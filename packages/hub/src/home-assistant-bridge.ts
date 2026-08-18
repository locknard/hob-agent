import { createHash } from "node:crypto";

import WebSocket from "ws";
import { z } from "zod";

import {
  BridgeStreamError,
  type AdapterFactoryContext as ContractAdapterFactoryContext,
  type AdapterRegistration as ContractAdapterRegistration,
  type BridgeAdapter as ContractBridgeAdapter,
  type BridgeControl as ContractBridgeControl,
  type BridgeEvent as ContractBridgeEvent,
  type BridgeInfo as ContractBridgeInfo,
  type CapabilitySemanticKind,
  type ControlResult as ContractControlResult,
  type DeviceDescriptor as ContractDeviceDescriptor,
  type Envelope as ContractEnvelope,
  type ExtensionHandleRegistry,
  type IdentityClaim as ContractIdentityClaim,
  type StateEvent as ContractStateEvent,
} from "../../../contracts/bridge-contract.js";
import {
  FOREIGN_RULES_EXTENSION,
  MAX_FOREIGN_RULES,
  type ForeignRuleCatalog,
  type ForeignRuleSummary,
  type ForeignRulesHandle,
} from "../../../contracts/bridge-foreign-rules.js";

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onclose: (() => void) | undefined;
  onerror: ((error: Error) => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;
}

export type SocketFactory = (url: string) => WebSocketLike;

/** Raw WebSocket frame budget applied before JSON parsing. */
export const MAX_HOME_ASSISTANT_MESSAGE_BYTES = 1_048_576;
export const DEFAULT_HOME_ASSISTANT_BOOTSTRAP_ITEMS = 4_096;
const MAX_HOME_ASSISTANT_IDENTITY_CLAIMS = 16;
const MAX_HOME_ASSISTANT_IDENTITY_CANDIDATES = 64;
const MAX_HOME_ASSISTANT_IDENTITY_VALUE_LENGTH = 256;

export interface HomeAssistantState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_updated?: string;
}

export interface HomeAssistantSnapshot {
  states: HomeAssistantState[];
  entityRegistry: unknown[];
  deviceRegistry: unknown[];
  areaRegistry: unknown[];
  health: { bridge: "up"; devices: Record<string, "reachable" | "unreachable" | "unknown"> };
}

export interface HomeAssistantBridgeOptions {
  baseUrl: string;
  accessToken: string;
  socketFactory?: SocketFactory;
  /** Internal adapter seam that retains the native state value for projection. */
  onNativeStateEvent?: (event: HomeAssistantNativeStateEvent) => void;
  /** Transport failures after startup are surfaced to the neutral adapter. */
  onDisconnect?: (error: Error) => void;
  connectTimeoutMs?: number;
  /** Bounded count of records returned by the bootstrap registry/state calls. */
  maxBootstrapItems?: number;
}

export interface HomeAssistantNativeStateEvent {
  entityId: string;
  state: string;
  attrs: Record<string, unknown>;
  ts: string;
}

export const DEFAULT_HOME_ASSISTANT_CONNECT_TIMEOUT_MS = 5_000;

export interface HomeAssistantEndpointProbeOptions {
  baseUrl: string;
  socketFactory?: SocketFactory;
  timeoutMs?: number;
  clock?: () => number;
}

export interface HomeAssistantEndpointProbeResult {
  status: "auth_required";
  version?: string;
  latencyMs: number;
}

interface ResultMessage {
  id: number;
  type: "result";
  success: boolean;
  result?: unknown;
  error?: { message?: string };
}

interface PendingCommand {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

export function toHomeAssistantWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.username !== "" || url.password !== "") {
    throw new Error("Home Assistant URL must not contain embedded credentials");
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Home Assistant URL must use http or https");
  }
  url.pathname = "/api/websocket";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Confirms the HA WebSocket endpoint before the product asks for a token.
 * It consumes only HA's initial auth challenge and never sends socket data.
 */
export function probeHomeAssistantEndpoint(
  options: HomeAssistantEndpointProbeOptions,
): Promise<HomeAssistantEndpointProbeResult> {
  const socketFactory = options.socketFactory ?? createNodeSocket;
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const timeoutMs = options.timeoutMs ?? 5_000;

  return new Promise((resolveProbe, rejectProbe) => {
    const socket = socketFactory(toHomeAssistantWebSocketUrl(options.baseUrl));
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      rejectProbe(new Error(message));
    };
    const timer = setTimeout(() => fail("Home Assistant preflight timed out"), timeoutMs);

    socket.onerror = () => fail("Home Assistant preflight failed");
    socket.onclose = () => fail("Home Assistant preflight connection closed");
    socket.onmessage = (event) => {
      if (Buffer.byteLength(event.data, "utf8") > MAX_HOME_ASSISTANT_MESSAGE_BYTES) {
        fail("Home Assistant preflight message exceeds the byte limit");
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        fail("Home Assistant preflight returned invalid JSON");
        return;
      }
      if (message.type !== "auth_required") {
        fail("Home Assistant preflight returned an unexpected response");
        return;
      }
      settled = true;
      clearTimeout(timer);
      const result: HomeAssistantEndpointProbeResult = {
        status: "auth_required",
        ...(typeof message.ha_version === "string" ? { version: message.ha_version } : {}),
        latencyMs: Math.max(0, clock() - startedAt),
      };
      socket.close();
      resolveProbe(result);
    };
  });
}

export class HomeAssistantBridge {
  private readonly socketFactory: SocketFactory;
  private readonly maxBootstrapItems: number;
  private readonly pending = new Map<number, PendingCommand>();
  private socket: WebSocketLike | undefined;
  private nextCommandId = 1;
  private intentionallyClosed = false;

  constructor(private readonly options: HomeAssistantBridgeOptions) {
    this.socketFactory = options.socketFactory ?? createNodeSocket;
    this.maxBootstrapItems = normalizeBootstrapItemBudget(options.maxBootstrapItems);
  }

  connect(): Promise<HomeAssistantSnapshot> {
    if (this.socket) throw new Error("Home Assistant bridge is already connected");
    this.intentionallyClosed = false;

    return new Promise((resolve, reject) => {
      const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_HOME_ASSISTANT_CONNECT_TIMEOUT_MS;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settleResolve = (snapshot: HomeAssistantSnapshot): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(snapshot);
      };
      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.rejectPending(error);
        reject(error);
      };
      const socket = this.socketFactory(toHomeAssistantWebSocketUrl(this.options.baseUrl));
      this.socket = socket;
      let authenticated = false;
      const failConnection = (error: Error): void => {
        if (!settled) {
          settleReject(error);
          return;
        }
        this.rejectPending(error);
        if (!this.intentionallyClosed) this.options.onDisconnect?.(error);
      };
      const transportError = (error: Error): void => {
        failConnection(error);
      };
      socket.onerror = transportError;
      socket.onclose = () => {
        const error = new Error(authenticated
          ? "Home Assistant WebSocket closed"
          : "Home Assistant connection closed before authentication");
        failConnection(error);
      };
      socket.onmessage = (event) => this.handleMessage(event.data, settleResolve, settleReject, () => {
        authenticated = true;
      }, failConnection);
      timer = setTimeout(() => {
        const error = new Error("Home Assistant connection timed out during startup");
        settleReject(error);
        socket.close();
      }, timeoutMs);
    });
  }

  close(): void {
    this.intentionallyClosed = true;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.rejectPending(new Error("Home Assistant bridge closed"));
  }

  /** Sends a bounded platform refresh request; completion means accepted only. */
  async requestResync(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("Home Assistant resync cancelled");
    // The neutral control contract defines completed as "request accepted";
    // the next sync-complete, rather than this command acknowledgement, is
    // the consistency boundary.  Do not retain an unbounded pending promise.
    const id = this.nextCommandId++;
    this.send({ id, type: "get_states" });
  }

  private handleMessage(
    data: string,
    resolveConnect: (snapshot: HomeAssistantSnapshot) => void,
    rejectConnect: (error: Error) => void,
    markAuthenticated: () => void,
    failConnection: (error: Error) => void,
  ): void {
    if (Buffer.byteLength(data, "utf8") > MAX_HOME_ASSISTANT_MESSAGE_BYTES) {
      failConnection(new BridgeStreamError("protocol_error", "Home Assistant message exceeds the byte limit"));
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      failConnection(new BridgeStreamError("protocol_error", "Home Assistant sent invalid JSON"));
      return;
    }

    if (message.type === "auth_required") {
      this.send({ type: "auth", access_token: this.options.accessToken });
      return;
    }
    if (message.type === "auth_invalid") {
      failConnection(new BridgeStreamError("authentication_failed", "Home Assistant authentication failed"));
      return;
    }
    if (message.type === "auth_ok") {
      markAuthenticated();
      void this.bootstrap().then(resolveConnect, rejectConnect);
      return;
    }
    if (message.type === "result" && typeof message.id === "number") {
      this.resolveCommand(message as unknown as ResultMessage);
      return;
    }
    if (message.type === "event" && typeof message.id === "number") {
      this.forwardStateEvent(message);
    }
  }

  private async bootstrap(): Promise<HomeAssistantSnapshot> {
    return this.loadSnapshot(true);
  }

  /** Reads a fresh neutralizable snapshot without registering a second event subscription. */
  async refreshSnapshot(signal?: AbortSignal): Promise<HomeAssistantSnapshot> {
    if (signal?.aborted) throw new Error("Home Assistant resync cancelled");
    return this.loadSnapshot(false);
  }

  private async loadSnapshot(subscribeEvents: boolean): Promise<HomeAssistantSnapshot> {
    const commands: Array<Promise<unknown>> = [
      this.command("get_states"),
      this.command("config/entity_registry/list"),
      this.command("config/device_registry/list"),
      this.command("config/area_registry/list"),
    ];
    if (subscribeEvents) commands.push(this.command("subscribe_events", { event_type: "state_changed" }));
    const [states, entityRegistry, deviceRegistry, areaRegistry] = await Promise.all(commands);
    const stateList = asArray<HomeAssistantState>(states);
    const entityList = asArray(entityRegistry);
    const deviceList = asArray(deviceRegistry);
    const areaList = asArray(areaRegistry);
    if (stateList.length + entityList.length + deviceList.length + areaList.length > this.maxBootstrapItems) {
      throw new BridgeStreamError("protocol_error", "Home Assistant bootstrap snapshot budget exceeded");
    }
    return {
      states: stateList,
      entityRegistry: entityList,
      deviceRegistry: deviceList,
      areaRegistry: areaList,
      health: { bridge: "up", devices: {} },
    };
  }

  private command(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextCommandId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, type, ...payload });
    });
  }

  private resolveCommand(message: ResultMessage): void {
    const command = this.pending.get(message.id);
    if (!command) return;
    this.pending.delete(message.id);
    if (message.success) command.resolve(message.result);
    else command.reject(new Error(message.error?.message ?? "Home Assistant command failed"));
  }

  private forwardStateEvent(message: Record<string, unknown>): void {
    const event = message.event;
    if (!isRecord(event) || event.event_type !== "state_changed" || !isRecord(event.data)) return;
    const entityId = event.data.entity_id;
    const newState = event.data.new_state;
    if (
      typeof entityId !== "string"
      || !isRecord(newState)
      || !isRecord(newState.attributes)
      || typeof newState.state !== "string"
      || typeof event.time_fired !== "string"
    ) return;
    const nativeEvent: HomeAssistantNativeStateEvent = {
      entityId,
      state: newState.state,
      attrs: newState.attributes,
      ts: event.time_fired,
    };
    this.options.onNativeStateEvent?.(nativeEvent);
  }

  private send(message: Record<string, unknown>): void {
    if (!this.socket) throw new Error("Home Assistant bridge is not connected");
    this.socket.send(JSON.stringify(message));
  }

  private rejectPending(error: Error): void {
    for (const command of this.pending.values()) command.reject(error);
    this.pending.clear();
  }
}

// ---- neutral BridgeAdapter projection ------------------------------------

export const HOME_ASSISTANT_ADAPTER_TYPE = "home-assistant";
export const HOME_ASSISTANT_ACCESS_TOKEN_ALIAS = "access-token";
export const HOME_ASSISTANT_ENTITY_SCHEMA = "ha.entity";
export const HOME_ASSISTANT_ENTITY_SCHEMA_VERSION = "1.0.0";
export const HOME_ASSISTANT_CORE_VERSION = "6.5.0";
export const HOME_ASSISTANT_HEARTBEAT_INTERVAL_MS = 60_000;

let homeAssistantEpochCounter = 0;

export interface HomeAssistantAdapterConfig {
  readonly baseUrl: string;
  /** Optional non-secret account/subject label; it is hashed into remote identity. */
  readonly authenticationPrincipal?: string;
}

export interface HomeAssistantBridgeAdapterDependencies {
  readonly socketFactory?: SocketFactory;
  readonly snapshotIdFactory?: () => string;
  readonly clock?: () => string;
  readonly connectTimeoutMs?: number;
  /** Testable seam; the contract-facing declaration remains 60 seconds. */
  readonly heartbeatIntervalMs?: number;
  readonly maxBufferedEvents?: number;
  readonly maxBootstrapItems?: number;
}

const homeAssistantConfigSchema = z
  .object({
    baseUrl: z.string().url(),
    authenticationPrincipal: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((config, context) => {
    try {
      const url = new URL(config.baseUrl);
      if (url.username !== "" || url.password !== "") {
        context.addIssue({ code: "custom", message: "Home Assistant URL must not contain embedded credentials" });
      }
      const protocol = url.protocol;
      if (protocol !== "http:" && protocol !== "https:" && protocol !== "ws:" && protocol !== "wss:") {
        context.addIssue({ code: "custom", message: "Home Assistant URL must use http or https" });
      }
    } catch {
      context.addIssue({ code: "custom", message: "Home Assistant URL is invalid" });
    }
  });

/**
 * Canonical form for the first HA capability schema.  This is intentionally
 * independent of Zod internals: changing the projection requires changing
 * this reviewed form and therefore its hash.
 */
const HOME_ASSISTANT_ENTITY_SCHEMA_CANONICAL_FORM = [
  "schema=ha.entity",
  "majorVersion=1",
  "state=string",
  "brightness=number",
  "colorTemperature=number",
  "temperature=number",
  "humidity=number",
  "batteryLevel=number",
  "volumeLevel=number",
  "unit=string",
  "available=boolean",
  "unknownAttributeCount=number",
].join("|");

export const HOME_ASSISTANT_ENTITY_SCHEMA_CANONICAL_HASH = `sha256:${createHash("sha256")
  .update(HOME_ASSISTANT_ENTITY_SCHEMA_CANONICAL_FORM)
  .digest("hex")}`;

const homeAssistantEntityAttrsSchema = z
  .object({
    state: z.string(),
    unit: z.string().optional(),
    brightness: z.number().finite().optional(),
    colorTemperature: z.number().finite().optional(),
    temperature: z.number().finite().optional(),
    humidity: z.number().finite().optional(),
    batteryLevel: z.number().finite().optional(),
    volumeLevel: z.number().finite().optional(),
    available: z.boolean().optional(),
    unknownAttributeCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export const HOME_ASSISTANT_ADAPTER_REGISTRATION: ContractAdapterRegistration<HomeAssistantAdapterConfig> = {
  adapterType: HOME_ASSISTANT_ADAPTER_TYPE,
  configSchema: homeAssistantConfigSchema,
  credentialRequirements: Object.freeze([{
    alias: HOME_ASSISTANT_ACCESS_TOKEN_ALIAS,
    kind: "secret_text" as const,
  }]),
  capabilitySchemas: Object.freeze([{
    schema: HOME_ASSISTANT_ENTITY_SCHEMA,
    majorVersion: 1,
    attrsSchema: homeAssistantEntityAttrsSchema,
    canonicalHash: HOME_ASSISTANT_ENTITY_SCHEMA_CANONICAL_HASH,
  }]),
  factory: (context) => new HomeAssistantBridgeAdapter(context),
};

/** Lowercase alias for composition code that prefers value-style names. */
export const homeAssistantAdapterRegistration = HOME_ASSISTANT_ADAPTER_REGISTRATION;

/**
 * Home Assistant does not expose a public, stable installation UUID through
 * the WebSocket handshake.  Until one is explicitly available, bind a
 * conservative audit identity to the normalized endpoint and a non-secret
 * authentication principal.  The token is deliberately absent: rotating it
 * must not change identity, while changing URL or principal must require a
 * registry rebind.  The returned digest is not presented as HA's own ID.
 */
export function deriveHomeAssistantRemoteInstanceId(
  baseUrl: string,
  authenticationPrincipal?: string,
): string {
  const endpoint = new URL(toHomeAssistantWebSocketUrl(baseUrl));
  endpoint.username = "";
  endpoint.password = "";
  endpoint.search = "";
  endpoint.hash = "";
  const normalizedEndpoint = endpoint.toString();
  const principal = authenticationPrincipal?.trim() || "<unknown-principal>";
  const material = `home-assistant-remote-v1\n${normalizedEndpoint}\n${principal}`;
  return `ha:${createHash("sha256").update(material).digest("hex")}`;
}

export function createHomeAssistantBridgeAdapter(
  context: ContractAdapterFactoryContext<HomeAssistantAdapterConfig>,
  dependencies: HomeAssistantBridgeAdapterDependencies = {},
): HomeAssistantBridgeAdapter {
  return new HomeAssistantBridgeAdapter(context, dependencies);
}

export class HomeAssistantBridgeAdapter implements ContractBridgeAdapter {
  readonly info: ContractBridgeInfo;
  readonly control: ContractBridgeControl;
  private lifecycle: "new" | "running" | "disposed" = "new";
  private eventsStarted = false;
  private bridge: HomeAssistantBridge | undefined;
  private queue: NativeStateQueue | undefined;
  private bindingsByEntityId = new Map<string, EntityBinding>();
  private healthByNativeId = new Map<string, "reachable" | "unreachable" | "unknown">();
  private foreignRuleCatalog: ForeignRuleCatalog | undefined;
  private resyncInFlight = false;

  constructor(
    private readonly context: ContractAdapterFactoryContext<HomeAssistantAdapterConfig>,
    private readonly dependencies: HomeAssistantBridgeAdapterDependencies = {},
  ) {
    this.info = Object.freeze({
      bridgeId: context.bridgeId,
      coreVersion: HOME_ASSISTANT_CORE_VERSION,
      ecosystem: "home-assistant",
      heartbeatIntervalMs: HOME_ASSISTANT_HEARTBEAT_INTERVAL_MS,
      extensions: Object.freeze([FOREIGN_RULES_EXTENSION]),
    });
    this.control = Object.freeze({
      requestResync: (signal: AbortSignal) => this.requestResync(signal),
      dispose: () => this.dispose(),
    });
  }

  events(signal: AbortSignal): AsyncIterable<ContractEnvelope> {
    if (this.lifecycle === "disposed" || this.eventsStarted) {
      throw new BridgeStreamError("protocol_error", "Home Assistant adapter has a single-use lifecycle");
    }
    this.eventsStarted = true;
    return this.runEvents(signal);
  }

  extension<K extends keyof ExtensionHandleRegistry>(name: K): ExtensionHandleRegistry[K] | undefined {
    if (name !== "foreignRules@1") return undefined;
    const handle: ForeignRulesHandle = {
      catalog: async () => this.foreignRuleCatalog === undefined ? undefined : {
        epochId: this.foreignRuleCatalog.epochId,
        complete: this.foreignRuleCatalog.complete,
        rules: this.foreignRuleCatalog.rules.map((rule) => ({ ...rule })),
      },
    };
    return handle as ExtensionHandleRegistry[K];
  }

  private async *runEvents(signal: AbortSignal): AsyncGenerator<ContractEnvelope> {
    if (this.lifecycle === "disposed") {
      throw new BridgeStreamError("protocol_error", "Home Assistant adapter was disposed before events started");
    }
    this.lifecycle = "running";
    if (signal.aborted) {
      this.lifecycle = "disposed";
      return;
    }
    const queue = new NativeStateQueue(this.dependencies.maxBufferedEvents);
    this.queue = queue;
    try {
      const accessToken = await this.resolveAccessToken();
      const bridge = new HomeAssistantBridge({
        baseUrl: this.context.config.baseUrl,
        accessToken,
        socketFactory: this.dependencies.socketFactory,
        connectTimeoutMs: this.dependencies.connectTimeoutMs,
        maxBootstrapItems: this.dependencies.maxBootstrapItems,
        onNativeStateEvent: (event) => queue.pushState(event),
        onDisconnect: (error) => queue.fail(mapHomeAssistantStreamError(error)),
      });
      this.bridge = bridge;

      let snapshot: HomeAssistantSnapshot;
      try {
        snapshot = await bridge.connect();
      } catch (error) {
        throw mapHomeAssistantStreamError(error);
      }
      if (signal.aborted || this.isDisposed()) return;

      let current = this.prepareSnapshot(snapshot);
      yield* snapshotEnvelopes(current, "initial");

      while (!signal.aborted && !this.isDisposed()) {
        const item = await queue.next(signal, this.dependencies.heartbeatIntervalMs ?? this.info.heartbeatIntervalMs);
        if (item === undefined) return;
        if (item.kind === "heartbeat") {
          yield current.envelope({ kind: "heartbeat" });
          continue;
        }
        if (item.kind === "resync") {
          current = this.prepareSnapshot(item.snapshot);
          yield* snapshotEnvelopes(current, "resync");
          continue;
        }
        const binding = this.bindingsByEntityId.get(item.event.entityId);
        if (binding === undefined) continue;
        const state = projectNativeState(item.event, binding);
        if (state === undefined) continue;
        yield current.envelope({ kind: "state", state });
        const nextHealth = healthForNativeState(item.event.state);
        if (this.healthByNativeId.get(binding.nativeId) !== nextHealth) {
          this.healthByNativeId.set(binding.nativeId, nextHealth);
          yield current.envelope({ kind: "device-health", nativeId: binding.nativeId, status: nextHealth });
        }
      }
    } catch (error) {
      if (signal.aborted || this.isDisposed()) return;
      throw error instanceof BridgeStreamError
        ? error
        : mapHomeAssistantStreamError(error);
    } finally {
      queue.close();
      this.bridge?.close();
      this.bridge = undefined;
      this.queue = undefined;
      this.healthByNativeId.clear();
      this.resyncInFlight = false;
      this.lifecycle = "disposed";
    }
  }

  private prepareSnapshot(snapshot: HomeAssistantSnapshot): SnapshotEmission {
    const projection = projectSnapshot(snapshot);
    this.bindingsByEntityId = projection.bindingsByEntityId;
    this.healthByNativeId = new Map(
      projection.devices.map((device) => [device.descriptor.nativeId, device.health]),
    );
    const snapshotId = this.snapshotId();
    const epochId = `${this.context.bridgeId}:${snapshotId}:${++homeAssistantEpochCounter}`;
    this.foreignRuleCatalog = { epochId, ...projectForeignRules(snapshot) };
    const remoteInstanceId = deriveHomeAssistantRemoteInstanceId(
      this.context.config.baseUrl,
      this.context.config.authenticationPrincipal,
    );
    let seq = 1;
    return {
      projection,
      snapshotId,
      epochId,
      remoteInstanceId,
      envelope: (event) => ({ epochId, seq: seq++, event }),
    };
  }

  private async resolveAccessToken(): Promise<string> {
    let material: unknown;
    try {
      material = await this.context.credentials.resolve(HOME_ASSISTANT_ACCESS_TOKEN_ALIAS);
    } catch {
      throw new BridgeStreamError("authentication_failed", "Home Assistant authentication failed");
    }
    if (!isRecord(material) || material.kind !== "secret_text" || typeof material.value !== "string" || material.value.length === 0) {
      throw new BridgeStreamError("authentication_failed", "Home Assistant authentication failed");
    }
    return material.value;
  }

  private isDisposed(): boolean {
    return this.lifecycle === "disposed";
  }

  private snapshotId(): string {
    const candidate = this.dependencies.snapshotIdFactory?.()
      ?? `ha-${createHash("sha256")
        .update(`${this.context.bridgeId}\n${this.dependencies.clock?.() ?? new Date().toISOString()}`)
        .digest("hex")}`;
    if (candidate.trim() === "") throw new BridgeStreamError("internal_error", "Home Assistant snapshot id is empty");
    return candidate;
  }

  private async requestResync(signal: AbortSignal): Promise<ContractControlResult> {
    if (signal.aborted) return { status: "failed", reason: "cancelled" };
    if (this.lifecycle !== "running" || this.bridge === undefined) {
      return { status: "unsupported", reason: "not_ready" };
    }
    if (this.resyncInFlight) return { status: "completed" };
    const bridge = this.bridge;
    const queue = this.queue;
    if (queue === undefined) return { status: "unsupported", reason: "not_ready" };
    this.resyncInFlight = true;
    void bridge.refreshSnapshot(signal).then(
      (snapshot) => queue.pushResync(snapshot),
      (error: unknown) => queue.fail(mapHomeAssistantStreamError(error)),
    ).finally(() => {
      this.resyncInFlight = false;
    });
    return { status: "completed" };
  }

  private async dispose(): Promise<void> {
    if (this.lifecycle === "disposed") return;
    this.lifecycle = "disposed";
    this.queue?.close();
    this.bridge?.close();
  }
}

function projectForeignRules(snapshot: HomeAssistantSnapshot): {
  readonly complete: boolean;
  readonly rules: ForeignRuleSummary[];
} {
  const states = new Map(snapshot.states.map((state) => [state.entity_id, state]));
  const rules: ForeignRuleSummary[] = [];
  let complete = true;
  for (const raw of snapshot.entityRegistry) {
    if (!isRecord(raw)) continue;
    const entityId = nonEmptyString(raw.entity_id);
    if (entityId === undefined || !entityId.startsWith("automation.")) continue;
    const state = states.get(entityId);
    if (state?.state === "unavailable"
      && isRecord(state.attributes)
      && state.attributes.restored === true) continue;
    if (rules.length >= MAX_FOREIGN_RULES) {
      complete = false;
      continue;
    }
    const stableId = nonEmptyString(raw.id) ?? entityId;
    const stateName = state && isRecord(state.attributes)
      ? nonEmptyString(state.attributes.friendly_name)
      : undefined;
    const name = nonEmptyString(raw.name) ?? nonEmptyString(raw.original_name) ?? stateName;
    const enabled = state?.state === "on" ? true : state?.state === "off" ? false : undefined;
    const updatedAt = state?.last_updated;
    rules.push({
      ruleRef: `ha-rule:${createHash("sha256").update(stableId).digest("hex")}`,
      ...(name === undefined ? {} : { name: name.slice(0, 256) }),
      ...(enabled === undefined ? {} : { enabled }),
      ...(typeof updatedAt === "string" && updatedAt.length > 0 ? { updatedAt } : {}),
    });
  }
  return { complete, rules: rules.sort((left, right) => left.ruleRef.localeCompare(right.ruleRef)) };
}

/** Short alias for callers that use the contract's adapter terminology. */
export { HomeAssistantBridgeAdapter as HomeAssistantAdapter };

interface EntityBinding {
  readonly nativeInstanceId: string;
  readonly entityId: string;
  readonly nativeId: string;
  readonly name?: string;
  readonly nativeSpaceId?: string;
  readonly spaceName?: string;
}

interface ProjectedDevice {
  readonly descriptor: ContractDeviceDescriptor;
  readonly states: readonly ContractStateEvent[];
  readonly health: "reachable" | "unreachable" | "unknown";
}

interface SnapshotProjection {
  readonly bindingsByEntityId: Map<string, EntityBinding>;
  readonly devices: readonly ProjectedDevice[];
}

interface SnapshotEmission {
  readonly projection: SnapshotProjection;
  readonly snapshotId: string;
  readonly epochId: string;
  readonly remoteInstanceId: string;
  readonly envelope: (event: ContractBridgeEvent) => ContractEnvelope;
}

function* snapshotEnvelopes(
  emission: SnapshotEmission,
  reason: "initial" | "resync",
): Generator<ContractEnvelope> {
  yield emission.envelope({
    kind: "sync-start",
    snapshotId: emission.snapshotId,
    remoteInstanceId: emission.remoteInstanceId,
    reason,
  });
  let deviceEnvelopeCount = 0;
  let stateEnvelopeCount = 0;
  for (const device of emission.projection.devices) {
    yield emission.envelope({ kind: "device-upserted", device: device.descriptor });
    deviceEnvelopeCount += 1;
    for (const state of device.states) {
      yield emission.envelope({ kind: "state", state });
      stateEnvelopeCount += 1;
    }
    yield emission.envelope({ kind: "device-health", nativeId: device.descriptor.nativeId, status: device.health });
  }
  yield emission.envelope({
    kind: "sync-complete",
    manifest: { snapshotId: emission.snapshotId, deviceEnvelopeCount, stateEnvelopeCount },
  });
}

function projectSnapshot(snapshot: HomeAssistantSnapshot): SnapshotProjection {
  const areaNames = new Map<string, string>();
  for (const raw of snapshot.areaRegistry) {
    if (!isRecord(raw)) continue;
    const nativeSpaceId = boundedRegistryText(raw.area_id, 256) ?? boundedRegistryText(raw.id, 256);
    const name = boundedRegistryText(raw.name, 512);
    if (nativeSpaceId !== undefined && name !== undefined && !areaNames.has(nativeSpaceId)) {
      areaNames.set(nativeSpaceId, name);
    }
  }

  const deviceNames = new Map<string, string>();
  const deviceSpaces = new Map<string, string>();
  const identityClaimsByNativeId = new Map<string, readonly ContractIdentityClaim[]>();
  for (const raw of snapshot.deviceRegistry) {
    if (!isRecord(raw)) continue;
    const nativeId = nonEmptyString(raw.id);
    const name = nonEmptyString(raw.name);
    const nativeSpaceId = boundedRegistryText(raw.area_id, 256);
    if (nativeId !== undefined && name !== undefined && !deviceNames.has(nativeId)) deviceNames.set(nativeId, name);
    if (nativeId !== undefined && nativeSpaceId !== undefined && !deviceSpaces.has(nativeId)) {
      deviceSpaces.set(nativeId, nativeSpaceId);
    }
    if (nativeId !== undefined) {
      const claims = projectDeviceIdentityClaims(raw);
      if (claims.length > 0) identityClaimsByNativeId.set(nativeId, claims);
    }
  }

  const bindingsByEntityId = new Map<string, EntityBinding>();
  const bindingsByNativeInstanceId = new Set<string>();
  for (const raw of snapshot.entityRegistry) {
    if (!isRecord(raw)) continue;
    const nativeInstanceId = nonEmptyString(raw.id);
    const entityId = nonEmptyString(raw.entity_id);
    const nativeId = nonEmptyString(raw.device_id);
    const nativeSpaceId = boundedRegistryText(raw.area_id, 256)
      ?? (nativeId === undefined ? undefined : deviceSpaces.get(nativeId));
    if (nativeInstanceId === undefined || entityId === undefined || nativeId === undefined) continue;
    if (bindingsByEntityId.has(entityId) || bindingsByNativeInstanceId.has(nativeInstanceId)) continue;
    bindingsByEntityId.set(entityId, {
      nativeInstanceId,
      entityId,
      nativeId,
      ...(nonEmptyString(raw.name) !== undefined ? { name: nonEmptyString(raw.name) } : {}),
      ...(nativeSpaceId === undefined
        ? {}
        : {
            nativeSpaceId,
            ...(areaNames.get(nativeSpaceId) === undefined ? {} : { spaceName: areaNames.get(nativeSpaceId) }),
          }),
    });
    bindingsByNativeInstanceId.add(nativeInstanceId);
  }

  const statesByNativeId = new Map<string, ContractStateEvent[]>();
  const healthByNativeId = new Map<string, Array<"reachable" | "unreachable" | "unknown">>();
  for (const raw of snapshot.states) {
    if (!isRecord(raw) || !isRecord(raw.attributes) || typeof raw.state !== "string") continue;
    const entityId = nonEmptyString(raw.entity_id);
    if (entityId === undefined) continue;
    const binding = bindingsByEntityId.get(entityId);
    if (binding === undefined) continue;
    const state = projectNativeState({
      entityId,
      state: raw.state,
      attrs: raw.attributes,
      ts: typeof raw.last_updated === "string" ? raw.last_updated : "",
    }, binding);
    if (state === undefined) continue;
    const states = statesByNativeId.get(binding.nativeId) ?? [];
    states.push(state);
    statesByNativeId.set(binding.nativeId, states);
    const health = healthForNativeState(raw.state);
    const healthStates = healthByNativeId.get(binding.nativeId) ?? [];
    healthStates.push(health);
    healthByNativeId.set(binding.nativeId, healthStates);
  }

  const bindingsByNativeId = new Map<string, EntityBinding[]>();
  for (const binding of bindingsByEntityId.values()) {
    const bindings = bindingsByNativeId.get(binding.nativeId) ?? [];
    bindings.push(binding);
    bindingsByNativeId.set(binding.nativeId, bindings);
  }

  const devices: ProjectedDevice[] = [];
  for (const [nativeId, bindings] of bindingsByNativeId) {
    bindings.sort((left, right) => left.nativeInstanceId.localeCompare(right.nativeInstanceId));
    const capabilities = bindings.map((binding) => {
      const semanticKind = homeAssistantSemanticKind(binding.entityId);
      return {
        nativeInstanceId: binding.nativeInstanceId,
        schema: HOME_ASSISTANT_ENTITY_SCHEMA,
        schemaVersion: HOME_ASSISTANT_ENTITY_SCHEMA_VERSION,
        ...(semanticKind === undefined ? {} : { semanticKind }),
        ...(binding.nativeSpaceId === undefined
          ? {}
          : {
              space: {
                nativeSpaceId: binding.nativeSpaceId,
                ...(binding.spaceName === undefined ? {} : { name: binding.spaceName }),
              },
            }),
      };
    });
    const states = (statesByNativeId.get(nativeId) ?? []).sort((left, right) =>
      left.nativeInstanceId.localeCompare(right.nativeInstanceId));
    devices.push({
      descriptor: {
        nativeId,
        ...(deviceNames.get(nativeId) ?? bindings[0]?.name
          ? { name: deviceNames.get(nativeId) ?? bindings[0]?.name }
          : {}),
        capabilities,
        ...(identityClaimsByNativeId.get(nativeId) === undefined
          ? {}
          : { identityClaims: [...identityClaimsByNativeId.get(nativeId)!] }),
      },
      states,
      health: aggregateHealth(healthByNativeId.get(nativeId) ?? []),
    });
  }
  devices.sort((left, right) => left.descriptor.nativeId.localeCompare(right.descriptor.nativeId));
  return { bindingsByEntityId, devices };
}

const HOME_ASSISTANT_SEMANTIC_KINDS: Readonly<Record<string, CapabilitySemanticKind>> = Object.freeze({
  light: "light",
  switch: "switch",
  button: "button",
  sensor: "sensor",
  binary_sensor: "binary-sensor",
  number: "numeric-control",
  input_number: "numeric-control",
  select: "choice-control",
  text: "text-control",
  time: "time-control",
  input_datetime: "time-control",
  event: "event",
  media_player: "media",
  cover: "cover",
  lock: "lock",
  device_tracker: "presence",
  person: "presence",
  fan: "fan",
  camera: "camera",
  vacuum: "vacuum",
  climate: "climate",
  water_heater: "climate",
  weather: "weather",
  automation: "automation",
  script: "automation",
});

export function homeAssistantSemanticKind(entityId: string): CapabilitySemanticKind | undefined {
  const separator = entityId.indexOf(".");
  if (separator <= 0) return undefined;
  return HOME_ASSISTANT_SEMANTIC_KINDS[entityId.slice(0, separator)];
}

function projectDeviceIdentityClaims(raw: Record<string, unknown>): readonly ContractIdentityClaim[] {
  const claims: ContractIdentityClaim[] = [];
  const seen = new Set<string>();
  const sources = [raw.connections, raw.identifiers];
  let candidates = 0;
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const pair of source) {
      if (++candidates > MAX_HOME_ASSISTANT_IDENTITY_CANDIDATES) break;
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const type = identityClaimType(pair[0]);
      const value = boundedIdentityValue(pair[1]);
      if (type === undefined || value === undefined) continue;
      const key = `${type}\u0000${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({
        type,
        value,
        source: { kind: "platform_registry", platform: "home-assistant" },
        confidence: "high",
      });
      if (claims.length >= MAX_HOME_ASSISTANT_IDENTITY_CLAIMS) return claims;
    }
    if (candidates > MAX_HOME_ASSISTANT_IDENTITY_CANDIDATES) break;
  }
  return claims;
}

function identityClaimType(value: unknown): ContractIdentityClaim["type"] | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "mac" || normalized === "mac_address") return "mac";
  if (normalized === "ieee" || normalized === "ieee_address" || normalized === "ieeeaddr") return "ieee";
  if (normalized === "serial" || normalized === "serial_number" || normalized === "serialnumber") return "serial";
  if (normalized === "miotdid" || normalized === "miot_did") return "miotDid";
  return undefined;
}

function boundedIdentityValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_HOME_ASSISTANT_IDENTITY_VALUE_LENGTH) return undefined;
  return normalized;
}

function projectNativeState(nativeState: HomeAssistantNativeStateEvent, binding: EntityBinding): ContractStateEvent | undefined {
  if (nativeState.entityId !== binding.entityId || nativeState.state.trim() === "") return undefined;
  const attrs = projectKnownAttributes(nativeState.state, nativeState.attrs);
  return {
    nativeId: binding.nativeId,
    nativeInstanceId: binding.nativeInstanceId,
    attrs,
    time: nativeState.ts.trim() === ""
      ? { sourceTsQuality: "none" }
      : { sourceTs: nativeState.ts, sourceTsQuality: "platform" },
    origin: "observed",
  };
}

function projectKnownAttributes(state: string, attributes: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const projected: Record<string, string | number | boolean | null> = { state };
  const knownKeys = new Set<string>();
  const known: Readonly<Record<string, string>> = {
    unit_of_measurement: "unit",
    brightness: "brightness",
    color_temp: "colorTemperature",
    temperature: "temperature",
    humidity: "humidity",
    battery_level: "batteryLevel",
    volume_level: "volumeLevel",
    available: "available",
  };
  for (const [sourceKey, targetKey] of Object.entries(known)) {
    if (!Object.prototype.hasOwnProperty.call(attributes, sourceKey)) continue;
    knownKeys.add(sourceKey);
    const value = attributes[sourceKey];
    if (isJsonScalar(value)) projected[targetKey] = value;
  }
  const unknownAttributeCount = Object.keys(attributes)
    .filter((key) => !knownKeys.has(key))
    .length;
  if (unknownAttributeCount > 0) {
    projected.unknownAttributeCount = unknownAttributeCount;
  }
  return projected;
}

function healthForNativeState(state: string): "reachable" | "unreachable" | "unknown" {
  if (state === "unavailable") return "unreachable";
  if (state === "unknown") return "unknown";
  return "reachable";
}

function aggregateHealth(states: readonly ("reachable" | "unreachable" | "unknown")[]): "reachable" | "unreachable" | "unknown" {
  if (states.includes("unreachable")) return "unreachable";
  if (states.length === 0 || states.includes("unknown")) return "unknown";
  return "reachable";
}

function isJsonScalar(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function mapHomeAssistantStreamError(error: unknown): BridgeStreamError {
  if (error instanceof BridgeStreamError) return error;
  const text = error instanceof Error ? error.message : "";
  const authentication = /auth|credential|token/i.test(text);
  return new BridgeStreamError(
    authentication ? "authentication_failed" : "upstream_unavailable",
    authentication ? "Home Assistant authentication failed" : "Home Assistant upstream unavailable",
  );
}

type NativeQueueItem =
  | { kind: "state"; event: HomeAssistantNativeStateEvent }
  | { kind: "resync"; snapshot: HomeAssistantSnapshot }
  | { kind: "heartbeat" };

class NativeStateQueue {
  private readonly values: NativeQueueItem[] = [];
  private readonly maxBufferedEvents: number;
  private waiter: {
    resolve: (value: NativeQueueItem | undefined) => void;
    reject: (error: unknown) => void;
    cleanup: () => void;
  } | undefined;
  private failure: BridgeStreamError | undefined;
  private closed = false;

  constructor(maxBufferedEvents = 256) {
    this.maxBufferedEvents = Number.isFinite(maxBufferedEvents)
      ? Math.max(1, Math.floor(maxBufferedEvents))
      : 256;
  }

  pushState(event: HomeAssistantNativeStateEvent): void {
    this.pushValue({ kind: "state", event });
  }

  pushResync(snapshot: HomeAssistantSnapshot): void {
    this.pushValue({ kind: "resync", snapshot });
  }

  private pushValue(value: NativeQueueItem): void {
    if (this.closed || this.failure !== undefined) return;
    if (this.waiter !== undefined) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.cleanup();
      waiter.resolve(value);
      return;
    }
    if (this.values.length >= this.maxBufferedEvents) {
      this.fail(new BridgeStreamError("internal_error", "Home Assistant stream buffer limit exceeded"));
      return;
    }
    this.values.push(value);
  }

  fail(error: BridgeStreamError): void {
    if (this.closed || this.failure !== undefined) return;
    this.failure = error;
    this.values.length = 0;
    if (this.waiter !== undefined) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.cleanup();
      waiter.reject(error);
    }
  }

  next(signal: AbortSignal, heartbeatIntervalMs: number): Promise<NativeQueueItem | undefined> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.values.length > 0) return Promise.resolve(this.values.shift()!);
    if (this.closed || signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (this.waiter?.resolve !== resolve) return;
        this.waiter = undefined;
        clearTimeout(heartbeatTimer);
        signal.removeEventListener("abort", onAbort);
        resolve(undefined);
      };
      const heartbeatTimer = setTimeout(() => {
        if (this.waiter?.resolve !== resolve) return;
        this.waiter = undefined;
        signal.removeEventListener("abort", onAbort);
        resolve({ kind: "heartbeat" });
      }, Math.max(1, heartbeatIntervalMs));
      heartbeatTimer.unref?.();
      this.waiter = {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(heartbeatTimer);
          signal.removeEventListener("abort", onAbort);
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.values.length = 0;
    if (this.waiter !== undefined) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.cleanup();
      waiter.resolve(undefined);
    }
  }
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function normalizeBootstrapItemBudget(value: number | undefined): number {
  const budget = value ?? DEFAULT_HOME_ASSISTANT_BOOTSTRAP_ITEMS;
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new RangeError("Home Assistant bootstrap item budget must be a positive safe integer");
  }
  return budget;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function boundedRegistryText(value: unknown, maxLength: number): string | undefined {
  const text = nonEmptyString(value);
  return text === undefined || text.length > maxLength ? undefined : text;
}

function createNodeSocket(url: string): WebSocketLike {
  const socket = new WebSocket(url);
  let onclose: (() => void) | undefined;
  let onerror: ((error: Error) => void) | undefined;
  let onmessage: ((event: { data: string }) => void) | undefined;
  socket.onclose = () => onclose?.();
  socket.onerror = (event) => onerror?.(
    event.error instanceof Error ? event.error : new Error("Home Assistant WebSocket error"),
  );
  socket.onmessage = (event) => onmessage?.({ data: String(event.data) });
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    get onclose() { return onclose; },
    set onclose(handler) { onclose = handler; },
    get onerror() { return onerror; },
    set onerror(handler) { onerror = handler; },
    get onmessage() { return onmessage; },
    set onmessage(handler) { onmessage = handler; },
  };
}
