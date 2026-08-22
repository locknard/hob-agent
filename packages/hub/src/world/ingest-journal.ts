import { DatabaseSync } from "node:sqlite";

import type {
  Envelope,
  HeartbeatIntervalRecord,
  HistoryGapRecord,
  JournalWatermark,
  RejectionRecord,
} from "./bridge-ingest-types.js";
import type { IngestRecord } from "@hob/bridge-contract";
import { ensurePrivateSqliteFiles } from "../sqlite-private-files.js";

export class JournalCapacityError extends Error {
  readonly code = "JOURNAL_CAPACITY";
  readonly retentionConflict: boolean;

  constructor(message = "ingest journal hard quota reached", retentionConflict = false) {
    super(message);
    this.name = "JournalCapacityError";
    this.retentionConflict = retentionConflict;
  }
}

export interface SqliteIngestJournalOptions {
  maxBytes?: number;
  /** Minimum records that retention must preserve before a hard quota can prune. */
  minimumRetainedRecords?: number;
  /** Naming alias used by retention policy integrations. */
  minimumRetentionRecords?: number;
}

export interface JournalLiveStateBinding {
  readonly nativeId: string;
  readonly nativeInstanceId: string;
}

export interface JournalLiveStateQuery {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly afterSeq: number;
  readonly since: string;
  readonly until: string;
  readonly bindings: readonly JournalLiveStateBinding[];
  readonly limit: number;
}

export interface JournalLiveStatePage {
  /** Most recent bounded page, returned in ascending sequence order. */
  readonly records: readonly IngestRecord[];
  readonly truncated: boolean;
}

export interface JournalLiveStateActivityQuery {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly afterSeq: number;
  readonly since: string;
  readonly until: string;
  readonly limit: number;
}

export interface JournalLiveStateActivityPage {
  readonly activity: readonly {
    readonly nativeId: string;
    readonly nativeInstanceIds: readonly string[];
    readonly eventCount: number;
    readonly latestObservedAt: string;
  }[];
  readonly truncated: boolean;
}

export interface JournalCapacityStatus {
  readonly usedBytes: number;
  readonly maxBytes: number;
  readonly remainingBytes: number;
}

/** A journal sequence range pinned by a durable proposal evidence reference. */
export interface IngestJournalRetentionEvidenceReference {
  readonly referenceId: string;
  readonly bridgeId: string;
  readonly epochId: string;
  readonly seq: number;
}

/** Explicit, operator/audit supplied retention request. */
export interface IngestJournalRetentionPolicy {
  readonly policyId: string;
  readonly bridgeId: string;
  /** The caller supplies the decision time so the operation is deterministic and auditable. */
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly reason: string;
  /** Defaults to the supported 168-hour evidence window. */
  readonly evidenceWindowMs?: number;
  readonly proposalEvidence?: readonly IngestJournalRetentionEvidenceReference[];
}

export interface IngestJournalRetentionResult {
  readonly policyId: string;
  readonly bridgeId: string;
  readonly evidenceWindowStart: string;
  /** Eligible records older than the evidence window, before protection rules. */
  readonly candidateCount: number;
  readonly deletedEventCount: number;
  readonly skippedRecoveryCount: number;
  readonly skippedHistoryGapCount: number;
  readonly skippedProposalEvidenceCount: number;
  readonly skippedEvidenceWindowCount: number;
  readonly bytesDeleted: number;
  readonly coverageFloor?: string;
  readonly partialCoverage: boolean;
}

export interface IngestJournalRetentionAudit {
  readonly policyId: string;
  readonly bridgeId: string;
  readonly appliedAt: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly evidenceWindowStart: string;
  readonly candidateCount: number;
  readonly deletedEventCount: number;
  readonly skippedRecoveryCount: number;
  readonly skippedHistoryGapCount: number;
  readonly skippedProposalEvidenceCount: number;
  readonly skippedEvidenceWindowCount: number;
  readonly bytesDeleted: number;
  readonly coverageFloor?: string;
  readonly partialCoverage: boolean;
}

/** Current queryable coverage, including an explicit partial-history floor. */
export interface IngestJournalCoverage {
  readonly bridgeId: string;
  readonly coverageFloor?: string;
  readonly retainedRecordCount: number;
  readonly partial: boolean;
  readonly latestConsistentWatermark?: JournalWatermark;
  readonly openHistoryGapCount: number;
  readonly lastRetentionPolicyId?: string;
}

export interface IngestJournal {
  appendAtomic(record: IngestRecord): void;
  append?(record: IngestRecord): void;
  appendRejectionAtomic(rejection: RejectionRecord, watermark: JournalWatermark): void;
  recordRejection(rejection: RejectionRecord): void;
  appendRejection?(rejection: RejectionRecord, watermark?: JournalWatermark): void;
  recordHistoryGap(gap: HistoryGapRecord): void;
  /** Records a quota/retention conflict without consuming the event quota. */
  recordRetentionConflict?(gap: HistoryGapRecord): void;
  closeHistoryGaps(bridgeId: string, epochId: string): void;
  watermark(bridgeId: string): JournalWatermark | undefined;
  /** Last sync-complete whose manifest was verified and world exchanged. */
  consistentWatermark?(bridgeId: string): JournalWatermark | undefined;
  markConsistent?(bridgeId: string, watermark: JournalWatermark): void;
  /** Optional bounded evidence seam; production SQLite journals implement it. */
  queryLiveStateRecords?(query: JournalLiveStateQuery): JournalLiveStatePage;
  /** Optional metadata-only activity seam; values never leave the journal. */
  queryLiveStateActivity?(query: JournalLiveStateActivityQuery): JournalLiveStateActivityPage;
  records(bridgeId?: string): IngestRecord[];
  rejections(bridgeId?: string): RejectionRecord[];
  historyGaps(bridgeId?: string): HistoryGapRecord[];
  heartbeatIntervals(bridgeId?: string): HeartbeatIntervalRecord[];
  /** Aggregate logical quota only; never returns journal records or household values. */
  capacity?(): JournalCapacityStatus;
  /** Exact no-write retention decision preview; production SQLite journals implement it. */
  previewRetention?(policy: IngestJournalRetentionPolicy): IngestJournalRetentionResult;
  applyRetention?(policy: IngestJournalRetentionPolicy): IngestJournalRetentionResult;
  coverage?(bridgeId: string): IngestJournalCoverage;
  retentionAudits?(bridgeId?: string): readonly IngestJournalRetentionAudit[];
  /** Bounded metadata-only latest audit lookup; does not enumerate history. */
  latestRetentionAudit?(bridgeId: string): IngestJournalRetentionAudit | undefined;
  assertWithinQuota(): void;
  contains(text: string): boolean;
  close(): void;
}

type SqlRow = Record<string, unknown>;
type RetentionEventRow = {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly seq: number;
  readonly receivedAt: string;
  readonly bytes: number;
};

interface RetentionDecision {
  readonly result: IngestJournalRetentionResult;
  readonly toDelete: readonly RetentionEventRow[];
}

const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_EVIDENCE_WINDOW_MS = 168 * 60 * 60 * 1_000;
const MAX_EVIDENCE_WINDOW_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_RETENTION_REFERENCES = 1_000;

/**
 * The Phase 0 journal deliberately exposes a small SQLite seam. Every legal
 * envelope and its watermark are committed in one transaction. A logical
 * byte ledger is used for the hard quota so quota checks are deterministic in
 * tests and do not depend on SQLite page allocation details.
 */
export class SqliteIngestJournal implements IngestJournal {
  private readonly db: DatabaseSync;
  private readonly maxBytes: number;
  private readonly minimumRetainedRecords: number;
  private usedBytes: number;

  constructor(readonly path: string, options: SqliteIngestJournalOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new RangeError("journal maxBytes must be a positive safe integer");
    }
    this.minimumRetainedRecords = options.minimumRetainedRecords ?? options.minimumRetentionRecords ?? 0;
    if (!Number.isSafeInteger(this.minimumRetainedRecords) || this.minimumRetainedRecords < 0) {
      throw new RangeError("journal minimumRetainedRecords must be a non-negative safe integer");
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ingest_events (
        bridge_id TEXT NOT NULL, epoch_id TEXT NOT NULL, seq INTEGER NOT NULL,
        received_at TEXT NOT NULL, kind TEXT NOT NULL, envelope_json TEXT NOT NULL,
        bytes INTEGER NOT NULL, PRIMARY KEY (bridge_id, epoch_id, seq)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ingest_rejections (
        id INTEGER PRIMARY KEY AUTOINCREMENT, bridge_id TEXT NOT NULL,
        epoch_id TEXT NOT NULL, seq INTEGER NOT NULL, reason TEXT NOT NULL,
        native_id TEXT, bytes INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ingest_history_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT, bridge_id TEXT NOT NULL,
        epoch_id TEXT NOT NULL, from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL,
        reason TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ingest_heartbeats (
        bridge_id TEXT NOT NULL, epoch_id TEXT NOT NULL, from_seq INTEGER NOT NULL,
        to_seq INTEGER NOT NULL, count INTEGER NOT NULL, bytes INTEGER NOT NULL,
        PRIMARY KEY (bridge_id, epoch_id, from_seq)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ingest_watermarks (
        bridge_id TEXT PRIMARY KEY, epoch_id TEXT NOT NULL, last_seq INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ingest_consistent_watermarks (
        bridge_id TEXT PRIMARY KEY, epoch_id TEXT NOT NULL, last_seq INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ingest_consistent_epochs (
        bridge_id TEXT NOT NULL, epoch_id TEXT NOT NULL, last_seq INTEGER NOT NULL,
        PRIMARY KEY (bridge_id, epoch_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ingest_retention_audits (
        policy_id TEXT PRIMARY KEY, bridge_id TEXT NOT NULL, applied_at TEXT NOT NULL,
        requested_by TEXT NOT NULL, reason TEXT NOT NULL, evidence_window_start TEXT NOT NULL,
        candidate_count INTEGER NOT NULL, deleted_event_count INTEGER NOT NULL,
        skipped_recovery_count INTEGER NOT NULL, skipped_history_gap_count INTEGER NOT NULL,
        skipped_proposal_evidence_count INTEGER NOT NULL, skipped_evidence_window_count INTEGER NOT NULL,
        bytes_deleted INTEGER NOT NULL, coverage_floor TEXT,
        partial_coverage INTEGER NOT NULL
      ) STRICT;
    `);
    this.db.exec(`INSERT OR IGNORE INTO ingest_consistent_epochs (bridge_id, epoch_id, last_seq)
      SELECT bridge_id, epoch_id, last_seq FROM ingest_consistent_watermarks;`);
    this.usedBytes = this.readUsedBytes();
    this.ensurePrivateFile();
  }

  appendAtomic(record: IngestRecord): void {
    const envelopeJson = JSON.stringify(record.envelope);
    const bytes = Buffer.byteLength(envelopeJson, "utf8");
    const additionalBytes = record.envelope.event.kind === "heartbeat"
      ? (this.canMergeHeartbeat(record) ? 0 : Math.max(bytes, 48))
      : bytes;
    this.assertCapacity(additionalBytes);
    const usedBytesBefore = this.usedBytes;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (record.envelope.event.kind === "heartbeat") {
        this.appendHeartbeat(record, bytes);
      } else {
        this.db.prepare(`INSERT INTO ingest_events
          (bridge_id, epoch_id, seq, received_at, kind, envelope_json, bytes)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          record.bridgeId,
          record.envelope.epochId,
          record.envelope.seq,
          record.receivedAt,
          record.envelope.event.kind,
          envelopeJson,
          bytes,
        );
        this.usedBytes += bytes;
      }
      this.upsertWatermark(record.bridgeId, record.envelope.epochId, record.envelope.seq);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.usedBytes = usedBytesBefore;
      throw error;
    } finally {
      this.ensurePrivateFile();
    }
  }

  append(record: IngestRecord): void {
    this.appendAtomic(record);
  }

  appendRejectionAtomic(rejection: RejectionRecord, watermark: JournalWatermark): void {
    const bytes = serializedBytes(rejection);
    this.assertCapacity(bytes);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.insertRejection(rejection, bytes);
      this.upsertWatermark(rejection.bridgeId, watermark.epochId, watermark.lastSeq);
      this.db.exec("COMMIT");
      this.usedBytes += bytes;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFile();
    }
  }

  recordRejection(rejection: RejectionRecord): void {
    const bytes = serializedBytes(rejection);
    this.assertCapacity(bytes);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.insertRejection(rejection, bytes);
      this.db.exec("COMMIT");
      this.usedBytes += bytes;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFile();
    }
  }

  appendRejection(rejection: RejectionRecord, watermark?: JournalWatermark): void {
    if (watermark === undefined) {
      this.recordRejection(rejection);
      return;
    }
    this.appendRejectionAtomic(rejection, watermark);
  }

  recordHistoryGap(gap: HistoryGapRecord): void {
    const bytes = serializedBytes(gap);
    this.assertCapacity(bytes);
    this.db.prepare(`INSERT INTO ingest_history_gaps
      (bridge_id, epoch_id, from_seq, to_seq, reason, bytes) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(gap.bridgeId, gap.epochId, gap.fromSeq, gap.toSeq, gap.reason, bytes);
    this.usedBytes += bytes;
    this.ensurePrivateFile();
  }

  recordRetentionConflict(gap: HistoryGapRecord): void {
    const existing = this.db.prepare(`SELECT id FROM ingest_history_gaps
      WHERE bridge_id = ? AND epoch_id = ? AND from_seq = ? AND to_seq = ? AND reason = ? LIMIT 1`)
      .get(gap.bridgeId, gap.epochId, gap.fromSeq, gap.toSeq, gap.reason) as SqlRow | undefined;
    if (existing) return;
    const countRow = this.db.prepare("SELECT COUNT(*) AS count FROM ingest_history_gaps WHERE reason = 'journal_quota_retention_conflict'")
      .get() as SqlRow;
    if (Number(countRow.count) >= 32) return;
    // A conflict marker is metadata about the failed append, not retained
    // event data, so it must remain writable when the event quota is full.
    this.db.prepare(`INSERT INTO ingest_history_gaps
      (bridge_id, epoch_id, from_seq, to_seq, reason, bytes) VALUES (?, ?, ?, ?, ?, 0)`)
      .run(gap.bridgeId, gap.epochId, gap.fromSeq, gap.toSeq, gap.reason);
    this.ensurePrivateFile();
  }

  closeHistoryGaps(bridgeId: string, epochId: string): void {
    this.db.prepare("UPDATE ingest_history_gaps SET closed = 1 WHERE bridge_id = ? AND epoch_id <> ? AND closed = 0")
      .run(bridgeId, epochId);
    this.ensurePrivateFile();
  }

  watermark(bridgeId: string): JournalWatermark | undefined {
    const row = this.db.prepare("SELECT epoch_id, last_seq FROM ingest_watermarks WHERE bridge_id = ?")
      .get(bridgeId) as SqlRow | undefined;
    if (!row) return undefined;
    return { epochId: String(row.epoch_id), lastSeq: Number(row.last_seq) };
  }

  consistentWatermark(bridgeId: string): JournalWatermark | undefined {
    const row = this.db.prepare("SELECT epoch_id, last_seq FROM ingest_consistent_watermarks WHERE bridge_id = ?")
      .get(bridgeId) as SqlRow | undefined;
    if (!row) return undefined;
    return { epochId: String(row.epoch_id), lastSeq: Number(row.last_seq) };
  }

  markConsistent(bridgeId: string, watermark: JournalWatermark): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO ingest_consistent_epochs (bridge_id, epoch_id, last_seq)
        VALUES (?, ?, ?)
        ON CONFLICT(bridge_id, epoch_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)`)
        .run(bridgeId, watermark.epochId, watermark.lastSeq);
      this.db.prepare(`INSERT INTO ingest_consistent_watermarks (bridge_id, epoch_id, last_seq)
        VALUES (?, ?, ?)
        ON CONFLICT(bridge_id) DO UPDATE SET epoch_id = excluded.epoch_id, last_seq = excluded.last_seq`)
        .run(bridgeId, watermark.epochId, watermark.lastSeq);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFile();
    }
  }

  previewRetention(policy: IngestJournalRetentionPolicy): IngestJournalRetentionResult {
    const validated = validateRetentionPolicy(policy);
    this.db.exec("BEGIN");
    try {
      const decision = this.readRetentionDecision(policy, validated);
      this.db.exec("ROLLBACK");
      return decision.result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original bounded preview failure.
      }
      throw error;
    }
  }

  applyRetention(policy: IngestJournalRetentionPolicy): IngestJournalRetentionResult {
    const validated = validateRetentionPolicy(policy);
    const usedBytesBefore = this.usedBytes;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT policy_id FROM ingest_retention_audits WHERE policy_id = ?")
        .get(policy.policyId) as SqlRow | undefined;
      if (existing !== undefined) throw new Error(`retention policy ${policy.policyId} already applied`);

      // The lock must cover the complete decision snapshot. A second process
      // cannot commit a new gap/watermark between these reads and deletion.
      const decision = this.readRetentionDecision(policy, validated);

      for (const event of decision.toDelete) {
        this.db.prepare("DELETE FROM ingest_events WHERE bridge_id = ? AND epoch_id = ? AND seq = ?")
          .run(event.bridgeId, event.epochId, event.seq);
      }
      const result = decision.result;
      this.db.prepare(`INSERT INTO ingest_retention_audits
        (policy_id, bridge_id, applied_at, requested_by, reason, evidence_window_start,
         candidate_count, deleted_event_count, skipped_recovery_count, skipped_history_gap_count,
         skipped_proposal_evidence_count, skipped_evidence_window_count, bytes_deleted,
         coverage_floor, partial_coverage)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        policy.policyId,
        policy.bridgeId,
        policy.requestedAt,
        policy.requestedBy,
        policy.reason,
        result.evidenceWindowStart,
        result.candidateCount,
        result.deletedEventCount,
        result.skippedRecoveryCount,
        result.skippedHistoryGapCount,
        result.skippedProposalEvidenceCount,
        result.skippedEvidenceWindowCount,
        result.bytesDeleted,
        result.coverageFloor ?? null,
        result.partialCoverage ? 1 : 0,
      );
      const usedBytesAfter = this.readUsedBytes();
      // Check permissions while rollback is still possible. The commit below
      // is the point at which deletion and its audit become durable together.
      this.ensurePrivateFile();
      this.db.exec("COMMIT");
      this.usedBytes = usedBytesAfter;
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure; SQLite will reject any future write if
        // the transaction could not be rolled back.
      }
      this.usedBytes = usedBytesBefore;
      throw error;
    }
  }

  private readRetentionDecision(
    policy: IngestJournalRetentionPolicy,
    validated: ReturnType<typeof validateRetentionPolicy>,
  ): RetentionDecision {
    const evidenceWindowStart = new Date(Date.parse(policy.requestedAt) - validated.evidenceWindowMs).toISOString();
    const consistent = this.consistentWatermark(policy.bridgeId);
    const openGapEpochs = new Set((this.db.prepare(`SELECT DISTINCT epoch_id
      FROM ingest_history_gaps WHERE bridge_id = ? AND closed = 0`).all(policy.bridgeId) as SqlRow[])
      .map((row) => String(row.epoch_id)));
    const consistentEpochs = new Set((this.db.prepare(`SELECT epoch_id
      FROM ingest_consistent_epochs WHERE bridge_id = ?`).all(policy.bridgeId) as SqlRow[])
      .map((row) => String(row.epoch_id)));
    const rows = (this.db.prepare(`SELECT bridge_id, epoch_id, seq, received_at, bytes
      FROM ingest_events WHERE bridge_id = ? ORDER BY rowid`).all(policy.bridgeId) as SqlRow[]).map((row) => ({
      bridgeId: String(row.bridge_id),
      epochId: String(row.epoch_id),
      seq: Number(row.seq),
      receivedAt: String(row.received_at),
      bytes: Number(row.bytes),
    }));
    const toDelete: RetentionEventRow[] = [];
    const proposalEvidenceKeys = new Set(validated.proposalEvidence.map((reference) => (
      `${reference.bridgeId}\u0000${reference.epochId}\u0000${reference.seq}`
    )));
    let candidateCount = 0;
    let skippedRecoveryCount = 0;
    let skippedHistoryGapCount = 0;
    let skippedProposalEvidenceCount = 0;
    let skippedEvidenceWindowCount = 0;

    for (const event of rows) {
      const receivedAtMs = Date.parse(event.receivedAt);
      if (!Number.isFinite(receivedAtMs) || receivedAtMs >= Date.parse(evidenceWindowStart)) {
        skippedEvidenceWindowCount += 1;
        continue;
      }
      candidateCount += 1;
      if (consistent !== undefined && event.epochId === consistent.epochId && event.seq <= consistent.lastSeq) {
        skippedRecoveryCount += 1;
      } else if (openGapEpochs.has(event.epochId)) {
        skippedHistoryGapCount += 1;
      } else if (!consistentEpochs.has(event.epochId)) {
        skippedRecoveryCount += 1;
      } else if (proposalEvidenceKeys.has(`${event.bridgeId}\u0000${event.epochId}\u0000${event.seq}`)) {
        skippedProposalEvidenceCount += 1;
      } else {
        toDelete.push(event);
      }
    }
    const deletedKeys = new Set(toDelete.map((event) => `${event.epochId}\u0000${event.seq}`));
    const retainedTimes = rows
      .filter((event) => !deletedKeys.has(`${event.epochId}\u0000${event.seq}`))
      .map((event) => event.receivedAt)
      .filter((receivedAt) => Number.isFinite(Date.parse(receivedAt)))
      .sort((left, right) => Date.parse(left) - Date.parse(right));
    const coverageFloor = retainedTimes[0];
    const previousPartial = this.db.prepare(`SELECT COALESCE(MAX(partial_coverage), 0) AS partial
      FROM ingest_retention_audits WHERE bridge_id = ?`).get(policy.bridgeId) as SqlRow;
    const bytesDeleted = toDelete.reduce((sum, event) => sum + event.bytes, 0);
    const partialCoverage = Number(previousPartial.partial) !== 0 || toDelete.length > 0;
    return {
      toDelete,
      result: {
        policyId: policy.policyId,
        bridgeId: policy.bridgeId,
        evidenceWindowStart,
        candidateCount,
        deletedEventCount: toDelete.length,
        skippedRecoveryCount,
        skippedHistoryGapCount,
        skippedProposalEvidenceCount,
        skippedEvidenceWindowCount,
        bytesDeleted,
        ...(coverageFloor === undefined ? {} : { coverageFloor }),
        partialCoverage,
      },
    };
  }

  coverage(bridgeId: string): IngestJournalCoverage {
    validateBridgeId(bridgeId);
    const row = this.db.prepare("SELECT COUNT(*) AS retained_count FROM ingest_events WHERE bridge_id = ?")
      .get(bridgeId) as SqlRow;
    const partialRow = this.db.prepare(`SELECT COALESCE(MAX(partial_coverage), 0) AS partial,
        (SELECT policy_id FROM ingest_retention_audits WHERE bridge_id = ? ORDER BY rowid DESC LIMIT 1) AS policy_id
      FROM ingest_retention_audits WHERE bridge_id = ?`).get(bridgeId, bridgeId) as SqlRow;
    const gapRow = this.db.prepare(`SELECT COUNT(*) AS count FROM ingest_history_gaps
      WHERE bridge_id = ? AND closed = 0`).get(bridgeId) as SqlRow;
    const coverageFloor = this.readCoverageFloor(bridgeId);
    const latestPolicy = partialRow.policy_id === null || partialRow.policy_id === undefined
      ? undefined
      : String(partialRow.policy_id);
    return {
      bridgeId,
      ...(coverageFloor === undefined ? {} : { coverageFloor }),
      retainedRecordCount: Number(row.retained_count),
      partial: Number(partialRow.partial) !== 0,
      ...(this.consistentWatermark(bridgeId) === undefined
        ? {}
        : { latestConsistentWatermark: this.consistentWatermark(bridgeId) }),
      openHistoryGapCount: Number(gapRow.count),
      ...(latestPolicy === undefined ? {} : { lastRetentionPolicyId: latestPolicy }),
    };
  }

  retentionAudits(bridgeId?: string): readonly IngestJournalRetentionAudit[] {
    const rows = (bridgeId === undefined
      ? this.db.prepare(`SELECT policy_id, bridge_id, applied_at, requested_by, reason,
          evidence_window_start, candidate_count, deleted_event_count, skipped_recovery_count,
          skipped_history_gap_count, skipped_proposal_evidence_count, skipped_evidence_window_count,
          bytes_deleted, coverage_floor, partial_coverage
        FROM ingest_retention_audits ORDER BY rowid`).all()
      : this.db.prepare(`SELECT policy_id, bridge_id, applied_at, requested_by, reason,
          evidence_window_start, candidate_count, deleted_event_count, skipped_recovery_count,
          skipped_history_gap_count, skipped_proposal_evidence_count, skipped_evidence_window_count,
          bytes_deleted, coverage_floor, partial_coverage
        FROM ingest_retention_audits WHERE bridge_id = ? ORDER BY rowid`).all(bridgeId)) as SqlRow[];
    return rows.map(retentionAuditFromRow);
  }

  latestRetentionAudit(bridgeId: string): IngestJournalRetentionAudit | undefined {
    const row = this.db.prepare(`SELECT policy_id, bridge_id, applied_at, requested_by, reason,
        evidence_window_start, candidate_count, deleted_event_count, skipped_recovery_count,
        skipped_history_gap_count, skipped_proposal_evidence_count, skipped_evidence_window_count,
        bytes_deleted, coverage_floor, partial_coverage
      FROM ingest_retention_audits WHERE bridge_id = ? ORDER BY rowid DESC LIMIT 1`).get(bridgeId) as SqlRow | undefined;
    return row === undefined ? undefined : retentionAuditFromRow(row);
  }

  records(bridgeId?: string): IngestRecord[] {
    const rows = (bridgeId === undefined
      ? this.db.prepare("SELECT bridge_id, received_at, envelope_json FROM ingest_events ORDER BY rowid").all()
      : this.db.prepare("SELECT bridge_id, received_at, envelope_json FROM ingest_events WHERE bridge_id = ? ORDER BY rowid").all(bridgeId)) as SqlRow[];
    return rows.map((row) => ({
      bridgeId: String(row.bridge_id),
      receivedAt: String(row.received_at),
      envelope: JSON.parse(String(row.envelope_json)) as Envelope,
    }));
  }

  queryLiveStateRecords(query: JournalLiveStateQuery): JournalLiveStatePage {
    validateLiveStateQuery(query);
    const bindingClauses = query.bindings.map(() => `(
      json_extract(envelope_json, '$.event.state.nativeId') = ?
      AND json_extract(envelope_json, '$.event.state.nativeInstanceId') = ?
    )`);
    const bindingParams = query.bindings.flatMap((binding) => [binding.nativeId, binding.nativeInstanceId]);
    const rows = this.db.prepare(`SELECT bridge_id, received_at, envelope_json
      FROM ingest_events
      WHERE bridge_id = ? AND epoch_id = ? AND seq > ? AND kind = 'state'
        AND julianday(received_at) >= julianday(?)
        AND julianday(received_at) <= julianday(?)
        AND (${bindingClauses.join(" OR ")})
      ORDER BY seq DESC LIMIT ?`).all(
        query.bridgeId,
        query.epochId,
        query.afterSeq,
        query.since,
        query.until,
        ...bindingParams,
        query.limit + 1,
      ) as SqlRow[];
    const truncated = rows.length > query.limit;
    const page = rows.slice(0, query.limit).map((row) => ({
      bridgeId: String(row.bridge_id),
      receivedAt: String(row.received_at),
      envelope: JSON.parse(String(row.envelope_json)) as Envelope,
    })).reverse();
    return { records: page, truncated };
  }

  queryLiveStateActivity(query: JournalLiveStateActivityQuery): JournalLiveStateActivityPage {
    validateLiveStateActivityQuery(query);
    const rows = this.db.prepare(`SELECT
        json_extract(envelope_json, '$.event.state.nativeId') AS native_id,
        json_group_array(DISTINCT json_extract(envelope_json, '$.event.state.nativeInstanceId')) AS native_instance_ids,
        COUNT(*) AS event_count,
        MAX(received_at) AS latest_observed_at
      FROM ingest_events
      WHERE bridge_id = ? AND epoch_id = ? AND seq > ? AND kind = 'state'
        AND julianday(received_at) >= julianday(?)
        AND julianday(received_at) <= julianday(?)
      GROUP BY native_id
      ORDER BY event_count DESC, latest_observed_at DESC, native_id ASC
      LIMIT ?`).all(
      query.bridgeId,
      query.epochId,
      query.afterSeq,
      query.since,
      query.until,
      query.limit + 1,
    ) as SqlRow[];
    return {
      activity: rows.slice(0, query.limit).map((row) => ({
        nativeId: String(row.native_id),
        nativeInstanceIds: (JSON.parse(String(row.native_instance_ids)) as unknown[])
          .map(String)
          .sort((left, right) => left.localeCompare(right)),
        eventCount: Number(row.event_count),
        latestObservedAt: String(row.latest_observed_at),
      })),
      truncated: rows.length > query.limit,
    };
  }

  rejections(bridgeId?: string): RejectionRecord[] {
    const rows = (bridgeId === undefined
      ? this.db.prepare("SELECT bridge_id, epoch_id, seq, reason, native_id FROM ingest_rejections ORDER BY id").all()
      : this.db.prepare("SELECT bridge_id, epoch_id, seq, reason, native_id FROM ingest_rejections WHERE bridge_id = ? ORDER BY id").all(bridgeId)) as SqlRow[];
    return rows.map((row) => ({
      bridgeId: String(row.bridge_id), epochId: String(row.epoch_id), seq: Number(row.seq), reason: String(row.reason),
      ...(row.native_id === null || row.native_id === undefined ? {} : { nativeId: String(row.native_id) }),
    }));
  }

  historyGaps(bridgeId?: string): HistoryGapRecord[] {
    const rows = (bridgeId === undefined
      ? this.db.prepare("SELECT bridge_id, epoch_id, from_seq, to_seq, reason FROM ingest_history_gaps ORDER BY id").all()
      : this.db.prepare("SELECT bridge_id, epoch_id, from_seq, to_seq, reason FROM ingest_history_gaps WHERE bridge_id = ? ORDER BY id").all(bridgeId)) as SqlRow[];
    return rows.map((row) => ({ bridgeId: String(row.bridge_id), epochId: String(row.epoch_id), fromSeq: Number(row.from_seq), toSeq: Number(row.to_seq), reason: String(row.reason) }));
  }

  heartbeatIntervals(bridgeId?: string): HeartbeatIntervalRecord[] {
    const rows = (bridgeId === undefined
      ? this.db.prepare("SELECT bridge_id, epoch_id, from_seq, to_seq, count FROM ingest_heartbeats ORDER BY rowid").all()
      : this.db.prepare("SELECT bridge_id, epoch_id, from_seq, to_seq, count FROM ingest_heartbeats WHERE bridge_id = ? ORDER BY rowid").all(bridgeId)) as SqlRow[];
    return rows.map((row) => ({ bridgeId: String(row.bridge_id), epochId: String(row.epoch_id), fromSeq: Number(row.from_seq), toSeq: Number(row.to_seq), count: Number(row.count) }));
  }

  capacity(): JournalCapacityStatus {
    return {
      usedBytes: this.usedBytes,
      maxBytes: this.maxBytes,
      remainingBytes: Math.max(0, this.maxBytes - this.usedBytes),
    };
  }

  assertWithinQuota(): void {
    if (this.usedBytes >= this.maxBytes) throw new JournalCapacityError(undefined, this.minimumRetainedRecords > 0);
  }

  contains(text: string): boolean {
    const values = [
      this.db.prepare("SELECT bridge_id, epoch_id, seq, received_at, kind, envelope_json FROM ingest_events").all(),
      this.db.prepare("SELECT bridge_id, epoch_id, seq, reason, native_id FROM ingest_rejections").all(),
      this.db.prepare("SELECT bridge_id, epoch_id, from_seq, to_seq, reason FROM ingest_history_gaps").all(),
    ];
    return JSON.stringify(values).includes(text);
  }

  close(): void {
    this.db.close();
  }

  private appendHeartbeat(record: IngestRecord, bytes: number): void {
    const previous = this.db.prepare(`SELECT from_seq, to_seq, count FROM ingest_heartbeats
      WHERE bridge_id = ? AND epoch_id = ? ORDER BY to_seq DESC LIMIT 1`)
      .get(record.bridgeId, record.envelope.epochId) as SqlRow | undefined;
    if (previous && Number(previous.to_seq) + 1 === record.envelope.seq) {
      this.db.prepare(`UPDATE ingest_heartbeats SET to_seq = ?, count = count + 1 WHERE bridge_id = ? AND epoch_id = ? AND from_seq = ?`)
        .run(record.envelope.seq, record.bridgeId, record.envelope.epochId, Number(previous.from_seq));
      return;
    }
    const intervalBytes = Math.max(bytes, 48);
    this.db.prepare(`INSERT INTO ingest_heartbeats
      (bridge_id, epoch_id, from_seq, to_seq, count, bytes) VALUES (?, ?, ?, ?, 1, ?)`)
      .run(record.bridgeId, record.envelope.epochId, record.envelope.seq, record.envelope.seq, intervalBytes);
    this.usedBytes += intervalBytes;
  }

  private canMergeHeartbeat(record: IngestRecord): boolean {
    const previous = this.db.prepare(`SELECT to_seq FROM ingest_heartbeats
      WHERE bridge_id = ? AND epoch_id = ? ORDER BY to_seq DESC LIMIT 1`)
      .get(record.bridgeId, record.envelope.epochId) as SqlRow | undefined;
    return previous !== undefined && Number(previous.to_seq) + 1 === record.envelope.seq;
  }

  private insertRejection(rejection: RejectionRecord, bytes: number): void {
    this.db.prepare(`INSERT INTO ingest_rejections
      (bridge_id, epoch_id, seq, reason, native_id, bytes) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(rejection.bridgeId, rejection.epochId, rejection.seq, rejection.reason, rejection.nativeId ?? null, bytes);
  }

  private upsertWatermark(bridgeId: string, epochId: string, seq: number): void {
    this.db.prepare(`INSERT INTO ingest_watermarks (bridge_id, epoch_id, last_seq) VALUES (?, ?, ?)
      ON CONFLICT(bridge_id) DO UPDATE SET epoch_id = excluded.epoch_id, last_seq = excluded.last_seq`)
      .run(bridgeId, epochId, seq);
  }

  private readUsedBytes(): number {
    const row = this.db.prepare(`SELECT
      COALESCE((SELECT SUM(bytes) FROM ingest_events), 0) +
      COALESCE((SELECT SUM(bytes) FROM ingest_rejections), 0) +
      COALESCE((SELECT SUM(bytes) FROM ingest_history_gaps), 0) +
      COALESCE((SELECT SUM(bytes) FROM ingest_heartbeats), 0) AS used`).get() as SqlRow;
    return Number(row.used);
  }

  private readCoverageFloor(bridgeId: string): string | undefined {
    const rows = this.db.prepare("SELECT received_at FROM ingest_events WHERE bridge_id = ?")
      .all(bridgeId) as SqlRow[];
    let floor: { readonly value: string; readonly timestamp: number } | undefined;
    for (const row of rows) {
      const value = String(row.received_at);
      const timestamp = Date.parse(value);
      if (!Number.isFinite(timestamp) || (floor !== undefined && timestamp >= floor.timestamp)) continue;
      floor = { value, timestamp };
    }
    return floor?.value;
  }

  private assertCapacity(additionalBytes: number): void {
    if (this.usedBytes + additionalBytes > this.maxBytes) {
      throw new JournalCapacityError(undefined, this.minimumRetainedRecords > 0);
    }
  }

  private ensurePrivateFile(): void {
    ensurePrivateSqliteFiles(this.path);
  }
}

function validateLiveStateQuery(query: JournalLiveStateQuery): void {
  const validTimestamp = (value: unknown): value is string => (
    typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value))
  );
  if (!query || typeof query !== "object"
    || typeof query.bridgeId !== "string" || query.bridgeId.length === 0 || query.bridgeId.length > 200
    || typeof query.epochId !== "string" || query.epochId.length === 0 || query.epochId.length > 200
    || !Number.isSafeInteger(query.afterSeq) || query.afterSeq < 0
    || !validTimestamp(query.since) || !validTimestamp(query.until)
    || Date.parse(query.since) > Date.parse(query.until)
    || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200
    || !Array.isArray(query.bindings) || query.bindings.length < 1 || query.bindings.length > 50
    || query.bindings.some((binding) => (
      !binding || typeof binding !== "object"
      || typeof binding.nativeId !== "string" || binding.nativeId.length === 0 || binding.nativeId.length > 512
      || typeof binding.nativeInstanceId !== "string" || binding.nativeInstanceId.length === 0
      || binding.nativeInstanceId.length > 512
    ))) {
    throw new TypeError("live state query is invalid or unbounded");
  }
}

function validateLiveStateActivityQuery(query: JournalLiveStateActivityQuery): void {
  const validTimestamp = (value: unknown): value is string => (
    typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value))
  );
  if (!query || typeof query !== "object"
    || typeof query.bridgeId !== "string" || query.bridgeId.length === 0 || query.bridgeId.length > 200
    || typeof query.epochId !== "string" || query.epochId.length === 0 || query.epochId.length > 200
    || !Number.isSafeInteger(query.afterSeq) || query.afterSeq < 0
    || !validTimestamp(query.since) || !validTimestamp(query.until)
    || Date.parse(query.since) > Date.parse(query.until)
    || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 50) {
    throw new TypeError("live state activity query is invalid or unbounded");
  }
}

export { SqliteIngestJournal as IngestJournalStore };
// Runtime alias for callers that use the frozen concept name directly.
export const IngestJournal = SqliteIngestJournal;

function validateRetentionPolicy(policy: IngestJournalRetentionPolicy): {
  readonly evidenceWindowMs: number;
  readonly proposalEvidence: readonly IngestJournalRetentionEvidenceReference[];
} {
  if (policy === null || typeof policy !== "object") throw new TypeError("retention policy is invalid");
  validateBoundedString(policy.policyId, "retention policy id");
  validateBridgeId(policy.bridgeId);
  validateTimestamp(policy.requestedAt, "retention requestedAt");
  validateBoundedString(policy.requestedBy, "retention requestedBy");
  validateBoundedString(policy.reason, "retention reason", 1_000);
  const evidenceWindowMs = policy.evidenceWindowMs ?? DEFAULT_EVIDENCE_WINDOW_MS;
  if (!Number.isSafeInteger(evidenceWindowMs)
    || evidenceWindowMs < DEFAULT_EVIDENCE_WINDOW_MS
    || evidenceWindowMs > MAX_EVIDENCE_WINDOW_MS) {
    throw new RangeError("retention evidenceWindowMs must retain at least 168 hours");
  }
  const proposalEvidence = policy.proposalEvidence ?? [];
  if (!Array.isArray(proposalEvidence) || proposalEvidence.length > MAX_RETENTION_REFERENCES) {
    throw new RangeError("retention proposal evidence references are unbounded");
  }
  for (const reference of proposalEvidence) {
    if (reference === null || typeof reference !== "object") throw new TypeError("retention evidence reference is invalid");
    validateBoundedString(reference.referenceId, "retention evidence reference id");
    validateBridgeId(reference.bridgeId);
    validateBoundedString(reference.epochId, "retention evidence epoch id");
    if (reference.bridgeId !== policy.bridgeId) throw new TypeError("retention evidence bridge must match policy bridge");
    if (!Number.isSafeInteger(reference.seq) || reference.seq < 0) {
      throw new RangeError("retention evidence sequence is invalid");
    }
  }
  return { evidenceWindowMs, proposalEvidence };
}

function validateBridgeId(value: unknown): asserts value is string {
  validateBoundedString(value, "bridge id");
}

function validateBoundedString(value: unknown, label: string, maxLength = 200): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} is invalid`);
  }
}

function validateTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} is invalid`);
  }
}

function retentionAuditFromRow(row: SqlRow): IngestJournalRetentionAudit {
  return {
    policyId: String(row.policy_id),
    bridgeId: String(row.bridge_id),
    appliedAt: String(row.applied_at),
    requestedBy: String(row.requested_by),
    reason: String(row.reason),
    evidenceWindowStart: String(row.evidence_window_start),
    candidateCount: Number(row.candidate_count),
    deletedEventCount: Number(row.deleted_event_count),
    skippedRecoveryCount: Number(row.skipped_recovery_count),
    skippedHistoryGapCount: Number(row.skipped_history_gap_count),
    skippedProposalEvidenceCount: Number(row.skipped_proposal_evidence_count),
    skippedEvidenceWindowCount: Number(row.skipped_evidence_window_count),
    bytesDeleted: Number(row.bytes_deleted),
    ...(row.coverage_floor === null || row.coverage_floor === undefined
      ? {} : { coverageFloor: String(row.coverage_floor) }),
    partialCoverage: Number(row.partial_coverage) !== 0,
  };
}
