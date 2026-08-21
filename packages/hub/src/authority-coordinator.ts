import type { ControlResult, WorldCapability } from "../../../contracts/bridge-contract.js";

import type {
  GovernanceAuditRecord,
  GovernanceProposal,
} from "./world-identity.js";

export type AuthorityValidity = "valid" | "stale" | "invalid-source" | "present-but-invalid";

export interface AuthorityAvailability {
  readonly bridgeId: string;
  readonly available: boolean;
  readonly validity: AuthorityValidity;
}

export interface AuthorityBindingObservation {
  readonly hwCapabilityId: string;
  readonly nativeId: string;
  readonly nativeInstanceId: string;
  readonly validity: AuthorityValidity;
}

export interface AuthorityResyncSnapshot {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly bindings: readonly AuthorityBindingObservation[];
}

export type ActionAuthorityPolicyClass = "direct" | "confirmation" | "administrator";

export interface AuthorityResyncPort {
  requestResync(bridgeId: string, signal?: AbortSignal): Promise<ControlResult>;
  waitForSyncComplete(bridgeId: string, generation: number, signal?: AbortSignal): Promise<AuthorityResyncSnapshot>;
}

export interface ActionAuthorityConfiguration {
  readonly bridgeId: string;
  readonly approved: boolean;
  /** Reviewed Hub policy class; semantic hints never supply this value. */
  readonly policyClass: ActionAuthorityPolicyClass;
  /** Hub-owned canonical digest of the complete authority configuration. */
  readonly configIdentity: string;
  /** Monotonic Hub-owned configuration revision; never defaults implicitly. */
  readonly configRevision: number;
}

/** Hub-internal projection; never forwarded by HomeWorld or an agent tool. */
export interface ActionAuthorityConfigurationResolution {
  readonly status: "configured" | "not_configured" | "invalid";
  readonly approved: boolean;
  readonly policyClass?: ActionAuthorityPolicyClass;
  readonly configIdentity?: string;
  readonly configRevision?: number;
}

export interface AuthorityCoordinatorOptions {
  readonly capabilities: readonly WorldCapability[];
  readonly stateAuthorityConfig?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  readonly actionAuthorityConfig?: ReadonlyMap<string, ActionAuthorityConfiguration>
    | Readonly<Record<string, ActionAuthorityConfiguration>>;
  readonly initialStateAuthorities?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  readonly resyncPort?: AuthorityResyncPort;
  readonly resyncTimeoutMs?: number;
  readonly now?: () => string | Date;
}

export type StateAuthorityFailureReason =
  | "unknown_capability"
  | "no_available_binding"
  | "resync_unavailable"
  | "resync_failed"
  | "candidate_missing"
  | "candidate_invalid"
  | "batch_not_committed";

export interface StateAuthorityChoice {
  readonly status: "available" | "unavailable";
  readonly bridgeId?: string;
  readonly reason?: "unknown_capability" | "no_available_binding";
}

export interface StateAuthorityResolution {
  readonly hwCapabilityId: string;
  readonly status: "unchanged" | "switched" | "failed";
  readonly authority?: string;
  readonly reason?: StateAuthorityFailureReason;
}

export type ActionAuthorityResolution =
  | {
      readonly status: "available";
      readonly bridgeId: string;
      readonly policyClass: ActionAuthorityPolicyClass;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "not_configured" | "not_approved" | "configured_binding_unavailable" | "unknown_capability";
    };

export interface StateAuthorityRequest {
  readonly hwCapabilityId: string;
  readonly availability: readonly AuthorityAvailability[];
  readonly preferredBridgeId?: string;
}

/**
 * Coordinates read-side authority without giving action execution an implicit
 * route. State changes are committed only after every requested candidate has
 * passed the same bridge-local consistency point.
 */
export class AuthorityCoordinator {
  private readonly capabilities = new Map<string, WorldCapability>();
  private readonly stateAuthorityConfig: ReadonlyMap<string, string>;
  private readonly initialStateAuthorities: ReadonlyMap<string, string>;
  private actionAuthorityConfig: ReadonlyMap<string, unknown>;
  private readonly stateAuthorities = new Map<string, string>();
  private readonly resyncPort?: AuthorityResyncPort;
  private readonly resyncTimeoutMs: number;
  private readonly now: () => string;
  private readonly inFlightResync = new Map<string, Promise<AuthorityResyncSnapshot>>();
  private readonly resyncGenerations = new Map<string, number>();
  private readonly proposals = new Map<string, GovernanceProposal>();
  private readonly audits: GovernanceAuditRecord[] = [];
  private auditCounter = 0;
  private proposalCounter = 0;

  constructor(options: AuthorityCoordinatorOptions) {
    this.now = () => normalizeTime(options.now?.() ?? new Date());
    this.stateAuthorityConfig = readStringMap(options.stateAuthorityConfig);
    this.initialStateAuthorities = readStringMap(options.initialStateAuthorities);
    this.actionAuthorityConfig = readActionMap(options.actionAuthorityConfig);
    this.resyncPort = options.resyncPort;
    this.resyncTimeoutMs = Math.max(1, options.resyncTimeoutMs ?? 30_000);
    for (const capability of options.capabilities) {
      this.capabilities.set(capability.hwCapabilityId, cloneCapability(capability));
    }
    for (const [hwCapabilityId, bridgeId] of this.initialStateAuthorities) {
      if (this.capabilities.has(hwCapabilityId)) this.stateAuthorities.set(hwCapabilityId, bridgeId);
    }
  }

  /**
   * Adds capabilities discovered after construction. Existing entries are
   * intentionally retained so a caller can seed an authority record before
   * the first bridge snapshot arrives.
   */
  registerCapabilities(capabilities: readonly WorldCapability[]): void {
    for (const capability of capabilities) {
      if (!this.capabilities.has(capability.hwCapabilityId)) {
        this.capabilities.set(capability.hwCapabilityId, cloneCapability(capability));
      }
      if (this.stateAuthorities.has(capability.hwCapabilityId)) continue;
      const registered = this.capabilities.get(capability.hwCapabilityId);
      if (registered === undefined) continue;
      const configured = this.initialStateAuthorities.get(capability.hwCapabilityId)
        ?? this.stateAuthorityConfig.get(capability.hwCapabilityId);
      const initialBridgeId = configured !== undefined
        ? (hasBinding(registered, configured) ? configured : undefined)
        : registered.bindings.length === 1 ? registered.bindings[0]?.bridgeId : undefined;
      if (initialBridgeId !== undefined) this.stateAuthorities.set(capability.hwCapabilityId, initialBridgeId);
    }
  }

  capability(hwCapabilityId: string): WorldCapability | undefined {
    const capability = this.capabilities.get(hwCapabilityId);
    return capability === undefined ? undefined : cloneCapability(capability);
  }

  capabilitiesSnapshot(): readonly WorldCapability[] {
    return [...this.capabilities.values()].sort((left, right) => compare(left.hwCapabilityId, right.hwCapabilityId)).map(cloneCapability);
  }

  /** Replaces the Hub-owned action projection after its durable source commits. */
  replaceActionAuthorityConfig(
    configuration: ReadonlyMap<string, ActionAuthorityConfiguration>
      | Readonly<Record<string, ActionAuthorityConfiguration>>,
  ): void {
    this.actionAuthorityConfig = readActionMap(configuration);
  }

  chooseStateAuthority(
    hwCapabilityId: string,
    availability: readonly AuthorityAvailability[],
    preferredBridgeId?: string,
  ): StateAuthorityChoice {
    const capability = this.capabilities.get(hwCapabilityId);
    if (capability === undefined) return { status: "unavailable", reason: "unknown_capability" };
    const candidates = availability
      .filter((candidate) => candidate.available && candidate.validity === "valid" && hasBinding(capability, candidate.bridgeId))
      .sort((left, right) => compare(left.bridgeId, right.bridgeId));
    if (candidates.length === 0) return { status: "unavailable", reason: "no_available_binding" };
    const configured = preferredBridgeId ?? this.stateAuthorityConfig.get(hwCapabilityId);
    if (configured !== undefined && candidates.some((candidate) => candidate.bridgeId === configured)) {
      return { status: "available", bridgeId: configured };
    }
    return { status: "available", bridgeId: candidates[0]!.bridgeId };
  }

  currentStateAuthority(hwCapabilityId: string): string | undefined {
    return this.stateAuthorities.get(hwCapabilityId);
  }

  stateAuthoritySnapshot(): ReadonlyMap<string, string> {
    return new Map(this.stateAuthorities);
  }

  async reconcileStateAuthority(
    hwCapabilityId: string,
    availability: readonly AuthorityAvailability[],
    preferredBridgeId?: string,
  ): Promise<StateAuthorityResolution> {
    const [result] = await this.reconcileStateAuthorities([{
      hwCapabilityId,
      availability,
      preferredBridgeId,
    }]);
    return result!;
  }

  async reconcileStateAuthorities(requests: readonly StateAuthorityRequest[]): Promise<readonly StateAuthorityResolution[]> {
    const planned: Array<{
      request: StateAuthorityRequest;
      target?: string;
      current?: string;
      choice?: StateAuthorityChoice;
    }> = requests.map((request) => ({
      request,
      current: this.stateAuthorities.get(request.hwCapabilityId),
      choice: this.chooseStateAuthority(request.hwCapabilityId, request.availability, request.preferredBridgeId),
    }));

    const immediate = new Map<string, StateAuthorityResolution>();
    const pendingByBridge = new Map<string, string[]>();
    for (const item of planned) {
      const { request, choice, current } = item;
      if (choice?.status !== "available") {
        immediate.set(request.hwCapabilityId, {
          hwCapabilityId: request.hwCapabilityId,
          status: "failed",
          authority: current,
          reason: choice?.reason === "unknown_capability" ? "unknown_capability" : "no_available_binding",
        });
        continue;
      }
      item.target = choice.bridgeId;
      if (choice.bridgeId === current) {
        immediate.set(request.hwCapabilityId, {
          hwCapabilityId: request.hwCapabilityId,
          status: "unchanged",
          authority: current,
        });
        continue;
      }
      const bridgeId = choice.bridgeId!;
      const ids = pendingByBridge.get(bridgeId) ?? [];
      ids.push(request.hwCapabilityId);
      pendingByBridge.set(bridgeId, ids);
    }

    const snapshots = new Map<string, AuthorityResyncSnapshot>();
    const failedBridges = new Set<string>();
    await Promise.all([...pendingByBridge.keys()].map(async (bridgeId) => {
      try {
        snapshots.set(bridgeId, await this.ensureResync(bridgeId));
      } catch {
        failedBridges.add(bridgeId);
      }
    }));

    const pendingResults = new Map<string, StateAuthorityResolution>();
    let batchCanCommit = failedBridges.size === 0;
    for (const item of planned) {
      if (item.target === undefined || immediate.has(item.request.hwCapabilityId)) continue;
      const { request, target, current } = item;
      if (failedBridges.has(target)) {
        pendingResults.set(request.hwCapabilityId, {
          hwCapabilityId: request.hwCapabilityId,
          status: "failed",
          authority: current,
          reason: this.resyncPort === undefined ? "resync_unavailable" : "resync_failed",
        });
        batchCanCommit = false;
        continue;
      }
      const candidate = this.validateCandidate(request.hwCapabilityId, target, snapshots.get(target)!);
      if (candidate !== undefined) {
        pendingResults.set(request.hwCapabilityId, {
          hwCapabilityId: request.hwCapabilityId,
          status: "failed",
          authority: current,
          reason: candidate,
        });
        batchCanCommit = false;
      }
    }

    if (!batchCanCommit) {
      for (const item of planned) {
        if (item.target === undefined || immediate.has(item.request.hwCapabilityId)) continue;
        if (!pendingResults.has(item.request.hwCapabilityId)) {
          pendingResults.set(item.request.hwCapabilityId, {
            hwCapabilityId: item.request.hwCapabilityId,
            status: "failed",
            authority: item.current,
            reason: "batch_not_committed",
          });
        }
      }
    } else {
      for (const item of planned) {
        if (item.target === undefined || immediate.has(item.request.hwCapabilityId)) continue;
        const current = item.current;
        this.stateAuthorities.set(item.request.hwCapabilityId, item.target);
        pendingResults.set(item.request.hwCapabilityId, {
          hwCapabilityId: item.request.hwCapabilityId,
          status: "switched",
          authority: item.target,
        });
        this.recordAudit({
          kind: "state-authority-switched",
          at: this.now(),
          hwCapabilityId: item.request.hwCapabilityId,
          fromBridgeId: current,
          toBridgeId: item.target,
          outcome: "switched",
        });
      }
    }

    return requests.map((request) => immediate.get(request.hwCapabilityId)
      ?? pendingResults.get(request.hwCapabilityId)
      ?? {
        hwCapabilityId: request.hwCapabilityId,
        status: "failed" as const,
        authority: this.stateAuthorities.get(request.hwCapabilityId),
        reason: "batch_not_committed" as const,
      });
  }

  resolveActionAuthority(
    hwCapabilityId: string,
    availability: readonly AuthorityAvailability[],
  ): ActionAuthorityResolution {
    const capability = this.capabilities.get(hwCapabilityId);
    if (capability === undefined) return { status: "unavailable", reason: "unknown_capability" };
    const configuration = this.resolveActionAuthorityConfiguration(hwCapabilityId);
    if (configuration.status !== "configured") return { status: "unavailable", reason: "not_configured" };
    const configured = parseActionAuthorityConfiguration(this.actionAuthorityConfig.get(hwCapabilityId));
    if (configured === undefined) return { status: "unavailable", reason: "not_configured" };
    if (!configured.approved) return { status: "unavailable", reason: "not_approved" };
    const available = availability.some((candidate) => candidate.bridgeId === configured.bridgeId
      && candidate.available
      && candidate.validity === "valid"
      && hasBinding(capability, candidate.bridgeId));
    return available
      ? { status: "available", bridgeId: configured.bridgeId, policyClass: configured.policyClass }
      : { status: "unavailable", reason: "configured_binding_unavailable" };
  }

  /**
   * Hub-private configuration projection for candidate/assessment producers.
   * It intentionally omits the selected bridge and accepts no unversioned
   * configuration, so malformed input cannot become an authority assertion.
   */
  resolveActionAuthorityConfiguration(hwCapabilityId: string): ActionAuthorityConfigurationResolution {
    if (!this.capabilities.has(hwCapabilityId)) {
      return { status: "not_configured", approved: false };
    }
    if (!this.actionAuthorityConfig.has(hwCapabilityId)) {
      return { status: "not_configured", approved: false };
    }
    const configured = parseActionAuthorityConfiguration(this.actionAuthorityConfig.get(hwCapabilityId));
    if (configured === undefined) return { status: "invalid", approved: false };
    return Object.freeze({
      status: "configured" as const,
      approved: configured.approved,
      policyClass: configured.policyClass,
      configIdentity: configured.configIdentity,
      configRevision: configured.configRevision,
    });
  }

  /**
   * Hub-internal binding selector for HomeWorld's candidate projection. It
   * only answers a caller-supplied bridge predicate and never returns a route
   * or configuration record.
   */
  isActionAuthorityConfiguredForBridge(hwCapabilityId: string, bridgeId: string): boolean {
    if (!this.capabilities.has(hwCapabilityId) || typeof bridgeId !== "string") return false;
    const configured = parseActionAuthorityConfiguration(this.actionAuthorityConfig.get(hwCapabilityId));
    return configured?.bridgeId === bridgeId;
  }

  proposeActionAuthority(hwCapabilityId: string, bridgeId: string): GovernanceProposal {
    const capability = this.capabilities.get(hwCapabilityId);
    if (capability === undefined) throw new Error(`Unknown hwCapabilityId "${hwCapabilityId}"`);
    if (!hasBinding(capability, bridgeId)) throw new Error(`Bridge "${bridgeId}" has no binding for "${hwCapabilityId}"`);
    const proposal: GovernanceProposal = {
      id: `authority-proposal-${++this.proposalCounter}`,
      kind: "action-authority-binding",
      status: "proposed",
      createdAt: this.now(),
      requiresHumanApproval: true,
      hwCapabilityId,
      bridgeId,
      reason: "action_authority_requires_explicit_approval",
    };
    this.proposals.set(proposal.id, proposal);
    this.recordAudit({
      kind: "action-authority-proposed",
      at: proposal.createdAt,
      hwCapabilityId,
      bridgeId,
      proposalId: proposal.id,
      outcome: "proposed",
    });
    return { ...proposal };
  }

  proposalsList(): readonly GovernanceProposal[] {
    return [...this.proposals.values()].map((proposal) => ({ ...proposal }));
  }

  auditTrail(): readonly GovernanceAuditRecord[] {
    return this.audits.map((record) => ({ ...record }));
  }

  private ensureResync(bridgeId: string): Promise<AuthorityResyncSnapshot> {
    const existing = this.inFlightResync.get(bridgeId);
    if (existing !== undefined) return existing;
    if (this.resyncPort === undefined) return Promise.reject(new Error("resync port is unavailable"));
    const generation = (this.resyncGenerations.get(bridgeId) ?? 0) + 1;
    this.resyncGenerations.set(bridgeId, generation);
    const controller = new AbortController();
    const operation = (async () => {
      const result = await this.resyncPort!.requestResync(bridgeId, controller.signal);
      if (result.status !== "completed") throw new Error("resync request was not accepted");
      const snapshot = await this.resyncPort!.waitForSyncComplete(bridgeId, generation, controller.signal);
      if (snapshot.bridgeId !== bridgeId || typeof snapshot.epochId !== "string" || snapshot.epochId.length === 0) {
        throw new Error("sync-complete identity mismatch");
      }
      return snapshot;
    })();
    const promise = withTimeout(operation, this.resyncTimeoutMs, controller).finally(() => {
      if (this.inFlightResync.get(bridgeId) === promise) this.inFlightResync.delete(bridgeId);
    });
    this.inFlightResync.set(bridgeId, promise);
    return promise;
  }

  private validateCandidate(hwCapabilityId: string, bridgeId: string, snapshot: AuthorityResyncSnapshot): StateAuthorityFailureReason | undefined {
    const capability = this.capabilities.get(hwCapabilityId);
    if (capability === undefined) return "unknown_capability";
    const expected = capability.bindings.find((binding) => binding.bridgeId === bridgeId);
    if (expected === undefined) return "candidate_missing";
    const observed = snapshot.bindings.filter((binding) => binding.hwCapabilityId === hwCapabilityId
      && binding.nativeId === expected.nativeId
      && binding.nativeInstanceId === expected.nativeInstanceId);
    if (observed.length === 0) return "candidate_missing";
    return observed.some((binding) => binding.validity === "valid") ? undefined : "candidate_invalid";
  }

  private recordAudit(fields: Omit<GovernanceAuditRecord, "id">): void {
    this.audits.push({ ...fields, id: `authority-audit-${++this.auditCounter}` });
  }
}

function hasBinding(capability: WorldCapability, bridgeId: string): boolean {
  return capability.bindings.some((binding) => binding.bridgeId === bridgeId);
}

function cloneCapability(capability: WorldCapability): WorldCapability {
  return { ...capability, bindings: capability.bindings.map((binding) => ({ ...binding })) };
}

function readStringMap(value: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined): ReadonlyMap<string, string> {
  return value instanceof Map ? new Map(value) : new Map(Object.entries(value ?? {}));
}

function readActionMap(
  value: ReadonlyMap<string, ActionAuthorityConfiguration> | Readonly<Record<string, ActionAuthorityConfiguration>> | undefined,
): ReadonlyMap<string, unknown> {
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value ?? {});
  return new Map(entries.map(([key, configuration]) => [
    key,
    snapshotActionAuthorityConfig(configuration),
  ] as const));
}

function snapshotActionAuthorityConfig(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const clone = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (seen.has(candidate)) return undefined;
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) return Object.freeze(candidate.map(clone));
      const copy: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(candidate)) copy[key] = clone(nested);
      return Object.freeze(copy);
    } finally {
      seen.delete(candidate);
    }
  };
  try {
    return clone(value);
  } catch {
    return undefined;
  }
}

const ACTION_AUTHORITY_CONFIG_IDENTITY = /^sha256:[0-9a-f]{64}$/;

function parseActionAuthorityConfiguration(value: unknown): ActionAuthorityConfiguration | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const configRevision = record.configRevision;
    const keys = Object.keys(record).sort();
    if (keys.length !== 5 || keys.some((key, index) => key !== ["approved", "bridgeId", "configIdentity", "configRevision", "policyClass"][index])) {
      return undefined;
    }
    if (typeof record.bridgeId !== "string"
      || record.bridgeId.length === 0
      || record.bridgeId.length > 200
      || record.bridgeId !== record.bridgeId.trim()
      || typeof record.approved !== "boolean"
      || !isActionAuthorityPolicyClass(record.policyClass)
      || typeof record.configIdentity !== "string"
      || !ACTION_AUTHORITY_CONFIG_IDENTITY.test(record.configIdentity)
      || !isPositiveSafeInteger(configRevision)) {
      return undefined;
    }
    return {
      bridgeId: record.bridgeId,
      approved: record.approved,
      policyClass: record.policyClass,
      configIdentity: record.configIdentity,
      configRevision,
    };
  } catch {
    return undefined;
  }
}

function isActionAuthorityPolicyClass(value: unknown): value is ActionAuthorityPolicyClass {
  return value === "direct" || value === "confirmation" || value === "administrator";
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function normalizeTime(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("resync timed out"));
    }, timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
