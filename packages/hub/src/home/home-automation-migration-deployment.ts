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
  resumeRuleSwitch(input: {
    readonly migrationId: string;
    readonly ruleRef: string;
    readonly switchOperationId: string;
    readonly switchActor: string;
  }): boolean;
  resumeRuleRollback(input: {
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
const ROLLBACK_FAILURE_REASON = "迁移回退没有完成，原有规则状态需要处理。";
const ROLLBACK_UNKNOWN_REASON = "迁移回退结果暂时无法确认，已停止后续写入。";

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
    if (lookup.status === "governed") {
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

  private async recoverSwitchDeployment(
    request: Parameters<ProposalDeploymentPort["deploy"]>[0],
    lookup: Extract<HomeAutomationMigrationDeploymentLookup, { readonly status: "governed" }>,
  ): Promise<Awaited<ReturnType<ProposalDeploymentPort["deploy"]>>> {
    const control = this.source.foreignRuleControlFor(lookup.sourceBridgeId);
    if (control === undefined) return failed(SWITCH_UNKNOWN_REASON);
    const source = await this.readSource(control, lookup.ruleRef);
    if (source.status === "unknown") return failed(SWITCH_UNKNOWN_REASON);
    if (source.status === "missing" || source.sourceFingerprint !== lookup.sourceFingerprint) {
      return failed("原有规则的来源已经变化，需要重新准备迁移。");
    }
    const target = await this.readTarget(request.intent.deploymentId, request.intent.target);
    if (target.status === "unknown") return failed(SWITCH_UNKNOWN_REASON);
    const expectedFingerprint = lookup.deploymentConfigFingerprint;
    if (target.status === "paused") return failed("迁移自动化的目标当前已暂停，需要人工确认后恢复。");
    if (target.status === "running" && expectedFingerprint !== undefined && target.configFingerprint !== expectedFingerprint) {
      return failed("迁移自动化的部署指纹无法验证，已停止后续写入。");
    }

    const switchOperationId = operationId("switch", request.proposalId, `recovery:${request.revision}`, lookup);
    // A crash can leave the durable workflow in switching. Close that active
    // receipt with a strict CAS before opening a fresh recovery receipt.
    if (lookup.workflowStatus === "switching") this.fail(lookup, "switching", "switch_unknown");
    if (!this.runtime.resumeRuleSwitch({
      migrationId: lookup.migrationId,
      ruleRef: lookup.ruleRef,
      switchOperationId,
      switchActor: request.actor,
    })) return failed(SWITCH_UNKNOWN_REASON);

    if (target.status === "running" && expectedFingerprint === undefined) {
      let withdrawn: { readonly restored: boolean };
      try {
        if (this.base.withdraw === undefined) {
          this.fail(lookup, "switching", "switch_failed");
          return failed(SWITCH_FAILURE_REASON);
        }
        withdrawn = await this.base.withdraw({
          proposalId: request.proposalId,
          deploymentId: request.intent.deploymentId,
          target: request.intent.target,
          actor: request.actor,
        });
      } catch {
        this.fail(lookup, "switching", "switch_unknown");
        return failed(SWITCH_UNKNOWN_REASON);
      }
      if (!withdrawn.restored) {
        this.fail(lookup, "switching", "switch_failed");
        return failed(SWITCH_FAILURE_REASON);
      }
      const afterWithdraw = await this.readTarget(request.intent.deploymentId, request.intent.target);
      if (afterWithdraw.status === "unknown") {
        this.fail(lookup, "switching", "switch_unknown");
        return failed(SWITCH_UNKNOWN_REASON);
      }
      if (afterWithdraw.status !== "missing") {
        this.fail(lookup, "switching", "switch_failed");
        return failed(SWITCH_FAILURE_REASON);
      }
      if (source.status === "paused") {
        const restored = await this.setSource(control, lookup, true, switchOperationId);
        if (restored.status === "unknown") {
          this.fail(lookup, "switching", "switch_unknown");
          return failed(SWITCH_UNKNOWN_REASON);
        }
        if (restored.status !== "running" || restored.sourceFingerprint !== lookup.sourceFingerprint) {
          this.fail(lookup, "switching", "switch_failed");
          return failed(SWITCH_FAILURE_REASON);
        }
      }
      const finalSource = await this.readSource(control, lookup.ruleRef);
      if (finalSource.status === "unknown") {
        this.fail(lookup, "switching", "switch_unknown");
        return failed(SWITCH_UNKNOWN_REASON);
      }
      this.fail(lookup, "switching", "switch_failed");
      return failed(SWITCH_FAILURE_REASON);
    }

    if (target.status === "missing" && source.status === "paused") {
      const restored = await this.setSource(control, lookup, true, switchOperationId);
      if (restored.status === "unknown") {
        this.fail(lookup, "switching", "switch_unknown");
        return failed(SWITCH_UNKNOWN_REASON);
      }
      if (restored.status !== "running" || restored.sourceFingerprint !== lookup.sourceFingerprint) {
        this.fail(lookup, "switching", "switch_failed");
        return failed(SWITCH_FAILURE_REASON);
      }
      const finalSource = await this.readSource(control, lookup.ruleRef);
      if (finalSource.status === "unknown") {
        this.fail(lookup, "switching", "switch_unknown");
        return failed(SWITCH_UNKNOWN_REASON);
      }
      this.fail(lookup, "switching", finalSource.status === "running" && finalSource.sourceFingerprint === lookup.sourceFingerprint
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
          this.fail(lookup, "switching", "switch_unknown");
          return failed(SWITCH_UNKNOWN_REASON);
        }
        if (stopped.status !== "paused" || stopped.sourceFingerprint !== lookup.sourceFingerprint) {
          this.fail(lookup, "switching", "switch_failed");
          return failed(SWITCH_FAILURE_REASON);
        }
      }
      const finalTarget = await this.readTarget(request.intent.deploymentId, request.intent.target);
      const finalSource = await this.readSource(control, lookup.ruleRef);
      if (finalTarget.status === "unknown" || finalSource.status === "unknown") {
        this.fail(lookup, "switching", "switch_unknown");
        return failed(SWITCH_UNKNOWN_REASON);
      }
      if (finalTarget.status !== "running" || finalTarget.configFingerprint !== expectedFingerprint
        || finalSource.status !== "paused" || finalSource.sourceFingerprint !== lookup.sourceFingerprint) {
        const recovered = await this.recoverKnownFailure(request, lookup, control, "verification_failed");
        return failed(recovered === "switch_unknown" ? SWITCH_UNKNOWN_REASON : "迁移自动化的运行状态无法验证，已停止后续写入。");
      }
      if (!this.runtime.verifyRuleSwitch({
        migrationId: lookup.migrationId,
        ruleRef: lookup.ruleRef,
        deploymentId: request.intent.deploymentId,
        deploymentTarget: request.intent.target,
        deploymentConfigFingerprint: expectedFingerprint!,
      })) {
        this.fail(lookup, "switching", "switch_unknown");
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
      this.fail(lookup, "switching", "switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (stopped.status !== "paused" || stopped.sourceFingerprint !== lookup.sourceFingerprint) {
      this.fail(lookup, "switching", "switch_failed");
      return failed(SWITCH_FAILURE_REASON);
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
    if (outcome.deploymentId !== request.intent.deploymentId || outcome.target !== request.intent.target || outcome.configFingerprint === undefined) {
      const recovered = await this.recoverKnownFailure(request, lookup, control, "verification_failed");
      return failed(recovered === "switch_unknown" ? SWITCH_UNKNOWN_REASON : "迁移自动化的部署身份无法验证，已停止后续写入。");
    }
    const finalTarget = await this.readTarget(request.intent.deploymentId, request.intent.target);
    const finalSource = await this.readSource(control, lookup.ruleRef);
    if (finalTarget.status === "unknown" || finalSource.status === "unknown") {
      this.fail(lookup, "switching", "switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
    if (finalTarget.status !== "running" || finalTarget.configFingerprint !== outcome.configFingerprint
      || finalSource.status !== "paused" || finalSource.sourceFingerprint !== lookup.sourceFingerprint) {
      const recovered = await this.recoverKnownFailure(request, lookup, control, "verification_failed");
      return failed(recovered === "switch_unknown" ? SWITCH_UNKNOWN_REASON : "迁移自动化的运行状态无法验证，已停止后续写入。");
    }
    if (!this.runtime.verifyRuleSwitch({
      migrationId: lookup.migrationId,
      ruleRef: lookup.ruleRef,
      deploymentId: request.intent.deploymentId,
      deploymentTarget: request.intent.target,
      deploymentConfigFingerprint: outcome.configFingerprint,
    })) {
      this.fail(lookup, "switching", "switch_unknown");
      return failed(SWITCH_UNKNOWN_REASON);
    }
    return outcome;
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
      const withdrawn = await this.base.withdraw?.({
        proposalId: request.proposalId,
        deploymentId: request.intent.deploymentId,
        target: request.intent.target,
        actor: request.actor,
      });
      return withdrawn ?? { restored: false };
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
    if (source.status === "unknown" || target.status === "unknown") {
      return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    }
    if (source.status === "missing" || source.sourceFingerprint !== lookup.sourceFingerprint) {
      return { restored: false, recoveryRequired: true, reason: "原有规则的来源已经变化，需要人工确认后恢复。" };
    }
    const rollbackOperationId = operationId("rollback", request.proposalId, `recovery:${request.revision}`, lookup);
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

    if (target.status !== "missing") {
      let withdrawn: { readonly restored: boolean };
      try {
        withdrawn = await this.base.withdraw?.({
          proposalId: request.proposalId,
          deploymentId: request.intent.deploymentId,
          target: request.intent.target,
          actor: request.actor,
        }) ?? { restored: false };
      } catch {
        this.fail(lookup, "rolling_back", "rollback_unknown");
        return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
      }
      if (!withdrawn.restored) {
        this.fail(lookup, "rolling_back", "rollback_failed");
        return { restored: false, recoveryRequired: true, reason: "迁移回退没有完成，原有规则状态需要处理。" };
      }
      const afterWithdraw = await this.readTarget(request.intent.deploymentId, request.intent.target);
      if (afterWithdraw.status === "unknown") {
        this.fail(lookup, "rolling_back", "rollback_unknown");
        return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
      }
      if (afterWithdraw.status !== "missing") {
        this.fail(lookup, "rolling_back", "rollback_failed");
        return { restored: false, recoveryRequired: true, reason: "迁移回退没有完成，目标自动化仍然存在。" };
      }
    }
    if (source.status !== "running") {
      const restored = await this.setSource(control, lookup, true, rollbackOperationId);
      if (restored.status === "unknown") {
        this.fail(lookup, "rolling_back", "rollback_unknown");
        return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
      }
      if (restored.status !== "running" || restored.sourceFingerprint !== lookup.sourceFingerprint) {
        this.fail(lookup, "rolling_back", "rollback_failed");
        return { restored: false, recoveryRequired: true, reason: "迁移回退没有完成，原有规则仍未恢复。" };
      }
    }
    const finalSource = await this.readSource(control, lookup.ruleRef);
    const finalTarget = await this.readTarget(request.intent.deploymentId, request.intent.target);
    if (finalSource.status === "unknown" || finalTarget.status === "unknown") {
      this.fail(lookup, "rolling_back", "rollback_unknown");
      return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    }
    if (finalSource.status !== "running" || finalSource.sourceFingerprint !== lookup.sourceFingerprint || finalTarget.status !== "missing") {
      this.fail(lookup, "rolling_back", "rollback_failed");
      return { restored: false, recoveryRequired: true, reason: "迁移回退的最终状态无法验证。" };
    }
    if (!this.runtime.restoreRule({ migrationId: lookup.migrationId, ruleRef: lookup.ruleRef })) {
      this.fail(lookup, "rolling_back", "rollback_unknown");
      return { restored: false, recoveryRequired: true, reason: SWITCH_UNKNOWN_REASON };
    }
    return { restored: true };
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
    if (targetBefore.status !== "missing"
      && targetBefore.configFingerprint !== lookup.deploymentConfigFingerprint) {
      this.fail(lookup, "verified", "verification_failed");
      return { restored: false, recoveryRequired: true, reason: "迁移回退的目标指纹无法验证，需要人工确认后恢复。" };
    }
    const rollbackOperationId = operationId("rollback", request.proposalId, request.deploymentId, lookup);
    if (!this.runtime.startRuleRollback({
      migrationId: lookup.migrationId,
      ruleRef: lookup.ruleRef,
      rollbackOperationId,
      rollbackActor: request.actor,
    })) {
      this.fail(lookup, "verified", "verification_failed");
      return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
    }
    if (targetBefore.status !== "missing") {
      let withdrawn: { readonly restored: boolean };
      try {
        if (this.base.withdraw === undefined) {
          this.fail(lookup, "rolling_back", "rollback_failed");
          return { restored: false, recoveryRequired: true, reason: ROLLBACK_FAILURE_REASON };
        }
        withdrawn = await this.base.withdraw(request);
      } catch {
        this.fail(lookup, "rolling_back", "rollback_unknown");
        return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
      }
      if (!withdrawn.restored) {
        this.fail(lookup, "rolling_back", "rollback_failed");
        return { restored: false, recoveryRequired: true, reason: ROLLBACK_FAILURE_REASON };
      }
      const afterWithdraw = await this.readTarget(request.deploymentId, request.target);
      if (afterWithdraw.status === "unknown") {
        this.fail(lookup, "rolling_back", "rollback_unknown");
        return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
      }
      if (afterWithdraw.status !== "missing") {
        this.fail(lookup, "rolling_back", "rollback_failed");
        return { restored: false, recoveryRequired: true, reason: "迁移回退没有完成，目标自动化仍然存在。" };
      }
    }
    if (sourceBefore.status === "paused") {
      const restored = await this.setSource(control, lookup, true, rollbackOperationId);
      if (restored.status === "unknown") {
        this.fail(lookup, "rolling_back", "rollback_unknown");
        return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
      }
      if (restored.status !== "running" || restored.sourceFingerprint !== lookup.sourceFingerprint) {
        this.fail(lookup, "rolling_back", "rollback_failed");
        return { restored: false, recoveryRequired: true, reason: ROLLBACK_FAILURE_REASON };
      }
    }
    const finalSource = await this.readSource(control, lookup.ruleRef);
    const finalTarget = await this.readTarget(request.deploymentId, request.target);
    if (finalSource.status === "unknown" || finalTarget.status === "unknown") {
      this.fail(lookup, "rolling_back", "rollback_unknown");
      return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
    }
    if (finalSource.status !== "running" || finalSource.sourceFingerprint !== lookup.sourceFingerprint
      || finalTarget.status !== "missing") {
      this.fail(lookup, "rolling_back", "rollback_failed");
      return { restored: false, recoveryRequired: true, reason: ROLLBACK_FAILURE_REASON };
    }
    if (!this.runtime.restoreRule({ migrationId: lookup.migrationId, ruleRef: lookup.ruleRef })) {
      this.fail(lookup, "rolling_back", "rollback_unknown");
      return { restored: false, recoveryRequired: true, reason: ROLLBACK_UNKNOWN_REASON };
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
      if (this.base.withdraw === undefined) {
        this.fail(lookup, "switching", failure);
        return "known";
      }
      withdrawn = await this.base.withdraw({
        proposalId: request.proposalId,
        deploymentId: request.intent.deploymentId,
        target: request.intent.target,
        actor: request.actor,
      });
    } catch {
      this.fail(lookup, "switching", "switch_unknown");
      return "switch_unknown";
    }
    if (!withdrawn.restored) {
      this.fail(lookup, "switching", failure);
      return "known";
    }
    const afterWithdraw = await this.readTarget(request.intent.deploymentId, request.intent.target);
    if (afterWithdraw.status === "unknown") {
      this.fail(lookup, "switching", "switch_unknown");
      return "switch_unknown";
    }
    if (afterWithdraw.status !== "missing") {
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
