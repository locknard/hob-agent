import { createHash } from "node:crypto";

import { Context, Service } from "@deepseek-ai/cordis";
import type { BridgeActionTarget, ForeignRuleMigrationResult } from "@hob/bridge-contract";

import {
  createForeignRuleArtifactCandidate,
  type ForeignRuleArtifactCandidateResult,
} from "../artifact/foreign-rule-artifact-candidate.js";
import {
  HomeAutomationMigrationService,
  type HomeAutomationMigrationCreateResult,
  type HomeAutomationMigrationRunOptions,
} from "./home-automation-migration-service.js";
import {
  SqliteHomeAutomationMigrationStore,
  type SqliteHomeAutomationMigrationStoreOptions,
} from "./home-automation-migration-store.js";
import {
  HomeAutomationMigrationTranslator,
  type HomeAutomationMigrationWorldPort,
} from "./home-automation-migration-world-translator.js";
import {
  HomeAutomationMigrationPreparationService,
  homeAutomationMigrationProposalIdentity,
  type HomeAutomationMigrationPreparationFailureReason,
} from "./home-automation-migration-preparation.js";
import {
  HomeAutomationMigrationSelectionFacade,
  type HomeAutomationMigrationSelectionPrincipal,
  type HomeAutomationMigrationSelectionProjection,
} from "./home-automation-migration-selection.js";
import {
  HomeAutomationMigrationSimulator,
  computeHomeAutomationMigrationCandidateContentHash,
  type HomeAutomationMigrationSimulationResult,
} from "./home-automation-migration-simulator.js";
import type {
  HomeAutomationMigrationSimulationEvidencePort,
  HomeAutomationMigrationSimulationReceipt,
  HomeAutomationMigrationSimulationSourceCut,
} from "./home-automation-migration-simulation.js";
import type { ForeignRuleArtifactCandidate } from "../artifact/foreign-rule-artifact-candidate.js";
import type {
  HomeAutomationMigrationAssessment,
  HomeAutomationMigrationRuleWorkflow,
  HomeAutomationMigrationCloseReason,
} from "./home-automation-migration.js";
import type {
  HomeWorldForeignRuleCatalog,
  HomeWorldForeignRuleMigrationResult,
  HomeWorldSnapshot,
} from "../world/home-world-service.js";
import type {
  CreateHomeMigrationDraftInput,
  HomePreparationStatus,
} from "./home-proposal-service.js";
import type {
  ProposalCreationResult,
  ProposalEnvelope,
} from "./proposal-store.js";
import type {
  HomeAutomationMigrationDeploymentLookup,
  HomeAutomationMigrationDeploymentRuntimePort,
} from "./home-automation-migration-deployment.js";
import type {
  HomeAutomationMigrationFailRuleWorkflowInput,
  HomeAutomationMigrationResumeRuleRollbackInput,
  HomeAutomationMigrationResumeRuleSwitchInput,
  HomeAutomationMigrationStartRuleRollbackInput,
  HomeAutomationMigrationStartRuleSwitchInput,
  HomeAutomationMigrationRestoreRuleInput,
  HomeAutomationMigrationVerifyRuleSwitchInput,
} from "./home-automation-migration-service.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeAutomationMigrations: HomeAutomationMigrationRuntimeService;
  }
}

export type HomeAutomationMigrationRuntimeAssessmentFailureReason =
  | "invalid_input"
  | "catalog_unavailable"
  | "idempotency_conflict";

/**
 * A closed assessment result. The failure branch carries only a fixed reason;
 * bridge errors, native rule bodies, and provider payloads never cross this
 * runtime boundary.
 */
export type HomeAutomationMigrationRuntimeAssessmentResult =
  | HomeAutomationMigrationCreateResult
  | {
    readonly outcome: "needs_attention";
    readonly reason: HomeAutomationMigrationRuntimeAssessmentFailureReason;
  };

export type HomeAutomationMigrationRuntimeCandidateReason =
  | "assessment_not_eligible"
  | "stale_source"
  | "translation_unavailable"
  | "unsupported"
  | "invalid_input"
  | "resolver_failed"
  | "unbound_target"
  | "multiple_targets"
  | "invalid_title"
  | "artifact_invalid";

export type HomeAutomationMigrationRuntimeCandidateResult =
  | Extract<ForeignRuleArtifactCandidateResult, { readonly status: "candidate" }>
  | {
    readonly status: "needs_attention";
    readonly reason: HomeAutomationMigrationRuntimeCandidateReason;
  };

export type HomeAutomationMigrationRuntimeWorkflowReason =
  | "invalid_input"
  | "assessment_not_eligible"
  | "workflow_unavailable"
  | "workflow_not_recoverable"
  | "proposal_unavailable"
  | "candidate_unavailable"
  | "stale_source"
  | "unsupported"
  | "scope_unavailable"
  | "capacity_full"
  | "suppressed"
  | "translation_unavailable"
  | "simulation_failed"
  | "simulation_unavailable";

export type HomeAutomationMigrationRuntimeWorkflowResult =
  | {
    readonly status: "translated";
    readonly ruleRef: string;
    readonly sourceFingerprint: string;
    readonly proposalId: string;
    readonly candidateProposalRevision: number;
    readonly candidateContentHash: string;
    readonly writesPerformed: false;
  }
  | {
    readonly status: "simulated";
    readonly ruleRef: string;
    readonly sourceFingerprint: string;
    readonly proposalId: string;
    readonly candidateProposalRevision: number;
    readonly candidateContentHash: string;
    readonly preparedArtifact: HomeAutomationMigrationPreparedArtifact;
    readonly writesPerformed: false;
  }
  | {
    readonly status: "ready";
    readonly ruleRef: string;
    readonly sourceFingerprint: string;
    readonly proposalId: string;
    readonly candidateProposalRevision: number;
    readonly reviewProposalRevision: number;
    readonly candidateContentHash: string;
    readonly preparedArtifact: HomeAutomationMigrationPreparedArtifact;
    readonly writesPerformed: false;
  }
  | {
    readonly status: "needs_attention";
    readonly reason: HomeAutomationMigrationRuntimeWorkflowReason;
    readonly writesPerformed: false;
  };

interface HomeAutomationMigrationPreparedArtifact {
  readonly artifactId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly compileResultId: string;
  readonly dryRunResultId: string;
}

export interface HomeAutomationMigrationRuntimeServiceOptions extends SqliteHomeAutomationMigrationStoreOptions {
  readonly clock?: () => string;
  readonly migrationIdFactory?: () => string;
  readonly idempotencyKeyFactory?: () => string;
  readonly simulationEvidence?: HomeAutomationMigrationSimulationEvidencePort;
}

export interface HomeAutomationMigrationRuntimeAssessOptions {
  readonly signal?: AbortSignal;
}

export interface HomeAutomationMigrationRuntimeCandidateInput {
  readonly migrationId: string;
  readonly ruleRef: string;
}

export interface HomeAutomationMigrationRuntimeWorkflowInput {
  readonly migrationId: string;
  readonly ruleRef: string;
}

/**
 * Cordis product owner for read-only foreign-rule assessments and candidates.
 * It owns the SQLite store and closes it with the mounted service. It never
 * persists an Artifact and never sends a bridge command.
 */
export class HomeAutomationMigrationRuntimeService extends Service implements HomeAutomationMigrationDeploymentRuntimePort {
  readonly path: string;

  private readonly world: HomeWorldMigrationPort;
  private readonly migration: HomeAutomationMigrationService;
  private readonly selection: HomeAutomationMigrationSelectionFacade;
  private readonly simulator = new HomeAutomationMigrationSimulator();
  private readonly simulationEvidence?: HomeAutomationMigrationSimulationEvidencePort;
  private preparation: HomeAutomationMigrationPreparationService | undefined;
  private closed = false;

  constructor(ctx: Context, options: HomeAutomationMigrationRuntimeServiceOptions) {
    super(ctx, "homeAutomationMigrations");

    const path = readPath(options);
    const world = readHomeWorld(ctx);
    this.path = path;
    this.world = world;
    this.simulationEvidence = options.simulationEvidence;
    const store = new SqliteHomeAutomationMigrationStore({ path });
    const translator = new HomeAutomationMigrationTranslator(world);
    this.migration = new HomeAutomationMigrationService({
      store,
      translator,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.migrationIdFactory === undefined ? {} : { migrationIdFactory: options.migrationIdFactory }),
      ...(options.idempotencyKeyFactory === undefined ? {} : { idempotencyKeyFactory: options.idempotencyKeyFactory }),
    });
    this.selection = new HomeAutomationMigrationSelectionFacade({
      store,
      prepareRule: async (input) => {
        const result = await this.prepareRuleReview(input);
        if (result.status === "translated" || result.status === "simulated" || result.status === "ready") {
          return {
            status: "prepared",
            proposalId: result.proposalId,
            ...(result.status === "ready" ? { proposalRevision: result.reviewProposalRevision } : {}),
          };
        }
        return { status: "unavailable", reason: "prepare_unavailable" };
      },
      lookupPreparedRule: (input) => this.lookupPreparedSelection(input),
    });
  }

  protected [Service.init](): void {
    this.ctx.effect(() => () => this.close(), "home-automation-migrations.close");
  }

  async assessBridgeCatalog(
    bridgeId: string,
    options: HomeAutomationMigrationRuntimeAssessOptions = {},
  ): Promise<HomeAutomationMigrationRuntimeAssessmentResult> {
    try {
      if (!isBoundedId(bridgeId) || !isRuntimeOptions(options)) {
        return assessmentFailure("invalid_input");
      }
      const catalogs = await this.world.foreignRuleCatalog();
      const catalog = selectExactAvailableCatalog(catalogs, bridgeId);
      if (catalog === undefined) return assessmentFailure("catalog_unavailable");

      const idempotencyKey = deterministicCutIdempotencyKey(
        catalog.bridgeId,
        catalog.epochId!,
        catalog.lastSeq!,
      );
      const input = { catalog, idempotencyKey } as const;
      const runOptions: HomeAutomationMigrationRunOptions = options.signal === undefined
        ? {}
        : { signal: options.signal };
      try {
        return await this.migration.create(input, runOptions);
      } catch (error) {
        return assessmentFailure(isIdempotencyConflict(error) ? "idempotency_conflict" : "catalog_unavailable");
      }
    } catch {
      return assessmentFailure("catalog_unavailable");
    }
  }

  get(migrationId: string): HomeAutomationMigrationAssessment | undefined {
    try {
      return isBoundedId(migrationId) ? this.migration.get(migrationId) : undefined;
    } catch {
      return undefined;
    }
  }

  list(): readonly HomeAutomationMigrationAssessment[] {
    try {
      return this.migration.list();
    } catch {
      return [];
    }
  }

  /** Safe, actor-bound selection projections; internal migration identity stays server-side. */
  listMigrationSelections(principal: HomeAutomationMigrationSelectionPrincipal): readonly HomeAutomationMigrationSelectionProjection[] {
    try {
      return this.selection.list(principal);
    } catch {
      return [];
    }
  }

  /** Consumes a selection token through the Hub-owned preparation seam. */
  async submitMigrationSelection(
    token: string,
    principal: HomeAutomationMigrationSelectionPrincipal,
  ): Promise<HomeAutomationMigrationSelectionProjection> {
    try {
      return await this.selection.submitSelection(token, principal);
    } catch {
      return { name: "Unavailable", status: "unavailable" };
    }
  }

  /** Restart reconciliation uses lookup-only Proposal identity recovery. */
  async recoverMigrationSelections(): Promise<readonly HomeAutomationMigrationSelectionProjection[]> {
    try {
      return await this.selection.recover();
    } catch {
      return [];
    }
  }

  /** Returns one exact neutral workflow link for a proposal, including governed restart states. */
  findWorkflowForProposal(proposalId: string): HomeAutomationMigrationDeploymentLookup {
    try {
      if (!isBoundedId(proposalId)) return { status: "not_migration" };
      const matches = this.migration.list().flatMap((assessment) => assessment.rules.flatMap((rule) => {
        const workflow = rule.workflow;
        return workflow?.proposalId === proposalId
          ? [{ assessment, ruleRef: rule.ruleRef, workflow }]
          : [];
      }));
      if (matches.length === 0) return { status: "not_migration" };
      if (matches.length !== 1) return { status: "ambiguous" };
      const match = matches[0]!;
      const workflow = match.workflow;
      const common = {
        migrationId: match.assessment.migrationId,
        ruleRef: match.ruleRef,
        sourceBridgeId: match.assessment.sourceBridgeId,
        sourceFingerprint: workflow.sourceFingerprint,
      } as const;
      if (workflow.status === "ready") {
        return workflow.reviewProposalRevision === undefined
          ? { status: "ambiguous" }
          : { status: "ready", ...common, reviewProposalRevision: workflow.reviewProposalRevision };
      }
      return {
        status: "governed",
        ...common,
        workflowStatus: workflow.status,
        ...(workflow.reviewProposalRevision === undefined ? {} : { reviewProposalRevision: workflow.reviewProposalRevision }),
        ...(workflow.approvedProposalRevision === undefined ? {} : { approvedProposalRevision: workflow.approvedProposalRevision }),
        ...(workflow.switchOperationId === undefined ? {} : { switchOperationId: workflow.switchOperationId }),
        ...(workflow.switchActor === undefined ? {} : { switchActor: workflow.switchActor }),
        ...(workflow.sourceWasEnabled === undefined ? {} : { sourceWasEnabled: workflow.sourceWasEnabled }),
        ...(workflow.switchStartedAt === undefined ? {} : { switchStartedAt: workflow.switchStartedAt }),
        ...(workflow.deploymentId === undefined ? {} : { deploymentId: workflow.deploymentId }),
        ...(workflow.deploymentTarget === undefined ? {} : { deploymentTarget: workflow.deploymentTarget }),
        ...(workflow.deploymentConfigFingerprint === undefined ? {} : { deploymentConfigFingerprint: workflow.deploymentConfigFingerprint }),
        ...(workflow.rollbackOperationId === undefined ? {} : { rollbackOperationId: workflow.rollbackOperationId }),
        ...(workflow.rollbackActor === undefined ? {} : { rollbackActor: workflow.rollbackActor }),
        ...(workflow.rollbackStartedAt === undefined ? {} : { rollbackStartedAt: workflow.rollbackStartedAt }),
        ...(workflow.failureReason === undefined ? {} : { failureReason: workflow.failureReason }),
      };
    } catch {
      return { status: "ambiguous" };
    }
  }

  /** Records switching CAS state; bridge commands stay in the deployment decorator. */
  startRuleSwitch(input: Omit<HomeAutomationMigrationStartRuleSwitchInput, "from" | "sourceWasEnabled">): boolean {
    try {
      return this.migration.startRuleSwitch({ ...input, from: "ready", sourceWasEnabled: true }) !== undefined;
    } catch {
      return false;
    }
  }

  /** Records neutral target deployment evidence after the decorator read-back. */
  verifyRuleSwitch(input: Omit<HomeAutomationMigrationVerifyRuleSwitchInput, "from">): boolean {
    try {
      return this.migration.verifyRuleSwitch({ ...input, from: "switching" }) !== undefined;
    } catch {
      return false;
    }
  }

  /** Records rollback CAS state; bridge commands stay in the deployment decorator. */
  startRuleRollback(input: Omit<HomeAutomationMigrationStartRuleRollbackInput, "from">): boolean {
    try {
      return this.migration.startRuleRollback({ ...input, from: "verified" }) !== undefined;
    } catch {
      return false;
    }
  }

  /** Records a fresh neutral switch recovery receipt after a readback decision. */
  resumeRuleSwitch(input: Omit<HomeAutomationMigrationResumeRuleSwitchInput, "from">): boolean {
    try {
      return this.migration.resumeRuleSwitch({ ...input, from: "needs_attention" }) !== undefined;
    } catch {
      return false;
    }
  }

  /** Records a fresh neutral rollback recovery receipt after a readback decision. */
  resumeRuleRollback(input: Omit<HomeAutomationMigrationResumeRuleRollbackInput, "from">): boolean {
    try {
      return this.migration.resumeRuleRollback({ ...input, from: "needs_attention" }) !== undefined;
    } catch {
      return false;
    }
  }

  /** Records that the source was read back running after target withdrawal. */
  restoreRule(input: Omit<HomeAutomationMigrationRestoreRuleInput, "from">): boolean {
    try {
      return this.migration.restoreRule({ ...input, from: "rolling_back" }) !== undefined;
    } catch {
      return false;
    }
  }

  /** Records one fixed failure reason without exposing store or bridge objects. */
  failRuleWorkflow(input: Omit<HomeAutomationMigrationFailRuleWorkflowInput, never>): boolean {
    try {
      return this.migration.failRuleWorkflow(input) !== undefined;
    } catch {
      return false;
    }
  }

  async retry(
    input: { readonly migrationId: string },
    options: HomeAutomationMigrationRuntimeAssessOptions = {},
  ): Promise<HomeAutomationMigrationAssessment | undefined> {
    try {
      if (!isExactObject(input, ["migrationId"]) || !isBoundedId(input.migrationId) || !isRuntimeOptions(options)) {
        return undefined;
      }
      return await this.migration.retry(
        { migrationId: input.migrationId },
        options.signal === undefined ? {} : { signal: options.signal },
      );
    } catch {
      return undefined;
    }
  }

  closeAssessment(input: {
    readonly migrationId: string;
    readonly reason: HomeAutomationMigrationCloseReason;
  }): HomeAutomationMigrationAssessment | undefined {
    try {
      if (!isExactObject(input, ["migrationId", "reason"])
        || !isBoundedId(input.migrationId)
        || !isCloseReason(input.reason)) return undefined;
      return this.migration.closeAssessment({ migrationId: input.migrationId, reason: input.reason });
    } catch {
      return undefined;
    }
  }

  async createArtifactCandidate(
    input: HomeAutomationMigrationRuntimeCandidateInput,
    options: HomeAutomationMigrationRuntimeAssessOptions = {},
  ): Promise<HomeAutomationMigrationRuntimeCandidateResult> {
    try {
      const parsedInput = readCandidateInput(input);
      if (parsedInput === undefined || !isRuntimeOptions(options)) {
        return candidateFailure("invalid_input");
      }

      const assessment = this.migration.get(parsedInput.migrationId);
      if (assessment === undefined || assessment.status !== "assessed") {
        return candidateFailure("assessment_not_eligible");
      }
      const matches = assessment.rules.filter((rule) => rule.ruleRef === parsedInput.ruleRef);
      if (matches.length !== 1 || matches[0]?.disposition !== "eligible") {
        return candidateFailure("assessment_not_eligible");
      }

      const translated = await this.world.translateForeignRule({
        bridgeId: assessment.sourceBridgeId,
        epochId: assessment.sourceEpochId,
        lastSeq: assessment.sourceLastSeq,
        ruleRef: parsedInput.ruleRef,
        signal: options.signal ?? new AbortController().signal,
      });
      const mapped = mapTranslationResult(translated);
      if (mapped.status !== "translated") return candidateFailure(mapped.reason);
      if (mapped.value.ruleRef !== parsedInput.ruleRef) return candidateFailure("stale_source");
      const expectedFingerprint = matches[0]?.sourceFingerprint;
      if (expectedFingerprint === undefined || mapped.value.sourceFingerprint !== expectedFingerprint) {
        return candidateFailure("stale_source");
      }

      const candidate = createForeignRuleArtifactCandidate(
        mapped.value,
        (binding) => this.world.resolveBridgeActionTargetForBinding(binding),
      );
      return candidate as HomeAutomationMigrationRuntimeCandidateResult;
    } catch {
      return candidateFailure("translation_unavailable");
    }
  }

  /** Creates one migration-lane review draft and links its exact candidate cut. */
  async prepareRuleReview(
    input: HomeAutomationMigrationRuntimeWorkflowInput,
    options: HomeAutomationMigrationRuntimeAssessOptions = {},
  ): Promise<HomeAutomationMigrationRuntimeWorkflowResult> {
    try {
      const parsedInput = readWorkflowInput(input);
      if (parsedInput === undefined || !isRuntimeOptions(options)) return workflowFailure("invalid_input");
      const current = this.migration.get(parsedInput.migrationId);
      const rule = eligibleWorkflowRule(current, parsedInput.ruleRef);
      if (rule === undefined || current?.status !== "assessed" || rule.workflow === undefined) {
        return workflowFailure("assessment_not_eligible");
      }
      const workflow = rule.workflow;
      if (workflow.status === "switching" || workflow.status === "verified"
        || workflow.status === "rolling_back" || workflow.status === "restored") {
        return workflowFailure("workflow_not_recoverable");
      }
      if (workflow.status === "translated" || workflow.status === "simulated" || workflow.status === "ready") {
        return workflowResult(parsedInput.ruleRef, workflow);
      }
      if (workflow.status === "needs_attention"
        && workflow.failureReason !== "compile_failed"
        && workflow.failureReason !== "compile_unavailable") {
        return workflowFailure("workflow_not_recoverable");
      }

      const preparation = this.preparationService();
      if (preparation === undefined) return workflowFailure("proposal_unavailable");
      const result = await preparation.createReviewDraft(parsedInput, options.signal === undefined ? {} : { signal: options.signal });
      if (result.outcome === "needs_attention") return workflowFailure(mapPreparationReason(result.reason));
      const proposal = readMigrationProposal(result);
      if (proposal === undefined) return workflowFailure("proposal_unavailable");
      const candidateProposalRevision = candidateRevisionForProposal(proposal);
      if (candidateProposalRevision === undefined) return workflowFailure("proposal_unavailable");
      const candidateContentHash = candidateContentHashForProposal(proposal);
      if (candidateContentHash === undefined) return workflowFailure("proposal_unavailable");

      const next = workflow.status === "needs_attention"
        ? this.migration.retryRuleWorkflow({
            migrationId: parsedInput.migrationId,
            ruleRef: parsedInput.ruleRef,
            proposalId: proposal.id,
            candidateProposalRevision,
            candidateContentHash,
          })
        : this.migration.translateRule({
            migrationId: parsedInput.migrationId,
            ruleRef: parsedInput.ruleRef,
            from: "assessed",
            proposalId: proposal.id,
            candidateProposalRevision,
            candidateContentHash,
          });
      if (next === undefined) {
        const converged = this.migration.get(parsedInput.migrationId);
        const convergedRule = eligibleWorkflowRule(converged, parsedInput.ruleRef);
        if (convergedRule?.workflow !== undefined && convergedRule.workflow.status !== "assessed") {
          return workflowResult(parsedInput.ruleRef, convergedRule.workflow);
        }
        return workflowFailure("workflow_unavailable");
      }
      const nextRule = eligibleWorkflowRule(next, parsedInput.ruleRef);
      return nextRule?.workflow === undefined
        ? workflowFailure("workflow_unavailable")
        : workflowResult(parsedInput.ruleRef, nextRule.workflow);
    } catch {
      return workflowFailure("proposal_unavailable");
    }
  }

  /** Reprojects proposal preparation and CASes translated → simulated → ready. */
  async refreshRuleWorkflow(
    input: HomeAutomationMigrationRuntimeWorkflowInput,
    options: HomeAutomationMigrationRuntimeAssessOptions = {},
  ): Promise<HomeAutomationMigrationRuntimeWorkflowResult> {
    try {
      const parsedInput = readWorkflowInput(input);
      if (parsedInput === undefined || !isRuntimeOptions(options)) return workflowFailure("invalid_input");
      let assessment = this.migration.get(parsedInput.migrationId);
      let rule = eligibleWorkflowRule(assessment, parsedInput.ruleRef);
      if (rule === undefined || assessment?.status !== "assessed" || rule.workflow === undefined) {
        return workflowFailure("assessment_not_eligible");
      }
      if (rule.workflow.status === "ready") return workflowResult(parsedInput.ruleRef, rule.workflow);
      if (rule.workflow.status === "switching" || rule.workflow.status === "verified"
        || rule.workflow.status === "rolling_back" || rule.workflow.status === "restored") {
        return workflowFailure("workflow_not_recoverable");
      }
      if (rule.workflow.status === "assessed") return workflowFailure("workflow_not_recoverable");
      if (rule.workflow.status === "needs_attention") return workflowFailure("workflow_not_recoverable");
      const workflow = rule.workflow;
      if (workflow.proposalId === undefined || workflow.candidateProposalRevision === undefined) {
        return workflowFailure("workflow_unavailable");
      }

      const proposals = readHomeProposals(this.ctx);
      if (proposals === undefined) return this.failWorkflow(parsedInput, workflow, "simulation_unavailable");
      const proposal = proposals.get(workflow.proposalId);
      if (proposal === undefined) return this.failWorkflow(parsedInput, workflow, "simulation_unavailable");
      const preparation = proposals.preparationForProposal(workflow.proposalId, workflow.candidateProposalRevision);
      const candidate = await this.createArtifactCandidate({
        migrationId: parsedInput.migrationId,
        ruleRef: parsedInput.ruleRef,
      }, options.signal === undefined ? {} : { signal: options.signal });
      if (candidate.status !== "candidate") return this.failWorkflow(parsedInput, workflow, "simulation_unavailable");

      const projection = this.simulator.project({
        ruleRef: parsedInput.ruleRef,
        sourceFingerprint: workflow.sourceFingerprint,
        candidate,
        proposal,
        ...(preparation === undefined ? {} : { preparation }),
      });
      if (projection.status === "needs_attention") {
        return this.failWorkflow(parsedInput, workflow, simulationFailureReason(projection));
      }
      if (projection.proposalId !== workflow.proposalId
        || projection.candidateProposalRevision !== workflow.candidateProposalRevision
        || projection.candidateContentHash !== workflow.candidateContentHash
        || projection.sourceFingerprint !== workflow.sourceFingerprint) {
        return this.failWorkflow(parsedInput, workflow, "simulation_failed");
      }

      if (projection.status === "translated") return workflowResult(parsedInput.ruleRef, workflow);

      let simulationReceipt: HomeAutomationMigrationSimulationReceipt | undefined;
      if (workflow.status === "translated") {
        // The dual-run receipt binds the exact prepared Artifact and its
        // compile/dry-run attestations, so an unpromoted preparation remains
        // translated until those durable refs are observable.
        if (projection.status !== "ready") return workflowResult(parsedInput.ruleRef, workflow);
        const refs = projection.preparedArtifact;
        const evidencePort = this.simulationEvidence;
        if (evidencePort === undefined) return this.failWorkflow(parsedInput, workflow, "simulation_unavailable");
        const sourceCut: HomeAutomationMigrationSimulationSourceCut = {
          bridgeId: assessment.sourceBridgeId,
          epochId: assessment.sourceEpochId,
          lastSeq: assessment.sourceLastSeq,
          configFingerprint: workflow.sourceFingerprint,
        };
        let evidence: Awaited<ReturnType<HomeAutomationMigrationSimulationEvidencePort["read"]>> | undefined;
        try {
          evidence = await evidencePort.read({
            sourceCut,
            candidate: candidate as ForeignRuleArtifactCandidate,
            signal: options.signal ?? new AbortController().signal,
          });
        } catch {
          evidence = undefined;
        }
        if (evidence === undefined || !sameSimulationSourceCut(evidence.sourceCut, sourceCut)) {
          return this.failWorkflow(parsedInput, workflow, "simulation_unavailable");
        }
        const dualRun = this.simulator.simulate({
          sourceCut,
          candidate: candidate as ForeignRuleArtifactCandidate,
          preparation: {
            artifactId: refs.artifactId,
            artifactRevision: refs.revision,
            artifactContentHash: refs.contentHash,
            compileResultId: refs.compileResultId,
            dryRunResultId: refs.dryRunResultId,
          },
          eventSamples: evidence.eventSamples,
          existingRuleSummaries: evidence.existingRuleSummaries,
        });
        if (dualRun.status !== "simulated") return this.failWorkflow(parsedInput, workflow, "simulation_failed");
        simulationReceipt = dualRun.receipt;
      }

      let simulatedWorkflow = workflow;
      if (workflow.status === "translated") {
        if (projection.status !== "ready") return workflowResult(parsedInput.ruleRef, workflow);
        const refs = projection.preparedArtifact;
        const simulated = this.migration.simulateRule({
          migrationId: parsedInput.migrationId,
          ruleRef: parsedInput.ruleRef,
          from: "translated",
          artifactId: refs.artifactId,
          artifactRevision: refs.revision,
          artifactContentHash: refs.contentHash,
          compileResultId: refs.compileResultId,
          dryRunResultId: refs.dryRunResultId,
          simulationReceipt,
        });
        if (simulated === undefined) {
          assessment = this.migration.get(parsedInput.migrationId);
          rule = eligibleWorkflowRule(assessment, parsedInput.ruleRef);
          if (rule?.workflow?.status === "ready") return workflowResult(parsedInput.ruleRef, rule.workflow);
          if (rule?.workflow?.status !== "simulated") return this.failWorkflow(parsedInput, workflow, "simulation_unavailable");
          simulatedWorkflow = rule.workflow;
        } else {
          const simulatedRule = eligibleWorkflowRule(simulated, parsedInput.ruleRef);
          if (simulatedRule?.workflow?.status !== "simulated") return workflowFailure("workflow_unavailable");
          simulatedWorkflow = simulatedRule.workflow;
        }
      }

      if (projection.status !== "ready") return workflowResult(parsedInput.ruleRef, simulatedWorkflow);
      const freshCandidate = await this.createArtifactCandidate({
        migrationId: parsedInput.migrationId,
        ruleRef: parsedInput.ruleRef,
      }, options.signal === undefined ? {} : { signal: options.signal });
      if (freshCandidate.status !== "candidate"
        || freshCandidate.sourceFingerprint !== workflow.sourceFingerprint
        || computeHomeAutomationMigrationCandidateContentHash(freshCandidate.content) !== workflow.candidateContentHash) {
        return this.failWorkflow(parsedInput, simulatedWorkflow, "simulation_unavailable");
      }
      const reviewProposalRevision = projection.reviewProposalRevision;
      const ready = this.migration.readyRule({
        migrationId: parsedInput.migrationId,
        ruleRef: parsedInput.ruleRef,
        from: "simulated",
        reviewProposalRevision,
      });
      if (ready === undefined) {
        const converged = this.migration.get(parsedInput.migrationId);
        const convergedRule = eligibleWorkflowRule(converged, parsedInput.ruleRef);
        if (convergedRule?.workflow?.status === "ready") return workflowResult(parsedInput.ruleRef, convergedRule.workflow);
        return workflowFailure("workflow_unavailable");
      }
      const readyRule = eligibleWorkflowRule(ready, parsedInput.ruleRef);
      return readyRule?.workflow === undefined
        ? workflowFailure("workflow_unavailable")
        : workflowResult(parsedInput.ruleRef, readyRule.workflow);
    } catch {
      return workflowFailure("simulation_unavailable");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.selection.close();
    this.migration.close();
  }

  private lookupPreparedSelection(input: {
    readonly migrationId: string;
    readonly ruleRef: string;
    readonly sourceBridgeId: string;
    readonly sourceEpochId: string;
    readonly sourceLastSeq: number;
    readonly sourceFingerprint: string;
  }): { readonly status: "prepared"; readonly proposalId: string; readonly proposalRevision?: number } | { readonly status: "unavailable"; readonly reason: "prepare_unavailable" } {
    const assessment = this.migration.get(input.migrationId);
    if (assessment === undefined || assessment.status !== "assessed"
      || assessment.sourceBridgeId !== input.sourceBridgeId
      || assessment.sourceEpochId !== input.sourceEpochId
      || assessment.sourceLastSeq !== input.sourceLastSeq) {
      return { status: "unavailable", reason: "prepare_unavailable" };
    }
    const rule = assessment.rules.find((candidate) => candidate.ruleRef === input.ruleRef);
    const workflow = rule?.workflow;
    if (rule?.disposition !== "eligible" || workflow === undefined || workflow.sourceFingerprint !== input.sourceFingerprint) {
      return { status: "unavailable", reason: "prepare_unavailable" };
    }
    if ((workflow.status === "translated" || workflow.status === "simulated" || workflow.status === "ready")
      && workflow.proposalId !== undefined) {
      return {
        status: "prepared",
        proposalId: workflow.proposalId,
        ...(workflow.candidateProposalRevision === undefined ? {} : { proposalRevision: workflow.candidateProposalRevision }),
      };
    }
    // A crash can leave the exact migration Proposal committed while the
    // assessment workflow is still `assessed`. Recovery performs one exact
    // owner lookup; it never scans a page or calls the create/preparation ingress.
    const proposals = readHomeProposals(this.ctx);
    if (proposals?.findMigrationProposalByIdentity === undefined) {
      return { status: "unavailable", reason: "prepare_unavailable" };
    }
    const identity = homeAutomationMigrationProposalIdentity({
      migrationId: input.migrationId,
      ruleRef: input.ruleRef,
      sourceBridgeId: input.sourceBridgeId,
      sourceEpochId: input.sourceEpochId,
      sourceLastSeq: input.sourceLastSeq,
      sourceFingerprint: input.sourceFingerprint,
    });
    const proposal = proposals.findMigrationProposalByIdentity(identity);
    if (proposal === undefined || proposal.reviewLane !== "migration" || proposal.dedupKey !== identity.dedupKey) {
      return { status: "unavailable", reason: "prepare_unavailable" };
    }
    const proposalRecord = proposal as unknown as Record<string, unknown>;
    const candidateProposalRevision = candidateRevisionForProposal(proposalRecord);
    const candidateContentHash = candidateContentHashForProposal(proposalRecord);
    if (candidateProposalRevision === undefined || candidateContentHash === undefined) {
      return { status: "unavailable", reason: "prepare_unavailable" };
    }
    const linked = this.migration.translateRule({
      migrationId: input.migrationId,
      ruleRef: input.ruleRef,
      from: "assessed",
      proposalId: proposal.id,
      candidateProposalRevision,
      candidateContentHash,
    });
    if (linked === undefined) {
      const converged = this.migration.get(input.migrationId);
      const convergedRule = eligibleWorkflowRule(converged, input.ruleRef);
      const convergedWorkflow = convergedRule?.workflow;
      if (convergedWorkflow?.status !== "translated"
        || convergedWorkflow.proposalId !== proposal.id
        || convergedWorkflow.candidateProposalRevision !== candidateProposalRevision
        || convergedWorkflow.candidateContentHash !== candidateContentHash) {
        return { status: "unavailable", reason: "prepare_unavailable" };
      }
    }
    return { status: "prepared", proposalId: proposal.id, proposalRevision: candidateProposalRevision };
  }

  private preparationService(): HomeAutomationMigrationPreparationService | undefined {
    if (this.preparation !== undefined) return this.preparation;
    try {
      const proposals = lazyHomeProposalsPort(this.ctx);
      if (proposals === undefined || typeof this.world.snapshot !== "function") return undefined;
      this.preparation = new HomeAutomationMigrationPreparationService({
        source: this,
        world: this.world,
        proposals,
      });
      return this.preparation;
    } catch {
      return undefined;
    }
  }

  private failWorkflow(
    input: HomeAutomationMigrationRuntimeWorkflowInput,
    workflow: HomeAutomationMigrationRuleWorkflow,
    reason: "simulation_failed" | "simulation_unavailable",
  ): HomeAutomationMigrationRuntimeWorkflowResult {
    try {
      const failed = this.migration.failRuleWorkflow({
        migrationId: input.migrationId,
        ruleRef: input.ruleRef,
        from: workflow.status === "simulated" ? "simulated" : "translated",
        // A translated rule has not reached the simulation CAS yet. Its
        // bounded failure is therefore the compile/preparation vocabulary;
        // simulation failures are durable only after the simulated stage.
        reason: workflow.status === "translated"
          ? reason === "simulation_failed" ? "compile_failed" : "compile_unavailable"
          : reason,
      });
      const failedRule = eligibleWorkflowRule(failed, input.ruleRef);
      if (failedRule?.workflow?.status === "needs_attention") return workflowFailure(reason);
      const current = this.migration.get(input.migrationId);
      const currentRule = eligibleWorkflowRule(current, input.ruleRef);
      if (currentRule?.workflow?.status === "needs_attention") return workflowFailure(reason);
      if (currentRule?.workflow !== undefined && currentRule.workflow.status !== "assessed") {
        return workflowResult(input.ruleRef, currentRule.workflow);
      }
    } catch {
      // The fixed result below is the only failure detail crossing this boundary.
    }
    return workflowFailure(reason);
  }
}

function sameSimulationSourceCut(
  left: HomeAutomationMigrationSimulationSourceCut,
  right: HomeAutomationMigrationSimulationSourceCut,
): boolean {
  return left.bridgeId === right.bridgeId
    && left.epochId === right.epochId
    && left.lastSeq === right.lastSeq
    && left.configFingerprint === right.configFingerprint;
}

interface HomeWorldMigrationPort extends HomeAutomationMigrationWorldPort {
  foreignRuleCatalog(): Promise<readonly HomeWorldForeignRuleCatalog[]>;
  resolveBridgeActionTargetForBinding(input: unknown): BridgeActionTarget | undefined;
  snapshot(): HomeWorldSnapshot;
}

interface HomeAutomationMigrationProposalPort {
  createMigrationDraftGoverned(input: CreateHomeMigrationDraftInput): Promise<ProposalCreationResult> | ProposalCreationResult;
  get(proposalId: string): ProposalEnvelope | undefined;
  /** Narrow, exact identity lookup used only during restart recovery. */
  findMigrationProposalByIdentity: (input: {
    readonly dedupKey: string;
    readonly idempotencyKey: string;
  }) => ProposalEnvelope | undefined;
  preparationForProposal(proposalId: string, proposalRevision: number): HomePreparationStatus | undefined;
}

function readHomeProposals(ctx: Context): HomeAutomationMigrationProposalPort | undefined {
  try {
    const value = ctx.get("homeProposals") as unknown;
    if (!isRecord(value)
      || typeof value.createMigrationDraftGoverned !== "function"
      || typeof value.get !== "function"
      || typeof value.preparationForProposal !== "function"
      || typeof value.findMigrationProposalByIdentity !== "function") return undefined;
    return value as unknown as HomeAutomationMigrationProposalPort;
  } catch {
    return undefined;
  }
}

function lazyHomeProposalsPort(ctx: Context): Pick<HomeAutomationMigrationProposalPort, "createMigrationDraftGoverned"> | undefined {
  // The migration service mounts before HomeProposalService. This proxy keeps
  // construction side-effect free and resolves the proposal owner per call.
  return {
    createMigrationDraftGoverned(input: CreateHomeMigrationDraftInput): Promise<ProposalCreationResult> | ProposalCreationResult {
      const proposals = readHomeProposals(ctx);
      if (proposals === undefined) throw new Error("HomeProposalService is unavailable");
      return proposals.createMigrationDraftGoverned(input);
    },
  };
}

function readHomeWorld(ctx: Context): HomeWorldMigrationPort {
  try {
    const world = ctx.get("homeWorld") as unknown as HomeWorldMigrationPort | undefined;
    if (world === undefined
      || typeof world.foreignRuleCatalog !== "function"
      || typeof world.translateForeignRule !== "function"
      || typeof world.resolveBridgeActionTargetForBinding !== "function") {
      throw new Error("HomeWorld migration port is unavailable");
    }
    return world;
  } catch {
    throw new Error("HomeWorld migration port is unavailable");
  }
}

function readPath(options: unknown): string {
  try {
    if (!isRecord(options)
      || Object.keys(options).some((key) => !["path", "clock", "migrationIdFactory", "idempotencyKeyFactory", "simulationEvidence"].includes(key))) {
      throw new TypeError("home automation migration path is required");
    }
    if (typeof options.path !== "string" || options.path.length === 0 || options.path.trim() !== options.path) {
      throw new TypeError("home automation migration path is invalid");
    }
    for (const key of ["clock", "migrationIdFactory", "idempotencyKeyFactory"] as const) {
      if (options[key] !== undefined && typeof options[key] !== "function") {
        throw new TypeError("home automation migration option is invalid");
      }
    }
    if (options.simulationEvidence !== undefined
      && (!isRecord(options.simulationEvidence) || typeof options.simulationEvidence.read !== "function")) {
      throw new TypeError("home automation simulation evidence option is invalid");
    }
    return options.path;
  } catch {
    throw new TypeError("home automation migration path is invalid");
  }
}

function selectExactAvailableCatalog(
  catalogs: readonly HomeWorldForeignRuleCatalog[],
  bridgeId: string,
): HomeWorldForeignRuleCatalog | undefined {
  if (!Array.isArray(catalogs)) return undefined;
  const matches = catalogs.filter((catalog) => {
    try {
      return isRecord(catalog) && catalog.bridgeId === bridgeId;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) return undefined;
  const [match] = matches;
  return isExactAvailableCatalog(match) ? match : undefined;
}

function isExactAvailableCatalog(value: unknown): value is HomeWorldForeignRuleCatalog {
  if (!isRecord(value) || value.status !== "available") return false;
  return isBoundedId(value.bridgeId)
    && isBoundedId(value.epochId)
    && isPositiveSafeInteger(value.lastSeq)
    && Array.isArray(value.rules);
}

function deterministicCutIdempotencyKey(bridgeId: string, epochId: string, lastSeq: number): string {
  return createHash("sha256")
    .update(`${bridgeId}\u0000${epochId}\u0000${lastSeq}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function mapTranslationResult(
  value: unknown,
): { readonly status: "translated"; readonly value: Extract<ForeignRuleMigrationResult, { readonly status: "translated" }> }
  | { readonly status: "needs_attention"; readonly reason: Exclude<HomeAutomationMigrationRuntimeCandidateReason, "assessment_not_eligible" | "invalid_input" | "resolver_failed" | "unbound_target" | "multiple_targets" | "invalid_title" | "artifact_invalid"> } {
  try {
    if (!isRecord(value) || value.status === "stale_source") {
      return { status: "needs_attention", reason: value !== null && isRecord(value) && value.status === "stale_source" ? "stale_source" : "translation_unavailable" };
    }
    if (value.status === "unsupported") return { status: "needs_attention", reason: "unsupported" };
    const parsed = value as HomeWorldForeignRuleMigrationResult;
    if (parsed.status !== "translated") return { status: "needs_attention", reason: "translation_unavailable" };
    return { status: "translated", value: parsed as Extract<ForeignRuleMigrationResult, { readonly status: "translated" }> };
  } catch {
    return { status: "needs_attention", reason: "translation_unavailable" };
  }
}

function assessmentFailure(reason: HomeAutomationMigrationRuntimeAssessmentFailureReason): HomeAutomationMigrationRuntimeAssessmentResult {
  return Object.freeze({ outcome: "needs_attention" as const, reason });
}

function candidateFailure(reason: HomeAutomationMigrationRuntimeCandidateReason): HomeAutomationMigrationRuntimeCandidateResult {
  return Object.freeze({ status: "needs_attention" as const, reason });
}

function isRuntimeOptions(value: unknown): value is HomeAutomationMigrationRuntimeAssessOptions {
  try {
    return isRecord(value)
      && Object.keys(value).every((key) => key === "signal")
      && (value.signal === undefined || isAbortSignalLike(value.signal));
  } catch {
    return false;
  }
}

function isCloseReason(value: unknown): value is HomeAutomationMigrationCloseReason {
  return value === "household_closed" || value === "superseded" || value === "stale_source";
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value.trim() === value
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  try {
    return isRecord(value)
      && typeof value.aborted === "boolean"
      && typeof value.addEventListener === "function";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  try {
    if (!isRecord(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  } catch {
    return false;
  }
}

function isIdempotencyConflict(error: unknown): boolean {
  return error instanceof Error && error.name === "HomeAutomationMigrationIdempotencyConflictError";
}

function readCandidateInput(value: unknown): HomeAutomationMigrationRuntimeCandidateInput | undefined {
  try {
    if (!isExactObject(value, ["migrationId", "ruleRef"])) return undefined;
    const migrationId = value.migrationId;
    const ruleRef = value.ruleRef;
    return isBoundedId(migrationId) && isBoundedId(ruleRef)
      ? { migrationId, ruleRef }
      : undefined;
  } catch {
    return undefined;
  }
}

function readWorkflowInput(value: unknown): HomeAutomationMigrationRuntimeWorkflowInput | undefined {
  try {
    if (!isExactObject(value, ["migrationId", "ruleRef"])) return undefined;
    const migrationId = value.migrationId;
    const ruleRef = value.ruleRef;
    return isBoundedId(migrationId) && isBoundedId(ruleRef)
      ? { migrationId, ruleRef }
      : undefined;
  } catch {
    return undefined;
  }
}

function eligibleWorkflowRule(
  assessment: HomeAutomationMigrationAssessment | undefined,
  ruleRef: string,
): HomeAutomationMigrationAssessment["rules"][number] | undefined {
  try {
    const matches = assessment?.rules.filter((rule) => rule.ruleRef === ruleRef && rule.disposition === "eligible");
    return matches?.length === 1 ? matches[0] : undefined;
  } catch {
    return undefined;
  }
}

function readMigrationProposal(
  result: unknown,
): Record<string, unknown> & Pick<ProposalEnvelope, "id" | "revision"> | undefined {
  try {
    if (!isRecord(result)
      || (result.outcome !== "created" && result.outcome !== "merged" && result.outcome !== "replayed")
      || !isRecord(result.proposal)
      || !isBoundedId(result.proposal.id)
      || !isPositiveSafeInteger(result.proposal.revision)
      || result.proposal.kind !== "automation-draft"
      || result.proposal.status !== "pending_review"
      || (result.proposal.lifecycle !== "preparing"
        && result.proposal.lifecycle !== "needs_info"
        && result.proposal.lifecycle !== "ready")
      || !isRecord(result.proposal.artifactCandidate)
      || result.proposal.artifactCandidate.schemaVersion !== "1") return undefined;
    return result.proposal as Record<string, unknown> & Pick<ProposalEnvelope, "id" | "revision">;
  } catch {
    return undefined;
  }
}

function candidateRevisionForProposal(proposal: Record<string, unknown>): number | undefined {
  try {
    if (!isPositiveSafeInteger(proposal.revision)) return undefined;
    if (proposal.lifecycle === "ready") {
      return proposal.revision > 1 ? proposal.revision - 1 : undefined;
    }
    return proposal.revision;
  } catch {
    return undefined;
  }
}

function candidateContentHashForProposal(proposal: Record<string, unknown>): string | undefined {
  try {
    if (!isRecord(proposal.artifactCandidate) || proposal.artifactCandidate.schemaVersion !== "1") return undefined;
    return computeHomeAutomationMigrationCandidateContentHash(proposal.artifactCandidate.content);
  } catch {
    return undefined;
  }
}

function workflowResult(
  ruleRef: string,
  workflow: HomeAutomationMigrationRuleWorkflow,
): HomeAutomationMigrationRuntimeWorkflowResult {
  try {
    if (workflow.status === "translated"
      && workflow.proposalId !== undefined
      && workflow.candidateProposalRevision !== undefined
      && workflow.candidateContentHash !== undefined) {
      const base = {
        ruleRef,
        sourceFingerprint: workflow.sourceFingerprint,
        proposalId: workflow.proposalId,
        candidateProposalRevision: workflow.candidateProposalRevision,
        candidateContentHash: workflow.candidateContentHash,
        writesPerformed: false as const,
      };
      return Object.freeze({ status: "translated" as const, ...base });
    }
    if ((workflow.status === "simulated" || workflow.status === "ready")
      && workflow.proposalId !== undefined
      && workflow.candidateProposalRevision !== undefined
      && workflow.candidateContentHash !== undefined
      && workflow.artifactId !== undefined
      && workflow.artifactRevision !== undefined
      && workflow.artifactContentHash !== undefined
      && workflow.compileResultId !== undefined
      && workflow.dryRunResultId !== undefined) {
      const base = {
        ruleRef,
        sourceFingerprint: workflow.sourceFingerprint,
        proposalId: workflow.proposalId,
        candidateProposalRevision: workflow.candidateProposalRevision,
        candidateContentHash: workflow.candidateContentHash,
        writesPerformed: false as const,
      };
      const preparedArtifact = {
        artifactId: workflow.artifactId,
        revision: workflow.artifactRevision,
        contentHash: workflow.artifactContentHash,
        compileResultId: workflow.compileResultId,
        dryRunResultId: workflow.dryRunResultId,
      } satisfies HomeAutomationMigrationPreparedArtifact;
      if (workflow.status === "simulated") {
        return Object.freeze({ status: "simulated" as const, ...base, preparedArtifact });
      }
      if (workflow.reviewProposalRevision !== undefined) {
        return Object.freeze({
          status: "ready" as const,
          ...base,
          reviewProposalRevision: workflow.reviewProposalRevision,
          preparedArtifact,
        });
      }
    }
    if (workflow.status === "needs_attention") {
      return workflowFailure(workflow.failureReason === "compile_failed" || workflow.failureReason === "compile_unavailable"
        ? "workflow_not_recoverable"
        : "simulation_failed");
    }
  } catch {
    // Fall through to the fixed closed result.
  }
  return workflowFailure("workflow_unavailable");
}

function mapPreparationReason(
  reason: HomeAutomationMigrationPreparationFailureReason,
): HomeAutomationMigrationRuntimeWorkflowReason {
  return reason;
}

function simulationFailureReason(
  result: Extract<HomeAutomationMigrationSimulationResult, { readonly status: "needs_attention" }>,
): "simulation_failed" | "simulation_unavailable" {
  switch (result.reason) {
    case "invalid_candidate":
    case "candidate_mismatch":
    case "rule_binding_mismatch":
    case "source_fingerprint_mismatch":
    case "proposal_mismatch":
    case "preparation_failed":
    case "prepared_artifact_missing":
    case "prepared_content_stale":
      return "simulation_failed";
    case "proposal_unavailable":
    case "preparation_unavailable":
    case "preparation_not_succeeded":
      return "simulation_unavailable";
  }
}

function workflowFailure(reason: HomeAutomationMigrationRuntimeWorkflowReason): HomeAutomationMigrationRuntimeWorkflowResult {
  return Object.freeze({ status: "needs_attention" as const, reason, writesPerformed: false as const });
}
