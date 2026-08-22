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
} from "@hob/bridge-contract";
import {
  AUTOMATIONS_EXTENSION,
  bridgeAutomationSpecSchema,
  type AutomationsExtension,
  type BridgeAutomationAction,
  type BridgeAutomationCondition,
  type BridgeAutomationDeployResult,
  type BridgeAutomationStatusResult,
  type BridgeAutomationSpec,
  type BridgeAutomationCommandResult,
} from "@hob/bridge-contract";
import {
  ACTIONS_EXTENSION,
  bridgeActionDescriptorRequestSchema,
  bridgeActionDescriptorSchema,
  bridgeActionRequestSchema,
  bridgeActionResultSchema,
  type ActionsExtension,
  type BridgeActionDescriptor,
  type BridgeActionDescriptorRequest,
  type BridgeActionRequest,
  type BridgeActionResult,
} from "@hob/bridge-contract";
import {
  FOREIGN_RULES_EXTENSION,
  MAX_FOREIGN_RULES,
  type ForeignRuleCatalog,
  type ForeignRuleSummary,
  type ForeignRulesHandle,
} from "@hob/bridge-contract";
import {
  ORG_HINTS_EXTENSION,
  type OrgHintPayload,
} from "@hob/bridge-contract";

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

  async callService(input: {
    readonly domain: string;
    readonly service: string;
    readonly entityId: string;
    readonly serviceData?: Readonly<Record<string, string | number | boolean>>;
  }, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason ?? new Error("Home Assistant action cancelled");
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.domain)
      || !/^[a-z][a-z0-9_]{0,63}$/.test(input.service)
      || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(input.entityId)) {
      throw new TypeError("Home Assistant action is invalid");
    }
    await this.command("call_service", {
      domain: input.domain,
      service: input.service,
      target: { entity_id: input.entityId },
      service_data: { ...(input.serviceData ?? {}) },
    });
    if (signal.aborted) throw signal.reason ?? new Error("Home Assistant action cancelled");
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
export const HOME_ASSISTANT_COVER_SCHEMA = "ha.cover";
export const HOME_ASSISTANT_COVER_SCHEMA_VERSION = "1.0.0";
export const HOME_ASSISTANT_MEDIA_PLAYER_SCHEMA = "ha.media-player";
export const HOME_ASSISTANT_MEDIA_PLAYER_SCHEMA_VERSION = "1.0.0";
/** Home Assistant's CoverEntityFeature.SET_POSITION bit. */
export const HOME_ASSISTANT_COVER_SET_POSITION_FEATURE = 4;
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
  /** Testable seam for the Home Assistant config REST API. */
  readonly fetchImpl?: typeof fetch;
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

const HOME_ASSISTANT_COVER_SCHEMA_CANONICAL_FORM = [
  "schema=ha.cover",
  "majorVersion=1",
  "state=string",
  "level=number",
  "setLevelSupported=boolean",
  "available=boolean",
  "unknownAttributeCount=number",
].join("|");

export const HOME_ASSISTANT_COVER_SCHEMA_CANONICAL_HASH = `sha256:${createHash("sha256")
  .update(HOME_ASSISTANT_COVER_SCHEMA_CANONICAL_FORM)
  .digest("hex")}`;

const HOME_ASSISTANT_MEDIA_PLAYER_SCHEMA_CANONICAL_FORM = [
  "schema=ha.media-player",
  "majorVersion=1",
  "state=string",
  "volumeLevel=number[0,1]",
  "available=boolean",
  "unknownAttributeCount=number",
].join("|");

export const HOME_ASSISTANT_MEDIA_PLAYER_SCHEMA_CANONICAL_HASH = `sha256:${createHash("sha256")
  .update(HOME_ASSISTANT_MEDIA_PLAYER_SCHEMA_CANONICAL_FORM)
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

const homeAssistantCoverAttrsSchema = z
  .object({
    state: z.string(),
    level: z.number().finite().min(0).max(1).optional(),
    setLevelSupported: z.boolean().optional(),
    available: z.boolean().optional(),
    unknownAttributeCount: z.number().int().nonnegative().optional(),
  })
  .strict();

const homeAssistantMediaPlayerAttrsSchema = z
  .object({
    state: z.string(),
    volumeLevel: z.number().finite().min(0).max(1).optional(),
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
  }, {
    schema: HOME_ASSISTANT_COVER_SCHEMA,
    majorVersion: 1,
    attrsSchema: homeAssistantCoverAttrsSchema,
    canonicalHash: HOME_ASSISTANT_COVER_SCHEMA_CANONICAL_HASH,
  }, {
    schema: HOME_ASSISTANT_MEDIA_PLAYER_SCHEMA,
    majorVersion: 1,
    attrsSchema: homeAssistantMediaPlayerAttrsSchema,
    canonicalHash: HOME_ASSISTANT_MEDIA_PLAYER_SCHEMA_CANONICAL_HASH,
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
  private stateAttrsByNativeInstanceId = new Map<string, Readonly<Record<string, unknown>>>();
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
      extensions: Object.freeze([FOREIGN_RULES_EXTENSION, ORG_HINTS_EXTENSION, ACTIONS_EXTENSION, AUTOMATIONS_EXTENSION]),
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
    if (name === "foreignRules@2") {
      const handle: ForeignRulesHandle = {
        catalog: async () => this.foreignRuleCatalog === undefined ? undefined : {
          epochId: this.foreignRuleCatalog.epochId,
          lastSeq: this.foreignRuleCatalog.lastSeq,
          complete: this.foreignRuleCatalog.complete,
          rules: this.foreignRuleCatalog.rules.map((rule) => ({ ...rule })),
        },
      };
      return handle as ExtensionHandleRegistry[K];
    }
    if (name === "actions@1") {
      const handle: ActionsExtension = {
        describe: (request) => this.describeAction(request),
        execute: (request, options) => this.executeAction(request, options.signal),
      };
      return handle as ExtensionHandleRegistry[K];
    }
    if (name === "automations@1") {
      const handle: AutomationsExtension = {
        status: (request, options) => this.automationStatus(request, options.signal),
        deploy: (spec, options) => this.deployAutomation(spec, options.signal),
        setEnabled: (request, options) => this.setAutomationEnabled(request, options.signal),
        withdraw: (request, options) => this.withdrawAutomation(request, options.signal),
      };
      return handle as ExtensionHandleRegistry[K];
    }
    return undefined;
  }

  /**
   * Deploys a Hub-compiled automation through the Home Assistant config API and
   * reports success only after reading the stored configuration back. The alias
   * equals the Hub automation id, so the automation entity id stays
   * deterministic and the adapter never touches a rule it did not create.
   */
  private async deployAutomation(specValue: BridgeAutomationSpec, signal: AbortSignal): Promise<BridgeAutomationDeployResult> {
    const parsed = bridgeAutomationSpecSchema.safeParse(specValue);
    if (!parsed.success) return { status: "rejected", reason: "invalid_target", detail: "Automation spec is invalid" };
    if (this.lifecycle !== "running") return { status: "rejected", reason: "unavailable", detail: "Home Assistant bridge is not running" };
    const spec = parsed.data;
    const config = this.compileAutomationConfig(spec);
    if ("reason" in config) return { status: "rejected", reason: config.reason, detail: config.detail };
    try {
      const written = await this.automationConfigRequest("POST", spec.automationId, signal, config.value);
      if (!written.ok) {
        return { status: "rejected", reason: "failed", detail: `Home Assistant rejected the automation (${written.statusCode})` };
      }
      const readBack = await this.automationConfigRequest("GET", spec.automationId, signal);
      if (!readBack.ok || !isRecord(readBack.body) || readBack.body.alias !== spec.automationId) {
        return { status: "rejected", reason: "failed", detail: "Home Assistant did not store the automation" };
      }
      return { status: "deployed", nativeAutomationId: spec.automationId };
    } catch {
      return { status: "rejected", reason: "unavailable", detail: "Home Assistant configuration API is unreachable" };
    }
  }

  private async setAutomationEnabled(
    request: { readonly nativeAutomationId: string; readonly enabled: boolean },
    signal: AbortSignal,
  ): Promise<BridgeAutomationCommandResult> {
    if (!/^[a-z0-9][a-z0-9_]{2,120}$/.test(request.nativeAutomationId)) {
      return { status: "rejected", reason: "not_found", detail: "Unknown automation id" };
    }
    if (this.lifecycle !== "running" || this.bridge === undefined) {
      return { status: "rejected", reason: "unavailable", detail: "Home Assistant bridge is not running" };
    }
    try {
      await this.bridge.callService({
        domain: "automation",
        service: request.enabled ? "turn_on" : "turn_off",
        entityId: `automation.${request.nativeAutomationId}`,
      }, signal);
      return { status: "acknowledged" };
    } catch {
      return { status: "rejected", reason: "failed", detail: "Home Assistant did not acknowledge the toggle" };
    }
  }

  /** Withdrawal only deletes the adapter's own automation; a missing one is already withdrawn. */
  private async withdrawAutomation(
    request: { readonly nativeAutomationId: string },
    signal: AbortSignal,
  ): Promise<BridgeAutomationCommandResult> {
    if (!/^[a-z0-9][a-z0-9_]{2,120}$/.test(request.nativeAutomationId)) {
      return { status: "rejected", reason: "not_found", detail: "Unknown automation id" };
    }
    try {
      const deleted = await this.automationConfigRequest("DELETE", request.nativeAutomationId, signal);
      if (deleted.ok || deleted.statusCode === 404) return { status: "acknowledged" };
      return { status: "rejected", reason: "failed", detail: `Home Assistant rejected the removal (${deleted.statusCode})` };
    } catch {
      return { status: "rejected", reason: "unavailable", detail: "Home Assistant configuration API is unreachable" };
    }
  }

  /** Reads the automation entity state; the config read-back covers existence. */
  private async automationStatus(
    request: { readonly nativeAutomationId: string },
    signal: AbortSignal,
  ): Promise<BridgeAutomationStatusResult> {
    if (!/^[a-z0-9][a-z0-9_]{2,120}$/.test(request.nativeAutomationId)) return { status: "missing" };
    try {
      const accessToken = await this.resolveAccessToken();
      const fetchImpl = this.dependencies.fetchImpl ?? fetch;
      const url = new URL(`/api/states/automation.${request.nativeAutomationId}`, this.context.config.baseUrl);
      const response = await fetchImpl(url, {
        signal,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (response.status === 404) return { status: "missing" };
      if (!response.ok) return { status: "unknown" };
      const body = await response.json() as { state?: unknown };
      if (body?.state === "on") return { status: "running" };
      if (body?.state === "off") return { status: "paused" };
      return { status: "unknown" };
    } catch {
      return { status: "unknown" };
    }
  }

  private compileAutomationConfig(spec: BridgeAutomationSpec):
    | { readonly value: Record<string, unknown> }
    | { readonly reason: "unsupported" | "invalid_target"; readonly detail: string } {
    const entityFor = (binding: { bridgeId: string; nativeId: string; nativeInstanceId: string }): string | undefined => {
      if (binding.bridgeId !== this.context.bridgeId) return undefined;
      return [...this.bindingsByEntityId.values()].find((candidate) => (
        candidate.nativeId === binding.nativeId && candidate.nativeInstanceId === binding.nativeInstanceId
      ))?.entityId;
    };
    const conditions: Record<string, unknown>[] = [];
    let trigger: Record<string, unknown>;
    if (spec.trigger.kind === "schedule") {
      trigger = { platform: "time", at: `${spec.trigger.at}:00` };
      if (spec.trigger.daysOfWeek.length < 7) {
        const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
        conditions.push({ condition: "time", weekday: [...spec.trigger.daysOfWeek].sort().map((day) => weekdays[day]) });
      }
    } else {
      const entityId = entityFor(spec.trigger.source.binding);
      if (entityId === undefined) return { reason: "invalid_target", detail: "Trigger source is not bound to this bridge" };
      trigger = { platform: "state", entity_id: entityId };
    }
    for (const condition of spec.conditions) {
      const compiled = this.compileAutomationCondition(condition, entityFor);
      if ("reason" in compiled) return compiled;
      conditions.push(compiled.value);
    }
    const actions: Record<string, unknown>[] = [];
    for (const action of spec.actions) {
      const compiled = this.compileAutomationAction(action, spec.title, entityFor);
      if ("reason" in compiled) return compiled;
      actions.push(compiled.value);
    }
    return {
      value: {
        id: spec.automationId,
        alias: spec.automationId,
        description: `hob:${spec.title}`,
        trigger: [trigger],
        condition: conditions,
        action: actions,
        mode: "single",
      },
    };
  }

  private compileAutomationCondition(
    condition: BridgeAutomationCondition,
    entityFor: (binding: { bridgeId: string; nativeId: string; nativeInstanceId: string }) => string | undefined,
  ): { readonly value: Record<string, unknown> } | { readonly reason: "unsupported" | "invalid_target"; readonly detail: string } {
    const entityId = entityFor(condition.source.binding);
    if (entityId === undefined) return { reason: "invalid_target", detail: "Condition source is not bound to this bridge" };
    if (condition.operator === "greater_than" || condition.operator === "less_than") {
      if (typeof condition.value !== "number") {
        return { reason: "unsupported", detail: "Numeric comparison requires a numeric value" };
      }
      return {
        value: {
          condition: "numeric_state",
          entity_id: entityId,
          ...(condition.operator === "greater_than" ? { above: condition.value } : { below: condition.value }),
        },
      };
    }
    const stateCondition = { condition: "state", entity_id: entityId, state: automationStateText(condition.value) };
    return condition.operator === "equals"
      ? { value: stateCondition }
      : { value: { condition: "not", conditions: [stateCondition] } };
  }

  private compileAutomationAction(
    action: BridgeAutomationAction,
    title: string,
    entityFor: (binding: { bridgeId: string; nativeId: string; nativeInstanceId: string }) => string | undefined,
  ): { readonly value: Record<string, unknown> } | { readonly reason: "unsupported" | "invalid_target"; readonly detail: string } {
    if (action.kind === "notify_local") {
      return { value: { service: "persistent_notification.create", data: { title, message: action.message } } };
    }
    const entityId = entityFor(action.target.binding);
    if (entityId === undefined) return { reason: "invalid_target", detail: "Action target is not bound to this bridge" };
    if (action.kind === "set_boolean") {
      return { value: { service: action.value ? "homeassistant.turn_on" : "homeassistant.turn_off", target: { entity_id: entityId } } };
    }
    const domain = entityId.split(".")[0];
    const percent = Math.round(action.level * 100);
    switch (domain) {
      case "light":
        return { value: { service: "light.turn_on", target: { entity_id: entityId }, data: { brightness_pct: percent } } };
      case "cover":
        return { value: { service: "cover.set_cover_position", target: { entity_id: entityId }, data: { position: percent } } };
      case "fan":
        return { value: { service: "fan.set_percentage", target: { entity_id: entityId }, data: { percentage: percent } } };
      case "media_player":
        return { value: { service: "media_player.volume_set", target: { entity_id: entityId }, data: { volume_level: action.level } } };
      default:
        return { reason: "unsupported", detail: `Level control is not supported for ${domain} entities` };
    }
  }

  private async automationConfigRequest(
    method: "GET" | "POST" | "DELETE",
    automationId: string,
    signal: AbortSignal,
    body?: Record<string, unknown>,
  ): Promise<{ readonly ok: boolean; readonly statusCode: number; readonly body?: unknown }> {
    const accessToken = await this.resolveAccessToken();
    const fetchImpl = this.dependencies.fetchImpl ?? fetch;
    const url = new URL(`/api/config/automation/config/${automationId}`, this.context.config.baseUrl);
    const response = await fetchImpl(url, {
      method,
      signal,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let parsedBody: unknown;
    try {
      parsedBody = await response.json();
    } catch {
      parsedBody = undefined;
    }
    return { ok: response.ok, statusCode: response.status, body: parsedBody };
  }

  private describeAction(requestValue: BridgeActionDescriptorRequest): BridgeActionDescriptor | undefined {
    const parsed = bridgeActionDescriptorRequestSchema.safeParse(requestValue);
    if (!parsed.success || this.lifecycle !== "running" || this.bridge === undefined) return undefined;
    const target = parsed.data.target;
    if (target.binding.bridgeId !== this.context.bridgeId) return undefined;
    const binding = [...this.bindingsByEntityId.values()].find((candidate) => (
      candidate.nativeId === target.binding.nativeId
      && candidate.nativeInstanceId === target.binding.nativeInstanceId
    ));
    if (binding === undefined) return undefined;
    const current = this.stateAttrsByNativeInstanceId.get(binding.nativeInstanceId);
    if (current === undefined) return undefined;
    const descriptor = homeAssistantActionDescriptor(binding.entityId, current);
    const validated = bridgeActionDescriptorSchema.safeParse(descriptor);
    return validated.success ? validated.data : undefined;
  }

  private async executeAction(requestValue: BridgeActionRequest, signal: AbortSignal): Promise<BridgeActionResult> {
    const parsed = bridgeActionRequestSchema.safeParse(requestValue);
    if (!parsed.success || signal.aborted) {
      return bridgeActionResultSchema.parse({
        status: "unknown",
        reason: signal.aborted ? "cancelled" : "upstream_unavailable",
      });
    }
    const request = parsed.data;
    const target = request.action.target;
    if (target.binding.bridgeId !== this.context.bridgeId) {
      return { status: "rejected", reason: "invalid_target" };
    }
    const binding = [...this.bindingsByEntityId.values()].find((candidate) => (
      candidate.nativeId === target.binding.nativeId
      && candidate.nativeInstanceId === target.binding.nativeInstanceId
    ));
    if (binding === undefined || this.bridge === undefined) {
      return { status: "rejected", reason: "invalid_target" };
    }
    const command = homeAssistantActionCommand(request, binding.entityId);
    if (command === undefined) return { status: "rejected", reason: "unsupported" };
    try {
      await this.bridge.callService(command, signal);
      return { status: "acknowledged" };
    } catch {
      return signal.aborted
        ? { status: "unknown", reason: "cancelled" }
        : { status: "rejected", reason: "failed" };
    }
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
        if (sameScalarRecord(this.stateAttrsByNativeInstanceId.get(state.nativeInstanceId), state.attrs)) continue;
        this.stateAttrsByNativeInstanceId.set(state.nativeInstanceId, { ...state.attrs });
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
      this.stateAttrsByNativeInstanceId.clear();
      this.healthByNativeId.clear();
      this.resyncInFlight = false;
      this.lifecycle = "disposed";
    }
  }

  private prepareSnapshot(snapshot: HomeAssistantSnapshot): SnapshotEmission {
    const projection = projectSnapshot(snapshot);
    this.bindingsByEntityId = projection.bindingsByEntityId;
    this.stateAttrsByNativeInstanceId = new Map(projection.devices.flatMap((device) =>
      device.states.map((state) => [state.nativeInstanceId, { ...state.attrs }] as const)));
    this.healthByNativeId = new Map(
      projection.devices.map((device) => [device.descriptor.nativeId, device.health]),
    );
    const snapshotId = this.snapshotId();
    const epochId = `${this.context.bridgeId}:${snapshotId}:${++homeAssistantEpochCounter}`;
    const foreignRules = projectForeignRules(snapshot);
    this.foreignRuleCatalog = undefined;
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
      commitForeignRuleCatalog: (lastSeq) => {
        this.foreignRuleCatalog = { epochId, lastSeq, ...foreignRules };
      },
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
  readonly orgHints: ReadonlyMap<string, OrgHintPayload>;
}

interface SnapshotEmission {
  readonly projection: SnapshotProjection;
  readonly snapshotId: string;
  readonly epochId: string;
  readonly remoteInstanceId: string;
  readonly envelope: (event: ContractBridgeEvent) => ContractEnvelope;
  readonly commitForeignRuleCatalog: (lastSeq: number) => void;
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
    const orgHint = emission.projection.orgHints.get(device.descriptor.nativeId);
    if (orgHint !== undefined) {
      yield emission.envelope({ kind: "ext", ext: "orgHints@1", payload: orgHint });
    }
    for (const state of device.states) {
      yield emission.envelope({ kind: "state", state });
      stateEnvelopeCount += 1;
    }
    yield emission.envelope({ kind: "device-health", nativeId: device.descriptor.nativeId, status: device.health });
  }
  const complete = emission.envelope({
    kind: "sync-complete",
    manifest: { snapshotId: emission.snapshotId, deviceEnvelopeCount, stateEnvelopeCount },
  });
  emission.commitForeignRuleCatalog(complete.seq);
  yield complete;
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
  const orgHints = new Map<string, OrgHintPayload>();
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
      if (raw.entry_type === "service") {
        orgHints.set(nativeId, { nativeId, spatialDisposition: "non_spatial" });
      }
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
      const cover = isHomeAssistantCoverEntity(binding.entityId);
      const mediaPlayer = isHomeAssistantMediaPlayerEntity(binding.entityId);
      return {
        nativeInstanceId: binding.nativeInstanceId,
        schema: cover
          ? HOME_ASSISTANT_COVER_SCHEMA
          : mediaPlayer ? HOME_ASSISTANT_MEDIA_PLAYER_SCHEMA : HOME_ASSISTANT_ENTITY_SCHEMA,
        schemaVersion: cover
          ? HOME_ASSISTANT_COVER_SCHEMA_VERSION
          : mediaPlayer ? HOME_ASSISTANT_MEDIA_PLAYER_SCHEMA_VERSION : HOME_ASSISTANT_ENTITY_SCHEMA_VERSION,
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
  return { bindingsByEntityId, devices, orgHints };
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

function isHomeAssistantCoverEntity(entityId: string): boolean {
  const separator = entityId.indexOf(".");
  return separator > 0 && entityId.slice(0, separator) === "cover";
}

function isHomeAssistantMediaPlayerEntity(entityId: string): boolean {
  const separator = entityId.indexOf(".");
  return separator > 0 && entityId.slice(0, separator) === "media_player";
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
  const attrs = isHomeAssistantCoverEntity(binding.entityId)
    ? projectCoverAttributes(nativeState.state, nativeState.attrs)
    : isHomeAssistantMediaPlayerEntity(binding.entityId)
      ? projectMediaPlayerAttributes(nativeState.state, nativeState.attrs)
      : projectKnownAttributes(nativeState.state, nativeState.attrs);
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

function projectCoverAttributes(
  state: string,
  attributes: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const projected: Record<string, string | number | boolean | null> = { state };
  const knownKeys = new Set(["current_position", "supported_features", "available"]);

  if (Object.prototype.hasOwnProperty.call(attributes, "current_position")) {
    const level = normalizeCoverPosition(attributes.current_position);
    if (level !== undefined) projected.level = level;
  }

  if (Object.prototype.hasOwnProperty.call(attributes, "supported_features")) {
    const setLevelSupported = coverSetLevelSupported(attributes.supported_features);
    if (setLevelSupported !== undefined) projected.setLevelSupported = setLevelSupported;
  }

  if (Object.prototype.hasOwnProperty.call(attributes, "available")
    && typeof attributes.available === "boolean") {
    projected.available = attributes.available;
  }

  const unknownAttributeCount = Object.keys(attributes)
    .filter((key) => !knownKeys.has(key))
    .length;
  if (unknownAttributeCount > 0) projected.unknownAttributeCount = unknownAttributeCount;
  return projected;
}

function normalizeCoverPosition(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 100) return undefined;
  return value / 100;
}

function projectMediaPlayerAttributes(
  state: string,
  attributes: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const projected: Record<string, string | number | boolean | null> = { state };
  const knownKeys = new Set(["volume_level", "available"]);
  const volume = attributes.volume_level;
  if (typeof volume === "number" && Number.isFinite(volume) && volume >= 0 && volume <= 1) {
    projected.volumeLevel = volume;
  }
  if (typeof attributes.available === "boolean") projected.available = attributes.available;
  const unknownAttributeCount = Object.keys(attributes).filter((key) => !knownKeys.has(key)).length;
  if (unknownAttributeCount > 0) projected.unknownAttributeCount = unknownAttributeCount;
  return projected;
}

function coverSetLevelSupported(value: unknown): boolean | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return Math.floor(value / HOME_ASSISTANT_COVER_SET_POSITION_FEATURE) % 2 === 1;
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

function homeAssistantActionDescriptor(
  entityId: string,
  current: Readonly<Record<string, unknown>>,
): BridgeActionDescriptor | undefined {
  const domain = entityId.split(".", 1)[0];
  const state = typeof current.state === "string" ? current.state : undefined;
  if (domain === undefined || state === undefined || current.available === false
    || state === "unknown" || state === "unavailable") return undefined;

  if (["light", "switch", "fan", "input_boolean"].includes(domain)) {
    if (state !== "on" && state !== "off") return undefined;
    return { action: { kind: "set_boolean", value: state === "off" }, reversible: true };
  }
  if (domain === "lock") {
    if (state !== "locked" && state !== "unlocked") return undefined;
    return { action: { kind: "set_boolean", value: state === "locked" }, reversible: true };
  }
  if (domain === "cover") {
    if (state !== "open" && state !== "closed") return undefined;
    if (current.setLevelSupported === true && typeof current.level === "number"
      && Number.isFinite(current.level) && current.level >= 0 && current.level <= 1) {
      return {
        action: { kind: "set_level", level: current.level > 0 ? 0 : 1 },
        reversible: true,
      };
    }
    return { action: { kind: "set_boolean", value: state === "closed" }, reversible: true };
  }
  if (domain === "media_player") {
    if (["playing", "paused", "buffering"].includes(state)) {
      return { action: { kind: "stop_media" }, reversible: false };
    }
    if (typeof current.volumeLevel === "number" && Number.isFinite(current.volumeLevel)
      && current.volumeLevel >= 0 && current.volumeLevel <= 1) {
      return {
        action: { kind: "set_level", level: current.volumeLevel > 0 ? 0 : 1 },
        reversible: true,
      };
    }
  }
  return undefined;
}

function homeAssistantActionCommand(
  request: BridgeActionRequest,
  entityId: string,
): {
  readonly domain: string;
  readonly service: string;
  readonly entityId: string;
  readonly serviceData?: Readonly<Record<string, string | number | boolean>>;
} | undefined {
  const domain = entityId.split(".", 1)[0];
  if (domain === undefined) return undefined;
  const action = request.action;
  if (action.kind === "set_boolean") {
    if (["light", "switch", "fan", "input_boolean"].includes(domain)) {
      return { domain, service: action.value ? "turn_on" : "turn_off", entityId, serviceData: {} };
    }
    if (domain === "lock") {
      return { domain, service: action.value ? "unlock" : "lock", entityId, serviceData: {} };
    }
    if (domain === "cover") {
      return { domain, service: action.value ? "open_cover" : "close_cover", entityId, serviceData: {} };
    }
    return undefined;
  }
  if (action.kind === "set_level") {
    if (domain === "cover") {
      return { domain, service: "set_cover_position", entityId, serviceData: { position: Math.round(action.level * 100) } };
    }
    if (domain === "light") {
      return { domain, service: "turn_on", entityId, serviceData: { brightness_pct: Math.round(action.level * 100) } };
    }
    if (domain === "media_player") {
      return { domain, service: "volume_set", entityId, serviceData: { volume_level: action.level } };
    }
  }
  if (action.kind === "stop_media" && domain === "media_player") {
    return { domain, service: "media_stop", entityId, serviceData: {} };
  }
  return undefined;
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

function sameScalarRecord(
  left: Readonly<Record<string, unknown>> | undefined,
  right: Readonly<Record<string, unknown>>,
): boolean {
  if (left === undefined) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && left[key] === right[key]);
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

function automationStateText(value: string | number | boolean | null): string {
  if (value === null) return "unknown";
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

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
