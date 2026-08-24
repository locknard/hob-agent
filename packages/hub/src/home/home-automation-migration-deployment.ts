import { createHash } from "node:crypto";

import type {
  ForeignRuleControlHandle,
  ForeignRuleControlSetEnabledResult,
  ForeignRuleControlStatusResult,
} from "@hob/bridge-contract";

import type {
  ProposalDeploymentPort,
  ProposalDeploymentReconciliationDisposition,
  ProposalDeploymentReconciliationResult,
} from "./home-proposal-service.js";
import type { HomeAutomationMigrationFailRuleWorkflowInput } from "./home-automation-migration-service.js";
import type {
  HomeAutomationMigrationRuleWorkflowFailureReason,
  HomeAutomationMigrationRuleWorkflowStatus,
} from "./home-automation-migration.js";

/** The neutral source-control lookup owned by HomeWorld. */
export interface HomeAutomationMigrationSourceControlPort {
  foreignRuleControlFor(bridgeId: string): ForeignRuleControlHandle | undefined;
}

/** Exact behavior-set drift state for foreign rules other than the migrated source. */
export type HomeAutomationMigrationForeignRuleCatalogState =
  | { readonly status: "unchanged" }
  | { readonly status: "changed" }
  | { readonly status: "unavailable" };

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
      readonly switchOperationId?: string;
      readonly switchActor?: string;
      readonly sourceWasEnabled?: true;
      readonly switchStartedAt?: string;
      readonly deploymentId?: string;
      readonly deploymentTarget?: string;
      readonly deploymentConfigFingerprint?: string;
      readonly rollbackOperationId?: string;
      readonly rollbackActor?: string;
      readonly rollbackStartedAt?: string;
      readonly failureReason?: HomeAutomationMigrationRuleWorkflowFailureReason;
    });

/** Narrow runtime query/mutation seam. It never performs a bridge write. */
export interface HomeAutomationMigrationDeploymentRuntimePort {
  findWorkflowForProposal(proposalId: string): HomeAutomationMigrationDeploymentLookup;
  /**
   * Reads the current same-bridge catalog against the assessment cut. The
   * source rule is excluded because the cutover intentionally pauses it;
   * only another rule's reference or enabled state can change this set.
   */
  readForeignRuleCatalog(input: {
    readonly migrationId: string;
    readonly ruleRef: string;
  }): Promise<HomeAutomationMigrationForeignRuleCatalogState> | HomeAutomationMigrationForeignRuleCatalogState;
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
    readonly expectedSwitchOperationId: string;
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
  resumeRuleSwitch(input: {
    readonly migrationId: string;
    readonly ruleRef: string;
    readonly switchOperationId: string;
    readonly switchActor: string;
  }): boolean;
  restoreFailedSwitch(input: {
    readonly migrationId: string;
    readonly ruleRef: string;
    readonly expectedApprovedProposalRevision: number;
    readonly expectedFailureReason: "switch_failed" | "switch_unknown";
    readonly expectedSwitchOperationId: string;
    readonly expectedSwitchStartedAt: string;
  }): boolean;
  resumeRuleRollback(input: {
    readonly migrationId: string;
    readonly ruleRef: string;
    readonly rollbackOperationId: string;
    readonly rollbackActor: string;
  }): boolean;
  restoreRule(input: {
    readonly migrationId: string;
    readonly ruleRef: string;
    readonly from: "rolling_back";
    readonly expectedRollbackOperationId: string;
  }): boolean;
  failRuleWorkflow(input: HomeAutomationMigrationFailRuleWorkflowInput): boolean;
}

const SWITCH_FAILURE_REASON = "迁移切换没有完成，原有规则保持可恢复状态。";
const SWITCH_UNKNOWN_REASON = "迁移切换结果暂时无法确认，已停止后续写入。";
const ROLLBACK_FAILURE_REASON = "迁移回退没有完成，原有规则状态需要处理。";
const ROLLBACK_UNKNOWN_REASON = "迁移回退结果暂时无法确认，已停止后续写入。";
const ROLLBACK_TARGET_FINGERPRINT_FAILURE_REASON = "迁移回退的目标指纹无法验证，需要人工确认后恢复。";
const SWITCH_TARGET_FINGERPRINT_FAILURE_REASON = "迁移自动化的部署指纹无法验证，已停止后续写入。";
const SEMANTIC_PREFLIGHT_FAILURE_REASON = "方案里的设备当前状态或能力语义已经变化，需要重新准备后再启用；家里的设置保持原样。";
const FOREIGN_RULE_CATALOG_PREFLIGHT_FAILURE_REASON = "现有规则状态已经变化或暂时无法确认，需要重新准备迁移；家里的设置保持原样。";
const FOREIGN_RULE_CATALOG_CHANGED_REASON = "现有规则目录发生变化，需要重新评估后再继续运行。";
const FOREIGN_RULE_CATALOG_UNAVAILABLE_REASON = "现有规则冲突状态暂时无法确认，需要继续恢复迁移状态。";

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

  preflight(request: Parameters<NonNullable<ProposalDeploymentPort["preflight"]>>[0]): ReturnType<NonNullable<ProposalDeploymentPort["preflight"]>> {
    if (this.base.preflight === undefined) {
      return { status: "blocked", reason: "invalid_plan" };
    }
    return this.base.preflight(request);
  }

  reconciliationGuard(
    request: Parameters<NonNullable<ProposalDeploymentPort["reconciliationGuard"]>>[0],
  ): ProposalDeploymentReconciliationDisposition {
    let lookup: HomeAutomationMigrationDeploymentLookup;
    try {
      lookup = this.runtime.findWorkflowForProposal(request.proposalId);
    } catch {
      return "defer";
    }
    if (lookup.status === "not_migration") return "allow";
    // Once a migration is durably verified, active and paused proposal rows
    // need the ordinary target readback so bridge-ready reconciliation can
    // surface native edits, while cutover/recovery windows remain guarded.
    if (lookup.status === "governed"
      && lookup.workflowStatus === "verified"
      && (request.lifecycle === "active" || request.lifecycle === "paused")) {
      return "allow";
    }
    if (lookup.status === "governed"
      && hasVerifiedFailureReceipt(lookup)
      && (request.lifecycle === "active" || request.lifecycle === "paused")) {
      return "allow";
    }
    return "defer";
  }

  async reconcileStatus(
    request: Parameters<NonNullable<ProposalDeploymentPort["reconcileStatus"]>>[0],
  ): Promise<ProposalDeploymentReconciliationResult> {
    let lookup: HomeAutomationMigrationDeploymentLookup;
    try {
      lookup = this.runtime.findWorkflowForProposal(request.proposalId);
    } catch {
      return { disposition: "defer" };
    }
    if (lookup.status === "not_migration") {
      return { disposition: "observed", target: await this.readTarget(request.deploymentId, request.target) };
    }
    if (lookup.status === "governed"
      && hasVerifiedFailureReceipt(lookup)
      && sameDeploymentIdentity(request.deploymentId, lookup.deploymentId)
      && sameDeploymentIdentity(request.target, lookup.deploymentTarget)) {
      return { disposition: "recovery_required", reason: "迁移自动化的验证失败需要继续恢复。" };
    }
    if (lookup.status !== "governed"
      || lookup.workflowStatus !== "verified"
      || (request.lifecycle !== "active" && request.lifecycle !== "paused")
      || !sameDeploymentIdentity(request.deploymentId, lookup.deploymentId)
      || !sameDeploymentIdentity(request.target, lookup.deploymentTarget)
      || !hasNonEmptyString(lookup.sourceBridgeId)
      || !hasNonEmptyString(lookup.ruleRef)
      || !hasNonEmptyString(lookup.sourceFingerprint)
      || !hasNonEmptyString(lookup.deploymentConfigFingerprint)
      || !hasNonEmptyString(lookup.switchOperationId)) {
      return { disposition: "defer" };
    }

    let foreignRuleCatalog: HomeAutomationMigrationForeignRuleCatalogState;
    try {
      foreignRuleCatalog = await this.runtime.readForeignRuleCatalog({
        migrationId: lookup.migrationId,
        ruleRef: lookup.ruleRef,
      });
    } catch {
      return this.verifiedReconciliationFailure(lookup, FOREIGN_RULE_CATALOG_UNAVAILABLE_REASON);
    }
    if (foreignRuleCatalog.status === "unavailable") {
      return this.verifiedReconciliationFailure(lookup, FOREIGN_RULE_CATALOG_UNAVAILABLE_REASON);
    }
    if (foreignRuleCatalog.status === "changed") {
      return this.verifiedReconciliationFailure(lookup, FOREIGN_RULE_CATALOG_CHANGED_REASON);
    }

    let control: ForeignRuleControlHandle | undefined;
    try {
      control = this.source.foreignRuleControlFor(lookup.sourceBridgeId);
    } catch {
      return this.verifiedReconciliationFailure(lookup, "迁移自动化的运行状态暂时无法确认，需要继续恢复。");
    }
    if (control === undefined) {
      return this.verifiedReconciliationFailure(lookup, "迁移自动化的运行状态暂时无法确认，需要继续恢复。");
    }
    const source = await this.readSource(control, lookup.ruleRef);
    const target = await this.readTarget(request.deploymentId, request.target);
    if (source.status === "unknown" || target.status === "unknown") {
      return this.verifiedReconciliationFailure(lookup, "迁移自动化的运行状态暂时无法确认，需要继续恢复。");
    }
    if (source.status === "missing" || source.sourceFingerprint !== lookup.sourceFingerprint) {
      return this.verifiedReconciliationFailure(lookup, "原有规则的运行状态发生变化，需要继续恢复。");
    }
    if (target.status === "missing") {
      return this.verifiedReconciliationFailure(lookup, "迁移自动化已经不在目标平台，需要继续恢复原有规则。");
    }
    if (!hasNonEmptyString(target.configFingerprint)) {
      return this.verifiedReconciliationFailure(lookup, "迁移自动化的配置指纹暂时无法确认，需要继续恢复。");
    }
    if (source.status === "running") {
      return this.verifiedReconciliationFailure(lookup, "原有规则已经重新运行，需要继续恢复迁移状态。");
    }
    return { disposition: "observed", target };
  }

  async deploy(request: Parameters<ProposalDeploymentPort["deploy"]>[0]): Promise<Awaited<ReturnType<ProposalDeploymentPort["deploy"]>>> {
    let lookup: HomeAutomationMigrationDeploymentLookup;
    try {
      lookup = this.runtime.findWorkflowForProposal(request.proposalId);
    } catch {
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (lookup.status === "not_migration") return this.base.deploy(request);
    if (lookup.status === "governed") {
      if (lookup.workflowStatus === "verified") {
        return this.verifyVerifiedDeployment(request, lookup);
      }
      if (lookup.workflowStatus === "needs_attention"
        && (lookup.failureReason === "switch_failed" || lookup.failureReason === "switch_unknown")) {
        return this.recoverFailedSwitchDeployment(request, lookup);
      }
      if ((lookup.workflowStatus === "switching")
        || (lookup.workflowStatus === "needs_attention"
          && (lookup.failureReason === "switch_failed"
            || lookup.failureReason === "switch_unknown"
            || lookup.failureReason === "verification_failed" && lookup.deploymentId === undefined))) {
        return this.recoverSwitchDeployment(request, lookup);
      }
      return failed("迁移方案当前处于受管状态，不能重复启用。");
    }
    if (lookup.status !== "ready") return failed("迁移方案当前处于受管状态，不能重复启用。");
    if (request.revision !== lookup.reviewProposalRevision + 1) {
      return failed("迁移方案的批准版本已经变化，需要重新准备。");
    }

    const semanticPreflight = await this.readSemanticPreflight(request);
    if (semanticPreflight.status === "blocked") return failed(SEMANTIC_PREFLIGHT_FAILURE_REASON);

    let foreignRuleCatalog: HomeAutomationMigrationForeignRuleCatalogState;
    try {
      foreignRuleCatalog = await this.runtime.readForeignRuleCatalog({
        migrationId: lookup.migrationId,
        ruleRef: lookup.ruleRef,
      });
    } catch {
      this.fail(lookup, "ready", "source_stale");
      return failed(FOREIGN_RULE_CATALOG_PREFLIGHT_FAILURE_REASON);
    }
    if (foreignRuleCatalog.status !== "unchanged") {
      this.fail(lookup, "ready", "source_stale");
      return failed(FOREIGN_RULE_CATALOG_PREFLIGHT_FAILURE_REASON);
    }

    let control: ForeignRuleControlHandle | undefined;
    try {
      control = this.source.foreignRuleControlFor(lookup.sourceBridgeId);
    } catch {
      this.fail(lookup, "ready", "switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
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
      this.fail(lookup, "switching", reason, switchOperationId);
      return failed(reason === "switch_unknown" ? SWITCH_UNKNOWN_REASON : SWITCH_FAILURE_REASON);
    }

    let outcome: Awaited<ReturnType<ProposalDeploymentPort["deploy"]>>;
    try {
      outcome = await this.base.deploy({
        ...request,
        operationId: targetAutomationOperationId("deploy", switchOperationId),
      });
    } catch {
      this.fail(lookup, "switching", "switch_unknown", switchOperationId);
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (outcome.status !== "verified") {
      const recovered = await this.recoverKnownFailure(request, lookup, control, "switch_failed", switchOperationId);
      return failed(recovered === "switch_unknown" ? SWITCH_UNKNOWN_REASON : SWITCH_FAILURE_REASON);
    }
    if (outcome.deploymentId === undefined || outcome.target === undefined || outcome.configFingerprint === undefined
      || outcome.deploymentId !== request.intent.deploymentId || outcome.target !== request.intent.target) {
      const recovered = await this.recoverKnownFailure(request, lookup, control, "verification_failed", switchOperationId);
      return failed(recovered === "switch_unknown" ? SWITCH_UNKNOWN_REASON : "迁移自动化的部署身份无法验证，已停止后续写入。");
    }

    const target = await this.readTarget(outcome.deploymentId, outcome.target);
    if (target.status === "unknown") {
      this.fail(lookup, "switching", "switch_unknown", switchOperationId);
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (target.status !== "running" || target.configFingerprint !== outcome.configFingerprint) {
      const recovered = await this.recoverKnownFailure(request, lookup, control, "verification_failed", switchOperationId);
      return failed(recovered === "switch_unknown" ? SWITCH_UNKNOWN_REASON : "迁移自动化的运行状态无法验证，已停止后续写入。");
    }

    const after = await this.readSource(control, lookup.ruleRef);
    if (after.status === "unknown") {
      this.fail(lookup, "switching", "switch_unknown", switchOperationId);
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (after.status !== "paused" || after.sourceFingerprint !== lookup.sourceFingerprint) {
      const recovered = await this.recoverKnownFailure(request, lookup, control, "verification_failed", switchOperationId);
      return failed(recovered === "switch_unknown" ? SWITCH_UNKNOWN_REASON : "原有规则的暂停状态无法验证，已停止后续写入。");
    }
    if (!this.runtime.verifyRuleSwitch({
      migrationId: lookup.migrationId,
      ruleRef: lookup.ruleRef,
      expectedSwitchOperationId: switchOperationId,
      deploymentId: outcome.deploymentId,
      deploymentTarget: outcome.target,
      deploymentConfigFingerprint: outcome.configFingerprint,
    })) {
      this.fail(lookup, "switching", "switch_unknown", switchOperationId);
      return failed(SWITCH_UNKNOWN_REASON);
    }
    return outcome;
  }

  private async recoverFailedSwitchDeployment(
    request: Parameters<ProposalDeploymentPort["deploy"]>[0],
    lookup: Extract<HomeAutomationMigrationDeploymentLookup, { readonly status: "governed" }>,
  ): Promise<Awaited<ReturnType<ProposalDeploymentPort["deploy"]>>> {
    const semanticPreflight = await this.readSemanticPreflight(request);
    if (semanticPreflight.status === "blocked") return failed(SEMANTIC_PREFLIGHT_FAILURE_REASON);
    const recovery = await this.reconcileFailedSwitch({
      proposalId: request.proposalId,
      deploymentId: request.intent.deploymentId,
      target: request.intent.target,
      actor: request.actor,
      lookup,
    });
    if (recovery.restored) {
      return failed(lookup.failureReason === "switch_unknown" ? SWITCH_UNKNOWN_REASON : SWITCH_FAILURE_REASON);
    }
    return failed(recovery.reason ?? SWITCH_UNKNOWN_REASON);
  }

  /**
   * Reconciles a failed switch using only the approved neutral deployment
   * identity. It never recreates a target whose identity was not verified.
   */
  private async reconcileFailedSwitch(request: FailedSwitchRecoveryRequest): Promise<FailedSwitchRecoveryResult> {
    if (request.lookup.status !== "governed") {
      return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    }
    const failureReason = request.lookup.failureReason;
    if (!isFailedSwitchReason(failureReason) || failedSwitchReceipt(request.lookup, failureReason) === undefined) {
      return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    }

    let control: ForeignRuleControlHandle | undefined;
    try {
      control = this.source.foreignRuleControlFor(request.lookup.sourceBridgeId);
    } catch {
      return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    }
    if (control === undefined) return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };

    const source = await this.readSource(control, request.lookup.ruleRef);
    if (source.status === "unknown") {
      return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    }
    if (source.status === "missing" || source.sourceFingerprint !== request.lookup.sourceFingerprint) {
      return { restored: false, recoveryRequired: true, reason: "原有规则的来源已经变化，需要人工确认后恢复。" };
    }
    const target = await this.readTarget(request.deploymentId, request.target);
    if (target.status === "unknown") {
      return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    }
    const targetCheck = switchTargetCheck(target, request.lookup.deploymentConfigFingerprint);
    if (targetCheck.status === "unsafe") {
      return { restored: false, recoveryRequired: true, reason: targetCheck.reason };
    }

    // An already restored readback can close the durable failure without a new
    // source command or a replay of the target deployment.
    if (source.status === "running" && target.status === "missing") {
      return this.restoreFailedSwitchAfterReadback(request, failureReason);
    }

    const switchOperationId = recoverySwitchOperationId(
      request.proposalId,
      `recovery:${request.deploymentId}:${request.target}`,
      request.lookup,
    );
    if (!this.runtime.resumeRuleSwitch({
      migrationId: request.lookup.migrationId,
      ruleRef: request.lookup.ruleRef,
      switchOperationId,
      switchActor: request.actor,
    })) {
      return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    }

    if (target.status === "running") {
      let withdrawn: { readonly restored: boolean };
      try {
        if (this.base.withdraw === undefined) {
          this.fail(request.lookup, "switching", failureReason, switchOperationId);
          return { restored: false, recoveryRequired: true, reason: SWITCH_FAILURE_REASON };
        }
        withdrawn = await this.base.withdraw({
          proposalId: request.proposalId,
          deploymentId: request.deploymentId,
          target: request.target,
          actor: request.actor,
          operationId: targetAutomationOperationId("withdraw", switchOperationId),
        });
      } catch {
        this.fail(request.lookup, "switching", "switch_unknown", switchOperationId);
        return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
      }
      if (!withdrawn.restored) {
        this.fail(request.lookup, "switching", failureReason, switchOperationId);
        return { restored: false, recoveryRequired: true, reason: SWITCH_FAILURE_REASON };
      }
      const afterWithdraw = await this.readTarget(request.deploymentId, request.target);
      if (afterWithdraw.status === "unknown") {
        this.fail(request.lookup, "switching", "switch_unknown", switchOperationId);
        return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
      }
      if (afterWithdraw.status !== "missing") {
        this.fail(request.lookup, "switching", failureReason, switchOperationId);
        return { restored: false, recoveryRequired: true, reason: SWITCH_FAILURE_REASON };
      }
    }

    if (source.status === "paused") {
      const restored = await this.setSource(control, request.lookup, true, switchOperationId);
      if (restored.status === "unknown") {
        this.fail(request.lookup, "switching", "switch_unknown", switchOperationId);
        return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
      }
      if (restored.status !== "running" || restored.sourceFingerprint !== request.lookup.sourceFingerprint) {
        this.fail(request.lookup, "switching", failureReason, switchOperationId);
        return { restored: false, recoveryRequired: true, reason: SWITCH_FAILURE_REASON };
      }
    }

    const finalSource = await this.readSource(control, request.lookup.ruleRef);
    const finalTarget = await this.readTarget(request.deploymentId, request.target);
    if (finalSource.status === "unknown" || finalTarget.status === "unknown") {
      this.fail(request.lookup, "switching", "switch_unknown", switchOperationId);
      return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    }
    if (finalSource.status !== "running" || finalSource.sourceFingerprint !== request.lookup.sourceFingerprint
      || finalTarget.status !== "missing") {
      this.fail(request.lookup, "switching", failureReason, switchOperationId);
      return { restored: false, recoveryRequired: true, reason: SWITCH_FAILURE_REASON };
    }
    this.fail(request.lookup, "switching", failureReason, switchOperationId);
    return this.restoreFailedSwitchAfterReadback(request, failureReason);
  }

  private restoreFailedSwitchAfterReadback(
    request: FailedSwitchRecoveryRequest,
    failureReason: "switch_failed" | "switch_unknown",
  ): FailedSwitchRecoveryResult {
    try {
      const refreshed = this.runtime.findWorkflowForProposal(request.proposalId);
      const receipt = refreshed.status === "governed" ? failedSwitchReceipt(refreshed, failureReason) : undefined;
      if (receipt === undefined || !this.runtime.restoreFailedSwitch(receipt)) {
        return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
      }
      return { restored: true };
    } catch {
      return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    }
  }

  private async recoverSwitchDeployment(
    request: Parameters<ProposalDeploymentPort["deploy"]>[0],
    lookup: Extract<HomeAutomationMigrationDeploymentLookup, { readonly status: "governed" }>,
  ): Promise<Awaited<ReturnType<ProposalDeploymentPort["deploy"]>>> {
    const failPreflight = (reason: "switch_failed" | "switch_unknown" | "verification_failed"): void => {
      if (lookup.workflowStatus === "switching") this.fail(lookup, "switching", reason);
    };
    const semanticPreflight = await this.readSemanticPreflight(request);
    if (semanticPreflight.status === "blocked") {
      failPreflight("verification_failed");
      return failed(SEMANTIC_PREFLIGHT_FAILURE_REASON);
    }
    const control = this.source.foreignRuleControlFor(lookup.sourceBridgeId);
    if (control === undefined) {
      failPreflight("switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
    const source = await this.readSource(control, lookup.ruleRef);
    if (source.status === "unknown") {
      failPreflight("switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (source.status === "missing" || source.sourceFingerprint !== lookup.sourceFingerprint) {
      failPreflight("switch_failed");
      return failed("原有规则的来源已经变化，需要重新准备迁移。");
    }
    const target = await this.readTarget(request.intent.deploymentId, request.intent.target);
    if (target.status === "unknown") {
      failPreflight("switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
    const expectedFingerprint = lookup.deploymentConfigFingerprint;
    const targetCheck = switchTargetCheck(target, expectedFingerprint);
    if (targetCheck.status === "unsafe") {
      failPreflight(targetCheck.failureReason);
      return failed(targetCheck.reason);
    }

    const switchOperationId = recoverySwitchOperationId(request.proposalId, `recovery:${request.revision}`, lookup);
    const failSwitch = (reason: "switch_failed" | "switch_unknown" | "verification_failed"): void => {
      this.fail(lookup, "switching", reason, switchOperationId);
    };
    // A crash can leave the durable workflow in switching. Close that active
    // receipt with a strict CAS before opening a fresh recovery receipt.
    if (lookup.workflowStatus === "switching") this.fail(lookup, "switching", "switch_unknown");
    if (!this.runtime.resumeRuleSwitch({
      migrationId: lookup.migrationId,
      ruleRef: lookup.ruleRef,
      switchOperationId,
      switchActor: request.actor,
    })) return failed(SWITCH_UNKNOWN_REASON);

    if (target.status === "paused") {
      const targetBeforeCleanup = await this.readTarget(request.intent.deploymentId, request.intent.target);
      const targetBeforeCleanupCheck = switchTargetCheck(targetBeforeCleanup, expectedFingerprint);
      if (targetBeforeCleanupCheck.status === "unsafe") {
        failSwitch(targetBeforeCleanupCheck.failureReason);
        return failed(targetBeforeCleanupCheck.reason);
      }
      if (targetBeforeCleanupCheck.status !== "missing") {
        let withdrawn: { readonly restored: boolean };
        try {
          if (this.base.withdraw === undefined) {
            failSwitch("switch_failed");
            return failed(SWITCH_FAILURE_REASON);
          }
          withdrawn = await this.base.withdraw({
            proposalId: request.proposalId,
            deploymentId: request.intent.deploymentId,
            target: request.intent.target,
            actor: request.actor,
            operationId: targetAutomationOperationId("withdraw", switchOperationId),
          });
        } catch {
          failSwitch("switch_unknown");
          return failed(SWITCH_UNKNOWN_REASON);
        }
        if (!withdrawn.restored) {
          failSwitch("switch_failed");
          return failed(SWITCH_FAILURE_REASON);
        }
        const afterWithdraw = await this.readTarget(request.intent.deploymentId, request.intent.target);
        if (afterWithdraw.status === "unknown") {
          failSwitch("switch_unknown");
          return failed(SWITCH_UNKNOWN_REASON);
        }
        if (afterWithdraw.status !== "missing") {
          failSwitch("switch_failed");
          return failed(SWITCH_FAILURE_REASON);
        }
      }
      if (source.status === "paused") {
        const restored = await this.setSource(control, lookup, true, switchOperationId);
        if (restored.status === "unknown") {
          failSwitch("switch_unknown");
          return failed(SWITCH_UNKNOWN_REASON);
        }
        if (restored.status !== "running" || restored.sourceFingerprint !== lookup.sourceFingerprint) {
          failSwitch("switch_failed");
          return failed(SWITCH_FAILURE_REASON);
        }
      }
      const finalSource = await this.readSource(control, lookup.ruleRef);
      if (finalSource.status === "unknown") {
        failSwitch("switch_unknown");
        return failed(SWITCH_UNKNOWN_REASON);
      }
      if (finalSource.status !== "running" || finalSource.sourceFingerprint !== lookup.sourceFingerprint) {
        failSwitch("switch_failed");
        return failed(SWITCH_FAILURE_REASON);
      }
      failSwitch("switch_failed");
      return failed(SWITCH_FAILURE_REASON);
    }

    if (target.status === "missing" && source.status === "paused") {
      const restored = await this.setSource(control, lookup, true, switchOperationId);
      if (restored.status === "unknown") {
        failSwitch("switch_unknown");
        return failed(SWITCH_UNKNOWN_REASON);
      }
      if (restored.status !== "running" || restored.sourceFingerprint !== lookup.sourceFingerprint) {
        failSwitch("switch_failed");
        return failed(SWITCH_FAILURE_REASON);
      }
      const finalSource = await this.readSource(control, lookup.ruleRef);
      if (finalSource.status === "unknown") {
        failSwitch("switch_unknown");
        return failed(SWITCH_UNKNOWN_REASON);
      }
      failSwitch(finalSource.status === "running" && finalSource.sourceFingerprint === lookup.sourceFingerprint
        ? "switch_failed"
        : "switch_unknown");
      return failed(finalSource.status === "running" && finalSource.sourceFingerprint === lookup.sourceFingerprint
        ? SWITCH_FAILURE_REASON
        : SWITCH_UNKNOWN_REASON);
    }

    if (target.status === "running") {
      if (source.status === "running") {
        const stopped = await this.setSource(control, lookup, false, switchOperationId);
        if (stopped.status === "unknown") {
          failSwitch("switch_unknown");
          return failed(SWITCH_UNKNOWN_REASON);
        }
        if (stopped.status !== "paused" || stopped.sourceFingerprint !== lookup.sourceFingerprint) {
          failSwitch("switch_failed");
          return failed(SWITCH_FAILURE_REASON);
        }
      }
      const finalTarget = await this.readTarget(request.intent.deploymentId, request.intent.target);
      const finalSource = await this.readSource(control, lookup.ruleRef);
      if (finalTarget.status === "unknown" || finalSource.status === "unknown") {
        failSwitch("switch_unknown");
        return failed(SWITCH_UNKNOWN_REASON);
      }
      if (finalTarget.status !== "running" || finalTarget.configFingerprint !== expectedFingerprint
        || finalSource.status !== "paused" || finalSource.sourceFingerprint !== lookup.sourceFingerprint) {
        const recovered = await this.recoverKnownFailure(request, lookup, control, "verification_failed", switchOperationId);
        return failed(recovered === "switch_unknown" ? SWITCH_UNKNOWN_REASON : "迁移自动化的运行状态无法验证，已停止后续写入。");
      }
      if (!this.runtime.verifyRuleSwitch({
        migrationId: lookup.migrationId,
        ruleRef: lookup.ruleRef,
        expectedSwitchOperationId: switchOperationId,
        deploymentId: request.intent.deploymentId,
        deploymentTarget: request.intent.target,
        deploymentConfigFingerprint: expectedFingerprint!,
    })) {
        failSwitch("switch_unknown");
        return failed(SWITCH_UNKNOWN_REASON);
      }
      return {
        status: "verified",
        deploymentId: request.intent.deploymentId,
        target: request.intent.target,
        configFingerprint: expectedFingerprint,
      };
    }

    // A known missing target and a running source can be safely re-created only
    // after a fresh recovery CAS and an explicit source pause readback.
    const stopped = await this.setSource(control, lookup, false, switchOperationId);
    if (stopped.status === "unknown") {
      failSwitch("switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (stopped.status !== "paused" || stopped.sourceFingerprint !== lookup.sourceFingerprint) {
      failSwitch("switch_failed");
      return failed(SWITCH_FAILURE_REASON);
    }
    let outcome: Awaited<ReturnType<ProposalDeploymentPort["deploy"]>>;
    try {
      outcome = await this.base.deploy({
        ...request,
        operationId: targetAutomationOperationId("deploy", switchOperationId),
      });
    } catch {
      failSwitch("switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (outcome.status !== "verified") {
      const recovered = await this.recoverKnownFailure(request, lookup, control, "switch_failed", switchOperationId);
      return failed(recovered === "switch_unknown" ? SWITCH_UNKNOWN_REASON : SWITCH_FAILURE_REASON);
    }
    if (outcome.deploymentId !== request.intent.deploymentId || outcome.target !== request.intent.target || outcome.configFingerprint === undefined) {
      const recovered = await this.recoverKnownFailure(request, lookup, control, "verification_failed", switchOperationId);
      return failed(recovered === "switch_unknown" ? SWITCH_UNKNOWN_REASON : "迁移自动化的部署身份无法验证，已停止后续写入。");
    }
    const finalTarget = await this.readTarget(request.intent.deploymentId, request.intent.target);
    const finalSource = await this.readSource(control, lookup.ruleRef);
    if (finalTarget.status === "unknown" || finalSource.status === "unknown") {
      failSwitch("switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (finalTarget.status !== "running" || finalTarget.configFingerprint !== outcome.configFingerprint
      || finalSource.status !== "paused" || finalSource.sourceFingerprint !== lookup.sourceFingerprint) {
      const recovered = await this.recoverKnownFailure(request, lookup, control, "verification_failed", switchOperationId);
      return failed(recovered === "switch_unknown" ? SWITCH_UNKNOWN_REASON : "迁移自动化的运行状态无法验证，已停止后续写入。");
    }
    if (!this.runtime.verifyRuleSwitch({
      migrationId: lookup.migrationId,
      ruleRef: lookup.ruleRef,
      expectedSwitchOperationId: switchOperationId,
      deploymentId: request.intent.deploymentId,
      deploymentTarget: request.intent.target,
      deploymentConfigFingerprint: outcome.configFingerprint,
    })) {
      failSwitch("switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
    return outcome;
  }

  private async verifyVerifiedDeployment(
    request: Parameters<ProposalDeploymentPort["deploy"]>[0],
    lookup: Extract<HomeAutomationMigrationDeploymentLookup, { readonly status: "governed" }>,
  ): Promise<Awaited<ReturnType<ProposalDeploymentPort["deploy"]>>> {
    if (lookup.approvedProposalRevision === undefined
      || request.revision !== lookup.approvedProposalRevision
      || !sameDeploymentIdentity(request.intent.deploymentId, lookup.deploymentId)
      || !sameDeploymentIdentity(request.intent.target, lookup.deploymentTarget)
      || !hasNonEmptyString(lookup.sourceBridgeId)
      || !hasNonEmptyString(lookup.ruleRef)
      || !hasNonEmptyString(lookup.sourceFingerprint)
      || typeof lookup.deploymentConfigFingerprint !== "string"
      || lookup.deploymentConfigFingerprint.length === 0) {
      return failed("迁移方案当前处于受管状态，不能重复启用。");
    }

    let control: ForeignRuleControlHandle | undefined;
    try {
      control = this.source.foreignRuleControlFor(lookup.sourceBridgeId);
    } catch {
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (control === undefined) return failed(SWITCH_UNKNOWN_REASON);

    const source = await this.readSource(control, lookup.ruleRef);
    const target = await this.readTarget(request.intent.deploymentId, request.intent.target);
    if (source.status === "unknown" || target.status === "unknown") {
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (source.status !== "paused"
      || source.sourceFingerprint !== lookup.sourceFingerprint
      || target.status !== "running"
      || target.configFingerprint !== lookup.deploymentConfigFingerprint) {
      return failed("迁移自动化的运行状态无法验证，已停止后续写入。");
    }
    return {
      status: "verified",
      deploymentId: lookup.deploymentId!,
      target: lookup.deploymentTarget!,
      configFingerprint: lookup.deploymentConfigFingerprint,
    };
  }

  /** Readback-driven recovery for an already-decided migration withdrawal. */
  async recover(request: Parameters<NonNullable<ProposalDeploymentPort["recover"]>>[0]): Promise<Awaited<ReturnType<NonNullable<ProposalDeploymentPort["recover"]>>>> {
    let lookup: HomeAutomationMigrationDeploymentLookup;
    try {
      lookup = this.runtime.findWorkflowForProposal(request.proposalId);
    } catch {
      return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
    }
    if (lookup.status === "not_migration") {
      const target = await this.readTarget(request.intent.deploymentId, request.intent.target);
      if (target.status === "missing") return { restored: true };
      if (target.status === "unknown") {
        return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
      }
      const withdrawn = await this.base.withdraw?.({
        proposalId: request.proposalId,
        deploymentId: request.intent.deploymentId,
        target: request.intent.target,
        actor: request.actor,
        operationId: ordinaryRecoveryAutomationOperationId(
          request.proposalId,
          request.revision,
          request.intent.deploymentId,
          request.intent.target,
        ),
      });
      return withdrawn ?? { restored: false };
    }
    if (lookup.status === "governed" && lookup.workflowStatus === "restored") {
      return this.verifyRestoredState(lookup, {
        deploymentId: request.intent.deploymentId,
        target: request.intent.target,
      });
    }
    if (lookup.status === "governed" && lookup.workflowStatus === "needs_attention"
      && isFailedSwitchReason(lookup.failureReason)) {
      if (!hasNonEmptyString(request.intent.deploymentId) || !hasNonEmptyString(request.intent.target)) {
        return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
      }
      return this.reconcileFailedSwitch({
        proposalId: request.proposalId,
        deploymentId: request.intent.deploymentId,
        target: request.intent.target,
        actor: request.actor,
        lookup,
      });
    }
    if (lookup.status !== "governed"
      || (lookup.workflowStatus !== "needs_attention" && lookup.workflowStatus !== "rolling_back")
      || (lookup.workflowStatus !== "rolling_back"
        && lookup.failureReason !== "verification_failed"
        && lookup.failureReason !== "rollback_failed"
        && lookup.failureReason !== "rollback_unknown")) {
      return { restored: false, recoveryRequired: true, reason: ROLLBACK_FAILURE_REASON };
    }
    const control = this.source.foreignRuleControlFor(lookup.sourceBridgeId);
    if (control === undefined) return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    const source = await this.readSource(control, lookup.ruleRef);
    const target = await this.readTarget(request.intent.deploymentId, request.intent.target);
    if (source.status === "unknown") {
      return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    }
    if (source.status === "missing" || source.sourceFingerprint !== lookup.sourceFingerprint) {
      return { restored: false, recoveryRequired: true, reason: "原有规则的来源已经变化，需要人工确认后恢复。" };
    }
    const targetBeforeRollback = rollbackTargetCheck(target, lookup.deploymentConfigFingerprint);
    if (targetBeforeRollback.status === "unsafe") {
      if (lookup.workflowStatus === "rolling_back") this.fail(lookup, "rolling_back", targetBeforeRollback.failureReason);
      return { restored: false, recoveryRequired: true, reason: targetBeforeRollback.reason };
    }
    const rollbackOperationId = operationId("rollback", request.proposalId, `recovery:${request.revision}`, lookup);
    const failRollback = (reason: "rollback_failed" | "rollback_unknown"): void => {
      this.fail(lookup, "rolling_back", reason, rollbackOperationId);
    };
    // Convert a crash-left active receipt to an explicit unknown before using
    // a fresh rollback receipt. This keeps recovery CAS-based and restart-safe.
    if (lookup.workflowStatus === "rolling_back") this.fail(lookup, "rolling_back", "rollback_unknown");
    if (!this.runtime.resumeRuleRollback({
      migrationId: lookup.migrationId,
      ruleRef: lookup.ruleRef,
      rollbackOperationId,
      rollbackActor: request.actor,
    })) {
      return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    }

    const targetBeforeDelete = await this.readTarget(request.intent.deploymentId, request.intent.target);
    const targetBeforeDeleteCheck = rollbackTargetCheck(targetBeforeDelete, lookup.deploymentConfigFingerprint);
    if (targetBeforeDeleteCheck.status === "unsafe") {
      failRollback(targetBeforeDeleteCheck.failureReason);
      return { restored: false, recoveryRequired: true, reason: targetBeforeDeleteCheck.reason };
    }
    if (targetBeforeDeleteCheck.status !== "missing") {
      let withdrawn: { readonly restored: boolean };
      try {
        withdrawn = await this.base.withdraw?.({
          proposalId: request.proposalId,
          deploymentId: request.intent.deploymentId,
          target: request.intent.target,
          actor: request.actor,
          operationId: targetAutomationOperationId("withdraw", rollbackOperationId),
        }) ?? { restored: false };
      } catch {
        failRollback("rollback_unknown");
        return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
      }
      if (!withdrawn.restored) {
        failRollback("rollback_failed");
        return { restored: false, recoveryRequired: true, reason: "迁移回退没有完成，原有规则状态需要处理。" };
      }
      const afterWithdraw = await this.readTarget(request.intent.deploymentId, request.intent.target);
      if (afterWithdraw.status === "unknown") {
        failRollback("rollback_unknown");
        return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
      }
      if (afterWithdraw.status !== "missing") {
        failRollback("rollback_failed");
        return { restored: false, recoveryRequired: true, reason: "迁移回退没有完成，目标自动化仍然存在。" };
      }
    }
    if (source.status !== "running") {
      const restored = await this.setSource(control, lookup, true, rollbackOperationId);
      if (restored.status === "unknown") {
        failRollback("rollback_unknown");
        return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
      }
      if (restored.status !== "running" || restored.sourceFingerprint !== lookup.sourceFingerprint) {
        failRollback("rollback_failed");
        return { restored: false, recoveryRequired: true, reason: "迁移回退没有完成，原有规则仍未恢复。" };
      }
    }
    const finalSource = await this.readSource(control, lookup.ruleRef);
    const finalTarget = await this.readTarget(request.intent.deploymentId, request.intent.target);
    if (finalSource.status === "unknown" || finalTarget.status === "unknown") {
      failRollback("rollback_unknown");
      return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    }
    if (finalSource.status !== "running" || finalSource.sourceFingerprint !== lookup.sourceFingerprint || finalTarget.status !== "missing") {
      failRollback("rollback_failed");
      return { restored: false, recoveryRequired: true, reason: "迁移回退的最终状态无法验证。" };
    }
    if (!this.runtime.restoreRule({
      migrationId: lookup.migrationId,
      ruleRef: lookup.ruleRef,
      from: "rolling_back",
      expectedRollbackOperationId: rollbackOperationId,
    })) {
      failRollback("rollback_unknown");
      return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    }
    return { restored: true };
  }

  status(request: Parameters<NonNullable<ProposalDeploymentPort["status"]>>[0]): ReturnType<NonNullable<ProposalDeploymentPort["status"]>> {
    return this.base.status?.(request) ?? { status: "unknown" };
  }

  private async readSemanticPreflight(
    request: Parameters<NonNullable<ProposalDeploymentPort["preflight"]>>[0],
  ): Promise<Awaited<ReturnType<NonNullable<ProposalDeploymentPort["preflight"]>>>> {
    if (this.base.preflight === undefined) return { status: "blocked", reason: "invalid_plan" };
    try {
      return await this.base.preflight(request);
    } catch {
      return { status: "blocked", reason: "invalid_plan" };
    }
  }

  pause(request: Parameters<NonNullable<ProposalDeploymentPort["pause"]>>[0]): ReturnType<NonNullable<ProposalDeploymentPort["pause"]>> {
    return this.base.pause?.(request);
  }

  resume(request: Parameters<NonNullable<ProposalDeploymentPort["resume"]>>[0]): ReturnType<NonNullable<ProposalDeploymentPort["resume"]>> {
    return this.base.resume?.(request);
  }

  async withdraw(request: Parameters<NonNullable<ProposalDeploymentPort["withdraw"]>>[0]): Promise<{ readonly restored: boolean; readonly recoveryRequired?: boolean; readonly reason?: string }> {
    let lookup: HomeAutomationMigrationDeploymentLookup;
    try {
      lookup = this.runtime.findWorkflowForProposal(request.proposalId);
    } catch {
      return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    }
    if (lookup.status === "not_migration") {
      return this.base.withdraw?.(request) ?? { restored: false };
    }
    if (lookup.status === "governed" && lookup.workflowStatus === "restored") {
      return this.verifyRestoredState(lookup, {
        deploymentId: request.deploymentId,
        target: request.target,
      });
    }
    if (lookup.status === "governed" && lookup.workflowStatus === "needs_attention"
      && isFailedSwitchReason(lookup.failureReason)) {
      if (!hasNonEmptyString(request.deploymentId) || !hasNonEmptyString(request.target)) {
        return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
      }
      return this.reconcileFailedSwitch({
        proposalId: request.proposalId,
        deploymentId: request.deploymentId,
        target: request.target,
        actor: request.actor,
        lookup,
      });
    }
    if (lookup.status !== "governed" || lookup.workflowStatus !== "verified"
      || lookup.deploymentId !== request.deploymentId || lookup.deploymentTarget !== request.target) {
      return { restored: false, recoveryRequired: true, reason: "迁移回退当前没有可恢复的中立状态。" };
    }
    if (typeof request.deploymentId !== "string" || request.deploymentId.length === 0
      || typeof request.target !== "string" || request.target.length === 0) {
      return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
    }
    const control = this.source.foreignRuleControlFor(lookup.sourceBridgeId);
    if (control === undefined) {
      this.fail(lookup, "verified", "verification_failed");
      return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
    }
    const sourceBefore = await this.readSource(control, lookup.ruleRef);
    const targetBefore = await this.readTarget(request.deploymentId, request.target);
    if (sourceBefore.status === "unknown" || targetBefore.status === "unknown") {
      this.fail(lookup, "verified", "verification_failed");
      return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
    }
    if (sourceBefore.status === "missing" || sourceBefore.sourceFingerprint !== lookup.sourceFingerprint) {
      this.fail(lookup, "verified", "verification_failed");
      return { restored: false, recoveryRequired: true, reason: "原有规则的来源已经变化，需要人工确认后恢复。" };
    }
    const targetBeforeRollback = rollbackTargetCheck(targetBefore, lookup.deploymentConfigFingerprint);
    if (targetBeforeRollback.status === "unsafe") {
      this.fail(lookup, "verified", "verification_failed");
      return { restored: false, recoveryRequired: true, reason: targetBeforeRollback.reason };
    }
    const rollbackOperationId = operationId("rollback", request.proposalId, request.deploymentId, lookup);
    const failRollback = (reason: "rollback_failed" | "rollback_unknown"): void => {
      this.fail(lookup, "rolling_back", reason, rollbackOperationId);
    };
    if (!this.runtime.startRuleRollback({
      migrationId: lookup.migrationId,
      ruleRef: lookup.ruleRef,
      rollbackOperationId,
      rollbackActor: request.actor,
    })) {
      this.fail(lookup, "verified", "verification_failed");
      return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
    }
    const targetBeforeDelete = await this.readTarget(request.deploymentId, request.target);
    const targetBeforeDeleteCheck = rollbackTargetCheck(targetBeforeDelete, lookup.deploymentConfigFingerprint);
    if (targetBeforeDeleteCheck.status === "unsafe") {
      failRollback(targetBeforeDeleteCheck.failureReason);
      return { restored: false, recoveryRequired: true, reason: targetBeforeDeleteCheck.reason };
    }
    if (targetBeforeDeleteCheck.status !== "missing") {
      let withdrawn: { readonly restored: boolean };
      try {
        if (this.base.withdraw === undefined) {
          failRollback("rollback_failed");
          return { restored: false, recoveryRequired: true, reason: ROLLBACK_FAILURE_REASON };
        }
        withdrawn = await this.base.withdraw({
          ...request,
          operationId: targetAutomationOperationId("withdraw", rollbackOperationId),
        });
      } catch {
        failRollback("rollback_unknown");
        return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
      }
      if (!withdrawn.restored) {
        failRollback("rollback_failed");
        return { restored: false, recoveryRequired: true, reason: ROLLBACK_FAILURE_REASON };
      }
      const afterWithdraw = await this.readTarget(request.deploymentId, request.target);
      if (afterWithdraw.status === "unknown") {
        failRollback("rollback_unknown");
        return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
      }
      if (afterWithdraw.status !== "missing") {
        failRollback("rollback_failed");
        return { restored: false, recoveryRequired: true, reason: "迁移回退没有完成，目标自动化仍然存在。" };
      }
    }
    if (sourceBefore.status === "paused") {
      const restored = await this.setSource(control, lookup, true, rollbackOperationId);
      if (restored.status === "unknown") {
        failRollback("rollback_unknown");
        return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
      }
      if (restored.status !== "running" || restored.sourceFingerprint !== lookup.sourceFingerprint) {
        failRollback("rollback_failed");
        return { restored: false, recoveryRequired: true, reason: ROLLBACK_FAILURE_REASON };
      }
    }
    const finalSource = await this.readSource(control, lookup.ruleRef);
    const finalTarget = await this.readTarget(request.deploymentId, request.target);
    if (finalSource.status === "unknown" || finalTarget.status === "unknown") {
      failRollback("rollback_unknown");
      return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
    }
    if (finalSource.status !== "running" || finalSource.sourceFingerprint !== lookup.sourceFingerprint
      || finalTarget.status !== "missing") {
      failRollback("rollback_failed");
      return { restored: false, recoveryRequired: true, reason: ROLLBACK_FAILURE_REASON };
    }
    if (!this.runtime.restoreRule({
      migrationId: lookup.migrationId,
      ruleRef: lookup.ruleRef,
      from: "rolling_back",
      expectedRollbackOperationId: rollbackOperationId,
    })) {
      failRollback("rollback_unknown");
      return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
    }
    return { restored: true };
  }

  private async verifyRestoredState(
    lookup: Extract<HomeAutomationMigrationDeploymentLookup, { readonly status: "governed" }>,
    request: { readonly deploymentId?: string; readonly target?: string },
  ): Promise<{ readonly restored: boolean; readonly recoveryRequired?: boolean; readonly reason?: string }> {
    if (!sameDeploymentIdentity(request.deploymentId, lookup.deploymentId)
      || !sameDeploymentIdentity(request.target, lookup.deploymentTarget)
      || !hasNonEmptyString(lookup.sourceBridgeId)
      || !hasNonEmptyString(lookup.ruleRef)
      || !hasNonEmptyString(lookup.sourceFingerprint)) {
      return { restored: false, recoveryRequired: true, reason: "迁移回退当前没有可恢复的中立状态。" };
    }

    let control: ForeignRuleControlHandle | undefined;
    try {
      control = this.source.foreignRuleControlFor(lookup.sourceBridgeId);
    } catch {
      return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
    }
    if (control === undefined) {
      return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
    }

    const source = await this.readSource(control, lookup.ruleRef);
    const target = await this.readTarget(request.deploymentId!, request.target!);
    if (source.status === "unknown" || target.status === "unknown") {
      return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
    }
    if (source.status !== "running" || source.sourceFingerprint !== lookup.sourceFingerprint || target.status !== "missing") {
      return { restored: false, recoveryRequired: true, reason: "迁移回退的最终状态无法验证。" };
    }
    return { restored: true };
  }

  private fail(
    lookup: Exclude<HomeAutomationMigrationDeploymentLookup, { readonly status: "not_migration" | "ambiguous" }>,
    from: "ready" | "switching" | "verified" | "rolling_back",
    reason: HomeAutomationMigrationRuleWorkflowFailureReason,
    expectedOperationId?: string,
  ): void {
    try {
      const base = { migrationId: lookup.migrationId, ruleRef: lookup.ruleRef };
      if (from === "ready") {
        if (reason !== "source_stale" && reason !== "switch_unknown") return;
        this.runtime.failRuleWorkflow({ ...base, from, reason });
        return;
      }
      if (from === "verified") {
        if (reason !== "verification_failed") return;
        const expectedSwitchOperationId = expectedOperationId
          ?? (lookup.status === "governed" ? lookup.switchOperationId : undefined);
        if (!hasNonEmptyString(expectedSwitchOperationId)) return;
        this.runtime.failRuleWorkflow({ ...base, from, reason, expectedSwitchOperationId });
        return;
      }
      if (from === "switching") {
        if (reason !== "switch_failed" && reason !== "switch_unknown" && reason !== "verification_failed") return;
        const expectedSwitchOperationId = expectedOperationId
          ?? (lookup.status === "governed" ? lookup.switchOperationId : undefined);
        if (!hasNonEmptyString(expectedSwitchOperationId)) return;
        this.runtime.failRuleWorkflow({ ...base, from, reason, expectedSwitchOperationId });
        return;
      }
      if (reason !== "rollback_failed" && reason !== "rollback_unknown") return;
      const expectedRollbackOperationId = expectedOperationId
        ?? (lookup.status === "governed" ? lookup.rollbackOperationId : undefined);
      if (!hasNonEmptyString(expectedRollbackOperationId)) return;
      this.runtime.failRuleWorkflow({ ...base, from, reason, expectedRollbackOperationId });
    } catch {
      // The durable CAS remains the source of truth if a concurrent writer wins.
    }
  }

  private async recoverKnownFailure(
    request: Parameters<ProposalDeploymentPort["deploy"]>[0],
    lookup: Extract<HomeAutomationMigrationDeploymentLookup, { readonly status: "ready" | "governed" }>,
    control: ForeignRuleControlHandle,
    failure: "switch_failed" | "verification_failed",
    expectedSwitchOperationId: string,
  ): Promise<"known" | "switch_unknown"> {
    const expectedFingerprint = lookup.status === "governed" ? lookup.deploymentConfigFingerprint : undefined;
    const target = await this.readTarget(request.intent.deploymentId, request.intent.target);
    const targetCheck = switchTargetCheck(target, expectedFingerprint);
    if (targetCheck.status === "unsafe") {
      this.fail(lookup, "switching", targetCheck.failureReason, expectedSwitchOperationId);
      return targetCheck.failureReason === "switch_unknown" ? "switch_unknown" : "known";
    }

    if (targetCheck.status !== "missing") {
      let withdrawn: { readonly restored: boolean };
      try {
        if (this.base.withdraw === undefined) {
          this.fail(lookup, "switching", failure, expectedSwitchOperationId);
          return "known";
        }
        withdrawn = await this.base.withdraw({
          proposalId: request.proposalId,
          deploymentId: request.intent.deploymentId,
          target: request.intent.target,
          actor: request.actor,
          operationId: targetAutomationOperationId("withdraw", expectedSwitchOperationId),
        });
      } catch {
        this.fail(lookup, "switching", "switch_unknown", expectedSwitchOperationId);
        return "switch_unknown";
      }
      if (!withdrawn.restored) {
        this.fail(lookup, "switching", failure, expectedSwitchOperationId);
        return "known";
      }
      const afterWithdraw = await this.readTarget(request.intent.deploymentId, request.intent.target);
      if (afterWithdraw.status === "unknown") {
        this.fail(lookup, "switching", "switch_unknown", expectedSwitchOperationId);
        return "switch_unknown";
      }
      if (afterWithdraw.status !== "missing") {
        this.fail(lookup, "switching", failure, expectedSwitchOperationId);
        return "known";
      }
    }
    const restored = await this.setSource(control, lookup, true, operationId("restore", request.proposalId, request.revision, lookup));
    if (restored.status === "unknown") {
      this.fail(lookup, "switching", "switch_unknown", expectedSwitchOperationId);
      return "switch_unknown";
    }
    if (restored.status !== "running" || restored.sourceFingerprint !== lookup.sourceFingerprint) {
      this.fail(lookup, "switching", failure, expectedSwitchOperationId);
      return "known";
    }
    const finalSource = await this.readSource(control, lookup.ruleRef);
    const finalTarget = await this.readTarget(request.intent.deploymentId, request.intent.target);
    if (finalSource.status === "unknown" || finalTarget.status === "unknown") {
      this.fail(lookup, "switching", "switch_unknown", expectedSwitchOperationId);
      return "switch_unknown";
    }
    if (finalSource.status !== "running" || finalSource.sourceFingerprint !== lookup.sourceFingerprint
      || finalTarget.status !== "missing") {
      this.fail(lookup, "switching", failure, expectedSwitchOperationId);
      return "known";
    }
    this.fail(lookup, "switching", failure, expectedSwitchOperationId);
    if (failure !== "verification_failed") {
      this.restoreFailedSwitchAfterReadback({
        proposalId: request.proposalId,
        deploymentId: request.intent.deploymentId,
        target: request.intent.target,
        actor: request.actor,
        lookup,
      }, failure);
    }
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

  private async readTarget(deploymentId: string, target: string): Promise<TargetReadback> {
    try {
      return await this.base.status?.({ deploymentId, target }) ?? { status: "unknown" };
    } catch {
      return { status: "unknown" };
    }
  }

  private verifiedReconciliationFailure(
    lookup: Extract<HomeAutomationMigrationDeploymentLookup, { readonly status: "governed" }>,
    reason: string,
  ): ProposalDeploymentReconciliationResult {
    try {
      if (!this.runtime.failRuleWorkflow({
        migrationId: lookup.migrationId,
        ruleRef: lookup.ruleRef,
        from: "verified",
        reason: "verification_failed",
        expectedSwitchOperationId: lookup.switchOperationId!,
      })) return { disposition: "defer" };
    } catch {
      return { disposition: "defer" };
    }
    return { disposition: "recovery_required", reason };
  }
}

type FailedSwitchRecoveryRequest = {
  readonly proposalId: string;
  readonly deploymentId: string;
  readonly target: string;
  readonly actor: string;
  readonly lookup: Extract<HomeAutomationMigrationDeploymentLookup, { readonly status: "ready" | "governed" }>;
};

type TargetReadback = {
  readonly status: "running" | "paused" | "missing" | "unknown";
  readonly configFingerprint?: string;
};

type SwitchTargetCheck =
  | { readonly status: "missing" | "matched" }
  | {
      readonly status: "unsafe";
      readonly reason: string;
      readonly failureReason: "switch_unknown" | "verification_failed";
    };

function switchTargetCheck(target: TargetReadback, expectedFingerprint: string | undefined): SwitchTargetCheck {
  if (target.status === "missing") return { status: "missing" };
  if (target.status === "unknown") {
    return { status: "unsafe", reason: SWITCH_UNKNOWN_REASON, failureReason: "switch_unknown" };
  }
  if (!hasNonEmptyString(expectedFingerprint) || target.configFingerprint !== expectedFingerprint) {
    return {
      status: "unsafe",
      reason: SWITCH_TARGET_FINGERPRINT_FAILURE_REASON,
      failureReason: "verification_failed",
    };
  }
  return { status: "matched" };
}

type RollbackTargetCheck =
  | { readonly status: "missing" | "matched" }
  | { readonly status: "unsafe"; readonly reason: string; readonly failureReason: "rollback_failed" | "rollback_unknown" };

function rollbackTargetCheck(target: TargetReadback, expectedFingerprint: string | undefined): RollbackTargetCheck {
  if (target.status === "missing") return { status: "missing" };
  if (target.status === "unknown") {
    return { status: "unsafe", reason: ROLLBACK_UNKNOWN_REASON, failureReason: "rollback_unknown" };
  }
  if (!hasNonEmptyString(expectedFingerprint) || target.configFingerprint !== expectedFingerprint) {
    return {
      status: "unsafe",
      reason: ROLLBACK_TARGET_FINGERPRINT_FAILURE_REASON,
      failureReason: "rollback_failed",
    };
  }
  return { status: "matched" };
}

type FailedSwitchRecoveryResult =
  | { readonly restored: true }
  | { readonly restored: false; readonly recoveryRequired: true; readonly reason: string };

function isFailedSwitchReason(
  value: HomeAutomationMigrationRuleWorkflowFailureReason | undefined,
): value is "switch_failed" | "switch_unknown" {
  return value === "switch_failed" || value === "switch_unknown";
}

function failedSwitchReceipt(
  lookup: Extract<HomeAutomationMigrationDeploymentLookup, { readonly status: "governed" }>,
  failureReason: "switch_failed" | "switch_unknown",
): Parameters<HomeAutomationMigrationDeploymentRuntimePort["restoreFailedSwitch"]>[0] | undefined {
  const approvedProposalRevision = lookup.approvedProposalRevision;
  if (lookup.workflowStatus !== "needs_attention"
    || lookup.failureReason !== failureReason
    || typeof approvedProposalRevision !== "number"
    || !Number.isSafeInteger(approvedProposalRevision)
    || approvedProposalRevision <= 0
    || !hasNonEmptyString(lookup.switchOperationId)
    || !hasNonEmptyString(lookup.switchStartedAt)
    || !hasNonEmptyString(lookup.switchActor)
    || lookup.sourceWasEnabled !== true
    || lookup.deploymentId !== undefined
    || lookup.deploymentTarget !== undefined
    || lookup.deploymentConfigFingerprint !== undefined) {
    return undefined;
  }
  return {
    migrationId: lookup.migrationId,
    ruleRef: lookup.ruleRef,
    expectedApprovedProposalRevision: approvedProposalRevision,
    expectedFailureReason: failureReason,
    expectedSwitchOperationId: lookup.switchOperationId,
    expectedSwitchStartedAt: lookup.switchStartedAt,
  };
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

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sameDeploymentIdentity(requested: unknown, persisted: unknown): boolean {
  return hasNonEmptyString(requested)
    && hasNonEmptyString(persisted)
    && requested === persisted;
}

function hasVerifiedFailureReceipt(
  lookup: Extract<HomeAutomationMigrationDeploymentLookup, { readonly status: "governed" }>,
): boolean {
  return lookup.workflowStatus === "needs_attention"
    && lookup.failureReason === "verification_failed"
    && typeof lookup.approvedProposalRevision === "number"
    && Number.isSafeInteger(lookup.approvedProposalRevision)
    && lookup.approvedProposalRevision > 0
    && lookup.sourceWasEnabled === true
    && hasNonEmptyString(lookup.switchOperationId)
    && hasNonEmptyString(lookup.switchActor)
    && hasNonEmptyString(lookup.switchStartedAt)
    && hasNonEmptyString(lookup.deploymentId)
    && hasNonEmptyString(lookup.deploymentTarget)
    && hasNonEmptyString(lookup.deploymentConfigFingerprint);
}

function operationId(
  kind: "switch" | "rollback" | "restore",
  proposalId: string,
  revision: number | string,
  lookup: Exclude<HomeAutomationMigrationDeploymentLookup, { readonly status: "not_migration" | "ambiguous" }>,
  receiptIdentity?: string,
): string {
  return createHash("sha256")
    .update(`${kind}\u0000${lookup.migrationId}\u0000${lookup.ruleRef}\u0000${proposalId}\u0000${revision}${receiptIdentity === undefined ? "" : `\u0000${receiptIdentity}`}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function recoverySwitchOperationId(
  proposalId: string,
  revision: string,
  lookup: Extract<HomeAutomationMigrationDeploymentLookup, { readonly status: "governed" }>,
): string {
  return operationId("switch", proposalId, revision, lookup, lookup.switchOperationId ?? lookup.switchStartedAt);
}

function targetAutomationOperationId(kind: "deploy" | "withdraw", receiptOperationId: string): string {
  return createHash("sha256")
    .update(`automations-v2\u0000${kind}\u0000${receiptOperationId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function ordinaryRecoveryAutomationOperationId(
  proposalId: string,
  revision: number,
  deploymentId: string,
  target: string,
): string {
  return createHash("sha256")
    .update(`automations-v2\u0000withdraw-recovery\u0000${proposalId}\u0000${revision}\u0000${deploymentId}\u0000${target}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}
