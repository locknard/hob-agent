import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { ensurePrivateSqliteFiles } from "../sqlite-private-files.js";
import { artifactContentSchema } from "../artifact/neutral-artifact.js";
import type { HubVerifiedProposalSource } from "../artifact/proposal-source-port.js";
import {
  ARTIFACT_PREPARATION_JOB_ERROR_CODES,
  ARTIFACT_PREPARATION_JOB_STAGES,
  type ArtifactPreparationJob,
  type ArtifactPreparationJobErrorCode,
  type ArtifactPreparationJobFailure,
  type ArtifactPreparationJobStage,
  type ArtifactPreparationJobStatus,
  type ArtifactPreparationJobTransition,
} from "../artifact/preparation-job-port.js";

export type { HubVerifiedProposalSource } from "../artifact/proposal-source-port.js";
export {
  ARTIFACT_PREPARATION_JOB_ERROR_CODES,
  ARTIFACT_PREPARATION_JOB_STAGES,
} from "../artifact/preparation-job-port.js";
export type {
  ArtifactPreparationJob,
  ArtifactPreparationJobErrorCode,
  ArtifactPreparationJobFailure,
  ArtifactPreparationJobStage,
  ArtifactPreparationJobStatus,
  ArtifactPreparationJobTransition,
} from "../artifact/preparation-job-port.js";

const boundedId = z.string().trim().min(1).max(200);
const boundedText = z.string().trim().min(1).max(1_000);
const isoTimestamp = z.iso.datetime({ offset: true });
const proposalReviewLaneSchema = z.enum(["standard", "migration"]);
const HOME_AUTOMATION_MIGRATION_PRODUCER = "home-automation-migration";

const provenanceSchema = z.object({
  producer: boundedId,
  sessionId: boundedId.optional(),
  toolCallId: boundedId.optional(),
  /** Legacy v1 field: early rows stored a DSH root call id under this name. */
  turnId: boundedId.optional(),
}).strict();

const evidenceCoverageReasons = [
  "bridge_not_ready",
  "missing_consistent_baseline",
  "baseline_time_unknown",
  "window_before_baseline",
  "history_gap",
  "journal_query_unavailable",
  "selection_too_broad",
  "query_truncated",
  "merge_truncated",
] as const;

const evidenceReferenceSchema = z.object({
    bridgeId: boundedId,
    hwId: boundedId.optional(),
    capabilityId: boundedId.optional(),
    observedAt: isoTimestamp,
    source: z.enum(["current-state", "post-baseline-event"]).optional(),
    epochId: boundedId.optional(),
    seq: z.number().int().nonnegative().optional(),
  }).strict().superRefine((reference, ctx) => {
    const hasEventProvenance = reference.epochId !== undefined && reference.seq !== undefined;
    if ((reference.epochId === undefined) !== (reference.seq === undefined)) {
      ctx.addIssue({ code: "custom", message: "evidence epoch and sequence must appear together" });
    }
    if (reference.source === "post-baseline-event" && !hasEventProvenance) {
      ctx.addIssue({ code: "custom", message: "post-baseline evidence requires epoch and sequence" });
    }
    if (reference.source === "current-state" && (reference.epochId !== undefined || reference.seq !== undefined)) {
      ctx.addIssue({ code: "custom", message: "current-state evidence cannot claim journal provenance" });
    }
    if (reference.source === undefined && (reference.epochId !== undefined || reference.seq !== undefined)) {
      ctx.addIssue({ code: "custom", message: "legacy evidence cannot claim journal provenance" });
    }
  });

/** One bound for the runtime guard and the persisted deployment schema: what validates writes must read back. */
const MAX_DEPLOYMENT_TARGETS = 16;

const evidenceSchema = z.object({
  references: z.array(evidenceReferenceSchema).max(50),
  watermarks: z.array(z.object({
    bridgeId: boundedId,
    epochId: boundedId,
    lastSeq: z.number().int().nonnegative(),
    freshness: z.enum(["fresh", "stale", "unknown"]),
    gapCount: z.number().int().nonnegative(),
  }).strict()).min(1).max(16),
  temporal: z.object({
    requestedSince: isoTimestamp,
    requestedUntil: isoTimestamp,
    truncated: z.boolean(),
    coverage: z.array(z.object({
      bridgeId: boundedId,
      epochId: boundedId.optional(),
      baselineSeq: z.number().int().nonnegative().optional(),
      baselineAt: isoTimestamp.optional(),
      status: z.enum(["complete", "partial", "unavailable"]),
      reasons: z.array(z.enum(evidenceCoverageReasons)).max(evidenceCoverageReasons.length),
    }).strict()).max(16),
  }).strict().optional(),
}).strict().superRefine((evidence, ctx) => {
  const eventReferences = evidence.references.filter((reference) => reference.source === "post-baseline-event");
  if (evidence.temporal === undefined && eventReferences.length > 0) {
    ctx.addIssue({ code: "custom", message: "event references require temporal coverage" });
  }
  if (evidence.temporal !== undefined && eventReferences.length !== evidence.references.length) {
    ctx.addIssue({ code: "custom", message: "temporal evidence must contain only event references" });
  }
});

const conflictCheckSchema = z.object({
  status: z.enum(["checked", "unavailable"]),
  existingAutomationCount: z.number().int().nonnegative(),
  matches: z.array(z.object({
    identity: boundedId,
    relation: z.enum(["duplicate", "conflict", "possible_overlap"]),
  }).strict()).max(20),
}).strict();

const dryRunSchema = z.object({
  status: z.enum(["passed", "failed", "not_run"]),
  summary: boundedText,
}).strict();

const riskSchema = z.object({
  level: z.enum(["low", "medium", "high"]),
  reasons: z.array(boundedText).max(10),
  requiresHumanApproval: z.boolean(),
}).strict();

const intentSchema = z.object({
  type: boundedId,
  description: boundedText,
  rollback: boundedText,
}).strict();

const rationaleSchema = z.object({
  householdValue: boundedText,
  whyNow: boundedText,
  uncertainties: z.array(boundedText).min(1).max(6),
}).strict();

const spaceCoverageSchema = z.object({
  selectedDevices: z.number().int().min(0).max(20),
  devicesWithSingleSpace: z.number().int().nonnegative(),
  devicesWithoutSpace: z.number().int().nonnegative(),
  devicesWithMultipleSpaces: z.number().int().nonnegative(),
}).strict().superRefine((coverage, ctx) => {
  if (coverage.devicesWithSingleSpace + coverage.devicesWithoutSpace
    + coverage.devicesWithMultipleSpaces !== coverage.selectedDevices) {
    ctx.addIssue({ code: "custom", message: "selected-device space coverage must sum to the selected device count" });
  }
});

const artifactCandidateSchema = z.object({
  schemaVersion: z.literal("1"),
  content: artifactContentSchema,
}).strict();

const createProposalInputSchema = z.object({
  kind: z.enum([
    "automation-draft",
    "household-insight",
    "identity-link",
    "capability-binding",
    "action-authority-binding",
  ]),
  title: z.string().trim().min(1).max(120),
  summary: boundedText,
  /** Gate classes of the plan's device actions, recorded for household disclosure. */
  actionPolicyClasses: z.array(z.enum(["direct", "confirmation"])).max(2).optional(),
  /** Household names of the confirmation-class devices this plan touches. */
  confirmationDeviceNames: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
  /** Stable identity of the behavior being discussed, independent of one producer attempt. */
  dedupKey: boundedId.optional(),
  idempotencyKey: boundedId,
  /** Optional expiry override; new proposals default to fourteen days. */
  expiresAt: isoTimestamp.optional(),
  provenance: provenanceSchema,
  evidence: evidenceSchema,
  conflictCheck: conflictCheckSchema,
  dryRun: dryRunSchema,
  risk: riskSchema,
  intent: intentSchema,
  rationale: rationaleSchema.optional(),
  spaceCoverage: spaceCoverageSchema.optional(),
  artifactCandidate: artifactCandidateSchema.optional(),
}).strict();

const admittedProposalInputSchema = createProposalInputSchema.superRefine((proposal, ctx) => {
  if (proposal.kind !== "automation-draft" && proposal.artifactCandidate !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["artifactCandidate"],
      message: "artifact candidate is only valid for an automation draft",
    });
  }
});

export type CreateProposalInput = z.infer<typeof createProposalInputSchema>;
export type ProposalReviewLane = z.infer<typeof proposalReviewLaneSchema>;
type PersistedProposalInput = CreateProposalInput & { readonly reviewLane: ProposalReviewLane };
export type ProposalStatus = "pending_review" | "approved" | "rejected" | "expired";
export type ProposalApplicationStatus = "not_available" | "deploying" | "running" | "failed" | "withdrawn";
export type ProposalDecision = Exclude<ProposalStatus, "pending_review">;
export type ProposalSnoozeTarget = "tomorrow" | "weekend" | "next_week";
export type ProposalGovernanceDecision = "approve" | "reject_once" | "do_not_suggest";
/**
 * One household decision moves a prepared plan into a running automation.
 * Preparation carries no side effect and stays out of the household inbox.
 */
export type ProposalLifecycle =
  | "preparing"
  | "needs_info"
  | "ready"
  | "enabling"
  | "active"
  | "paused"
  | "closed"
  | "enable_failed"
  | "recovery_required";

/** Only a verified deployment reports a running automation. */
export interface ProposalDeployment {
  readonly status: "pending" | "verified" | "failed" | "rolled_back";
  readonly requestedAt: string;
  readonly deploymentId?: string;
  readonly target?: string;
  readonly verifiedAt?: string;
  readonly failedAt?: string;
  readonly restoredAt?: string;
  /** Household-readable reason. Bridge-native payloads never reach this field. */
  readonly reason?: string;
  /** Behavioral fingerprint recorded at verification. */
  readonly configFingerprint?: string;
  /** The native runtime holds a different behavior than the household approved. */
  readonly drifted?: boolean;
  /** The exact device bindings this deployment was authorized against. */
  readonly targets?: readonly ProposalDeploymentTargetBinding[];
}

export interface ProposalEnablement {
  readonly enabledAt: string;
  readonly reviewer: string;
  readonly note?: string;
}

export interface ProposalRecoveryAttempt {
  readonly id: string;
  readonly actor: string;
  readonly revision: number;
  readonly startedAt: string;
  readonly reason?: string;
}

/** The household inbox holds prepared plans; preparation holds its own small budget. */
export const MAX_PREPARING_PROPOSALS = 3;
export const MAX_PROPOSAL_CAPACITY = 5;
export const PROPOSAL_EXPIRY_MS = 14 * 24 * 60 * 60 * 1_000;
export type ProposalApprovalFeedbackCode = "useful_as_is";
export type ProposalRejectionFeedbackCode =
  | "already_covered"
  | "not_useful"
  | "incorrect_assumption"
  | "insufficient_evidence"
  | "household_preference"
  | "too_risky"
  | "other";
export type ProposalReviewFeedbackCode = ProposalApprovalFeedbackCode | ProposalRejectionFeedbackCode;

export interface ProposalQualitySummary {
  readonly total: number;
  readonly statuses: Readonly<Record<ProposalStatus, number>>;
  readonly feedback: Readonly<Record<ProposalReviewFeedbackCode, number>>;
  readonly reviewedWithoutFeedback: number;
}

export interface ProposalCalibrationItem {
  readonly proposalId: string;
  readonly kind: CreateProposalInput["kind"];
  readonly title: string;
  readonly decision: "approved" | "rejected";
  readonly reviewedAt: string;
  readonly feedbackCode?: ProposalReviewFeedbackCode;
}

/** Exact journal pins projected from durable proposal evidence, without text. */
export interface ProposalRetentionEvidenceReference {
  readonly referenceId: string;
  readonly bridgeId: string;
  readonly epochId: string;
  readonly seq: number;
}

export const MAX_PROPOSAL_RETENTION_REFERENCES = 1_000;

const approvalFeedbackCodes = ["useful_as_is"] as const;
const rejectionFeedbackCodes = [
  "already_covered",
  "not_useful",
  "incorrect_assumption",
  "insufficient_evidence",
  "household_preference",
  "too_risky",
  "other",
] as const;
const reviewFeedbackCodeSchema = z.enum([...approvalFeedbackCodes, ...rejectionFeedbackCodes]);

export interface ProposalAuditEvent {
  readonly id: string;
  readonly at: string;
  readonly action:
    | "created"
    | ProposalDecision
    | "evidence_merged"
    | "snoozed"
    | "snooze_elapsed"
    | "prepared"
    | "info_requested"
    | "revalidation_required"
    | "enable_unblocked"
    | "deployment_retried"
    | "deployment_verified"
    | "deployment_failed"
    | "recovery_required"
    | "recovery_started"
    | "recovery_failed"
    | "drift_detected"
    | "drift_restored"
    | "paused"
    | "resumed"
    | "closed";
  readonly actor: string;
  readonly revision: number;
  readonly feedbackCode?: ProposalReviewFeedbackCode;
  readonly note?: string;
}

export interface ProposalReview {
  readonly decision: ProposalDecision;
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly feedbackCode?: ProposalReviewFeedbackCode;
  readonly note?: string;
}

export interface ProposalGovernanceDecisionRecord {
  readonly kind: ProposalGovernanceDecision;
  readonly at: string;
  readonly reviewer?: string;
  readonly note?: string;
}

export interface ProposalEnvelope extends CreateProposalInput {
  readonly reviewLane: ProposalReviewLane;
  readonly schemaVersion: "1";
  readonly id: string;
  readonly revision: number;
  readonly status: ProposalStatus;
  /** Derived from the deployment record; `running` requires a verified deployment. */
  readonly applicationStatus: ProposalApplicationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Stable behavior identity. `idempotencyKey` remains the producer-attempt key. */
  readonly dedupKey: string;
  readonly expiresAt: string;
  /** Snoozing retains pending_review status so existing consumers remain compatible. */
  readonly snoozeCount: number;
  readonly snoozedUntil?: string;
  readonly newEvidence: boolean;
  readonly lifecycle: ProposalLifecycle;
  /** Hash of the plan the household saw when it became ready. */
  readonly preparedContentHash?: string;
  /** Audit link to the immutable preparation outputs behind this ready state. */
  readonly preparedArtifact?: {
    readonly artifactId: string;
    readonly revision: number;
    readonly contentHash: string;
    readonly compileResultId: string;
    readonly dryRunResultId: string;
  };
  readonly deployment?: ProposalDeployment;
  readonly enablement?: ProposalEnablement;
  /** Durable, bounded attempts to restore a migration after a failed decision. */
  readonly recoveryAttempts?: readonly ProposalRecoveryAttempt[];
  /** Present while preparation waits for one household answer. */
  readonly openQuestion?: string;
  /** The world no longer allows this plan to enable; the card says so instead of looping. */
  readonly enableBlockedReason?: string;
  /** Closed cause behind the block, so the card offers the right exit. */
  readonly enableBlockedKind?: "not_configured" | "not_approved" | "unknown_capability" | "protected";
  readonly decision?: ProposalGovernanceDecisionRecord;
  readonly review?: ProposalReview;
  readonly audit: readonly ProposalAuditEvent[];
}

const proposalAuditEventSchema = z.object({
  id: boundedId,
  at: isoTimestamp,
  action: z.enum([
    "created", "approved", "rejected", "expired", "evidence_merged", "snoozed", "snooze_elapsed",
    "prepared", "info_requested", "revalidation_required", "enable_unblocked", "deployment_retried",
    "recovery_required", "recovery_started", "recovery_failed",
    "deployment_verified", "deployment_failed", "drift_detected", "drift_restored", "paused", "resumed", "closed",
  ]),
  actor: boundedId,
  revision: z.number().int().positive(),
  feedbackCode: reviewFeedbackCodeSchema.optional(),
  note: z.string().trim().min(1).max(1_000).optional(),
}).strict();

const proposalReviewSchema = z.object({
  decision: z.enum(["approved", "rejected", "expired"]),
  reviewer: boundedId,
  reviewedAt: isoTimestamp,
  feedbackCode: reviewFeedbackCodeSchema.optional(),
  note: z.string().trim().min(1).max(1_000).optional(),
}).strict();

const proposalGovernanceDecisionSchema = z.object({
  kind: z.enum(["approve", "reject_once", "do_not_suggest"]),
  at: isoTimestamp,
  reviewer: boundedId.optional(),
  note: z.string().trim().min(1).max(1_000).optional(),
}).strict();

const proposalEnvelopeSchema = createProposalInputSchema.extend({
  reviewLane: proposalReviewLaneSchema.optional(),
  schemaVersion: z.literal("1"),
  id: boundedId,
  revision: z.number().int().positive(),
  status: z.enum(["pending_review", "approved", "rejected", "expired"]),
  applicationStatus: z.enum(["not_available", "deploying", "running", "failed", "withdrawn"]),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  dedupKey: boundedId.optional(),
  expiresAt: isoTimestamp.optional(),
  snoozeCount: z.number().int().nonnegative().optional(),
  snoozedUntil: isoTimestamp.optional(),
  newEvidence: z.boolean().optional(),
  lifecycle: z.enum([
    "preparing", "needs_info", "ready", "enabling", "active", "paused", "closed", "enable_failed", "recovery_required",
  ]).optional(),
  deployment: z.object({
    status: z.enum(["pending", "verified", "failed", "rolled_back"]),
    requestedAt: isoTimestamp,
    deploymentId: boundedId.optional(),
    target: boundedId.optional(),
    verifiedAt: isoTimestamp.optional(),
    failedAt: isoTimestamp.optional(),
    restoredAt: isoTimestamp.optional(),
    reason: z.string().trim().min(1).max(1_000).optional(),
    configFingerprint: z.string().trim().min(1).max(128).optional(),
    drifted: z.boolean().optional(),
    targets: z.array(z.object({
      hwCapabilityId: boundedId,
      binding: z.object({
        bridgeId: boundedId,
        nativeId: boundedId,
        nativeInstanceId: boundedId,
      }).strict(),
    }).strict()).max(MAX_DEPLOYMENT_TARGETS).optional(),
  }).strict().optional(),
  openQuestion: z.string().trim().min(1).max(1_000).optional(),
  preparedContentHash: z.string().trim().min(1).max(128).optional(),
  enableBlockedReason: z.string().trim().min(1).max(1_000).optional(),
  enableBlockedKind: z.enum(["not_configured", "not_approved", "unknown_capability", "protected"]).optional(),
  preparedArtifact: z.object({
    artifactId: boundedId,
    revision: z.number().int().positive(),
    contentHash: z.string().trim().min(1).max(128),
    compileResultId: z.string().trim().min(1).max(128),
    dryRunResultId: z.string().trim().min(1).max(128),
  }).strict().optional(),
  enablement: z.object({
    enabledAt: isoTimestamp,
    reviewer: boundedId,
    note: z.string().trim().min(1).max(1_000).optional(),
  }).strict().optional(),
  recoveryAttempts: z.array(z.object({
    id: boundedId,
    actor: boundedId,
    revision: z.number().int().positive(),
    startedAt: isoTimestamp,
    reason: boundedText.optional(),
  }).strict()).max(50).optional(),
  decision: proposalGovernanceDecisionSchema.optional(),
  review: proposalReviewSchema.optional(),
  audit: z.array(proposalAuditEventSchema).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  // The blocked cause and its household reason are one fact: never one alone.
  if ((value.enableBlockedReason === undefined) !== (value.enableBlockedKind === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "enable block reason and kind exist together or not at all" });
  }
});

interface ReviewProposalInputBase {
  readonly proposalId: string;
  readonly expectedRevision: number;
  readonly reviewer: string;
  readonly note?: string;
}

export type ReviewProposalInput = ReviewProposalInputBase & (
  | { readonly decision: "approved"; readonly feedbackCode: ProposalApprovalFeedbackCode }
  | { readonly decision: "rejected"; readonly feedbackCode: ProposalRejectionFeedbackCode }
  | { readonly decision: "expired"; readonly feedbackCode?: never }
);

export interface ProposalListQuery {
  readonly status?: ProposalStatus;
  readonly limit?: number;
  /** Include pending cards whose snooze target has not arrived yet. */
  readonly includeSnoozed?: boolean;
  /** Return only cards currently visible to the household. */
  readonly visibleOnly?: boolean;
}

/** Exact identity used only by Hub-owned migration restart recovery. */
export interface MigrationProposalIdentity {
  readonly dedupKey: string;
  readonly idempotencyKey: string;
}

export interface ProposalSnoozeInput {
  readonly proposalId: string;
  readonly expectedRevision?: number;
  readonly until: ProposalSnoozeTarget;
  readonly reviewer?: string;
}

export interface ProposalDeploymentTargetBinding {
  readonly hwCapabilityId: string;
  readonly binding: {
    readonly bridgeId: string;
    readonly nativeId: string;
    readonly nativeInstanceId: string;
  };
}

export interface ProposalDeploymentIntent {
  readonly deploymentId: string;
  readonly target: string;
  /** The exact device bindings the plan was validated against. */
  readonly targets: readonly ProposalDeploymentTargetBinding[];
}

export interface ProposalDecideInput {
  readonly proposalId: string;
  readonly expectedRevision?: number;
  readonly decision: ProposalGovernanceDecision;
  readonly reviewer?: string;
  readonly reviewerId?: string;
  readonly note?: string;
  readonly feedbackCode?: ProposalReviewFeedbackCode;  /** Persisted with the approval, before any external write happens. */
  readonly deploymentIntent?: ProposalDeploymentIntent;
}

export interface ProposalDedupLatch {
  readonly id: string;
  readonly dedupKey: string;
  readonly proposalId: string;
  readonly createdAt: string;
}

export type ProposalDedupLatchAuditAction = "created" | "cleared";
export interface ProposalDedupLatchAuditEvent {
  readonly id: string;
  readonly dedupKey: string;
  readonly latchId: string;
  readonly proposalId: string;
  readonly action: ProposalDedupLatchAuditAction;
  readonly at: string;
  readonly actor: string;
  readonly note?: string;
}

export interface ProposalClearDedupLatchInput {
  readonly dedupKey: string;
  readonly reviewer: string;
  readonly note?: string;
}

export interface ProposalLifecycleInput {
  readonly proposalId: string;
  readonly expectedRevision?: number;
  readonly actor?: string;
  readonly note?: string;
}

export interface PreparedArtifactRefs {
  readonly artifactId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly compileResultId: string;
  readonly dryRunResultId: string;
}

export type ProposalReadyInput = ProposalLifecycleInput;

export interface ProposalInfoRequestInput extends ProposalLifecycleInput {
  readonly question: string;
}

export interface ProposalDeploymentOutcome {
  readonly configFingerprint?: string;
  readonly status: "verified" | "failed";
  readonly deploymentId?: string;
  readonly target?: string;
  readonly reason?: string;
}

export interface ProposalDeploymentRecordInput extends ProposalLifecycleInput {
  readonly outcome: ProposalDeploymentOutcome;
}

export interface ProposalCloseInput extends ProposalLifecycleInput {
  readonly restored: boolean;
}

export interface ProposalRecoveryRequiredInput extends ProposalLifecycleInput {
  readonly reason: string;
}

export interface ProposalRecoveryAttemptInput extends ProposalLifecycleInput {
  readonly actor: string;
}

export interface ProposalRecoveryFailureInput extends ProposalLifecycleInput {
  readonly actor: string;
  readonly reason: string;
}

export interface ProposalRecoveryCompleteInput extends ProposalLifecycleInput {
  readonly actor: string;
}

export type ProposalCreationResult =
  | { readonly kind: "created" | "merged" | "replayed"; readonly proposal: ProposalEnvelope; readonly mergedEvidenceCount?: number }
  | { readonly kind: "capacity_full" }
  | { readonly kind: "suppressed"; readonly reason: "dedup_latched"; readonly dedupKey: string };

export type ProposalStoreErrorCode =
  | "invalid_proposal"
  | "conflict_check_required"
  | "human_approval_required"
  | "corrupt_store"
  | "not_found"
  | "revision_conflict"
  | "terminal_status"
  | "capacity_full"
  | "review_lane_mismatch"
  | "dedup_latched"
  | "dedup_latch_not_found"
  | "snooze_limit_reached"
  | "snooze_target_invalid"
  | "lifecycle_invalid"
  | "enable_temporarily_unavailable"
  | "rollout_state_invalid"
  | "job_transition_conflict"
  | "source_unavailable"
  | "retention_evidence_limit";

export class ProposalStoreError extends Error {
  constructor(readonly code: ProposalStoreErrorCode, message: string) {
    super(message);
    this.name = "ProposalStoreError";
  }
}

export interface SqliteProposalStoreOptions {
  readonly path: string;
  readonly now?: () => string;
  readonly id?: () => string;
}

type ProposalRow = {
  proposal_id?: unknown;
  producer?: unknown;
  idempotency_key?: unknown;
  status?: unknown;
  revision?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  payload_json?: unknown;
  reference_index?: unknown;
  bridge_id?: unknown;
  source?: unknown;
  epoch_id?: unknown;
  seq?: unknown;
};

type ArtifactPreparationJobRow = {
  job_id?: unknown;
  proposal_id?: unknown;
  proposal_revision?: unknown;
  idempotency_key?: unknown;
  status?: unknown;
  attempt?: unknown;
  version?: unknown;
  stage?: unknown;
  error_code?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

type ProposalDedupLatchRow = {
  latch_id?: unknown;
  dedup_key?: unknown;
  proposal_id?: unknown;
  created_at?: unknown;
};

interface ArtifactPreparationJobMutation {
  readonly status: ArtifactPreparationJobStatus;
  readonly attempt: number;
  readonly version: number;
  readonly stage?: ArtifactPreparationJobStage;
  readonly errorCode?: ArtifactPreparationJobErrorCode;
  readonly updatedAt: string;
  readonly preparedRefsJson?: string;
}

const MAX_ARTIFACT_PREPARATION_ATTEMPTS = 5;
const PROPOSAL_IDEMPOTENCY_ALIASES_TABLE = "proposal_idempotency_aliases";

/** Durable local store for review-only proposal envelopes and their audit trail. */
export class SqliteProposalStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly id: () => string;
  private closed = false;

  constructor(options: SqliteProposalStoreOptions) {
    if (!options || typeof options.path !== "string" || options.path.length === 0) {
      throw new TypeError("proposal store path is required");
    }
    this.path = options.path;
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? randomUUID;
    if (this.path !== ":memory:" && !this.path.startsWith("file::memory:")) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        proposal_id TEXT PRIMARY KEY,
        producer TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE (producer, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS proposals_status_created
        ON proposals (status, created_at DESC, proposal_id DESC);
      CREATE TABLE IF NOT EXISTS ${PROPOSAL_IDEMPOTENCY_ALIASES_TABLE} (
        producer TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        PRIMARY KEY (producer, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS proposal_idempotency_aliases_proposal
        ON ${PROPOSAL_IDEMPOTENCY_ALIASES_TABLE} (proposal_id);
      CREATE TABLE IF NOT EXISTS proposal_dedup_latches (
        dedup_key TEXT PRIMARY KEY,
        latch_id TEXT NOT NULL UNIQUE,
        proposal_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS proposal_dedup_latches_proposal
        ON proposal_dedup_latches (proposal_id);
      CREATE TABLE IF NOT EXISTS proposal_dedup_latch_audit (
        event_id TEXT PRIMARY KEY,
        dedup_key TEXT NOT NULL,
        latch_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('created', 'cleared')),
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        note TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS proposal_dedup_latch_audit_key_at
        ON proposal_dedup_latch_audit (dedup_key, at ASC, event_id ASC);
      CREATE TABLE IF NOT EXISTS approved_proposal_preparation_jobs (
        job_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        proposal_revision INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        attempt INTEGER NOT NULL CHECK (attempt >= 1 AND attempt <= ${MAX_ARTIFACT_PREPARATION_ATTEMPTS}),
        version INTEGER NOT NULL CHECK (version >= 1),
        stage TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (proposal_id, proposal_revision),
        CHECK ((status = 'failed' AND stage IS NOT NULL AND error_code IS NOT NULL)
          OR (status <> 'failed' AND stage IS NULL AND error_code IS NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS preparation_jobs_status_created
        ON approved_proposal_preparation_jobs (status, created_at ASC, job_id ASC);
    `);
    try {
      this.db.exec("ALTER TABLE approved_proposal_preparation_jobs ADD COLUMN prepared_refs_json TEXT");
    } catch {
      // The column already exists.
    }
    // Capacity ownership keeps five review slots and drops retired overflow tables.
    this.db.exec("DROP TABLE IF EXISTS proposal_candidate_idempotency_aliases; DROP TABLE IF EXISTS proposal_candidate_queue;");
    // Existing v1 rows only had one producer/idempotency pair. Backfill that
    // pair into the alias table so later evidence merges remain replay-safe.
    this.db.prepare(`INSERT OR IGNORE INTO ${PROPOSAL_IDEMPOTENCY_ALIASES_TABLE}
      (producer, idempotency_key, proposal_id)
      SELECT producer, idempotency_key, proposal_id FROM proposals`).run();
    this.ensurePrivateFiles();
  }

  create(candidate: CreateProposalInput): ProposalEnvelope {
    const result = this.createGoverned(candidate);
    if (result.kind === "suppressed") {
      throw new ProposalStoreError(
        "dedup_latched",
        "This behavior identity has been marked do-not-suggest",
      );
    }
    if (result.kind === "capacity_full") {
      throw new ProposalStoreError(
        "capacity_full",
        "Review capacity is full; retry explicitly after a review slot opens",
      );
    }
    return result.proposal;
  }

  /**
   * Creates a standard-lane proposal, merges evidence into an unresolved
   * behavior card, or returns a durable suppression result. The producer
   * idempotency key is an operation replay key; `dedupKey` is the stable
   * behavior identity.
   */
  createGoverned(candidate: CreateProposalInput): ProposalCreationResult {
    return this.createGovernedInLane(candidate, "standard");
  }

  /**
   * Narrow Hub-owned ingress for an explicitly selected HA migration rule.
   * Callers cannot provide a lane field; this method injects the persisted lane
   * after the generic envelope has been validated.
   */
  createMigrationGoverned(candidate: CreateProposalInput): ProposalCreationResult {
    if (candidate !== null
      && typeof candidate === "object"
      && Object.prototype.hasOwnProperty.call(candidate, "reviewLane")) {
      throw new ProposalStoreError("invalid_proposal", "Migration review lane is selected by the Hub-owned ingress");
    }
    return this.createGovernedInLane(candidate, "migration");
  }

  private createGovernedInLane(
    candidate: CreateProposalInput,
    reviewLane: ProposalReviewLane,
  ): ProposalCreationResult {
    const parsed = admittedProposalInputSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ProposalStoreError("invalid_proposal", "Proposal does not match the bounded v1 envelope");
    }
    const input: PersistedProposalInput = { ...parsed.data, reviewLane };
    if (reviewLane === "standard" && input.provenance.producer === HOME_AUTOMATION_MIGRATION_PRODUCER) {
      throw new ProposalStoreError("invalid_proposal", "Migration proposals require the Hub-owned migration ingress");
    }
    if (reviewLane === "migration"
      && (input.kind !== "automation-draft"
        || input.artifactCandidate === undefined
        || input.provenance.producer !== HOME_AUTOMATION_MIGRATION_PRODUCER)) {
      throw new ProposalStoreError("invalid_proposal", "The migration review lane requires one Hub-owned automation draft");
    }
    if (input.provenance.producer === "dsh-home-agent" && input.rationale === undefined) {
      throw new ProposalStoreError("invalid_proposal", "Agent-created proposals require a bounded household rationale");
    }
    if (input.provenance.producer === "dsh-home-agent" && input.spaceCoverage === undefined) {
      throw new ProposalStoreError("invalid_proposal", "Agent-created proposals require Hub-bound space coverage");
    }
    if (input.conflictCheck.status !== "checked") {
      throw new ProposalStoreError("conflict_check_required", "A completed conflict check is required");
    }
    if (!input.risk.requiresHumanApproval) {
      throw new ProposalStoreError("human_approval_required", "Every M3a proposal requires human approval");
    }
    const at = this.timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.expireDueInTransaction(at);
      this.promotePreparedInTransaction(at);
      const concurrent = this.findByIdempotency(input.provenance.producer, input.idempotencyKey);
      if (concurrent) {
        this.db.exec("COMMIT");
        return { kind: "replayed", proposal: concurrent };
      }
      const dedupKey = input.dedupKey ?? input.idempotencyKey;
      const existingByIdentity = this.findByDedupKey(dedupKey);
      if (existingByIdentity !== undefined && existingByIdentity.reviewLane !== input.reviewLane) {
        throw new ProposalStoreError("review_lane_mismatch", "A behavior identity cannot cross review lanes");
      }
      const latch = this.findDedupLatch(dedupKey);
      if (latch !== undefined) {
        this.db.exec("COMMIT");
        return { kind: "suppressed", reason: "dedup_latched", dedupKey };
      }
      const unresolved = this.findUnresolvedByDedupKey(dedupKey);
      if (unresolved !== undefined) {
        if (unresolved.reviewLane !== input.reviewLane) {
          throw new ProposalStoreError("review_lane_mismatch", "A behavior identity cannot cross review lanes");
        }
        const merged = mergeProposalEvidence(unresolved, input, at, this.id);
        this.updateProposal(merged.proposal, unresolved.revision);
        this.enqueuePreparationJob(merged.proposal, at);
        this.insertIdempotencyAlias(input.provenance.producer, input.idempotencyKey, unresolved.id);
        this.db.exec("COMMIT");
        return {
          kind: "merged",
          proposal: clone(merged.proposal),
          mergedEvidenceCount: merged.mergedEvidenceCount,
        };
      }
      const admissionFull = requiresPreparation(input)
        ? this.preparingCountInTransaction() >= MAX_PREPARING_PROPOSALS
        : this.readyCountInTransaction() >= MAX_PROPOSAL_CAPACITY;
      if (admissionFull) {
        this.db.exec("COMMIT");
        return { kind: "capacity_full" };
      }
      const expiresAt = input.expiresAt ?? new Date(Date.parse(at) + PROPOSAL_EXPIRY_MS).toISOString();
      if (Date.parse(expiresAt) <= Date.parse(at)) {
        throw new ProposalStoreError("invalid_proposal", "Proposal natural expiry must be in the future");
      }
      const proposal = this.insertProposalInTransaction(input, dedupKey, at, expiresAt);
      this.insertIdempotencyAlias(proposal.provenance.producer, proposal.idempotencyKey, proposal.id);
      this.db.exec("COMMIT");
      return { kind: "created", proposal: clone(proposal) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFiles();
    }
  }

  private insertProposalInTransaction(
    input: PersistedProposalInput,
    dedupKey: string,
    at: string,
    expiresAt: string,
  ): ProposalEnvelope {
    const proposal: ProposalEnvelope = {
      ...input,
      dedupKey,
      expiresAt,
      schemaVersion: "1",
      id: `proposal-${this.id()}`,
      revision: 1,
      status: "pending_review",
      applicationStatus: "not_available",
      // A plan with an artifact to compile prepares first; anything else is
      // already as complete as it will get and can reach the household now.
      lifecycle: requiresPreparation(input) ? "preparing" : "ready",
      createdAt: at,
      updatedAt: at,
      snoozeCount: 0,
      newEvidence: false,
      audit: [{
        id: `audit-${this.id()}`,
        at,
        action: "created",
        actor: input.provenance.producer,
        revision: 1,
      }],
    };
    this.enqueuePreparationJob(proposal, at);
    this.db.prepare(`INSERT INTO proposals
      (proposal_id, producer, idempotency_key, status, revision, created_at, updated_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      proposal.id,
      proposal.provenance.producer,
      proposal.idempotencyKey,
      proposal.status,
      proposal.revision,
      proposal.createdAt,
      proposal.updatedAt,
      JSON.stringify(proposal),
    );
    return proposal;
  }

  get(proposalId: string): ProposalEnvelope | undefined {
    this.expireDue();
    const row = this.db.prepare(`SELECT
        proposal_id, producer, idempotency_key, status, revision,
        created_at, updated_at, payload_json
      FROM proposals WHERE proposal_id = ?`)
      .get(proposalId) as ProposalRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  /**
   * Reads one migration proposal by its complete deterministic identity.
   * This query is intentionally narrower than list() and never creates an
   * alias, expires a row, merges evidence, or admits a proposal.
   */
  findMigrationProposalByIdentity(input: MigrationProposalIdentity): ProposalEnvelope | undefined {
    if (!input || typeof input !== "object"
      || Object.keys(input).length !== 2
      || !Object.prototype.hasOwnProperty.call(input, "dedupKey")
      || !Object.prototype.hasOwnProperty.call(input, "idempotencyKey")) {
      throw new TypeError("migration proposal identity is invalid");
    }
    validateBoundedKey(input.dedupKey, "migration proposal dedup key");
    validateBoundedKey(input.idempotencyKey, "migration proposal idempotency key");
    const row = this.db.prepare(`SELECT
        proposal_id, producer, idempotency_key, status, revision,
        created_at, updated_at, payload_json
      FROM proposals
      WHERE producer = ? AND idempotency_key = ?`).get(
      HOME_AUTOMATION_MIGRATION_PRODUCER,
      input.idempotencyKey,
    ) as ProposalRow | undefined;
    if (row === undefined) return undefined;
    const proposal = fromRow(row);
    return proposal.provenance.producer === HOME_AUTOMATION_MIGRATION_PRODUCER
      && proposal.reviewLane === "migration"
      && proposal.idempotencyKey === input.idempotencyKey
      && proposal.dedupKey === input.dedupKey
      ? proposal
      : undefined;
  }

  list(query: ProposalListQuery = {}): readonly ProposalEnvelope[] {
    this.expireDue();
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new TypeError("proposal list limit must be an integer from 1 to 200");
    }
    const rows = query.status === undefined
      ? this.db.prepare(`SELECT
          proposal_id, producer, idempotency_key, status, revision,
          created_at, updated_at, payload_json
        FROM proposals
          ORDER BY created_at DESC, proposal_id DESC LIMIT ?`).all(limit)
      : this.db.prepare(`SELECT
          proposal_id, producer, idempotency_key, status, revision,
          created_at, updated_at, payload_json
        FROM proposals WHERE status = ?
          ORDER BY created_at DESC, proposal_id DESC LIMIT ?`).all(query.status, limit);
    return (rows as ProposalRow[])
      .map(fromRow)
      .filter((proposal) => query.includeSnoozed === true
        || query.visibleOnly !== true
        || proposal.snoozedUntil === undefined
      || Date.parse(proposal.snoozedUntil) <= Date.parse(proposal.updatedAt));
  }

  /** Capacity limits household attention, so it counts prepared plans only. */
  proposalCapacity(): { readonly used: number; readonly max: 5; readonly available: number } {
    this.expireDue();
    const used = this.readyCountInTransaction();
    if (used > MAX_PROPOSAL_CAPACITY) {
      throw new ProposalStoreError("corrupt_store", "Proposal review capacity is corrupt");
    }
    return { used, max: MAX_PROPOSAL_CAPACITY, available: MAX_PROPOSAL_CAPACITY - used };
  }

  listDedupLatchAudit(limit = 100): readonly ProposalDedupLatchAuditEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new TypeError("proposal latch audit limit must be an integer from 1 to 200");
    }
    const rows = this.db.prepare(`SELECT event_id, dedup_key, latch_id, proposal_id,
        action, at, actor, note
      FROM proposal_dedup_latch_audit
      ORDER BY rowid ASC LIMIT ?`).all(limit) as Array<Record<string, unknown>>;
    return rows.map(fromDedupLatchAuditRow);
  }

  clearDedupLatch(input: ProposalClearDedupLatchInput): ProposalDedupLatchAuditEvent {
    validateClearDedupLatchInput(input);
    const at = this.timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.findDedupLatch(input.dedupKey);
      if (current === undefined) {
        throw new ProposalStoreError("dedup_latch_not_found", "The behavior identity has no active do-not-suggest latch");
      }
      const note = input.note?.trim();
      const event: ProposalDedupLatchAuditEvent = {
        id: `latch-audit-${this.id()}`,
        dedupKey: current.dedupKey,
        latchId: current.id,
        proposalId: current.proposalId,
        action: "cleared",
        at,
        actor: input.reviewer,
        ...(note ? { note } : {}),
      };
      this.db.prepare("DELETE FROM proposal_dedup_latches WHERE dedup_key = ?").run(input.dedupKey);
      this.insertDedupLatchAudit(event);
      this.db.exec("COMMIT");
      return clone(event);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFiles();
    }
  }

  /** Preparation carries no side effect; only a prepared plan may spend household attention. */
  markProposalReady(input: ProposalReadyInput): ProposalEnvelope {
    return this.transition(input, "ready transition", (current, at, revision) => {
      // A prepared plan is already ready; repeating the signal changes nothing,
      // so a retried preparation run stays safe.
      if (current.lifecycle === "ready") return current;
      if (current.lifecycle !== "preparing" && current.lifecycle !== "needs_info") {
        throw new ProposalStoreError("lifecycle_invalid", "Only a preparing proposal can become ready");
      }
      // The inbox only ever shows verified plans: a plan with something to
      // compile requires a succeeded preparation for exactly this revision,
      // and the ready envelope carries that preparation's immutable refs.
      const refs = requiresPreparation(current)
        ? this.preparedRefsForRevision(current.id, current.revision)
        : undefined;
      if (requiresPreparation(current)) {
        if (!this.preparationSucceededInTransaction(current.id, current.revision)) {
          throw new ProposalStoreError("lifecycle_invalid", "Preparation has not succeeded for this plan revision");
        }
        if (refs === undefined) {
          throw new ProposalStoreError("lifecycle_invalid", "Preparation refs are missing for this plan revision");
        }
      }
      if (current.reviewLane !== "migration"
        && this.readyCountInTransaction() >= MAX_PROPOSAL_CAPACITY) {
        throw new ProposalStoreError("capacity_full", "Household review capacity is full");
      }
      const { openQuestion: _open, ...base } = current;
      return {
        ...base,
        revision,
        lifecycle: "ready",
        ...(current.artifactCandidate === undefined
          ? {}
          : { preparedContentHash: proposalContentHash(preparedPlanSnapshot(current)) }),
        ...(refs === undefined ? {} : { preparedArtifact: refs }),
        updatedAt: at,
        audit: [...current.audit, this.auditEvent(at, "prepared", input.actor ?? "system", revision)],
      };
    });
  }

  private preparationSucceededInTransaction(proposalId: string, proposalRevision: number): boolean {
    const row = this.db.prepare(`SELECT status FROM approved_proposal_preparation_jobs
      WHERE proposal_id = ? AND proposal_revision = ?`).get(proposalId, proposalRevision) as { status?: unknown } | undefined;
    return row?.status === "succeeded";
  }

  /** Preparation may need one household answer; the question stays out of the inbox. */
  requestProposalInfo(input: ProposalInfoRequestInput): ProposalEnvelope {
    const question = input.question?.trim();
    if (typeof question !== "string" || question.length === 0 || question.length > 1_000) {
      throw new TypeError("proposal information question is invalid");
    }
    return this.transition(input, "information request", (current, at, revision) => {
      if (current.lifecycle !== "preparing") {
        throw new ProposalStoreError("lifecycle_invalid", "Only a preparing proposal can ask for information");
      }
      return {
        ...current,
        revision,
        lifecycle: "needs_info",
        openQuestion: question,
        updatedAt: at,
        audit: [...current.audit, this.auditEvent(at, "info_requested", input.actor ?? "system", revision)],
      };
    });
  }

  /** A failed enablement may retry once the household asks; the decision itself is already made. */
  beginDeploymentRetry(input: ProposalLifecycleInput & { readonly deploymentIntent?: ProposalDeploymentIntent }): ProposalEnvelope {
    return this.transition(input, "deployment retry", (current, at, revision) => {
      if (current.lifecycle !== "enable_failed") {
        throw new ProposalStoreError("lifecycle_invalid", "Only a failed enablement can retry");
      }
      // The intent survives every retry: same deterministic native id, same
      // target domain, so recovery always knows exactly where to look.
      const deploymentId = current.deployment?.deploymentId ?? input.deploymentIntent?.deploymentId;
      const target = current.deployment?.target ?? input.deploymentIntent?.target;
      const targets = current.deployment?.targets ?? input.deploymentIntent?.targets;
      return {
        ...current,
        revision,
        lifecycle: "enabling",
        applicationStatus: "deploying",
        deployment: {
          status: "pending",
          requestedAt: at,
          ...(deploymentId === undefined ? {} : { deploymentId }),
          ...(target === undefined ? {} : { target }),
          ...(targets === undefined ? {} : { targets }),
        },
        updatedAt: at,
        audit: [...current.audit, this.auditEvent(at, "deployment_retried", input.actor ?? "household-owner", revision)],
      };
    });
  }

  /** Records the deployment result. A running automation requires a verified deployment. */
  recordProposalDeployment(input: ProposalDeploymentRecordInput): ProposalEnvelope {
    const outcome = input.outcome;
    if (!outcome || (outcome.status !== "verified" && outcome.status !== "failed")) {
      throw new TypeError("proposal deployment outcome is invalid");
    }
    return this.transition(input, "deployment record", (current, at, revision) => {
      if (current.lifecycle !== "enabling") {
        throw new ProposalStoreError("lifecycle_invalid", "Only an enabling proposal records a deployment");
      }
      if (outcome.status === "verified" && current.deployment?.deploymentId !== undefined
        && (outcome.deploymentId !== current.deployment.deploymentId
          || (current.deployment.target !== undefined && outcome.target !== current.deployment.target))) {
        throw new ProposalStoreError("lifecycle_invalid", "The deployment outcome contradicts the recorded intent");
      }
      const requestedAt = current.deployment?.requestedAt ?? at;
      const reason = outcome.reason?.trim();
      const verified = outcome.status === "verified";
      return {
        ...current,
        revision,
        lifecycle: verified ? "active" : "enable_failed",
        applicationStatus: verified ? "running" : "failed",
        updatedAt: at,
        deployment: {
          status: verified ? "verified" : "failed",
          requestedAt,
          ...(outcome.deploymentId ? { deploymentId: outcome.deploymentId } : {}),
          ...(outcome.target ? { target: outcome.target } : {}),
          ...(current.deployment?.targets === undefined ? {} : { targets: current.deployment.targets }),
          ...(verified ? { verifiedAt: at } : { failedAt: at }),
          ...(reason ? { reason } : {}),
          ...(verified && outcome.configFingerprint ? { configFingerprint: outcome.configFingerprint } : {}),
        },
        audit: [...current.audit, {
          ...this.auditEvent(at, verified ? "deployment_verified" : "deployment_failed", input.actor ?? "system", revision),
          ...(reason ? { note: reason } : {}),
        }],
      };
    });
  }

  pauseAutomation(input: ProposalLifecycleInput): ProposalEnvelope {
    return this.transition(input, "pause", (current, at, revision) => {
      if (current.lifecycle !== "active") {
        throw new ProposalStoreError("lifecycle_invalid", "Only a running automation can pause");
      }
      return {
        ...current,
        revision,
        lifecycle: "paused",
        updatedAt: at,
        audit: [...current.audit, this.auditEvent(at, "paused", input.actor ?? "household-owner", revision)],
      };
    });
  }

  resumeAutomation(input: ProposalLifecycleInput): ProposalEnvelope {
    return this.transition(input, "resume", (current, at, revision) => {
      if (current.lifecycle !== "paused") {
        throw new ProposalStoreError("lifecycle_invalid", "Only a paused automation can resume");
      }
      return {
        ...current,
        revision,
        lifecycle: "active",
        updatedAt: at,
        audit: [...current.audit, this.auditEvent(at, "resumed", input.actor ?? "household-owner", revision)],
      };
    });
  }

  /**
   * The plan's actions stopped being automatable (an administrator escalation
   * or a lost authority). The card stays visible with an honest notice; the
   * household keeps the revise and decline entries and is never sent in a loop.
   */
  markEnableBlocked(input: ProposalLifecycleInput & { readonly reason: string; readonly kind: "not_configured" | "not_approved" | "unknown_capability" | "protected" }): ProposalEnvelope {
    const reason = input.reason?.trim();
    if (typeof reason !== "string" || reason.length === 0 || reason.length > 1_000) {
      throw new TypeError("proposal enable block reason is invalid");
    }
    return this.transition(input, "enable block", (current, at, revision) => {
      if (current.lifecycle !== "ready") {
        throw new ProposalStoreError("lifecycle_invalid", "Only a prepared plan records an enable block");
      }
      if (current.enableBlockedReason === reason && current.enableBlockedKind === input.kind) return current;
      return {
        ...current,
        revision,
        enableBlockedReason: reason,
        enableBlockedKind: input.kind,
        updatedAt: at,
        audit: [...current.audit, {
          ...this.auditEvent(at, "revalidation_required", input.actor ?? "system", revision),
          note: reason,
        }],
      };
    });
  }

  /**
   * A fresh, successful world validation lifts an enable block. Nothing else
   * clears the field on a standing plan: the audit records the recheck.
   */
  clearEnableBlock(input: ProposalLifecycleInput): ProposalEnvelope {
    return this.transition(input, "enable unblock", (current, at, revision) => {
      if (current.lifecycle !== "ready" || current.enableBlockedReason === undefined) {
        throw new ProposalStoreError("lifecycle_invalid", "Only a blocked prepared plan clears an enable block");
      }
      const { enableBlockedReason: _cleared, enableBlockedKind: _clearedKind, ...rest } = current;
      return {
        ...rest,
        revision,
        updatedAt: at,
        audit: [...current.audit, {
          ...this.auditEvent(at, "enable_unblocked", input.actor ?? "system", revision),
          note: "启用条件已恢复，方案重新可启用。",
        }],
      };
    });
  }

  /**
   * The world changed under a prepared plan (binding or authority drift): it
   * returns to preparation instead of being decidable, and a fresh preparation
   * job is queued for the new revision in the same transaction.
   */
  returnToPreparation(input: ProposalLifecycleInput & {
    readonly note?: string;
    /** Refreshed gate disclosure so the re-prepared card tells the current truth. */
    readonly updatedGateDisclosure?: {
      readonly actionPolicyClasses: readonly ("direct" | "confirmation")[];
      readonly confirmationDeviceNames?: readonly string[];
    };
  }): ProposalEnvelope {
    validateLifecycleInput(input, "revalidation");
    const at = this.timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.findById(input.proposalId);
      if (current === undefined) throw new ProposalStoreError("not_found", "Proposal was not found");
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        throw new ProposalStoreError("revision_conflict", "Proposal revision has changed");
      }
      if (current.lifecycle !== "ready") {
        throw new ProposalStoreError("lifecycle_invalid", "Only a prepared plan returns to preparation");
      }
      const revision = current.revision + 1;
      const note = input.note?.trim();
      const {
        snoozedUntil: _sleep,
        preparedContentHash: _hash,
        preparedArtifact: _refs,
        actionPolicyClasses: _staleClasses,
        confirmationDeviceNames: _staleNames,
        enableBlockedReason: _staleBlock,
        enableBlockedKind: _staleBlockKind,
        ...basePlan
      } = current;
      const disclosure = input.updatedGateDisclosure;
      const demoted: ProposalEnvelope = {
        ...basePlan,
        ...(disclosure === undefined
          ? {
              ...(current.actionPolicyClasses === undefined ? {} : { actionPolicyClasses: current.actionPolicyClasses }),
              ...(current.confirmationDeviceNames === undefined ? {} : { confirmationDeviceNames: current.confirmationDeviceNames }),
            }
          : {
              actionPolicyClasses: [...disclosure.actionPolicyClasses],
              ...(disclosure.confirmationDeviceNames === undefined || disclosure.confirmationDeviceNames.length === 0
                ? {}
                : { confirmationDeviceNames: [...disclosure.confirmationDeviceNames] }),
            }),
        revision,
        lifecycle: "preparing",
        updatedAt: at,
        audit: [...current.audit, {
          ...this.auditEvent(at, "revalidation_required", input.actor ?? "system", revision),
          ...(note ? { note } : {}),
        }],
      };
      this.updateProposal(demoted, current.revision);
      this.enqueuePreparationJob(demoted, at);
      this.db.exec("COMMIT");
      return clone(demoted);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFiles();
    }
  }

  /** Reflects whether the native runtime still holds the approved behavior. */
  setAutomationDrift(input: ProposalLifecycleInput & { readonly drifted: boolean }): ProposalEnvelope {
    if (typeof input?.drifted !== "boolean") throw new TypeError("proposal drift flag is invalid");
    return this.transition(input, "drift", (current, at, revision) => {
      if (current.lifecycle !== "active" && current.lifecycle !== "paused") {
        throw new ProposalStoreError("lifecycle_invalid", "Only a deployed automation records drift");
      }
      if (current.deployment === undefined || (current.deployment.drifted ?? false) === input.drifted) return current;
      return {
        ...current,
        revision,
        updatedAt: at,
        deployment: { ...current.deployment, drifted: input.drifted },
        audit: [...current.audit, this.auditEvent(at, input.drifted ? "drift_detected" : "drift_restored", input.actor ?? "system", revision)],
      };
    });
  }

  /** Closing withdraws the automation and records whether the original configuration returned. */
  closeAutomation(input: ProposalCloseInput): ProposalEnvelope {
    if (typeof input?.restored !== "boolean") throw new TypeError("proposal close restored flag is invalid");
    return this.transition(input, "close", (current, at, revision) => {
      if (current.lifecycle !== "active" && current.lifecycle !== "paused" && current.lifecycle !== "enable_failed") {
        throw new ProposalStoreError("lifecycle_invalid", "Only a deployed automation can close");
      }
      return {
        ...current,
        revision,
        lifecycle: "closed",
        applicationStatus: "withdrawn",
        updatedAt: at,
        ...(current.deployment === undefined ? {} : {
          deployment: {
            ...current.deployment,
            status: "rolled_back",
            ...(input.restored ? { restoredAt: at } : {}),
          },
        }),
        audit: [...current.audit, this.auditEvent(at, "closed", input.actor ?? "household-owner", revision)],
      };
    });
  }

  /** Records a migration-side effect that needs an explicit, non-approval recovery. */
  markRecoveryRequired(input: ProposalRecoveryRequiredInput): ProposalEnvelope {
    const reason = input?.reason?.trim();
    if (typeof reason !== "string" || reason.length === 0 || reason.length > 1_000) {
      throw new TypeError("proposal recovery reason is invalid");
    }
    return this.transition(input, "recovery required", (current, at, revision) => {
      if (current.lifecycle === "recovery_required") {
        throw new ProposalStoreError("lifecycle_invalid", "The migration already requires recovery");
      }
      if (current.reviewLane !== "migration"
        || (current.lifecycle !== "active" && current.lifecycle !== "paused" && current.lifecycle !== "enable_failed")
        || current.deployment === undefined) {
        throw new ProposalStoreError("lifecycle_invalid", "Only a deployed migration can require recovery");
      }
      return {
        ...current,
        revision,
        lifecycle: "recovery_required",
        applicationStatus: "failed",
        deployment: {
          ...current.deployment,
          status: "failed",
          failedAt: at,
          reason,
        },
        updatedAt: at,
        audit: [...current.audit, {
          ...this.auditEvent(at, "recovery_required", input.actor ?? "system", revision),
          note: reason,
        }],
      };
    });
  }

  /** Atomically records one bounded recovery attempt before external writes begin. */
  beginRecoveryAttempt(input: ProposalRecoveryAttemptInput): ProposalEnvelope {
    if (typeof input?.actor !== "string" || input.actor.trim().length === 0 || input.actor.length > 200) {
      throw new TypeError("proposal recovery actor is invalid");
    }
    return this.transition(input, "recovery attempt", (current, at, revision) => {
      if (current.lifecycle !== "recovery_required" || current.reviewLane !== "migration") {
        throw new ProposalStoreError("lifecycle_invalid", "Only a migration requiring recovery can start an attempt");
      }
      const previous = current.recoveryAttempts ?? [];
      if (previous.length >= 50) throw new ProposalStoreError("lifecycle_invalid", "Recovery attempt limit reached");
      const actor = input.actor.trim();
      return {
        ...current,
        revision,
        recoveryAttempts: [...previous, {
          id: `recovery-${this.id()}`,
          actor,
          revision,
          startedAt: at,
        }],
        updatedAt: at,
        audit: [...current.audit, this.auditEvent(at, "recovery_started", actor, revision)],
      };
    });
  }

  /** Records a bounded, known recovery failure without leaving recovery_required. */
  recordRecoveryFailure(input: ProposalRecoveryFailureInput): ProposalEnvelope {
    const reason = input?.reason?.trim();
    if (typeof reason !== "string" || reason.length === 0 || reason.length > 1_000) {
      throw new TypeError("proposal recovery failure reason is invalid");
    }
    if (typeof input?.actor !== "string" || input.actor.trim().length === 0 || input.actor.length > 200) {
      throw new TypeError("proposal recovery failure actor is invalid");
    }
    return this.transition(input, "recovery failure", (current, at, revision) => {
      if (current.lifecycle !== "recovery_required" || current.reviewLane !== "migration") {
        throw new ProposalStoreError("lifecycle_invalid", "Only a migration requiring recovery can record a failure");
      }
      const attempts = current.recoveryAttempts ?? [];
      if (attempts.length === 0) {
        throw new ProposalStoreError("lifecycle_invalid", "A recovery failure requires an active attempt");
      }
      const last = attempts.at(-1)!;
      return {
        ...current,
        revision,
        updatedAt: at,
        recoveryAttempts: [...attempts.slice(0, -1), { ...last, reason }],
        ...(current.deployment === undefined ? {} : {
          deployment: {
            ...current.deployment,
            status: "failed",
            failedAt: at,
            reason,
          },
        }),
        audit: [...current.audit, {
          ...this.auditEvent(at, "recovery_failed", input.actor, revision),
          note: reason,
        }],
      };
    });
  }

  /** Closes a migration only after the deployment seam has verified restoration. */
  completeRecovery(input: ProposalRecoveryCompleteInput): ProposalEnvelope {
    if (typeof input?.actor !== "string" || input.actor.trim().length === 0 || input.actor.length > 200) {
      throw new TypeError("proposal recovery actor is invalid");
    }
    return this.transition(input, "recovery complete", (current, at, revision) => {
      if (current.lifecycle !== "recovery_required" || current.reviewLane !== "migration") {
        throw new ProposalStoreError("lifecycle_invalid", "Only a migration requiring recovery can close");
      }
      const { recoveryAttempts: _attempts, ...withoutRecoveryAttempts } = current;
      return {
        ...withoutRecoveryAttempts,
        revision,
        lifecycle: "closed",
        applicationStatus: "withdrawn",
        updatedAt: at,
        ...(current.deployment === undefined ? {} : {
          deployment: {
            ...current.deployment,
            status: "rolled_back",
            restoredAt: at,
          },
        }),
        audit: [...current.audit, this.auditEvent(at, "closed", input.actor, revision)],
      };
    });
  }

  private auditEvent(at: string, action: ProposalAuditEvent["action"], actor: string, revision: number): ProposalAuditEvent {
    return { id: `audit-${this.id()}`, at, action, actor, revision };
  }

  private preparingCountInTransaction(): number {
    return this.countPendingByLifecycle((value) => value === "preparing" || value === "needs_info");
  }


  private readyCountInTransaction(): number {
    // ready + snoozed together bound how much unresolved business the Agent
    // may hold open with the household; sleeping hides a card, it does not
    // hand the Agent a fresh slot.
    return this.countPendingByLifecycle((value, payload) =>
      value === "ready" && payload.reviewLane !== "migration");
  }

  private countPendingByLifecycle(match: (
    lifecycle: unknown,
    payload: { snoozedUntil?: unknown; reviewLane?: unknown },
  ) => boolean): number {
    const rows = this.db.prepare(
      "SELECT payload_json FROM proposals WHERE status = 'pending_review'",
    ).all() as Array<{ payload_json?: unknown }>;
    let matched = 0;
    for (const row of rows) {
      if (typeof row.payload_json !== "string") continue;
      try {
        const payload = JSON.parse(row.payload_json) as {
          lifecycle?: unknown;
          snoozedUntil?: unknown;
          reviewLane?: unknown;
        };
        if (match(payload.lifecycle, payload)) matched += 1;
      } catch {
        throw new ProposalStoreError("corrupt_store", "Proposal review capacity is unavailable");
      }
    }
    return matched;
  }

  private transition(
    input: ProposalLifecycleInput,
    label: string,
    apply: (current: ProposalEnvelope, at: string, revision: number) => ProposalEnvelope,
  ): ProposalEnvelope {
    validateLifecycleInput(input, label);
    const at = this.timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.findById(input.proposalId);
      if (current === undefined) throw new ProposalStoreError("not_found", "Proposal was not found");
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        throw new ProposalStoreError("revision_conflict", "Proposal revision has changed");
      }
      const next = apply(current, at, current.revision + 1);
      this.updateProposal(next, current.revision);
      this.db.exec("COMMIT");
      return clone(next);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFiles();
    }
  }

  /**
   * "以后再说": the card sleeps and returns once before natural expiry. New
   * evidence for the same behavior wakes it early. There is no attempt cap and
   * no forced decision — expiry closes what the household never chose.
   */
  snoozeProposal(input: ProposalSnoozeInput): ProposalEnvelope {
    validateSnoozeInput(input);
    this.expireDue();
    const at = this.timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.findById(input.proposalId);
      if (current === undefined) throw new ProposalStoreError("not_found", "Proposal was not found");
      if (current.status !== "pending_review") {
        throw new ProposalStoreError("terminal_status", "A terminal proposal cannot be snoozed");
      }
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        throw new ProposalStoreError("revision_conflict", "Proposal revision has changed");
      }
      const revision = current.revision + 1;
      const oneWeek = Date.parse(at) + 7 * 24 * 3_600_000;
      const snoozedUntil = new Date(Math.min(oneWeek, Date.parse(current.expiresAt) - 3_600_000)).toISOString();
      if (Date.parse(snoozedUntil) <= Date.parse(at)) {
        throw new ProposalStoreError("terminal_status", "The proposal expires too soon to sleep");
      }
      const snoozed: ProposalEnvelope = {
        ...current,
        revision,
        snoozeCount: current.snoozeCount + 1,
        snoozedUntil,
        updatedAt: at,
        audit: [...current.audit, this.auditEvent(at, "snoozed", "household-owner", revision)],
      };
      this.updateProposal(snoozed, current.revision);
      this.db.exec("COMMIT");
      return clone(snoozed);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFiles();
    }
  }

  decideProposal(input: ProposalDecideInput): ProposalEnvelope {
    validateDecideInput(input);
    this.expireDue();
    const at = this.timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.findById(input.proposalId);
      if (current === undefined) throw new ProposalStoreError("not_found", "Proposal was not found");
      if (current.status !== "pending_review") {
        throw new ProposalStoreError("terminal_status", "A terminal proposal decision cannot be changed");
      }
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        throw new ProposalStoreError("revision_conflict", "Proposal revision has changed");
      }
      if (current.lifecycle !== "ready") {
        throw new ProposalStoreError("lifecycle_invalid", "The household decides on a prepared plan");
      }
      if (current.kind === "automation-draft" && current.artifactCandidate !== undefined
        && current.preparedContentHash !== proposalContentHash(preparedPlanSnapshot(current))) {
        throw new ProposalStoreError("lifecycle_invalid", "The plan changed after preparation; it must prepare again");
      }
      // Enablement of an automation is the deployment path; an approval without
      // a persisted intent would strand the proposal in enabling forever.
      const deployable = current.kind === "automation-draft" && current.artifactCandidate !== undefined;
      if (input.decision === "approve" && deployable
        && (input.deploymentIntent === undefined || input.deploymentIntent.targets.length === 0)) {
        throw new ProposalStoreError("lifecycle_invalid", "Automation enablement requires a deployment intent with its binding vector");
      }
      // The inverse also holds: only that combination deploys, so an intent on
      // any other decision would dress an insight up as a running automation.
      if (input.deploymentIntent !== undefined && (input.decision !== "approve" || !deployable)) {
        throw new ProposalStoreError("lifecycle_invalid", "A deployment intent only accompanies an automation approval");
      }
      const reviewer = (input.reviewer ?? input.reviewerId ?? "household-owner").trim();
      const feedbackCode = input.decision === "approve"
        ? "useful_as_is" as const
        : input.feedbackCode !== undefined && rejectionFeedbackCodes.includes(input.feedbackCode as ProposalRejectionFeedbackCode)
          ? input.feedbackCode
          : input.decision === "do_not_suggest" ? "household_preference" as const : "not_useful" as const;
      const revision = current.revision + 1;
      const status: ProposalStatus = input.decision === "approve" ? "approved" : "rejected";
      const note = input.note?.trim();
      const { snoozedUntil: _previousSnoozedUntil, ...baseCurrent } = current;
      const decided: ProposalEnvelope = {
        ...baseCurrent,
        revision,
        status,
        updatedAt: at,
        newEvidence: false,
        ...(status === "approved" && input.deploymentIntent !== undefined
          ? {
              lifecycle: "enabling" as const,
              applicationStatus: "deploying" as const,
              deployment: {
                status: "pending" as const,
                requestedAt: at,
                deploymentId: input.deploymentIntent.deploymentId,
                target: input.deploymentIntent.target,
                targets: input.deploymentIntent.targets,
              },
            }
          : {}),
        decision: {
          kind: input.decision,
          at,
          reviewer,
          ...(note ? { note } : {}),
        },
        review: {
          decision: status,
          reviewer,
          reviewedAt: at,
          feedbackCode,
          ...(note ? { note } : {}),
        },
        audit: [...current.audit, {
          id: `audit-${this.id()}`,
          at,
          action: status,
          actor: reviewer,
          revision,
          feedbackCode,
          ...(note ? { note } : {}),
        }],
      };
      this.updateProposal(decided, current.revision);
      if (input.decision === "do_not_suggest") {
        const latchId = `latch-${this.id()}`;
        try {
          this.db.prepare(`INSERT INTO proposal_dedup_latches
            (dedup_key, latch_id, proposal_id, created_at) VALUES (?, ?, ?, ?)`).run(
            current.dedupKey,
            latchId,
            current.id,
            at,
          );
        } catch {
          throw new ProposalStoreError("dedup_latched", "This behavior identity already has a do-not-suggest latch");
        }
        this.insertDedupLatchAudit({
          id: `latch-audit-${this.id()}`,
          dedupKey: current.dedupKey,
          latchId,
          proposalId: current.id,
          action: "created",
          at,
          actor: reviewer,
          ...(note ? { note } : {}),
        });
      }
      if (decided.status === "approved"
        && decided.kind === "automation-draft"
        && decided.artifactCandidate !== undefined) {

      }
      this.db.exec("COMMIT");
      return clone(decided);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFiles();
    }
  }

  listDedupLatches(): readonly ProposalDedupLatch[] {
    const rows = this.db.prepare(`SELECT latch_id, dedup_key, proposal_id, created_at
      FROM proposal_dedup_latches ORDER BY created_at ASC, latch_id ASC`).all() as ProposalDedupLatchRow[];
    return rows.map(fromDedupLatchRow);
  }

  hasDedupLatch(dedupKey: string): boolean {
    validateBoundedKey(dedupKey, "proposal dedup key");
    const row = this.db.prepare("SELECT 1 AS present FROM proposal_dedup_latches WHERE dedup_key = ?")
      .get(dedupKey) as { present?: unknown } | undefined;
    return row !== undefined;
  }

  /** Expires due pending proposals and clears due snooze metadata atomically. */
  expireDue(): readonly ProposalEnvelope[] {
    const at = this.timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.expireDueInTransaction(at);
      this.promotePreparedInTransaction(at);
      this.db.exec("COMMIT");
      return changed.map(clone);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFiles();
    }
  }

  /**
   * Runs a synchronous operation against the exact current approved source.
   * The store is intentionally single-current-revision today: an older
   * revision is rejected rather than silently reinterpreted as the current
   * payload. The projection is deeply frozen before it crosses this seam.
   */
  withApprovedProposalAtRevision<T>(
    proposalId: string,
    revision: number,
    operation: (source: HubVerifiedProposalSource) => T,
  ): T {
    validateProposalSourceQuery(proposalId, revision, operation);
    this.db.exec("BEGIN IMMEDIATE");
    let callbackStarted = false;
    try {
      const row = this.db.prepare(`SELECT
          proposal_id, producer, idempotency_key, status, revision,
          created_at, updated_at, payload_json
        FROM proposals WHERE proposal_id = ?`).get(proposalId) as ProposalRow | undefined;
      if (!row) throw new ProposalStoreError("not_found", "Proposal was not found");
      const proposal = fromRow(row);
      if (proposal.revision !== revision) {
        throw new ProposalStoreError("revision_conflict", "Proposal source revision is not current");
      }
      if (proposal.kind !== "automation-draft"
        || proposal.status !== "pending_review"
        || proposal.applicationStatus !== "not_available"
        || !PREPARABLE_LIFECYCLES.includes(proposal.lifecycle)
        || proposal.artifactCandidate === undefined) {
        throw new ProposalStoreError("source_unavailable", "Proposal is not a preparable automation source");
      }
      const source = freezeSource({
        proposalId: proposal.id,
        revision: proposal.revision,
        kind: proposal.kind,
        status: proposal.status,
        applicationStatus: proposal.applicationStatus,
        title: proposal.title,
        summary: proposal.summary,
        intent: proposal.intent,
        evidence: proposal.evidence,
        conflictCheck: proposal.conflictCheck,
        risk: proposal.risk,
        artifactCandidate: proposal.artifactCandidate,
      });
      callbackStarted = true;
      const result = operation(source);
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError("Approved proposal source callback must be synchronous");
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the first failure; the next store operation will fail closed.
      }
      if (callbackStarted) throw error;
      if (error instanceof ProposalStoreError || error instanceof TypeError) throw error;
      throw new ProposalStoreError("corrupt_store", "Approved proposal source is unavailable");
    } finally {
      this.ensurePrivateFiles();
    }
  }

  /**
   * Holds the proposal write lock while projecting only exact event evidence
   * refs. The callback runs before commit so retention can hold this snapshot
   * while the journal transaction deletes eligible rows; proposal text never
   * enters the projection.
   */
  withRetentionEvidence<T>(
    bridgeId: string,
    limit: number,
    operation: (references: readonly ProposalRetentionEvidenceReference[]) => T,
  ): T {
    validateRetentionEvidenceQuery(bridgeId, limit);
    this.db.exec("BEGIN IMMEDIATE");
    let callbackStarted = false;
    try {
      const references = this.readRetentionEvidence(bridgeId, limit);
      callbackStarted = true;
      const result = operation(references);
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError("Retention evidence callback must be synchronous");
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the first failure; the next store operation will fail closed.
      }
      if (callbackStarted) throw error;
      if (error instanceof ProposalStoreError) throw error;
      throw new ProposalStoreError("corrupt_store", "Proposal retention evidence is unavailable");
    } finally {
      this.ensurePrivateFiles();
    }
  }

  /** Aggregates bounded lifecycle/feedback metadata without loading proposal content into callers. */
  qualitySummary(): ProposalQualitySummary {
    this.expireDue();
    const statuses: Record<ProposalStatus, number> = {
      pending_review: 0,
      approved: 0,
      rejected: 0,
      expired: 0,
    };
    const feedback: Record<ProposalReviewFeedbackCode, number> = {
      useful_as_is: 0,
      already_covered: 0,
      not_useful: 0,
      incorrect_assumption: 0,
      insufficient_evidence: 0,
      household_preference: 0,
      too_risky: 0,
      other: 0,
    };
    const statusRows = this.db.prepare("SELECT status, COUNT(*) AS count FROM proposals GROUP BY status").all() as Record<string, unknown>[];
    for (const row of statusRows) {
      const status = String(row.status) as ProposalStatus;
      const count = Number(row.count);
      if (!Object.hasOwn(statuses, status) || !Number.isSafeInteger(count) || count < 0) {
        throw new ProposalStoreError("corrupt_store", "Proposal quality metadata is corrupt");
      }
      statuses[status] = count;
    }
    const feedbackRows = this.db.prepare(`SELECT
        json_extract(payload_json, '$.review.feedbackCode') AS feedback_code,
        COUNT(*) AS count
      FROM proposals
      WHERE status IN ('approved', 'rejected')
      GROUP BY feedback_code`).all() as Record<string, unknown>[];
    let reviewedWithoutFeedback = 0;
    for (const row of feedbackRows) {
      const count = Number(row.count);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new ProposalStoreError("corrupt_store", "Proposal quality metadata is corrupt");
      }
      if (row.feedback_code === null || row.feedback_code === undefined) {
        reviewedWithoutFeedback += count;
        continue;
      }
      const code = String(row.feedback_code) as ProposalReviewFeedbackCode;
      if (!Object.hasOwn(feedback, code)) {
        throw new ProposalStoreError("corrupt_store", "Proposal quality metadata is corrupt");
      }
      feedback[code] = count;
    }
    return {
      total: Object.values(statuses).reduce((sum, count) => sum + count, 0),
      statuses,
      feedback,
      reviewedWithoutFeedback,
    };
  }

  /** Returns only the bounded reviewed-topic projection needed for Agent calibration. */
  calibrationHistory(limit = 10): readonly ProposalCalibrationItem[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new TypeError("proposal calibration limit must be an integer from 1 to 20");
    }
    const rows = this.db.prepare(`SELECT
        proposal_id, producer, idempotency_key, status, revision,
        created_at, updated_at, payload_json
      FROM proposals
      WHERE status IN ('approved', 'rejected')
      ORDER BY updated_at DESC, proposal_id DESC LIMIT ?`).all(limit) as ProposalRow[];
    return rows.map((row) => {
      const proposal = fromRow(row);
      const review = proposal.review!;
      return {
        proposalId: proposal.id,
        kind: proposal.kind,
        title: proposal.title,
        decision: review.decision as "approved" | "rejected",
        reviewedAt: review.reviewedAt,
        ...(review.feedbackCode === undefined ? {} : { feedbackCode: review.feedbackCode }),
      };
    });
  }

  review(input: ReviewProposalInput): ProposalEnvelope {
    validateReviewInput(input);
    this.expireDue();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const at = this.timestamp();
      const current = this.findById(input.proposalId);
      if (!current) throw new ProposalStoreError("not_found", "Proposal was not found");
      if (current.revision !== input.expectedRevision) {
        throw new ProposalStoreError("revision_conflict", "Proposal revision has changed");
      }
      if (current.status !== "pending_review") {
        throw new ProposalStoreError("terminal_status", "A terminal review decision cannot be changed");
      }
      if (current.lifecycle !== "ready") {
        throw new ProposalStoreError("lifecycle_invalid", "The household decides on a prepared plan");
      }
      if (input.decision === "approved"
        && current.kind === "automation-draft" && current.artifactCandidate !== undefined) {
        throw new ProposalStoreError("lifecycle_invalid", "Automation enablement walks the deployment path");
      }
      if (current.kind === "automation-draft" && current.artifactCandidate !== undefined
        && current.preparedContentHash !== proposalContentHash(preparedPlanSnapshot(current))) {
        throw new ProposalStoreError("lifecycle_invalid", "The plan changed after preparation; it must prepare again");
      }
      const revision = current.revision + 1;
      const note = input.note?.trim();
      const feedbackCode = input.decision === "expired" ? undefined : input.feedbackCode;
      const governanceDecision = input.decision === "approved"
        ? { kind: "approve" as const, at, reviewer: input.reviewer.trim(), ...(note ? { note } : {}) }
        : input.decision === "rejected"
          ? { kind: "reject_once" as const, at, reviewer: input.reviewer.trim(), ...(note ? { note } : {}) }
          : undefined;
      const { snoozedUntil: _previousSnoozedUntil, ...baseCurrent } = current;
      const reviewed: ProposalEnvelope = {
        ...baseCurrent,
        revision,
        status: input.decision,
        updatedAt: at,
        newEvidence: false,

        ...(governanceDecision === undefined ? {} : { decision: governanceDecision }),
        review: {
          decision: input.decision,
          reviewer: input.reviewer.trim(),
          reviewedAt: at,
          ...(feedbackCode ? { feedbackCode } : {}),
          ...(note ? { note } : {}),
        },
        audit: [...current.audit, {
          id: `audit-${this.id()}`,
          at,
          action: input.decision,
          actor: input.reviewer.trim(),
          revision,
          ...(feedbackCode ? { feedbackCode } : {}),
          ...(note ? { note } : {}),
        }],
      };
      this.updateProposal(reviewed, current.revision);
      if (reviewed.status === "approved"
        && reviewed.kind === "automation-draft"
        && reviewed.artifactCandidate !== undefined) {

      }
      this.db.exec("COMMIT");
      return clone(reviewed);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFiles();
    }
  }

  listPreparationJobs(limit = 100): readonly ArtifactPreparationJob[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("preparation job list limit is invalid");
    }
    const rows = this.db.prepare(`SELECT job_id, proposal_id, proposal_revision,
        idempotency_key, status, attempt, version, stage, error_code, created_at, updated_at
      FROM approved_proposal_preparation_jobs
      ORDER BY created_at ASC, job_id ASC LIMIT ?`).all(limit) as ArtifactPreparationJobRow[];
    return rows.map(fromPreparationJobRow);
  }

  getPreparationJob(jobId: string): ArtifactPreparationJob | undefined {
    validatePreparationJobId(jobId);
    const row = this.db.prepare(`SELECT job_id, proposal_id, proposal_revision,
        idempotency_key, status, attempt, version, stage, error_code, created_at, updated_at
      FROM approved_proposal_preparation_jobs WHERE job_id = ?`).get(jobId) as ArtifactPreparationJobRow | undefined;
    return row === undefined ? undefined : fromPreparationJobRow(row);
  }

  getPreparationJobForProposal(
    proposalId: string,
    proposalRevision: number,
  ): ArtifactPreparationJob | undefined {
    if (typeof proposalId !== "string"
      || proposalId.length === 0
      || proposalId.trim() !== proposalId
      || Buffer.byteLength(proposalId, "utf8") > 200) {
      throw new TypeError("preparation job proposal id is invalid");
    }
    if (!Number.isSafeInteger(proposalRevision) || proposalRevision < 1) {
      throw new TypeError("preparation job proposal revision is invalid");
    }
    const row = this.db.prepare(`SELECT job_id, proposal_id, proposal_revision,
        idempotency_key, status, attempt, version, stage, error_code, created_at, updated_at
      FROM approved_proposal_preparation_jobs
      WHERE proposal_id = ? AND proposal_revision = ?`).get(
      proposalId,
      proposalRevision,
    ) as ArtifactPreparationJobRow | undefined;
    return row === undefined ? undefined : fromPreparationJobRow(row);
  }

  claimPreparationJob(input: ArtifactPreparationJobTransition): ArtifactPreparationJob {
    return this.transitionPreparationJob(input, "queued", "running");
  }

  /**
   * Success persists the immutable preparation refs on the job row itself, so
   * both immediate and deferred promotion copy the same receipt and a crash
   * between completion and promotion loses nothing.
   */
  completePreparationJob(
    input: ArtifactPreparationJobTransition & { readonly preparedArtifact: PreparedArtifactRefs },
  ): ArtifactPreparationJob {
    const refs = validatePreparedRefs(input.preparedArtifact);
    validatePreparationTransition(input);
    return this.mutatePreparationJob(input, (current, at) => {
      if (current.status !== "running") throw preparationTransitionConflict();
      return {
        status: "succeeded",
        attempt: current.attempt,
        version: current.version + 1,
        updatedAt: at,
        preparedRefsJson: JSON.stringify(refs),
      };
    });
  }

  private preparedRefsForRevision(proposalId: string, proposalRevision: number): PreparedArtifactRefs | undefined {
    const row = this.db.prepare(`SELECT prepared_refs_json FROM approved_proposal_preparation_jobs
      WHERE proposal_id = ? AND proposal_revision = ? AND status = 'succeeded'`)
      .get(proposalId, proposalRevision) as { prepared_refs_json?: unknown } | undefined;
    if (typeof row?.prepared_refs_json !== "string") return undefined;
    try {
      return validatePreparedRefs(JSON.parse(row.prepared_refs_json));
    } catch {
      return undefined;
    }
  }

  failPreparationJob(input: ArtifactPreparationJobFailure): ArtifactPreparationJob {
    validatePreparationFailure(input);
    return this.mutatePreparationJob(input, (current, at) => {
      if (current.status !== "running") throw preparationTransitionConflict();
      return {
        status: "failed",
        attempt: current.attempt,
        version: current.version + 1,
        stage: input.stage,
        errorCode: input.code,
        updatedAt: at,
      };
    });
  }

  retryPreparationJob(input: ArtifactPreparationJobTransition): ArtifactPreparationJob {
    validatePreparationTransition(input);
    return this.mutatePreparationJob(input, (current, at) => {
      if (current.status !== "failed") throw preparationTransitionConflict();
      if (current.attempt >= MAX_ARTIFACT_PREPARATION_ATTEMPTS) {
        throw new ProposalStoreError("job_transition_conflict", "Preparation attempt limit reached");
      }
      return {
        status: "queued",
        attempt: current.attempt + 1,
        version: current.version + 1,
        updatedAt: at,
      };
    });
  }

  private transitionPreparationJob(
    input: ArtifactPreparationJobTransition,
    expectedStatus: ArtifactPreparationJobStatus,
    nextStatus: ArtifactPreparationJobStatus,
  ): ArtifactPreparationJob {
    validatePreparationTransition(input);
    return this.mutatePreparationJob(input, (current, at) => {
      if (current.status !== expectedStatus) throw preparationTransitionConflict();
      return {
        status: nextStatus,
        attempt: current.attempt,
        version: current.version + 1,
        updatedAt: at,
      };
    });
  }

  private mutatePreparationJob(
    input: ArtifactPreparationJobTransition,
    mutation: (current: ArtifactPreparationJob, at: string) => ArtifactPreparationJobMutation,
  ): ArtifactPreparationJob {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getPreparationJob(input.jobId);
      if (current === undefined) throw new ProposalStoreError("not_found", "Preparation job was not found");
      if (current.version !== input.expectedVersion) throw preparationTransitionConflict();
      const next = mutation(current, this.timestamp());
      const result = next.preparedRefsJson === undefined
        ? this.db.prepare(`UPDATE approved_proposal_preparation_jobs
            SET status = ?, attempt = ?, version = ?, stage = ?, error_code = ?, updated_at = ?
            WHERE job_id = ? AND version = ? AND status = ?`).run(
          next.status,
          next.attempt,
          next.version,
          next.stage ?? null,
          next.errorCode ?? null,
          next.updatedAt,
          current.jobId,
          current.version,
          current.status,
        )
        // Success and its receipt refs commit in one statement: a crash can
        // never leave a succeeded job that cannot promote its proposal.
        : this.db.prepare(`UPDATE approved_proposal_preparation_jobs
            SET status = ?, attempt = ?, version = ?, stage = ?, error_code = ?, updated_at = ?, prepared_refs_json = ?
            WHERE job_id = ? AND version = ? AND status = ?`).run(
          next.status,
          next.attempt,
          next.version,
          next.stage ?? null,
          next.errorCode ?? null,
          next.updatedAt,
          next.preparedRefsJson,
          current.jobId,
          current.version,
          current.status,
        );
      if (Number(result.changes) !== 1) throw preparationTransitionConflict();
      const updated = this.getPreparationJob(current.jobId);
      if (updated === undefined) throw new ProposalStoreError("corrupt_store", "Preparation job disappeared");
      this.db.exec("COMMIT");
      return updated;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFiles();
    }
  }

  /** Preparation begins at admission; it has no side effect and no household cost. */
  private enqueuePreparationJob(proposal: ProposalEnvelope, at: string): void {
    if (proposal.kind !== "automation-draft" || proposal.artifactCandidate === undefined) return;
    const material = `approved-proposal-preparation-v1\n${proposal.id.length}:${proposal.id}\n${proposal.revision}`;
    const digest = createHash("sha256").update(material).digest("hex");
    this.db.prepare(`INSERT INTO approved_proposal_preparation_jobs
      (job_id, proposal_id, proposal_revision, idempotency_key, status, attempt,
       version, stage, error_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', 1, 1, NULL, NULL, ?, ?)`).run(
      `preparation-${digest}`,
      proposal.id,
      proposal.revision,
      `sha256:${digest}`,
      at,
      at,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private findByIdempotency(producer: string, idempotencyKey: string): ProposalEnvelope | undefined {
    const alias = this.db.prepare(`SELECT proposal_id
      FROM ${PROPOSAL_IDEMPOTENCY_ALIASES_TABLE}
      WHERE producer = ? AND idempotency_key = ?`).get(producer, idempotencyKey) as { proposal_id?: unknown } | undefined;
    if (alias !== undefined) {
      if (typeof alias.proposal_id !== "string") {
        throw new ProposalStoreError("corrupt_store", "Proposal idempotency alias is corrupt");
      }
      const proposal = this.findById(alias.proposal_id);
      if (proposal === undefined) throw new ProposalStoreError("corrupt_store", "Proposal idempotency alias is dangling");
      return proposal;
    }
    const row = this.db.prepare(`SELECT
        proposal_id, producer, idempotency_key, status, revision,
        created_at, updated_at, payload_json
      FROM proposals
      WHERE producer = ? AND idempotency_key = ?`).get(producer, idempotencyKey) as ProposalRow | undefined;
    if (row === undefined) return undefined;
    const proposal = fromRow(row);
    this.insertIdempotencyAlias(proposal.provenance.producer, proposal.idempotencyKey, proposal.id);
    return proposal;
  }

  private findById(proposalId: string): ProposalEnvelope | undefined {
    const row = this.db.prepare(`SELECT
        proposal_id, producer, idempotency_key, status, revision,
        created_at, updated_at, payload_json
      FROM proposals WHERE proposal_id = ?`).get(proposalId) as ProposalRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  private findUnresolvedByDedupKey(dedupKey: string): ProposalEnvelope | undefined {
    const rows = this.db.prepare(`SELECT
        proposal_id, producer, idempotency_key, status, revision,
        created_at, updated_at, payload_json
      FROM proposals WHERE status = 'pending_review'
      ORDER BY updated_at DESC, proposal_id DESC`).all() as ProposalRow[];
    return rows.map(fromRow).find((proposal) => proposal.dedupKey === dedupKey);
  }

  private findByDedupKey(dedupKey: string): ProposalEnvelope | undefined {
    const rows = this.db.prepare(`SELECT
        proposal_id, producer, idempotency_key, status, revision,
        created_at, updated_at, payload_json
      FROM proposals
      ORDER BY updated_at DESC, proposal_id DESC`).all() as ProposalRow[];
    return rows.map(fromRow).find((proposal) => proposal.dedupKey === dedupKey);
  }

  private findDedupLatch(dedupKey: string): ProposalDedupLatch | undefined {
    const row = this.db.prepare(`SELECT latch_id, dedup_key, proposal_id, created_at
      FROM proposal_dedup_latches WHERE dedup_key = ?`).get(dedupKey) as ProposalDedupLatchRow | undefined;
    return row === undefined ? undefined : fromDedupLatchRow(row);
  }

  private insertDedupLatchAudit(event: ProposalDedupLatchAuditEvent): void {
    this.db.prepare(`INSERT INTO proposal_dedup_latch_audit
      (event_id, dedup_key, latch_id, proposal_id, action, at, actor, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.id,
      event.dedupKey,
      event.latchId,
      event.proposalId,
      event.action,
      event.at,
      event.actor,
      event.note ?? null,
    );
  }

  private insertIdempotencyAlias(producer: string, idempotencyKey: string, proposalId: string): void {
    const existing = this.db.prepare(`SELECT proposal_id FROM ${PROPOSAL_IDEMPOTENCY_ALIASES_TABLE}
      WHERE producer = ? AND idempotency_key = ?`).get(producer, idempotencyKey) as { proposal_id?: unknown } | undefined;
    if (existing !== undefined) {
      if (existing.proposal_id !== proposalId) {
        throw new ProposalStoreError("corrupt_store", "Proposal idempotency key maps to multiple proposals");
      }
      return;
    }
    this.db.prepare(`INSERT INTO ${PROPOSAL_IDEMPOTENCY_ALIASES_TABLE}
      (producer, idempotency_key, proposal_id) VALUES (?, ?, ?)`).run(producer, idempotencyKey, proposalId);
  }

  private updateProposal(proposal: ProposalEnvelope, expectedRevision: number): void {
    const result = this.db.prepare(`UPDATE proposals
      SET status = ?, revision = ?, updated_at = ?, payload_json = ?
      WHERE proposal_id = ? AND revision = ?`).run(
      proposal.status,
      proposal.revision,
      proposal.updatedAt,
      JSON.stringify(proposal),
      proposal.id,
      expectedRevision,
    );
    if (Number(result.changes) !== 1) {
      throw new ProposalStoreError("revision_conflict", "Proposal revision has changed");
    }
  }

  /**
   * Promotes prepared-but-deferred proposals as inbox slots free up. Promotion
   * requires a succeeded preparation job for the proposal's current revision.
   */
  private promotePreparedInTransaction(at: string): void {
    const rows = this.db.prepare(`SELECT
        proposal_id, producer, idempotency_key, status, revision,
        created_at, updated_at, payload_json
      FROM proposals WHERE status = 'pending_review'`).all() as ProposalRow[];
    let available = MAX_PROPOSAL_CAPACITY - this.readyCountInTransaction();
    for (const row of rows) {
      const current = fromRow(row);
      if (current.lifecycle !== "preparing") continue;
      if (current.reviewLane !== "migration" && available <= 0) continue;
      const job = this.db.prepare(`SELECT status FROM approved_proposal_preparation_jobs
        WHERE proposal_id = ? AND proposal_revision = ?`).get(current.id, current.revision) as { status?: unknown } | undefined;
      if (job?.status !== "succeeded") continue;
      const refs = this.preparedRefsForRevision(current.id, current.revision);
      if (requiresPreparation(current) && refs === undefined) continue;
      const revision = current.revision + 1;
      const { openQuestion: _open, ...base } = current;
      const promoted: ProposalEnvelope = {
        ...base,
        revision,
        lifecycle: "ready",
        ...(current.artifactCandidate === undefined
          ? {}
          : { preparedContentHash: proposalContentHash(preparedPlanSnapshot(current)) }),
        ...(refs === undefined ? {} : { preparedArtifact: refs }),
        updatedAt: at,
        audit: [...current.audit, this.auditEvent(at, "prepared", "system", revision)],
      };
      this.updateProposal(promoted, current.revision);
      if (current.reviewLane !== "migration") available -= 1;
    }
  }

  private expireDueInTransaction(at: string): ProposalEnvelope[] {
    const rows = this.db.prepare(`SELECT
        proposal_id, producer, idempotency_key, status, revision,
        created_at, updated_at, payload_json
      FROM proposals WHERE status = 'pending_review'`).all() as ProposalRow[];
    const changed: ProposalEnvelope[] = [];
    for (const row of rows) {
      const current = fromRow(row);
      const now = Date.parse(at);
      if (Date.parse(current.expiresAt) <= now) {
        const revision = current.revision + 1;
        const { snoozedUntil: _snoozedUntil, decision: _decision, ...base } = current;
        const expired: ProposalEnvelope = {
          ...base,
          revision,
          status: "expired",
          updatedAt: at,
          newEvidence: false,
          review: { decision: "expired", reviewer: "system", reviewedAt: at },
          audit: [...current.audit, {
            id: `audit-${this.id()}`,
            at,
            action: "expired",
            actor: "system",
            revision,
          }],
        };
        this.updateProposal(expired, current.revision);
        changed.push(expired);
        continue;
      }
      if (current.snoozedUntil !== undefined && Date.parse(current.snoozedUntil) <= now) {
        const revision = current.revision + 1;
        const { snoozedUntil: _snoozedUntil, ...base } = current;
        const reopened: ProposalEnvelope = {
          ...base,
          revision,
          updatedAt: at,
          audit: [...current.audit, {
            id: `audit-${this.id()}`,
            at,
            action: "snooze_elapsed",
            actor: "system",
            revision,
          }],
        };
        this.updateProposal(reopened, current.revision);
        changed.push(reopened);
      }
    }
    return changed;
  }

  private readRetentionEvidence(
    bridgeId: string,
    limit: number,
  ): readonly ProposalRetentionEvidenceReference[] {
    let rows: Record<string, unknown>[];
    try {
      rows = this.db.prepare(`SELECT
          p.proposal_id AS proposal_id,
          p.producer AS producer,
          p.idempotency_key AS idempotency_key,
          p.status AS status,
          p.revision AS revision,
          p.created_at AS created_at,
          p.updated_at AS updated_at,
          p.payload_json AS payload_json,
          CAST(reference.key AS INTEGER) AS reference_index,
          json_extract(reference.value, '$.bridgeId') AS bridge_id,
          json_extract(reference.value, '$.source') AS source,
          json_extract(reference.value, '$.epochId') AS epoch_id,
          json_extract(reference.value, '$.seq') AS seq
        FROM proposals AS p
        JOIN json_each(p.payload_json, '$.evidence.references') AS reference
        WHERE json_extract(reference.value, '$.bridgeId') = ?
          AND json_extract(reference.value, '$.source') = 'post-baseline-event'
        ORDER BY p.proposal_id ASC, reference_index ASC
        LIMIT ?`).all(bridgeId, limit + 1) as Record<string, unknown>[];
    } catch {
      throw new ProposalStoreError("corrupt_store", "Proposal retention evidence is unavailable");
    }
    if (rows.length > limit) {
      throw new ProposalStoreError("retention_evidence_limit", "Proposal retention evidence exceeds the bounded limit");
    }
    const references: ProposalRetentionEvidenceReference[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const proposal = fromRow(row as ProposalRow);
      const proposalId = row.proposal_id;
      const revision = Number(row.revision);
      const referenceIndex = Number(row.reference_index);
      const referenceBridgeId = row.bridge_id;
      const source = row.source;
      const epochId = row.epoch_id;
      const seq = Number(row.seq);
      const persistedReference = proposal.evidence.references[referenceIndex];
      if (typeof proposalId !== "string" || proposalId.length === 0 || proposalId.length > 200
        || proposal.id !== proposalId
        || proposal.revision !== revision
        || !Number.isSafeInteger(revision) || revision < 1
        || !Number.isSafeInteger(referenceIndex) || referenceIndex < 0
        || referenceBridgeId !== bridgeId
        || source !== "post-baseline-event"
        || typeof epochId !== "string" || epochId.length === 0 || epochId.length > 200
        || !Number.isSafeInteger(seq) || seq < 0
        || persistedReference?.bridgeId !== bridgeId
        || persistedReference.source !== "post-baseline-event"
        || persistedReference.epochId !== epochId
        || persistedReference.seq !== seq) {
        throw new ProposalStoreError("corrupt_store", "Proposal retention evidence is invalid");
      }
      const referenceId = `${proposalId}:${revision}:${referenceIndex}`;
      if (referenceId.length > 200 || seen.has(referenceId)) {
        throw new ProposalStoreError("corrupt_store", "Proposal retention evidence is invalid");
      }
      seen.add(referenceId);
      references.push({ referenceId, bridgeId, epochId, seq });
    }
    return references;
  }

  private timestamp(): string {
    const value = this.now();
    if (!isoTimestamp.safeParse(value).success) throw new TypeError("proposal clock must return an ISO timestamp");
    return value;
  }

  private ensurePrivateFiles(): void {
    ensurePrivateSqliteFiles(this.path);
  }
}

function mergeProposalEvidence(
  current: ProposalEnvelope,
  input: PersistedProposalInput,
  at: string,
  id: () => string,
): { readonly proposal: ProposalEnvelope; readonly mergedEvidenceCount: number } {
  const temporalMode = current.evidence.temporal !== undefined || input.evidence.temporal !== undefined
    || current.evidence.references.some((reference) => reference.source === "post-baseline-event")
    || input.evidence.references.some((reference) => reference.source === "post-baseline-event");
  const references = current.evidence.references.filter((reference) => temporalMode
    ? reference.source === "post-baseline-event"
    : reference.source !== "post-baseline-event");
  const referenceKeys = new Set(references.map(evidenceReferenceKey));
  let mergedEvidenceCount = 0;
  for (const reference of input.evidence.references) {
    if ((temporalMode && reference.source !== "post-baseline-event")
      || (!temporalMode && reference.source === "post-baseline-event")) continue;
    const key = evidenceReferenceKey(reference);
    if (referenceKeys.has(key) || references.length >= 50) continue;
    referenceKeys.add(key);
    references.push(reference);
    mergedEvidenceCount += 1;
  }
  const watermarks = [...current.evidence.watermarks];
  const watermarksByBridge = new Map(watermarks.map((item) => [item.bridgeId, item] as const));
  for (const watermark of input.evidence.watermarks) {
    const previous = watermarksByBridge.get(watermark.bridgeId);
    if (previous === undefined || watermark.lastSeq >= previous.lastSeq) {
      watermarksByBridge.set(watermark.bridgeId, watermark);
    }
  }
  const mergedEvidence = {
    ...current.evidence,
    references,
    watermarks: [...watermarksByBridge.values()].slice(0, 16),
    ...(temporalMode
      ? { temporal: input.evidence.temporal ?? current.evidence.temporal }
      : {}),
  };
  // Any change to what the household would see and authorize is a plan
  // revision — a title-only or risk-only replacement never disappears.
  const revisedPlan = proposalContentHash(preparedPlanSnapshot(input)) !== proposalContentHash(preparedPlanSnapshot(current));
  if (mergedEvidenceCount === 0 && !revisedPlan) return { proposal: current, mergedEvidenceCount: 0 };
  const revision = current.revision + 1;
  const requiresPreparationAfterMerge = current.kind === "automation-draft"
    && (revisedPlan ? input.artifactCandidate !== undefined : current.artifactCandidate !== undefined);
  const {
    snoozedUntil: _sleep,
    preparedContentHash: _preparedHash,
    preparedArtifact: _preparedRefs,
    enableBlockedReason: _staleBlock,
    enableBlockedKind: _staleBlockKind,
    ...base
  } = current;
  return {
    proposal: {
      ...base,
      revision,
      updatedAt: at,
      evidence: mergedEvidence,
      newEvidence: true,
      // New evidence or a revised plan wakes the card and sends it back through
      // preparation; the household only ever decides on a re-verified plan.
      ...(revisedPlan ? {
        // The revision replaces the full household-visible snapshot — including
        // absent optional fields, which clear instead of leaking stale values.
        artifactCandidate: input.artifactCandidate,
        title: input.title,
        summary: input.summary,
        intent: input.intent,
        rationale: input.rationale,
        risk: input.risk,
        actionPolicyClasses: input.actionPolicyClasses,
        confirmationDeviceNames: input.confirmationDeviceNames,
      } : {}),
      ...(requiresPreparationAfterMerge ? { lifecycle: "preparing" as const } : {}),
      audit: [...current.audit, {
        id: `audit-${id()}`,
        at,
        action: "evidence_merged",
        actor: input.provenance.producer,
        revision,
      }],
    },
    mergedEvidenceCount,
  };
}

function mergeEvidenceData(
  current: CreateProposalInput["evidence"],
  input: CreateProposalInput["evidence"],
): { readonly evidence: CreateProposalInput["evidence"]; readonly mergedEvidenceCount: number } {
  const temporalMode = current.temporal !== undefined || input.temporal !== undefined
    || current.references.some((reference) => reference.source === "post-baseline-event")
    || input.references.some((reference) => reference.source === "post-baseline-event");
  const references = current.references.filter((reference) => temporalMode
    ? reference.source === "post-baseline-event"
    : reference.source !== "post-baseline-event");
  const referenceKeys = new Set(references.map(evidenceReferenceKey));
  let mergedEvidenceCount = 0;
  for (const reference of input.references) {
    if ((temporalMode && reference.source !== "post-baseline-event")
      || (!temporalMode && reference.source === "post-baseline-event")) continue;
    const key = evidenceReferenceKey(reference);
    if (referenceKeys.has(key) || references.length >= 50) continue;
    referenceKeys.add(key);
    references.push(reference);
    mergedEvidenceCount += 1;
  }
  const watermarksByBridge = new Map(current.watermarks.map((item) => [item.bridgeId, item] as const));
  for (const watermark of input.watermarks) {
    const previous = watermarksByBridge.get(watermark.bridgeId);
    if (previous === undefined || watermark.lastSeq >= previous.lastSeq) watermarksByBridge.set(watermark.bridgeId, watermark);
  }
  return {
    evidence: {
      ...current,
      references,
      watermarks: [...watermarksByBridge.values()].slice(0, 16),
      ...(temporalMode ? { temporal: input.temporal ?? current.temporal } : {}),
    },
    mergedEvidenceCount,
  };
}

function evidenceReferenceKey(reference: CreateProposalInput["evidence"]["references"][number]): string {
  if (reference.source === "post-baseline-event") {
    return ["event", reference.bridgeId, reference.epochId ?? "", reference.seq === undefined ? "" : String(reference.seq)].join("\u0000");
  }
  return [
    "state",
    reference.bridgeId,
    reference.hwId ?? "",
    reference.capabilityId ?? "",
    reference.source ?? "",
    reference.epochId ?? "",
    reference.seq === undefined ? "" : String(reference.seq),
    reference.observedAt,
  ].join("\u0000");
}

function fromDedupLatchRow(row: ProposalDedupLatchRow): ProposalDedupLatch {
  if (typeof row.latch_id !== "string"
    || typeof row.dedup_key !== "string"
    || typeof row.proposal_id !== "string"
    || typeof row.created_at !== "string"
    || !boundedKeyIsValid(row.latch_id)
    || !boundedKeyIsValid(row.dedup_key)
    || !boundedKeyIsValid(row.proposal_id)
    || !isoTimestamp.safeParse(row.created_at).success) {
    throw new ProposalStoreError("corrupt_store", "Persisted proposal dedup latch is invalid");
  }
  return {
    id: row.latch_id,
    dedupKey: row.dedup_key,
    proposalId: row.proposal_id,
    createdAt: row.created_at,
  };
}

/** Stable identity of everything the household sees and approves about a plan. */
function proposalContentHash(snapshot: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
}

/** Everything the household sees and authorizes: story, plan, risk and gate disclosure. */
function preparedPlanSnapshot(proposal: Pick<CreateProposalInput,
  "title" | "summary" | "intent" | "rationale" | "artifactCandidate" | "risk" | "actionPolicyClasses" | "confirmationDeviceNames">): unknown {
  return {
    title: proposal.title,
    summary: proposal.summary,
    intent: proposal.intent,
    rationale: proposal.rationale ?? null,
    artifactCandidate: proposal.artifactCandidate ?? null,
    risk: proposal.risk,
    actionPolicyClasses: proposal.actionPolicyClasses ?? null,
    confirmationDeviceNames: proposal.confirmationDeviceNames ?? null,
  };
}

function requiresPreparation(input: Pick<CreateProposalInput, "kind" | "artifactCandidate">): boolean {
  return input.kind === "automation-draft" && input.artifactCandidate !== undefined;
}

const PREPARABLE_LIFECYCLES: readonly ProposalLifecycle[] = ["preparing", "needs_info", "ready"];
const PENDING_TAIL_AUDIT_ACTIONS: readonly ProposalAuditEvent["action"][] = [
  "created", "evidence_merged", "snoozed", "snooze_elapsed",
  "prepared", "info_requested", "revalidation_required", "enable_unblocked", "deployment_retried",
];
const APPROVED_TAIL_AUDIT_ACTIONS: readonly ProposalAuditEvent["action"][] = [
  "approved", "deployment_verified", "deployment_failed", "deployment_retried", "recovery_required", "recovery_started", "recovery_failed",
  "drift_detected", "drift_restored", "paused", "resumed", "closed",
];
const DEPLOYED_LIFECYCLES: readonly ProposalLifecycle[] = ["enabling", "active", "paused", "enable_failed", "recovery_required", "closed"];

function fromDedupLatchAuditRow(row: Record<string, unknown>): ProposalDedupLatchAuditEvent {
  if (typeof row.event_id !== "string"
    || typeof row.dedup_key !== "string"
    || typeof row.latch_id !== "string"
    || typeof row.proposal_id !== "string"
    || (row.action !== "created" && row.action !== "cleared")
    || typeof row.at !== "string"
    || typeof row.actor !== "string"
    || (row.note !== null && row.note !== undefined && typeof row.note !== "string")) {
    throw new ProposalStoreError("corrupt_store", "Persisted proposal latch audit is invalid");
  }
  return {
    id: row.event_id,
    dedupKey: row.dedup_key,
    latchId: row.latch_id,
    proposalId: row.proposal_id,
    action: row.action,
    at: row.at,
    actor: row.actor,
    ...(typeof row.note === "string" ? { note: row.note } : {}),
  };
}

function validateBoundedKey(value: unknown, label: string): asserts value is string {
  if (!boundedKeyIsValid(value)) throw new TypeError(`${label} is invalid`);
}

function boundedKeyIsValid(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && Buffer.byteLength(value, "utf8") <= 200;
}

function validateSnoozeInput(input: ProposalSnoozeInput): void {
  if (!input || typeof input !== "object") throw new TypeError("proposal snooze is required");
  validateBoundedKey(input.proposalId, "proposal snooze id");
  if (input.expectedRevision !== undefined
    && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
    throw new TypeError("proposal snooze expectedRevision is invalid");
  }
  if (input.until !== undefined && !["later", "tomorrow", "weekend", "next_week"].includes(input.until)) {
    throw new ProposalStoreError("snooze_target_invalid", "The snooze target is not recognized");
  }
}

function validateDecideInput(input: ProposalDecideInput): void {
  if (!input || typeof input !== "object") throw new TypeError("proposal decision is required");
  validateBoundedKey(input.proposalId, "proposal decision id");
  if (input.decision !== "approve" && input.decision !== "reject_once" && input.decision !== "do_not_suggest") {
    throw new TypeError("proposal decision is invalid");
  }
  if (input.expectedRevision !== undefined
    && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
    throw new TypeError("proposal decision expectedRevision is invalid");
  }
  const reviewer = input.reviewer ?? input.reviewerId;
  if (reviewer !== undefined) validateBoundedKey(reviewer, "proposal decision reviewer");
  if (input.note !== undefined && (typeof input.note !== "string" || input.note.trim().length === 0 || input.note.length > 1_000)) {
    throw new TypeError("proposal decision note is invalid");
  }
  if (input.deploymentIntent !== undefined) validateDeploymentIntent(input.deploymentIntent);
}

/**
 * The persisted intent is the deployment's contract, so the store refuses a
 * malformed one at the door: bounded identifiers, no duplicate capabilities,
 * and every binding living on the intent's own target bridge.
 */
function validateDeploymentIntent(intent: ProposalDeploymentIntent): void {
  validateBoundedKey(intent?.deploymentId, "deployment intent id");
  validateBoundedKey(intent?.target, "deployment intent target");
  if (!Array.isArray(intent.targets) || intent.targets.length === 0 || intent.targets.length > MAX_DEPLOYMENT_TARGETS) {
    throw new TypeError("deployment intent targets are invalid");
  }
  const seen = new Set<string>();
  for (const target of intent.targets) {
    validateBoundedKey(target?.hwCapabilityId, "deployment intent capability");
    validateBoundedKey(target?.binding?.bridgeId, "deployment intent binding bridge");
    validateBoundedKey(target?.binding?.nativeId, "deployment intent binding device");
    validateBoundedKey(target?.binding?.nativeInstanceId, "deployment intent binding instance");
    if (target.binding.bridgeId !== intent.target) {
      throw new TypeError("deployment intent binding must live on the intent target bridge");
    }
    if (seen.has(target.hwCapabilityId)) throw new TypeError("deployment intent capabilities must be unique");
    seen.add(target.hwCapabilityId);
  }
}

function validateClearDedupLatchInput(input: ProposalClearDedupLatchInput): void {
  if (!input || typeof input !== "object") throw new TypeError("dedup latch clear is required");
  validateBoundedKey(input.dedupKey, "dedup latch key");
  validateBoundedKey(input.reviewer, "dedup latch reviewer");
  if (input.note !== undefined && (typeof input.note !== "string" || input.note.trim().length === 0 || input.note.length > 1_000)) {
    throw new TypeError("dedup latch clear note is invalid");
  }
}

function validatePreparedRefs(value: unknown): PreparedArtifactRefs {
  if (value === null || typeof value !== "object") throw new TypeError("prepared refs are invalid");
  const refs = value as Record<string, unknown>;
  if (typeof refs.artifactId !== "string" || refs.artifactId.length === 0 || refs.artifactId.length > 256
    || !Number.isSafeInteger(refs.revision) || (refs.revision as number) < 1
    || typeof refs.contentHash !== "string" || refs.contentHash.length === 0 || refs.contentHash.length > 128
    || typeof refs.compileResultId !== "string" || refs.compileResultId.length === 0 || refs.compileResultId.length > 128
    || typeof refs.dryRunResultId !== "string" || refs.dryRunResultId.length === 0 || refs.dryRunResultId.length > 128) {
    throw new TypeError("prepared refs are invalid");
  }
  return {
    artifactId: refs.artifactId,
    revision: refs.revision as number,
    contentHash: refs.contentHash,
    compileResultId: refs.compileResultId,
    dryRunResultId: refs.dryRunResultId,
  };
}

function validateLifecycleInput(input: ProposalLifecycleInput, label: string): void {
  if (!input || typeof input !== "object") throw new TypeError(`proposal ${label} is required`);
  validateBoundedKey(input.proposalId, `proposal ${label} id`);
  if (input.expectedRevision !== undefined
    && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
    throw new TypeError(`proposal ${label} expectedRevision is invalid`);
  }
  if (input.actor !== undefined) validateBoundedKey(input.actor, `proposal ${label} actor`);
  if (input.note !== undefined && (typeof input.note !== "string" || input.note.trim().length === 0 || input.note.length > 1_000)) {
    throw new TypeError(`proposal ${label} note is invalid`);
  }
}

function calculateProposalSnoozeAt(at: string, target: ProposalSnoozeTarget): string {
  const date = new Date(Date.parse(at));
  if (target === "tomorrow") {
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString();
  }
  const desiredDay = target === "weekend" ? 6 : 1;
  const currentDay = date.getUTCDay();
  let days = (desiredDay - currentDay + 7) % 7;
  if (days === 0) days = 7;
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(9, 0, 0, 0);
  if (Date.parse(date.toISOString()) <= Date.parse(at)) date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString();
}

function validateReviewInput(input: ReviewProposalInput): void {
  if (!input || typeof input !== "object") throw new TypeError("proposal review is required");
  for (const [name, value, max] of [
    ["proposalId", input.proposalId, 200],
    ["reviewer", input.reviewer, 200],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
      throw new TypeError(`proposal review ${name} is invalid`);
    }
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new TypeError("proposal review expectedRevision is invalid");
  }
  if (!(["approved", "rejected", "expired"] as const).includes(input.decision)) {
    throw new TypeError("proposal review decision is invalid");
  }
  if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 1_000)) {
    throw new TypeError("proposal review note is invalid");
  }
  const feedbackCode = (input as { feedbackCode?: unknown }).feedbackCode;
  if (input.decision === "approved" && !approvalFeedbackCodes.includes(feedbackCode as ProposalApprovalFeedbackCode)) {
    throw new TypeError("proposal review feedback is invalid for approval");
  }
  if (input.decision === "rejected" && !rejectionFeedbackCodes.includes(feedbackCode as ProposalRejectionFeedbackCode)) {
    throw new TypeError("proposal review feedback is invalid for rejection");
  }
  if (input.decision === "expired" && feedbackCode !== undefined) {
    throw new TypeError("proposal expiration cannot carry review feedback");
  }
  if (feedbackCode === "other" && !input.note?.trim()) {
    throw new TypeError("proposal review note is required for other feedback");
  }
}

function validatePreparationJobId(jobId: string): void {
  if (typeof jobId !== "string"
    || jobId.length === 0
    || jobId.trim() !== jobId
    || Buffer.byteLength(jobId, "utf8") > 200) {
    throw new TypeError("preparation job id is invalid");
  }
}

function validatePreparationTransition(
  input: ArtifactPreparationJobTransition,
): void {
  if (!input || typeof input !== "object") throw new TypeError("preparation job transition is invalid");
  validatePreparationJobId(input.jobId);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new TypeError("preparation job expected version is invalid");
  }
}

function validatePreparationFailure(input: ArtifactPreparationJobFailure): void {
  validatePreparationTransition(input);
  if (!ARTIFACT_PREPARATION_JOB_STAGES.includes(input.stage)
    || !ARTIFACT_PREPARATION_JOB_ERROR_CODES.includes(input.code)) {
    throw new TypeError("preparation job failure is invalid");
  }
}

function preparationTransitionConflict(): ProposalStoreError {
  return new ProposalStoreError("job_transition_conflict", "Preparation job transition conflicted");
}

function fromPreparationJobRow(row: ArtifactPreparationJobRow): ArtifactPreparationJob {
  try {
    if (typeof row.job_id !== "string"
      || typeof row.proposal_id !== "string"
      || typeof row.idempotency_key !== "string"
      || typeof row.status !== "string"
      || typeof row.created_at !== "string"
      || typeof row.updated_at !== "string") {
      throw new Error("invalid preparation job metadata");
    }
    const jobId = String(row.job_id);
    const proposalId = String(row.proposal_id);
    const proposalRevision = Number(row.proposal_revision);
    const idempotencyKey = String(row.idempotency_key);
    const status = String(row.status) as ArtifactPreparationJobStatus;
    const attempt = Number(row.attempt);
    const version = Number(row.version);
    const createdAt = String(row.created_at);
    const updatedAt = String(row.updated_at);
    const stage = row.stage === null || row.stage === undefined
      ? undefined
      : String(row.stage) as ArtifactPreparationJobStage;
    const errorCode = row.error_code === null || row.error_code === undefined
      ? undefined
      : String(row.error_code) as ArtifactPreparationJobErrorCode;
    validatePreparationJobId(jobId);
    validatePreparationJobId(proposalId);
    if (!idempotencyKey.startsWith("sha256:") || idempotencyKey.length !== 71
      || !/^[a-f0-9]+$/u.test(idempotencyKey.slice(7))
      || !Number.isSafeInteger(proposalRevision) || proposalRevision < 1
      || !(["queued", "running", "succeeded", "failed"] as const).includes(status)
      || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAX_ARTIFACT_PREPARATION_ATTEMPTS
      || !Number.isSafeInteger(version) || version < 1
      || !isoTimestamp.safeParse(createdAt).success
      || !isoTimestamp.safeParse(updatedAt).success
      || Date.parse(updatedAt) < Date.parse(createdAt)
      || (status === "failed") !== (stage !== undefined && errorCode !== undefined)
      || (stage !== undefined && !ARTIFACT_PREPARATION_JOB_STAGES.includes(stage))
      || (errorCode !== undefined && !ARTIFACT_PREPARATION_JOB_ERROR_CODES.includes(errorCode))) {
      throw new Error("invalid preparation job");
    }
    return deepFreeze({
      schemaVersion: "1" as const,
      kind: "approved-proposal-preparation" as const,
      jobId,
      proposalId,
      proposalRevision,
      idempotencyKey,
      status,
      attempt,
      version,
      ...(stage === undefined ? {} : { stage }),
      ...(stage === undefined || errorCode === undefined ? {} : { error: { stage, code: errorCode } }),
      createdAt,
      updatedAt,
    });
  } catch (error) {
    if (error instanceof ProposalStoreError) throw error;
    throw new ProposalStoreError("corrupt_store", "Persisted preparation job is invalid");
  }
}

function validateRetentionEvidenceQuery(bridgeId: string, limit: number): void {
  if (typeof bridgeId !== "string" || bridgeId.trim().length === 0 || bridgeId.length > 200) {
    throw new TypeError("retention evidence bridge id is invalid");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PROPOSAL_RETENTION_REFERENCES) {
    throw new RangeError("retention evidence limit is unbounded");
  }
}

function validateProposalSourceQuery(
  proposalId: string,
  revision: number,
  operation: unknown,
): void {
  if (typeof proposalId !== "string"
    || proposalId.length === 0
    || proposalId !== proposalId.trim()
    || Buffer.byteLength(proposalId, "utf8") > 200) {
    throw new TypeError("approved proposal source id is invalid");
  }
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError("approved proposal source revision is invalid");
  }
  if (typeof operation !== "function") {
    throw new TypeError("approved proposal source callback is invalid");
  }
}


function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  return typeof (value as { readonly then?: unknown }).then === "function";
}

function fromRow(row: ProposalRow): ProposalEnvelope {
  try {
    if (typeof row.payload_json !== "string") throw new Error("missing payload");
    const parsed = proposalEnvelopeSchema.safeParse(JSON.parse(row.payload_json));
    if (!parsed.success) throw new Error("invalid payload");
    const raw = parsed.data;
    const dedupKey = raw.dedupKey ?? raw.idempotencyKey;
    const expiresAt = raw.expiresAt ?? new Date(Date.parse(raw.createdAt) + PROPOSAL_EXPIRY_MS).toISOString();
    const lifecycle = raw.lifecycle
      ?? (raw.status === "approved" ? "enabling" as const : "preparing" as const);
    const reviewLane = raw.reviewLane ?? "standard";
    const proposal: ProposalEnvelope = {
      ...raw,
      dedupKey,
      expiresAt,
      reviewLane,
      snoozeCount: raw.snoozeCount ?? 0,
      newEvidence: raw.newEvidence ?? false,
      lifecycle,
    };
    if (row.proposal_id !== proposal.id
      || row.producer !== proposal.provenance.producer
      || row.idempotency_key !== proposal.idempotencyKey
      || row.status !== proposal.status
      || row.revision !== proposal.revision
      || row.created_at !== proposal.createdAt
      || row.updated_at !== proposal.updatedAt) {
      throw new Error("metadata mismatch");
    }
    const lastAudit = proposal.audit.at(-1);
    const decisionAudit = [...proposal.audit].reverse().find((event) => event.action === proposal.status);
    const lifecycleValid = lastAudit?.revision === proposal.revision
      && (proposal.status === "pending_review"
        ? proposal.review === undefined
          && proposal.decision === undefined
          && PENDING_TAIL_AUDIT_ACTIONS.includes(lastAudit.action)
        : proposal.review?.decision === proposal.status
          && (proposal.status === "approved"
            ? APPROVED_TAIL_AUDIT_ACTIONS.includes(lastAudit.action)
            : lastAudit.action === proposal.status)
          && persistedFeedbackIsConsistent(proposal.status, proposal.review.feedbackCode, decisionAudit?.feedbackCode)
          && governanceDecisionIsConsistent(proposal));
    if (!boundedKeyIsValid(proposal.dedupKey)
      || !isoTimestamp.safeParse(proposal.expiresAt).success
      || Date.parse(proposal.expiresAt) <= Date.parse(proposal.createdAt)
      || proposal.snoozeCount < 0
      || (proposal.snoozedUntil !== undefined
        && (proposal.status !== "pending_review" || Date.parse(proposal.snoozedUntil) <= Date.parse(proposal.updatedAt)))) {
      throw new Error("invalid governance metadata");
    }
    if (proposal.reviewLane === "migration"
      && (proposal.kind !== "automation-draft"
        || proposal.artifactCandidate === undefined
        || proposal.provenance.producer !== HOME_AUTOMATION_MIGRATION_PRODUCER)) {
      throw new Error("migration review lane is not Hub-owned");
    }
    if (proposal.reviewLane === "standard"
      && proposal.provenance.producer === HOME_AUTOMATION_MIGRATION_PRODUCER) {
      throw new Error("migration producer is outside its review lane");
    }
    if (DEPLOYED_LIFECYCLES.includes(proposal.lifecycle) && proposal.status !== "approved") {
      throw new Error("a deployed automation requires an approved decision");
    }
    if (proposal.lifecycle === "active" && proposal.deployment?.status !== "verified") {
      throw new Error("a running automation requires a verified deployment");
    }
    if (proposal.applicationStatus === "running" && proposal.lifecycle !== "active" && proposal.lifecycle !== "paused") {
      throw new Error("application status contradicts the lifecycle");
    }
    if (proposal.lifecycle === "recovery_required") {
      if (proposal.reviewLane !== "migration"
        || proposal.status !== "approved"
        || proposal.applicationStatus !== "failed"
        || proposal.deployment?.status !== "failed"
        || proposal.recoveryAttempts !== undefined && proposal.recoveryAttempts.length > 50) {
        throw new Error("recovery-required proposal state is invalid");
      }
    } else if (proposal.recoveryAttempts !== undefined) {
      throw new Error("recovery attempts require a recovery-required proposal");
    }
    if (proposal.lifecycle === "ready" && proposal.kind === "automation-draft"
      && proposal.artifactCandidate !== undefined && proposal.preparedArtifact === undefined) {
      throw new Error("a ready plan requires its preparation refs");
    }
    if (!lifecycleValid) throw new Error("invalid lifecycle");
    return proposal as ProposalEnvelope;
  } catch {
    throw new ProposalStoreError("corrupt_store", "Persisted proposal state is invalid");
  }
}

function governanceDecisionIsConsistent(proposal: ProposalEnvelope): boolean {
  if (proposal.status === "expired") return proposal.decision === undefined;
  // Reviewed v1 rows predate the stable behavior decision metadata.
  if (proposal.decision === undefined) return true;
  if (proposal.status === "approved") return proposal.decision?.kind === "approve";
  if (proposal.status === "rejected") {
    return proposal.decision?.kind === "reject_once" || proposal.decision?.kind === "do_not_suggest";
  }
  return false;
}

function persistedFeedbackIsConsistent(
  status: Exclude<ProposalStatus, "pending_review">,
  reviewCode: ProposalReviewFeedbackCode | undefined,
  auditCode: ProposalReviewFeedbackCode | undefined,
): boolean {
  if (reviewCode === undefined && auditCode === undefined) return true;
  if (reviewCode !== auditCode) return false;
  if (status === "approved") return reviewCode === "useful_as_is";
  if (status === "expired") return false;
  return rejectionFeedbackCodes.includes(reviewCode as ProposalRejectionFeedbackCode);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freezeSource(value: HubVerifiedProposalSource): HubVerifiedProposalSource {
  return deepFreeze(clone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
