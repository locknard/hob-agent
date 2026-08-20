import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  canonicalAssessmentInput,
  parseArtifactAuthorityAssessment,
  parseArtifactEvidenceAttestation,
  parseArtifactRiskAssessment,
  type ArtifactAuthorityAssessment,
  type ArtifactEvidenceAttestation,
  type ArtifactRiskAssessment,
  type ArtifactRef,
} from "./artifact-assessments.js";
import {
  artifactRefSchema,
  parseArtifactJson,
  parseArtifactRevision,
  verifyArtifactRevision,
  type ArtifactRevision,
} from "./neutral-artifact.js";
import { ensurePrivateSqliteFiles } from "./sqlite-private-files.js";

export type ArtifactRegistryStatus = "draft" | "superseded";
export type ArtifactRegistryAuditAction = "created" | "revision_appended" | "superseded" | "assessment_recorded";

export type ArtifactRegistryFaultPoint =
  | "after-artifact-row"
  | "after-status-row"
  | "after-audit-row"
  | "after-assessment-row";

export type ArtifactAssessmentKind =
  | "evidence-attestation"
  | "risk-assessment"
  | "authority-assessment";

export type ArtifactAssessment =
  | ArtifactEvidenceAttestation
  | ArtifactRiskAssessment
  | ArtifactAuthorityAssessment;

export interface ArtifactRegistryAudit {
  readonly id: string;
  readonly artifactId: string;
  readonly revision: number;
  readonly action: ArtifactRegistryAuditAction;
  readonly actor: string;
  readonly at: string;
  readonly idempotencyKey: string;
  readonly reason?: string;
  readonly kind?: ArtifactAssessmentKind;
  readonly recordId?: string;
}

export interface ArtifactRegistryEntry {
  readonly artifact: ArtifactRevision;
  readonly status: ArtifactRegistryStatus;
  readonly tombstone: boolean;
  readonly audit: readonly ArtifactRegistryAudit[];
}

export interface ArtifactRegistryOptions {
  readonly path: string;
  readonly now?: () => string;
  readonly id?: () => string;
  readonly fault?: (point: ArtifactRegistryFaultPoint) => void;
}

export interface CreateArtifactDraftInput {
  readonly artifact: ArtifactRevision;
  readonly idempotencyKey: string;
  readonly actor?: string;
}

export interface AppendArtifactRevisionInput {
  readonly artifact: ArtifactRevision;
  readonly expectedPreviousRevision: number;
  readonly idempotencyKey: string;
  readonly actor?: string;
}

export interface MarkArtifactSupersededInput {
  readonly artifactId: string;
  readonly revision: number;
  readonly idempotencyKey: string;
  readonly actor?: string;
  readonly reason?: string;
}

export interface ArtifactRegistryListQuery {
  readonly artifactId?: string;
  readonly limit?: number;
}

export interface ArtifactRegistryAuditQuery {
  readonly limit?: number;
}

export interface RecordArtifactAssessmentInput<T extends ArtifactAssessment> {
  readonly assessment: T;
  readonly idempotencyKey: string;
  readonly actor?: string;
}

export interface ArtifactAssessmentListQuery {
  readonly kind?: ArtifactAssessmentKind;
  readonly artifact?: ArtifactRef;
  readonly limit?: number;
}

export interface ArtifactAssessmentLookup {
  readonly kind: ArtifactAssessmentKind;
  readonly artifact: ArtifactRef;
  readonly limit?: number;
}

export interface ArtifactAssessmentEntry {
  readonly kind: ArtifactAssessmentKind;
  readonly recordId: string;
  readonly artifact: ArtifactRef;
  readonly inputIdentity: string;
  readonly recordedAt: string;
  readonly assessment: ArtifactAssessment;
  readonly audit: readonly ArtifactRegistryAudit[];
}

export type ArtifactRegistryErrorCode =
  | "invalid_input"
  | "invalid_artifact"
  | "invalid_assessment"
  | "revision_conflict"
  | "not_found"
  | "corrupt_record"
  | "write_failed"
  | "closed";

export class ArtifactRegistryError extends Error {
  readonly code: ArtifactRegistryErrorCode;

  constructor(code: ArtifactRegistryErrorCode, message: string) {
    super(message);
    this.name = "ArtifactRegistryError";
    this.code = code;
  }
}

type SqlRow = Record<string, unknown>;

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 200;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_ACTOR_LENGTH = 200;
const MAX_REASON_LENGTH = 1_000;

/**
 * The M3b registry owns only immutable neutral artifact rows, lifecycle state,
 * and append-only audit. It intentionally has no compiler, bridge, credential,
 * or action surface.
 */
export class ArtifactRegistry {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly fault: ((point: ArtifactRegistryFaultPoint) => void) | undefined;
  private closed = false;

  constructor(options: ArtifactRegistryOptions) {
    if (!options || typeof options.path !== "string" || options.path.length === 0) {
      throw new ArtifactRegistryError("invalid_input", "Artifact registry path is required");
    }
    this.path = options.path;
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? randomUUID;
    this.fault = options.fault;
    if (!isMemoryPath(this.path)) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });

    let openedDatabase: DatabaseSync | undefined;
    try {
      openedDatabase = new DatabaseSync(this.path);
      this.db = openedDatabase;
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS artifact_revisions (
          artifact_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          artifact_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (artifact_id, revision)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS artifact_operations (
          idempotency_key TEXT PRIMARY KEY,
          operation TEXT NOT NULL,
          artifact_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          content_hash TEXT,
          actor TEXT,
          reason TEXT,
          record_kind TEXT,
          record_id TEXT,
          input_identity TEXT,
          payload_hash TEXT,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS artifact_status_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          artifact_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          status TEXT NOT NULL,
          tombstone INTEGER NOT NULL,
          reason TEXT,
          idempotency_key TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS artifact_audit (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          audit_id TEXT NOT NULL UNIQUE,
          artifact_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          action TEXT NOT NULL,
          actor TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          reason TEXT,
          record_kind TEXT,
          record_id TEXT,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS artifact_assessments (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          artifact_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          input_identity TEXT NOT NULL,
          record_id TEXT NOT NULL UNIQUE,
          payload_json TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          UNIQUE (kind, artifact_id, revision, content_hash, input_identity)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS artifact_revisions_by_id
          ON artifact_revisions (artifact_id, revision);
        CREATE INDEX IF NOT EXISTS artifact_audit_by_ref
          ON artifact_audit (artifact_id, revision, sequence);
        CREATE INDEX IF NOT EXISTS artifact_assessments_by_ref
          ON artifact_assessments (kind, artifact_id, revision, content_hash, sequence);
      `);
      this.ensureOperationColumns();
      this.ensureAuditColumns();
      this.ensurePrivateFiles();
    } catch {
      try {
        openedDatabase?.close();
      } catch {
        // Preserve the bounded open failure.
      }
      throw new ArtifactRegistryError("write_failed", "Artifact registry could not be opened");
    }
  }

  createDraft(input: CreateArtifactDraftInput): ArtifactRegistryEntry {
    this.ensureOpen();
    const artifact = validateArtifact(input?.artifact);
    const idempotencyKey = validateBoundedText(input?.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH, "idempotency key");
    const actor = validateBoundedText(input?.actor ?? "hub", MAX_ACTOR_LENGTH, "actor");
    if (artifact.revision !== 1) {
      throw new ArtifactRegistryError("revision_conflict", "Artifact draft must start at revision one");
    }

    return this.writeTransaction(() => {
      const replay = this.findOperation(idempotencyKey);
      if (replay !== undefined) {
        this.assertOperationMatches(replay, "create", artifact, undefined, undefined, actor);
        return this.requireEntry(artifact.artifactId, artifact.revision);
      }
      if (this.findRevisionRow(artifact.artifactId, artifact.revision) !== undefined) {
        throw new ArtifactRegistryError("revision_conflict", "Artifact revision already exists");
      }
      this.insertRevision(artifact);
      this.inject("after-artifact-row");
      this.insertOperation(idempotencyKey, "create", artifact, this.now(), undefined, actor);
      this.insertAudit({
        artifact,
        action: "created",
        actor,
        at: this.now(),
        idempotencyKey,
      });
      this.inject("after-audit-row");
      return this.requireEntry(artifact.artifactId, artifact.revision);
    });
  }

  appendRevision(input: AppendArtifactRevisionInput): ArtifactRegistryEntry {
    this.ensureOpen();
    const artifact = validateArtifact(input?.artifact);
    const idempotencyKey = validateBoundedText(input?.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH, "idempotency key");
    const actor = validateBoundedText(input?.actor ?? "hub", MAX_ACTOR_LENGTH, "actor");
    if (!Number.isSafeInteger(input?.expectedPreviousRevision) || input.expectedPreviousRevision < 1) {
      throw new ArtifactRegistryError("invalid_input", "Expected previous revision is invalid");
    }
    const expectedRevision = input.expectedPreviousRevision + 1;
    if (artifact.revision !== expectedRevision) {
      throw new ArtifactRegistryError("revision_conflict", "Artifact revision is not the expected next revision");
    }

    return this.writeTransaction(() => {
      const replay = this.findOperation(idempotencyKey);
      if (replay !== undefined) {
        this.assertOperationMatches(replay, "append", artifact, input.expectedPreviousRevision, undefined, actor);
        return this.requireEntry(artifact.artifactId, artifact.revision);
      }
      const currentRevision = this.latestRevision(artifact.artifactId);
      if (currentRevision !== input.expectedPreviousRevision) {
        throw new ArtifactRegistryError("revision_conflict", "Artifact expected revision is stale");
      }
      if (this.findRevisionRow(artifact.artifactId, artifact.revision) !== undefined) {
        throw new ArtifactRegistryError("revision_conflict", "Artifact revision already exists");
      }
      this.insertRevision(artifact);
      this.inject("after-artifact-row");
      this.insertOperation(idempotencyKey, "append", artifact, this.now(), undefined, actor);
      this.insertAudit({
        artifact,
        action: "revision_appended",
        actor,
        at: this.now(),
        idempotencyKey,
      });
      this.inject("after-audit-row");
      return this.requireEntry(artifact.artifactId, artifact.revision);
    });
  }

  markSuperseded(input: MarkArtifactSupersededInput): ArtifactRegistryEntry {
    this.ensureOpen();
    const artifactId = validateArtifactId(input?.artifactId);
    const revision = input?.revision;
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new ArtifactRegistryError("invalid_input", "Artifact revision is invalid");
    }
    const idempotencyKey = validateBoundedText(input?.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH, "idempotency key");
    const actor = validateBoundedText(input?.actor ?? "hub", MAX_ACTOR_LENGTH, "actor");
    const reason = input?.reason === undefined
      ? undefined
      : validateBoundedText(input.reason, MAX_REASON_LENGTH, "reason");
    return this.writeTransaction(() => {
      const replay = this.findOperation(idempotencyKey);
      if (replay !== undefined) {
        this.assertSupersedeOperationMatches(replay, artifactId, revision, reason, actor);
        const entry = this.requireEntry(artifactId, revision);
        if (replay.contentHash !== entry.artifact.contentHash) {
          throw new ArtifactRegistryError("corrupt_record", "Artifact idempotency record is inconsistent");
        }
        return entry;
      }
      const artifact = this.requireEntry(artifactId, revision).artifact;
      const current = this.readStatus(artifactId, revision);
      if (current.status === "superseded") {
        throw new ArtifactRegistryError("revision_conflict", "Artifact revision is already superseded");
      }
      const at = this.now();
      this.db.prepare(`INSERT INTO artifact_status_events
        (artifact_id, revision, status, tombstone, reason, idempotency_key, created_at)
        VALUES (?, ?, 'superseded', 1, ?, ?, ?)`).run(
        artifactId,
        revision,
        reason ?? null,
        idempotencyKey,
        at,
      );
      this.inject("after-status-row");
      this.insertOperation(idempotencyKey, "supersede", artifact, at, reason, actor);
      this.insertAudit({ artifact, action: "superseded", actor, at, idempotencyKey, reason });
      this.inject("after-audit-row");
      return this.requireEntry(artifactId, revision);
    });
  }

  recordEvidenceAttestation(
    input: RecordArtifactAssessmentInput<ArtifactEvidenceAttestation>,
  ): ArtifactAssessmentEntry {
    this.ensureOpen();
    const assessment = parseEvidenceForRegistry(input?.assessment);
    return this.recordAssessment("evidence-attestation", assessment, input?.idempotencyKey, input?.actor);
  }

  recordRiskAssessment(
    input: RecordArtifactAssessmentInput<ArtifactRiskAssessment>,
  ): ArtifactAssessmentEntry {
    this.ensureOpen();
    const assessment = parseRiskForRegistry(input?.assessment);
    return this.recordAssessment("risk-assessment", assessment, input?.idempotencyKey, input?.actor);
  }

  recordAuthorityAssessment(
    input: RecordArtifactAssessmentInput<ArtifactAuthorityAssessment>,
  ): ArtifactAssessmentEntry {
    this.ensureOpen();
    const assessment = parseAuthorityForRegistry(input?.assessment);
    return this.recordAssessment("authority-assessment", assessment, input?.idempotencyKey, input?.actor);
  }

  listAttestations(query: ArtifactAssessmentListQuery = {}): readonly ArtifactAssessmentEntry[] {
    this.ensureOpen();
    const normalized = normalizeAssessmentQuery(query);
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    if (normalized.kind !== undefined) {
      clauses.push("kind = ?");
      values.push(normalized.kind);
    }
    if (normalized.artifact !== undefined) {
      clauses.push("artifact_id = ?", "revision = ?", "content_hash = ?");
      values.push(
        normalized.artifact.artifactId,
        normalized.artifact.revision,
        normalized.artifact.contentHash,
      );
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const rows = this.db.prepare(`SELECT sequence, kind, artifact_id, revision, content_hash,
        input_identity, record_id, payload_json, recorded_at
      FROM artifact_assessments ${where} ORDER BY sequence DESC LIMIT ?`).all(...values, normalized.limit) as SqlRow[];
    return rows.map((row) => this.assessmentEntryFromRow(row));
  }

  latestAttestation(query: ArtifactAssessmentLookup): ArtifactAssessmentEntry | undefined {
    this.ensureOpen();
    const normalized = normalizeAssessmentQuery(query, true);
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    if (normalized.kind !== undefined) {
      clauses.push("kind = ?");
      values.push(normalized.kind);
    }
    if (normalized.artifact !== undefined) {
      clauses.push("artifact_id = ?", "revision = ?", "content_hash = ?");
      values.push(
        normalized.artifact.artifactId,
        normalized.artifact.revision,
        normalized.artifact.contentHash,
      );
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const row = this.db.prepare(`SELECT sequence, kind, artifact_id, revision, content_hash,
        input_identity, record_id, payload_json, recorded_at
      FROM artifact_assessments ${where} ORDER BY sequence DESC LIMIT 1`).get(...values) as SqlRow | undefined;
    return row === undefined ? undefined : this.assessmentEntryFromRow(row);
  }

  getRevision(artifactId: string, revision: number): ArtifactRegistryEntry | undefined {
    this.ensureOpen();
    const id = validateArtifactId(artifactId);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new ArtifactRegistryError("invalid_input", "Artifact revision is invalid");
    }
    const row = this.findRevisionRow(id, revision);
    return row === undefined ? undefined : this.entryFromRow(row);
  }

  list(query: ArtifactRegistryListQuery = {}): readonly ArtifactRegistryEntry[] {
    this.ensureOpen();
    const artifactId = query.artifactId === undefined
      ? undefined
      : validateArtifactId(query.artifactId);
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new ArtifactRegistryError("invalid_input", "Artifact list limit is out of bounds");
    }
    const rows = artifactId === undefined
      ? this.db.prepare(`SELECT artifact_id, revision, content_hash, artifact_json, created_at
          FROM artifact_revisions ORDER BY artifact_id, revision LIMIT ?`).all(limit) as SqlRow[]
      : this.db.prepare(`SELECT artifact_id, revision, content_hash, artifact_json, created_at
          FROM artifact_revisions WHERE artifact_id = ? ORDER BY revision LIMIT ?`).all(artifactId, limit) as SqlRow[];
    return rows.map((row) => this.entryFromRow(row));
  }

  audit(query: ArtifactRegistryAuditQuery = {}): readonly ArtifactRegistryAudit[] {
    this.ensureOpen();
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new ArtifactRegistryError("invalid_input", "Artifact audit limit is out of bounds");
    }
    const rows = this.db.prepare(`SELECT audit_id, artifact_id, revision, action, actor,
        idempotency_key, reason, record_kind, record_id, created_at
      FROM artifact_audit ORDER BY sequence LIMIT ?`).all(limit) as SqlRow[];
    return rows.map(toAudit);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private writeTransaction<T>(operation: () => T): T {
    this.ensureOpen();
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch {
      throw new ArtifactRegistryError("write_failed", "Artifact registry write could not begin");
    }
    try {
      const result = operation();
      this.db.exec("COMMIT");
      this.ensurePrivateFiles();
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original bounded registry failure.
      }
      this.ensurePrivateFiles();
      if (error instanceof ArtifactRegistryError) throw error;
      throw new ArtifactRegistryError("write_failed", "Artifact registry write failed");
    }
  }

  private recordAssessment(
    kind: ArtifactAssessmentKind,
    assessment: ArtifactAssessment,
    rawIdempotencyKey: unknown,
    rawActor: unknown,
  ): ArtifactAssessmentEntry {
    const idempotencyKey = validateBoundedText(rawIdempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH, "idempotency key");
    const actor = validateBoundedText(rawActor ?? "hub", MAX_ACTOR_LENGTH, "actor");
    const artifact = assessment.artifact;
    const recordId = assessmentRecordId(assessment);
    const payloadJson = canonicalAssessmentInput(assessment);
    const payloadHash = hashAssessmentPayload(payloadJson);
    const inputIdentity = assessment.inputIdentity;

    return this.writeTransaction(() => {
      const replay = this.findOperation(idempotencyKey);
      if (replay !== undefined) {
        this.assertAssessmentOperationMatches(replay, artifact, kind, inputIdentity, payloadHash, actor);
        if (replay.recordId === undefined) {
          throw new ArtifactRegistryError("corrupt_record", "Assessment idempotency row has no record id");
        }
        const replayRow = this.findAssessmentByRecordId(replay.recordId);
        if (replayRow === undefined) {
          throw new ArtifactRegistryError("corrupt_record", "Assessment idempotency row has no assessment");
        }
        const current = this.requireEntry(artifact.artifactId, artifact.revision);
        assertArtifactRefMatches(current.artifact, artifact);
        const replayEntry = this.assessmentEntryFromRow(replayRow);
        if (replayEntry.recordId !== replay.recordId
          || replayEntry.kind !== kind
          || replayEntry.inputIdentity !== inputIdentity
          || replayEntry.artifact.artifactId !== artifact.artifactId
          || replayEntry.artifact.revision !== artifact.revision
          || replayEntry.artifact.contentHash !== artifact.contentHash
          || replayEntry.audit[0]?.actor !== actor
          || (replayEntry.recordId === recordId
            && hashAssessmentPayload(canonicalAssessmentInput(replayEntry.assessment)) !== replay.payloadHash)) {
          throw new ArtifactRegistryError("corrupt_record", "Assessment idempotency row points to inconsistent assessment");
        }
        return replayEntry;
      }

      const current = this.requireEntry(artifact.artifactId, artifact.revision);
      assertArtifactRefMatches(current.artifact, artifact);

      const byRecordId = this.findAssessmentByRecordId(recordId);
      if (byRecordId !== undefined) {
        const existing = this.assessmentEntryFromRow(byRecordId);
        assertAssessmentSemanticMatch(existing, kind, artifact, inputIdentity, payloadJson, actor);
        this.insertAssessmentOperation({
          idempotencyKey,
          artifact,
          kind,
          recordId: existing.recordId,
          inputIdentity,
          payloadHash,
          actor,
          at: this.now(),
        });
        return existing;
      }

      const byIdentity = this.findAssessmentByIdentity(kind, artifact, inputIdentity);
      if (byIdentity !== undefined) {
        const existing = this.assessmentEntryFromRow(byIdentity);
        assertAssessmentSemanticMatch(existing, kind, artifact, inputIdentity, undefined, actor);
        this.insertAssessmentOperation({
          idempotencyKey,
          artifact,
          kind,
          recordId: existing.recordId,
          inputIdentity,
          payloadHash,
          actor,
          at: this.now(),
        });
        return existing;
      }

      if (current.status === "superseded") {
        throw new ArtifactRegistryError("revision_conflict", "Superseded artifact revisions cannot receive assessments");
      }
      if (kind === "risk-assessment") {
        if (assessment.kind !== "risk-assessment") {
          throw new ArtifactRegistryError("corrupt_record", "Risk assessment kind does not match its payload");
        }
        this.assertRiskDependencies(assessment);
      }

      const recordedAt = this.now();
      this.db.prepare(`INSERT INTO artifact_assessments
        (kind, artifact_id, revision, content_hash, input_identity, record_id, payload_json, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        kind,
        artifact.artifactId,
        artifact.revision,
        artifact.contentHash,
        inputIdentity,
        recordId,
        payloadJson,
        recordedAt,
      );
      this.inject("after-assessment-row");
      this.insertAssessmentOperation({
        idempotencyKey,
        artifact,
        kind,
        recordId,
        inputIdentity,
        payloadHash,
        actor,
        at: recordedAt,
      });
      this.insertAudit({
        artifact: current.artifact,
        action: "assessment_recorded",
        actor,
        at: recordedAt,
        idempotencyKey,
        kind,
        recordId,
      });
      this.inject("after-audit-row");
      const inserted = this.findAssessmentByRecordId(recordId);
      if (inserted === undefined) {
        throw new ArtifactRegistryError("corrupt_record", "Assessment row disappeared during write");
      }
      return this.assessmentEntryFromRow(inserted);
    });
  }

  private insertRevision(artifact: ArtifactRevision): void {
    this.db.prepare(`INSERT INTO artifact_revisions
      (artifact_id, revision, content_hash, artifact_json, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(
      artifact.artifactId,
      artifact.revision,
      artifact.contentHash,
      JSON.stringify(artifact),
      artifact.createdAt,
    );
  }

  private insertOperation(
    idempotencyKey: string,
    operation: "create" | "append" | "supersede",
    artifact: ArtifactRevision,
    at: string,
    reason: string | undefined,
    actor: string,
  ): void {
    this.db.prepare(`INSERT INTO artifact_operations
      (idempotency_key, operation, artifact_id, revision, content_hash, actor, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      idempotencyKey,
      operation,
      artifact.artifactId,
      artifact.revision,
      artifact.contentHash,
      actor,
      reason ?? null,
      at,
    );
  }

  private insertAssessmentOperation(input: {
    readonly idempotencyKey: string;
    readonly artifact: ArtifactRef;
    readonly kind: ArtifactAssessmentKind;
    readonly recordId: string;
    readonly inputIdentity: string;
    readonly payloadHash: string;
    readonly actor: string;
    readonly at: string;
  }): void {
    this.db.prepare(`INSERT INTO artifact_operations
      (idempotency_key, operation, artifact_id, revision, content_hash, actor,
        record_kind, record_id, input_identity, payload_hash, created_at)
      VALUES (?, 'assessment', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.idempotencyKey,
      input.artifact.artifactId,
      input.artifact.revision,
      input.artifact.contentHash,
      input.actor,
      input.kind,
      input.recordId,
      input.inputIdentity,
      input.payloadHash,
      input.at,
    );
  }

  private insertAudit(input: {
    readonly artifact: ArtifactRevision;
    readonly action: ArtifactRegistryAuditAction;
    readonly actor: string;
    readonly at: string;
    readonly idempotencyKey: string;
    readonly reason?: string;
    readonly kind?: ArtifactAssessmentKind;
    readonly recordId?: string;
  }): void {
    this.db.prepare(`INSERT INTO artifact_audit
      (audit_id, artifact_id, revision, action, actor, idempotency_key, reason, record_kind, record_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      this.id(),
      input.artifact.artifactId,
      input.artifact.revision,
      input.action,
      input.actor,
      input.idempotencyKey,
      input.reason ?? null,
      input.kind ?? null,
      input.recordId ?? null,
      input.at,
    );
  }

  private findOperation(idempotencyKey: string): OperationRow | undefined {
    const row = this.db.prepare(`SELECT idempotency_key, operation, artifact_id, revision,
        content_hash, actor, reason, record_kind, record_id, input_identity, payload_hash, created_at
      FROM artifact_operations WHERE idempotency_key = ?`).get(idempotencyKey) as SqlRow | undefined;
    if (row === undefined) return undefined;
    return {
      idempotencyKey: textColumn(row, "idempotency_key"),
      operation: textColumn(row, "operation"),
      artifactId: textColumn(row, "artifact_id"),
      revision: integerColumn(row, "revision"),
      contentHash: nullableTextColumn(row, "content_hash"),
      actor: nullableTextColumn(row, "actor"),
      reason: nullableTextColumn(row, "reason"),
      recordKind: nullableTextColumn(row, "record_kind"),
      recordId: nullableTextColumn(row, "record_id"),
      inputIdentity: nullableTextColumn(row, "input_identity"),
      payloadHash: nullableTextColumn(row, "payload_hash"),
      createdAt: textColumn(row, "created_at"),
    };
  }

  private assertOperationMatches(
    operation: OperationRow,
    expectedOperation: OperationRow["operation"],
    artifact: ArtifactRevision,
    expectedPreviousRevision: number | undefined,
    expectedReason: string | undefined,
    expectedActor: string,
  ): void {
    const expectedRevision = expectedPreviousRevision === undefined
      ? artifact.revision
      : expectedPreviousRevision + 1;
    if (operation.operation !== expectedOperation
      || operation.artifactId !== artifact.artifactId
      || operation.revision !== expectedRevision
      || operation.contentHash !== artifact.contentHash
      || operation.reason !== expectedReason
      || operation.actor !== expectedActor) {
      throw new ArtifactRegistryError("revision_conflict", "Idempotency key conflicts with another artifact write");
    }
  }

  private assertSupersedeOperationMatches(
    operation: OperationRow,
    artifactId: string,
    revision: number,
    expectedReason: string | undefined,
    expectedActor: string,
  ): void {
    if (operation.operation !== "supersede"
      || operation.artifactId !== artifactId
      || operation.revision !== revision
      || operation.reason !== expectedReason
      || operation.actor !== expectedActor) {
      throw new ArtifactRegistryError("revision_conflict", "Idempotency key conflicts with another artifact write");
    }
  }

  private assertAssessmentOperationMatches(
    operation: OperationRow,
    artifact: ArtifactRef,
    kind: ArtifactAssessmentKind,
    inputIdentity: string,
    payloadHash: string,
    actor: string,
  ): void {
    if (operation.operation !== "assessment"
      || operation.artifactId !== artifact.artifactId
      || operation.revision !== artifact.revision
      || operation.contentHash !== artifact.contentHash
      || operation.recordKind !== kind
      || operation.inputIdentity !== inputIdentity
      || operation.payloadHash !== payloadHash
      || operation.actor !== actor) {
      throw new ArtifactRegistryError("revision_conflict", "Idempotency key conflicts with another assessment write");
    }
  }

  private latestRevision(artifactId: string): number | undefined {
    const row = this.db.prepare("SELECT MAX(revision) AS revision FROM artifact_revisions WHERE artifact_id = ?").get(artifactId) as SqlRow;
    if (row.revision === null || row.revision === undefined) return undefined;
    return integerColumn(row, "revision");
  }

  private findRevisionRow(artifactId: string, revision: number): SqlRow | undefined {
    return this.db.prepare(`SELECT artifact_id, revision, content_hash, artifact_json, created_at
      FROM artifact_revisions WHERE artifact_id = ? AND revision = ?`).get(artifactId, revision) as SqlRow | undefined;
  }

  private findAssessmentByRecordId(recordId: string): SqlRow | undefined {
    return this.db.prepare(`SELECT sequence, kind, artifact_id, revision, content_hash,
        input_identity, record_id, payload_json, recorded_at
      FROM artifact_assessments WHERE record_id = ?`).get(recordId) as SqlRow | undefined;
  }

  private findAssessmentByIdentity(
    kind: ArtifactAssessmentKind,
    artifact: ArtifactRef,
    inputIdentity: string,
  ): SqlRow | undefined {
    return this.db.prepare(`SELECT sequence, kind, artifact_id, revision, content_hash,
        input_identity, record_id, payload_json, recorded_at
      FROM artifact_assessments
      WHERE kind = ? AND artifact_id = ? AND revision = ? AND content_hash = ? AND input_identity = ?`).get(
      kind,
      artifact.artifactId,
      artifact.revision,
      artifact.contentHash,
      inputIdentity,
    ) as SqlRow | undefined;
  }

  private requireEntry(artifactId: string, revision: number): ArtifactRegistryEntry {
    const row = this.findRevisionRow(artifactId, revision);
    if (row === undefined) throw new ArtifactRegistryError("not_found", "Artifact revision was not found");
    return this.entryFromRow(row);
  }

  private entryFromRow(row: SqlRow): ArtifactRegistryEntry {
    const artifact = artifactFromRow(row);
    const status = this.readStatus(artifact.artifactId, artifact.revision);
    const audit = this.db.prepare(`SELECT audit_id, artifact_id, revision, action, actor,
        idempotency_key, reason, record_kind, record_id, created_at
      FROM artifact_audit
      WHERE artifact_id = ? AND revision = ?
        AND action IN ('created', 'revision_appended', 'superseded')
      ORDER BY sequence`).all(
      artifact.artifactId,
      artifact.revision,
    ) as SqlRow[];
    return {
      artifact,
      status: status.status,
      tombstone: status.tombstone,
      audit: audit.map(toAudit),
    };
  }

  private assessmentEntryFromRow(row: SqlRow): ArtifactAssessmentEntry {
    const assessment = assessmentFromRow(row);
    const artifact = assessment.artifact;
    const storedArtifact = this.requireEntry(artifact.artifactId, artifact.revision).artifact;
    assertArtifactRefMatches(storedArtifact, artifact);
    if (assessment.kind === "risk-assessment") {
      this.assertRiskDependencies(assessment);
    }
    const recordId = textColumn(row, "record_id");
    if (recordId !== assessmentRecordId(assessment)
      || textColumn(row, "kind") !== assessment.kind
      || textColumn(row, "artifact_id") !== artifact.artifactId
      || integerColumn(row, "revision") !== artifact.revision
      || textColumn(row, "content_hash") !== artifact.contentHash
      || textColumn(row, "input_identity") !== assessment.inputIdentity) {
      throw new ArtifactRegistryError("corrupt_record", "Assessment row identity mismatch");
    }
    const audit = this.db.prepare(`SELECT audit_id, artifact_id, revision, action, actor,
        idempotency_key, reason, record_kind, record_id, created_at
      FROM artifact_audit
      WHERE artifact_id = ? AND revision = ? AND action = 'assessment_recorded'
        AND record_kind = ? AND record_id = ?
      ORDER BY sequence DESC LIMIT 1`).all(
      artifact.artifactId,
      artifact.revision,
      assessment.kind,
      recordId,
    ) as SqlRow[];
    if (audit.length !== 1) {
      throw new ArtifactRegistryError("corrupt_record", "Assessment audit row is missing");
    }
    return {
      kind: assessment.kind,
      recordId,
      artifact,
      inputIdentity: assessment.inputIdentity,
      recordedAt: textColumn(row, "recorded_at"),
      assessment,
      audit: audit.map(toAudit),
    };
  }

  private assertRiskDependencies(assessment: ArtifactRiskAssessment): void {
    this.assertAssessmentDependency(
      "evidence-attestation",
      assessment.evidence.attestationId,
      assessment.artifact,
      assessment.evidence.inputIdentity,
    );
    this.assertAssessmentDependency(
      "authority-assessment",
      assessment.authority.assessmentId,
      assessment.artifact,
      assessment.authority.inputIdentity,
    );
  }

  private assertAssessmentDependency(
    kind: "evidence-attestation" | "authority-assessment",
    recordId: string,
    artifact: ArtifactRef,
    inputIdentity: string,
  ): void {
    const row = this.findAssessmentByRecordId(recordId);
    if (row === undefined) {
      throw new ArtifactRegistryError("not_found", "Risk assessment dependency was not found");
    }
    if (textColumn(row, "kind") !== kind) {
      throw new ArtifactRegistryError("revision_conflict", "Risk assessment dependency kind does not match");
    }
    const dependency = this.assessmentEntryFromRow(row);
    if (dependency.artifact.artifactId !== artifact.artifactId
      || dependency.artifact.revision !== artifact.revision
      || dependency.artifact.contentHash !== artifact.contentHash) {
      throw new ArtifactRegistryError("revision_conflict", "Risk assessment dependency artifact does not match");
    }
    if (dependency.inputIdentity !== inputIdentity) {
      throw new ArtifactRegistryError("revision_conflict", "Risk assessment dependency identity does not match");
    }
  }

  private readStatus(artifactId: string, revision: number): { status: ArtifactRegistryStatus; tombstone: boolean } {
    const row = this.db.prepare(`SELECT status, tombstone FROM artifact_status_events
      WHERE artifact_id = ? AND revision = ? ORDER BY sequence DESC LIMIT 1`).get(artifactId, revision) as SqlRow | undefined;
    if (row === undefined) return { status: "draft", tombstone: false };
    const status = textColumn(row, "status");
    if (status !== "superseded") throw new ArtifactRegistryError("corrupt_record", "Artifact lifecycle state is invalid");
    const tombstone = integerColumn(row, "tombstone");
    if (tombstone !== 1) throw new ArtifactRegistryError("corrupt_record", "Artifact tombstone state is invalid");
    return { status, tombstone: true };
  }

  private inject(point: ArtifactRegistryFaultPoint): void {
    this.fault?.(point);
  }

  private ensurePrivateFiles(): void {
    ensurePrivateSqliteFiles(this.path);
  }

  private ensureOperationColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(artifact_operations)").all() as SqlRow[];
    const additions = [
      ["actor", "TEXT"],
      ["reason", "TEXT"],
      ["record_kind", "TEXT"],
      ["record_id", "TEXT"],
      ["input_identity", "TEXT"],
      ["payload_hash", "TEXT"],
    ] as const;
    for (const [name, type] of additions) {
      if (!columns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE artifact_operations ADD COLUMN ${name} ${type}`);
      }
    }
  }

  private ensureAuditColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(artifact_audit)").all() as SqlRow[];
    for (const name of ["record_kind", "record_id"] as const) {
      if (!columns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE artifact_audit ADD COLUMN ${name} TEXT`);
      }
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new ArtifactRegistryError("closed", "Artifact registry is closed");
  }
}

interface OperationRow {
  readonly idempotencyKey: string;
  readonly operation: "create" | "append" | "supersede" | string;
  readonly artifactId: string;
  readonly revision: number;
  readonly contentHash: string | undefined;
  readonly actor: string | undefined;
  readonly reason: string | undefined;
  readonly recordKind: string | undefined;
  readonly recordId: string | undefined;
  readonly inputIdentity: string | undefined;
  readonly payloadHash: string | undefined;
  readonly createdAt: string;
}

function parseEvidenceForRegistry(input: unknown): ArtifactEvidenceAttestation {
  try {
    return parseArtifactEvidenceAttestation(input);
  } catch {
    throw new ArtifactRegistryError("invalid_assessment", "Evidence assessment failed validation");
  }
}

function parseRiskForRegistry(input: unknown): ArtifactRiskAssessment {
  try {
    return parseArtifactRiskAssessment(input);
  } catch {
    throw new ArtifactRegistryError("invalid_assessment", "Risk assessment failed validation");
  }
}

function parseAuthorityForRegistry(input: unknown): ArtifactAuthorityAssessment {
  try {
    return parseArtifactAuthorityAssessment(input);
  } catch {
    throw new ArtifactRegistryError("invalid_assessment", "Authority assessment failed validation");
  }
}

function assessmentRecordId(assessment: ArtifactAssessment): string {
  if (assessment.kind === "evidence-attestation") return assessment.attestationId;
  return assessment.assessmentId;
}

function hashAssessmentPayload(payload: string): string {
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

function isAssessmentKind(value: string): value is ArtifactAssessmentKind {
  return value === "evidence-attestation"
    || value === "risk-assessment"
    || value === "authority-assessment";
}

function normalizeAssessmentQuery(query: ArtifactAssessmentListQuery, requireExact = false): {
  readonly kind: ArtifactAssessmentKind | undefined;
  readonly artifact: ArtifactRef | undefined;
  readonly limit: number;
} {
  if (!query || typeof query !== "object") {
    throw new ArtifactRegistryError("invalid_input", "Assessment query is invalid");
  }
  const kind = query.kind;
  if (kind !== undefined && !isAssessmentKind(kind)) {
    throw new ArtifactRegistryError("invalid_input", "Assessment kind is invalid");
  }
  if (requireExact && kind === undefined) {
    throw new ArtifactRegistryError("invalid_input", "Latest assessment kind is required");
  }
  let artifact: ArtifactRef | undefined;
  if (query.artifact !== undefined) {
    const parsed = artifactRefSchema.safeParse(query.artifact);
    if (!parsed.success) throw new ArtifactRegistryError("invalid_input", "Assessment artifact ref is invalid");
    artifact = parsed.data;
  }
  if (requireExact && artifact === undefined) {
    throw new ArtifactRegistryError("invalid_input", "Latest assessment artifact ref is required");
  }
  const limit = query.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ArtifactRegistryError("invalid_input", "Assessment list limit is out of bounds");
  }
  return { kind, artifact, limit };
}

function assertArtifactRefMatches(artifact: ArtifactRevision, ref: ArtifactRef): void {
  if (artifact.artifactId !== ref.artifactId
    || artifact.revision !== ref.revision
    || artifact.contentHash !== ref.contentHash) {
    throw new ArtifactRegistryError("revision_conflict", "Assessment artifact ref does not match the stored revision");
  }
}

function assertAssessmentSemanticMatch(
  existing: ArtifactAssessmentEntry,
  kind: ArtifactAssessmentKind,
  artifact: ArtifactRef,
  inputIdentity: string,
  payloadJson: string | undefined,
  actor: string,
): void {
  if (existing.kind !== kind
    || existing.artifact.artifactId !== artifact.artifactId
    || existing.artifact.revision !== artifact.revision
    || existing.artifact.contentHash !== artifact.contentHash
    || existing.inputIdentity !== inputIdentity
    || (payloadJson !== undefined && canonicalAssessmentInput(existing.assessment) !== payloadJson)
    || existing.audit[0]?.actor !== actor) {
    throw new ArtifactRegistryError("revision_conflict", "Assessment identity conflicts with an existing row");
  }
}

function assessmentFromRow(row: SqlRow): ArtifactAssessment {
  try {
    const kind = textColumn(row, "kind");
    if (!isAssessmentKind(kind)) throw new Error("assessment kind is invalid");
    const payloadJson = textColumn(row, "payload_json");
    let raw: unknown;
    try {
      raw = JSON.parse(payloadJson) as unknown;
    } catch {
      throw new Error("assessment payload JSON is invalid");
    }
    if (canonicalAssessmentInput(raw) !== payloadJson) {
      throw new Error("assessment payload is not canonical");
    }
    if (kind === "evidence-attestation") return parseArtifactEvidenceAttestation(raw);
    if (kind === "risk-assessment") return parseArtifactRiskAssessment(raw);
    return parseArtifactAuthorityAssessment(raw);
  } catch {
    throw new ArtifactRegistryError("corrupt_record", "Artifact assessment row failed validation");
  }
}

function validateArtifact(value: unknown): ArtifactRevision {
  try {
    const parsed = parseArtifactRevision(value);
    const verified = verifyArtifactRevision(parsed);
    if (verified === false) throw new Error("artifact verification failed");
    return parsed;
  } catch {
    throw new ArtifactRegistryError("invalid_artifact", "Artifact revision failed validation");
  }
}

function artifactFromRow(row: SqlRow): ArtifactRevision {
  try {
    const artifactJson = textColumn(row, "artifact_json");
    const artifact = parseArtifactJson(artifactJson);
    const verified = verifyArtifactRevision(artifact);
    if (verified === false) throw new Error("artifact verification failed");
    if (artifact.artifactId !== textColumn(row, "artifact_id")
      || artifact.revision !== integerColumn(row, "revision")
      || artifact.contentHash !== textColumn(row, "content_hash")
      || artifact.createdAt !== textColumn(row, "created_at")) {
      throw new Error("artifact row identity mismatch");
    }
    return artifact;
  } catch {
    throw new ArtifactRegistryError("corrupt_record", "Artifact registry row failed validation");
  }
}

function toAudit(row: SqlRow): ArtifactRegistryAudit {
  const action = textColumn(row, "action");
  if (action !== "created" && action !== "revision_appended" && action !== "superseded" && action !== "assessment_recorded") {
    throw new ArtifactRegistryError("corrupt_record", "Artifact audit action is invalid");
  }
  const reason = nullableTextColumn(row, "reason");
  const kind = nullableTextColumn(row, "record_kind");
  if (kind !== undefined && !isAssessmentKind(kind)) {
    throw new ArtifactRegistryError("corrupt_record", "Artifact audit assessment kind is invalid");
  }
  const recordId = nullableTextColumn(row, "record_id");
  if (action === "assessment_recorded" && (kind === undefined || recordId === undefined)) {
    throw new ArtifactRegistryError("corrupt_record", "Assessment audit metadata is incomplete");
  }
  if (action !== "assessment_recorded" && (kind !== undefined || recordId !== undefined)) {
    throw new ArtifactRegistryError("corrupt_record", "Lifecycle audit contains assessment metadata");
  }
  return {
    id: textColumn(row, "audit_id"),
    artifactId: textColumn(row, "artifact_id"),
    revision: integerColumn(row, "revision"),
    action,
    actor: textColumn(row, "actor"),
    at: textColumn(row, "created_at"),
    idempotencyKey: textColumn(row, "idempotency_key"),
    ...(reason === undefined ? {} : { reason }),
    ...(kind === undefined ? {} : { kind }),
    ...(recordId === undefined ? {} : { recordId }),
  };
}

function validateBoundedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string"
    || value.trim() === ""
    || value.trim() !== value
    || Buffer.byteLength(value, "utf8") > maximum) {
    throw new ArtifactRegistryError("invalid_input", `${label} is invalid`);
  }
  return value;
}

function validateArtifactId(value: unknown): string {
  const parsed = artifactRefSchema.safeParse({
    artifactId: value,
    revision: 1,
    contentHash: `sha256:${"0".repeat(64)}`,
  });
  if (!parsed.success) throw new ArtifactRegistryError("invalid_input", "artifact id is invalid");
  return parsed.data.artifactId;
}

function textColumn(row: SqlRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ArtifactRegistryError("corrupt_record", "Artifact registry text column is invalid");
  }
  return value;
}

function nullableTextColumn(row: SqlRow, name: string): string | undefined {
  const value = row[name];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new ArtifactRegistryError("corrupt_record", "Artifact registry nullable text is invalid");
  return value;
}

function integerColumn(row: SqlRow, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ArtifactRegistryError("corrupt_record", "Artifact registry integer column is invalid");
  }
  return value;
}

function isMemoryPath(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}
