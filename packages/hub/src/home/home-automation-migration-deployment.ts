import { createHash } from "node:crypto";

import type {
  ForeignRuleControlHandle,
  ForeignRuleControlSetEnabledResult,
  ForeignRuleControlStatusResult,
} from "@hob/bridge-contract";

import type { ProposalDeploymentPort } from "./home-proposal-service.js";
import type {
  HomeAutomationMigrationRuleWorkflowFailureReason,
  HomeAutomationMigrationRuleWorkflowStatus,
} from "./home-automation-migration.js";

/** The neutral source-control lookup owned by HomeWorld. */
export interface HomeAutomationMigrationSourceControlPort {
  foreignRuleControlFor(bridgeId: string): ForeignRuleControlHandle | undefined;
}

/** One exact migration workflow projection, with no provider/native payload. */
export type HomeAutomationMigrationDeploymentLookup =
  | { readonly status: "not_migration" }
  | { readonly status: "ambiguous" }
  | ({
      readonly status: "ready";
      readonly migrationId: string;
      readonly ruleRef: string;
      readonly sourceBridgeId: string;
      readonly sourceFingerprint: string;
      readonly reviewProposalRevision: number;
    })
  | ({
      readonly status: "governed";
      readonly workflowStatus: Exclude<HomeAutomationMigrationRuleWorkflowStatus, "ready">;
      readonly migrationId: string;
      readonly ruleRef: string;
      readonly sourceBridgeId: string;
      readonly sourceFingerprint: string;
      readonly reviewProposalRevision?: number;
      readonly approvedProposalRevision?: number;
      readonly deploymentId?: string;
      readonly deploymentTarget?: string;
      readonly deploymentConfigFingerprint?: string;
    });

/** Narrow runtime query/mutation seam. It never performs a bridge write. */
export interface HomeAutomationMigrationDeploymentRuntimePort {
  findWorkflowForProposal(proposalId: string): HomeAutomationMigrationDeploymentLookup;
  startRuleSwitch(input: {
    readonly migrationId: string;
    readonly ruleRef: string;
    readonly approvedProposalRevision: number;
    readonly switchOperationId: string;
    readonly switchActor: string;
  }): boolean;
  verifyRuleSwitch(input: {
    readonly migrationId: string;
    readonly ruleRef: string;
    readonly deploymentId: string;
    readonly deploymentTarget: string;
    readonly deploymentConfigFingerprint: string;
  }): boolean;
  startRuleRollback(input: {
    readonly migrationId: string;
    readonly ruleRef: string;
    readonly rollbackOperationId: string;
    readonly rollbackActor: string;
  }): boolean;
  restoreRule(input: { readonly migrationId: string; readonly ruleRef: string }): boolean;
  failRuleWorkflow(input: {
    readonly migrationId: string;
    readonly ruleRef: string;
    readonly from: "ready" | "switching" | "verified" | "rolling_back";
    readonly reason: HomeAutomationMigrationRuleWorkflowFailureReason;
  }): boolean;
}

const SWITCH_FAILURE_REASON = "迁移切换没有完成，原有规则保持可恢复状态。";
const SWITCH_UNKNOWN_REASON = "迁移切换结果暂时无法确认，已停止后续写入。";

/**
 * Governs migration cutover around the existing BridgeAutomationDeployment.
 * The decorator owns sequencing while the runtime owns only neutral CAS state.
 */
export class HomeAutomationMigrationDeployment implements ProposalDeploymentPort {
  constructor(
    private readonly base: ProposalDeploymentPort,
    private readonly runtime: HomeAutomationMigrationDeploymentRuntimePort,
    private readonly source: HomeAutomationMigrationSourceControlPort,
  ) {}

  resolveIntent(request: Parameters<ProposalDeploymentPort["resolveIntent"]>[0]): ReturnType<ProposalDeploymentPort["resolveIntent"]> {
    return this.base.resolveIntent(request);
  }

  async deploy(request: Parameters<ProposalDeploymentPort["deploy"]>[0]): Promise<Awaited<ReturnType<ProposalDeploymentPort["deploy"]>>> {
    let lookup: HomeAutomationMigrationDeploymentLookup;
    try {
      lookup = this.runtime.findWorkflowForProposal(request.proposalId);
    } catch {
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (lookup.status === "not_migration") return this.base.deploy(request);
    if (lookup.status !== "ready") return failed("迁移方案当前处于受管状态，不能重复启用。");
    if (request.revision !== lookup.reviewProposalRevision + 1) {
      return failed("迁移方案的批准版本已经变化，需要重新准备。");
    }

    const control = this.source.foreignRuleControlFor(lookup.sourceBridgeId);
    if (control === undefined) {
      this.fail(lookup, "ready", "switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
    const before = await this.readSource(control, lookup.ruleRef);
    if (before.status === "unknown") {
      this.fail(lookup, "ready", "switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (before.status !== "running" || before.sourceFingerprint !== lookup.sourceFingerprint) {
      this.fail(lookup, "ready", "source_stale");
      return failed("原有规则的来源已经变化，需要重新准备迁移。");
    }

    const switchOperationId = operationId("switch", request.proposalId, request.revision, lookup);
    if (!this.runtime.startRuleSwitch({
      migrationId: lookup.migrationId,
      ruleRef: lookup.ruleRef,
      approvedProposalRevision: request.revision,
      switchOperationId,
      switchActor: request.actor,
    })) return failed(SWITCH_UNKNOWN_REASON);

    const stopped = await this.setSource(control, lookup, false, switchOperationId);
    if (stopped.status !== "paused" || stopped.sourceFingerprint !== lookup.sourceFingerprint) {
      const reason = stopped.status === "unknown" ? "switch_unknown" : "switch_failed";
      this.fail(lookup, "switching", reason);
      return failed(reason === "switch_unknown" ? SWITCH_UNKNOWN_REASON : SWITCH_FAILURE_REASON);
    }

    let outcome: Awaited<ReturnType<ProposalDeploymentPort["deploy"]>>;
    try {
      outcome = await this.base.deploy(request);
    } catch {
      this.fail(lookup, "switching", "switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (outcome.status !== "verified") {
      const recovered = await this.recoverKnownFailure(request, lookup, control, "switch_failed");
      return failed(recovered === "switch_unknown" ? SWITCH_UNKNOWN_REASON : SWITCH_FAILURE_REASON);
    }
    if (outcome.deploymentId === undefined || outcome.target === undefined || outcome.configFingerprint === undefined
      || outcome.deploymentId !== request.intent.deploymentId || outcome.target !== request.intent.target) {
      const recovered = await this.recoverKnownFailure(request, lookup, control, "verification_failed");
      return failed(recovered === "switch_unknown" ? SWITCH_UNKNOWN_REASON : "迁移自动化的部署身份无法验证，已停止后续写入。");
    }

    const target = await this.readTarget(outcome.deploymentId, outcome.target);
    if (target.status === "unknown") {
      this.fail(lookup, "switching", "switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (target.status !== "running" || target.configFingerprint !== outcome.configFingerprint) {
      const recovered = await this.recoverKnownFailure(request, lookup, control, "verification_failed");
      return failed(recovered === "switch_unknown" ? SWITCH_UNKNOWN_REASON : "迁移自动化的运行状态无法验证，已停止后续写入。");
    }

    const after = await this.readSource(control, lookup.ruleRef);
    if (after.status === "unknown") {
      this.fail(lookup, "switching", "switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (after.status !== "paused" || after.sourceFingerprint !== lookup.sourceFingerprint) {
      const recovered = await this.recoverKnownFailure(request, lookup, control, "verification_failed");
      return failed(recovered === "switch_unknown" ? SWITCH_UNKNOWN_REASON : "原有规则的暂停状态无法验证，已停止后续写入。");
    }
    if (!this.runtime.verifyRuleSwitch({
      migrationId: lookup.migrationId,
      ruleRef: lookup.ruleRef,
      deploymentId: outcome.deploymentId,
      deploymentTarget: outcome.target,
      deploymentConfigFingerprint: outcome.configFingerprint,
    })) {
      this.fail(lookup, "switching", "switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
    return outcome;
  }

  status(request: Parameters<NonNullable<ProposalDeploymentPort["status"]>>[0]): ReturnType<NonNullable<ProposalDeploymentPort["status"]>> {
    return this.base.status?.(request) ?? { status: "unknown" };
  }

  pause(request: Parameters<NonNullable<ProposalDeploymentPort["pause"]>>[0]): ReturnType<NonNullable<ProposalDeploymentPort["pause"]>> {
    return this.base.pause?.(request);
  }

  resume(request: Parameters<NonNullable<ProposalDeploymentPort["resume"]>>[0]): ReturnType<NonNullable<ProposalDeploymentPort["resume"]>> {
    return this.base.resume?.(request);
  }

  async withdraw(request: Parameters<NonNullable<ProposalDeploymentPort["withdraw"]>>[0]): Promise<{ readonly restored: boolean }> {
    let lookup: HomeAutomationMigrationDeploymentLookup;
    try {
      lookup = this.runtime.findWorkflowForProposal(request.proposalId);
    } catch {
      return { restored: false };
    }
    if (lookup.status === "not_migration") {
      return this.base.withdraw?.(request) ?? { restored: false };
    }
    if (lookup.status !== "governed" || lookup.workflowStatus !== "verified"
      || lookup.deploymentId !== request.deploymentId || lookup.deploymentTarget !== request.target) {
      return { restored: false };
    }
    const rollbackOperationId = operationId("rollback", request.proposalId, request.deploymentId, lookup);
    if (!this.runtime.startRuleRollback({
      migrationId: lookup.migrationId,
      ruleRef: lookup.ruleRef,
      rollbackOperationId,
      rollbackActor: request.actor,
    })) return { restored: false };
    const control = this.source.foreignRuleControlFor(lookup.sourceBridgeId);
    if (control === undefined) {
      this.fail(lookup, "rolling_back", "rollback_unknown");
      return { restored: false };
    }
    let withdrawn: { readonly restored: boolean };
    try {
      withdrawn = await this.base.withdraw?.(request) ?? { restored: false };
    } catch {
      this.fail(lookup, "rolling_back", "rollback_unknown");
      return { restored: false };
    }
    if (!withdrawn.restored) {
      this.fail(lookup, "rolling_back", "rollback_failed");
      return { restored: false };
    }
    const restored = await this.setSource(control, lookup, true, rollbackOperationId);
    if (restored.status === "unknown") {
      this.fail(lookup, "rolling_back", "rollback_unknown");
      return { restored: false };
    }
    if (restored.status !== "running" || restored.sourceFingerprint !== lookup.sourceFingerprint) {
      this.fail(lookup, "rolling_back", "rollback_failed");
      return { restored: false };
    }
    if (!this.runtime.restoreRule({ migrationId: lookup.migrationId, ruleRef: lookup.ruleRef })) {
      this.fail(lookup, "rolling_back", "rollback_unknown");
      return { restored: false };
    }
    return { restored: true };
  }

  private fail(
    lookup: Exclude<HomeAutomationMigrationDeploymentLookup, { readonly status: "not_migration" | "ambiguous" }>,
    from: "ready" | "switching" | "verified" | "rolling_back",
    reason: HomeAutomationMigrationRuleWorkflowFailureReason,
  ): void {
    try {
      this.runtime.failRuleWorkflow({ migrationId: lookup.migrationId, ruleRef: lookup.ruleRef, from, reason });
    } catch {
      // The durable CAS remains the source of truth if a concurrent writer wins.
    }
  }

  private async recoverKnownFailure(
    request: Parameters<ProposalDeploymentPort["deploy"]>[0],
    lookup: Extract<HomeAutomationMigrationDeploymentLookup, { readonly status: "ready" | "governed" }>,
    control: ForeignRuleControlHandle,
    failure: "switch_failed" | "verification_failed",
  ): Promise<"known" | "switch_unknown"> {
    let withdrawn: { readonly restored: boolean };
    try {
      withdrawn = await this.base.withdraw?.({
        proposalId: request.proposalId,
        deploymentId: request.intent.deploymentId,
        target: request.intent.target,
        actor: request.actor,
      }) ?? { restored: false };
    } catch {
      this.fail(lookup, "switching", "switch_unknown");
      return "switch_unknown";
    }
    if (!withdrawn.restored) {
      this.fail(lookup, "switching", failure);
      return "known";
    }
    const restored = await this.setSource(control, lookup, true, operationId("restore", request.proposalId, request.revision, lookup));
    if (restored.status === "unknown") {
      this.fail(lookup, "switching", "switch_unknown");
      return "switch_unknown";
    }
    if (restored.status !== "running" || restored.sourceFingerprint !== lookup.sourceFingerprint) {
      this.fail(lookup, "switching", failure);
      return "known";
    }
    this.fail(lookup, "switching", failure);
    return "known";
  }

  private async setSource(
    control: ForeignRuleControlHandle,
    lookup: Exclude<HomeAutomationMigrationDeploymentLookup, { readonly status: "not_migration" | "ambiguous" }>,
    enabled: boolean,
    operationIdValue: string,
  ): Promise<{
    readonly status: "running" | "paused" | "rejected" | "unknown";
    readonly sourceFingerprint?: string;
  }> {
    try {
      const result = await control.setEnabled({
        ruleRef: lookup.ruleRef,
        expectedSourceFingerprint: lookup.sourceFingerprint,
        enabled,
        operationId: operationIdValue,
      }, { signal: AbortSignal.timeout(15_000) });
      return sourceCommandResult(result);
    } catch {
      return { status: "unknown" };
    }
  }

  private async readSource(control: ForeignRuleControlHandle, ruleRef: string): Promise<ForeignRuleControlStatusResult> {
    try {
      return await control.status({ ruleRef }, { signal: AbortSignal.timeout(10_000) });
    } catch {
      return { status: "unknown", reason: "unavailable" };
    }
  }

  private async readTarget(deploymentId: string, target: string): Promise<{ readonly status: "running" | "paused" | "missing" | "unknown"; readonly configFingerprint?: string }> {
    try {
      return await this.base.status?.({ deploymentId, target }) ?? { status: "unknown" };
    } catch {
      return { status: "unknown" };
    }
  }
}

function sourceCommandResult(
  result: ForeignRuleControlSetEnabledResult,
): { readonly status: "running" | "paused" | "rejected" | "unknown"; readonly sourceFingerprint?: string } {
  if ((result.status === "running" || result.status === "paused") && typeof result.sourceFingerprint === "string") {
    return result;
  }
  if (result.status === "rejected") return { status: "rejected" };
  return { status: "unknown" };
}

function failed(reason: string): { readonly status: "failed"; readonly reason: string } {
  return { status: "failed", reason };
}

function operationId(
  kind: "switch" | "rollback" | "restore",
  proposalId: string,
  revision: number | string,
  lookup: Exclude<HomeAutomationMigrationDeploymentLookup, { readonly status: "not_migration" | "ambiguous" }>,
): string {
  return createHash("sha256")
    .update(`${kind}\u0000${lookup.migrationId}\u0000${lookup.ruleRef}\u0000${proposalId}\u0000${revision}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}
