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
  /** Stable identity of the behavior being discussed, independent of one producer attempt. */
  dedupKey: boundedId.optional(),
  idempotencyKey: boundedId,
  /** Optional migration/import override; new proposals default to fourteen days. */
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
export type ProposalStatus = "pending_review" | "approved" | "rejected" | "expired";
export type ProposalDecision = Exclude<ProposalStatus, "pending_review">;
export type ProposalSnoozeTarget = "tomorrow" | "weekend" | "next_week";
export type ProposalGovernanceDecision = "approve" | "reject_once" | "do_not_suggest";
/** Governance progress is separate from application status and never grants execution authority. */
export type ProposalRolloutState = "direction_pending" | "trial_active" | "enable_pending" | "enabled";
export interface ProposalTrial {
  readonly durationDays: 7;
  readonly startedAt: string;
  readonly endsAt: string;
}
export interface ProposalEnablement {
  readonly enabledAt: string;
  readonly reviewer: string;
  readonly note?: string;
}
export const MAX_PROPOSAL_SNOOZES = 2;
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
    | "trial_completed"
    | "enabled";
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
  readonly schemaVersion: "1";
  readonly id: string;
  readonly revision: number;
  readonly status: ProposalStatus;
  /** M3a deliberately has no route from approval to application. */
  readonly applicationStatus: "not_available";
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Stable behavior identity. `idempotencyKey` remains the producer-attempt key. */
  readonly dedupKey: string;
  readonly expiresAt: string;
  /** Snoozing retains pending_review status so existing consumers remain compatible. */
  readonly snoozeCount: number;
  readonly snoozedUntil?: string;
  readonly newEvidence: boolean;
  readonly rolloutState: ProposalRolloutState;
  readonly trial?: ProposalTrial;
  readonly enablement?: ProposalEnablement;
  readonly decision?: ProposalGovernanceDecisionRecord;
  readonly review?: ProposalReview;
  readonly audit: readonly ProposalAuditEvent[];
}

const proposalAuditEventSchema = z.object({
  id: boundedId,
  at: isoTimestamp,
  action: z.enum([
    "created", "approved", "rejected", "expired", "evidence_merged", "snoozed", "snooze_elapsed",
    "trial_completed", "enabled",
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
  schemaVersion: z.literal("1"),
  id: boundedId,
  revision: z.number().int().positive(),
  status: z.enum(["pending_review", "approved", "rejected", "expired"]),
  applicationStatus: z.literal("not_available"),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  dedupKey: boundedId.optional(),
  expiresAt: isoTimestamp.optional(),
  snoozeCount: z.number().int().nonnegative().max(MAX_PROPOSAL_SNOOZES).optional(),
  snoozedUntil: isoTimestamp.optional(),
  newEvidence: z.boolean().optional(),
  rolloutState: z.enum(["direction_pending", "trial_active", "enable_pending", "enabled"]).optional(),
  trial: z.object({
    durationDays: z.literal(7),
    startedAt: isoTimestamp,
    endsAt: isoTimestamp,
  }).strict().optional(),
  enablement: z.object({
    enabledAt: isoTimestamp,
    reviewer: boundedId,
    note: z.string().trim().min(1).max(1_000).optional(),
  }).strict().optional(),
  decision: proposalGovernanceDecisionSchema.optional(),
  review: proposalReviewSchema.optional(),
  audit: z.array(proposalAuditEventSchema).min(1).max(100),
}).strict();

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

export interface ProposalSnoozeInput {
  readonly proposalId: string;
  readonly expectedRevision?: number;
  readonly until: ProposalSnoozeTarget;
  readonly reviewer?: string;
}

export interface ProposalDecideInput {
  readonly proposalId: string;
  readonly expectedRevision?: number;
  readonly decision: ProposalGovernanceDecision;
  readonly reviewer?: string;
  readonly reviewerId?: string;
  readonly note?: string;
  readonly feedbackCode?: ProposalReviewFeedbackCode;
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

export interface ProposalTrialAdvanceInput {
  readonly proposalId: string;
  readonly expectedRevision?: number;
  readonly reviewer?: string;
}

export interface ProposalEnableInput {
  readonly proposalId: string;
  readonly expectedRevision?: number;
  readonly reviewer: string;
  readonly note?: string;
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
  | "dedup_latched"
  | "dedup_latch_not_found"
  | "snooze_limit_reached"
  | "snooze_target_invalid"
  | "trial_not_complete"
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
}

const MAX_ARTIFACT_PREPARATION_ATTEMPTS = 5;
const MAX_PENDING_REVIEW_PROPOSALS = MAX_PROPOSAL_CAPACITY;
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
   * Creates a proposal, merges evidence into an unresolved behavior card, or
   * returns a durable suppression result. The producer idempotency key is an
   * operation replay key; `dedupKey` is the stable behavior identity.
   */
  createGoverned(candidate: CreateProposalInput): ProposalCreationResult {
    const parsed = admittedProposalInputSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ProposalStoreError("invalid_proposal", "Proposal does not match the bounded v1 envelope");
    }
    const input = parsed.data;
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
      const concurrent = this.findByIdempotency(input.provenance.producer, input.idempotencyKey);
      if (concurrent) {
        this.db.exec("COMMIT");
        return { kind: "replayed", proposal: concurrent };
      }
      const dedupKey = input.dedupKey ?? input.idempotencyKey;
      const latch = this.findDedupLatch(dedupKey);
      if (latch !== undefined) {
        this.db.exec("COMMIT");
        return { kind: "suppressed", reason: "dedup_latched", dedupKey };
      }
      const unresolved = this.findUnresolvedByDedupKey(dedupKey);
      if (unresolved !== undefined) {
        const merged = mergeProposalEvidence(unresolved, input, at, this.id);
        this.updateProposal(merged.proposal, unresolved.revision);
        this.insertIdempotencyAlias(input.provenance.producer, input.idempotencyKey, unresolved.id);
        this.db.exec("COMMIT");
        return {
          kind: "merged",
          proposal: clone(merged.proposal),
          mergedEvidenceCount: merged.mergedEvidenceCount,
        };
      }
      const pendingRow = this.db.prepare(
        "SELECT COUNT(*) AS count FROM proposals WHERE status = 'pending_review'",
      ).get() as { count?: unknown } | undefined;
      const pendingCount = Number(pendingRow?.count);
      if (!Number.isSafeInteger(pendingCount) || pendingCount < 0) {
        throw new ProposalStoreError("corrupt_store", "Proposal review capacity is unavailable");
      }
      if (pendingCount >= MAX_PENDING_REVIEW_PROPOSALS) {
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
    input: CreateProposalInput,
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
      createdAt: at,
      updatedAt: at,
      snoozeCount: 0,
      newEvidence: false,
      rolloutState: "direction_pending",
      audit: [{
        id: `audit-${this.id()}`,
        at,
        action: "created",
        actor: input.provenance.producer,
        revision: 1,
      }],
    };
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

  proposalCapacity(): { readonly used: number; readonly max: 5; readonly available: number } {
    this.expireDue();
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM proposals WHERE status = 'pending_review'",
    ).get() as { count?: unknown } | undefined;
    const used = Number(row?.count);
    if (!Number.isSafeInteger(used) || used < 0 || used > MAX_PROPOSAL_CAPACITY) {
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

  advanceProposalTrial(input: ProposalTrialAdvanceInput): ProposalEnvelope {
    validateTrialAdvanceInput(input);
    const at = this.timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.findById(input.proposalId);
      if (current === undefined) throw new ProposalStoreError("not_found", "Proposal was not found");
      if (current.rolloutState !== "trial_active" || current.trial === undefined) {
        throw new ProposalStoreError("rollout_state_invalid", "The proposal is not in an active trial");
      }
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        throw new ProposalStoreError("revision_conflict", "Proposal revision has changed");
      }
      if (Date.parse(current.trial.endsAt) > Date.parse(at)) {
        throw new ProposalStoreError("trial_not_complete", "The seven-day trial is still running");
      }
      const revision = current.revision + 1;
      const completed: ProposalEnvelope = {
        ...current,
        revision,
        rolloutState: "enable_pending",
        updatedAt: at,
        audit: [...current.audit, {
          id: `audit-${this.id()}`,
          at,
          action: "trial_completed",
          actor: input.reviewer ?? "system",
          revision,
        }],
      };
      this.updateProposal(completed, current.revision);
      this.db.exec("COMMIT");
      return clone(completed);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFiles();
    }
  }

  enableProposal(input: ProposalEnableInput): ProposalEnvelope {
    validateEnableInput(input);
    const at = this.timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let current = this.findById(input.proposalId);
      if (current === undefined) throw new ProposalStoreError("not_found", "Proposal was not found");
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        throw new ProposalStoreError("revision_conflict", "Proposal revision has changed");
      }
      if (current.rolloutState === "trial_active" && current.trial !== undefined
        && Date.parse(current.trial.endsAt) <= Date.parse(at)) {
        const revision = current.revision + 1;
        current = {
          ...current,
          revision,
          rolloutState: "enable_pending",
          updatedAt: at,
          audit: [...current.audit, {
            id: `audit-${this.id()}`,
            at,
            action: "trial_completed",
            actor: "system",
            revision,
          }],
        };
        this.updateProposal(current, revision - 1);
      }
      if (current.rolloutState !== "enable_pending") {
        throw new ProposalStoreError("trial_not_complete", "The seven-day trial must complete before enablement");
      }
      const revision = current.revision + 1;
      const note = input.note?.trim();
      const enabled: ProposalEnvelope = {
        ...current,
        revision,
        rolloutState: "enabled",
        updatedAt: at,
        enablement: {
          enabledAt: at,
          reviewer: input.reviewer,
          ...(note ? { note } : {}),
        },
        audit: [...current.audit, {
          id: `audit-${this.id()}`,
          at,
          action: "enabled",
          actor: input.reviewer,
          revision,
          ...(note ? { note } : {}),
        }],
      };
      this.updateProposal(enabled, current.revision);
      this.db.exec("COMMIT");
      return clone(enabled);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFiles();
    }
  }

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
      if (current.snoozeCount >= MAX_PROPOSAL_SNOOZES) {
        throw new ProposalStoreError("snooze_limit_reached", "Proposal snooze limit reached");
      }
      const snoozedUntil = calculateProposalSnoozeAt(at, input.until);
      if (Date.parse(snoozedUntil) >= Date.parse(current.expiresAt)) {
        throw new ProposalStoreError("snooze_target_invalid", "Proposal snooze must end before natural expiry");
      }
      const revision = current.revision + 1;
      const reviewer = input.reviewer?.trim();
      const { snoozedUntil: _previousSnoozedUntil, ...baseCurrent } = current;
      const snoozed: ProposalEnvelope = {
        ...baseCurrent,
        revision,
        updatedAt: at,
        snoozeCount: current.snoozeCount + 1,
        snoozedUntil,
        audit: [...current.audit, {
          id: `audit-${this.id()}`,
          at,
          action: "snoozed",
          actor: reviewer || "household-owner",
          revision,
        }],
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
        ...(status === "approved"
          ? { rolloutState: "trial_active" as const, trial: createProposalTrial(at) }
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
        this.enqueuePreparationJob(decided, at);
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
        || proposal.status !== "approved"
        || proposal.applicationStatus !== "not_available"
        || proposal.review?.decision !== "approved"
        || proposal.review.feedbackCode !== "useful_as_is"
        || proposal.artifactCandidate === undefined) {
        throw new ProposalStoreError("source_unavailable", "Proposal is not an approved automation source");
      }
      validateApprovedAuditChain(proposal);
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
        ...(input.decision === "approved"
          ? { rolloutState: "trial_active" as const, trial: createProposalTrial(at) }
          : {}),
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
        this.enqueuePreparationJob(reviewed, at);
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

  completePreparationJob(input: ArtifactPreparationJobTransition): ArtifactPreparationJob {
    return this.transitionPreparationJob(input, "running", "succeeded");
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
      const result = this.db.prepare(`UPDATE approved_proposal_preparation_jobs
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

  private enqueuePreparationJob(proposal: ProposalEnvelope, at: string): void {
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
  input: CreateProposalInput,
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
  if (mergedEvidenceCount === 0) return { proposal: current, mergedEvidenceCount: 0 };
  const revision = current.revision + 1;
  return {
    proposal: {
      ...current,
      revision,
      updatedAt: at,
      evidence: mergedEvidence,
      newEvidence: true,
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
  if (!("tomorrow" === input.until
    || "weekend" === input.until
    || "next_week" === input.until)) {
    throw new ProposalStoreError("snooze_target_invalid", "Proposal snooze target is invalid");
  }
  if (input.expectedRevision !== undefined
    && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
    throw new TypeError("proposal snooze expectedRevision is invalid");
  }
  if (input.reviewer !== undefined) validateBoundedKey(input.reviewer, "proposal snooze reviewer");
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
}

function validateClearDedupLatchInput(input: ProposalClearDedupLatchInput): void {
  if (!input || typeof input !== "object") throw new TypeError("dedup latch clear is required");
  validateBoundedKey(input.dedupKey, "dedup latch key");
  validateBoundedKey(input.reviewer, "dedup latch reviewer");
  if (input.note !== undefined && (typeof input.note !== "string" || input.note.trim().length === 0 || input.note.length > 1_000)) {
    throw new TypeError("dedup latch clear note is invalid");
  }
}

function validateTrialAdvanceInput(input: ProposalTrialAdvanceInput): void {
  if (!input || typeof input !== "object") throw new TypeError("proposal trial advance is required");
  validateBoundedKey(input.proposalId, "proposal trial id");
  if (input.expectedRevision !== undefined
    && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
    throw new TypeError("proposal trial expectedRevision is invalid");
  }
  if (input.reviewer !== undefined) validateBoundedKey(input.reviewer, "proposal trial reviewer");
}

function validateEnableInput(input: ProposalEnableInput): void {
  if (!input || typeof input !== "object") throw new TypeError("proposal enablement is required");
  validateBoundedKey(input.proposalId, "proposal enablement id");
  validateBoundedKey(input.reviewer, "proposal enablement reviewer");
  if (input.expectedRevision !== undefined
    && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
    throw new TypeError("proposal enablement expectedRevision is invalid");
  }
  if (input.note !== undefined && (typeof input.note !== "string" || input.note.trim().length === 0 || input.note.length > 1_000)) {
    throw new TypeError("proposal enablement note is invalid");
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

function createProposalTrial(startedAt: string): ProposalTrial {
  const endsAt = new Date(Date.parse(startedAt));
  endsAt.setUTCDate(endsAt.getUTCDate() + 7);
  return { durationDays: 7, startedAt, endsAt: endsAt.toISOString() };
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

function validateApprovedAuditChain(proposal: ProposalEnvelope): void {
  const created = proposal.audit[0];
  const approved = proposal.audit[1];
  const review = proposal.review;
  const createdValid = proposal.revision === 2
    && proposal.audit.length === 2
    && created !== undefined
    && created.action === "created"
    && created.revision === 1
    && created.actor === proposal.provenance.producer
    && created.at === proposal.createdAt
    && created.feedbackCode === undefined
    && created.note === undefined;
  const approvedValid = approved !== undefined
    && review !== undefined
    && review.decision === "approved"
    && approved.action === "approved"
    && approved.revision === proposal.revision
    && approved.actor === review.reviewer
    && approved.at === review.reviewedAt
    && approved.at === proposal.updatedAt
    && approved.feedbackCode === review.feedbackCode
    && approved.note === review.note
    && created?.id !== approved.id
    && Date.parse(proposal.createdAt) <= Date.parse(proposal.updatedAt);
  if (!createdValid || !approvedValid) {
    throw new ProposalStoreError("corrupt_store", "Approved proposal audit chain is invalid");
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
    const legacyApprovedState = raw.status === "approved"
      && raw.trial === undefined
      && (raw.rolloutState === undefined || raw.rolloutState === "direction_pending");
    const rolloutState = legacyApprovedState
      ? "trial_active" as const
      : raw.rolloutState
        ?? (raw.status === "approved" ? "trial_active" as const : "direction_pending" as const);
    const trial = raw.trial
      ?? (raw.status === "approved" ? createProposalTrial(raw.updatedAt) : undefined);
    const proposal: ProposalEnvelope = {
      ...raw,
      dedupKey,
      expiresAt,
      snoozeCount: raw.snoozeCount ?? 0,
      newEvidence: raw.newEvidence ?? false,
      rolloutState,
      ...(trial === undefined ? {} : { trial }),
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
          && (lastAudit.action === "created"
            || lastAudit.action === "evidence_merged"
            || lastAudit.action === "snoozed"
            || lastAudit.action === "snooze_elapsed")
        : proposal.review?.decision === proposal.status
          && (proposal.status === "approved"
            ? (lastAudit.action === "approved" || lastAudit.action === "trial_completed" || lastAudit.action === "enabled")
            : lastAudit.action === proposal.status)
          && persistedFeedbackIsConsistent(proposal.status, proposal.review.feedbackCode, decisionAudit?.feedbackCode)
          && governanceDecisionIsConsistent(proposal));
    if (!boundedKeyIsValid(proposal.dedupKey)
      || !isoTimestamp.safeParse(proposal.expiresAt).success
      || Date.parse(proposal.expiresAt) <= Date.parse(proposal.createdAt)
      || proposal.snoozeCount < 0
      || proposal.snoozeCount > MAX_PROPOSAL_SNOOZES
      || (proposal.snoozedUntil !== undefined
        && (proposal.status !== "pending_review" || Date.parse(proposal.snoozedUntil) <= Date.parse(proposal.updatedAt)))) {
      throw new Error("invalid governance metadata");
    }
    if (proposal.rolloutState === "direction_pending" && proposal.status === "approved") {
      throw new Error("approved proposal has no trial state");
    }
    if ((proposal.rolloutState === "trial_active" || proposal.rolloutState === "enable_pending" || proposal.rolloutState === "enabled")
      && (proposal.status !== "approved" || proposal.trial === undefined
        || Date.parse(proposal.trial.endsAt) <= Date.parse(proposal.trial.startedAt)
        || proposal.trial.durationDays !== 7)) {
      throw new Error("proposal trial state is invalid");
    }
    if (proposal.rolloutState === "enabled" && proposal.enablement === undefined) {
      throw new Error("enabled proposal has no enablement record");
    }
    if (proposal.rolloutState !== "enabled" && proposal.enablement !== undefined) {
      throw new Error("proposal enablement record is premature");
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
