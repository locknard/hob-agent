import { createHash, randomUUID } from "node:crypto";

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
  AUTOMATIONS_EXTENSION_V2,
  bridgeAutomationDeployRequestSchema,
  bridgeAutomationOperationIdSchema,
  bridgeAutomationSetEnabledRequestSchema,
  bridgeAutomationWithdrawRequestSchema,
  bridgeAutomationSpecSchema,
  type AutomationsExtension,
  type AutomationsExtensionV2,
  type BridgeAutomationAction,
  type BridgeAutomationCondition,
  type BridgeAutomationCommandResultV2,
  type BridgeAutomationDeployResult,
  type BridgeAutomationDeployResultV2,
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
  FOREIGN_RULE_MIGRATION_EXTENSION,
  foreignRuleMigrationRequestSchema,
  foreignRuleMigrationResultSchema,
  type ForeignRuleMigrationBinding,
  type ForeignRuleMigrationAction,
  type ForeignRuleMigrationCondition,
  type ForeignRuleMigrationHandle,
  type ForeignRuleMigrationPlan,
  type ForeignRuleMigrationResult,
  type ForeignRuleMigrationTrigger,
  type ForeignRuleMigrationUnsupportedReason,
} from "@hob/bridge-contract";
import {
  FOREIGN_RULE_CONTROL_EXTENSION,
  foreignRuleControlSetEnabledRequestSchema,
  foreignRuleControlStatusRequestSchema,
  type ForeignRuleControlHandle,
  type ForeignRuleControlSetEnabledResult,
  type ForeignRuleControlStatusResult,
} from "@hob/bridge-contract";
import {
  FOREIGN_RULES_EXTENSION,
  MAX_FOREIGN_RULES,
  type ForeignRuleCatalog,
  type ForeignRuleSummary,
  type ForeignRulesHandle,
} from "@hob/bridge-contract";
import {
  CAUSALITY_EXTENSION,
  CAUSALITY_EXTENSION_KEY,
  HISTORY_EXTENSION,
  MAX_HISTORY_RECORD_BYTES,
  MAX_HISTORY_RECORDS,
  HistoryRecordSchema,
  historyPageSchema,
  historyRequestSchema,
  type HistoryCoverageReason,
  type HistoryHandle,
  type HistoryPage,
  type HistoryRecord,
  type HistoryRequest,
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
export const MAX_HOME_ASSISTANT_FOREIGN_RULE_CONFIG_BYTES = 256 * 1024;
const MAX_HOME_ASSISTANT_AUTOMATION_CONTEXTS = 256;
const HOME_ASSISTANT_AUTOMATION_CONTEXT_TTL_MS = 60_000;
const MAX_HOME_ASSISTANT_CONTEXT_ID_LENGTH = 36;
const MAX_HOME_ASSISTANT_ENTITY_ID_LENGTH = 255;
const HOME_ASSISTANT_HISTORY_TIMEOUT_MS = 5_000;
/** Foreign-rule toggle operation entries retained for this adapter instance. */
export const MAX_HOME_ASSISTANT_FOREIGN_RULE_CONTROL_OPERATIONS = 128;
/** Automation operation entries retained for this adapter instance. */
export const MAX_HOME_ASSISTANT_AUTOMATION_OPERATIONS = 128;

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
  /** Internal adapter seam for observed automation action contexts. */
  onNativeAutomationTriggeredEvent?: (event: HomeAssistantNativeAutomationTriggeredEvent) => void;
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
  /** Sanitized presence of HA context.user_id; raw context never crosses this seam. */
  userId?: string;
  /** Ephemeral internal join key; never projected into the neutral contract. */
  contextId?: string;
}

export interface HomeAssistantNativeAutomationTriggeredEvent {
  entityId: string;
  /** Ephemeral internal join key; never projected into the neutral contract. */
  contextId: string;
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

export type HomeAssistantReadProbeResult =
  | {
      readonly status: "connected";
      readonly latencyMs: number;
      readonly summary: { readonly states: number; readonly entities: number; readonly devices: number; readonly areas: number };
      /** Bounded household-readable structure derived from the authenticated registry snapshot. */
      readonly review: HomeAssistantSetupMapReview;
    }
  | { readonly status: "credential_rejected" | "endpoint_unreachable" | "incompatible" | "timed_out" };

export interface HomeAssistantSetupMapReview {
  readonly areas: readonly { readonly name: string; readonly deviceCount: number }[];
  readonly unassignedDeviceCount: number;
  /** False means the registry snapshot cannot support a complete, unambiguous household review. */
  readonly complete: boolean;
}

export interface HomeAssistantReadProbeOptions extends HomeAssistantBridgeOptions {
  readonly clock?: () => number;
  /** Cancels this bounded authenticated setup read without retaining a bridge connection. */
  readonly signal?: AbortSignal;
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

/** Authenticates and reads one bounded snapshot without subscribing or writing. */
export async function probeHomeAssistantReadAccess(
  options: HomeAssistantReadProbeOptions,
): Promise<HomeAssistantReadProbeResult> {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const bridge = new HomeAssistantBridge(options);
  const onAbort = () => bridge.close();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (isProbeCancelled(options.signal)) return { status: "endpoint_unreachable" };
    const snapshot = await bridge.connect({ subscribeEvents: false });
    if (isProbeCancelled(options.signal)) return { status: "endpoint_unreachable" };
    return {
      status: "connected",
      latencyMs: Math.max(0, clock() - startedAt),
      summary: {
        states: snapshot.states.length,
        entities: snapshot.entityRegistry.length,
        devices: snapshot.deviceRegistry.length,
        areas: snapshot.areaRegistry.length,
      },
      review: reviewHomeAssistantSetupMap(snapshot),
    };
  } catch (error) {
    if (error instanceof BridgeStreamError && error.reason === "authentication_failed") {
      return { status: "credential_rejected" };
    }
    if (error instanceof BridgeStreamError && error.reason === "protocol_error") {
      return { status: "incompatible" };
    }
    if (error instanceof Error && /timed out|timeout/iu.test(error.message)) return { status: "timed_out" };
    return { status: "endpoint_unreachable" };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    bridge.close();
  }
}

function isProbeCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

const MAX_HOME_ASSISTANT_SETUP_REVIEW_AREAS = 64;
const MAX_HOME_ASSISTANT_SETUP_REVIEW_AREA_NAME_SCALARS = 80;

/** Projects only room labels and aggregate counts; native identifiers never cross this setup seam. */
function reviewHomeAssistantSetupMap(snapshot: HomeAssistantSnapshot): HomeAssistantSetupMapReview {
  const listedAreas = new Map<string, { name: string; deviceCount: number }>();
  const knownAreaIds = new Set<string>();
  const seenAreaIds = new Set<string>();
  const seenNames = new Set<string>();
  let complete = true;

  for (const raw of snapshot.areaRegistry) {
    if (!isRecord(raw)) {
      complete = false;
      continue;
    }
    const id = setupRegistryText(raw.area_id ?? raw.id, 256);
    const name = setupAreaName(raw.name);
    if (id === undefined) {
      complete = false;
      continue;
    }
    knownAreaIds.add(id);
    if (name === undefined) {
      complete = false;
      continue;
    }
    if (seenAreaIds.has(id) || seenNames.has(name)) {
      complete = false;
      continue;
    }
    seenAreaIds.add(id);
    seenNames.add(name);
    if (listedAreas.size >= MAX_HOME_ASSISTANT_SETUP_REVIEW_AREAS) {
      complete = false;
      continue;
    }
    listedAreas.set(id, { name, deviceCount: 0 });
  }

  const seenDeviceIds = new Set<string>();
  let unassignedDeviceCount = 0;
  for (const raw of snapshot.deviceRegistry) {
    if (!isRecord(raw)) {
      complete = false;
      unassignedDeviceCount += 1;
      continue;
    }
    const id = setupRegistryText(raw.id, 256);
    if (id === undefined || seenDeviceIds.has(id)) {
      complete = false;
      unassignedDeviceCount += 1;
      continue;
    }
    seenDeviceIds.add(id);
    const areaId = raw.area_id === undefined || raw.area_id === null ? undefined : setupRegistryText(raw.area_id, 256);
    if (raw.area_id !== undefined && raw.area_id !== null && areaId === undefined) complete = false;
    if (areaId === undefined || !knownAreaIds.has(areaId)) {
      unassignedDeviceCount += 1;
      continue;
    }
    const area = listedAreas.get(areaId);
    if (area === undefined) unassignedDeviceCount += 1;
    else area.deviceCount += 1;
  }

  return Object.freeze({
    areas: Object.freeze([...listedAreas.values()].map((area) => Object.freeze({ ...area }))),
    unassignedDeviceCount,
    complete,
  });
}

function setupRegistryText(value: unknown, maximumScalars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" || Array.from(text).length > maximumScalars || /[\u0000-\u001f\u007f]/u.test(text)
    ? undefined
    : text;
}

function setupAreaName(value: unknown): string | undefined {
  return setupRegistryText(value, MAX_HOME_ASSISTANT_SETUP_REVIEW_AREA_NAME_SCALARS);
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

  connect(options: { readonly subscribeEvents?: boolean } = {}): Promise<HomeAssistantSnapshot> {
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
      }, failConnection, options.subscribeEvents ?? true);
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
    }, signal);
    if (signal.aborted) throw signal.reason ?? new Error("Home Assistant action cancelled");
  }

  private handleMessage(
    data: string,
    resolveConnect: (snapshot: HomeAssistantSnapshot) => void,
    rejectConnect: (error: Error) => void,
    markAuthenticated: () => void,
    failConnection: (error: Error) => void,
    subscribeEvents: boolean,
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
      void this.bootstrap(subscribeEvents).then(resolveConnect, rejectConnect);
      return;
    }
    if (message.type === "result" && typeof message.id === "number") {
      this.resolveCommand(message as unknown as ResultMessage);
      return;
    }
    if (message.type === "event" && typeof message.id === "number") {
      this.forwardStateEvent(message);
      this.forwardAutomationTriggeredEvent(message);
    }
  }

  private async bootstrap(subscribeEvents: boolean): Promise<HomeAssistantSnapshot> {
    return this.loadSnapshot(subscribeEvents);
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
    const stateSubscription = subscribeEvents
      ? this.command("subscribe_events", { event_type: "state_changed" })
      : Promise.resolve(undefined);
    // HA may reject this event subscription for non-admin tokens.  The state
    // stream remains the required path; absent evidence stays unknown.
    const automationSubscription = subscribeEvents
      ? this.command("subscribe_events", { event_type: "automation_triggered" }).catch(() => undefined)
      : Promise.resolve(undefined);
    const [states, entityRegistry, deviceRegistry, areaRegistry] = await Promise.all(commands);
    await stateSubscription;
    await automationSubscription;
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

  private command(
    type: string,
    payload: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.nextCommandId++;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        const reason = signal?.reason;
        reject(reason instanceof Error ? reason : new Error("Home Assistant command cancelled"));
      };
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      this.pending.set(id, {
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        this.send({ id, type, ...payload });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error instanceof Error ? error : new Error("Home Assistant command failed"));
      }
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
    const userId = isRecord(event.context)
      ? boundedHomeAssistantUserId(event.context.user_id)
      : undefined;
    const contextId = resolveHomeAssistantStateContextId(event.context, newState.context);
    const nativeEvent: HomeAssistantNativeStateEvent = {
      entityId,
      state: newState.state,
      attrs: newState.attributes,
      ts: event.time_fired,
      ...(userId === undefined ? {} : { userId }),
      ...(contextId === undefined ? {} : { contextId }),
    };
    this.options.onNativeStateEvent?.(nativeEvent);
  }

  private forwardAutomationTriggeredEvent(message: Record<string, unknown>): void {
    const event = message.event;
    if (!isRecord(event) || event.event_type !== "automation_triggered" || !isRecord(event.data)) return;
    const entityId = boundedHomeAssistantEntityId(event.data.entity_id);
    const contextId = isRecord(event.context)
      ? boundedHomeAssistantContextId(event.context.id)
      : undefined;
    if (entityId === undefined || !entityId.startsWith("automation.") || contextId === undefined) return;
    this.options.onNativeAutomationTriggeredEvent?.({ entityId, contextId });
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
export const HOME_ASSISTANT_BOOLEAN_ACTUATOR_SCHEMA = "ha.boolean-actuator";
export const HOME_ASSISTANT_BOOLEAN_ACTUATOR_SCHEMA_VERSION = "1.0.0";
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
  /** Test-only import identifier seam; production uses a collision-resistant UUID. */
  readonly historyImportIdFactory?: () => string;
  /** Test-only deadline seam; production keeps the profile's five-second deadline. */
  readonly historyTimeoutMs?: number;
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

const HOME_ASSISTANT_BOOLEAN_ACTUATOR_SCHEMA_CANONICAL_FORM = [
  "schema=ha.boolean-actuator",
  "majorVersion=1",
  "state=string",
  "value=boolean",
  "available=boolean",
  "unknownAttributeCount=number",
].join("|");

export const HOME_ASSISTANT_BOOLEAN_ACTUATOR_SCHEMA_CANONICAL_HASH = `sha256:${createHash("sha256")
  .update(HOME_ASSISTANT_BOOLEAN_ACTUATOR_SCHEMA_CANONICAL_FORM)
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

const homeAssistantBooleanActuatorAttrsSchema = z
  .object({
    state: z.string(),
    value: z.boolean().optional(),
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
    schema: HOME_ASSISTANT_BOOLEAN_ACTUATOR_SCHEMA,
    majorVersion: 1,
    attrsSchema: homeAssistantBooleanActuatorAttrsSchema,
    canonicalHash: HOME_ASSISTANT_BOOLEAN_ACTUATOR_SCHEMA_CANONICAL_HASH,
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

/**
 * Keeps the HA user identifier out of the neutral model while retaining a
 * stable, bridge-domain-scoped principal reference for confirmed attribution.
 */
export function deriveHomeAssistantPrincipalRef(bridgeId: string, userId: string): string | undefined {
  const domain = boundedHomeAssistantUserId(bridgeId);
  const principal = boundedHomeAssistantUserId(userId);
  if (domain === undefined || principal === undefined) return undefined;
  const material = `home-assistant-causality-principal-v1\n${domain}\n${principal}`;
  return `principal:${createHash("sha256").update(material).digest("hex")}`;
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
  private foreignRuleConfigIdsByRef = new Map<string, string>();
  private foreignRuleTitlesByRef = new Map<string, string>();
  private foreignRuleRefsByAutomationEntityId = new Map<string, string>();
  private observedAutomationContexts = new Map<string, { readonly ruleRef: string; readonly observedAtMs: number }>();
  private foreignRuleControlOperations = new Map<string, ForeignRuleControlOperationEntry>();
  private automationOperations = new Map<string, HomeAssistantAutomationOperationEntry>();
  private historyInFlight = false;
  private historyAbortController: AbortController | undefined;
  private historyGeneration = 0;
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
      extensions: Object.freeze([
        FOREIGN_RULES_EXTENSION,
        FOREIGN_RULE_MIGRATION_EXTENSION,
        FOREIGN_RULE_CONTROL_EXTENSION,
        CAUSALITY_EXTENSION,
        ORG_HINTS_EXTENSION,
        ACTIONS_EXTENSION,
        AUTOMATIONS_EXTENSION,
        AUTOMATIONS_EXTENSION_V2,
        HISTORY_EXTENSION,
      ]),
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
    if (name === "history@1") {
      const handle: HistoryHandle = {
        fetchHistory: (request, options) => this.fetchHistory(request, options.signal),
      };
      return handle as ExtensionHandleRegistry[K];
    }
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
    if (name === "foreignRuleMigration@1") {
      const handle: ForeignRuleMigrationHandle = {
        translate: (request, options) => this.translateForeignRule(request, options.signal),
      };
      return handle as ExtensionHandleRegistry[K];
    }
    if (name === "foreignRuleControl@1") {
      const handle: ForeignRuleControlHandle = {
        status: (request, options) => this.foreignRuleControlStatus(request, options.signal),
        setEnabled: (request, options) => this.setForeignRuleEnabled(request, options.signal),
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
    if (name === "automations@2") {
      const handle: AutomationsExtensionV2 = {
        status: (request, options) => this.automationStatus(request, options.signal),
        deploy: (request, options) => this.deployAutomationV2(request, options.signal),
        setEnabled: (request, options) => this.setAutomationEnabledV2(request, options.signal),
        withdraw: (request, options) => this.withdrawAutomationV2(request, options.signal),
      };
      return handle as ExtensionHandleRegistry[K];
    }
    return undefined;
  }

  /**
   * Reads one rule selected from the foreignRules@2 catalog.  The catalog
   * reference is the only caller-controlled lookup key; native config ids
   * remain private to this adapter and are never copied into the result.
   */
  private async translateForeignRule(
    requestValue: unknown,
    signal: AbortSignal,
  ): Promise<ForeignRuleMigrationResult> {
    const request = foreignRuleMigrationRequestSchema.safeParse(requestValue);
    if (!request.success) return { status: "unsupported", reason: "unsupported_structure" };
    if (signal.aborted) return { status: "unavailable", reason: "cancelled" };
    if (this.lifecycle !== "running" || this.bridge === undefined || this.foreignRuleCatalog === undefined) {
      return { status: "unavailable", reason: "not_ready" };
    }
    const nativeConfigId = this.foreignRuleConfigIdsByRef.get(request.data.ruleRef);
    if (nativeConfigId === undefined) return { status: "unsupported", reason: "unknown_rule" };

    try {
      const fetched = await this.foreignRuleConfigRequest(nativeConfigId, signal);
      if (signal.aborted) return { status: "unavailable", reason: "cancelled" };
      if (!fetched.ok) return { status: "unavailable", reason: fetched.invalidResponse ? "invalid_response" : "upstream_unavailable" };
      const canonical = canonicalNativeJson(fetched.body);
      if (canonical === undefined || Buffer.byteLength(canonical, "utf8") > MAX_HOME_ASSISTANT_FOREIGN_RULE_CONFIG_BYTES) {
        return { status: "unavailable", reason: "invalid_response" };
      }
      const sourceFingerprint = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
      const parsed = await translateHomeAssistantRuleConfig(
        fetched.body,
        (entityId) => this.migrationBindingForEntity(entityId),
        this.foreignRuleTitlesByRef.get(request.data.ruleRef),
        (instanceTimezoneSignal) => this.instanceTimezone(instanceTimezoneSignal),
        signal,
      );
      if (parsed.status !== "translated") return parsed;
      const result = foreignRuleMigrationResultSchema.safeParse({
        status: "translated",
        ruleRef: request.data.ruleRef,
        sourceFingerprint,
        title: parsed.title,
        plan: parsed.plan,
      });
      return result.success
        ? result.data
        : { status: "unavailable", reason: "invalid_response" };
    } catch {
      return signal.aborted
        ? { status: "unavailable", reason: "cancelled" }
        : { status: "unavailable", reason: "upstream_unavailable" };
    }
  }

  private migrationBindingForEntity(entityId: string): ForeignRuleMigrationBinding | undefined {
    const binding = this.bindingsByEntityId.get(entityId);
    if (binding === undefined) return undefined;
    return {
      bridgeId: this.context.bridgeId,
      nativeId: binding.nativeId,
      nativeInstanceId: binding.nativeInstanceId,
    };
  }

  private async foreignRuleControlStatus(
    requestValue: unknown,
    signal: AbortSignal,
  ): Promise<ForeignRuleControlStatusResult> {
    const parsed = foreignRuleControlStatusRequestSchema.safeParse(requestValue);
    if (!parsed.success) return { status: "unknown", reason: "invalid_response" };
    if (signal.aborted || this.lifecycle !== "running") return { status: "unknown", reason: "unavailable" };
    const nativeConfigId = this.foreignRuleConfigIdsByRef.get(parsed.data.ruleRef);
    if (nativeConfigId === undefined) return { status: "missing" };
    try {
      return await this.readForeignRuleControlState(nativeConfigId, signal);
    } catch {
      return { status: "unknown", reason: "unavailable" };
    }
  }

  private setForeignRuleEnabled(
    requestValue: unknown,
    signal: AbortSignal,
  ): Promise<ForeignRuleControlSetEnabledResult> {
    const parsed = foreignRuleControlSetEnabledRequestSchema.safeParse(requestValue);
    if (!parsed.success) return Promise.resolve({ status: "rejected", reason: "failed" });
    if (signal.aborted) return Promise.resolve({ status: "unknown", reason: "cancelled" });
    if (this.lifecycle !== "running" || this.bridge === undefined) {
      return Promise.resolve({ status: "rejected", reason: "unavailable" });
    }

    const request = parsed.data;
    const requestKey = foreignRuleControlRequestKey(request);
    const existing = this.foreignRuleControlOperations.get(request.operationId);
    if (existing !== undefined) {
      return existing.requestKey === requestKey
        ? existing.result
        : Promise.resolve({ status: "rejected", reason: "failed" });
    }

    if (!this.reserveForeignRuleControlOperation(request.operationId)) {
      return Promise.resolve({ status: "rejected", reason: "unavailable" });
    }

    const result = this.performForeignRuleEnabled(request, signal).catch(() => (
      signal.aborted
        ? { status: "unknown", reason: "cancelled" } as const
        : { status: "unknown", reason: "upstream_unavailable" } as const
    ));
    const entry: ForeignRuleControlOperationEntry = {
      requestKey,
      result,
      settled: false,
    };
    this.foreignRuleControlOperations.set(request.operationId, entry);
    void result.then(
      () => { entry.settled = true; },
      () => { entry.settled = true; },
    );
    return result;
  }

  private reserveForeignRuleControlOperation(operationId: string): boolean {
    if (this.foreignRuleControlOperations.size >= MAX_HOME_ASSISTANT_FOREIGN_RULE_CONTROL_OPERATIONS) {
      const evictable = [...this.foreignRuleControlOperations.entries()]
        .find(([, entry]) => entry.settled)?.[0];
      if (evictable === undefined) return false;
      this.foreignRuleControlOperations.delete(evictable);
    }
    return true;
  }

  private async performForeignRuleEnabled(
    request: {
      readonly ruleRef: string;
      readonly expectedSourceFingerprint: string;
      readonly enabled: boolean;
      readonly operationId: string;
    },
    signal: AbortSignal,
  ): Promise<ForeignRuleControlSetEnabledResult> {
    const bridge = this.bridge;
    if (this.lifecycle !== "running" || bridge === undefined) return { status: "rejected", reason: "unavailable" };
    const nativeConfigId = this.foreignRuleConfigIdsByRef.get(request.ruleRef);
    if (nativeConfigId === undefined) return { status: "rejected", reason: "not_found" };

    let preflight: ForeignRuleControlConfigRead;
    try {
      preflight = await this.readForeignRuleControlConfig(nativeConfigId, signal);
    } catch {
      return { status: "rejected", reason: "unavailable" };
    }
    if (preflight.status === "missing") return { status: "rejected", reason: "not_found" };
    if (preflight.status === "unavailable") return { status: "rejected", reason: "unavailable" };
    if (preflight.status === "invalid") return { status: "rejected", reason: "failed" };
    if (preflight.sourceFingerprint !== request.expectedSourceFingerprint) {
      return { status: "rejected", reason: "stale_source" };
    }

    try {
      await bridge.callService({
        domain: "automation",
        service: request.enabled ? "turn_on" : "turn_off",
        entityId: `automation.${nativeConfigId}`,
      }, signal);
    } catch {
      return signal.aborted
        ? { status: "unknown", reason: "cancelled" }
        : { status: "unknown", reason: "upstream_unavailable" };
    }

    try {
      const observed = await this.readForeignRuleControlState(nativeConfigId, signal);
      const expectedStatus = request.enabled ? "running" : "paused";
      if (observed.status === expectedStatus
        && observed.sourceFingerprint === request.expectedSourceFingerprint) {
        return observed;
      }
      return signal.aborted
        ? { status: "unknown", reason: "cancelled" }
        : { status: "unknown", reason: "upstream_unavailable" };
    } catch {
      return signal.aborted
        ? { status: "unknown", reason: "cancelled" }
        : { status: "unknown", reason: "upstream_unavailable" };
    }
  }

  private async readForeignRuleControlState(
    nativeConfigId: string,
    signal: AbortSignal,
  ): Promise<ForeignRuleControlStatusResult> {
    const accessToken = await this.resolveAccessToken();
    const fetchImpl = this.dependencies.fetchImpl ?? fetch;
    const stateResponse = await fetchImpl(
      new URL(`/api/states/automation.${nativeConfigId}`, this.context.config.baseUrl),
      { signal, headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (stateResponse.status === 404) return { status: "missing" };
    if (!stateResponse.ok) return { status: "unknown", reason: "unavailable" };
    let stateBody: unknown;
    try {
      stateBody = await stateResponse.json();
    } catch {
      return { status: "unknown", reason: "invalid_response" };
    }
    if (!isRecord(stateBody) || (stateBody.state !== "on" && stateBody.state !== "off")) {
      return { status: "unknown", reason: "invalid_response" };
    }
    const config = await this.readForeignRuleControlConfig(nativeConfigId, signal);
    if (config.status === "missing") return { status: "missing" };
    if (config.status === "unavailable") return { status: "unknown", reason: "unavailable" };
    if (config.status === "invalid") return { status: "unknown", reason: "invalid_response" };
    return {
      status: stateBody.state === "on" ? "running" : "paused",
      sourceFingerprint: config.sourceFingerprint,
    };
  }

  private async readForeignRuleControlConfig(
    nativeConfigId: string,
    signal: AbortSignal,
  ): Promise<ForeignRuleControlConfigRead> {
    let response: { readonly ok: boolean; readonly statusCode: number; readonly body?: unknown };
    try {
      response = await this.automationConfigRequest("GET", nativeConfigId, signal);
    } catch {
      return { status: "unavailable" };
    }
    if (response.statusCode === 404) return { status: "missing" };
    if (!response.ok) return { status: "unavailable" };
    const fingerprint = sourceAutomationFingerprint(response.body);
    return fingerprint === undefined
      ? { status: "invalid" }
      : { status: "ok", sourceFingerprint: fingerprint };
  }

  private async foreignRuleConfigRequest(
    nativeConfigId: string,
    signal: AbortSignal,
  ): Promise<{ readonly ok: boolean; readonly body?: unknown; readonly invalidResponse?: boolean }> {
    const accessToken = await this.resolveAccessToken();
    const fetchImpl = this.dependencies.fetchImpl ?? fetch;
    const response = await fetchImpl(
      new URL(`/api/config/automation/config/${encodeURIComponent(nativeConfigId)}`, this.context.config.baseUrl),
      { method: "GET", signal, headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) return { ok: false };
    try {
      const bodyText = await response.text();
      if (Buffer.byteLength(bodyText, "utf8") > MAX_HOME_ASSISTANT_FOREIGN_RULE_CONFIG_BYTES) {
        return { ok: false, invalidResponse: true };
      }
      return { ok: true, body: JSON.parse(bodyText) as unknown };
    } catch {
      return { ok: false, invalidResponse: true };
    }
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
      if (spec.trigger.kind === "schedule") {
        const instanceTimezone = await this.instanceTimezone(signal);
        if (instanceTimezone === undefined) {
          return { status: "rejected", reason: "unavailable", detail: "Home Assistant timezone is unavailable" };
        }
        // A time trigger runs in the instance timezone; deploying a schedule
        // into a different clock would silently shift the household's plan.
        if (instanceTimezone !== spec.trigger.timezone) {
          return { status: "rejected", reason: "unsupported", detail: `Home Assistant runs in ${instanceTimezone}, not ${spec.trigger.timezone}` };
        }
      }

      // A deterministic id is an ownership boundary.  Only a confirmed
      // missing config may proceed to POST; an existing config is immutable
      // unless it carries our marker and the compiled behavior is unchanged.
      const existing = await this.automationConfigRequest("GET", spec.automationId, signal);
      if (existing.statusCode !== 404) {
        if (!existing.ok) {
          return { status: "rejected", reason: "unavailable", detail: "Home Assistant automation config is unavailable" };
        }
        if (!isRecord(existing.body) || !storedAutomationMatches(config.value, existing.body)) {
          return { status: "rejected", reason: "failed", detail: "Home Assistant automation is not an unchanged Hub-owned config" };
        }
        return {
          status: "deployed",
          nativeAutomationId: spec.automationId,
          configFingerprint: automationConfigFingerprint(existing.body),
        };
      }

      const written = await this.automationConfigRequest("POST", spec.automationId, signal, config.value);
      if (!written.ok) {
        return { status: "rejected", reason: "failed", detail: `Home Assistant rejected the automation (${written.statusCode})` };
      }
      const readBack = await this.automationConfigRequest("GET", spec.automationId, signal);
      // A successful write still requires ownership and exact behavioral
      // read-back before the deployment becomes observable as deployed.
      if (!readBack.ok || !isRecord(readBack.body) || !storedAutomationMatches(config.value, readBack.body)) {
        return { status: "rejected", reason: "failed", detail: "Home Assistant did not store the compiled automation" };
      }
      return {
        status: "deployed",
        nativeAutomationId: spec.automationId,
        configFingerprint: automationConfigFingerprint(readBack.body),
      };
    } catch {
      return { status: "rejected", reason: "unavailable", detail: "Home Assistant configuration API is unreachable" };
    }
  }

  private async instanceTimezone(signal: AbortSignal): Promise<string | undefined> {
    try {
      const accessToken = await this.resolveAccessToken();
      const fetchImpl = this.dependencies.fetchImpl ?? fetch;
      const response = await fetchImpl(new URL("/api/config", this.context.config.baseUrl), {
        signal,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) return undefined;
      const body = await response.json() as { time_zone?: unknown };
      return typeof body?.time_zone === "string" && body.time_zone.length > 0 ? body.time_zone : undefined;
    } catch {
      return undefined;
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
      const existing = await this.automationConfigRequest("GET", request.nativeAutomationId, signal);
      if (existing.statusCode === 404) return { status: "acknowledged" };
      if (!existing.ok) {
        return { status: "rejected", reason: "unavailable", detail: "Home Assistant automation config is unavailable" };
      }
      if (!isRecord(existing.body) || !hasHomeAssistantAutomationOwnershipMarker(request.nativeAutomationId, existing.body)) {
        return { status: "rejected", reason: "failed", detail: "Home Assistant automation is not Hub-owned" };
      }
      const deleted = await this.automationConfigRequest("DELETE", request.nativeAutomationId, signal);
      if (deleted.ok || deleted.statusCode === 404) return { status: "acknowledged" };
      return { status: "rejected", reason: "failed", detail: `Home Assistant rejected the removal (${deleted.statusCode})` };
    } catch {
      return { status: "rejected", reason: "unavailable", detail: "Home Assistant configuration API is unreachable" };
    }
  }

  private async deployAutomationV2(
    requestValue: Parameters<AutomationsExtensionV2["deploy"]>[0],
    signal: AbortSignal,
  ): Promise<BridgeAutomationDeployResultV2> {
    const operationId = automationOperationId(requestValue);
    const parsed = bridgeAutomationDeployRequestSchema.safeParse(requestValue);
    if (!parsed.success) {
      return { status: "rejected", operationId, reason: "failed", detail: "Automation deploy request is invalid" };
    }
    const request = parsed.data;
    return this.runAutomationOperation(
      request.operationId,
      "deploy",
      automationOperationRequestKey("deploy", request),
      () => this.performAutomationDeployV2(request, signal),
      () => ({ status: "rejected", operationId: request.operationId, reason: "failed" }),
      () => ({ status: "unknown", operationId: request.operationId, reason: "unavailable" }),
    );
  }

  private async performAutomationDeployV2(
    request: Parameters<AutomationsExtensionV2["deploy"]>[0],
    signal: AbortSignal,
  ): Promise<BridgeAutomationDeployResultV2> {
    if (this.lifecycle !== "running") {
      return { status: "rejected", operationId: request.operationId, reason: "unavailable", detail: "Home Assistant bridge is not running" };
    }
    const spec = request.spec;
    const config = this.compileAutomationConfig(spec);
    if ("reason" in config) {
      return { status: "rejected", operationId: request.operationId, reason: config.reason, detail: config.detail };
    }
    try {
      if (spec.trigger.kind === "schedule") {
        const instanceTimezone = await this.instanceTimezone(signal);
        if (instanceTimezone === undefined) {
          return { status: "rejected", operationId: request.operationId, reason: "unavailable", detail: "Home Assistant timezone is unavailable" };
        }
        if (instanceTimezone !== spec.trigger.timezone) {
          return { status: "rejected", operationId: request.operationId, reason: "unsupported", detail: `Home Assistant runs in ${instanceTimezone}, not ${spec.trigger.timezone}` };
        }
      }

      const existing = await this.automationConfigRequest("GET", spec.automationId, signal);
      if (existing.statusCode !== 404) {
        if (!existing.ok) {
          return { status: "rejected", operationId: request.operationId, reason: "unavailable", detail: "Home Assistant automation config is unavailable" };
        }
        if (!isRecord(existing.body) || !storedAutomationMatches(config.value, existing.body)) {
          return { status: "rejected", operationId: request.operationId, reason: "failed", detail: "Home Assistant automation is not an unchanged Hub-owned config" };
        }
        return {
          status: "deployed",
          operationId: request.operationId,
          nativeAutomationId: spec.automationId,
          configFingerprint: automationConfigFingerprint(existing.body),
        };
      }

      let written: { readonly ok: boolean; readonly statusCode: number; readonly body?: unknown };
      try {
        written = await this.automationConfigRequest("POST", spec.automationId, signal, config.value);
      } catch {
        return { status: "unknown", operationId: request.operationId, reason: "unavailable" };
      }
      if (!written.ok) {
        return { status: "rejected", operationId: request.operationId, reason: "failed", detail: `Home Assistant rejected the automation (${written.statusCode})` };
      }

      let readBack: { readonly ok: boolean; readonly statusCode: number; readonly body?: unknown };
      try {
        readBack = await this.automationConfigRequest("GET", spec.automationId, signal);
      } catch {
        return { status: "unknown", operationId: request.operationId, reason: "unavailable" };
      }
      if (!readBack.ok || !isRecord(readBack.body) || !storedAutomationMatches(config.value, readBack.body)) {
        return { status: "unknown", operationId: request.operationId, reason: "not_confirmed" };
      }
      return {
        status: "deployed",
        operationId: request.operationId,
        nativeAutomationId: spec.automationId,
        configFingerprint: automationConfigFingerprint(readBack.body),
      };
    } catch {
      return { status: "rejected", operationId: request.operationId, reason: "unavailable", detail: "Home Assistant configuration API is unreachable" };
    }
  }

  private async setAutomationEnabledV2(
    requestValue: Parameters<AutomationsExtensionV2["setEnabled"]>[0],
    signal: AbortSignal,
  ): Promise<BridgeAutomationCommandResultV2> {
    const operationId = automationOperationId(requestValue);
    const parsed = bridgeAutomationSetEnabledRequestSchema.safeParse(requestValue);
    if (!parsed.success) {
      return { status: "rejected", operationId, reason: "failed", detail: "Automation toggle request is invalid" };
    }
    const request = parsed.data;
    return this.runAutomationOperation(
      request.operationId,
      "set_enabled",
      automationOperationRequestKey("set_enabled", request),
      () => this.performAutomationEnabledV2(request, signal),
      () => ({ status: "rejected", operationId: request.operationId, reason: "failed" }),
      () => ({ status: "unknown", operationId: request.operationId, reason: "unavailable" }),
    );
  }

  private async performAutomationEnabledV2(
    request: Parameters<AutomationsExtensionV2["setEnabled"]>[0],
    signal: AbortSignal,
  ): Promise<BridgeAutomationCommandResultV2> {
    if (this.lifecycle !== "running" || this.bridge === undefined) {
      return { status: "rejected", operationId: request.operationId, reason: "unavailable", detail: "Home Assistant bridge is not running" };
    }
    const current = await this.automationStatus({ nativeAutomationId: request.nativeAutomationId }, signal);
    if (current.status === "missing") {
      return { status: "rejected", operationId: request.operationId, reason: "not_found", detail: "Unknown automation id" };
    }
    if (current.status === "unknown") {
      return { status: "rejected", operationId: request.operationId, reason: "unavailable", detail: "Home Assistant automation state is unavailable" };
    }
    const expected = request.enabled ? "running" : "paused";
    if (current.status === expected) return { status: "acknowledged", operationId: request.operationId };

    try {
      await this.bridge.callService({
        domain: "automation",
        service: request.enabled ? "turn_on" : "turn_off",
        entityId: `automation.${request.nativeAutomationId}`,
      }, signal);
    } catch {
      return { status: "unknown", operationId: request.operationId, reason: "unavailable" };
    }
    const observed = await this.automationStatus({ nativeAutomationId: request.nativeAutomationId }, signal);
    return observed.status === expected
      ? { status: "acknowledged", operationId: request.operationId }
      : { status: "unknown", operationId: request.operationId, reason: "not_confirmed" };
  }

  private async withdrawAutomationV2(
    requestValue: Parameters<AutomationsExtensionV2["withdraw"]>[0],
    signal: AbortSignal,
  ): Promise<BridgeAutomationCommandResultV2> {
    const operationId = automationOperationId(requestValue);
    const parsed = bridgeAutomationWithdrawRequestSchema.safeParse(requestValue);
    if (!parsed.success) {
      return { status: "rejected", operationId, reason: "failed", detail: "Automation withdrawal request is invalid" };
    }
    const request = parsed.data;
    return this.runAutomationOperation(
      request.operationId,
      "withdraw",
      automationOperationRequestKey("withdraw", request),
      () => this.performAutomationWithdrawV2(request, signal),
      () => ({ status: "rejected", operationId: request.operationId, reason: "failed" }),
      () => ({ status: "unknown", operationId: request.operationId, reason: "unavailable" }),
    );
  }

  private async performAutomationWithdrawV2(
    request: Parameters<AutomationsExtensionV2["withdraw"]>[0],
    signal: AbortSignal,
  ): Promise<BridgeAutomationCommandResultV2> {
    if (this.lifecycle !== "running") {
      return { status: "rejected", operationId: request.operationId, reason: "unavailable", detail: "Home Assistant bridge is not running" };
    }
    let existing: { readonly ok: boolean; readonly statusCode: number; readonly body?: unknown };
    try {
      existing = await this.automationConfigRequest("GET", request.nativeAutomationId, signal);
    } catch {
      return { status: "rejected", operationId: request.operationId, reason: "unavailable", detail: "Home Assistant automation config is unavailable" };
    }
    if (existing.statusCode === 404) return { status: "acknowledged", operationId: request.operationId };
    if (!existing.ok) {
      return { status: "rejected", operationId: request.operationId, reason: "unavailable", detail: "Home Assistant automation config is unavailable" };
    }
    if (!isRecord(existing.body) || !hasHomeAssistantAutomationOwnershipMarker(request.nativeAutomationId, existing.body)) {
      return { status: "rejected", operationId: request.operationId, reason: "failed", detail: "Home Assistant automation is not Hub-owned" };
    }

    let deleted: { readonly ok: boolean; readonly statusCode: number; readonly body?: unknown };
    try {
      deleted = await this.automationConfigRequest("DELETE", request.nativeAutomationId, signal);
    } catch {
      return { status: "unknown", operationId: request.operationId, reason: "unavailable" };
    }
    if (deleted.statusCode === 404) return { status: "acknowledged", operationId: request.operationId };
    if (!deleted.ok) {
      return { status: "rejected", operationId: request.operationId, reason: "failed", detail: `Home Assistant rejected the removal (${deleted.statusCode})` };
    }

    let readBack: { readonly ok: boolean; readonly statusCode: number; readonly body?: unknown };
    try {
      readBack = await this.automationConfigRequest("GET", request.nativeAutomationId, signal);
    } catch {
      return { status: "unknown", operationId: request.operationId, reason: "unavailable" };
    }
    return readBack.statusCode === 404
      ? { status: "acknowledged", operationId: request.operationId }
      : { status: "unknown", operationId: request.operationId, reason: readBack.ok ? "not_confirmed" : "unavailable" };
  }

  private runAutomationOperation<T extends HomeAssistantAutomationOperationResult>(
    operationId: string,
    kind: HomeAssistantAutomationOperationKind,
    requestKey: string,
    perform: () => Promise<T>,
    collision: () => T,
    unavailable: () => T,
  ): Promise<T> {
    const existing = this.automationOperations.get(operationId);
    if (existing !== undefined) {
      if (existing.kind !== kind || existing.requestKey !== requestKey) return Promise.resolve(collision());
      if (!existing.settled || existing.lastResult?.status !== "unknown") {
        return existing.result as Promise<T>;
      }
    } else if (!this.reserveAutomationOperation()) {
      return Promise.resolve(unavailable());
    }

    const result = Promise.resolve().then(perform).catch(() => unavailable());
    const entry = existing ?? {
      kind,
      requestKey,
      result: result as Promise<HomeAssistantAutomationOperationResult>,
      settled: false,
    } satisfies HomeAssistantAutomationOperationEntry;
    entry.result = result as Promise<HomeAssistantAutomationOperationResult>;
    entry.settled = false;
    entry.lastResult = undefined;
    this.automationOperations.set(operationId, entry);
    void result.then((value) => {
      entry.lastResult = value;
      entry.settled = true;
    });
    return result;
  }

  private reserveAutomationOperation(): boolean {
    if (this.automationOperations.size < MAX_HOME_ASSISTANT_AUTOMATION_OPERATIONS) return true;
    const evictable = [...this.automationOperations.entries()].find(([, entry]) => entry.settled)?.[0];
    if (evictable === undefined) return false;
    this.automationOperations.delete(evictable);
    return true;
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
      const state = body?.state === "on" ? "running" as const : body?.state === "off" ? "paused" as const : undefined;
      if (state === undefined) return { status: "unknown" };
      try {
        const config = await this.automationConfigRequest("GET", request.nativeAutomationId, signal);
        return config.ok && isRecord(config.body) && isStoredAutomationConfig(config.body, request.nativeAutomationId)
          ? { status: state, configFingerprint: automationConfigFingerprint(config.body) }
          : { status: "unknown" };
      } catch {
        return { status: "unknown" };
      }
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

  private async fetchHistory(requestValue: HistoryRequest, signal: AbortSignal): Promise<HistoryPage> {
    const parsed = historyRequestSchema.safeParse(requestValue);
    if (!parsed.success) throw new TypeError("Home Assistant history request is invalid");
    const request = parsed.data;
    const importId = this.nextHistoryImportId();
    if (signal.aborted) return historyUnavailablePage(request, importId, "cancelled");
    if (this.lifecycle !== "running" || this.bridge === undefined) {
      return historyUnavailablePage(request, importId, "history_unavailable");
    }
    if (this.resyncInFlight) return historyUnavailablePage(request, importId, "resync_stale");
    const resolved = resolveHistoryBindings(this.bindingsByEntityId, request.bindings);
    if (resolved === undefined) return historyUnavailablePage(request, importId, "history_unavailable");
    if (this.historyInFlight) return historyUnavailablePage(request, importId, "busy");

    this.historyInFlight = true;
    const historyGeneration = this.historyGeneration;
    const timeoutController = new AbortController();
    this.historyAbortController = timeoutController;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, this.dependencies.historyTimeoutMs ?? HOME_ASSISTANT_HISTORY_TIMEOUT_MS);
    const onAbort = (): void => timeoutController.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const credential = await awaitHomeAssistantHistoryOperation(
        () => this.resolveAccessToken(),
        timeoutController.signal,
      );
      if (historyGeneration !== this.historyGeneration) {
        return historyUnavailablePage(request, importId, "resync_stale");
      }
      if (credential.status !== "fulfilled") {
        if (timedOut) return historyUnavailablePage(request, importId, "timeout");
        if (signal.aborted) return historyUnavailablePage(request, importId, "cancelled");
        return historyUnavailablePage(request, importId, "history_unavailable");
      }
      const accessToken = credential.value;
      const url = new URL(
        `/api/history/period/${encodeURIComponent(request.since)}`,
        this.context.config.baseUrl,
      );
      url.searchParams.set("end_time", request.until);
      url.searchParams.set("filter_entity_id", resolved.map((item) => item.entityId).join(","));
      url.searchParams.set("skip_initial_state", "");
      url.searchParams.set("significant_changes_only", "1");
      url.searchParams.set("minimal_response", "0");
      url.searchParams.set("no_attributes", "0");

      const fetched = await awaitHomeAssistantHistoryOperation(async () => {
        const fetchImpl = this.dependencies.fetchImpl ?? fetch;
        return fetchImpl(url, {
          method: "GET",
          signal: timeoutController.signal,
          headers: { authorization: `Bearer ${accessToken}` },
        });
      }, timeoutController.signal);
      if (historyGeneration !== this.historyGeneration) {
        return historyUnavailablePage(request, importId, "resync_stale");
      }
      if (fetched.status !== "fulfilled") {
        return historyUnavailablePage(
          request,
          importId,
          timedOut ? "timeout" : signal.aborted ? "cancelled" : "history_unavailable",
        );
      }
      const response = fetched.value;
      if (!response.ok) {
        return historyUnavailablePage(
          request,
          importId,
          response.status === 404 ? "recorder_disabled" : "history_unavailable",
        );
      }

      const read = await awaitHomeAssistantHistoryOperation(
        () => readBoundedHomeAssistantResponse(response, timeoutController.signal),
        timeoutController.signal,
      );
      if (historyGeneration !== this.historyGeneration) {
        return historyUnavailablePage(request, importId, "resync_stale");
      }
      if (read.status !== "fulfilled") {
        return historyUnavailablePage(
          request,
          importId,
          timedOut ? "timeout" : signal.aborted ? "cancelled" : "invalid_response",
        );
      }
      if (read.value === "too_large") {
        return historyPartialPage(request, importId, [], ["response_too_large"]);
      }
      const rawText = read.value;

      let body: unknown;
      try {
        body = JSON.parse(rawText) as unknown;
      } catch {
        return historyUnavailablePage(request, importId, "invalid_response");
      }
      if (!Array.isArray(body)) return historyUnavailablePage(request, importId, "invalid_response");

      const rowCount = body.reduce((count, group) => count + (Array.isArray(group) ? group.length : 1), 0);
      if (rowCount > MAX_HISTORY_RECORDS) {
        return historyPartialPage(request, importId, [], ["record_limit"]);
      }

      const reasons = new Set<HistoryCoverageReason>(["retention_floor_unknown"]);
      const projectedStates: HistoryRecord["state"][] = [];
      for (const group of body) {
        if (!Array.isArray(group)) {
          reasons.add("invalid_row");
          continue;
        }
        for (const raw of group) {
          const parsedRow = projectHomeAssistantHistoryRow(raw, resolved);
          if (parsedRow.status === "invalid") {
            reasons.add("invalid_row");
            continue;
          }
          if (parsedRow.status === "record_too_large") {
            reasons.add("record_too_large");
            continue;
          }
          if (parsedRow.timestampInvalid) reasons.add("invalid_row");
          projectedStates.push(parsedRow.state);
        }
      }
      projectedStates.sort(compareHomeAssistantHistoryStates);
      const records: HistoryRecord[] = [];
      for (const state of projectedStates) {
        const historySeq = records.length + 1;
        const record = { historySeq, state } satisfies HistoryRecord;
        if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_HISTORY_RECORD_BYTES) {
          reasons.add("record_too_large");
          continue;
        }
        records.push(record);
      }
      if (rowCount === 0) reasons.add("empty_or_purged");
      return historyPageSchema.parse({
        importId,
        source: "home-assistant-recorder",
        sourceRange: { since: request.since, until: request.until },
        liveCut: { ...request.liveCut },
        coverage: "partial",
        reasons: [...reasons],
        records,
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (this.historyAbortController === timeoutController) this.historyAbortController = undefined;
      this.historyInFlight = false;
    }
  }

  private nextHistoryImportId(): string {
    return this.dependencies.historyImportIdFactory?.() ?? `history-${randomUUID()}`;
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
        onNativeAutomationTriggeredEvent: (event) => queue.pushAutomationTriggered(event),
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
        if (item.kind === "automation-triggered") {
          this.observeAutomationTriggered(item.event);
          continue;
        }
        const binding = this.bindingsByEntityId.get(item.event.entityId);
        if (binding === undefined) continue;
        const state = projectNativeState(item.event, binding);
        if (state === undefined) continue;
        if (sameScalarRecord(this.stateAttrsByNativeInstanceId.get(state.nativeInstanceId), state.attrs)) continue;
        this.stateAttrsByNativeInstanceId.set(state.nativeInstanceId, { ...state.attrs });
        const stateEnvelope = current.envelope({ kind: "state", state });
        yield stateEnvelope;
        const principalRef = item.event.userId === undefined
          ? undefined
          : deriveHomeAssistantPrincipalRef(this.context.bridgeId, item.event.userId);
        const foreignRuleRef = item.event.contextId === undefined
          ? undefined
          : this.foreignRuleForAutomationContext(item.event.contextId);
        yield current.envelope({
          kind: "ext",
          ext: CAUSALITY_EXTENSION_KEY,
          payload: {
            refSeq: stateEnvelope.seq,
            cause: foreignRuleRef === undefined
              ? principalRef === undefined
                ? { kind: "unknown" }
                : { kind: "user", principalRef }
              : { kind: "foreign_rule", ruleRef: foreignRuleRef },
          },
        });
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
      this.foreignRuleConfigIdsByRef.clear();
      this.foreignRuleTitlesByRef.clear();
      this.foreignRuleRefsByAutomationEntityId.clear();
      this.observedAutomationContexts.clear();
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
    this.foreignRuleConfigIdsByRef = new Map(foreignRules.configIdsByRuleRef);
    this.foreignRuleTitlesByRef = new Map(foreignRules.titlesByRuleRef);
    this.foreignRuleRefsByAutomationEntityId = new Map(foreignRules.ruleRefsByAutomationEntityId);
    this.observedAutomationContexts.clear();
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
        this.foreignRuleCatalog = {
          epochId,
          lastSeq,
          complete: foreignRules.complete,
          rules: foreignRules.rules,
        };
      },
    };
  }

  private observeAutomationTriggered(event: HomeAssistantNativeAutomationTriggeredEvent): void {
    if (this.resyncInFlight) return;
    const ruleRef = this.foreignRuleRefsByAutomationEntityId.get(event.entityId);
    if (ruleRef === undefined) return;
    const nowMs = this.automationContextNowMs();
    this.pruneAutomationContexts(nowMs);
    this.observedAutomationContexts.delete(event.contextId);
    this.observedAutomationContexts.set(event.contextId, { ruleRef, observedAtMs: nowMs });
    while (this.observedAutomationContexts.size > MAX_HOME_ASSISTANT_AUTOMATION_CONTEXTS) {
      const oldest = this.observedAutomationContexts.keys().next().value;
      if (typeof oldest !== "string") break;
      this.observedAutomationContexts.delete(oldest);
    }
  }

  private foreignRuleForAutomationContext(contextId: string): string | undefined {
    this.pruneAutomationContexts(this.automationContextNowMs());
    return this.observedAutomationContexts.get(contextId)?.ruleRef;
  }

  private pruneAutomationContexts(nowMs: number): void {
    for (const [contextId, observed] of this.observedAutomationContexts) {
      if (nowMs - observed.observedAtMs >= HOME_ASSISTANT_AUTOMATION_CONTEXT_TTL_MS) {
        this.observedAutomationContexts.delete(contextId);
      }
    }
  }

  private automationContextNowMs(): number {
    const configured = this.dependencies.clock?.();
    if (configured !== undefined) {
      const parsed = Date.parse(configured);
      if (Number.isFinite(parsed)) return parsed;
    }
    return Date.now();
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
    this.historyGeneration += 1;
    this.historyAbortController?.abort(new Error("history invalidated by resync"));
    this.observedAutomationContexts.clear();
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
    this.historyAbortController?.abort();
    this.queue?.close();
    this.bridge?.close();
  }
}

function projectForeignRules(snapshot: HomeAssistantSnapshot): {
  readonly complete: boolean;
  readonly rules: ForeignRuleSummary[];
  readonly configIdsByRuleRef: ReadonlyMap<string, string>;
  readonly titlesByRuleRef: ReadonlyMap<string, string>;
  readonly ruleRefsByAutomationEntityId: ReadonlyMap<string, string>;
} {
  const states = new Map(snapshot.states.map((state) => [state.entity_id, state]));
  const rules: ForeignRuleSummary[] = [];
  const configIdsByRuleRef = new Map<string, string>();
  const titlesByRuleRef = new Map<string, string>();
  const ruleRefsByAutomationEntityId = new Map<string, string>();
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
    const nativeConfigId = entityId.slice("automation.".length);
    if (!/^[a-z0-9][a-z0-9_-]{0,255}$/u.test(nativeConfigId)) continue;
    const stateName = state && isRecord(state.attributes)
      ? nonEmptyString(state.attributes.friendly_name)
      : undefined;
    const name = nonEmptyString(raw.name) ?? nonEmptyString(raw.original_name) ?? stateName;
    const enabled = state?.state === "on" ? true : state?.state === "off" ? false : undefined;
    const updatedAt = state?.last_updated;
    const ruleRef = `ha-rule:${createHash("sha256").update(stableId).digest("hex")}`;
    configIdsByRuleRef.set(ruleRef, nativeConfigId);
    ruleRefsByAutomationEntityId.set(entityId, ruleRef);
    if (name !== undefined) titlesByRuleRef.set(ruleRef, name.slice(0, 512));
    rules.push({
      ruleRef,
      ...(name === undefined ? {} : { name: name.slice(0, 256) }),
      ...(enabled === undefined ? {} : { enabled }),
      ...(typeof updatedAt === "string" && updatedAt.length > 0 ? { updatedAt } : {}),
    });
  }
  return {
    complete,
    rules: rules.sort((left, right) => left.ruleRef.localeCompare(right.ruleRef)),
    configIdsByRuleRef,
    titlesByRuleRef,
    ruleRefsByAutomationEntityId,
  };
}

type ForeignRuleTranslationProjection =
  | { readonly status: "translated"; readonly title: string; readonly plan: ForeignRuleMigrationPlan }
  | { readonly status: "unsupported"; readonly reason: ForeignRuleMigrationUnsupportedReason }
  | { readonly status: "unavailable"; readonly reason: "upstream_unavailable" | "invalid_response" | "cancelled" };

type HomeAssistantAutomationOperationKind = "deploy" | "set_enabled" | "withdraw";
type HomeAssistantAutomationOperationResult = BridgeAutomationDeployResultV2 | BridgeAutomationCommandResultV2;

interface HomeAssistantAutomationOperationEntry {
  readonly kind: HomeAssistantAutomationOperationKind;
  readonly requestKey: string;
  result: Promise<HomeAssistantAutomationOperationResult>;
  lastResult?: HomeAssistantAutomationOperationResult;
  settled: boolean;
}

type ForeignRuleControlConfigRead =
  | { readonly status: "ok"; readonly sourceFingerprint: string }
  | { readonly status: "missing" }
  | { readonly status: "unavailable" }
  | { readonly status: "invalid" };

interface ForeignRuleControlOperationEntry {
  readonly requestKey: string;
  readonly result: Promise<ForeignRuleControlSetEnabledResult>;
  settled: boolean;
}

const HOME_ASSISTANT_WEEKDAY_TO_NUMBER: Readonly<Record<string, number>> = Object.freeze({
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
});

async function translateHomeAssistantRuleConfig(
  value: unknown,
  bindingForEntity: (entityId: string) => ForeignRuleMigrationBinding | undefined,
  fallbackTitle: string | undefined,
  resolveTimezone: (signal: AbortSignal) => Promise<string | undefined>,
  signal: AbortSignal,
): Promise<ForeignRuleTranslationProjection> {
  if (signal.aborted) return { status: "unavailable", reason: "cancelled" };
  const config = recordValue(value);
  if (config === undefined) return { status: "unavailable", reason: "invalid_response" };
  if (!Object.keys(config).every((key) => ["id", "alias", "description", "mode", "trigger", "condition", "action"].includes(key))) {
    return { status: "unsupported", reason: "unsupported_structure" };
  }
  if (config.mode !== undefined && config.mode !== "single") {
    return { status: "unsupported", reason: "mode_not_single" };
  }

  const title = boundedHouseholdTitle(config.alias, fallbackTitle);
  const triggerResult = await translateForeignTrigger(config.trigger, bindingForEntity, resolveTimezone, signal);
  if (triggerResult.status !== "ok") return triggerResult;

  const conditionsResult = translateForeignConditions(
    config.condition,
    bindingForEntity,
    triggerResult.value.kind === "schedule",
  );
  if (conditionsResult.status !== "ok") return conditionsResult;

  const planTrigger = triggerResult.value.kind === "schedule" && conditionsResult.daysOfWeek !== undefined
    ? { ...triggerResult.value, daysOfWeek: conditionsResult.daysOfWeek }
    : triggerResult.value;

  const actionsResult = translateForeignActions(config.action, bindingForEntity);
  if (actionsResult.status !== "ok") return actionsResult;

  return {
    status: "translated",
    title,
    plan: {
      trigger: planTrigger,
      conditions: conditionsResult.value,
      actions: actionsResult.value,
    },
  };
}

async function translateForeignTrigger(
  value: unknown,
  bindingForEntity: (entityId: string) => ForeignRuleMigrationBinding | undefined,
  resolveTimezone: (signal: AbortSignal) => Promise<string | undefined>,
  signal: AbortSignal,
): Promise<
  | { readonly status: "ok"; readonly value: ForeignRuleMigrationTrigger }
  | Extract<ForeignRuleTranslationProjection, { status: "unsupported" | "unavailable" }>
> {
  if (!Array.isArray(value)) return { status: "unsupported", reason: "unsupported_trigger" };
  if (value.length !== 1) return { status: "unsupported", reason: value.length > 1 ? "multiple_triggers" : "unsupported_trigger" };
  const trigger = recordValue(value[0]);
  if (trigger === undefined || typeof trigger.platform !== "string") {
    return { status: "unsupported", reason: "unsupported_trigger" };
  }
  if (trigger.platform === "time") {
    if (!exactKeys(trigger, ["platform", "at"]) || typeof trigger.at !== "string") {
      return { status: "unsupported", reason: "unsupported_trigger" };
    }
    const at = normalizeHomeAssistantTime(trigger.at);
    if (at === undefined) return { status: "unsupported", reason: "unsupported_trigger" };
    const timezone = await resolveTimezone(signal);
    if (signal.aborted) return { status: "unavailable", reason: "cancelled" };
    if (timezone === undefined) return { status: "unavailable", reason: "upstream_unavailable" };
    return {
      status: "ok",
      value: {
        kind: "schedule",
        timezone,
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        at,
      },
    };
  }
  if (trigger.platform !== "state" || !exactKeys(trigger, ["platform", "entity_id"])) {
    return { status: "unsupported", reason: "unsupported_trigger" };
  }
  const entityId = singleEntityId(trigger.entity_id);
  if (entityId === undefined) return { status: "unsupported", reason: "unsupported_trigger" };
  const binding = bindingForEntity(entityId);
  if (binding === undefined) return { status: "unsupported", reason: "unbound_target" };
  return { status: "ok", value: { kind: "capability_changed", source: binding } };
}

function translateForeignConditions(
  value: unknown,
  bindingForEntity: (entityId: string) => ForeignRuleMigrationBinding | undefined,
  scheduleTrigger: boolean,
):
  | { readonly status: "ok"; readonly value: ForeignRuleMigrationPlan["conditions"]; readonly daysOfWeek?: number[] }
  | Extract<ForeignRuleTranslationProjection, { status: "unsupported" }> {
  if (value === undefined) return { status: "ok", value: [] };
  const maxRawConditions = scheduleTrigger ? 9 : 8;
  if (!Array.isArray(value) || value.length > maxRawConditions) return { status: "unsupported", reason: "unsupported_condition" };
  const conditions: ForeignRuleMigrationCondition[] = [];
  let daysOfWeek: number[] | undefined;
  for (const raw of value) {
    const condition = recordValue(raw);
    if (condition === undefined || typeof condition.condition !== "string") {
      return { status: "unsupported", reason: "unsupported_condition" };
    }
    if (condition.condition === "state") {
      if (!exactKeys(condition, ["condition", "entity_id", "state"]) || typeof condition.state !== "string") {
        return { status: "unsupported", reason: "unsupported_condition" };
      }
      const entityId = singleEntityId(condition.entity_id);
      const binding = entityId === undefined ? undefined : bindingForEntity(entityId);
      if (binding === undefined) return { status: "unsupported", reason: "unbound_target" };
      const value = entityId === undefined
        ? condition.state
        : booleanActuatorStateValue(entityId, condition.state) ?? condition.state;
      conditions.push({ kind: "capability_value", source: binding, operator: "equals", value });
      continue;
    }
    if (condition.condition === "time") {
      if (!scheduleTrigger || daysOfWeek !== undefined || !exactKeys(condition, ["condition", "weekday"])) {
        return { status: "unsupported", reason: "unsupported_condition" };
      }
      const weekdays = Array.isArray(condition.weekday)
        ? condition.weekday
        : typeof condition.weekday === "string" ? [condition.weekday] : undefined;
      const dayNumbers = weekdays === undefined
        ? undefined
        : weekdays.map((weekday) => typeof weekday === "string" ? HOME_ASSISTANT_WEEKDAY_TO_NUMBER[weekday] : undefined);
      if (dayNumbers === undefined
        || dayNumbers.length < 1
        || dayNumbers.length > 7
        || dayNumbers.some((day) => day === undefined)
        || new Set(dayNumbers).size !== dayNumbers.length) {
        return { status: "unsupported", reason: "unsupported_condition" };
      }
      daysOfWeek = [...dayNumbers as number[]].sort((left, right) => left - right);
      continue;
    }
    if (condition.condition === "numeric_state") {
      if (!exactKeys(condition, ["condition", "entity_id", "above", "below"]) &&
        !exactKeys(condition, ["condition", "entity_id", "above"]) &&
        !exactKeys(condition, ["condition", "entity_id", "below"])) {
        return { status: "unsupported", reason: "unsupported_condition" };
      }
      const entityId = singleEntityId(condition.entity_id);
      const binding = entityId === undefined ? undefined : bindingForEntity(entityId);
      if (binding === undefined) return { status: "unsupported", reason: "unbound_target" };
      if (typeof condition.above === "number" && Number.isFinite(condition.above) && condition.below === undefined) {
        conditions.push({ kind: "capability_value", source: binding, operator: "greater_than", value: condition.above });
        continue;
      }
      if (typeof condition.below === "number" && Number.isFinite(condition.below) && condition.above === undefined) {
        conditions.push({ kind: "capability_value", source: binding, operator: "less_than", value: condition.below });
        continue;
      }
    }
    return { status: "unsupported", reason: "unsupported_condition" };
  }
  if (conditions.length > 8) return { status: "unsupported", reason: "unsupported_condition" };
  return { status: "ok", value: conditions, ...(daysOfWeek === undefined ? {} : { daysOfWeek }) };
}

function translateForeignActions(
  value: unknown,
  bindingForEntity: (entityId: string) => ForeignRuleMigrationBinding | undefined,
):
  | { readonly status: "ok"; readonly value: ForeignRuleMigrationPlan["actions"] }
  | Extract<ForeignRuleTranslationProjection, { status: "unsupported" }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return { status: "unsupported", reason: "unsupported_action" };
  const actions: ForeignRuleMigrationAction[] = [];
  for (const raw of value) {
    const action = recordValue(raw);
    if (action === undefined || typeof action.service !== "string") return { status: "unsupported", reason: "unsupported_action" };
    if (action.service === "persistent_notification.create") {
      if (!exactKeys(action, ["service", "data"]) || !isRecord(action.data)) {
        return { status: "unsupported", reason: "unsupported_action" };
      }
      if (!exactKeys(action.data, ["message", "title"]) && !exactKeys(action.data, ["message"])) {
        return { status: "unsupported", reason: "unsupported_action" };
      }
      if (typeof action.data.message !== "string" || boundedHouseholdMessage(action.data.message) === undefined) {
        return { status: "unsupported", reason: "unsupported_action" };
      }
      actions.push({ kind: "notify_local", message: boundedHouseholdMessage(action.data.message)! });
      continue;
    }

    const targetEntityId = migrationActionEntityId(action.target);
    const target = migrationActionTarget(action.target, bindingForEntity);
    if (target.status !== "ok") return target;
    if (targetEntityId !== undefined && isBooleanActuatorService(action.service, targetEntityId)) {
      const emptyData = exactKeys(action, ["service", "target"])
        || (exactKeys(action, ["service", "target", "data"])
          && isRecord(action.data)
          && Object.keys(action.data).length === 0);
      if (emptyData) {
        actions.push({ kind: "set_boolean", target: target.value, value: action.service.endsWith("turn_on") });
        continue;
      }
    }

    const data = action.data;
    if (!exactKeys(action, ["service", "target", "data"]) || !isRecord(data)) {
      return { status: "unsupported", reason: "unsupported_action" };
    }
    const level = homeAssistantLevel(action.service, data);
    if (level === undefined) return { status: "unsupported", reason: "unsupported_action" };
    actions.push({ kind: "set_level", target: target.value, level });
  }
  return { status: "ok", value: actions };
}

function migrationActionTarget(
  value: unknown,
  bindingForEntity: (entityId: string) => ForeignRuleMigrationBinding | undefined,
):
  | { readonly status: "ok"; readonly value: ForeignRuleMigrationBinding }
  | Extract<ForeignRuleTranslationProjection, { status: "unsupported" }> {
  if (!isRecord(value) || !exactKeys(value, ["entity_id"])) return { status: "unsupported", reason: "unsupported_action" };
  if (Array.isArray(value.entity_id) && value.entity_id.length !== 1) return { status: "unsupported", reason: "multiple_targets" };
  const entityId = singleEntityId(value.entity_id);
  if (entityId === undefined) return { status: "unsupported", reason: "unsupported_action" };
  const binding = bindingForEntity(entityId);
  return binding === undefined
    ? { status: "unsupported", reason: "unbound_target" }
    : { status: "ok", value: binding };
}

function migrationActionEntityId(value: unknown): string | undefined {
  if (!isRecord(value) || !exactKeys(value, ["entity_id"])) return undefined;
  return singleEntityId(value.entity_id);
}

function isBooleanActuatorService(service: string, entityId: string): boolean {
  if (!isHomeAssistantBooleanActuatorEntity(entityId)) return false;
  const domain = entityId.slice(0, entityId.indexOf("."));
  return service === "homeassistant.turn_on"
    || service === "homeassistant.turn_off"
    || service === `${domain}.turn_on`
    || service === `${domain}.turn_off`;
}

function booleanActuatorStateValue(entityId: string, state: string): boolean | undefined {
  if (!isHomeAssistantBooleanActuatorEntity(entityId)) return undefined;
  return state === "on" ? true : state === "off" ? false : undefined;
}

function homeAssistantLevel(service: string, data: Record<string, unknown>): number | undefined {
  const field = service === "light.turn_on"
    ? "brightness_pct"
    : service === "cover.set_cover_position"
      ? "position"
      : service === "fan.set_percentage"
        ? "percentage"
        : service === "media_player.volume_set"
          ? "volume_level"
          : undefined;
  if (field === undefined || !exactKeys(data, [field]) || typeof data[field] !== "number" || !Number.isFinite(data[field])) return undefined;
  if (field === "volume_level") return data[field] >= 0 && data[field] <= 1 ? data[field] : undefined;
  return data[field] >= 0 && data[field] <= 100 ? data[field] / 100 : undefined;
}

function normalizeHomeAssistantTime(value: string): string | undefined {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  if (hour > 23 || minute > 59 || second !== 0) return undefined;
  return `${match[1]}:${match[2]}`;
}

function boundedHouseholdTitle(value: unknown, fallback: string | undefined): string {
  return boundedHouseholdMessage(value) ?? boundedHouseholdMessage(fallback) ?? "Home Assistant 自动化";
}

function boundedHouseholdMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0
    && text.length <= 512
    && Buffer.byteLength(text, "utf8") <= 2_048
    && !/[\u0000-\u001f\u007f]/u.test(text)
    ? text
    : undefined;
}

function singleEntityId(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return value[0].trim() || undefined;
  return undefined;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(record).every((key) => expected.has(key)) && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function canonicalNativeJson(value: unknown): string | undefined {
  const normalized = canonicalNativeValue(value, 0, new Set<object>());
  if (normalized === undefined) return undefined;
  try {
    return JSON.stringify(normalized);
  } catch {
    return undefined;
  }
}

function canonicalNativeValue(value: unknown, depth: number, seen: Set<object>): unknown {
  if (depth > 32) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const output = value.map((item) => canonicalNativeValue(item, depth + 1, seen));
    seen.delete(value);
    return output.some((item) => item === undefined) ? undefined : output;
  }
  if (isRecord(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = canonicalNativeValue(value[key], depth + 1, seen);
      if (item === undefined) return undefined;
      output[key] = item;
    }
    seen.delete(value);
    return output;
  }
  return undefined;
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
      const booleanActuator = isHomeAssistantBooleanActuatorEntity(binding.entityId);
      const cover = isHomeAssistantCoverEntity(binding.entityId);
      const mediaPlayer = isHomeAssistantMediaPlayerEntity(binding.entityId);
      return {
        nativeInstanceId: binding.nativeInstanceId,
        schema: booleanActuator
          ? HOME_ASSISTANT_BOOLEAN_ACTUATOR_SCHEMA
          : cover ? HOME_ASSISTANT_COVER_SCHEMA
          : mediaPlayer ? HOME_ASSISTANT_MEDIA_PLAYER_SCHEMA : HOME_ASSISTANT_ENTITY_SCHEMA,
        schemaVersion: booleanActuator
          ? HOME_ASSISTANT_BOOLEAN_ACTUATOR_SCHEMA_VERSION
          : cover ? HOME_ASSISTANT_COVER_SCHEMA_VERSION
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

function isHomeAssistantBooleanActuatorEntity(entityId: string): boolean {
  const separator = entityId.indexOf(".");
  if (separator <= 0) return false;
  return ["light", "switch", "fan", "input_boolean"].includes(entityId.slice(0, separator));
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

interface ResolvedHistoryBinding {
  readonly entityId: string;
  readonly binding: EntityBinding;
}

function resolveHistoryBindings(
  bindingsByEntityId: ReadonlyMap<string, EntityBinding>,
  requested: readonly { readonly nativeId: string; readonly nativeInstanceId: string }[],
): ResolvedHistoryBinding[] | undefined {
  const resolved: ResolvedHistoryBinding[] = [];
  for (const request of requested) {
    const binding = [...bindingsByEntityId.values()].find((candidate) => (
      candidate.nativeId === request.nativeId
      && candidate.nativeInstanceId === request.nativeInstanceId
    ));
    if (binding === undefined) return undefined;
    resolved.push({ entityId: binding.entityId, binding });
  }
  return resolved;
}

type ProjectedHistoryRow =
  | { readonly status: "ok"; readonly state: HistoryRecord["state"]; readonly timestampInvalid: boolean }
  | { readonly status: "invalid" }
  | { readonly status: "record_too_large" };

function projectHomeAssistantHistoryRow(
  raw: unknown,
  resolved: readonly ResolvedHistoryBinding[],
): ProjectedHistoryRow {
  if (!isRecord(raw)) return { status: "invalid" };
  const entityId = typeof raw.entity_id === "string" ? raw.entity_id : undefined;
  const resolvedBinding = entityId === undefined
    ? undefined
    : resolved.find((candidate) => candidate.entityId === entityId);
  if (resolvedBinding === undefined || typeof raw.state !== "string" || !isRecord(raw.attributes)) {
    return { status: "invalid" };
  }

  const hasLastUpdated = Object.prototype.hasOwnProperty.call(raw, "last_updated");
  const rawTimestamp = hasLastUpdated ? raw.last_updated : raw.last_changed;
  const timestampValid = isValidHomeAssistantHistoryTimestamp(rawTimestamp);
  const state = projectNativeState({
    entityId: resolvedBinding.entityId,
    state: raw.state,
    attrs: raw.attributes,
    ts: timestampValid ? rawTimestamp as string : "",
  }, resolvedBinding.binding, "imported");
  if (state === undefined) return { status: "invalid" };
  const candidateRecord = { historySeq: 1, state };
  if (Buffer.byteLength(JSON.stringify(candidateRecord), "utf8") > MAX_HISTORY_RECORD_BYTES) {
    return { status: "record_too_large" };
  }
  const parsedRecord = HistoryRecordSchema.safeParse(candidateRecord);
  if (!parsedRecord.success) return { status: "invalid" };
  return { status: "ok", state: parsedRecord.data.state, timestampInvalid: !timestampValid };
}

function compareHomeAssistantHistoryStates(
  left: HistoryRecord["state"],
  right: HistoryRecord["state"],
): number {
  const leftTimestamp = "sourceTs" in left.time ? left.time.sourceTs : undefined;
  const rightTimestamp = "sourceTs" in right.time ? right.time.sourceTs : undefined;
  if (leftTimestamp === undefined || rightTimestamp === undefined) {
    if (leftTimestamp !== rightTimestamp) return leftTimestamp === undefined ? 1 : -1;
  } else {
    const timeDifference = Date.parse(leftTimestamp) - Date.parse(rightTimestamp);
    if (timeDifference !== 0) return timeDifference;
  }
  return left.nativeId.localeCompare(right.nativeId)
    || left.nativeInstanceId.localeCompare(right.nativeInstanceId)
    || (canonicalNativeJson(left.attrs) ?? "").localeCompare(canonicalNativeJson(right.attrs) ?? "");
}

function isValidHomeAssistantHistoryTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || value === "") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (match === null) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const date = new Date(parsed);
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3])
    && date.getUTCHours() === Number(match[4])
    && date.getUTCMinutes() === Number(match[5])
    && date.getUTCSeconds() === Number(match[6]);
}

function historyUnavailablePage(
  request: HistoryRequest,
  importId: string,
  reason: HistoryCoverageReason,
): HistoryPage {
  return historyPageSchema.parse({
    importId,
    source: "home-assistant-recorder",
    sourceRange: { since: request.since, until: request.until },
    liveCut: { ...request.liveCut },
    coverage: "unavailable",
    reasons: [reason],
    records: [],
  });
}

function historyPartialPage(
  request: HistoryRequest,
  importId: string,
  records: readonly HistoryRecord[],
  reasons: readonly HistoryCoverageReason[],
): HistoryPage {
  return historyPageSchema.parse({
    importId,
    source: "home-assistant-recorder",
    sourceRange: { since: request.since, until: request.until },
    liveCut: { ...request.liveCut },
    coverage: "partial",
    reasons: [...new Set(reasons)],
    records,
  });
}

type HomeAssistantHistoryOperation<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected" | "aborted" };

function awaitHomeAssistantHistoryOperation<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
): Promise<HomeAssistantHistoryOperation<T>> {
  if (signal.aborted) return Promise.resolve({ status: "aborted" });
  return new Promise<HomeAssistantHistoryOperation<T>>((resolve) => {
    let settled = false;
    const finish = (result: HomeAssistantHistoryOperation<T>): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish({ status: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      Promise.resolve(operation()).then(
        (value) => finish({ status: "fulfilled", value }),
        () => finish({ status: "rejected" }),
      );
    } catch {
      finish({ status: "rejected" });
    }
  });
}

async function readBoundedHomeAssistantResponse(
  response: Response,
  signal: AbortSignal,
): Promise<string | "too_large"> {
  if (response.body === null) {
    throw new Error("Home Assistant history response has no bounded body stream");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("history response cancelled");
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_HOME_ASSISTANT_MESSAGE_BYTES) {
        await reader.cancel();
        return "too_large";
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function projectNativeState(
  nativeState: HomeAssistantNativeStateEvent,
  binding: EntityBinding,
  origin: "observed" | "imported" = "observed",
): ContractStateEvent | undefined {
  if (nativeState.entityId !== binding.entityId || nativeState.state.trim() === "") return undefined;
  const attrs = isHomeAssistantBooleanActuatorEntity(binding.entityId)
    ? projectBooleanActuatorAttributes(nativeState.state, nativeState.attrs)
    : isHomeAssistantCoverEntity(binding.entityId)
      ? projectCoverAttributes(nativeState.state, nativeState.attrs)
    : isHomeAssistantMediaPlayerEntity(binding.entityId)
      ? projectMediaPlayerAttributes(nativeState.state, nativeState.attrs)
      : projectKnownAttributes(nativeState.state, nativeState.attrs);
  if (attrs === undefined) return undefined;
  return {
    nativeId: binding.nativeId,
    nativeInstanceId: binding.nativeInstanceId,
    attrs,
    time: nativeState.ts.trim() === ""
      ? { sourceTsQuality: "none" }
      : { sourceTs: nativeState.ts, sourceTsQuality: "platform" },
    origin,
  };
}

function projectBooleanActuatorAttributes(
  state: string,
  attributes: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const projected: Record<string, string | number | boolean | null> = { state };
  if (state === "on") projected.value = true;
  if (state === "off") projected.value = false;
  if (typeof attributes.available === "boolean") projected.available = attributes.available;

  const unknownAttributeCount = Object.keys(attributes)
    .filter((key) => key !== "available")
    .length;
  if (unknownAttributeCount > 0) projected.unknownAttributeCount = unknownAttributeCount;
  return projected;
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
  const value = typeof current.value === "boolean" ? current.value : undefined;
  if (domain === undefined || state === undefined || current.available === false
    || state === "unknown" || state === "unavailable") return undefined;

  if (["light", "switch", "fan", "input_boolean"].includes(domain)) {
    if (value === undefined) return undefined;
    return { action: { kind: "set_boolean", value: !value }, reversible: true };
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
  | { kind: "automation-triggered"; event: HomeAssistantNativeAutomationTriggeredEvent }
  | { kind: "resync"; snapshot: HomeAssistantSnapshot }
  | { kind: "heartbeat" };

/** Behavioral identity of a stored automation, ignoring bookkeeping keys. */
function automationConfigFingerprint(stored: Record<string, unknown>): string {
  const material = stableJson({
    trigger: stored.trigger,
    condition: stored.condition,
    action: stored.action,
    mode: stored.mode,
  });
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

/** The source fingerprint is the same canonical whole-config identity returned by migration translation. */
function sourceAutomationFingerprint(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const canonical = canonicalNativeJson(value);
  if (canonical === undefined || Buffer.byteLength(canonical, "utf8") > MAX_HOME_ASSISTANT_FOREIGN_RULE_CONFIG_BYTES) return undefined;
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function foreignRuleControlRequestKey(request: {
  readonly ruleRef: string;
  readonly expectedSourceFingerprint: string;
  readonly enabled: boolean;
}): string {
  return JSON.stringify([request.ruleRef, request.expectedSourceFingerprint, request.enabled]);
}

const INVALID_AUTOMATION_OPERATION_ID = "00000000000000000000000000000000";

function automationOperationId(value: unknown): string {
  const parsed = bridgeAutomationOperationIdSchema.safeParse(isRecord(value) ? value.operationId : undefined);
  return parsed.success ? parsed.data : INVALID_AUTOMATION_OPERATION_ID;
}

function automationOperationRequestKey(
  kind: HomeAssistantAutomationOperationKind,
  request: unknown,
): string {
  return `${kind}\u0000${stableJson(request)}`;
}

/** Deep equality on the behavioral fields; storage may add bookkeeping keys. */
function storedAutomationMatches(sent: Record<string, unknown>, stored: Record<string, unknown>): boolean {
  return typeof sent.alias === "string"
    && hasHomeAssistantAutomationOwnershipMarker(sent.alias, stored)
    && automationConfigFingerprint(sent) === automationConfigFingerprint(stored);
}

/** The adapter owns only configs carrying both deterministic identity markers. */
function hasHomeAssistantAutomationOwnershipMarker(
  automationId: string,
  stored: Record<string, unknown>,
): boolean {
  return stored.alias === automationId
    && typeof stored.description === "string"
    && stored.description.startsWith("hob:");
}

/** A status read needs enough native structure to produce a trustworthy fingerprint. */
function isStoredAutomationConfig(stored: Record<string, unknown>, automationId: string): boolean {
  return hasHomeAssistantAutomationOwnershipMarker(automationId, stored)
    && Array.isArray(stored.trigger)
    && Array.isArray(stored.condition)
    && Array.isArray(stored.action)
    && typeof stored.mode === "string";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

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

  pushAutomationTriggered(event: HomeAssistantNativeAutomationTriggeredEvent): void {
    this.pushValue({ kind: "automation-triggered", event });
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

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) && !Array.isArray(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function boundedRegistryText(value: unknown, maxLength: number): string | undefined {
  const text = nonEmptyString(value);
  return text === undefined || text.length > maxLength ? undefined : text;
}

function boundedHomeAssistantUserId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" || text !== value
    || text.length > 256
    || /[\u0000-\u001f\u007f\s]/u.test(text)
    ? undefined
    : text;
}

function boundedHomeAssistantContextId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === ""
    || text !== value
    || Array.from(text).length > MAX_HOME_ASSISTANT_CONTEXT_ID_LENGTH
    || /[\u0000-\u001f\u007f\s]/u.test(text)
    ? undefined
    : text;
}

function boundedHomeAssistantEntityId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === ""
    || text !== value
    || Array.from(text).length > MAX_HOME_ASSISTANT_ENTITY_ID_LENGTH
    || /[\u0000-\u001f\u007f\s]/u.test(text)
    ? undefined
    : text;
}

function resolveHomeAssistantStateContextId(
  eventContext: unknown,
  stateContext: unknown,
): string | undefined {
  const eventRecord = isRecord(eventContext);
  const stateRecord = isRecord(stateContext);
  const eventId = eventRecord ? boundedHomeAssistantContextId(eventContext.id) : undefined;
  const stateId = stateRecord ? boundedHomeAssistantContextId(stateContext.id) : undefined;
  if (eventRecord && stateRecord) return eventId !== undefined && eventId === stateId ? eventId : undefined;
  return eventId ?? stateId;
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
