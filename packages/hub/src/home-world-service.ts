import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Context, Service } from "@deepseek-ai/cordis";
import type { ZodType } from "zod";

import {
  canonicalExtensionKey,
  normalizeBridgeStreamError,
  type BridgeAdapter,
  type BridgeStreamError,
  type BridgeStreamErrorReason,
  type DeviceDescriptor,
  type StateEvent,
} from "../../../contracts/bridge-contract.js";
import {
  BridgeCatalog,
  type BridgeAdapter as CatalogBridgeAdapter,
} from "./bridge-catalog.js";
import {
  BridgeRegistry,
  SqliteBridgeRegistryStore,
  type BridgeRegistryStore,
  type BridgeConfigEntry,
} from "./bridge-registry.js";
import type { ScopedCredentialSource } from "./bridge-credentials.js";
import {
  BridgeIngest,
  type DeviceHealthStatus,
  type HubBridgeDiagnostics,
  type ResourceBudget,
} from "./bridge-ingest.js";
import type { JournalWatermark } from "./bridge-ingest-types.js";
import {
  SqliteIngestJournal,
  type IngestJournal,
  type SqliteIngestJournalOptions,
} from "./ingest-journal.js";
import {
  WorldModelIndex,
  type WorldModelAggregateQuery,
  type WorldModelApplyResult,
  type WorldModelConsistentWatermark,
  type WorldModelDevice,
  type WorldModelFreshness,
  type WorldModelLatestState,
  type WorldModelNumericAggregate,
  type WorldModelRetentionAudit,
  type WorldModelRetentionPolicy,
  type WorldModelStateQuery,
} from "./world-model-index.js";
import {
  AuthorityCoordinator,
  type ActionAuthorityResolution,
  type AuthorityAvailability,
  type AuthorityResyncPort,
  type StateAuthorityResolution,
} from "./authority-coordinator.js";
import {
  WorldIdentityManager,
  type IdentityObservation,
} from "./world-identity.js";
import { WorldState } from "./world-state.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeWorld: HomeWorldService;
  }
}

export interface HomeWorldScheduler {
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export type HomeWorldSchedulerLike = HomeWorldScheduler | HomeWorldScheduler["wait"];

export interface HomeWorldServiceOptions {
  readonly catalog: BridgeCatalog;
  readonly registry?: BridgeRegistry;
  /** Global source; registry creates a bridge-scoped provider for each adapter. */
  readonly credentialSource?: ScopedCredentialSource;
  /** Optional durable binding store; owned and closed when no registry is supplied. */
  readonly registryStore?: BridgeRegistryStore;
  /** Separate registry DB by default; may point at a shared SQLite file explicitly. */
  readonly registryPath?: string;
  /** Optional durable read-model index. Injected indexes remain caller-owned. */
  readonly worldModelIndex?: WorldModelIndex;
  /** Durable read-model path; defaults beside journal files when configured. */
  readonly worldModelPath?: string;
  readonly bridges?: readonly BridgeConfigEntry<unknown>[];
  readonly bridgeConfigs?: readonly BridgeConfigEntry<unknown>[];
  readonly journalFactory?: (bridgeId: string, entry: BridgeConfigEntry<unknown>) => IngestJournal;
  readonly journalDirectory?: string;
  readonly journalPath?: (bridgeId: string, entry: BridgeConfigEntry<unknown>) => string;
  readonly journalOptions?: SqliteIngestJournalOptions;
  readonly scheduler?: HomeWorldSchedulerLike;
  readonly restartBackoffMs?: number | ((attempt: number, reason?: BridgeStreamErrorReason) => number);
  readonly maxRestarts?: number;
  readonly heartbeatIntervalMs?: number;
  readonly syncTimeoutMs?: number;
  readonly diagnosticSampleLimit?: number;
  /** Hub-side structural budget applied before canonical event admission. */
  readonly resourceBudget?: Partial<ResourceBudget>;
  /** Deterministic latest-wins state fold window. */
  readonly stateFoldWindowMs?: number;
  /** Alias for stateFoldWindowMs. */
  readonly foldWindowMs?: number;
  /** Payload schemas for negotiated extension events; absent means fail closed. */
  readonly extensionSchemas?: ReadonlyMap<string, ZodType<unknown>>;
  readonly monitorIntervalMs?: number;
  readonly clock?: () => string | number | Date;
  readonly nowMs?: () => number;
  /** Hub-owned identity allocator; injectable for deterministic governance tests. */
  readonly identityManager?: WorldIdentityManager;
  /** Read-side authority coordinator; action routing remains query-only. */
  readonly authorityCoordinator?: AuthorityCoordinator;
  readonly authorityResyncPort?: AuthorityResyncPort;
  readonly stateAuthorityConfig?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  readonly actionAuthorityConfig?: ConstructorParameters<typeof AuthorityCoordinator>[0]["actionAuthorityConfig"];
  readonly initialStateAuthorities?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  readonly authorityResyncTimeoutMs?: number;
}

export interface HomeWorldBridgeRuntime {
  readonly bridgeId: string;
  readonly adapterType: string;
  adapter: CatalogBridgeAdapter;
  readonly journal: IngestJournal;
  readonly ingest: BridgeIngest;
  extensionAvailability: Readonly<Record<string, "available" | "unavailable">>;
  restartCount: number;
  lastStreamError?: BridgeStreamErrorReason;
  lastTermination: "running" | "completed" | "error";
  subscriptionAbort?: AbortController;
  task?: Promise<void>;
}

export interface HomeWorldDeviceSnapshot {
  bridgeId: string;
  /** Hub identity is the primary cross-bridge device key. */
  hwId: string;
  /** Controlled provenance retained for bridge-local diagnostics and state reads. */
  nativeId: string;
  readonly bindings: readonly HomeWorldBinding[];
  name?: string;
  capabilities: readonly HomeWorldCapabilitySnapshot[];
  descriptor: DeviceDescriptor;
  states: readonly StateEvent[];
  /** Latest reduced health signal, if the bridge has reported one. */
  health?: DeviceHealthStatus;
  validity: "valid" | "stale" | "invalid-source" | "present-but-invalid";
}

export interface HomeWorldBinding {
  readonly bridgeId: string;
  readonly nativeId: string;
  readonly nativeInstanceId: string;
}

export interface HomeWorldCapabilitySnapshot {
  readonly hwCapabilityId: string;
  readonly hwId: string;
  readonly schema: string;
  readonly schemaVersion: string;
  readonly bindings: readonly HomeWorldBinding[];
}

export interface HomeWorldBridgeMetrics {
  /** Consistency indicator: only a completed manifest is ready. */
  consistency: "ready" | "not_ready" | "degraded";
  /** Whether the bridge has delivered an event/contact in this process. */
  eventActivity: "active" | "idle";
  /** Connection liveness, independent of snapshot consistency. */
  connection: "up" | "degraded" | "down";
}

export interface HomeWorldBridgeSnapshot {
  bridgeId: string;
  adapterType: string;
  diagnostics: HubBridgeDiagnostics;
  watermark: HomeWorldWatermark | null;
  devices: readonly HomeWorldDeviceSnapshot[];
  extensions: Readonly<Record<string, "available" | "unavailable">>;
  metrics: HomeWorldBridgeMetrics;
  lastStreamError?: BridgeStreamErrorReason;
}

export interface HomeWorldWatermark {
  bridgeId: string;
  epochId: string;
  lastSeq: number;
  lastSyncCompleteAt?: string;
}

export interface HomeWorldDiagnostics {
  bridgeId: string;
  connectionState: HubBridgeDiagnostics["connectionState"];
  lastSyncCompleteAt?: string;
  lastEventReceivedAt?: string;
  lastSuccessfulContactAt?: string;
}

export interface HomeWorldMetricSummary {
  consistency: readonly {
    bridgeId: string;
    state: HubBridgeDiagnostics["connectionState"];
    lastSyncCompleteAt?: string;
  }[];
  eventActivity: readonly {
    bridgeId: string;
    lastEventReceivedAt?: string;
  }[];
  connectionActivity: readonly {
    bridgeId: string;
    state: HubBridgeDiagnostics["connectionState"];
    lastSuccessfulContactAt?: string;
  }[];
}

export interface HomeWorldSnapshot {
  generatedAt: string;
  bridges: Readonly<Record<string, HomeWorldBridgeSnapshot>>;
  watermarkVector: Readonly<Record<string, HomeWorldWatermark | null>>;
  /** Stable array form consumed by the agent-facing neutral snapshot tool. */
  bridgeWatermarks: readonly HomeWorldWatermark[];
  /** Backwards-compatible alias for callers that use the shorter name. */
  watermarks: readonly HomeWorldWatermark[];
  diagnostics: readonly HomeWorldDiagnostics[];
  metrics: HomeWorldMetricSummary;
  devices: readonly HomeWorldDeviceSnapshot[];
}

const defaultScheduler: HomeWorldScheduler = {
  wait(delayMs, signal) {
    if (signal.aborted || delayMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      timer.unref?.();
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  },
};

/**
 * Neutral Cordis-owned multi-bridge runtime. It owns bridge lifecycles and
 * journals, while all event semantics stay in BridgeIngest.
 */
export class HomeWorldService extends Service {
  readonly catalog: BridgeCatalog;
  readonly identity: WorldIdentityManager;
  readonly authority: AuthorityCoordinator;
  registry!: BridgeRegistry;
  private readonly options: HomeWorldServiceOptions;
  private readonly entries: readonly BridgeConfigEntry<unknown>[];
  private readonly scheduler: HomeWorldScheduler;
  private readonly runtimesById = new Map<string, HomeWorldBridgeRuntime>();
  private readonly identityByDevice = new Map<string, IdentityObservation>();
  private readonly identityDescriptorFingerprints = new Map<string, string>();
  private readonly authorityResyncBaselines = new Map<string, JournalWatermark | undefined>();
  private readonly suppliedRegistry: BridgeRegistry | undefined;
  private worldModelIndexValue: WorldModelIndex | undefined;
  private ownsWorldModelIndex = false;
  private ownedRegistryStore: (BridgeRegistryStore & { close?: () => void }) | undefined;
  private stopController: AbortController | undefined;
  private stopTask: Promise<void> | undefined;
  private monitorTimer: ReturnType<typeof setInterval> | undefined;

  constructor(ctx: Context, options: HomeWorldServiceOptions) {
    super(ctx, "homeWorld");
    this.options = options;
    this.catalog = options.catalog;
    this.suppliedRegistry = options.registry;
    if (options.worldModelIndex !== undefined && options.worldModelPath !== undefined) {
      throw new Error("HomeWorld accepts either worldModelIndex or worldModelPath, not both");
    }
    this.worldModelIndexValue = options.worldModelIndex;
    if (options.registry) this.registry = options.registry;
    this.entries = options.bridges ?? options.bridgeConfigs ?? [];
    this.scheduler = normalizeScheduler(options.scheduler);
    this.identity = options.identityManager ?? new WorldIdentityManager({
      now: () => {
        const value = options.clock?.() ?? new Date();
        return value instanceof Date ? value : typeof value === "number" ? new Date(value) : value;
      },
    });
    this.authority = options.authorityCoordinator ?? new AuthorityCoordinator({
      capabilities: [],
      stateAuthorityConfig: options.stateAuthorityConfig,
      actionAuthorityConfig: options.actionAuthorityConfig,
      initialStateAuthorities: options.initialStateAuthorities,
      resyncPort: options.authorityResyncPort ?? this.createAuthorityResyncPort(),
      resyncTimeoutMs: options.authorityResyncTimeoutMs,
      now: () => {
        const value = options.clock?.() ?? new Date();
        return value instanceof Date ? value : typeof value === "number" ? new Date(value) : value;
      },
    });
    const seen = new Set<string>();
    for (const entry of this.entries) {
      if (seen.has(entry.bridgeId)) throw new Error(`Duplicate homeWorld bridgeId "${entry.bridgeId}"`);
      seen.add(entry.bridgeId);
    }
  }

  protected async [Service.init](): Promise<void> {
    this.stopController = new AbortController();
    this.ctx.effect(() => async () => { await this.stop(); }, "home-world.stop");
    try {
      if (this.options.journalDirectory !== undefined) {
        await mkdir(this.options.journalDirectory, { recursive: true, mode: 0o700 });
      }
      if (this.worldModelIndexValue === undefined) {
        const worldModelPath = this.options.worldModelPath
          ?? (this.options.journalDirectory === undefined
            ? ":memory:"
            : join(this.options.journalDirectory, "world-model.sqlite"));
        if (worldModelPath !== ":memory:" && !worldModelPath.startsWith("file::memory:")) {
          await mkdir(dirname(worldModelPath), { recursive: true, mode: 0o700 });
        }
        this.worldModelIndexValue = new WorldModelIndex({ path: worldModelPath });
        this.ownsWorldModelIndex = true;
      }
      if (this.suppliedRegistry === undefined) {
        const registryPath = this.options.registryPath
          ?? (this.options.journalDirectory === undefined
            ? ":memory:"
            : join(this.options.journalDirectory, "bridge-registry.sqlite"));
        if (this.options.registryStore === undefined
          && registryPath !== ":memory:"
          && !registryPath.startsWith("file::memory:")) {
          await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
        }
        const store = this.options.registryStore ?? new SqliteBridgeRegistryStore(registryPath);
        this.ownedRegistryStore = store;
        this.registry = new BridgeRegistry({
          catalog: this.catalog,
          store,
          credentialSource: this.options.credentialSource,
        });
      }
      for (const entry of this.entries) await this.startBridge(entry);
      const monitorIntervalMs = this.options.monitorIntervalMs ?? 1_000;
      if (monitorIntervalMs > 0) {
        this.monitorTimer = setInterval(() => this.tick(), monitorIntervalMs);
        this.monitorTimer.unref?.();
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  runtime(bridgeId: string): HomeWorldBridgeRuntime | undefined {
    return this.runtimesById.get(bridgeId);
  }

  runtimes(): readonly HomeWorldBridgeRuntime[] {
    return [...this.runtimesById.values()];
  }

  journal(bridgeId: string): IngestJournal | undefined {
    return this.runtimesById.get(bridgeId)?.journal;
  }

  /** Caller-owned read-model handle, useful for recovery diagnostics only. */
  get worldModel(): WorldModelIndex | undefined {
    return this.worldModelIndexValue;
  }

  worldModelDevices(bridgeId?: string): WorldModelDevice[] {
    this.assertWorldModelReadable(bridgeId);
    return this.requireWorldModel().devices(bridgeId);
  }

  worldModelLatestState(
    bridgeId: string,
    nativeId: string,
    nativeInstanceId: string,
  ): WorldModelLatestState | undefined {
    this.assertWorldModelReadable(bridgeId);
    return this.requireWorldModel().latestState(bridgeId, nativeId, nativeInstanceId);
  }

  worldModelLatestStates(query: WorldModelStateQuery = {}): WorldModelLatestState[] {
    this.assertWorldModelReadable(query.bridgeId);
    return this.requireWorldModel().latestStates(query);
  }

  worldModelNumericAggregates(query: WorldModelAggregateQuery = {}): WorldModelNumericAggregate[] {
    this.assertWorldModelReadable(query.bridgeId);
    return this.requireWorldModel().numericAggregates(query);
  }

  worldModelWatermark(bridgeId: string): WorldModelConsistentWatermark | undefined {
    this.assertWorldModelReadable(bridgeId);
    return this.requireWorldModel().consistentWatermark(bridgeId);
  }

  worldModelFreshness(bridgeId: string): WorldModelFreshness | undefined {
    this.assertWorldModelReadable(bridgeId);
    return this.requireWorldModel().freshness(bridgeId);
  }

  applyWorldModelRetention(policy: WorldModelRetentionPolicy): WorldModelRetentionAudit {
    return this.requireWorldModel().applyRetention(policy);
  }

  worldModelRetentionAudits(): WorldModelRetentionAudit[] {
    return this.requireWorldModel().retentionAudits();
  }

  snapshot(): HomeWorldSnapshot {
    this.refreshIdentity();
    const bridges: Record<string, HomeWorldBridgeSnapshot> = {};
    const watermarkVector: Record<string, HomeWorldWatermark | null> = {};
    const bridgeWatermarks: HomeWorldWatermark[] = [];
    const diagnosticsList: HomeWorldDiagnostics[] = [];
    const devices: HomeWorldDeviceSnapshot[] = [];
    for (const runtime of this.runtimesById.values()) {
      const diagnostics = runtime.ingest.diagnostics();
      // The latest journal row may belong to a partial or broken epoch. The
      // agent-facing cursor is therefore sourced only from the manifest-
      // verified consistency boundary.
      const consistentWatermark = runtime.journal.consistentWatermark?.(runtime.bridgeId);
      const watermark = consistentWatermark === undefined ? null : {
        bridgeId: runtime.bridgeId,
        ...consistentWatermark,
        ...(diagnostics.lastSyncCompleteAt === undefined ? {} : { lastSyncCompleteAt: diagnostics.lastSyncCompleteAt }),
      } satisfies HomeWorldWatermark;
      const bridgeDevices = worldDevices(
        runtime.bridgeId,
        runtime.ingest.worldSnapshot(),
        this.identityByDevice,
        (nativeId) => runtime.ingest.deviceHealth(nativeId),
      );
      const bridgeSnapshot: HomeWorldBridgeSnapshot = {
        bridgeId: runtime.bridgeId,
        adapterType: runtime.adapterType,
        diagnostics,
        watermark,
        devices: bridgeDevices,
        extensions: { ...runtime.extensionAvailability },
        metrics: metricsFor(diagnostics),
        ...(runtime.lastStreamError === undefined ? {} : { lastStreamError: runtime.lastStreamError }),
      };
      bridges[runtime.bridgeId] = bridgeSnapshot;
      watermarkVector[runtime.bridgeId] = watermark;
      diagnosticsList.push({ bridgeId: runtime.bridgeId, ...diagnostics });
      if (watermark !== null) bridgeWatermarks.push(watermark);
      devices.push(...bridgeDevices);
    }
    diagnosticsList.sort((left, right) => left.bridgeId.localeCompare(right.bridgeId));
    bridgeWatermarks.sort((left, right) => left.bridgeId.localeCompare(right.bridgeId));
    return {
      generatedAt: this.clock(),
      bridges,
      watermarkVector,
      bridgeWatermarks,
      watermarks: bridgeWatermarks,
      diagnostics: diagnosticsList,
      metrics: metricSummary(diagnosticsList),
      devices: aggregateWorldDevices(devices, this.authority),
    };
  }

  /**
   * Reconciles a read-side state authority. A candidate is accepted only when
   * the coordinator's resync seam observes the expected binding in a complete
   * epoch; this method never exposes an action executor.
   */
  async reconcileStateAuthority(hwCapabilityId: string, preferredBridgeId?: string): Promise<StateAuthorityResolution> {
    this.refreshIdentity();
    return this.authority.reconcileStateAuthority(
      hwCapabilityId,
      this.authorityAvailability(hwCapabilityId),
      preferredBridgeId,
    );
  }

  resolveActionAuthority(hwCapabilityId: string): ActionAuthorityResolution {
    this.refreshIdentity();
    return this.authority.resolveActionAuthority(hwCapabilityId, this.authorityAvailability(hwCapabilityId));
  }

  /** Runs both liveness clocks synchronously for deterministic callers/tests. */
  tick(now = this.nowMs()): void {
    for (const runtime of this.runtimesById.values()) {
      const timeout = runtime.ingest.checkTimeouts(now);
      if (timeout.heartbeatDown || timeout.syncTimedOut) runtime.subscriptionAbort?.abort();
    }
  }

  async stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopTask = (async () => {
      this.stopController?.abort();
      if (this.monitorTimer !== undefined) clearInterval(this.monitorTimer);
      for (const runtime of this.runtimesById.values()) runtime.subscriptionAbort?.abort();
      const tasks = [...this.runtimesById.values()].map((runtime) => runtime.task).filter((task): task is Promise<void> => task !== undefined);
      await Promise.allSettled(tasks);
      for (const runtime of this.runtimesById.values()) runtime.journal.close();
      if (this.ownsWorldModelIndex) {
        this.worldModelIndexValue?.close();
        this.worldModelIndexValue = undefined;
        this.ownsWorldModelIndex = false;
      }
      this.ownedRegistryStore?.close?.();
    })();
    return this.stopTask;
  }

  private async startBridge(entry: BridgeConfigEntry<unknown>): Promise<void> {
    if (this.runtimesById.has(entry.bridgeId)) throw new Error(`Duplicate homeWorld bridgeId "${entry.bridgeId}"`);
    const adapter = this.registry.load(entry);
    let journal: IngestJournal | undefined;
    try {
      journal = this.createJournal(entry);
      const extensions = negotiateExtensions(adapter);
      const registration = this.catalog.requireAdapter(entry.adapterType);
      const registeredSchemas = new Set(registration.capabilitySchemas.map((schema) => `${schema.schema}@${schema.majorVersion}`));
      const world = new WorldState();
      const ingest = new BridgeIngest({
        bridgeId: entry.bridgeId,
        journal,
        world,
        control: adapter.control,
        registeredSchemas,
        schemaRegistrations: new Map(registration.capabilitySchemas.map((schema) => [
          `${schema.schema}@${schema.majorVersion}`,
          schema,
        ])),
        enabledExtensions: new Set(extensions.available),
        extensionSchemas: this.options.extensionSchemas,
        remoteIdentityValidator: this.registry.createRemoteIdentityValidator(entry.bridgeId),
        clock: this.options.clock,
        nowMs: this.options.nowMs,
        heartbeatIntervalMs: this.options.heartbeatIntervalMs ?? adapter.info.heartbeatIntervalMs,
        syncTimeoutMs: this.options.syncTimeoutMs,
        diagnosticSampleLimit: this.options.diagnosticSampleLimit,
        resourceBudget: this.options.resourceBudget,
        stateFoldWindowMs: this.options.stateFoldWindowMs,
        foldWindowMs: this.options.foldWindowMs,
      });
      const persistedWatermark = journal.watermark(entry.bridgeId);
      const consistentWatermark = journal.consistentWatermark?.(entry.bridgeId);
      if (consistentWatermark !== undefined) {
        await ingest.restoreConsistent(journal.records(entry.bridgeId), consistentWatermark);
      }
      if (persistedWatermark !== undefined) {
        const persistedHistoryGaps = journal.historyGaps(entry.bridgeId);
        const persistedBroken = persistedHistoryGaps.some((gap) => (
          gap.epochId === persistedWatermark.epochId
            && (consistentWatermark === undefined || consistentWatermark.epochId !== persistedWatermark.epochId)
        ));
        ingest.restoreWatermark(persistedWatermark, persistedBroken, persistedHistoryGaps);
      }
      const runtime: HomeWorldBridgeRuntime = {
        bridgeId: entry.bridgeId,
        adapterType: entry.adapterType,
        adapter,
        journal,
        ingest,
        extensionAvailability: extensions.status,
        restartCount: 0,
        lastTermination: "running",
      };
      this.materializeWorldModel(runtime);
      this.runtimesById.set(entry.bridgeId, runtime);
      runtime.task = this.runBridge(runtime, entry);
    } catch (error) {
      try {
        journal?.close();
      } catch {
        // Preserve the startup failure while still attempting adapter cleanup.
      }
      try {
        await adapter.control.dispose();
      } catch {
        // Preserve the original startup failure; no subscription was started.
      }
      throw error;
    }
  }

  private async runBridge(runtime: HomeWorldBridgeRuntime, entry: BridgeConfigEntry<unknown>): Promise<void> {
    const signal = this.stopController?.signal ?? new AbortController().signal;
    while (!signal.aborted) {
      const subscriptionAbort = new AbortController();
      runtime.subscriptionAbort = subscriptionAbort;
      runtime.lastTermination = "running";
      let streamError: BridgeStreamError | undefined;
      try {
        for await (const envelope of runtime.adapter.events(subscriptionAbort.signal)) {
          if (signal.aborted || subscriptionAbort.signal.aborted) break;
          const result = await runtime.ingest.ingest(envelope);
          // A fold window is an admission optimization, never a visibility
          // stall: each adapter batch exposes its latest accepted state.
          runtime.ingest.flushStateFolding();
          if (result.accepted && envelope.event.kind === "sync-complete") {
            this.materializeWorldModel(runtime);
          }
          // A remote identity mismatch is a security boundary failure, not a
          // transient stream fault. Stop this adapter immediately; only an
          // explicit registry rebind may permit a future lifecycle.
          if (result.fatal) {
            subscriptionAbort.abort();
            break;
          }
          this.refreshIdentityForRuntime(runtime);
        }
        runtime.lastTermination = "completed";
      } catch (error) {
        streamError = normalizeBridgeStreamError(error);
        runtime.lastTermination = "error";
        runtime.lastStreamError = streamError.reason;
        runtime.ingest.recordStreamError(streamError.reason);
      } finally {
        subscriptionAbort.abort();
        runtime.subscriptionAbort = undefined;
        try {
          await runtime.adapter.control.dispose();
        } catch (error) {
          const disposeError = normalizeBridgeStreamError(error);
          runtime.lastStreamError = disposeError.reason;
          runtime.ingest.recordStreamError(disposeError.reason);
        }
      }
      if (signal.aborted) return;
      // Resource safety states require an explicit control/rebind path. Do
      // not spin a fresh adapter against a paused or quarantined journal.
      const connectionState = runtime.ingest.diagnostics().connectionState;
      if (connectionState === "paused" || connectionState === "quarantined") return;
      const canRestart = runtime.restartCount < (this.options.maxRestarts ?? Number.POSITIVE_INFINITY);
      if (streamError === undefined && canRestart) {
        // A clean end is still a lost connection while the replacement is
        // being constructed; preserve the last consistent world meanwhile.
        runtime.ingest.recordStreamError("upstream_unavailable");
      }
      if (!canRestart) {
        if (streamError !== undefined) runtime.ingest.markDown();
        return;
      }
      runtime.restartCount += 1;
      const delay = restartDelay(this.options.restartBackoffMs, runtime.restartCount, streamError?.reason);
      await this.scheduler.wait(delay, signal);
      if (signal.aborted) return;
      try {
        const next = this.registry.load(entry);
        runtime.adapter = next;
        const extensions = negotiateExtensions(next);
        runtime.extensionAvailability = extensions.status;
        runtime.ingest.setControl(next.control);
        runtime.ingest.setEnabledExtensions(new Set(extensions.available));
      } catch (error) {
        const normalized = normalizeBridgeStreamError(error);
        runtime.lastTermination = "error";
        runtime.lastStreamError = normalized.reason;
        runtime.ingest.recordStreamError(normalized.reason);
        runtime.ingest.markDown();
        return;
      }
    }
  }

  private refreshIdentity(): void {
    for (const runtime of this.runtimesById.values()) this.refreshIdentityForRuntime(runtime);
  }

  private refreshIdentityForRuntime(runtime: HomeWorldBridgeRuntime): void {
    for (const device of runtime.ingest.worldSnapshot().values()) {
      const key = `${runtime.bridgeId}\u0000${device.descriptor.nativeId}`;
      const fingerprint = JSON.stringify(device.descriptor);
      if (this.identityByDevice.has(key) && this.identityDescriptorFingerprints.get(key) === fingerprint) continue;
      const observation = this.identity.observe(runtime.bridgeId, device.descriptor);
      this.identityByDevice.set(key, observation);
      this.identityDescriptorFingerprints.set(key, fingerprint);
      this.authority.registerCapabilities(observation.capabilities);
    }
  }

  private authorityAvailability(hwCapabilityId: string): readonly AuthorityAvailability[] {
    const capability = this.authority.capability(hwCapabilityId);
    if (capability === undefined) return [];
    return capability.bindings.map((binding) => {
      const runtime = this.runtimesById.get(binding.bridgeId);
      const device = runtime?.ingest.worldSnapshot().get(binding.nativeId);
      const validity = device?.validity ?? "invalid-source";
      const state = runtime?.ingest.diagnostics().connectionState;
      return {
        bridgeId: binding.bridgeId,
        available: device !== undefined && validity === "valid"
          && state !== undefined
          && state !== "down"
          && state !== "quarantined"
          && state !== "paused",
        validity,
      };
    });
  }

  private createAuthorityResyncPort(): AuthorityResyncPort {
    return {
      requestResync: async (bridgeId, signal) => {
        const runtime = this.runtimesById.get(bridgeId);
        if (runtime === undefined) return { status: "unsupported", reason: "unsupported" };
        this.authorityResyncBaselines.set(
          bridgeId,
          runtime.journal.consistentWatermark?.(bridgeId),
        );
        try {
          const result = await runtime.ingest.requestResync(signal);
          if (result.status !== "completed") this.authorityResyncBaselines.delete(bridgeId);
          return result;
        } catch (error) {
          this.authorityResyncBaselines.delete(bridgeId);
          throw error;
        }
      },
      waitForSyncComplete: async (bridgeId, _generation, signal) => {
        const runtime = this.runtimesById.get(bridgeId);
        if (runtime === undefined) throw new Error(`Unknown bridge "${bridgeId}"`);
        const before = this.authorityResyncBaselines.get(bridgeId);
        try {
          for (;;) {
            if (signal?.aborted) throw new Error("resync aborted");
            const diagnostics = runtime.ingest.diagnostics();
            const consistentWatermark = runtime.journal.consistentWatermark?.(bridgeId);
            if (diagnostics.connectionState === "ready"
              && consistentWatermark !== undefined
              && consistentWatermark.epochId !== before?.epochId) {
              this.refreshIdentityForRuntime(runtime);
              return {
                bridgeId,
                epochId: consistentWatermark.epochId,
                bindings: this.authority.capabilitiesSnapshot().flatMap((capability) => capability.bindings
                  .filter((binding) => binding.bridgeId === bridgeId)
                  .filter((binding) => {
                    const device = runtime.ingest.worldSnapshot().get(binding.nativeId);
                    return device?.validity === "valid"
                      && device.descriptor.capabilities.some((ref) => ref.nativeInstanceId === binding.nativeInstanceId);
                  })
                  .map((binding) => ({
                    hwCapabilityId: capability.hwCapabilityId,
                    nativeId: binding.nativeId,
                    nativeInstanceId: binding.nativeInstanceId,
                    validity: "valid" as const,
                  }))),
              };
            }
            await this.scheduler.wait(10, signal ?? new AbortController().signal);
          }
        } finally {
          this.authorityResyncBaselines.delete(bridgeId);
        }
      },
    };
  }

  private requireWorldModel(): WorldModelIndex {
    if (this.worldModelIndexValue === undefined) {
      throw new Error("World model index is not initialized");
    }
    return this.worldModelIndexValue;
  }

  private assertWorldModelReadable(bridgeId?: string): void {
    if (bridgeId !== undefined) {
      const runtime = this.runtimesById.get(bridgeId);
      if (runtime !== undefined) this.assertWorldModelBoundary(runtime);
      return;
    }
    for (const runtime of this.runtimesById.values()) this.assertWorldModelBoundary(runtime);
  }

  /**
   * A read model may never outrun the journal's manifest-verified cut. This
   * check also catches a world-model file restored beside a truncated or
   * replaced journal before its rows become visible through the service.
   */
  private assertWorldModelBoundary(runtime: HomeWorldBridgeRuntime): void {
    const index = this.worldModelIndexValue;
    const sourceWatermark = runtime.journal.consistentWatermark?.(runtime.bridgeId);
    const indexedWatermark = index?.consistentWatermark(runtime.bridgeId);
    if (index === undefined || indexedWatermark === undefined) return;
    if (sourceWatermark === undefined) {
      throw new Error(`World model index for bridge "${runtime.bridgeId}" has no journal consistency boundary`);
    }
    if (indexedWatermark.epochId === sourceWatermark.epochId
      && indexedWatermark.lastSeq > sourceWatermark.lastSeq) {
      throw new Error(`World model index for bridge "${runtime.bridgeId}" is ahead of its journal`);
    }
    const persistedWatermark = runtime.journal.watermark(runtime.bridgeId);
    if (persistedWatermark?.epochId === indexedWatermark.epochId
      && persistedWatermark.epochId !== sourceWatermark.epochId) {
      throw new Error(`World model index for bridge "${runtime.bridgeId}" points at an incomplete journal epoch`);
    }
    const indexedComplete = runtime.journal.records(runtime.bridgeId).some((record) => (
      record.envelope.epochId === indexedWatermark.epochId
      && record.envelope.seq === indexedWatermark.lastSeq
      && record.envelope.event.kind === "sync-complete"
    ));
    if (!indexedComplete) {
      throw new Error(`World model index for bridge "${runtime.bridgeId}" is not recoverable from its journal`);
    }
  }

  private materializeWorldModel(runtime: HomeWorldBridgeRuntime): WorldModelApplyResult | undefined {
    const index = this.worldModelIndexValue;
    const watermark = runtime.journal.consistentWatermark?.(runtime.bridgeId);
    if (index === undefined || watermark === undefined) return undefined;
    this.assertWorldModelBoundary(runtime);
    const gaps = runtime.journal.historyGaps(runtime.bridgeId);
    const rejected = runtime.journal.rejections(runtime.bridgeId)
      .filter((rejection) => rejection.epochId === watermark.epochId && rejection.seq <= watermark.lastSeq);
    const rejectedNativeIds = rejected
      .flatMap((rejection) => rejection.nativeId === undefined ? [] : [rejection.nativeId]);
    return index.applyConsistentBatch({
      bridgeId: runtime.bridgeId,
      records: runtime.journal.records(runtime.bridgeId),
      consistentWatermark: watermark,
      gaps,
      allowRejectedEvents: rejected.length > 0,
      rejectedNativeIds,
    });
  }

  private createJournal(entry: BridgeConfigEntry<unknown>): IngestJournal {
    if (this.options.journalFactory) return this.options.journalFactory(entry.bridgeId, entry);
    const path = this.options.journalPath?.(entry.bridgeId, entry)
      ?? (this.options.journalDirectory === undefined ? ":memory:" : join(this.options.journalDirectory, `${encodeURIComponent(entry.bridgeId)}.sqlite`));
    return new SqliteIngestJournal(path, this.options.journalOptions);
  }

  private clock(): string {
    return normalizeClock(this.options.clock?.() ?? new Date());
  }

  private nowMs(): number {
    if (this.options.nowMs) return this.options.nowMs();
    const value = this.options.clock?.();
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return Date.now();
  }
}

function normalizeScheduler(scheduler: HomeWorldSchedulerLike | undefined): HomeWorldScheduler {
  if (scheduler === undefined) return defaultScheduler;
  if (typeof scheduler === "function") return { wait: scheduler };
  return scheduler;
}

function restartDelay(
  configured: HomeWorldServiceOptions["restartBackoffMs"],
  attempt: number,
  reason: BridgeStreamErrorReason | undefined,
): number {
  const value = typeof configured === "function" ? configured(attempt, reason) : configured ?? 1_000;
  return Number.isFinite(value) ? Math.max(0, value) : 1_000;
}

function negotiateExtensions(adapter: BridgeAdapter): {
  status: Record<string, "available" | "unavailable">;
  available: string[];
} {
  const status: Record<string, "available" | "unavailable"> = {};
  const available: string[] = [];
  for (const declaration of adapter.info.extensions) {
    let key: string;
    try {
      key = canonicalExtensionKey(declaration);
    } catch {
      key = `${declaration.id}@invalid`;
    }
    let usable = false;
    try {
      if (typeof adapter.extension === "function") {
        const handle = adapter.extension(key as never);
        usable = handle !== undefined && handle !== null;
      }
    } catch {
      usable = false;
    }
    status[key] = usable ? "available" : "unavailable";
    if (usable) available.push(key);
  }
  return { status, available };
}

function worldDevices(
  bridgeId: string,
  world: Map<string, { descriptor: DeviceDescriptor; states: Map<string, StateEvent>; validity: HomeWorldDeviceSnapshot["validity"] }>,
  identities: ReadonlyMap<string, IdentityObservation>,
  healthForNativeId?: (nativeId: string) => DeviceHealthStatus | undefined,
): HomeWorldDeviceSnapshot[] {
  return [...world.values()].map((device) => {
    const nativeId = device.descriptor.nativeId;
    const observation = identities.get(`${bridgeId}\u0000${nativeId}`);
    const hwId = observation?.identity.hwId ?? `local:${bridgeId}:${nativeId}`;
    const capabilities = observation?.capabilities.map((capability) => {
      const binding = capability.bindings[0];
      const ref = device.descriptor.capabilities.find((candidate) => (
        candidate.schema === capability.schema
          && candidate.nativeInstanceId === binding?.nativeInstanceId
      ));
      return {
        hwCapabilityId: capability.hwCapabilityId,
        hwId: capability.hwId,
        schema: capability.schema,
        schemaVersion: ref?.schemaVersion ?? "unknown",
        bindings: capability.bindings.map((item) => ({ ...item })),
      } satisfies HomeWorldCapabilitySnapshot;
    }) ?? device.descriptor.capabilities.map((ref, index) => ({
      hwCapabilityId: `${hwId}:capability:${index}`,
      hwId,
      schema: ref.schema,
      schemaVersion: ref.schemaVersion,
      bindings: [{ bridgeId, nativeId, nativeInstanceId: ref.nativeInstanceId }],
    } satisfies HomeWorldCapabilitySnapshot));
    const bindings = uniqueBindings(capabilities.flatMap((capability) => capability.bindings));
    const health = healthForNativeId?.(nativeId);
    return {
      bridgeId,
      hwId,
      nativeId,
      bindings,
      descriptor: cloneJson(device.descriptor),
      ...(device.descriptor.name === undefined ? {} : { name: device.descriptor.name }),
      capabilities: cloneJson(capabilities),
      states: [...device.states.values()].map((state) => cloneJson(state)),
      ...(health === undefined ? {} : { health }),
      validity: device.validity,
    };
  });
}

function aggregateWorldDevices(
  devices: readonly HomeWorldDeviceSnapshot[],
  authority: AuthorityCoordinator,
): HomeWorldDeviceSnapshot[] {
  const grouped = new Map<string, HomeWorldDeviceSnapshot>();
  for (const device of devices) {
    const existing = grouped.get(device.hwId);
    if (existing === undefined) {
      grouped.set(device.hwId, {
        ...device,
        bindings: device.bindings.map((binding) => ({ ...binding })),
        capabilities: device.capabilities.map((capability) => ({
          ...capability,
          bindings: capability.bindings.map((binding) => ({ ...binding })),
        })),
        states: device.states.map((state) => cloneJson(state)),
      });
      continue;
    }
    const bindings = uniqueBindings([...existing.bindings, ...device.bindings]);
    const capabilityById = new Map(existing.capabilities.map((capability) => [capability.hwCapabilityId, capability]));
    for (const capability of device.capabilities) {
      const prior = capabilityById.get(capability.hwCapabilityId);
      if (prior === undefined) {
        capabilityById.set(capability.hwCapabilityId, {
          ...capability,
          bindings: capability.bindings.map((binding) => ({ ...binding })),
        });
      } else {
        capabilityById.set(capability.hwCapabilityId, {
          ...prior,
          bindings: uniqueBindings([...prior.bindings, ...capability.bindings]),
        });
      }
    }
    const stateByKey = new Map(existing.states.map((state) => [`${state.nativeId}\u0000${state.nativeInstanceId}`, state]));
    for (const state of device.states) stateByKey.set(`${state.nativeId}\u0000${state.nativeInstanceId}`, state);
    grouped.set(device.hwId, {
      ...existing,
      bindings,
      capabilities: [...capabilityById.values()].sort((left, right) => compareStrings(left.hwCapabilityId, right.hwCapabilityId)),
      states: [...stateByKey.values()].map((state) => cloneJson(state)),
      validity: existing.validity === "valid" || device.validity === "valid" ? "valid" : existing.validity,
    });
  }

  return [...grouped.values()]
    .map((device) => ({ ...device, states: selectAuthorityStates(device, authority) }))
    .sort((left, right) => compareStrings(left.hwId, right.hwId));
}

function selectAuthorityStates(
  device: HomeWorldDeviceSnapshot,
  authority: AuthorityCoordinator,
): readonly StateEvent[] {
  if (device.capabilities.length === 0) return device.states.map((state) => cloneJson(state));
  const selectedKeys = new Set<string>();
  for (const capability of device.capabilities) {
    const selectedBridge = authority.currentStateAuthority(capability.hwCapabilityId);
    if (selectedBridge === undefined) continue;
    const selectedBindings = capability.bindings.filter((binding) => binding.bridgeId === selectedBridge);
    for (const state of device.states) {
      if (selectedBindings.some((binding) => binding.nativeId === state.nativeId
        && binding.nativeInstanceId === state.nativeInstanceId)) {
        selectedKeys.add(`${state.nativeId}\u0000${state.nativeInstanceId}`);
      }
    }
  }
  if (selectedKeys.size === 0) return [];
  return device.states.filter((state) => selectedKeys.has(`${state.nativeId}\u0000${state.nativeInstanceId}`)).map((state) => cloneJson(state));
}

function uniqueBindings(bindings: readonly HomeWorldBinding[]): HomeWorldBinding[] {
  const result = new Map<string, HomeWorldBinding>();
  for (const binding of bindings) {
    const key = `${binding.bridgeId}\u0000${binding.nativeId}\u0000${binding.nativeInstanceId}`;
    if (!result.has(key)) result.set(key, { ...binding });
  }
  return [...result.values()].sort((left, right) => compareStrings(left.bridgeId, right.bridgeId)
    || compareStrings(left.nativeId, right.nativeId)
    || compareStrings(left.nativeInstanceId, right.nativeInstanceId));
}

function metricSummary(diagnostics: readonly HomeWorldDiagnostics[]): HomeWorldMetricSummary {
  return {
    consistency: diagnostics.map(({ bridgeId, connectionState: state, lastSyncCompleteAt }) => ({
      bridgeId,
      state,
      ...(lastSyncCompleteAt === undefined ? {} : { lastSyncCompleteAt }),
    })),
    eventActivity: diagnostics.map(({ bridgeId, lastEventReceivedAt }) => ({
      bridgeId,
      ...(lastEventReceivedAt === undefined ? {} : { lastEventReceivedAt }),
    })),
    connectionActivity: diagnostics.map(({ bridgeId, connectionState: state, lastSuccessfulContactAt }) => ({
      bridgeId,
      state,
      ...(lastSuccessfulContactAt === undefined ? {} : { lastSuccessfulContactAt }),
    })),
  };
}

function metricsFor(diagnostics: HubBridgeDiagnostics): HomeWorldBridgeMetrics {
  const consistency = diagnostics.connectionState === "ready"
    ? "ready"
    : diagnostics.connectionState === "degraded" ? "degraded" : "not_ready";
  const connection = diagnostics.connectionState === "down" || diagnostics.connectionState === "quarantined"
    ? "down"
    : diagnostics.connectionState === "degraded" || diagnostics.connectionState === "paused" ? "degraded" : "up";
  return {
    consistency,
    eventActivity: diagnostics.lastEventReceivedAt === undefined ? "idle" : "active",
    connection,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeClock(value: string | number | Date): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  return value;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
