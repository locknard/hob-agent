import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { Context, Service } from "@deepseek-ai/cordis";
import type { ZodType } from "zod";
import {
  foreignRuleCatalogSchema,
  foreignRuleMigrationBindingSchema,
  foreignRuleMigrationRequestSchema,
  foreignRuleMigrationResultSchema,
  type ForeignRuleMigrationBinding,
  type ForeignRuleMigrationHandle,
  type ForeignRuleMigrationPlan,
  type ForeignRuleMigrationUnsupportedReason,
  type ForeignRuleSummary,
  type ForeignRuleControlHandle,
  type ForeignRulesHandle,
} from "@hob/bridge-contract";
import { orgHintPayloadSchema } from "@hob/bridge-contract";
import {
  bridgeActionDescriptorRequestSchema,
  bridgeActionDescriptorSchema,
  bridgeActionCurrentStateSchema,
  bridgeActionResultSchema,
  type ActionsExtension,
  type AutomationsExtension,
  type BridgeActionTarget,
  type BridgeActionCurrentState,
  type BridgeActionDescriptor,
  type BridgeActionResult,
} from "@hob/bridge-contract";

import {
  canonicalExtensionKey,
  normalizeBridgeStreamError,
  type BridgeAdapter,
  type BridgeStreamError,
  type BridgeStreamErrorReason,
  type CapabilitySemanticKind,
  type DeviceDescriptor,
  type StateEvent,
  type WorldSpace,
} from "@hob/bridge-contract";
import {
  BridgeCatalog,
  type BridgeAdapter as CatalogBridgeAdapter,
} from "../bridge/bridge-catalog.js";
import {
  BridgeRegistry,
  SqliteBridgeRegistryStore,
  type BridgeRegistryStore,
  type BridgeConfigEntry,
} from "../bridge/bridge-registry.js";
import type { ScopedCredentialSource } from "../bridge/bridge-credentials.js";
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
  type ActionAuthorityConfigurationResolution,
} from "../authority/authority-coordinator.js";
import {
  actionAuthorityConfigurationPath,
  writeActionAuthorityConfiguration,
  type ActionAuthorityBindingWriteInput,
} from "../authority/action-authority-config.js";
import type { AuthorityCandidateResolveInput } from "../authority/authority-candidate-port.js";
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
  /** Canonical private source for runtime action authority updates. */
  readonly actionAuthorityConfigPath?: string;
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
  currentProcessReadyAt?: string;
  pendingNonSpatialNativeIds: Set<string>;
  committedNonSpatialNativeIds: ReadonlySet<string>;
  subscriptionAbort?: AbortController;
  task?: Promise<void>;
}

export type HomeWorldOneShotActionInput = {
  readonly requestId: string;
  readonly hwCapabilityId: string;
  readonly signal: AbortSignal;
  readonly action:
    | { readonly kind: "set_boolean"; readonly value: boolean }
    | { readonly kind: "set_level"; readonly level: number }
    | { readonly kind: "play_media"; readonly mediaRef: string; readonly queueMode: "replace_and_play" | "play_next" | "add_to_queue" }
    | { readonly kind: "stop_media" };
};

export interface HomeWorldActionAuthorityPolicyInput {
  readonly directCapabilityIds: readonly string[];
  readonly confirmationCapabilityIds: readonly string[];
  readonly administratorCapabilityIds: readonly string[];
}

export type HomeWorldActionAuthorityPolicyResult =
  | { readonly status: "configured"; readonly configurationRevision: number }
  | { readonly status: "blocked"; readonly reason: HomeWorldActionAuthorityBlockReason };

export type HomeWorldActionAuthorityBlockReason =
  "configuration_source_unavailable" | "unknown_capability" | "ambiguous_bridge" | "write_failed";

/** Delta result: success always states the count; failure keeps the closed reason set. */
export type HomeWorldActionAuthorityDeltaResult =
  | { readonly status: "configured"; readonly configurationRevision: number; readonly changedCount: number }
  | { readonly status: "blocked"; readonly reason: HomeWorldActionAuthorityBlockReason };

export interface HomeWorldForeignRuleCatalog {
  readonly bridgeId: string;
  readonly status: "available" | "unavailable";
  readonly epochId?: string;
  readonly lastSeq?: number;
  readonly rules: readonly ForeignRuleSummary[];
}

export interface HomeWorldForeignRuleMigrationInput {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly lastSeq: number;
  readonly ruleRef: string;
  readonly signal: AbortSignal;
}

/** Hub-owned, provider-detail-free result for one read-only rule translation. */
export type HomeWorldForeignRuleMigrationResult =
  | {
    readonly status: "translated";
    readonly ruleRef: string;
    readonly sourceFingerprint: string;
    readonly title: string;
    readonly plan: ForeignRuleMigrationPlan;
  }
  | { readonly status: "unsupported"; readonly reason: ForeignRuleMigrationUnsupportedReason }
  | { readonly status: "unavailable" }
  | { readonly status: "stale_source" };

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
  /** Optional committed neutral hint; never inferred from names or capabilities. */
  spatialDisposition?: "non_spatial";
  validity: "valid" | "stale" | "invalid-source" | "present-but-invalid";
}

export interface HomeWorldBinding {
  readonly bridgeId: string;
  readonly nativeId: string;
  readonly nativeInstanceId: string;
  readonly hwSpaceId?: string;
}

export interface HomeWorldCapabilitySnapshot {
  readonly hwCapabilityId: string;
  readonly hwId: string;
  readonly schema: string;
  readonly schemaVersion: string;
  readonly semanticKind?: CapabilitySemanticKind;
  readonly bindings: readonly HomeWorldBinding[];
}

export type HomeWorldEvidenceCoverageReason =
  | "bridge_not_ready"
  | "missing_consistent_baseline"
  | "baseline_time_unknown"
  | "window_before_baseline"
  | "history_gap"
  | "journal_query_unavailable"
  | "selection_too_broad"
  | "query_truncated"
  | "merge_truncated";

export interface HomeWorldEvidenceQuery {
  readonly hwCapabilityIds: readonly string[];
  readonly lookbackHours: number;
  readonly limit?: number;
}

export interface HomeWorldEvidenceEvent {
  readonly hwId: string;
  readonly hwCapabilityId: string;
  readonly semanticKind?: CapabilitySemanticKind;
  readonly value: string | number | boolean | null;
  readonly observedAt: string;
  readonly sourceTs?: string;
  readonly sourceTsQuality: StateEvent["time"]["sourceTsQuality"];
  readonly origin: StateEvent["origin"];
  readonly provenance: { readonly bridgeId: string; readonly epochId: string; readonly seq: number };
}

export interface HomeWorldEvidenceCoverage {
  readonly bridgeId: string;
  readonly epochId?: string;
  readonly baselineSeq?: number;
  readonly baselineAt?: string;
  readonly status: "complete" | "partial" | "unavailable";
  readonly reasons: readonly HomeWorldEvidenceCoverageReason[];
}

export interface HomeWorldEvidenceResult {
  readonly requestedSince: string;
  readonly requestedUntil: string;
  readonly events: readonly HomeWorldEvidenceEvent[];
  readonly coverage: readonly HomeWorldEvidenceCoverage[];
  readonly truncated: boolean;
}

export interface HomeWorldActivityQuery {
  readonly lookbackHours: number;
  readonly limit?: number;
}

export interface HomeWorldActivityResult {
  readonly requestedSince: string;
  readonly requestedUntil: string;
  readonly devices: readonly {
    readonly hwId: string;
    readonly eventCount: number;
    readonly latestObservedAt: string;
    readonly semanticKinds: readonly CapabilitySemanticKind[];
  }[];
  readonly coverage: readonly HomeWorldEvidenceCoverage[];
  readonly truncated: boolean;
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
  /** Present only after this process accepts a live sync-complete. */
  currentProcessReadyAt?: string;
  /** Aggregate logical ingest quota; contains no event payloads or identities. */
  journalCapacity?: {
    readonly usedBytes: number;
    readonly maxBytes: number;
    readonly remainingBytes: number;
  };
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
  spaces: readonly WorldSpace[];
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
  private readonly actionAuthorityConfigPathValue: string | undefined;
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
    this.actionAuthorityConfigPathValue = options.actionAuthorityConfigPath
      ?? (options.journalDirectory !== undefined && isAbsolute(options.journalDirectory)
        ? actionAuthorityConfigurationPath(options.journalDirectory)
        : undefined);
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

  /** Metadata-only bridge enumeration for Hub-owned operational status seams. */
  bridgeIds(): readonly string[] {
    return [...this.runtimesById.keys()].sort();
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

  /** Reads metadata-only foreign rules; unsupported or invalid extensions fail closed. */
  async foreignRuleCatalog(): Promise<readonly HomeWorldForeignRuleCatalog[]> {
    const catalogs: HomeWorldForeignRuleCatalog[] = [];
    for (const runtime of [...this.runtimesById.values()].sort((left, right) => left.bridgeId.localeCompare(right.bridgeId))) {
      if (runtime.extensionAvailability["foreignRules@2"] !== "available") {
        catalogs.push({ bridgeId: runtime.bridgeId, status: "unavailable", rules: [] });
        continue;
      }
      try {
        const handle = runtime.adapter.extension("foreignRules@2");
        const parsed = foreignRuleCatalogSchema.safeParse(await handle?.catalog());
        if (!parsed.success) throw new Error("Invalid foreign rule catalog");
        if (!parsed.data.complete) throw new Error("Foreign rule catalog is incomplete");
        const watermark = runtime.journal.consistentWatermark?.(runtime.bridgeId);
        if (watermark?.epochId !== parsed.data.epochId || watermark.lastSeq !== parsed.data.lastSeq) {
          throw new Error("Foreign rule catalog is not committed");
        }
        catalogs.push({
          bridgeId: runtime.bridgeId,
          status: "available",
          epochId: parsed.data.epochId,
          lastSeq: parsed.data.lastSeq,
          rules: parsed.data.rules,
        });
      } catch {
        catalogs.push({ bridgeId: runtime.bridgeId, status: "unavailable", rules: [] });
      }
    }
    return catalogs;
  }

  /**
   * Reads and validates one foreign rule against a committed catalog fence,
   * then asks the negotiated migration extension for a neutral translation.
   * This seam never writes to a bridge and never returns provider-shaped data.
   */
  async translateForeignRule(
    input: HomeWorldForeignRuleMigrationInput,
  ): Promise<HomeWorldForeignRuleMigrationResult> {
    try {
      const request = parseHomeWorldForeignRuleMigrationInput(input);
      if (request === undefined || request.signal.aborted) return { status: "unavailable" };

      const runtime = this.runtimesById.get(request.bridgeId);
      if (!migrationRuntimeReady(runtime)) return { status: "unavailable" };

      const initialWatermark = committedMigrationWatermark(runtime);
      if (initialWatermark === undefined) return { status: "unavailable" };
      if (!migrationWatermarkMatches(initialWatermark, request)) return { status: "stale_source" };

      let catalog: ReturnType<typeof foreignRuleCatalogSchema.parse>;
      try {
        const handle = runtime.adapter.extension("foreignRules@2") as ForeignRulesHandle | undefined;
        if (handle === undefined || typeof handle.catalog !== "function") return { status: "unavailable" };
        const catalogRead = await awaitMigrationRead(
          () => handle.catalog(),
          request.signal,
        );
        if (catalogRead.status !== "fulfilled" || request.signal.aborted) return { status: "unavailable" };
        const parsed = foreignRuleCatalogSchema.safeParse(catalogRead.value);
        if (!parsed.success) return { status: "unavailable" };
        catalog = parsed.data;
      } catch {
        return { status: "unavailable" };
      }

      if (!catalog.complete) return { status: "unavailable" };
      if (catalog.epochId !== request.epochId || catalog.lastSeq !== request.lastSeq) {
        return { status: "stale_source" };
      }
      const matchingRules = catalog.rules.filter((rule) => rule.ruleRef === request.ruleRef);
      if (matchingRules.length === 0) return { status: "stale_source" };
      if (matchingRules.length !== 1) return { status: "unavailable" };

      const preTranslateWatermark = committedMigrationWatermark(runtime);
      if (preTranslateWatermark === undefined) return { status: "unavailable" };
      if (!migrationWatermarkMatches(preTranslateWatermark, request)) return { status: "stale_source" };
      if (request.signal.aborted || !migrationRuntimeReady(runtime)) return { status: "unavailable" };

      let translation: AwaitMigrationReadResult<unknown>;
      try {
        const handle = runtime.adapter.extension("foreignRuleMigration@1") as ForeignRuleMigrationHandle | undefined;
        if (handle === undefined || typeof handle.translate !== "function") return { status: "unavailable" };
        translation = await awaitMigrationRead(
          () => handle.translate(
            { ruleRef: request.ruleRef },
            { signal: request.signal },
          ),
          request.signal,
        );
      } catch {
        translation = { status: "rejected" };
      }

      const postTranslateWatermark = committedMigrationWatermark(runtime);
      if (postTranslateWatermark === undefined) return { status: "unavailable" };
      if (!migrationWatermarkMatches(postTranslateWatermark, request)) return { status: "stale_source" };
      if (request.signal.aborted || !migrationRuntimeReady(runtime)) return { status: "unavailable" };
      if (translation.status !== "fulfilled") return { status: "unavailable" };

      return normalizeHomeWorldForeignRuleMigrationResult(
        translation.value,
        request.ruleRef,
        request.bridgeId,
      );
    } catch {
      return { status: "unavailable" };
    }
  }

  /**
   * Projects bounded post-baseline state changes into hub identities. Bootstrap
   * rows never qualify, and raw attributes/native identifiers never leave this
   * service boundary.
   */
  queryRecentEvidence(input: HomeWorldEvidenceQuery): HomeWorldEvidenceResult {
    const limit = validateEvidenceQuery(input);
    const requestedUntil = this.clock();
    const requestedSince = new Date(Date.parse(requestedUntil) - input.lookbackHours * 60 * 60 * 1_000).toISOString();
    const snapshot = this.snapshot();
    const capabilities = new Map(snapshot.devices.flatMap((device) => device.capabilities)
      .map((capability) => [capability.hwCapabilityId, capability] as const));
    const selectedIds = [...new Set(input.hwCapabilityIds)];
    const selected = selectedIds.map((id) => capabilities.get(id));
    if (selected.some((capability) => capability === undefined)) {
      throw new TypeError("home evidence selection contains an unavailable capability");
    }
    const groups = new Map<string, {
      bindings: HomeWorldBinding[];
      capabilitiesByBinding: Map<string, HomeWorldCapabilitySnapshot>;
    }>();
    for (const capability of selected as HomeWorldCapabilitySnapshot[]) {
      for (const binding of capability.bindings) {
        const group: {
          bindings: HomeWorldBinding[];
          capabilitiesByBinding: Map<string, HomeWorldCapabilitySnapshot>;
        } = groups.get(binding.bridgeId) ?? {
          bindings: [],
          capabilitiesByBinding: new Map<string, HomeWorldCapabilitySnapshot>(),
        };
        const key = evidenceBindingKey(binding.nativeId, binding.nativeInstanceId);
        if (!group.capabilitiesByBinding.has(key)) group.bindings.push(binding);
        group.capabilitiesByBinding.set(key, capability);
        groups.set(binding.bridgeId, group);
      }
    }

    const events: HomeWorldEvidenceEvent[] = [];
    let coverage: HomeWorldEvidenceCoverage[] = [];
    let truncated = false;
    for (const bridgeId of [...groups.keys()].sort((left, right) => left.localeCompare(right))) {
      const group = groups.get(bridgeId)!;
      const runtime = this.runtimesById.get(bridgeId);
      const watermark = runtime?.journal.consistentWatermark?.(bridgeId);
      const baselineAt = runtime?.ingest.diagnostics().lastSyncCompleteAt;
      const reasons: HomeWorldEvidenceCoverageReason[] = [];
      if (runtime === undefined || watermark === undefined) {
        coverage.push({ bridgeId, status: "unavailable", reasons: ["missing_consistent_baseline"] });
        continue;
      }
      if (runtime.ingest.diagnostics().connectionState !== "ready") reasons.push("bridge_not_ready");
      if (baselineAt === undefined) reasons.push("baseline_time_unknown");
      else if (Date.parse(requestedSince) < Date.parse(baselineAt)) reasons.push("window_before_baseline");
      if (runtime.journal.historyGaps(bridgeId).some((gap) => (
        gap.epochId === watermark.epochId && gap.toSeq > watermark.lastSeq
      ))) reasons.push("history_gap");
      if (group.bindings.length > 50) {
        reasons.push("selection_too_broad");
      } else if (runtime.journal.queryLiveStateRecords === undefined) {
        reasons.push("journal_query_unavailable");
      } else {
        try {
          const page = runtime.journal.queryLiveStateRecords({
            bridgeId,
            epochId: watermark.epochId,
            afterSeq: watermark.lastSeq,
            since: requestedSince,
            until: requestedUntil,
            bindings: group.bindings,
            limit,
          });
          if (page.truncated) {
            reasons.push("query_truncated");
            truncated = true;
          }
          for (const record of page.records) {
            if (record.envelope.event.kind !== "state") continue;
            const state = record.envelope.event.state;
            const value = evidenceScalar(state.attrs.state);
            if (value === undefined) continue;
            const capability = group.capabilitiesByBinding.get(evidenceBindingKey(
              state.nativeId,
              state.nativeInstanceId,
            ));
            if (capability === undefined) continue;
            events.push({
              hwId: capability.hwId,
              hwCapabilityId: capability.hwCapabilityId,
              ...(capability.semanticKind === undefined ? {} : { semanticKind: capability.semanticKind }),
              value,
              observedAt: record.receivedAt,
              ...(state.time.sourceTs === undefined ? {} : { sourceTs: state.time.sourceTs }),
              sourceTsQuality: state.time.sourceTsQuality,
              origin: state.origin,
              provenance: {
                bridgeId,
                epochId: record.envelope.epochId,
                seq: record.envelope.seq,
              },
            });
          }
        } catch {
          reasons.push("journal_query_unavailable");
        }
      }
      coverage.push({
        bridgeId,
        epochId: watermark.epochId,
        baselineSeq: watermark.lastSeq,
        ...(baselineAt === undefined ? {} : { baselineAt }),
        status: reasons.length === 0 ? "complete" : "partial",
        reasons,
      });
    }
    events.sort((left, right) => left.observedAt.localeCompare(right.observedAt)
      || left.provenance.bridgeId.localeCompare(right.provenance.bridgeId)
      || left.provenance.seq - right.provenance.seq);
    if (events.length > limit) {
      events.splice(0, events.length - limit);
      truncated = true;
      coverage = coverage.map((item) => item.status === "unavailable" || item.reasons.includes("merge_truncated")
        ? item
        : { ...item, status: "partial", reasons: [...item.reasons, "merge_truncated"] });
    }
    return { requestedSince, requestedUntil, events, coverage, truncated };
  }

  /** Returns metadata-only post-baseline activity for candidate discovery. */
  queryRecentActivity(input: HomeWorldActivityQuery): HomeWorldActivityResult {
    const limit = validateActivityQuery(input);
    const requestedUntil = this.clock();
    const requestedSince = new Date(Date.parse(requestedUntil) - input.lookbackHours * 60 * 60 * 1_000).toISOString();
    const snapshot = this.snapshot();
    const capabilitiesByBinding = new Map<string, HomeWorldCapabilitySnapshot>();
    for (const device of snapshot.devices) {
      for (const capability of device.capabilities) {
        for (const binding of capability.bindings) {
          capabilitiesByBinding.set(activityBindingKey(
            binding.bridgeId,
            binding.nativeId,
            binding.nativeInstanceId,
          ), capability);
        }
      }
    }
    const aggregates = new Map<string, {
      hwId: string;
      eventCount: number;
      latestObservedAt: string;
      semanticKinds: Set<CapabilitySemanticKind>;
    }>();
    let truncated = false;
    let coverage: HomeWorldEvidenceCoverage[] = [];
    for (const runtime of [...this.runtimesById.values()].sort((left, right) => left.bridgeId.localeCompare(right.bridgeId))) {
      const bridgeId = runtime.bridgeId;
      const watermark = runtime.journal.consistentWatermark?.(bridgeId);
      const baselineAt = runtime.ingest.diagnostics().lastSyncCompleteAt;
      const reasons: HomeWorldEvidenceCoverageReason[] = [];
      if (watermark === undefined) {
        coverage.push({ bridgeId, status: "unavailable", reasons: ["missing_consistent_baseline"] });
        continue;
      }
      if (runtime.ingest.diagnostics().connectionState !== "ready") reasons.push("bridge_not_ready");
      if (baselineAt === undefined) reasons.push("baseline_time_unknown");
      else if (Date.parse(requestedSince) < Date.parse(baselineAt)) reasons.push("window_before_baseline");
      if (runtime.journal.historyGaps(bridgeId).some((gap) => (
        gap.epochId === watermark.epochId && gap.toSeq > watermark.lastSeq
      ))) reasons.push("history_gap");
      if (runtime.journal.queryLiveStateActivity === undefined) {
        reasons.push("journal_query_unavailable");
      } else {
        try {
          const page = runtime.journal.queryLiveStateActivity({
            bridgeId,
            epochId: watermark.epochId,
            afterSeq: watermark.lastSeq,
            since: requestedSince,
            until: requestedUntil,
            limit,
          });
          if (page.truncated) {
            reasons.push("query_truncated");
            truncated = true;
          }
          for (const item of page.activity) {
            const capabilities = item.nativeInstanceIds.flatMap((nativeInstanceId) => {
              const capability = capabilitiesByBinding.get(activityBindingKey(
                bridgeId,
                item.nativeId,
                nativeInstanceId,
              ));
              return capability === undefined ? [] : [capability];
            });
            const hwIds = new Set(capabilities.map((capability) => capability.hwId));
            if (hwIds.size !== 1) continue;
            const hwId = [...hwIds][0]!;
            const aggregate = aggregates.get(hwId) ?? {
              hwId,
              eventCount: 0,
              latestObservedAt: item.latestObservedAt,
              semanticKinds: new Set<CapabilitySemanticKind>(),
            };
            aggregate.eventCount += item.eventCount;
            if (item.latestObservedAt > aggregate.latestObservedAt) {
              aggregate.latestObservedAt = item.latestObservedAt;
            }
            for (const capability of capabilities) {
              if (capability.semanticKind !== undefined) aggregate.semanticKinds.add(capability.semanticKind);
            }
            aggregates.set(hwId, aggregate);
          }
        } catch {
          reasons.push("journal_query_unavailable");
        }
      }
      coverage.push({
        bridgeId,
        epochId: watermark.epochId,
        baselineSeq: watermark.lastSeq,
        ...(baselineAt === undefined ? {} : { baselineAt }),
        status: reasons.length === 0 ? "complete" : "partial",
        reasons,
      });
    }
    const devices = [...aggregates.values()]
      .sort((left, right) => right.eventCount - left.eventCount
        || right.latestObservedAt.localeCompare(left.latestObservedAt)
        || left.hwId.localeCompare(right.hwId))
      .map((item) => ({
        hwId: item.hwId,
        eventCount: item.eventCount,
        latestObservedAt: item.latestObservedAt,
        semanticKinds: [...item.semanticKinds].sort(compareStrings),
      }));
    if (devices.length > limit) {
      devices.splice(limit);
      truncated = true;
      coverage = coverage.map((item) => item.status === "unavailable" || item.reasons.includes("merge_truncated")
        ? item
        : { ...item, status: "partial", reasons: [...item.reasons, "merge_truncated"] });
    }
    return { requestedSince, requestedUntil, devices, coverage, truncated };
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
      const bridgeDevices = applyCommittedOrgHints(runtime, worldDevices(
        runtime.bridgeId,
        runtime.ingest.worldSnapshot(),
        this.identityByDevice,
        (nativeId) => runtime.ingest.deviceHealth(nativeId),
      ));
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
      const journalCapacity = runtime.journal.capacity?.();
      diagnosticsList.push({
        bridgeId: runtime.bridgeId,
        ...diagnostics,
        ...(runtime.currentProcessReadyAt === undefined ? {} : { currentProcessReadyAt: runtime.currentProcessReadyAt }),
        ...(journalCapacity === undefined ? {} : { journalCapacity }),
      });
      if (watermark !== null) bridgeWatermarks.push(watermark);
      devices.push(...bridgeDevices);
    }
    diagnosticsList.sort((left, right) => left.bridgeId.localeCompare(right.bridgeId));
    bridgeWatermarks.sort((left, right) => left.bridgeId.localeCompare(right.bridgeId));
    const aggregatedDevices = aggregateWorldDevices(devices, this.authority);
    const activeSpaceIds = new Set(aggregatedDevices.flatMap((device) => device.capabilities)
      .flatMap((capability) => capability.bindings)
      .flatMap((binding) => binding.hwSpaceId === undefined ? [] : [binding.hwSpaceId]));
    return {
      generatedAt: this.clock(),
      bridges,
      watermarkVector,
      bridgeWatermarks,
      watermarks: bridgeWatermarks,
      diagnostics: diagnosticsList,
      metrics: metricSummary(diagnosticsList),
      spaces: this.identity.listWorldSpaces().filter((space) => activeSpaceIds.has(space.hwSpaceId)),
      devices: aggregatedDevices,
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

  /**
   * Resolves the adapter's concrete next action for one exact, authoritative
   * capability binding.  The Hub supplies current neutral state and accepts a
   * descriptor only from a negotiated live actions extension. Every ambiguity,
   * stale world row, unavailable bridge, or invalid adapter descriptor yields
   * a read-only result.
   */
  /**
   * The deployment target is decided by the plan's own capability bindings,
   * never by bridge registration order. Every referenced capability must bind
   * to exactly one bridge, all to the same one, and that bridge must be ready
   * with a live automations extension. Cross-bridge plans yield no deployment
   * path — the neutral seam stays open for any execution domain, including a
   * future hub-native automation engine, but Phase 0 never splits one plan.
   */
  automationBridgeForTargets(hwCapabilityIds: readonly string[]): {
    readonly bridgeId: string;
    readonly automations: AutomationsExtension;
    resolveTarget(hwCapabilityId: string): BridgeActionTarget | undefined;
  } | undefined {
    const deviceCapabilityIds = hwCapabilityIds.filter((id) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id));
    if (deviceCapabilityIds.length === 0 || deviceCapabilityIds.length !== hwCapabilityIds.length) return undefined;
    let targetBridgeId: string | undefined;
    for (const hwCapabilityId of deviceCapabilityIds) {
      const bindings = this.authority.capability(hwCapabilityId)?.bindings ?? [];
      const bridgeIds = new Set(bindings.map((binding) => binding.bridgeId));
      if (bridgeIds.size !== 1) return undefined;
      const [bridgeId] = bridgeIds;
      if (targetBridgeId === undefined) targetBridgeId = bridgeId;
      else if (targetBridgeId !== bridgeId) return undefined;
    }
    if (targetBridgeId === undefined) return undefined;
    const handle = this.liveAutomationsHandle(targetBridgeId);
    if (handle === undefined) return undefined;
    const bridgeId = targetBridgeId;
    return { bridgeId, automations: handle, resolveTarget: this.automationTargetResolver(bridgeId) };
  }

  /** Control and reconciliation address the bridge a deployment was recorded on. */
  automationsHandleFor(bridgeId: string): AutomationsExtension | undefined {
    return typeof bridgeId === "string" && bridgeId.length > 0 ? this.liveAutomationsHandle(bridgeId) : undefined;
  }

  /** Returns the Hub-owned foreign-rule control handle only for a bounded, ready bridge. */
  foreignRuleControlFor(bridgeId: string): ForeignRuleControlHandle | undefined {
    return boundedMigrationText(bridgeId, 256) ? this.liveForeignRuleControlHandle(bridgeId) : undefined;
  }

  /**
   * The household-facing name behind a capability, for gate disclosure:
   * the device name first, then the stable semantic label. A capability
   * without either cannot be disclosed and cannot enter an automation.
   */
  capabilityDeviceName(hwCapabilityId: string): string | undefined {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(hwCapabilityId)) return undefined;
    const hwId = this.authority.capability(hwCapabilityId)?.hwId;
    if (hwId === undefined) return undefined;
    const device = this.snapshot().devices.find((candidate) => candidate.hwId === hwId);
    if (device === undefined) return undefined;
    if (device.name !== undefined) return device.name;
    const capability = device.capabilities.find((candidate) => candidate.hwCapabilityId === hwCapabilityId);
    return householdCapabilityLabel(capability?.semanticKind);
  }

  /** Deploy against a recorded intent: the same bridge, the same resolution rules. */
  automationBridgeById(bridgeId: string): {
    readonly bridgeId: string;
    readonly automations: AutomationsExtension;
    resolveTarget(hwCapabilityId: string): BridgeActionTarget | undefined;
  } | undefined {
    if (typeof bridgeId !== "string" || bridgeId.length === 0) return undefined;
    const handle = this.liveAutomationsHandle(bridgeId);
    if (handle === undefined) return undefined;
    return { bridgeId, automations: handle, resolveTarget: this.automationTargetResolver(bridgeId) };
  }

  /**
   * Resolves one bridge-local migration binding against both authority and the
   * current runtime snapshot. The returned target contains only neutral Hub
   * identity and a fresh copy of the exact binding; provider-shaped fields
   * never cross this boundary.
   */
  resolveBridgeActionTargetForBinding(input: unknown): BridgeActionTarget | undefined {
    const binding = parseForeignRuleMigrationBinding(input);
    if (binding === undefined) return undefined;
    const runtime = this.runtimesById.get(binding.bridgeId);
    if (runtime === undefined || runtime.ingest.diagnostics().connectionState !== "ready") return undefined;

    const matches = this.authority.capabilitiesSnapshot().flatMap((capability) => capability.bindings
      .filter((candidate) => exactBinding(candidate, binding))
      .map(() => capability.hwCapabilityId));
    const capabilityIds = [...new Set(matches)];
    if (capabilityIds.length !== 1) return undefined;
    const hwCapabilityId = capabilityIds[0];
    if (hwCapabilityId === undefined) return undefined;

    const device = runtime.ingest.worldSnapshot().get(binding.nativeId);
    if (device === undefined
      || device.validity !== "valid"
      || device.descriptor.nativeId !== binding.nativeId
      || !device.descriptor.capabilities.some((capability) => capability.nativeInstanceId === binding.nativeInstanceId)) {
      return undefined;
    }
    return {
      hwCapabilityId,
      binding: {
        bridgeId: binding.bridgeId,
        nativeId: binding.nativeId,
        nativeInstanceId: binding.nativeInstanceId,
      },
    };
  }

  private automationTargetResolver(bridgeId: string): (hwCapabilityId: string) => BridgeActionTarget | undefined {
    return (hwCapabilityId: string): BridgeActionTarget | undefined => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(hwCapabilityId)) return undefined;
      const bindings = this.authority.capability(hwCapabilityId)?.bindings.filter((binding) => binding.bridgeId === bridgeId) ?? [];
      if (bindings.length !== 1) return undefined;
      const [binding] = bindings;
      if (binding === undefined) return undefined;
      return {
        hwCapabilityId,
        binding: {
          bridgeId: binding.bridgeId,
          nativeId: binding.nativeId,
          nativeInstanceId: binding.nativeInstanceId,
        },
      };
    };
  }

  private liveAutomationsHandle(bridgeId: string): AutomationsExtension | undefined {
    const runtime = this.runtimesById.get(bridgeId);
    if (runtime === undefined
      || runtime.extensionAvailability["automations@1"] !== "available"
      || runtime.ingest.diagnostics().connectionState !== "ready") return undefined;
    let handle: AutomationsExtension | undefined;
    try {
      handle = runtime.adapter.extension("automations@1") as AutomationsExtension | undefined;
    } catch {
      return undefined;
    }
    return handle !== undefined && typeof handle.deploy === "function" ? handle : undefined;
  }

  private liveForeignRuleControlHandle(bridgeId: string): ForeignRuleControlHandle | undefined {
    const runtime = this.runtimesById.get(bridgeId);
    if (runtime === undefined
      || runtime.extensionAvailability["foreignRuleControl@1"] !== "available"
      || runtime.ingest.diagnostics().connectionState !== "ready") return undefined;
    try {
      const handle = runtime.adapter.extension("foreignRuleControl@1") as ForeignRuleControlHandle | undefined;
      return handle !== undefined
        && typeof handle.status === "function"
        && typeof handle.setEnabled === "function"
        ? handle
        : undefined;
    } catch {
      return undefined;
    }
  }

  actionDescriptorFor(hwCapabilityId: string): BridgeActionDescriptor | undefined {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(hwCapabilityId)) return undefined;
    this.refreshIdentity();
    const authority = this.authority.resolveActionAuthority(
      hwCapabilityId,
      this.authorityAvailability(hwCapabilityId),
    );
    if (authority.status !== "available" || authority.bridgeId === undefined) return undefined;
    const capability = this.authority.capability(hwCapabilityId);
    const bindings = capability?.bindings.filter((binding) => binding.bridgeId === authority.bridgeId) ?? [];
    if (bindings.length !== 1) return undefined;
    const [binding] = bindings;
    if (binding === undefined) return undefined;
    const runtime = this.runtimesById.get(authority.bridgeId);
    if (runtime === undefined
      || runtime.extensionAvailability["actions@1"] !== "available"
      || runtime.ingest.diagnostics().connectionState !== "ready"
      || runtime.journal.consistentWatermark?.(authority.bridgeId) === undefined) return undefined;
    const deviceHealth = runtime.ingest.deviceHealth(binding.nativeId);
    if (deviceHealth !== undefined && deviceHealth !== "reachable") return undefined;
    const device = runtime.ingest.worldSnapshot().get(binding.nativeId);
    if (device === undefined || device.validity !== "valid") return undefined;
    const state = device.states.get(binding.nativeInstanceId);
    if (state === undefined) return undefined;
    const current = actionCurrentState(state.attrs);
    if (current === undefined || !actionStateIsKnown(current)) return undefined;
    let handle: ActionsExtension | undefined;
    try {
      handle = runtime.adapter.extension("actions@1") as ActionsExtension | undefined;
    } catch {
      return undefined;
    }
    if (handle === undefined || typeof handle.describe !== "function") return undefined;
    const request = bridgeActionDescriptorRequestSchema.safeParse({
      target: {
        hwCapabilityId,
        binding: {
          bridgeId: binding.bridgeId,
          nativeId: binding.nativeId,
          nativeInstanceId: binding.nativeInstanceId,
        },
      },
      current,
    });
    if (!request.success) return undefined;
    try {
      const descriptor = handle.describe(request.data);
      const parsed = bridgeActionDescriptorSchema.safeParse(descriptor);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Commits the onboarding-selected policy classes to the canonical private
   * source and updates the running AuthorityCoordinator only after the rename
   * succeeds. Capability-to-bridge ambiguity fails closed.
   */
  configureActionAuthority(
    input: HomeWorldActionAuthorityPolicyInput,
  ): HomeWorldActionAuthorityPolicyResult {
    if (this.actionAuthorityConfigPathValue === undefined) {
      return { status: "blocked", reason: "configuration_source_unavailable" };
    }
    this.refreshIdentity();
    const entries: ActionAuthorityBindingWriteInput[] = [];
    const selected = [
      ...input.directCapabilityIds.map((hwCapabilityId) => ({ hwCapabilityId, policyClass: "direct" as const })),
      ...input.confirmationCapabilityIds.map((hwCapabilityId) => ({ hwCapabilityId, policyClass: "confirmation" as const })),
      ...input.administratorCapabilityIds.map((hwCapabilityId) => ({ hwCapabilityId, policyClass: "administrator" as const })),
    ];
    const seen = new Set<string>();
    for (const item of selected) {
      if (seen.has(item.hwCapabilityId)) return { status: "blocked", reason: "unknown_capability" };
      seen.add(item.hwCapabilityId);
      const capability = this.authority.capability(item.hwCapabilityId);
      if (capability === undefined) return { status: "blocked", reason: "unknown_capability" };
      const bridgeIds = [...new Set(capability.bindings.map((binding) => binding.bridgeId))];
      if (bridgeIds.length !== 1 || bridgeIds[0] === undefined) return { status: "blocked", reason: "ambiguous_bridge" };
      const existing = this.authority.resolveActionAuthorityConfiguration(item.hwCapabilityId);
      const revision = existing.status === "configured" && existing.configRevision !== undefined
        ? existing.configRevision + 1
        : 1;
      entries.push({
        hwCapabilityId: item.hwCapabilityId,
        bridgeId: bridgeIds[0],
        approved: true,
        policyClass: item.policyClass,
        revision,
      });
    }
    try {
      const projection = writeActionAuthorityConfiguration(this.actionAuthorityConfigPathValue, entries);
      this.authority.replaceActionAuthorityConfig(projection);
      const revisions = Object.values(projection).map((entry) => entry.configRevision);
      return { status: "configured", configurationRevision: revisions.length === 0 ? 0 : Math.max(...revisions) };
    } catch {
      return { status: "blocked", reason: "write_failed" };
    }
  }

  /**
   * Delta write over the persisted configuration: the submitted rows change,
   * every other persisted entry — bridge down, authorization revoked, device
   * momentarily out of the snapshot — survives byte-for-byte semantics and
   * the whole set writes back atomically. A selected row re-approves
   * deliberately; nothing else touches the approved flag.
   */
  configureActionAuthorityDelta(
    changes: readonly { readonly hwCapabilityId: string; readonly policyClass: "direct" | "confirmation" | "administrator" }[],
  ): HomeWorldActionAuthorityDeltaResult {
    if (this.actionAuthorityConfigPathValue === undefined) {
      return { status: "blocked", reason: "configuration_source_unavailable" };
    }
    this.refreshIdentity();
    const merged = new Map<string, ActionAuthorityBindingWriteInput>();
    for (const existing of this.authority.actionAuthorityConfigurationEntries()) {
      merged.set(existing.hwCapabilityId, {
        hwCapabilityId: existing.hwCapabilityId,
        bridgeId: existing.bridgeId,
        approved: existing.approved,
        policyClass: existing.policyClass,
        revision: existing.revision,
      });
    }
    const seen = new Set<string>();
    let changedCount = 0;
    for (const change of changes) {
      if (seen.has(change.hwCapabilityId)) return { status: "blocked", reason: "unknown_capability" };
      seen.add(change.hwCapabilityId);
      const existing = merged.get(change.hwCapabilityId);
      // A row already enabled with the same class is a re-statement, not a
      // change: the original entry survives byte-for-byte — bridge, revision
      // and identity untouched — so a form echoing what it displayed can
      // never rebind, re-approve, or invalidate anything.
      if (existing !== undefined && existing.approved && existing.policyClass === change.policyClass) continue;
      const capability = this.authority.capability(change.hwCapabilityId);
      if (capability === undefined) return { status: "blocked", reason: "unknown_capability" };
      const bridgeIds = [...new Set(capability.bindings.map((binding) => binding.bridgeId))];
      if (bridgeIds.length !== 1 || bridgeIds[0] === undefined) return { status: "blocked", reason: "ambiguous_bridge" };
      merged.set(change.hwCapabilityId, {
        hwCapabilityId: change.hwCapabilityId,
        bridgeId: bridgeIds[0],
        approved: true,
        policyClass: change.policyClass,
        revision: (existing?.revision ?? 0) + 1,
      });
      changedCount += 1;
    }
    if (changedCount === 0) {
      // Nothing changed: no write, no revision bump, no invalidation.
      const revisions = this.authority.actionAuthorityConfigurationEntries().map((entry) => entry.revision);
      return { status: "configured", configurationRevision: revisions.length === 0 ? 0 : Math.max(...revisions), changedCount: 0 };
    }
    try {
      const projection = writeActionAuthorityConfiguration(this.actionAuthorityConfigPathValue, [...merged.values()]);
      this.authority.replaceActionAuthorityConfig(projection);
      const revisions = Object.values(projection).map((entry) => entry.configRevision);
      return { status: "configured", configurationRevision: revisions.length === 0 ? 0 : Math.max(...revisions), changedCount };
    } catch {
      return { status: "blocked", reason: "write_failed" };
    }
  }

  /** Persisted configuration state for one capability — settings truth. */
  actionAuthorityConfigurationOf(hwCapabilityId: string): ActionAuthorityConfigurationResolution {
    return this.authority.resolveActionAuthorityConfiguration(hwCapabilityId);
  }

  async executeOneShotAction(input: HomeWorldOneShotActionInput): Promise<BridgeActionResult> {
    if (input.signal.aborted) return { status: "unknown", reason: "cancelled" };
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.requestId)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.hwCapabilityId)) {
      return { status: "rejected", reason: "invalid_target" };
    }
    const descriptor = this.actionDescriptorFor(input.hwCapabilityId);
    if (descriptor === undefined || !sameActionIntent(descriptor.action, input.action)) {
      return { status: "rejected", reason: "invalid_target" };
    }
    this.refreshIdentity();
    const authority = this.authority.resolveActionAuthority(
      input.hwCapabilityId,
      this.authorityAvailability(input.hwCapabilityId),
    );
    if (authority.status !== "available" || authority.bridgeId === undefined) {
      return { status: "rejected", reason: "unavailable" };
    }
    const capability = this.authority.capability(input.hwCapabilityId);
    const bindings = capability?.bindings.filter((binding) => binding.bridgeId === authority.bridgeId) ?? [];
    if (bindings.length !== 1) return { status: "rejected", reason: "invalid_target" };
    const [binding] = bindings;
    const runtime = this.runtimesById.get(authority.bridgeId);
    if (binding === undefined || runtime?.extensionAvailability["actions@1"] !== "available") {
      return { status: "rejected", reason: "unavailable" };
    }
    let handle: ActionsExtension | undefined;
    try {
      handle = runtime.adapter.extension("actions@1") as ActionsExtension | undefined;
    } catch {
      return { status: "rejected", reason: "unavailable" };
    }
    if (handle === undefined) return { status: "rejected", reason: "unavailable" };
    const request = {
      requestId: input.requestId,
      action: {
        ...input.action,
        target: {
          hwCapabilityId: input.hwCapabilityId,
          binding: {
            bridgeId: binding.bridgeId,
            nativeId: binding.nativeId,
            nativeInstanceId: binding.nativeInstanceId,
          },
        },
      },
    };
    try {
      const result = await handle.execute(request, { signal: input.signal });
      const parsed = bridgeActionResultSchema.safeParse(result);
      return parsed.success ? parsed.data : { status: "unknown", reason: "upstream_unavailable" };
    } catch {
      return input.signal.aborted
        ? { status: "unknown", reason: "cancelled" }
        : { status: "unknown", reason: "upstream_unavailable" };
    }
  }

  /**
   * Hub-private input seam for authority assessment. The projection contains
   * only Hub capability facts and opaque digests; unresolved route, identity,
   * and registration state fail closed instead of becoming a placeholder.
   */
  resolveAuthorityCandidateInput(hwCapabilityId: string): AuthorityCandidateResolveInput | undefined {
    this.refreshIdentity();
    const capability = this.authority.capability(hwCapabilityId);
    if (capability === undefined) return undefined;

    const configuration = this.authority.resolveActionAuthorityConfiguration(hwCapabilityId);
    if (configuration.status === "not_configured") {
      return Object.freeze({
        hwCapabilityId,
        knownCapability: true,
        configured: false,
        approved: false,
        available: false,
      });
    }
    if (configuration.status !== "configured"
      || configuration.configIdentity === undefined
      || configuration.configRevision === undefined) return undefined;

    const selectedBindings = capability.bindings.filter((binding) => (
      this.authority.isActionAuthorityConfiguredForBridge(hwCapabilityId, binding.bridgeId)
    ));
    if (selectedBindings.length !== 1 || this.registry === undefined) return undefined;
    const [selectedBinding] = selectedBindings;
    if (selectedBinding === undefined) return undefined;
    const runtime = this.runtimesById.get(selectedBinding.bridgeId);
    let descriptorRef: DeviceDescriptor["capabilities"][number] | undefined;
    try {
      const device = runtime?.ingest.worldSnapshot().get(selectedBinding.nativeId);
      const refs = device?.descriptor.capabilities.filter((ref) => (
        ref.nativeInstanceId === selectedBinding.nativeInstanceId
      ));
      if (refs === undefined || refs.length !== 1) return undefined;
      [descriptorRef] = refs;
    } catch {
      return undefined;
    }
    if (descriptorRef === undefined
      || descriptorRef.schema !== capability.schema
      || typeof descriptorRef.schemaVersion !== "string"
      || descriptorRef.schemaVersion.length === 0) return undefined;
    const registration = this.registry.binding(selectedBinding.bridgeId);
    if (registration === undefined
      || registration.remoteInstanceId === undefined
      || !Number.isSafeInteger(registration.generation)
      || registration.generation < 1) return undefined;

    const availability = this.authorityAvailability(hwCapabilityId)
      .find((candidate) => candidate.bridgeId === selectedBinding.bridgeId);
    return Object.freeze({
      hwCapabilityId,
      knownCapability: true,
      configured: true,
      approved: configuration.approved,
      available: configuration.approved
        && availability?.available === true
        && availability.validity === "valid",
      bindingIdentity: authorityDigest("authority-binding-v1", {
        adapterType: registration.adapterType,
        bridgeId: selectedBinding.bridgeId,
        nativeId: selectedBinding.nativeId,
        nativeInstanceId: selectedBinding.nativeInstanceId,
        schema: descriptorRef.schema,
        schemaVersion: descriptorRef.schemaVersion,
        hwSpaceId: selectedBinding.hwSpaceId ?? null,
        remoteBound: registration.remoteInstanceId !== undefined,
        remoteInstanceId: registration.remoteInstanceId,
        registrationGeneration: registration.generation,
      }),
      configurationIdentity: authorityDigest("authority-configuration-v1", {
        configIdentity: configuration.configIdentity,
        configRevision: configuration.configRevision,
      }),
      registrationGeneration: registration.generation,
    });
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
      const extensions = negotiateExtensions(adapter, registeredExtensionSchemas(this.options.extensionSchemas));
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
        extensionSchemas: registeredExtensionSchemas(this.options.extensionSchemas),
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
        pendingNonSpatialNativeIds: new Set(),
        committedNonSpatialNativeIds: readCommittedOrgHints(journal, entry.bridgeId, consistentWatermark?.epochId),
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
          if (result.accepted) {
            if (envelope.event.kind === "sync-start") runtime.pendingNonSpatialNativeIds.clear();
            if (envelope.event.kind === "ext" && envelope.event.ext === "orgHints@1") {
              const parsed = orgHintPayloadSchema.safeParse(envelope.event.payload);
              if (parsed.success) runtime.pendingNonSpatialNativeIds.add(parsed.data.nativeId);
            }
            if (envelope.event.kind === "sync-complete") {
              runtime.committedNonSpatialNativeIds = new Set(runtime.pendingNonSpatialNativeIds);
              this.materializeWorldModel(runtime);
              runtime.currentProcessReadyAt = this.clock();
            }
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
        const extensions = negotiateExtensions(next, registeredExtensionSchemas(this.options.extensionSchemas));
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

function sameActionIntent(
  expected: BridgeActionDescriptor["action"],
  received: BridgeActionDescriptor["action"],
): boolean {
  if (expected.kind !== received.kind) return false;
  if (expected.kind === "set_boolean" && received.kind === "set_boolean") return expected.value === received.value;
  if (expected.kind === "set_level" && received.kind === "set_level") return expected.level === received.level;
  if (expected.kind === "play_media" && received.kind === "play_media") {
    return expected.mediaRef === received.mediaRef && expected.queueMode === received.queueMode;
  }
  return expected.kind === "stop_media" && received.kind === "stop_media";
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

function negotiateExtensions(
  adapter: BridgeAdapter,
  streamSchemas: ReadonlyMap<string, ZodType<unknown>>,
): {
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
    const streamUsable = streamSchemas.has(key);
    let usable = streamUsable;
    try {
      if (typeof adapter.extension === "function") {
        const handle = adapter.extension(key as never);
        usable ||= handle !== undefined && handle !== null;
      }
    } catch {
      usable = streamUsable;
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
        ...(ref?.semanticKind === undefined ? {} : { semanticKind: ref.semanticKind }),
        bindings: capability.bindings.map((item) => ({ ...item })),
      } satisfies HomeWorldCapabilitySnapshot;
    }) ?? device.descriptor.capabilities.map((ref, index) => ({
      hwCapabilityId: `${hwId}:capability:${index}`,
      hwId,
      schema: ref.schema,
      schemaVersion: ref.schemaVersion,
      ...(ref.semanticKind === undefined ? {} : { semanticKind: ref.semanticKind }),
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
    const { spatialDisposition: _existingSpatialDisposition, ...existingWithoutSpatialDisposition } = existing;
    const spatialDisposition = existing.spatialDisposition === "non_spatial"
      && device.spatialDisposition === "non_spatial"
      && bindings.every((binding) => binding.hwSpaceId === undefined)
      ? "non_spatial" as const
      : undefined;
    grouped.set(device.hwId, {
      ...existingWithoutSpatialDisposition,
      bindings,
      capabilities: [...capabilityById.values()].sort((left, right) => compareStrings(left.hwCapabilityId, right.hwCapabilityId)),
      states: [...stateByKey.values()].map((state) => cloneJson(state)),
      ...(spatialDisposition === undefined ? {} : { spatialDisposition }),
      validity: existing.validity === "valid" || device.validity === "valid" ? "valid" : existing.validity,
    });
  }

  return [...grouped.values()]
    .map((device) => ({ ...device, states: selectAuthorityStates(device, authority) }))
    .sort((left, right) => compareStrings(left.hwId, right.hwId));
}

function registeredExtensionSchemas(
  configured: ReadonlyMap<string, ZodType<unknown>> | undefined,
): ReadonlyMap<string, ZodType<unknown>> {
  return new Map([
    ...(configured?.entries() ?? []),
    ["orgHints@1", orgHintPayloadSchema] as const,
  ]);
}

function applyCommittedOrgHints(
  runtime: HomeWorldBridgeRuntime,
  devices: readonly HomeWorldDeviceSnapshot[],
): HomeWorldDeviceSnapshot[] {
  if (runtime.extensionAvailability["orgHints@1"] !== "available") {
    return [...devices];
  }
  return devices.map((device) => runtime.committedNonSpatialNativeIds.has(device.nativeId)
    && device.bindings.every((binding) => binding.hwSpaceId === undefined)
    ? { ...device, spatialDisposition: "non_spatial" }
    : device);
}

function parseForeignRuleMigrationBinding(input: unknown): ForeignRuleMigrationBinding | undefined {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
    const value = input as Record<string, unknown>;
    const raw = {
      bridgeId: value.bridgeId,
      nativeId: value.nativeId,
      nativeInstanceId: value.nativeInstanceId,
    };
    if (Object.values(raw).some((item) => typeof item !== "string" || item !== item.trim())) return undefined;
    const parsed = foreignRuleMigrationBindingSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function parseHomeWorldForeignRuleMigrationInput(input: unknown): HomeWorldForeignRuleMigrationInput | undefined {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
    const value = input as Record<string, unknown>;
    if (!hasExactKeys(value, ["bridgeId", "epochId", "lastSeq", "ruleRef", "signal"])) return undefined;
    if (!boundedMigrationText(value.bridgeId, 256) || !boundedMigrationText(value.epochId, 256)) return undefined;
    if (typeof value.lastSeq !== "number" || !Number.isSafeInteger(value.lastSeq) || value.lastSeq <= 0) return undefined;
    const parsedRuleRef = foreignRuleMigrationRequestSchema.safeParse({ ruleRef: value.ruleRef });
    if (!parsedRuleRef.success || parsedRuleRef.data.ruleRef !== value.ruleRef) return undefined;
    if (!isAbortSignalLike(value.signal)) return undefined;
    return {
      bridgeId: value.bridgeId,
      epochId: value.epochId,
      lastSeq: value.lastSeq,
      ruleRef: parsedRuleRef.data.ruleRef,
      signal: value.signal,
    };
  } catch {
    return undefined;
  }
}

function migrationRuntimeReady(
  runtime: HomeWorldBridgeRuntime | undefined,
): runtime is HomeWorldBridgeRuntime {
  return runtime !== undefined
    && runtime.ingest.diagnostics().connectionState === "ready"
    && runtime.extensionAvailability["foreignRules@2"] === "available"
    && runtime.extensionAvailability["foreignRuleMigration@1"] === "available";
}

function committedMigrationWatermark(runtime: HomeWorldBridgeRuntime): JournalWatermark | undefined {
  try {
    const watermark = runtime.journal.consistentWatermark?.(runtime.bridgeId);
    return watermark === undefined ? undefined : { ...watermark };
  } catch {
    return undefined;
  }
}

function migrationWatermarkMatches(
  watermark: JournalWatermark,
  request: Pick<HomeWorldForeignRuleMigrationInput, "epochId" | "lastSeq">,
): boolean {
  return watermark.epochId === request.epochId && watermark.lastSeq === request.lastSeq;
}

function normalizeHomeWorldForeignRuleMigrationResult(
  value: unknown,
  ruleRef: string,
  bridgeId: string,
): HomeWorldForeignRuleMigrationResult {
  const parsed = foreignRuleMigrationResultSchema.safeParse(value);
  if (!parsed.success) return { status: "unavailable" };
  if (parsed.data.status === "unsupported") {
    return { status: "unsupported", reason: parsed.data.reason };
  }
  if (parsed.data.status === "unavailable") return { status: "unavailable" };
  if (parsed.data.ruleRef !== ruleRef || !migrationPlanBindingsStayOnBridge(parsed.data.plan, bridgeId)) {
    return { status: "unavailable" };
  }
  return {
    status: "translated",
    ruleRef: parsed.data.ruleRef,
    sourceFingerprint: parsed.data.sourceFingerprint,
    title: parsed.data.title,
    plan: cloneForeignRuleMigrationPlan(parsed.data.plan),
  };
}

function migrationPlanBindingsStayOnBridge(plan: ForeignRuleMigrationPlan, bridgeId: string): boolean {
  const bindings: ForeignRuleMigrationBinding[] = [];
  if (plan.trigger.kind === "capability_changed") bindings.push(plan.trigger.source);
  for (const condition of plan.conditions) bindings.push(condition.source);
  for (const action of plan.actions) {
    if (action.kind === "set_boolean" || action.kind === "set_level") bindings.push(action.target);
  }
  return bindings.every((binding) => binding.bridgeId === bridgeId);
}

function cloneForeignRuleMigrationPlan(plan: ForeignRuleMigrationPlan): ForeignRuleMigrationPlan {
  const trigger = plan.trigger.kind === "schedule"
    ? {
      kind: "schedule" as const,
      timezone: plan.trigger.timezone,
      daysOfWeek: [...plan.trigger.daysOfWeek],
      at: plan.trigger.at,
    }
    : {
      kind: "capability_changed" as const,
      source: { ...plan.trigger.source },
    };
  const conditions = plan.conditions.map((condition) => ({
    kind: "capability_value" as const,
    source: { ...condition.source },
    operator: condition.operator,
    value: condition.value,
  }));
  const actions = plan.actions.map((action) => action.kind === "set_boolean"
    ? { kind: "set_boolean" as const, target: { ...action.target }, value: action.value }
    : action.kind === "set_level"
      ? { kind: "set_level" as const, target: { ...action.target }, level: action.level }
      : { kind: "notify_local" as const, message: action.message });
  return { trigger, conditions, actions };
}

type AwaitMigrationReadResult<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected" }
  | { readonly status: "aborted" };

function awaitMigrationRead<T>(
  read: () => PromiseLike<T> | T,
  signal: AbortSignal,
): Promise<AwaitMigrationReadResult<T>> {
  if (signal.aborted) return Promise.resolve({ status: "aborted" });
  return new Promise<AwaitMigrationReadResult<T>>((resolve) => {
    let settled = false;
    const cleanup = (): void => {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        // A malformed signal remains a closed unavailable result.
      }
    };
    const finish = (result: AwaitMigrationReadResult<T>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    function onAbort(): void {
      finish({ status: "aborted" });
    }
    try {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      Promise.resolve().then(() => {
        if (signal.aborted) {
          finish({ status: "aborted" });
          return undefined;
        }
        return read();
      }).then(
        (value) => { if (!settled) finish({ status: "fulfilled", value: value as T }); },
        () => finish({ status: "rejected" }),
      );
    } catch {
      finish({ status: "rejected" });
    }
  });
}

function boundedMigrationText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && Buffer.byteLength(value, "utf8") <= maximumBytes
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== "object") return false;
  const signal = value as Partial<AbortSignal>;
  return typeof signal.aborted === "boolean"
    && typeof signal.addEventListener === "function"
    && typeof signal.removeEventListener === "function";
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function exactBinding(
  left: { readonly bridgeId: string; readonly nativeId: string; readonly nativeInstanceId: string },
  right: ForeignRuleMigrationBinding,
): boolean {
  return left.bridgeId === right.bridgeId
    && left.nativeId === right.nativeId
    && left.nativeInstanceId === right.nativeInstanceId;
}

function readCommittedOrgHints(
  journal: IngestJournal,
  bridgeId: string,
  epochId: string | undefined,
): ReadonlySet<string> {
  const nonSpatial = new Set<string>();
  if (epochId === undefined) return nonSpatial;
  for (const record of journal.records(bridgeId)) {
    const { envelope } = record;
    if (envelope.epochId !== epochId || envelope.event.kind !== "ext" || envelope.event.ext !== "orgHints@1") continue;
    const parsed = orgHintPayloadSchema.safeParse(envelope.event.payload);
    if (parsed.success) nonSpatial.add(parsed.data.nativeId);
  }
  return nonSpatial;
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

function authorityDigest(
  domain: string,
  value: Readonly<Record<string, string | number | boolean | null>>,
): `sha256:${string}` {
  const canonical = JSON.stringify([
    domain,
    ...Object.entries(value).sort(([left], [right]) => compareStrings(left, right)),
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function validateEvidenceQuery(input: HomeWorldEvidenceQuery): number {
  const limit = input?.limit ?? 100;
  if (!input || typeof input !== "object"
    || !Array.isArray(input.hwCapabilityIds)
    || input.hwCapabilityIds.length < 1
    || input.hwCapabilityIds.length > 20
    || input.hwCapabilityIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 200)
    || !Number.isSafeInteger(input.lookbackHours)
    || input.lookbackHours < 1
    || input.lookbackHours > 168
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > 200) {
    throw new TypeError("home evidence query is invalid or unbounded");
  }
  return limit;
}

function validateActivityQuery(input: HomeWorldActivityQuery): number {
  const limit = input?.limit ?? 20;
  if (!input || typeof input !== "object"
    || !Number.isSafeInteger(input.lookbackHours)
    || input.lookbackHours < 1
    || input.lookbackHours > 168
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > 50) {
    throw new TypeError("home activity query is invalid or unbounded");
  }
  return limit;
}

function evidenceBindingKey(nativeId: string, nativeInstanceId: string): string {
  return `${nativeId}\u0000${nativeInstanceId}`;
}

function activityBindingKey(bridgeId: string, nativeId: string, nativeInstanceId: string): string {
  return `${bridgeId}\u0000${nativeId}\u0000${nativeInstanceId}`;
}

function evidenceScalar(value: unknown): string | number | boolean | null | undefined {
  return value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}

function actionCurrentState(
  attrs: Readonly<Record<string, unknown>>,
): BridgeActionCurrentState | undefined {
  const current: Record<string, unknown> = {};
  const scalarKeys = ["value", "state", "level", "brightness", "volumeLevel", "format", "writable", "setLevelSupported", "available"];
  for (const key of scalarKeys) {
    const value = attrs[key];
    if (value === undefined) continue;
    if (value === null || typeof value === "string" || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))) current[key] = value;
  }
  const parsed = bridgeActionCurrentStateSchema.safeParse(current);
  return parsed.success ? parsed.data : undefined;
}

function actionStateIsKnown(current: BridgeActionCurrentState): boolean {
  if (current.available === false || current.state === "unknown" || current.state === "unavailable") return false;
  return current.value !== undefined
    || current.state !== undefined
    || current.level !== undefined
    || current.brightness !== undefined
    || current.volumeLevel !== undefined;
}

function normalizeClock(value: string | number | Date): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  return value;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Household-readable fallback labels for capabilities on unnamed devices. */
const HOUSEHOLD_CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  light: "灯",
  switch: "开关",
  button: "按钮",
  sensor: "传感器",
  "binary-sensor": "传感器",
  "numeric-control": "调节器",
  "choice-control": "选择器",
  "text-control": "文本控制",
  "time-control": "定时控制",
  event: "事件源",
  media: "媒体设备",
  cover: "窗帘",
  lock: "门锁",
  presence: "在家感应",
  fan: "风扇",
  camera: "摄像头",
  vacuum: "扫地机",
  climate: "空调",
  weather: "天气",
  automation: "自动化",
};

export function householdCapabilityLabel(semanticKind: string | undefined): string | undefined {
  return semanticKind === undefined ? undefined : HOUSEHOLD_CAPABILITY_LABELS[semanticKind];
}
