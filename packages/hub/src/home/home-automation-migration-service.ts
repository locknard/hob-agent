import { createHash, randomBytes } from "node:crypto";

import {
  HOME_AUTOMATION_MIGRATION_LIMITS,
  HomeAutomationMigrationIdempotencyConflictError,
  type HomeAutomationMigrationAssessment,
  type HomeAutomationMigrationCloseReason,
  type HomeAutomationMigrationCreateResult,
  type HomeAutomationMigrationInput,
  type HomeAutomationMigrationRuleAnalysis,
  type HomeAutomationMigrationRuleAssessment,
  type HomeAutomationMigrationRuleWorkflow,
  type HomeAutomationMigrationRuleWorkflowFailureReason,
  type HomeAutomationMigrationRuleWorkflowStatus,
  type HomeAutomationMigrationRuleWorkflowTransition,
} from "./home-automation-migration.js";
import type { HomeAutomationMigrationStore } from "./home-automation-migration-store.js";
import {
  parseHomeAutomationMigrationSimulationReceipt,
  type HomeAutomationMigrationSimulationReceipt,
} from "./home-automation-migration-simulation.js";

export type {
  HomeAutomationMigrationAssessment,
  HomeAutomationMigrationCloseReason,
  HomeAutomationMigrationCreateResult,
  HomeAutomationMigrationInput,
  HomeAutomationMigrationRuleAnalysis,
  HomeAutomationMigrationRuleWorkflow,
  HomeAutomationMigrationRuleWorkflowFailureReason,
  HomeAutomationMigrationRuleWorkflowStatus,
};
export { HomeAutomationMigrationIdempotencyConflictError } from "./home-automation-migration.js";

/**
 * Narrow future bridge-translator seam. The composition root decides whether
 * this port is trusted; request payloads cannot provide or replace it.
 */
export interface HomeAutomationMigrationTranslator {
  assess(
    request: HomeAutomationMigrationTranslatorRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<HomeAutomationMigrationRuleAnalysis | undefined>;
}

/** Source cut owned by the service; callers cannot provide or override it. */
export interface HomeAutomationMigrationTranslatorRequest {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly lastSeq: number;
  readonly ruleRef: string;
}

export interface HomeAutomationMigrationRunOptions {
  readonly signal?: AbortSignal;
}

export interface HomeAutomationMigrationTranslateRuleInput {
  readonly migrationId: string;
  readonly ruleRef: string;
  readonly from: "assessed";
  readonly proposalId: string;
  readonly candidateProposalRevision: number;
  readonly candidateContentHash: string;
}

export interface HomeAutomationMigrationSimulateRuleInput {
  readonly migrationId: string;
  readonly ruleRef: string;
  readonly from: "translated";
  readonly artifactId: string;
  readonly artifactRevision: number;
  readonly artifactContentHash: string;
  readonly compileResultId: string;
  readonly dryRunResultId: string;
  readonly simulationReceipt?: HomeAutomationMigrationSimulationReceipt;
}

export interface HomeAutomationMigrationReadyRuleInput {
  readonly migrationId: string;
  readonly ruleRef: string;
  readonly from: "simulated";
  readonly reviewProposalRevision: number;
}

export interface HomeAutomationMigrationStartRuleSwitchInput {
  readonly migrationId: string;
  readonly ruleRef: string;
  readonly from: "ready";
  readonly approvedProposalRevision: number;
  readonly switchOperationId: string;
  readonly switchActor: string;
  readonly sourceWasEnabled: true;
}

export interface HomeAutomationMigrationVerifyRuleSwitchInput {
  readonly migrationId: string;
  readonly ruleRef: string;
  readonly from: "switching";
  readonly deploymentId: string;
  readonly deploymentTarget: string;
  readonly deploymentConfigFingerprint: string;
}

export interface HomeAutomationMigrationStartRuleRollbackInput {
  readonly migrationId: string;
  readonly ruleRef: string;
  readonly from: "verified";
  readonly rollbackOperationId: string;
  readonly rollbackActor: string;
}

export interface HomeAutomationMigrationResumeRuleSwitchInput {
  readonly migrationId: string;
  readonly ruleRef: string;
  readonly from: "needs_attention";
  readonly switchOperationId: string;
  readonly switchActor: string;
}

/** Closes a failed switch only after an external readback proves source-running and target-missing. */
export interface HomeAutomationMigrationRestoreFailedSwitchInput {
  readonly migrationId: string;
  readonly ruleRef: string;
  readonly from: "needs_attention";
  /** The approved proposal revision that owns the failed switch receipt. */
  readonly expectedApprovedProposalRevision: number;
  readonly expectedFailureReason: "switch_failed" | "switch_unknown";
  readonly expectedSwitchOperationId: string;
  readonly expectedSwitchStartedAt: string;
}

export interface HomeAutomationMigrationResumeRuleRollbackInput {
  readonly migrationId: string;
  readonly ruleRef: string;
  readonly from: "needs_attention";
  readonly rollbackOperationId: string;
  readonly rollbackActor: string;
}

export interface HomeAutomationMigrationRestoreRuleInput {
  readonly migrationId: string;
  readonly ruleRef: string;
  readonly from: "rolling_back";
}

export interface HomeAutomationMigrationFailRuleWorkflowInput {
  readonly migrationId: string;
  readonly ruleRef: string;
  readonly from: "ready" | "translated" | "simulated" | "switching" | "verified" | "rolling_back";
  readonly reason: HomeAutomationMigrationRuleWorkflowFailureReason;
}

export interface HomeAutomationMigrationRetryRuleWorkflowInput {
  readonly migrationId: string;
  readonly ruleRef: string;
  readonly proposalId?: string;
  readonly candidateProposalRevision?: number;
  readonly candidateContentHash?: string;
  readonly artifactId?: string;
  readonly artifactRevision?: number;
  readonly artifactContentHash?: string;
  readonly compileResultId?: string;
  readonly dryRunResultId?: string;
  readonly simulationReceipt?: HomeAutomationMigrationSimulationReceipt;
}

export interface HomeAutomationMigrationServiceOptions {
  readonly store: HomeAutomationMigrationStore;
  readonly clock?: () => string;
  readonly migrationIdFactory?: () => string;
  readonly idempotencyKeyFactory?: () => string;
  readonly translator?: HomeAutomationMigrationTranslator;
}

/**
 * Creates durable, read-only HA migration assessments. It classifies metadata
 * and never writes to a bridge or executes a translated rule.
 */
export class HomeAutomationMigrationService {
  private readonly store: HomeAutomationMigrationStore;
  private readonly clock: () => string;
  private readonly migrationIdFactory: () => string;
  private readonly idempotencyKeyFactory: () => string;
  private readonly translator?: HomeAutomationMigrationTranslator;

  constructor(options: HomeAutomationMigrationServiceOptions) {
    if (!options || !options.store) throw new TypeError("Home automation migration store is required");
    this.store = options.store;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.migrationIdFactory = options.migrationIdFactory ?? create128BitHex;
    this.idempotencyKeyFactory = options.idempotencyKeyFactory ?? create128BitHex;
    this.translator = options.translator;
  }

  async create(input: HomeAutomationMigrationInput, options: HomeAutomationMigrationRunOptions = {}): Promise<HomeAutomationMigrationCreateResult> {
    const normalized = normalizeInput(input);
    const createdAt = this.clock();
    assertTimestamp(createdAt, "migration creation time");
    const idempotencyKey = normalized.idempotencyKey ?? this.idempotencyKeyFactory();
    assert128BitHex(idempotencyKey, "idempotency key");
    const migrationId = this.migrationIdFactory();
    assert128BitHex(migrationId, "migration id");

    const initialRules = normalized.rules.map((rule) => metadataOnlyAssessment(rule));
    const discovered = this.store.discover({
      migrationId,
      idempotencyKey,
      inputDigest: normalized.inputDigest,
      sourceBridgeId: normalized.bridgeId,
      sourceEpochId: normalized.epochId,
      sourceLastSeq: normalized.lastSeq,
      analysisMode: this.translator === undefined ? "metadata_only" : "trusted_neutral",
      rules: initialRules,
      createdAt,
    });
    if (discovered.outcome === "existing") {
      if (discovered.assessment.status !== "discovered") return discovered;
      return { outcome: "existing", assessment: await this.resumeAssessment(discovered.assessment, options.signal) };
    }

    const classified = await this.classify(normalized, options.signal);
    const assessedAt = this.clock();
    assertTimestamp(assessedAt, "migration assessment time");
    const transition = {
      migrationId,
      status: aggregateStatus(classified),
      assessedAt,
      rules: initializeRuleWorkflows(classified, assessedAt),
    } as const;
    if (!this.store.assess(transition)) throw new Error("Migration assessment disappeared before classification");
    const assessment = this.store.get(migrationId);
    if (assessment === undefined) throw new Error("Migration assessment disappeared after classification");
    return { outcome: "created", assessment };
  }

  get(migrationId: string): HomeAutomationMigrationAssessment | undefined {
    return this.store.get(migrationId);
  }

  list(): readonly HomeAutomationMigrationAssessment[] {
    return this.store.list();
  }

  replay(input: HomeAutomationMigrationInput & { readonly idempotencyKey: string }): HomeAutomationMigrationAssessment | undefined {
    const normalized = normalizeInput(input);
    assert128BitHex(normalized.idempotencyKey, "idempotency key");
    return this.store.replay({ idempotencyKey: normalized.idempotencyKey, inputDigest: normalized.inputDigest });
  }

  async recover(options: HomeAutomationMigrationRunOptions = {}): Promise<readonly HomeAutomationMigrationAssessment[]> {
    const recovered: HomeAutomationMigrationAssessment[] = [];
    for (const assessment of this.store.recover()) {
      recovered.push(await this.resumeAssessment(assessment, options.signal));
    }
    return recovered;
  }

  /** Re-runs a recoverable needs-attention assessment through the same CAS path. */
  async retry(input: { readonly migrationId: string }, options: HomeAutomationMigrationRunOptions = {}): Promise<HomeAutomationMigrationAssessment | undefined> {
    const current = this.store.get(input?.migrationId);
    if (current === undefined || current.status !== "needs_attention") return current;
    return this.resumeAssessment(current, options.signal);
  }

  /** Links one eligible rule to an existing neutral proposal/artifact revision. */
  translateRule(input: HomeAutomationMigrationTranslateRuleInput): HomeAutomationMigrationAssessment | undefined {
    return this.transitionRuleWorkflow({ ...input, to: "translated" });
  }

  /** Links one translated rule to existing compile and dry-run attestations. */
  simulateRule(input: HomeAutomationMigrationSimulateRuleInput): HomeAutomationMigrationAssessment | undefined {
    return this.transitionRuleWorkflow({ ...input, to: "simulated" });
  }

  /** Marks one simulated rule ready after its existing attestations are complete. */
  readyRule(input: HomeAutomationMigrationReadyRuleInput): HomeAutomationMigrationAssessment | undefined {
    return this.transitionRuleWorkflow({ ...input, to: "ready" });
  }

  /** Records the governed switch start after the approved proposal revision is checked. */
  startRuleSwitch(input: HomeAutomationMigrationStartRuleSwitchInput): HomeAutomationMigrationAssessment | undefined {
    if (!isStrictStartRuleSwitchInput(input)) return undefined;
    return this.transitionRuleWorkflow({ ...input, to: "switching" });
  }

  /** Resumes a switch only after a durable, switching-stage uncertainty is read back and selected for recovery. */
  resumeRuleSwitch(input: HomeAutomationMigrationResumeRuleSwitchInput): HomeAutomationMigrationAssessment | undefined {
    if (!isStrictResumeRuleSwitchInput(input)) return undefined;
    const workflow = this.store.get(input.migrationId)?.rules.find((rule) => rule.ruleRef === input.ruleRef)?.workflow;
    if (workflow?.status !== "needs_attention"
      || (workflow.failureReason !== "switch_failed" && workflow.failureReason !== "switch_unknown"
        && workflow.failureReason !== "verification_failed")
      || workflow.approvedProposalRevision === undefined || workflow.switchOperationId === undefined
      || workflow.switchActor === undefined || workflow.sourceWasEnabled !== true || workflow.switchStartedAt === undefined
      || workflow.failureReason === "verification_failed" && workflow.deploymentId !== undefined
      || workflow.switchOperationId === input.switchOperationId) return undefined;
    return this.transitionRuleWorkflow({ ...input, to: "switching" });
  }

  /**
   * Terminates a known failed switch after the caller has externally confirmed
   * the source is running and the target is missing. The store performs the
   * exact failure-receipt CAS and retains the original switch audit fields.
   */
  restoreFailedSwitch(input: HomeAutomationMigrationRestoreFailedSwitchInput): HomeAutomationMigrationAssessment | undefined {
    if (!isStrictRestoreFailedSwitchInput(input)) return undefined;
    const restoredAt = this.clock();
    assertTimestamp(restoredAt, "migration failed-switch restore time");
    if (!this.store.restoreFailedSwitch({ ...input, restoredAt })) return undefined;
    return this.store.get(input.migrationId);
  }

  /** Records neutral deployment evidence after the switch has been externally verified. */
  verifyRuleSwitch(input: HomeAutomationMigrationVerifyRuleSwitchInput): HomeAutomationMigrationAssessment | undefined {
    if (!isStrictVerifyRuleSwitchInput(input)) return undefined;
    return this.transitionRuleWorkflow({ ...input, to: "verified" });
  }

  /** Records the governed rollback start for a verified deployment. */
  startRuleRollback(input: HomeAutomationMigrationStartRuleRollbackInput): HomeAutomationMigrationAssessment | undefined {
    if (!isStrictStartRuleRollbackInput(input)) return undefined;
    return this.transitionRuleWorkflow({ ...input, to: "rolling_back" });
  }

  /** Resumes rollback after verification drift or an uncertain/failed rollback, using a fresh receipt. */
  resumeRuleRollback(input: HomeAutomationMigrationResumeRuleRollbackInput): HomeAutomationMigrationAssessment | undefined {
    if (!isStrictResumeRuleRollbackInput(input)) return undefined;
    const workflow = this.store.get(input.migrationId)?.rules.find((rule) => rule.ruleRef === input.ruleRef)?.workflow;
    const canResumeFromVerification = workflow?.status === "needs_attention"
      && workflow.failureReason === "verification_failed" && workflow.deploymentId !== undefined
      && workflow.deploymentTarget !== undefined && workflow.deploymentConfigFingerprint !== undefined
      && workflow.verifiedAt !== undefined && workflow.rollbackOperationId === undefined
      && workflow.rollbackActor === undefined && workflow.rollbackStartedAt === undefined;
    const canResumeExistingRollback = workflow?.status === "needs_attention"
      && (workflow.failureReason === "rollback_failed" || workflow.failureReason === "rollback_unknown")
      && workflow.deploymentId !== undefined && workflow.deploymentTarget !== undefined
      && workflow.deploymentConfigFingerprint !== undefined && workflow.verifiedAt !== undefined
      && workflow.rollbackOperationId !== undefined && workflow.rollbackActor !== undefined
      && workflow.rollbackStartedAt !== undefined;
    if (!canResumeFromVerification && !canResumeExistingRollback) return undefined;
    if (canResumeExistingRollback && workflow.rollbackOperationId === input.rollbackOperationId) return undefined;
    return this.transitionRuleWorkflow({ ...input, to: "rolling_back" });
  }

  /** Records that the source configuration has been restored after rollback. */
  restoreRule(input: HomeAutomationMigrationRestoreRuleInput): HomeAutomationMigrationAssessment | undefined {
    if (!isStrictRestoreRuleInput(input)) return undefined;
    return this.transitionRuleWorkflow({ ...input, to: "restored" });
  }

  /** Records a fixed compile or simulation failure without storing its payload. */
  failRuleWorkflow(input: HomeAutomationMigrationFailRuleWorkflowInput): HomeAutomationMigrationAssessment | undefined {
    if (!isStrictWorkflowFailureInput(input)) return undefined;
    return this.transitionRuleWorkflow({
      migrationId: input.migrationId,
      ruleRef: input.ruleRef,
      from: input.from,
      to: "needs_attention",
      failureReason: input.reason,
    });
  }

  /** Explicitly retries a failed per-rule link with fresh neutral refs. */
  retryRuleWorkflow(input: HomeAutomationMigrationRetryRuleWorkflowInput): HomeAutomationMigrationAssessment | undefined {
    if (!isStrictRetryRuleWorkflowInput(input)) return undefined;
    const current = this.store.get(input?.migrationId);
    const workflow = current?.rules.find((rule) => rule.ruleRef === input?.ruleRef)?.workflow;
    if (workflow?.status !== "needs_attention") return undefined;
    if (workflow.failureReason === "compile_failed" || workflow.failureReason === "compile_unavailable") {
      if (input.proposalId === undefined || input.candidateProposalRevision === undefined || input.candidateContentHash === undefined || input.artifactId !== undefined || input.artifactRevision !== undefined
        || input.artifactContentHash !== undefined || input.compileResultId !== undefined || input.dryRunResultId !== undefined
        || input.simulationReceipt !== undefined) return undefined;
      return this.transitionRuleWorkflow({
        migrationId: input.migrationId,
        ruleRef: input.ruleRef,
        from: "needs_attention",
        to: "translated",
        proposalId: input.proposalId,
        candidateProposalRevision: input.candidateProposalRevision,
        candidateContentHash: input.candidateContentHash,
      });
    }
    if (workflow.failureReason === "simulation_failed" || workflow.failureReason === "simulation_unavailable") {
      if (input.proposalId !== undefined || input.candidateProposalRevision !== undefined || input.candidateContentHash !== undefined
        || input.artifactId === undefined || input.artifactRevision === undefined || input.artifactContentHash === undefined
        || input.compileResultId === undefined || input.dryRunResultId === undefined || input.simulationReceipt === undefined) return undefined;
      return this.transitionRuleWorkflow({
        migrationId: input.migrationId,
        ruleRef: input.ruleRef,
        from: "needs_attention",
        to: "simulated",
        artifactId: input.artifactId,
        artifactRevision: input.artifactRevision,
        artifactContentHash: input.artifactContentHash,
        compileResultId: input.compileResultId,
        dryRunResultId: input.dryRunResultId,
        simulationReceipt: input.simulationReceipt,
      });
    }
    return undefined;
  }

  retryRule(input: HomeAutomationMigrationRetryRuleWorkflowInput): HomeAutomationMigrationAssessment | undefined {
    return this.retryRuleWorkflow(input);
  }

  closeAssessment(input: { readonly migrationId: string; readonly reason: HomeAutomationMigrationCloseReason }): HomeAutomationMigrationAssessment | undefined {
    const closedAt = this.clock();
    assertTimestamp(closedAt, "migration close time");
    if (!this.store.closeAssessment({ migrationId: input.migrationId, closedAt, reason: input.reason })) return this.store.get(input.migrationId);
    return this.store.get(input.migrationId);
  }

  close(): void {
    this.store.close();
  }

  private async classify(
    source: Pick<NormalizedInput, "bridgeId" | "epochId" | "lastSeq" | "rules">,
    requestedSignal?: AbortSignal,
  ): Promise<HomeAutomationMigrationRuleAssessment[]> {
    const signal = requestedSignal ?? new AbortController().signal;
    const classified: HomeAutomationMigrationRuleAssessment[] = [];
    for (const rule of source.rules) {
      if (this.translator === undefined) {
        classified.push(metadataOnlyAssessment(rule));
        continue;
      }
      if (signal.aborted) {
        classified.push(needsAttentionAssessment(rule));
        continue;
      }
      let result: HomeAutomationMigrationRuleAnalysis | undefined;
      try {
        result = await this.translator.assess({
          bridgeId: source.bridgeId,
          epochId: source.epochId,
          lastSeq: source.lastSeq,
          ruleRef: rule.ruleRef,
        }, { signal });
      } catch {
        classified.push(needsAttentionAssessment(rule));
        continue;
      }
      if (signal.aborted || !isStrictAnalysis(result) || result.ruleRef !== rule.ruleRef) {
        classified.push(needsAttentionAssessment(rule));
        continue;
      }
      classified.push(classifyWithAnalysis(rule, result));
    }
    return classified;
  }

  private async resumeAssessment(assessment: HomeAutomationMigrationAssessment, requestedSignal?: AbortSignal): Promise<HomeAutomationMigrationAssessment> {
    const rules: NormalizedRule[] = assessment.rules.map((rule) => ({
      ruleRef: rule.ruleRef,
      ...(rule.name === undefined ? {} : { name: rule.name }),
      ...(rule.enabled === undefined ? {} : { enabled: rule.enabled }),
      ...(rule.updatedAt === undefined ? {} : { updatedAt: rule.updatedAt }),
    }));
    const classified = await this.classify({
      bridgeId: assessment.sourceBridgeId,
      epochId: assessment.sourceEpochId,
      lastSeq: assessment.sourceLastSeq,
      rules,
    }, requestedSignal);
    const assessedAt = this.clock();
    assertTimestamp(assessedAt, "migration assessment time");
    if (!this.store.assess({
      migrationId: assessment.migrationId,
      status: aggregateStatus(classified),
      assessedAt,
      rules: initializeRuleWorkflows(classified, assessedAt, assessment.rules),
    })) return this.store.get(assessment.migrationId) ?? assessment;
    return this.store.get(assessment.migrationId) ?? assessment;
  }

  private transitionRuleWorkflow(input: Omit<HomeAutomationMigrationRuleWorkflowTransition, "transitionedAt">): HomeAutomationMigrationAssessment | undefined {
    const transitionedAt = this.clock();
    assertTimestamp(transitionedAt, "migration workflow transition time");
    if (!this.store.transitionRuleWorkflow({ ...input, transitionedAt })) return undefined;
    return this.store.get(input.migrationId);
  }
}

interface NormalizedRule {
  readonly ruleRef: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly updatedAt?: string;
}

interface NormalizedInput {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly lastSeq: number;
  readonly rules: readonly NormalizedRule[];
  readonly idempotencyKey?: string;
  readonly inputDigest: string;
}

function normalizeInput(value: unknown): NormalizedInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ["catalog", "idempotencyKey"]) || !isRecord(value.catalog)) {
    throw new TypeError("Home automation migration input is invalid");
  }
  if (value.idempotencyKey !== undefined) assert128BitHex(value.idempotencyKey, "idempotency key");
  const catalog = value.catalog;
  if (!hasOnlyKeys(catalog, ["bridgeId", "status", "epochId", "lastSeq", "rules"])
    || catalog.status !== "available"
    || !isBoundedText(catalog.bridgeId, HOME_AUTOMATION_MIGRATION_LIMITS.maxBridgeIdLength)
    || !isBoundedText(catalog.epochId, HOME_AUTOMATION_MIGRATION_LIMITS.maxEpochIdLength)
    || !isPositiveSafeInteger(catalog.lastSeq)
    || !Array.isArray(catalog.rules)) {
    if (catalog.status !== "available") throw new TypeError("Foreign rule catalog is unavailable");
    throw new TypeError("Home automation migration catalog is invalid");
  }
  if (catalog.rules.length > HOME_AUTOMATION_MIGRATION_LIMITS.maxRules) {
    throw new TypeError("Home automation migration rules exceed the bound");
  }
  const refs = new Set<string>();
  const rules = catalog.rules.map((value) => {
    if (!isRecord(value) || !hasOnlyKeys(value, ["ruleRef", "name", "enabled", "updatedAt"])
      || !isBoundedText(value.ruleRef, HOME_AUTOMATION_MIGRATION_LIMITS.maxRuleRefLength)
      || refs.has(value.ruleRef)) {
      throw new TypeError("Foreign rule metadata is invalid");
    }
    refs.add(value.ruleRef);
    if (value.name !== undefined && !isBoundedText(value.name, HOME_AUTOMATION_MIGRATION_LIMITS.maxNameLength)) {
      throw new TypeError("Foreign rule metadata is invalid");
    }
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new TypeError("Foreign rule metadata is invalid");
    if (value.updatedAt !== undefined && !isTimestamp(value.updatedAt)) throw new TypeError("Foreign rule metadata is invalid");
    return {
      ruleRef: value.ruleRef,
      ...(value.name === undefined ? {} : { name: value.name }),
      ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
      ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
    } satisfies NormalizedRule;
  });
  const digestInput = {
    catalog: {
      bridgeId: catalog.bridgeId,
      status: "available",
      epochId: catalog.epochId,
      lastSeq: catalog.lastSeq,
      rules,
    },
  };
  const encoded = stableStringify(digestInput);
  if (Buffer.byteLength(encoded, "utf8") > HOME_AUTOMATION_MIGRATION_LIMITS.maxInputBytes) {
    throw new TypeError("Home automation migration input exceeds the byte bound");
  }
  return {
    bridgeId: catalog.bridgeId,
    epochId: catalog.epochId,
    lastSeq: catalog.lastSeq,
    rules,
    ...(value.idempotencyKey === undefined ? {} : { idempotencyKey: value.idempotencyKey }),
    inputDigest: `sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`,
  };
}

function metadataOnlyAssessment(rule: NormalizedRule): HomeAutomationMigrationRuleAssessment {
  return {
    ...rule,
    triggerClass: "metadata_only",
    conditionClass: "metadata_only",
    actionClass: "metadata_only",
    disposition: "metadata_only",
    reason: "translation_unavailable",
  };
}

function needsAttentionAssessment(rule: NormalizedRule): HomeAutomationMigrationRuleAssessment {
  return {
    ...rule,
    triggerClass: "unknown",
    conditionClass: "unknown",
    actionClass: "unknown",
    disposition: "needs_attention",
    reason: "analysis_incomplete",
  };
}

function initializeRuleWorkflows(
  rules: readonly HomeAutomationMigrationRuleAssessment[],
  assessedAt: string,
  previousRules: readonly HomeAutomationMigrationRuleAssessment[] = [],
): HomeAutomationMigrationRuleAssessment[] {
  const previousByRef = new Map(previousRules.map((rule) => [rule.ruleRef, rule]));
  return rules.map((rule) => {
    if (rule.disposition !== "eligible") return { ...rule };
    if (rule.sourceFingerprint === undefined) throw new Error("Eligible migration rule is missing its source fingerprint");
    const previous = previousByRef.get(rule.ruleRef);
    if (previous?.disposition === "eligible" && previous.sourceFingerprint === rule.sourceFingerprint && previous.workflow !== undefined) {
      return { ...rule, workflow: { ...previous.workflow } };
    }
    return {
      ...rule,
      workflow: {
        status: "assessed",
        sourceFingerprint: rule.sourceFingerprint,
        assessedAt,
      },
    };
  });
}

function classifyWithAnalysis(rule: NormalizedRule, result: HomeAutomationMigrationRuleAnalysis): HomeAutomationMigrationRuleAssessment {
  const triggerClass = result.trigger.kind;
  const conditionClass = result.condition.kind;
  const actionClass = result.action.kind;
  if (result.trigger.kind === "unknown" || result.condition.kind === "unknown" || result.action.kind === "unknown") {
    return { ...rule, triggerClass, conditionClass, actionClass, disposition: "needs_attention", reason: "analysis_incomplete" };
  }
  if (result.trigger.kind === "unsupported") {
    return { ...rule, triggerClass, conditionClass, actionClass, disposition: "unsupported", reason: "unsupported_trigger" };
  }
  if (result.condition.kind === "unsupported") {
    return { ...rule, triggerClass, conditionClass, actionClass, disposition: "unsupported", reason: "unsupported_condition" };
  }
  if (result.action.kind === "unsupported") {
    return { ...rule, triggerClass, conditionClass, actionClass, disposition: "unsupported", reason: "unsupported_action" };
  }
  return {
    ...rule,
    triggerClass,
    conditionClass: "flat_and",
    actionClass: "reversible",
    sourceFingerprint: result.sourceFingerprint,
    disposition: "eligible",
  };
}

function aggregateStatus(rules: readonly HomeAutomationMigrationRuleAssessment[]): "assessed" | "needs_attention" {
  if (rules.length === 0 || rules.some((rule) => rule.disposition === "needs_attention")) return "needs_attention";
  return "assessed";
}

function isStrictWorkflowFailureInput(value: unknown): value is HomeAutomationMigrationFailRuleWorkflowInput {
  try {
    return isRecord(value) && hasExactKeys(value, ["migrationId", "ruleRef", "from", "reason"])
      && isMigrationId(value.migrationId)
      && isBoundedText(value.ruleRef, HOME_AUTOMATION_MIGRATION_LIMITS.maxRuleRefLength)
      && isWorkflowFailureReason(value.reason)
      && isAllowedWorkflowFailurePair(value.from, value.reason);
  } catch {
    return false;
  }
}

function isStrictStartRuleSwitchInput(value: unknown): value is HomeAutomationMigrationStartRuleSwitchInput {
  try {
    return isRecord(value) && hasExactKeys(value, ["migrationId", "ruleRef", "from", "approvedProposalRevision", "switchOperationId", "switchActor", "sourceWasEnabled"])
      && isMigrationId(value.migrationId)
      && isBoundedText(value.ruleRef, HOME_AUTOMATION_MIGRATION_LIMITS.maxRuleRefLength)
      && value.from === "ready"
      && isPositiveSafeInteger(value.approvedProposalRevision)
      && is128BitHex(value.switchOperationId)
      && isBoundedText(value.switchActor, HOME_AUTOMATION_MIGRATION_LIMITS.maxOperationActorLength)
      && value.sourceWasEnabled === true;
  } catch {
    return false;
  }
}

function isStrictResumeRuleSwitchInput(value: unknown): value is HomeAutomationMigrationResumeRuleSwitchInput {
  try {
    return isRecord(value) && hasExactKeys(value, ["migrationId", "ruleRef", "from", "switchOperationId", "switchActor"])
      && isMigrationId(value.migrationId)
      && isBoundedText(value.ruleRef, HOME_AUTOMATION_MIGRATION_LIMITS.maxRuleRefLength)
      && value.from === "needs_attention"
      && is128BitHex(value.switchOperationId)
      && isBoundedText(value.switchActor, HOME_AUTOMATION_MIGRATION_LIMITS.maxOperationActorLength);
  } catch {
    return false;
  }
}

function isStrictRestoreFailedSwitchInput(value: unknown): value is HomeAutomationMigrationRestoreFailedSwitchInput {
  try {
    return isRecord(value) && hasExactKeys(value, [
      "migrationId", "ruleRef", "from", "expectedApprovedProposalRevision", "expectedFailureReason", "expectedSwitchOperationId", "expectedSwitchStartedAt",
    ])
      && isMigrationId(value.migrationId)
      && isBoundedText(value.ruleRef, HOME_AUTOMATION_MIGRATION_LIMITS.maxRuleRefLength)
      && value.from === "needs_attention"
      && isPositiveSafeInteger(value.expectedApprovedProposalRevision)
      && (value.expectedFailureReason === "switch_failed" || value.expectedFailureReason === "switch_unknown")
      && is128BitHex(value.expectedSwitchOperationId)
      && isTimestamp(value.expectedSwitchStartedAt);
  } catch {
    return false;
  }
}

function isStrictVerifyRuleSwitchInput(value: unknown): value is HomeAutomationMigrationVerifyRuleSwitchInput {
  try {
    return isRecord(value) && hasExactKeys(value, ["migrationId", "ruleRef", "from", "deploymentId", "deploymentTarget", "deploymentConfigFingerprint"])
      && isMigrationId(value.migrationId)
      && isBoundedText(value.ruleRef, HOME_AUTOMATION_MIGRATION_LIMITS.maxRuleRefLength)
      && value.from === "switching"
      && isBoundedText(value.deploymentId, HOME_AUTOMATION_MIGRATION_LIMITS.maxDeploymentIdLength)
      && isBoundedText(value.deploymentTarget, HOME_AUTOMATION_MIGRATION_LIMITS.maxDeploymentTargetLength)
      && isDigest(value.deploymentConfigFingerprint);
  } catch {
    return false;
  }
}

function isStrictStartRuleRollbackInput(value: unknown): value is HomeAutomationMigrationStartRuleRollbackInput {
  try {
    return isRecord(value) && hasExactKeys(value, ["migrationId", "ruleRef", "from", "rollbackOperationId", "rollbackActor"])
      && isMigrationId(value.migrationId)
      && isBoundedText(value.ruleRef, HOME_AUTOMATION_MIGRATION_LIMITS.maxRuleRefLength)
      && value.from === "verified"
      && is128BitHex(value.rollbackOperationId)
      && isBoundedText(value.rollbackActor, HOME_AUTOMATION_MIGRATION_LIMITS.maxOperationActorLength);
  } catch {
    return false;
  }
}

function isStrictResumeRuleRollbackInput(value: unknown): value is HomeAutomationMigrationResumeRuleRollbackInput {
  try {
    return isRecord(value) && hasExactKeys(value, ["migrationId", "ruleRef", "from", "rollbackOperationId", "rollbackActor"])
      && isMigrationId(value.migrationId)
      && isBoundedText(value.ruleRef, HOME_AUTOMATION_MIGRATION_LIMITS.maxRuleRefLength)
      && value.from === "needs_attention"
      && is128BitHex(value.rollbackOperationId)
      && isBoundedText(value.rollbackActor, HOME_AUTOMATION_MIGRATION_LIMITS.maxOperationActorLength);
  } catch {
    return false;
  }
}

function isStrictRestoreRuleInput(value: unknown): value is HomeAutomationMigrationRestoreRuleInput {
  try {
    return isRecord(value) && hasExactKeys(value, ["migrationId", "ruleRef", "from"])
      && isMigrationId(value.migrationId)
      && isBoundedText(value.ruleRef, HOME_AUTOMATION_MIGRATION_LIMITS.maxRuleRefLength)
      && value.from === "rolling_back";
  } catch {
    return false;
  }
}

function isStrictRetryRuleWorkflowInput(value: unknown): value is HomeAutomationMigrationRetryRuleWorkflowInput {
  try {
    if (!isRecord(value) || !hasOnlyKeys(value, [
      "migrationId", "ruleRef", "proposalId", "candidateProposalRevision", "candidateContentHash", "artifactId", "artifactRevision",
      "artifactContentHash", "compileResultId", "dryRunResultId", "simulationReceipt",
    ]) || !isMigrationId(value.migrationId)
      || !isBoundedText(value.ruleRef, HOME_AUTOMATION_MIGRATION_LIMITS.maxRuleRefLength)) return false;
    if ((value.proposalId === undefined) !== (value.candidateProposalRevision === undefined)
      || value.proposalId !== undefined && !isBoundedText(value.proposalId, HOME_AUTOMATION_MIGRATION_LIMITS.maxProposalIdLength)
      || value.candidateProposalRevision !== undefined && !isPositiveSafeInteger(value.candidateProposalRevision)
      || value.candidateContentHash !== undefined && !isDigest(value.candidateContentHash)
      || value.artifactId !== undefined && !isBoundedText(value.artifactId, HOME_AUTOMATION_MIGRATION_LIMITS.maxArtifactIdLength)
      || value.artifactRevision !== undefined && !isPositiveSafeInteger(value.artifactRevision)
      || value.artifactContentHash !== undefined && !isDigest(value.artifactContentHash)
      || value.compileResultId !== undefined && !isDigest(value.compileResultId)
      || value.dryRunResultId !== undefined && !isDigest(value.dryRunResultId)) return false;
    if (value.simulationReceipt !== undefined) {
      try { parseHomeAutomationMigrationSimulationReceipt(value.simulationReceipt); } catch { return false; }
    }
    return true;
  } catch {
    return false;
  }
}

function isStrictAnalysis(value: unknown): value is HomeAutomationMigrationRuleAnalysis {
  const baseKeys = ["ruleRef", "trigger", "condition", "action"] as const;
  const eligibleKeys = [...baseKeys, "sourceFingerprint"] as const;
  if (!isRecord(value) || !hasExactKeys(value, baseKeys) && !hasExactKeys(value, eligibleKeys)
    || !isBoundedText(value.ruleRef, HOME_AUTOMATION_MIGRATION_LIMITS.maxRuleRefLength)
    || !isRecord(value.trigger) || !hasExactKeys(value.trigger, ["kind"])
    || !isRecord(value.condition) || !hasExactKeys(value.condition, ["kind"])
    || !isRecord(value.action) || !hasExactKeys(value.action, ["kind"])) return false;
  const validTrigger = value.trigger.kind === "state" || value.trigger.kind === "time" || value.trigger.kind === "unsupported" || value.trigger.kind === "unknown";
  const validCondition = value.condition.kind === "flat_and" || value.condition.kind === "unsupported" || value.condition.kind === "unknown";
  const validAction = value.action.kind === "reversible" || value.action.kind === "unsupported" || value.action.kind === "unknown";
  if (!validTrigger || !validCondition || !validAction) return false;
  const isEligible = (value.trigger.kind === "state" || value.trigger.kind === "time")
    && value.condition.kind === "flat_and" && value.action.kind === "reversible";
  if (isEligible) return hasExactKeys(value, eligibleKeys) && isSourceFingerprint(value.sourceFingerprint);
  return hasExactKeys(value, baseKeys);
}

function isSourceFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isMigrationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
}

function isWorkflowFailureReason(value: unknown): value is HomeAutomationMigrationRuleWorkflowFailureReason {
  return value === "compile_failed" || value === "compile_unavailable"
    || value === "simulation_failed" || value === "simulation_unavailable"
    || value === "source_stale" || value === "switch_failed" || value === "switch_unknown"
    || value === "verification_failed" || value === "rollback_failed" || value === "rollback_unknown";
}

function isAllowedWorkflowFailurePair(from: unknown, reason: unknown): boolean {
  if (from === "translated") return reason === "compile_failed" || reason === "compile_unavailable";
  if (from === "simulated") return reason === "simulation_failed" || reason === "simulation_unavailable";
  if (from === "ready") return reason === "source_stale" || reason === "switch_unknown";
  if (from === "switching") return reason === "switch_failed" || reason === "switch_unknown" || reason === "verification_failed";
  if (from === "verified") return reason === "verification_failed";
  if (from === "rolling_back") return reason === "rollback_failed" || reason === "rollback_unknown";
  return false;
}

function is128BitHex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
}

function create128BitHex(): string {
  return randomBytes(16).toString("hex");
}

function assert128BitHex(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new TypeError(`Invalid migration ${label}`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (!isTimestamp(value)) throw new TypeError(`Invalid ${label}`);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && value.trim() === value
    && value.includes("T") && !/[\u0000-\u001F\u007F]/u.test(value) && Number.isFinite(Date.parse(value));
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001F\u007F]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= maximum;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  throw new TypeError("Home automation migration input is not canonicalizable");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
