/**
 * The bounded restart/reconnect handoff for migration cutovers.
 *
 * This module only coordinates the proposal owner and the migration runtime.
 * It does not read a store, inspect a bridge, or perform a deployment itself.
 * Every candidate is re-read through the neutral workflow lookup before the
 * already-decided proposal mutation is resumed.
 */

const MAX_SWEEP_ITEMS = 100;
const SYSTEM_ACTOR = "system" as const;

export const MIGRATION_CUTOVER_RECOVERY_LIMIT = MAX_SWEEP_ITEMS;

export interface MigrationCutoverAutomation {
  readonly id: string;
  readonly revision: number;
  readonly reviewLane: string;
  readonly lifecycle: string;
  readonly deployment?: {
    readonly target?: string;
  };
}

export interface MigrationCutoverRecoveryMutationInput {
  readonly proposalId: string;
  readonly expectedRevision: number;
  readonly actor: "system";
}

/** The proposal owner is the only owner allowed to resume a persisted decision. */
export interface MigrationCutoverProposalOwnerPort {
  listAutomations(): readonly MigrationCutoverAutomation[];
  retryEnable(input: MigrationCutoverRecoveryMutationInput): Promise<unknown> | unknown;
  recoverAutomation(input: MigrationCutoverRecoveryMutationInput): Promise<unknown> | unknown;
}

export type MigrationCutoverWorkflowLookup =
  | {
    readonly status: "not_migration";
  }
  | {
    readonly status: "ambiguous";
  }
  | {
    readonly status: "ready";
    readonly sourceBridgeId: string;
  }
  | {
    readonly status: "governed";
    readonly sourceBridgeId: string;
    readonly workflowStatus: string;
    readonly failureReason?: string;
    readonly deploymentId?: string;
    readonly deploymentTarget?: string;
  };

/** The migration runtime exposes only this neutral, lookup-only seam here. */
export interface MigrationCutoverMigrationRuntimePort {
  findWorkflowForProposal(proposalId: string): MigrationCutoverWorkflowLookup;
}

/** Readiness is a gate. A false or unavailable result prevents all writes. */
export type MigrationCutoverBridgeReadinessPort = (bridgeId: string) => boolean;

export interface MigrationCutoverRecoveryOptions {
  readonly proposals: MigrationCutoverProposalOwnerPort;
  readonly migrations: MigrationCutoverMigrationRuntimePort;
  readonly isBridgeReady: MigrationCutoverBridgeReadinessPort;
}

/** Stable per-sweep counters; no proposal or bridge identity is returned. */
export interface MigrationCutoverRecoveryResult {
  readonly scanned: number;
  /** Number of retryEnable owner calls, including calls that rejected. */
  readonly retried: number;
  /** Number of recoverAutomation owner calls, including calls that rejected. */
  readonly recovered: number;
  /** Candidates that failed a lane, lifecycle, lookup, identity, or readiness gate. */
  readonly skipped: number;
  /** Owner action failures; each failed row remains isolated from the sweep. */
  readonly failed: number;
}

type RowOutcome =
  | "retry"
  | "retry_failed"
  | "recover"
  | "recover_failed"
  | "skip";

interface MutableCounts {
  scanned: number;
  retried: number;
  recovered: number;
  skipped: number;
  failed: number;
}

/**
 * Reconciles migration cutover crash windows one bounded sweep at a time.
 * Concurrent callers on one instance receive the exact same in-flight sweep;
 * the lease is released after completion so a later sweep observes fresh
 * proposal and workflow revisions.
 */
export class MigrationCutoverRecoveryCoordinator {
  private readonly proposals: MigrationCutoverProposalOwnerPort;
  private readonly migrations: MigrationCutoverMigrationRuntimePort;
  private readonly isBridgeReady: MigrationCutoverBridgeReadinessPort;
  private inFlight: Promise<MigrationCutoverRecoveryResult> | undefined;

  constructor(options: MigrationCutoverRecoveryOptions) {
    if (!isRecord(options)
      || !isRecord(options.proposals)
      || typeof options.proposals.listAutomations !== "function"
      || typeof options.proposals.retryEnable !== "function"
      || typeof options.proposals.recoverAutomation !== "function"
      || !isRecord(options.migrations)
      || typeof options.migrations.findWorkflowForProposal !== "function"
      || typeof options.isBridgeReady !== "function") {
      throw new TypeError("migration cutover recovery ports are required");
    }
    this.proposals = options.proposals;
    this.migrations = options.migrations;
    this.isBridgeReady = options.isBridgeReady;
  }

  /** Runs one bounded restart/reconnect sweep. */
  sweep(): Promise<MigrationCutoverRecoveryResult> {
    const running = this.inFlight;
    if (running !== undefined) return running;

    const promise = this.runSweep();
    this.inFlight = promise;
    void promise.finally(() => {
      if (this.inFlight === promise) this.inFlight = undefined;
    }).catch(() => {
      // runSweep converts expected failures into stable counts. This handler
      // also prevents a cleanup rejection from becoming an unhandled error.
    });
    return promise;
  }

  private async runSweep(): Promise<MigrationCutoverRecoveryResult> {
    const counts: MutableCounts = {
      scanned: 0,
      retried: 0,
      recovered: 0,
      skipped: 0,
      failed: 0,
    };

    let automations: readonly MigrationCutoverAutomation[];
    try {
      const listed = this.proposals.listAutomations();
      if (!Array.isArray(listed)) throw new TypeError("automation list is invalid");
      automations = listed.slice(0, MAX_SWEEP_ITEMS);
    } catch {
      // A list owner failure has no row to isolate; expose one stable failure
      // while preserving the bounded, non-throwing diagnostic contract.
      counts.failed = 1;
      return freezeCounts(counts);
    }

    const readiness = new Map<string, boolean>();
    for (const automation of automations) {
      counts.scanned += 1;
      let outcome: RowOutcome;
      try {
        outcome = await this.reconcileOne(automation, readiness);
      } catch {
        // Untrusted row shapes and owner boundaries cannot stop other rows.
        outcome = "skip";
      }
      switch (outcome) {
        case "retry":
          counts.retried += 1;
          break;
        case "retry_failed":
          counts.retried += 1;
          counts.failed += 1;
          break;
        case "recover":
          counts.recovered += 1;
          break;
        case "recover_failed":
          counts.recovered += 1;
          counts.failed += 1;
          break;
        case "skip":
          counts.skipped += 1;
          break;
      }
    }
    return freezeCounts(counts);
  }

  private async reconcileOne(
    automation: MigrationCutoverAutomation,
    readiness: Map<string, boolean>,
  ): Promise<RowOutcome> {
    if (!isBoundedId(automation?.id)
      || !isRevision(automation?.revision)
      || automation.reviewLane !== "migration"
      || (automation.lifecycle !== "enabling" && automation.lifecycle !== "recovery_required")) {
      return "skip";
    }

    const target = automation.deployment?.target;
    if (!isBoundedId(target)) return "skip";

    let workflow: MigrationCutoverWorkflowLookup;
    try {
      workflow = this.migrations.findWorkflowForProposal(automation.id);
    } catch {
      return "skip";
    }
    if (!isRecord(workflow)) return "skip";

    const action = workflowAction(automation.lifecycle, workflow);
    if (action === undefined) return "skip";
    const source = workflowSourceBridgeId(workflow);
    if (source === undefined || !bridgeReady(source, readiness, this.isBridgeReady)
      || !bridgeReady(target, readiness, this.isBridgeReady)) {
      return "skip";
    }

    const input: MigrationCutoverRecoveryMutationInput = {
      proposalId: automation.id,
      expectedRevision: automation.revision,
      actor: SYSTEM_ACTOR,
    };
    try {
      if (action === "retry") {
        await this.proposals.retryEnable(input);
        return "retry";
      }
      await this.proposals.recoverAutomation(input);
      return "recover";
    } catch {
      return action === "retry" ? "retry_failed" : "recover_failed";
    }
  }
}

function workflowAction(
  lifecycle: string,
  workflow: MigrationCutoverWorkflowLookup,
): "retry" | "recover" | undefined {
  if (workflow.status !== "ready" && workflow.status !== "governed") return undefined;
  if (lifecycle === "enabling") {
    if (workflow.status === "ready") return "retry";
    if (workflow.workflowStatus === "switching" || workflow.workflowStatus === "verified") return "retry";
    if (workflow.workflowStatus !== "needs_attention") return undefined;
    if (workflow.failureReason === "switch_failed" || workflow.failureReason === "switch_unknown") return "retry";
    if (workflow.failureReason === "verification_failed"
      && workflow.deploymentId === undefined
      && workflow.deploymentTarget === undefined) {
      return "retry";
    }
    return undefined;
  }
  if (lifecycle !== "recovery_required" || workflow.status !== "governed") return undefined;
  if (workflow.workflowStatus === "rolling_back") return "recover";
  if (workflow.workflowStatus !== "needs_attention") return undefined;
  return workflow.failureReason === "verification_failed"
    || workflow.failureReason === "rollback_failed"
    || workflow.failureReason === "rollback_unknown"
    ? "recover"
    : undefined;
}

function workflowSourceBridgeId(workflow: MigrationCutoverWorkflowLookup): string | undefined {
  if ((workflow.status !== "ready" && workflow.status !== "governed")
    || !isBoundedId(workflow.sourceBridgeId)) {
    return undefined;
  }
  return workflow.sourceBridgeId;
}

function bridgeReady(
  bridgeId: string,
  readiness: Map<string, boolean>,
  isBridgeReady: MigrationCutoverBridgeReadinessPort,
): boolean {
  const previous = readiness.get(bridgeId);
  if (previous !== undefined) return previous;
  let ready = false;
  try {
    ready = isBridgeReady(bridgeId) === true;
  } catch {
    ready = false;
  }
  readiness.set(bridgeId, ready);
  return ready;
}

function freezeCounts(counts: MutableCounts): MigrationCutoverRecoveryResult {
  return Object.freeze({
    scanned: counts.scanned,
    retried: counts.retried,
    recovered: counts.recovered,
    skipped: counts.skipped,
    failed: counts.failed,
  });
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 200
    && value.trim() === value;
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
