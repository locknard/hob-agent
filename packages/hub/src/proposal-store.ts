import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { ensurePrivateSqliteFiles } from "./sqlite-private-files.js";
import { artifactContentSchema } from "./neutral-artifact.js";

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
  selectedDevices: z.number().int().min(1).max(20),
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
  idempotencyKey: boundedId,
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
  readonly action: "created" | ProposalDecision;
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

export interface ProposalEnvelope extends CreateProposalInput {
  readonly schemaVersion: "1";
  readonly id: string;
  readonly revision: number;
  readonly status: ProposalStatus;
  /** M3a deliberately has no route from approval to application. */
  readonly applicationStatus: "not_available";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly review?: ProposalReview;
  readonly audit: readonly ProposalAuditEvent[];
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

/**
 * Hub-verified source input for a future artifact producer. It is deliberately
 * a projection rather than a caller-supplied proposal/evidence object.
 */
export type HubVerifiedProposalSource = DeepReadonly<{
  readonly proposalId: string;
  readonly revision: number;
  readonly kind: "automation-draft";
  readonly status: "approved";
  readonly applicationStatus: "not_available";
  readonly title: string;
  readonly summary: string;
  readonly intent: CreateProposalInput["intent"];
  readonly evidence: CreateProposalInput["evidence"];
  readonly conflictCheck: CreateProposalInput["conflictCheck"];
  readonly risk: CreateProposalInput["risk"];
  readonly artifactCandidate: NonNullable<CreateProposalInput["artifactCandidate"]>;
}>;

const proposalAuditEventSchema = z.object({
  id: boundedId,
  at: isoTimestamp,
  action: z.enum(["created", "approved", "rejected", "expired"]),
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

const proposalEnvelopeSchema = createProposalInputSchema.extend({
  schemaVersion: z.literal("1"),
  id: boundedId,
  revision: z.number().int().positive(),
  status: z.enum(["pending_review", "approved", "rejected", "expired"]),
  applicationStatus: z.literal("not_available"),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  review: proposalReviewSchema.optional(),
  audit: z.array(proposalAuditEventSchema).min(1).max(10),
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
}

export type ProposalStoreErrorCode =
  | "invalid_proposal"
  | "conflict_check_required"
  | "human_approval_required"
  | "corrupt_store"
  | "not_found"
  | "revision_conflict"
  | "terminal_status"
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
    `);
    this.ensurePrivateFiles();
  }

  create(candidate: CreateProposalInput): ProposalEnvelope {
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

    const existing = this.findByIdempotency(input.provenance.producer, input.idempotencyKey);
    if (existing) return existing;

    const at = this.timestamp();
    const proposal: ProposalEnvelope = {
      ...input,
      schemaVersion: "1",
      id: `proposal-${this.id()}`,
      revision: 1,
      status: "pending_review",
      applicationStatus: "not_available",
      createdAt: at,
      updatedAt: at,
      audit: [{
        id: `audit-${this.id()}`,
        at,
        action: "created",
        actor: input.provenance.producer,
        revision: 1,
      }],
    };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const concurrent = this.findByIdempotency(input.provenance.producer, input.idempotencyKey);
      if (concurrent) {
        this.db.exec("COMMIT");
        return concurrent;
      }
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
      this.db.exec("COMMIT");
      return clone(proposal);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFiles();
    }
  }

  get(proposalId: string): ProposalEnvelope | undefined {
    const row = this.db.prepare(`SELECT
        proposal_id, producer, idempotency_key, status, revision,
        created_at, updated_at, payload_json
      FROM proposals WHERE proposal_id = ?`)
      .get(proposalId) as ProposalRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(query: ProposalListQuery = {}): readonly ProposalEnvelope[] {
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
    return (rows as ProposalRow[]).map(fromRow);
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(input.proposalId);
      if (!current) throw new ProposalStoreError("not_found", "Proposal was not found");
      if (current.revision !== input.expectedRevision) {
        throw new ProposalStoreError("revision_conflict", "Proposal revision has changed");
      }
      if (current.status !== "pending_review") {
        throw new ProposalStoreError("terminal_status", "A terminal review decision cannot be changed");
      }
      const at = this.timestamp();
      const revision = current.revision + 1;
      const note = input.note?.trim();
      const feedbackCode = input.decision === "expired" ? undefined : input.feedbackCode;
      const reviewed: ProposalEnvelope = {
        ...current,
        revision,
        status: input.decision,
        updatedAt: at,
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
      const result = this.db.prepare(`UPDATE proposals
        SET status = ?, revision = ?, updated_at = ?, payload_json = ?
        WHERE proposal_id = ? AND revision = ?`).run(
        reviewed.status,
        reviewed.revision,
        reviewed.updatedAt,
        JSON.stringify(reviewed),
        reviewed.id,
        current.revision,
      );
      if (Number(result.changes) !== 1) {
        throw new ProposalStoreError("revision_conflict", "Proposal revision has changed");
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private findByIdempotency(producer: string, idempotencyKey: string): ProposalEnvelope | undefined {
    const row = this.db.prepare(`SELECT
        proposal_id, producer, idempotency_key, status, revision,
        created_at, updated_at, payload_json
      FROM proposals
      WHERE producer = ? AND idempotency_key = ?`).get(producer, idempotencyKey) as ProposalRow | undefined;
    return row ? fromRow(row) : undefined;
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
    const proposal = parsed.data;
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
    const lifecycleValid = lastAudit?.revision === proposal.revision
      && (proposal.status === "pending_review"
        ? proposal.review === undefined && lastAudit.action === "created"
        : proposal.review?.decision === proposal.status
          && lastAudit.action === proposal.status
          && persistedFeedbackIsConsistent(proposal.status, proposal.review.feedbackCode, lastAudit.feedbackCode));
    if (!lifecycleValid) throw new Error("invalid lifecycle");
    return proposal as ProposalEnvelope;
  } catch {
    throw new ProposalStoreError("corrupt_store", "Persisted proposal state is invalid");
  }
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
