import { JournalCapacityError, type IngestJournal } from "./ingest-journal.js";
import { WorldState, type WorldDeviceView } from "./world-state.js";
import type { ZodType } from "zod";
import {
  bridgeEventSchema,
  type HubBridgeDiagnostics as ContractHubBridgeDiagnostics,
  type IngestRecord,
  type SchemaRegistration,
} from "@hob/bridge-contract";
import type {
  BridgeAdapter,
  BridgeControl,
  BridgeEvent,
  CoreReasonCode,
  DeviceDescriptor,
  Envelope,
  HistoryGapRecord,
  JournalWatermark,
  ResourceBudget,
  StateEvent,
} from "./bridge-ingest-types.js";

export type {
  AdapterCapabilityRef,
  BridgeAdapter,
  BridgeControl,
  BridgeEvent,
  BridgeInfo,
  ControlResult,
  CoreReasonCode,
  DeviceDescriptor,
  Envelope,
  ExtensionDeclaration,
  ExtensionHandleRegistry,
  JsonValue,
  ResourceBudget,
  SnapshotManifest,
  StateEvent,
} from "./bridge-ingest-types.js";

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: Extract<CoreReasonCode, "invalid_payload" | "unsupported" | "protocol_error">; nativeId?: string };

export interface BridgeIngestOptions {
  bridgeId: string;
  journal: IngestJournal;
  world?: WorldState;
  registeredSchemas?: ReadonlySet<string>;
  /** Negotiated canonical extension handles; an empty set fails closed. */
  enabledExtensions?: ReadonlySet<string>;
  /** Payload schemas registered for the negotiated extension handles. */
  extensionSchemas?: ReadonlyMap<string, ZodType<unknown>>;
  validateEvent?: (event: BridgeEvent) => ValidationResult | Promise<ValidationResult>;
  control?: BridgeControl;
  /** Persisted registry identity; a different sync-start must be rebound. */
  remoteInstanceId?: string;
  /** Registry-owned identity check, called before an epoch is created or journaled. */
  validateRemoteInstanceId?: (remoteInstanceId: string, epochId: string) => boolean | Promise<boolean>;
  /** Alias for registry integrations that name this seam explicitly. */
  remoteIdentityValidator?: (remoteInstanceId: string, epochId: string) => boolean | Promise<boolean>;
  clock?: () => string | number | Date;
  nowMs?: () => number;
  heartbeatIntervalMs?: number;
  syncTimeoutMs?: number;
  diagnosticSampleLimit?: number;
  /** Hub-side structural limits applied before deep canonical Zod parsing. */
  resourceBudget?: Partial<ResourceBudget>;
  /** Catalog registrations used to validate state attrs after descriptor binding. */
  schemaRegistrations?: ReadonlyMap<string, SchemaRegistration>;
  /** Queue state events until an explicit flush when this window is positive. */
  stateFoldWindowMs?: number;
  /** Alias for integrations that call the state coalescing window a fold window. */
  foldWindowMs?: number;
}

export interface IngestResult {
  accepted: boolean;
  epochId: string;
  seq: number;
  duplicate?: boolean;
  broken?: boolean;
  /** A security boundary failure that requires an explicit rebind before retry. */
  fatal?: boolean;
  reason?: CoreReasonCode | "sequence_gap" | "manifest_mismatch" | "replay_device_removed" | "remote_identity_mismatch";
}

export type HubBridgeDiagnostics = ContractHubBridgeDiagnostics;

type ReplayCounts = { device: number; state: number };
export type DeviceHealthStatus = "reachable" | "unreachable" | "unknown";
export type BridgeHealthStatus = "up" | "degraded";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_SYNC_TIMEOUT_MS = 120_000;
const DEFAULT_DIAGNOSTIC_SAMPLE_LIMIT = 32;
const DEFAULT_RESOURCE_BUDGET: ResourceBudget = {
  maxFields: 4_096,
  maxStringLength: 4_096,
  maxDepth: 32,
  maxSerializedBytes: 64 * 1024,
};

/**
 * Neutral homeWorld ingest state machine. The class intentionally accepts a
 * narrow journal and control seam, so adapters cannot bypass sequencing,
 * schema admission, or the policy-owned execution boundary.
 */
export class BridgeIngest {
  readonly world: () => WorldState;
  private readonly state: WorldState;
  private readonly bridgeId: string;
  private readonly journal: IngestJournal;
  private readonly registeredSchemas: ReadonlySet<string>;
  private readonly schemaRegistrations: ReadonlyMap<string, SchemaRegistration>;
  private enabledExtensions?: ReadonlySet<string>;
  private readonly extensionSchemas: ReadonlyMap<string, ZodType<unknown>>;
  private readonly validateEvent?: BridgeIngestOptions["validateEvent"];
  private control?: BridgeControl;
  private readonly remoteInstanceId?: string;
  private readonly validateRemoteInstanceId?: BridgeIngestOptions["validateRemoteInstanceId"];
  private readonly clock: () => string;
  private readonly nowMs: () => number;
  private readonly heartbeatIntervalMs: number;
  private readonly syncTimeoutMs: number;
  private readonly diagnosticSampleLimit: number;
  private readonly resourceBudget: ResourceBudget;
  private readonly stateFoldWindowMs: number;
  private readonly pendingStates = new Map<string, StateEvent>();
  private readonly stateKeysSeen = new Set<string>();
  private capabilitySchemas = new Map<string, string>();
  private replayCapabilitySchemas = new Map<string, string>();
  private deviceHealthByNativeId = new Map<string, DeviceHealthStatus>();
  private replayDeviceHealthByNativeId = new Map<string, DeviceHealthStatus>();
  private bridgeHealthStatus: BridgeHealthStatus = "up";
  private replayBridgeHealthStatus: BridgeHealthStatus = "up";
  private activeEpochId: string | undefined;
  private highWater = 0;
  private replayCounts: ReplayCounts = { device: 0, state: 0 };
  private epochBroken = false;
  private awaitingFreshEpoch = false;
  private syncStartedAt: number | undefined;
  private lastContactMs: number | undefined;
  private readonly diagnosticState: HubBridgeDiagnostics = {
    connectionState: "starting",
    droppedInvalidCount: 0,
    strippedFieldsCount: 0,
    staleEpochDropCount: 0,
    foldedStateCount: 0,
    unsupportedSchemaCount: 0,
    protocolViolationCount: 0,
    historyGapCount: 0,
    recentHistoryGaps: [],
  };
  private readonly sampleState: Array<{ epochId: string; seq: number; kind: string }> = [];

  constructor(options: BridgeIngestOptions) {
    if (!options.bridgeId) throw new Error("bridgeId is required");
    this.bridgeId = options.bridgeId;
    this.journal = options.journal;
    this.state = options.world ?? new WorldState();
    this.world = () => this.state;
    this.registeredSchemas = options.registeredSchemas ?? new Set();
    this.schemaRegistrations = options.schemaRegistrations ?? new Map();
    this.enabledExtensions = options.enabledExtensions;
    this.extensionSchemas = options.extensionSchemas ?? new Map();
    this.validateEvent = options.validateEvent;
    this.control = options.control;
    this.remoteInstanceId = options.remoteInstanceId;
    this.validateRemoteInstanceId = options.validateRemoteInstanceId ?? options.remoteIdentityValidator;
    this.clock = () => normalizeTime(options.clock?.() ?? new Date());
    this.nowMs = options.nowMs ?? (() => {
      const value = options.clock?.();
      if (value instanceof Date) return value.getTime();
      if (typeof value === "number") return value;
      if (typeof value === "string") {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return Date.now();
    });
    this.heartbeatIntervalMs = clamp(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS, 1, 24 * 60 * 60 * 1_000);
    this.syncTimeoutMs = Math.max(1, options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS);
    this.diagnosticSampleLimit = Math.min(32, Math.max(1, options.diagnosticSampleLimit ?? DEFAULT_DIAGNOSTIC_SAMPLE_LIMIT));
    this.resourceBudget = normalizeResourceBudget(options.resourceBudget);
    this.stateFoldWindowMs = Math.max(0, options.stateFoldWindowMs ?? options.foldWindowMs ?? 0);
  }

  async ingest(envelope: Envelope): Promise<IngestResult> {
    const header = validateHeader(envelope);
    if (!header.ok) {
      this.diagnosticState.protocolViolationCount += 1;
      this.diagnosticState.droppedInvalidCount += 1;
      return { accepted: false, epochId: envelope?.epochId ?? "", seq: envelope?.seq ?? 0, reason: "protocol_error" };
    }

    const { epochId, seq, event } = envelope;
    // Header validation is intentionally shallow. The bounded structural
    // walk must run before any canonical Zod parse or custom schema seam.
    const resourceExhausted = !withinResourceBudget(envelope, this.resourceBudget);
    const now = this.nowMs();
    this.diagnosticState.lastEventReceivedAt = this.clock();
    this.lastContactMs = now;
    this.diagnosticState.lastSuccessfulContactAt = this.diagnosticState.lastEventReceivedAt;

    if (this.activeEpochId === undefined) {
      if (event.kind !== "sync-start" || seq !== 1) return this.rejectProtocol(envelope);
      if (resourceExhausted) return this.rejectResource(envelope);
      if (!(await this.validateEpochIdentity(envelope))) return this.rejectRemoteIdentity(envelope);
      this.startEpoch(envelope);
      return this.commitLegal(envelope);
    }

    if (this.diagnosticState.connectionState === "paused" || this.diagnosticState.connectionState === "quarantined") {
      return { accepted: false, epochId, seq, reason: "resource_exhausted" };
    }

    if (this.awaitingFreshEpoch) {
      if (event.kind !== "sync-start" || epochId === this.activeEpochId || seq !== 1) {
        return epochId === this.activeEpochId ? this.rejectProtocol(envelope) : this.rejectStaleEpoch(envelope);
      }
      if (resourceExhausted) return this.rejectResource(envelope);
      if (!(await this.validateEpochIdentity(envelope))) return this.rejectRemoteIdentity(envelope);
      this.startEpoch(envelope);
      return this.commitLegal(envelope);
    }

    if (event.kind === "sync-start" && epochId !== this.activeEpochId) {
      if (seq !== 1) return this.rejectProtocol(envelope);
      if (resourceExhausted) return this.rejectResource(envelope);
      if (!(await this.validateEpochIdentity(envelope))) return this.rejectRemoteIdentity(envelope);
      this.startEpoch(envelope);
      return this.commitLegal(envelope);
    }
    if (epochId !== this.activeEpochId) {
      this.diagnosticState.staleEpochDropCount += 1;
      return { accepted: false, epochId, seq, reason: "protocol_error" };
    }
    if (this.isBrokenEpoch()) {
      this.addDiagnosticSample(envelope);
      return { accepted: false, epochId, seq, broken: true, reason: "sequence_gap" };
    }
    if (event.kind === "sync-start") return this.rejectProtocol(envelope);
    if (seq <= this.highWater) {
      return { accepted: false, epochId, seq, duplicate: true };
    }
    if (seq > this.highWater + 1) return this.breakEpoch(envelope);

    const replay = this.state.replaySnapshotId() !== undefined;
    if (!replay && event.kind === "sync-complete") return this.rejectProtocol(envelope);
    if (replay && event.kind === "device-removed") {
      this.diagnosticState.protocolViolationCount += 1;
      this.diagnosticState.droppedInvalidCount += 1;
      return this.commitRejection(envelope, "replay_device_removed", event.nativeId);
    }

    if (resourceExhausted) {
      this.diagnosticState.droppedInvalidCount += 1;
      this.addDiagnosticSample(envelope);
      this.applyInvalidPresence(event);
      if (replay) this.countReplay(event);
      return this.commitRejection(envelope, "resource_exhausted", extractNativeId(event));
    }

    const validation = await this.validate(event);
    if (!validation.ok) {
      if (validation.reason === "unsupported") this.diagnosticState.unsupportedSchemaCount += 1;
      this.diagnosticState.droppedInvalidCount += 1;
      this.applyInvalidPresence(event);
      if (replay) this.countReplay(event);
      return this.commitRejection(envelope, validation.reason, validation.nativeId ?? extractNativeId(event));
    }

    if (replay) this.countReplay(event);
    const result = await this.commitLegal(envelope);
    if (!result.accepted) return result;
    this.applyAccepted(event);
    if (event.kind === "sync-complete") {
      this.flushStates();
      return this.finishReplay(envelope);
    }
    return result;
  }

  async consume(adapter: BridgeAdapter, signal: AbortSignal): Promise<IngestResult[]> {
    const results: IngestResult[] = [];
    for await (const envelope of adapter.events(signal)) {
      if (signal.aborted) break;
      results.push(await this.ingest(envelope));
    }
    return results;
  }

  diagnostics(): HubBridgeDiagnostics {
    return {
      ...this.diagnosticState,
      recentHistoryGaps: this.diagnosticState.recentHistoryGaps.map((gap) => ({ ...gap })),
    };
  }

  diagnosticSamples(): readonly { epochId: string; seq: number; kind: string }[] {
    return this.sampleState.map((sample) => ({ ...sample }));
  }

  worldSnapshot(): Map<string, WorldDeviceView> {
    return this.state.snapshot();
  }

  /** Health reduced from neutral events, kept separate from raw ecosystem data. */
  deviceHealth(nativeId: string): DeviceHealthStatus | undefined {
    return this.deviceHealthByNativeId.get(nativeId);
  }

  /** Latest manifest-consistent bridge health status. */
  bridgeHealth(): BridgeHealthStatus {
    return this.bridgeHealthStatus;
  }

  /**
   * Seeds the sequence fence from a durable journal before subscribing to a
   * fresh adapter. This prevents a replayed old epoch from becoming a new
   * first epoch after process restart.
   */
  restoreWatermark(
    watermark: JournalWatermark,
    broken = false,
    historyGaps: readonly HistoryGapRecord[] = [],
  ): void {
    if (!validWatermark(watermark)) throw new TypeError("invalid persisted bridge watermark");
    this.pendingStates.clear();
    this.stateKeysSeen.clear();
    this.activeEpochId = watermark.epochId;
    this.highWater = watermark.lastSeq;
    this.epochBroken = broken;
    this.awaitingFreshEpoch = true;
    this.syncStartedAt = undefined;
    this.diagnosticState.historyGapCount = historyGaps.length;
    this.diagnosticState.recentHistoryGaps = historyGaps.slice(-32).map((gap) => ({
      from: `${gap.epochId}:${gap.fromSeq}`,
      to: `${gap.epochId}:${gap.toSeq}`,
      reason: gap.reason,
    }));
    if (broken) this.diagnosticState.connectionState = "degraded";
  }

  /**
   * Rebuilds only the last journaled, manifest-verified world. Failed or
   * incomplete epochs are deliberately ignored; callers then seed the live
   * sequence fence with the latest (possibly failed) journal watermark.
   */
  async restoreConsistent(records: readonly IngestRecord[], watermark: JournalWatermark): Promise<boolean> {
    if (!validWatermark(watermark)) return false;
    const ordered = records
      .filter((record) => record.bridgeId === this.bridgeId
        && record.envelope.epochId === watermark.epochId
        && record.envelope.seq <= watermark.lastSeq)
      .sort((left, right) => left.envelope.seq - right.envelope.seq);
    const startRecord = ordered.find((record) => record.envelope.event.kind === "sync-start");
    const completeRecord = ordered.find((record) => record.envelope.seq === watermark.lastSeq
      && record.envelope.event.kind === "sync-complete");
    if (startRecord === undefined || completeRecord === undefined
      || startRecord.envelope.event.kind !== "sync-start"
      || completeRecord.envelope.event.kind !== "sync-complete") return false;

    this.startEpoch(startRecord.envelope);
    for (const record of ordered) {
      const envelope = record.envelope;
      if (envelope.event.kind === "sync-start") continue;
      if (envelope.event.kind === "sync-complete") break;
      if (envelope.event.kind !== "device-upserted"
        && envelope.event.kind !== "state"
        && envelope.event.kind !== "device-health"
        && envelope.event.kind !== "bridge-health") continue;
      const validation = await this.validate(envelope.event);
      if (!validation.ok) continue;
      this.applyAccepted(envelope.event);
    }
    this.flushStates();

    try {
      this.state.completeReplay(completeRecord.envelope.event.manifest.snapshotId);
    } catch (error) {
      this.state.abandonReplay();
      return false;
    }
    this.commitReplaySchemaBindings();
    this.commitReplayHealth();
    const receivedAt = completeRecord.receivedAt;
    this.activeEpochId = watermark.epochId;
    this.highWater = watermark.lastSeq;
    this.epochBroken = false;
    this.awaitingFreshEpoch = false;
    this.syncStartedAt = undefined;
    this.diagnosticState.connectionState = this.bridgeHealthStatus === "degraded" ? "degraded" : "ready";
    this.diagnosticState.lastSyncCompleteAt = receivedAt;
    this.diagnosticState.lastEventReceivedAt = receivedAt;
    this.diagnosticState.lastSuccessfulContactAt = receivedAt;
    const parsed = Date.parse(receivedAt);
    if (Number.isFinite(parsed)) this.lastContactMs = parsed;
    return true;
  }

  /** Rebinds the policy control seam when the registry creates a fresh adapter. */
  setControl(control: BridgeControl): void {
    this.control = control;
  }

  /** Replaces the negotiated extension handles after a fresh adapter bind. */
  setEnabledExtensions(enabledExtensions: ReadonlySet<string>): void {
    this.enabledExtensions = enabledExtensions;
  }

  /** Applies all journaled state updates waiting in the deterministic fold buffer. */
  flushStates(): void {
    if (this.pendingStates.size === 0) return;
    if (this.epochBroken) {
      this.pendingStates.clear();
      return;
    }
    for (const event of this.pendingStates.values()) this.state.applyState(event, true);
    this.pendingStates.clear();
  }

  /** Explicit-name alias for scheduler and test seams. */
  flushStateFolding(): void {
    this.flushStates();
  }

  /** Records a classified stream failure without treating transport faults as protocol violations. */
  recordStreamError(reason: "upstream_unavailable" | "authentication_failed" | "rate_limited" | "protocol_error" | "internal_error"): void {
    if (reason === "protocol_error") this.diagnosticState.protocolViolationCount += 1;
    if (this.diagnosticState.connectionState !== "paused" && this.diagnosticState.connectionState !== "quarantined") {
      this.diagnosticState.connectionState = "degraded";
    }
  }

  markDown(): void {
    if (this.diagnosticState.connectionState !== "quarantined") this.diagnosticState.connectionState = "down";
  }

  checkTimeouts(now = this.nowMs()): { heartbeatDown: boolean; syncTimedOut: boolean } {
    const paused = this.diagnosticState.connectionState === "paused";
    const heartbeatDown = !paused && this.lastContactMs !== undefined && now - this.lastContactMs > this.heartbeatIntervalMs * 2;
    const syncTimedOut = this.state.replaySnapshotId() !== undefined
      && this.syncStartedAt !== undefined
      && now - this.syncStartedAt > this.syncTimeoutMs;
    if (heartbeatDown) this.diagnosticState.connectionState = "down";
    if (syncTimedOut) {
      this.diagnosticState.connectionState = "quarantined";
      this.state.abandonReplay();
    }
    return { heartbeatDown, syncTimedOut };
  }

  async requestResync(signal = new AbortController().signal): Promise<ReturnType<BridgeControl["requestResync"]> extends Promise<infer T> ? T : never> {
    if (!this.control) return { status: "unsupported", reason: "unsupported" };
    const result = await this.control.requestResync(signal);
    if (result.status === "completed") this.recordSuccessfulContact();
    return result;
  }

  private async validate(event: BridgeEvent): Promise<ValidationResult> {
    if (!bridgeEventSchema.safeParse(event).success) {
      return { ok: false, reason: "invalid_payload", nativeId: extractNativeId(event) };
    }
    if (this.validateEvent) {
      const result = await this.validateEvent(event);
      if (!result.ok) return result;
    }
    switch (event.kind) {
      case "device-upserted":
        return validateDescriptor(event.device, this.registeredSchemas);
      case "state":
        return this.validateStateEvent(event.state);
      case "device-removed":
        return typeof event.nativeId === "string" && event.nativeId.length > 0
          ? { ok: true }
          : { ok: false, reason: "invalid_payload" };
      case "sync-complete":
        return validateManifest(event.manifest);
      case "ext":
        if (typeof event.ext !== "string" || event.ext.length === 0) return { ok: false, reason: "invalid_payload" };
        if (this.enabledExtensions === undefined || !this.enabledExtensions.has(event.ext)) {
          return { ok: false, reason: "unsupported" };
        }
        const payloadSchema = this.extensionSchemas.get(event.ext);
        if (payloadSchema === undefined) return { ok: false, reason: "unsupported" };
        try {
          return payloadSchema.safeParse(event.payload).success
            ? { ok: true }
            : { ok: false, reason: "invalid_payload" };
        } catch {
          return { ok: false, reason: "invalid_payload" };
        }
      default:
        return { ok: true };
    }
  }

  private startEpoch(envelope: Envelope): void {
    this.pendingStates.clear();
    this.stateKeysSeen.clear();
    this.replayCapabilitySchemas.clear();
    this.replayDeviceHealthByNativeId.clear();
    this.replayBridgeHealthStatus = "up";
    this.activeEpochId = envelope.epochId;
    this.highWater = 0;
    this.replayCounts = { device: 0, state: 0 };
    this.epochBroken = false;
    this.awaitingFreshEpoch = false;
    this.state.beginReplay(envelope.event.kind === "sync-start" ? envelope.event.snapshotId : "");
    this.syncStartedAt = this.nowMs();
    this.diagnosticState.connectionState = "syncing";
  }

  private async validateEpochIdentity(envelope: Envelope): Promise<boolean> {
    if (envelope.event.kind !== "sync-start") return false;
    if (!bridgeEventSchema.safeParse(envelope.event).success) return false;
    const remoteInstanceId = (envelope.event as BridgeEvent & { remoteInstanceId?: unknown }).remoteInstanceId;
    if (typeof remoteInstanceId !== "string" || remoteInstanceId.length === 0) return false;
    if (this.remoteInstanceId !== undefined && remoteInstanceId !== this.remoteInstanceId) return false;
    if (this.validateRemoteInstanceId !== undefined && !(await this.validateRemoteInstanceId(remoteInstanceId, envelope.epochId))) return false;
    return true;
  }

  private rejectRemoteIdentity(envelope: Envelope): IngestResult {
    this.diagnosticState.droppedInvalidCount += 1;
    this.diagnosticState.connectionState = "quarantined";
    return {
      accepted: false,
      epochId: envelope.epochId,
      seq: envelope.seq,
      fatal: true,
      reason: "remote_identity_mismatch",
    };
  }

  private async commitLegal(envelope: Envelope): Promise<IngestResult> {
    try {
      this.journal.appendAtomic({ bridgeId: this.bridgeId, receivedAt: this.clock(), envelope });
      this.highWater = envelope.seq;
      return { accepted: true, epochId: envelope.epochId, seq: envelope.seq };
    } catch (error) {
      if (error instanceof JournalCapacityError) {
        await this.handleCapacity(error);
        return { accepted: false, epochId: envelope.epochId, seq: envelope.seq, reason: "resource_exhausted" };
      }
      this.diagnosticState.connectionState = "quarantined";
      return { accepted: false, epochId: envelope.epochId, seq: envelope.seq, reason: "internal_error" };
    }
  }

  private async commitRejection(envelope: Envelope, reason: string, nativeId?: string): Promise<IngestResult> {
    try {
      this.journal.appendRejectionAtomic({
        bridgeId: this.bridgeId,
        epochId: envelope.epochId,
        seq: envelope.seq,
        reason,
        ...(nativeId === undefined ? {} : { nativeId }),
      }, { epochId: envelope.epochId, lastSeq: envelope.seq });
      this.highWater = envelope.seq;
      return {
        accepted: false,
        epochId: envelope.epochId,
        seq: envelope.seq,
        reason: reason as CoreReasonCode | "replay_device_removed" | "remote_identity_mismatch",
      };
    } catch (error) {
      if (error instanceof JournalCapacityError) await this.handleCapacity(error);
      else this.diagnosticState.connectionState = "quarantined";
      return { accepted: false, epochId: envelope.epochId, seq: envelope.seq, reason: "resource_exhausted" };
    }
  }

  private async handleCapacity(error?: JournalCapacityError): Promise<void> {
    if (error?.retentionConflict) this.recordRetentionConflict();
    if (this.control?.pause) {
      try {
        const result = await this.control.pause(new AbortController().signal);
        if (result.status === "completed") {
          this.recordSuccessfulContact();
          this.diagnosticState.connectionState = "paused";
          return;
        }
      } catch {
        // A failed pause is deliberately fail-closed below.
      }
    }
    this.diagnosticState.connectionState = "quarantined";
  }

  private recordRetentionConflict(): void {
    if (this.activeEpochId === undefined) return;
    const fromSeq = this.highWater + 1;
    const gap: HistoryGapRecord = {
      bridgeId: this.bridgeId,
      epochId: this.activeEpochId,
      fromSeq,
      toSeq: fromSeq,
      reason: "journal_quota_retention_conflict",
    };
    this.diagnosticState.historyGapCount += 1;
    this.diagnosticState.recentHistoryGaps.push({
      from: `${gap.epochId}:${gap.fromSeq}`,
      to: `${gap.epochId}:${gap.toSeq}`,
      reason: gap.reason,
    });
    while (this.diagnosticState.recentHistoryGaps.length > 32) this.diagnosticState.recentHistoryGaps.shift();
    try {
      this.journal.recordRetentionConflict?.(gap);
    } catch {
      // The bridge remains fail-closed even if diagnostics cannot be persisted.
    }
  }

  private applyAccepted(event: BridgeEvent): void {
    switch (event.kind) {
      case "device-upserted":
        this.state.applyDescriptor(event.device, true);
        this.recordCapabilitySchemas(event.device);
        break;
      case "state":
        const key = `${event.state.nativeId}\u0000${event.state.nativeInstanceId}`;
        if (this.stateKeysSeen.has(key)) this.diagnosticState.foldedStateCount += 1;
        this.stateKeysSeen.add(key);
        if (this.stateFoldWindowMs > 0) {
          this.pendingStates.set(key, cloneStateEvent(event.state));
        } else {
          this.state.applyState(event.state, true);
        }
        break;
      case "device-removed":
        this.state.remove(event.nativeId);
        this.removeCapabilitySchemas(event.nativeId);
        this.deviceHealthByNativeId.delete(event.nativeId);
        this.replayDeviceHealthByNativeId.delete(event.nativeId);
        break;
      case "device-health":
        this.recordDeviceHealth(event.nativeId, event.status);
        break;
      case "bridge-health":
        this.recordBridgeHealth(event.status);
        break;
      case "heartbeat":
        break;
      default:
        break;
    }
  }

  private applyInvalidPresence(event: BridgeEvent): void {
    try {
      if (event.kind === "device-upserted") this.state.applyDescriptor(event.device, false);
      if (event.kind === "state") this.state.applyState(event.state, false);
    } catch {
      // Native identity is optional on an invalid payload; never let a
      // malformed value escape the rejection path as an ingest exception.
    }
  }

  private async finishReplay(envelope: Envelope): Promise<IngestResult> {
    const event = envelope.event;
    if (event.kind !== "sync-complete") throw new Error("finishReplay called for non-complete event");
    const manifestMatches = event.manifest.snapshotId === this.state.replaySnapshotId()
      && event.manifest.deviceEnvelopeCount === this.replayCounts.device
      && event.manifest.stateEnvelopeCount === this.replayCounts.state;
    if (!manifestMatches) {
      this.diagnosticState.connectionState = "degraded";
      this.epochBroken = true;
      this.state.abandonReplay();
      return { accepted: false, epochId: envelope.epochId, seq: envelope.seq, reason: "manifest_mismatch" };
    }
    this.state.completeReplay(event.manifest.snapshotId);
    this.commitReplaySchemaBindings();
    this.commitReplayHealth();
    this.diagnosticState.connectionState = this.bridgeHealthStatus === "degraded" ? "degraded" : "ready";
    this.diagnosticState.lastSyncCompleteAt = this.clock();
    this.journal.closeHistoryGaps(this.bridgeId, envelope.epochId);
    this.journal.markConsistent?.(this.bridgeId, { epochId: envelope.epochId, lastSeq: envelope.seq });
    this.syncStartedAt = undefined;
    return { accepted: true, epochId: envelope.epochId, seq: envelope.seq };
  }

  private countReplay(event: BridgeEvent): void {
    if (event.kind !== "device-upserted" && event.kind !== "state") return;
    // Each seq reaches this function once; duplicate seqs return earlier.
    if (event.kind === "device-upserted") this.replayCounts.device += 1;
    else this.replayCounts.state += 1;
  }

  private breakEpoch(envelope: Envelope): IngestResult {
    const fromSeq = this.highWater + 1;
    const toSeq = envelope.seq - 1;
    this.epochBroken = true;
    this.diagnosticState.connectionState = "degraded";
    this.diagnosticState.historyGapCount += 1;
    const gap = { from: `${envelope.epochId}:${fromSeq}`, to: `${envelope.epochId}:${toSeq}`, reason: "sequence_gap" };
    this.diagnosticState.recentHistoryGaps.push(gap);
    while (this.diagnosticState.recentHistoryGaps.length > 32) this.diagnosticState.recentHistoryGaps.shift();
    try {
      this.journal.recordHistoryGap({ bridgeId: this.bridgeId, epochId: envelope.epochId, fromSeq, toSeq, reason: "sequence_gap" });
    } catch (error) {
      if (error instanceof JournalCapacityError) void this.handleCapacity(error);
    }
    this.addDiagnosticSample(envelope);
    void this.requestResync().catch(() => {
      // The epoch is already broken; contain control-plane failures without
      // turning an upstream resync error into an unhandled rejection.
      this.diagnosticState.connectionState = "degraded";
    });
    return { accepted: false, epochId: envelope.epochId, seq: envelope.seq, broken: true, reason: "sequence_gap" };
  }

  private addDiagnosticSample(envelope: Envelope): void {
    this.sampleState.push({ epochId: envelope.epochId, seq: envelope.seq, kind: envelope.event.kind });
    while (this.sampleState.length > this.diagnosticSampleLimit) this.sampleState.shift();
  }

  private recordSuccessfulContact(): void {
    this.lastContactMs = this.nowMs();
    this.diagnosticState.lastSuccessfulContactAt = this.clock();
  }

  private isBrokenEpoch(): boolean {
    return this.epochBroken;
  }

  private rejectProtocol(envelope: Envelope): IngestResult {
    this.diagnosticState.protocolViolationCount += 1;
    this.diagnosticState.droppedInvalidCount += 1;
    return { accepted: false, epochId: envelope.epochId, seq: envelope.seq, reason: "protocol_error" };
  }

  private rejectResource(envelope: Envelope): IngestResult {
    this.diagnosticState.droppedInvalidCount += 1;
    this.addDiagnosticSample(envelope);
    return { accepted: false, epochId: envelope.epochId, seq: envelope.seq, reason: "resource_exhausted" };
  }

  private rejectStaleEpoch(envelope: Envelope): IngestResult {
    this.diagnosticState.staleEpochDropCount += 1;
    return { accepted: false, epochId: envelope.epochId, seq: envelope.seq, reason: "protocol_error" };
  }

  private validateStateEvent(state: StateEvent): ValidationResult {
    const basic = validateState(state);
    if (!basic.ok) return basic;
    if (this.schemaRegistrations.size === 0) return basic;

    const bindings = this.state.replaySnapshotId() === undefined
      ? this.capabilitySchemas
      : this.replayCapabilitySchemas;
    const schemaKey = bindings.get(capabilityKey(state.nativeId, state.nativeInstanceId));
    if (schemaKey === undefined) return { ok: false, reason: "invalid_payload", nativeId: state.nativeId };
    const registration = this.schemaRegistrations.get(schemaKey);
    if (registration === undefined) return { ok: false, reason: "unsupported", nativeId: state.nativeId };
    try {
      return registration.attrsSchema.safeParse(state.attrs).success
        ? { ok: true }
        : { ok: false, reason: "invalid_payload", nativeId: state.nativeId };
    } catch {
      return { ok: false, reason: "invalid_payload", nativeId: state.nativeId };
    }
  }

  private recordCapabilitySchemas(device: DeviceDescriptor): void {
    const bindings = this.state.replaySnapshotId() === undefined
      ? this.capabilitySchemas
      : this.replayCapabilitySchemas;
    for (const capability of device.capabilities) {
      const major = Number.parseInt(capability.schemaVersion.split(".")[0] ?? "", 10);
      if (Number.isSafeInteger(major)) {
        bindings.set(
          capabilityKey(device.nativeId, capability.nativeInstanceId),
          `${capability.schema}@${major}`,
        );
      }
    }
  }

  private removeCapabilitySchemas(nativeId: string): void {
    for (const bindings of [this.capabilitySchemas, this.replayCapabilitySchemas]) {
      for (const key of bindings.keys()) {
        if (key.startsWith(`${nativeId}\u0000`)) bindings.delete(key);
      }
    }
  }

  private commitReplaySchemaBindings(): void {
    this.capabilitySchemas = this.replayCapabilitySchemas;
    this.replayCapabilitySchemas = new Map();
  }

  private recordDeviceHealth(nativeId: string, status: DeviceHealthStatus): void {
    const target = this.state.replaySnapshotId() === undefined
      ? this.deviceHealthByNativeId
      : this.replayDeviceHealthByNativeId;
    target.set(nativeId, status);
  }

  private recordBridgeHealth(status: BridgeHealthStatus): void {
    if (this.state.replaySnapshotId() !== undefined) {
      this.replayBridgeHealthStatus = status;
      return;
    }
    this.bridgeHealthStatus = status;
    if (status === "degraded") {
      this.diagnosticState.connectionState = "degraded";
    } else if (this.diagnosticState.lastSyncCompleteAt !== undefined) {
      this.diagnosticState.connectionState = "ready";
    }
  }

  private commitReplayHealth(): void {
    this.deviceHealthByNativeId = this.replayDeviceHealthByNativeId;
    this.replayDeviceHealthByNativeId = new Map();
    this.bridgeHealthStatus = this.replayBridgeHealthStatus;
    this.replayBridgeHealthStatus = "up";
  }
}

function validateHeader(envelope: Envelope): { ok: true } | { ok: false } {
  if (!envelope || typeof envelope !== "object") return { ok: false };
  if (typeof envelope.epochId !== "string" || envelope.epochId.length === 0) return { ok: false };
  if (!Number.isSafeInteger(envelope.seq) || envelope.seq <= 0) return { ok: false };
  if (!envelope.event || typeof envelope.event !== "object" || typeof envelope.event.kind !== "string") return { ok: false };
  if (!KNOWN_EVENT_KINDS.has(envelope.event.kind)) return { ok: false };
  return { ok: true };
}

const KNOWN_EVENT_KINDS = new Set([
  "sync-start", "device-upserted", "device-removed", "state", "device-health",
  "bridge-health", "heartbeat", "ext", "sync-complete",
]);

function validateDescriptor(device: DeviceDescriptor, registeredSchemas: ReadonlySet<string>): ValidationResult {
  if (!device || typeof device.nativeId !== "string" || device.nativeId.length === 0 || !Array.isArray(device.capabilities) || device.capabilities.length === 0) {
    return { ok: false, reason: "invalid_payload", nativeId: typeof device?.nativeId === "string" ? device.nativeId : undefined };
  }
  for (const capability of device.capabilities) {
    if (!capability || typeof capability.nativeInstanceId !== "string" || capability.nativeInstanceId.length === 0 || typeof capability.schema !== "string" || typeof capability.schemaVersion !== "string") {
      return { ok: false, reason: "invalid_payload", nativeId: device.nativeId };
    }
    const major = Number.parseInt(capability.schemaVersion.split(".")[0] ?? "", 10);
    if (!Number.isSafeInteger(major) || !registeredSchemas.has(`${capability.schema}@${major}`)) {
      return { ok: false, reason: "unsupported", nativeId: device.nativeId };
    }
  }
  return { ok: true };
}

function validateState(state: StateEvent): ValidationResult {
  if (!state || typeof state.nativeId !== "string" || state.nativeId.length === 0 || typeof state.nativeInstanceId !== "string" || state.nativeInstanceId.length === 0) return { ok: false, reason: "invalid_payload", nativeId: state?.nativeId };
  if (!state.attrs || typeof state.attrs !== "object" || Array.isArray(state.attrs)) return { ok: false, reason: "invalid_payload", nativeId: state.nativeId };
  if (!state.time || !["device", "platform", "none"].includes(state.time.sourceTsQuality)) return { ok: false, reason: "invalid_payload", nativeId: state.nativeId };
  if (state.origin !== "observed" && state.origin !== "imported") return { ok: false, reason: "invalid_payload", nativeId: state.nativeId };
  return { ok: true };
}

function capabilityKey(nativeId: string, nativeInstanceId: string): string {
  return `${nativeId}\u0000${nativeInstanceId}`;
}

function validateManifest(manifest: unknown): ValidationResult {
  if (!manifest || typeof manifest !== "object") return { ok: false, reason: "invalid_payload" };
  const value = manifest as Record<string, unknown>;
  if (typeof value.snapshotId !== "string" || value.snapshotId.length === 0 || !Number.isSafeInteger(value.deviceEnvelopeCount) || Number(value.deviceEnvelopeCount) < 0 || !Number.isSafeInteger(value.stateEnvelopeCount) || Number(value.stateEnvelopeCount) < 0) return { ok: false, reason: "invalid_payload" };
  return { ok: true };
}

function extractNativeId(event: BridgeEvent): string | undefined {
  try {
    if (event.kind === "device-upserted") return typeof event.device?.nativeId === "string" ? event.device.nativeId : undefined;
    if (event.kind === "state") return typeof event.state?.nativeId === "string" ? event.state.nativeId : undefined;
    if (event.kind === "device-removed" || event.kind === "device-health") return typeof event.nativeId === "string" ? event.nativeId : undefined;
    return undefined;
  } catch {
    return undefined;
  }
}

function normalizeTime(value: string | number | Date): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function validWatermark(value: JournalWatermark): boolean {
  return Boolean(value)
    && typeof value.epochId === "string"
    && value.epochId.length > 0
    && Number.isSafeInteger(value.lastSeq)
    && value.lastSeq > 0;
}

function normalizeResourceBudget(value: Partial<ResourceBudget> | undefined): ResourceBudget {
  const budget = { ...DEFAULT_RESOURCE_BUDGET, ...(value ?? {}) };
  for (const [key, limit] of Object.entries(budget)) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError(`resource budget ${key} must be a positive safe integer`);
    }
  }
  return budget;
}

function cloneStateEvent(value: StateEvent): StateEvent {
  return {
    nativeId: value.nativeId,
    nativeInstanceId: value.nativeInstanceId,
    attrs: JSON.parse(JSON.stringify(value.attrs)) as StateEvent["attrs"],
    time: { ...value.time },
    origin: value.origin,
  };
}

type ResourceNode = { value: unknown; depth: number };

/**
 * Performs a bounded, cycle-safe shape walk without invoking Zod or
 * serializing the complete untrusted graph. Estimates include object keys so
 * the byte limit remains useful even when a payload contains many tiny values.
 */
function withinResourceBudget(value: unknown, budget: ResourceBudget): boolean {
  const stack: ResourceNode[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let fields = 0;
  let estimatedBytes = 0;
  try {
    while (stack.length > 0) {
      const current = stack.pop() as ResourceNode;
      if (current.depth > budget.maxDepth) return false;
      const item = current.value;
      if (item === null) {
        estimatedBytes += 4;
      } else if (typeof item === "string") {
        if (item.length > budget.maxStringLength) return false;
        estimatedBytes += Buffer.byteLength(item, "utf8") + 2;
      } else if (typeof item === "number" || typeof item === "boolean") {
        estimatedBytes += 8;
      } else if (typeof item === "bigint") {
        estimatedBytes += 16;
      } else if (typeof item === "undefined") {
        estimatedBytes += 1;
      } else if (typeof item === "object") {
        if (seen.has(item)) return false;
        seen.add(item);
        if (Array.isArray(item)) {
          fields += item.length;
          estimatedBytes += 2;
          if (fields > budget.maxFields) return false;
          for (let index = item.length - 1; index >= 0; index -= 1) {
            stack.push({ value: item[index], depth: current.depth + 1 });
          }
        } else {
          const keys = Object.keys(item);
          fields += keys.length;
          estimatedBytes += 2;
          if (fields > budget.maxFields) return false;
          for (let index = keys.length - 1; index >= 0; index -= 1) {
            const key = keys[index] as string;
            estimatedBytes += Buffer.byteLength(key, "utf8") + 3;
            stack.push({ value: (item as Record<string, unknown>)[key], depth: current.depth + 1 });
          }
        }
      } else if (typeof item === "function" || typeof item === "symbol") {
        return false;
      }
      if (estimatedBytes > budget.maxSerializedBytes) return false;
    }
    return true;
  } catch {
    // A throwing getter/proxy is not a reason to enter the deep parser.
    return false;
  }
}
