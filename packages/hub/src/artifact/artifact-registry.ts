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
  MAX_COMPILER_CANONICAL_BYTES,
  parseArtifactCompileAttestation,
  parseArtifactCompileAttestationJson,
  parseNeutralDryRunAttestation,
  parseNeutralDryRunAttestationJson,
  type ArtifactCompileAttestation,
  type NeutralDryRunAttestation,
} from "./artifact-compiler-contract.js";
import {
  artifactRefSchema,
  parseArtifactJson,
  parseArtifactRevision,
  verifyArtifactRevision,
  type ArtifactRevision,
} from "./neutral-artifact.js";
import { ensurePrivateSqliteFiles } from "../sqlite-private-files.js";

export type ArtifactRegistryStatus = "draft" | "superseded";
export type ArtifactRegistryAuditAction =
  | "created"
  | "revision_appended"
  | "superseded"
  | "assessment_recorded"
  | "compile_recorded"
  | "dry_run_recorded";

export type ArtifactRegistryFaultPoint =
  | "after-artifact-row"
  | "after-status-row"
  | "after-audit-row"
  | "after-assessment-row"
  | "after-result-row";

export type ArtifactAssessmentKind =
  | "evidence-attestation"
  | "risk-assessment"
  | "authority-assessment";

export type ArtifactCompilerResultKind = "compile-attestation" | "dry-run-attestation";

export type ArtifactCompilerResult = ArtifactCompileAttestation | NeutralDryRunAttestation;

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
  readonly kind?: ArtifactAssessmentKind | ArtifactCompilerResultKind;
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

export interface ArtifactRegistrySourceProposalLookup {
  readonly proposalId: string;
  readonly proposalRevision: number;
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

export interface ArtifactAssessmentIdentityLookup {
  readonly kind: ArtifactAssessmentKind;
  readonly artifact: ArtifactRef;
  readonly inputIdentity: string;
}

export interface ArtifactCompilerResultEntry {
  readonly kind: ArtifactCompilerResultKind;
  /** Alias retained for parity with assessment registry entries. */
  readonly recordId: string;
  readonly resultId: string;
  readonly artifact: ArtifactRef;
  readonly inputIdentity: string;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly result: ArtifactCompilerResult;
  readonly audit: readonly ArtifactRegistryAudit[];
}

export interface RecordArtifactCompilerResultInput<T extends ArtifactCompilerResult> {
  /** Preferred property. `attestation` is accepted as a compatibility alias. */
  readonly result?: T;
  readonly attestation?: T;
  readonly idempotencyKey: string;
  readonly actor?: string;
}

export type RecordArtifactCompileInput = RecordArtifactCompilerResultInput<ArtifactCompileAttestation>;
export type RecordArtifactDryRunInput = RecordArtifactCompilerResultInput<NeutralDryRunAttestation>;

export interface ArtifactCompilerResultListQuery {
  readonly kind?: ArtifactCompilerResultKind;
  readonly artifact: ArtifactRef;
  readonly limit?: number;
}

export interface ArtifactCompilerResultLookup {
  readonly kind: ArtifactCompilerResultKind;
  readonly artifact: ArtifactRef;
}

export interface ArtifactCompilerResultIdentityLookup extends ArtifactCompilerResultLookup {
  readonly inputIdentity: string;
}

export interface ArtifactCompilerResultIdLookup extends ArtifactCompilerResultLookup {
  readonly resultId: string;
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
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
export const ARTIFACT_REGISTRY_SCHEMA_VERSION = 1;

/**
 * The Artifact Registry owns immutable neutral artifact rows, M3b assessments,
 * and M3c compiler results. It intentionally has no bridge, credential, or
 * action surface.
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
      this.initializeSchema();
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

  private initializeSchema(): void {
    const version = this.readUserVersion();
    if (version > ARTIFACT_REGISTRY_SCHEMA_VERSION || version < 0) {
      throw new Error("Artifact registry schema version is unsupported");
    }

    const tables = this.schemaTableNames();
    if (version === 0 && tables.length === 0) {
      this.runSchemaTransaction(() => {
        this.createBaseSchema();
        this.db.exec(`PRAGMA user_version = ${ARTIFACT_REGISTRY_SCHEMA_VERSION}`);
      });
      return;
    }

    if (version === 0) {
      this.assertM3bSchema();
      if (tables.includes("artifact_compiler_results")) {
        throw new Error("Legacy registry unexpectedly contains compiler result table");
      }
      this.runSchemaTransaction(() => {
        this.createCompilerResultTable();
        this.db.exec(`PRAGMA user_version = ${ARTIFACT_REGISTRY_SCHEMA_VERSION}`);
      });
      return;
    }

    if (version !== ARTIFACT_REGISTRY_SCHEMA_VERSION) {
      throw new Error("Artifact registry schema version is unsupported");
    }
    this.assertCurrentSchema();
  }

  private readUserVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as SqlRow;
    const value = row.user_version;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new Error("Artifact registry user_version is invalid");
    }
    return value;
  }

  private schemaTableNames(): string[] {
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as SqlRow[];
    return rows.map((row) => {
      const name = row.name;
      if (typeof name !== "string" || name.length === 0) throw new Error("Artifact registry table name is invalid");
      return name;
    });
  }

  private runSchemaTransaction(operation: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the bounded schema failure.
      }
      throw error;
    }
  }

  private createBaseSchema(): void {
    this.db.exec(`
      CREATE TABLE artifact_revisions (
        artifact_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        artifact_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (artifact_id, revision)
      ) STRICT;
      CREATE TABLE artifact_operations (
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
      CREATE TABLE artifact_status_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        artifact_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        tombstone INTEGER NOT NULL,
        reason TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE artifact_audit (
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
      CREATE TABLE artifact_assessments (
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
    `);
    this.createCompilerResultTable();
    this.createIndexes();
  }

  private createCompilerResultTable(): void {
    this.db.exec(`
      CREATE TABLE artifact_compiler_results (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('compile-attestation', 'dry-run-attestation')),
        artifact_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        input_identity TEXT NOT NULL,
        result_id TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE (kind, artifact_id, revision, content_hash, input_identity)
      ) STRICT;
    `);
    this.db.exec(`
      CREATE INDEX artifact_compiler_results_by_ref
        ON artifact_compiler_results (kind, artifact_id, revision, content_hash, sequence);
      CREATE INDEX artifact_compiler_results_by_input
        ON artifact_compiler_results (kind, artifact_id, revision, content_hash, input_identity);
      CREATE INDEX artifact_compiler_results_by_result
        ON artifact_compiler_results (result_id);
    `);
  }

  private createIndexes(): void {
    this.db.exec(`
      CREATE INDEX artifact_revisions_by_id
        ON artifact_revisions (artifact_id, revision);
      CREATE INDEX artifact_audit_by_ref
        ON artifact_audit (artifact_id, revision, sequence);
      CREATE INDEX artifact_assessments_by_ref
        ON artifact_assessments (kind, artifact_id, revision, content_hash, sequence);
    `);
  }

  private assertM3bSchema(): void {
    const required: Readonly<Record<string, readonly string[]>> = {
      artifact_revisions: ["artifact_id", "revision", "content_hash", "artifact_json", "created_at"],
      artifact_operations: ["idempotency_key", "operation", "artifact_id", "revision", "content_hash", "actor", "reason", "record_kind", "record_id", "input_identity", "payload_hash", "created_at"],
      artifact_status_events: ["sequence", "artifact_id", "revision", "status", "tombstone", "reason", "idempotency_key", "created_at"],
      artifact_audit: ["sequence", "audit_id", "artifact_id", "revision", "action", "actor", "idempotency_key", "reason", "record_kind", "record_id", "created_at"],
      artifact_assessments: ["sequence", "kind", "artifact_id", "revision", "content_hash", "input_identity", "record_id", "payload_json", "recorded_at"],
    };
    for (const [table, columns] of Object.entries(required)) this.assertStrictTable(table, columns);
  }

  private assertCurrentSchema(): void {
    this.assertM3bSchema();
    this.assertStrictTable("artifact_compiler_results", [
      "sequence",
      "kind",
      "artifact_id",
      "revision",
      "content_hash",
      "input_identity",
      "result_id",
      "payload_json",
      "recorded_at",
    ], [
      { type: "INTEGER", notnull: 0, pk: 1 },
      { type: "TEXT", notnull: 1, pk: 0 },
      { type: "TEXT", notnull: 1, pk: 0 },
      { type: "INTEGER", notnull: 1, pk: 0 },
      { type: "TEXT", notnull: 1, pk: 0 },
      { type: "TEXT", notnull: 1, pk: 0 },
      { type: "TEXT", notnull: 1, pk: 0 },
      { type: "TEXT", notnull: 1, pk: 0 },
      { type: "TEXT", notnull: 1, pk: 0 },
    ]);
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get("artifact_compiler_results") as SqlRow | undefined;
    const sql = row?.sql;
    if (typeof sql !== "string" || !/check\s*\(\s*kind\s+in\s*\(\s*'compile-attestation'\s*,\s*'dry-run-attestation'\s*\)\s*\)/iu.test(sql)) {
      throw new Error("Artifact compiler result kind constraint is invalid");
    }
  }

  private assertStrictTable(
    table: string,
    columns: readonly string[],
    specifications?: readonly { readonly type: string; readonly notnull: number; readonly pk: number }[],
  ): void {
    const tableRow = this.db.prepare("SELECT name, type, strict FROM pragma_table_list WHERE name = ?").get(table) as SqlRow | undefined;
    if (tableRow === undefined || tableRow.type !== "table" || tableRow.strict !== 1) {
      throw new Error(`Artifact registry table ${table} is missing or not STRICT`);
    }
    const actualRows = this.db.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`).all() as SqlRow[];
    const actual = actualRows.map((row) => row.name);
    if (actual.length !== columns.length || !columns.every((column, index) => actual[index] === column)) {
      throw new Error(`Artifact registry table ${table} columns are invalid`);
    }
    if (specifications !== undefined && (specifications.length !== actualRows.length || actualRows.some((row, index) => (
      row.type !== specifications[index]!.type
      || row.notnull !== specifications[index]!.notnull
      || row.pk !== specifications[index]!.pk
    )))) {
      throw new Error(`Artifact registry table ${table} column declarations are invalid`);
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

  recordCompile(input: RecordArtifactCompileInput): ArtifactCompilerResultEntry {
    this.ensureOpen();
    const result = parseCompileResultForRegistry(resultInput(input));
    return this.recordCompilerResult("compile-attestation", result, input?.idempotencyKey, input?.actor);
  }

  recordDryRun(input: RecordArtifactDryRunInput): ArtifactCompilerResultEntry {
    this.ensureOpen();
    const result = parseDryRunResultForRegistry(resultInput(input));
    return this.recordCompilerResult("dry-run-attestation", result, input?.idempotencyKey, input?.actor);
  }

  listResults(query: ArtifactCompilerResultListQuery): readonly ArtifactCompilerResultEntry[] {
    this.ensureOpen();
    const normalized = normalizeCompilerResultListQuery(query);
    const clauses = ["artifact_id = ?", "revision = ?", "content_hash = ?"];
    const values: (string | number)[] = [
      normalized.artifact.artifactId,
      normalized.artifact.revision,
      normalized.artifact.contentHash,
    ];
    if (normalized.kind !== undefined) {
      clauses.push("kind = ?");
      values.push(normalized.kind);
    }
    const rows = this.db.prepare(`SELECT sequence, kind, artifact_id, revision, content_hash,
        input_identity, result_id, payload_json, recorded_at
      FROM artifact_compiler_results WHERE ${clauses.join(" AND ")}
      ORDER BY sequence DESC LIMIT ?`).all(...values, normalized.limit) as SqlRow[];
    return rows.map((row) => this.compilerResultEntryFromRow(row));
  }

  latestResult(query: ArtifactCompilerResultLookup): ArtifactCompilerResultEntry | undefined {
    this.ensureOpen();
    const normalized = normalizeCompilerResultLookup(query);
    const row = this.db.prepare(`SELECT sequence, kind, artifact_id, revision, content_hash,
        input_identity, result_id, payload_json, recorded_at
      FROM artifact_compiler_results
      WHERE kind = ? AND artifact_id = ? AND revision = ? AND content_hash = ?
      ORDER BY sequence DESC LIMIT 1`).get(
      normalized.kind,
      normalized.artifact.artifactId,
      normalized.artifact.revision,
      normalized.artifact.contentHash,
    ) as SqlRow | undefined;
    return row === undefined ? undefined : this.compilerResultEntryFromRow(row);
  }

  resultByInput(query: ArtifactCompilerResultIdentityLookup): ArtifactCompilerResultEntry | undefined {
    this.ensureOpen();
    const normalized = normalizeCompilerResultIdentityLookup(query);
    const rows = this.db.prepare(`SELECT sequence, kind, artifact_id, revision, content_hash,
        input_identity, result_id, payload_json, recorded_at
      FROM artifact_compiler_results
      WHERE kind = ? AND artifact_id = ? AND revision = ? AND content_hash = ? AND input_identity = ?
      LIMIT 2`).all(
      normalized.kind,
      normalized.artifact.artifactId,
      normalized.artifact.revision,
      normalized.artifact.contentHash,
      normalized.inputIdentity,
    ) as SqlRow[];
    if (rows.length > 1) throw new ArtifactRegistryError("corrupt_record", "Compiler result input identity is ambiguous");
    return rows.length === 0 ? undefined : this.compilerResultEntryFromRow(rows[0]!);
  }

  resultById(query: ArtifactCompilerResultIdLookup): ArtifactCompilerResultEntry | undefined {
    this.ensureOpen();
    const normalized = normalizeCompilerResultIdLookup(query);
    const rows = this.db.prepare(`SELECT sequence, kind, artifact_id, revision, content_hash,
        input_identity, result_id, payload_json, recorded_at
      FROM artifact_compiler_results
      WHERE kind = ? AND artifact_id = ? AND revision = ? AND content_hash = ? AND result_id = ?
      LIMIT 2`).all(
      normalized.kind,
      normalized.artifact.artifactId,
      normalized.artifact.revision,
      normalized.artifact.contentHash,
      normalized.resultId,
    ) as SqlRow[];
    if (rows.length > 1) throw new ArtifactRegistryError("corrupt_record", "Compiler result id is ambiguous");
    return rows.length === 0 ? undefined : this.compilerResultEntryFromRow(rows[0]!);
  }

  /** Short aliases used by read-side integrations. */
  byInput(query: ArtifactCompilerResultIdentityLookup): ArtifactCompilerResultEntry | undefined {
    return this.resultByInput(query);
  }

  byResult(query: ArtifactCompilerResultIdLookup): ArtifactCompilerResultEntry | undefined {
    return this.resultById(query);
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

  /**
   * Returns one exact immutable assessment without enumerating stale history.
   * The unique storage key makes this a bounded point lookup, not a latest/list
   * approximation.
   */
  attestationByInputIdentity(query: ArtifactAssessmentIdentityLookup): ArtifactAssessmentEntry | undefined {
    this.ensureOpen();
    const normalized = normalizeAssessmentIdentityLookup(query);
    const rows = this.db.prepare(`SELECT sequence, kind, artifact_id, revision, content_hash,
        input_identity, record_id, payload_json, recorded_at
      FROM artifact_assessments
      WHERE kind = ? AND artifact_id = ? AND revision = ? AND content_hash = ? AND input_identity = ?
      LIMIT 2`).all(
      normalized.kind,
      normalized.artifact.artifactId,
      normalized.artifact.revision,
      normalized.artifact.contentHash,
      normalized.inputIdentity,
    ) as SqlRow[];
    if (rows.length > 1) {
      throw new ArtifactRegistryError("corrupt_record", "Assessment identity lookup is ambiguous");
    }
    return rows.length === 0 ? undefined : this.assessmentEntryFromRow(rows[0]!);
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

  /**
   * Returns the one current draft revision sourced by an exact Proposal
   * revision. The source identity lives in the immutable JSON, so SQLite does
   * the narrow match and the bounded LIMIT 2 result proves uniqueness before
   * the candidate is exposed.
   */
  currentBySourceProposal(query: ArtifactRegistrySourceProposalLookup): ArtifactRegistryEntry | undefined {
    this.ensureOpen();
    const normalized = normalizeSourceProposalLookup(query);
    let rows: SqlRow[];
    try {
      rows = this.db.prepare(`SELECT artifact_id, revision, content_hash, artifact_json, created_at
        FROM artifact_revisions
        WHERE json_extract(artifact_json, '$.sourceProposal.proposalId') = ?
          AND json_extract(artifact_json, '$.sourceProposal.proposalRevision') = ?
          AND NOT EXISTS (
            SELECT 1 FROM artifact_status_events AS status
            WHERE status.artifact_id = artifact_revisions.artifact_id
              AND status.revision = artifact_revisions.revision
              AND status.status = 'superseded'
              AND status.tombstone = 1
          )
        ORDER BY artifact_id, revision
        LIMIT 2`).all(normalized.proposalId, normalized.proposalRevision) as SqlRow[];
    } catch (error) {
      if (error instanceof ArtifactRegistryError) throw error;
      throw new ArtifactRegistryError("corrupt_record", "Artifact source proposal lookup failed");
    }
    if (rows.length > 1) {
      throw new ArtifactRegistryError("corrupt_record", "Current source Proposal revision is ambiguous");
    }
    if (rows.length === 0) return undefined;

    const entry = this.entryFromRow(rows[0]!);
    if (entry.artifact.sourceProposal.proposalId !== normalized.proposalId
      || entry.artifact.sourceProposal.proposalRevision !== normalized.proposalRevision) {
      throw new ArtifactRegistryError("corrupt_record", "Artifact source Proposal identity is inconsistent");
    }
    this.assertCurrentDraftEntry(entry);
    return entry;
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

  private recordCompilerResult(
    kind: ArtifactCompilerResultKind,
    result: ArtifactCompilerResult,
    rawIdempotencyKey: unknown,
    rawActor: unknown,
  ): ArtifactCompilerResultEntry {
    const idempotencyKey = validateBoundedText(rawIdempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH, "idempotency key");
    const actor = validateBoundedText(rawActor ?? "hub", MAX_ACTOR_LENGTH, "actor");
    const artifact = result.artifact;
    const payloadJson = canonicalCompilerResult(result);
    const payloadHash = hashAssessmentPayload(payloadJson);
    const resultId = result.resultId;
    const inputIdentity = result.inputIdentity;

    return this.writeTransaction(() => {
      const replay = this.findOperation(idempotencyKey);
      if (replay !== undefined) {
        this.assertCompilerResultOperationMatches(replay, kind, artifact, resultId, inputIdentity, payloadHash, actor);
        if (replay.recordId === undefined) {
          throw new ArtifactRegistryError("corrupt_record", "Compiler result idempotency row has no result id");
        }
        const replayRow = this.findCompilerResultById(replay.recordId);
        if (replayRow === undefined) {
          throw new ArtifactRegistryError("corrupt_record", "Compiler result idempotency row has no result");
        }
        const replayEntry = this.compilerResultEntryFromRow(replayRow);
        if (replayEntry.resultId !== resultId
          || replayEntry.kind !== kind
          || replayEntry.inputIdentity !== inputIdentity
          || !sameArtifactRef(replayEntry.artifact, artifact)
          || replayEntry.audit[0]?.actor !== actor) {
          throw new ArtifactRegistryError("corrupt_record", "Compiler result idempotency row points to an inconsistent result");
        }
        return replayEntry;
      }

      const current = this.requireEntry(artifact.artifactId, artifact.revision);
      assertArtifactRefMatches(current.artifact, artifact);

      const byResultId = this.findCompilerResultById(resultId);
      if (byResultId !== undefined) {
        const existing = this.compilerResultEntryFromRow(byResultId);
        assertCompilerResultSemanticMatch(existing, kind, artifact, inputIdentity, resultId, payloadJson);
        this.insertCompilerResultOperation({
          idempotencyKey,
          kind,
          artifact,
          resultId: existing.resultId,
          inputIdentity,
          payloadHash,
          actor,
          at: this.now(),
        });
        return existing;
      }

      const byInput = this.findCompilerResultByInput(kind, artifact, inputIdentity);
      if (byInput !== undefined) {
        const existing = this.compilerResultEntryFromRow(byInput);
        assertCompilerResultSemanticMatch(existing, kind, artifact, inputIdentity, resultId, payloadJson);
        this.insertCompilerResultOperation({
          idempotencyKey,
          kind,
          artifact,
          resultId: existing.resultId,
          inputIdentity,
          payloadHash,
          actor,
          at: this.now(),
        });
        return existing;
      }

      if (current.status === "superseded") {
        throw new ArtifactRegistryError("revision_conflict", "Superseded artifact revisions cannot receive compiler results");
      }
      this.assertCompilerResultDependencies(result, false);

      const recordedAt = this.now();
      this.db.prepare(`INSERT INTO artifact_compiler_results
        (kind, artifact_id, revision, content_hash, input_identity, result_id, payload_json, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        kind,
        artifact.artifactId,
        artifact.revision,
        artifact.contentHash,
        inputIdentity,
        resultId,
        payloadJson,
        recordedAt,
      );
      this.inject("after-result-row");
      this.insertCompilerResultOperation({
        idempotencyKey,
        kind,
        artifact,
        resultId,
        inputIdentity,
        payloadHash,
        actor,
        at: recordedAt,
      });
      this.insertAudit({
        artifact: current.artifact,
        action: kind === "compile-attestation" ? "compile_recorded" : "dry_run_recorded",
        actor,
        at: recordedAt,
        idempotencyKey,
        kind,
        recordId: resultId,
      });
      this.inject("after-audit-row");
      const inserted = this.findCompilerResultById(resultId);
      if (inserted === undefined) {
        throw new ArtifactRegistryError("corrupt_record", "Compiler result row disappeared during write");
      }
      return this.compilerResultEntryFromRow(inserted);
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

  private insertCompilerResultOperation(input: {
    readonly idempotencyKey: string;
    readonly kind: ArtifactCompilerResultKind;
    readonly artifact: ArtifactRef;
    readonly resultId: string;
    readonly inputIdentity: string;
    readonly payloadHash: string;
    readonly actor: string;
    readonly at: string;
  }): void {
    this.db.prepare(`INSERT INTO artifact_operations
      (idempotency_key, operation, artifact_id, revision, content_hash, actor,
        record_kind, record_id, input_identity, payload_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.idempotencyKey,
      input.kind === "compile-attestation" ? "compile-result" : "dry-run-result",
      input.artifact.artifactId,
      input.artifact.revision,
      input.artifact.contentHash,
      input.actor,
      input.kind,
      input.resultId,
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
    readonly kind?: ArtifactAssessmentKind | ArtifactCompilerResultKind;
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

  private assertCompilerResultOperationMatches(
    operation: OperationRow,
    kind: ArtifactCompilerResultKind,
    artifact: ArtifactRef,
    resultId: string,
    inputIdentity: string,
    payloadHash: string,
    actor: string,
  ): void {
    if (!isCompilerResultOperation(operation.operation)
      || operation.recordKind !== kind
      || operation.recordId !== resultId
      || operation.artifactId !== artifact.artifactId
      || operation.revision !== artifact.revision
      || operation.contentHash !== artifact.contentHash
      || operation.inputIdentity !== inputIdentity
      || operation.payloadHash !== payloadHash
      || operation.actor !== actor) {
      throw new ArtifactRegistryError("revision_conflict", "Idempotency key conflicts with another compiler result write");
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

  private findCompilerResultById(resultId: string): SqlRow | undefined {
    return this.db.prepare(`SELECT sequence, kind, artifact_id, revision, content_hash,
        input_identity, result_id, payload_json, recorded_at
      FROM artifact_compiler_results WHERE result_id = ?`).get(resultId) as SqlRow | undefined;
  }

  private findCompilerResultByInput(
    kind: ArtifactCompilerResultKind,
    artifact: ArtifactRef,
    inputIdentity: string,
  ): SqlRow | undefined {
    return this.db.prepare(`SELECT sequence, kind, artifact_id, revision, content_hash,
        input_identity, result_id, payload_json, recorded_at
      FROM artifact_compiler_results
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

  private assertCurrentDraftEntry(entry: ArtifactRegistryEntry): void {
    if (entry.status !== "draft" || entry.tombstone) {
      throw new ArtifactRegistryError("corrupt_record", "Current artifact lifecycle state is invalid");
    }
    const lifecycleAudit = entry.audit.length === 1 ? entry.audit[0] : undefined;
    const expectedAction = entry.artifact.revision === 1 ? "created" : "revision_appended";
    const expectedOperation = entry.artifact.revision === 1 ? "create" : "append";
    if (lifecycleAudit === undefined || lifecycleAudit.action !== expectedAction) {
      throw new ArtifactRegistryError("corrupt_record", "Current artifact lifecycle audit is invalid");
    }
    const operation = this.findOperation(lifecycleAudit.idempotencyKey);
    if (operation === undefined
      || operation.operation !== expectedOperation
      || operation.artifactId !== entry.artifact.artifactId
      || operation.revision !== entry.artifact.revision
      || operation.contentHash !== entry.artifact.contentHash
      || operation.actor !== lifecycleAudit.actor) {
      throw new ArtifactRegistryError("corrupt_record", "Current artifact lifecycle audit is inconsistent");
    }
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

  private compilerResultEntryFromRow(row: SqlRow): ArtifactCompilerResultEntry {
    const result = compilerResultFromRow(row);
    const artifact = result.artifact;
    const storedArtifact = this.requireEntry(artifact.artifactId, artifact.revision).artifact;
    assertArtifactRefMatches(storedArtifact, artifact);
    try {
      this.assertCompilerResultDependencies(result, true);
    } catch (error) {
      if (error instanceof ArtifactRegistryError && (error.code === "not_found" || error.code === "revision_conflict")) {
        throw new ArtifactRegistryError("corrupt_record", "Compiler result dependency is inconsistent");
      }
      throw error;
    }

    const sequence = integerColumn(row, "sequence");
    const recordId = textColumn(row, "result_id");
    const kind = textColumn(row, "kind");
    const inputIdentity = textColumn(row, "input_identity");
    if (!isCompilerResultKind(kind)
      || kind !== result.kind
      || recordId !== result.resultId
      || inputIdentity !== result.inputIdentity
      || textColumn(row, "artifact_id") !== artifact.artifactId
      || integerColumn(row, "revision") !== artifact.revision
      || textColumn(row, "content_hash") !== artifact.contentHash) {
      throw new ArtifactRegistryError("corrupt_record", "Compiler result row identity mismatch");
    }

    const expectedAction = kind === "compile-attestation" ? "compile_recorded" : "dry_run_recorded";
    const auditRows = this.db.prepare(`SELECT audit_id, artifact_id, revision, action, actor,
        idempotency_key, reason, record_kind, record_id, created_at
      FROM artifact_audit
      WHERE artifact_id = ? AND revision = ? AND action = ?
        AND record_kind = ? AND record_id = ?
      ORDER BY sequence`).all(
      artifact.artifactId,
      artifact.revision,
      expectedAction,
      kind,
      recordId,
    ) as SqlRow[];
    if (auditRows.length !== 1) {
      throw new ArtifactRegistryError("corrupt_record", "Compiler result audit row is missing or ambiguous");
    }
    const resultAudit = toAudit(auditRows[0]!);
    const auditOperationRow = this.db.prepare(`SELECT idempotency_key, operation, artifact_id, revision,
        content_hash, actor, reason, record_kind, record_id, input_identity, payload_hash, created_at
      FROM artifact_operations WHERE idempotency_key = ?`).get(resultAudit.idempotencyKey) as SqlRow | undefined;
    if (auditOperationRow === undefined) {
      throw new ArtifactRegistryError("corrupt_record", "Compiler result audit operation pointer is missing");
    }
    const auditOperation = operationFromRow(auditOperationRow);
    if (!isCompilerResultOperation(auditOperation.operation)
      || auditOperation.recordKind !== kind
      || auditOperation.recordId !== recordId
      || auditOperation.artifactId !== artifact.artifactId
      || auditOperation.revision !== artifact.revision
      || auditOperation.contentHash !== artifact.contentHash
      || auditOperation.inputIdentity !== inputIdentity
      || auditOperation.payloadHash !== hashAssessmentPayload(canonicalCompilerResult(result))
      || auditOperation.actor !== resultAudit.actor
      || auditOperation.createdAt !== resultAudit.at) {
      throw new ArtifactRegistryError("corrupt_record", "Compiler result audit operation pointer is inconsistent");
    }
    const operationRows = this.db.prepare(`SELECT idempotency_key, operation, artifact_id, revision,
        content_hash, actor, reason, record_kind, record_id, input_identity, payload_hash, created_at
      FROM artifact_operations
      WHERE record_kind = ? AND record_id = ?`).all(kind, recordId) as SqlRow[];
    if (operationRows.length === 0) {
      throw new ArtifactRegistryError("corrupt_record", "Compiler result operation pointer is missing");
    }
    for (const operationRow of operationRows) {
      const operation = operationFromRow(operationRow);
      if (!isCompilerResultOperation(operation.operation)
        || operation.recordKind !== kind
        || operation.recordId !== recordId
        || operation.artifactId !== artifact.artifactId
        || operation.revision !== artifact.revision
        || operation.contentHash !== artifact.contentHash
        || operation.inputIdentity !== inputIdentity
        || operation.payloadHash !== hashAssessmentPayload(canonicalCompilerResult(result))
        || operation.actor === undefined) {
        throw new ArtifactRegistryError("corrupt_record", "Compiler result operation pointer is inconsistent");
      }
    }
    return {
      kind,
      recordId,
      resultId: recordId,
      artifact,
      inputIdentity,
      sequence,
      recordedAt: textColumn(row, "recorded_at"),
      result,
      audit: auditRows.map(toAudit),
    };
  }

  private assertCompilerResultDependencies(result: ArtifactCompilerResult, reading: boolean): void {
    if (result.kind === "compile-attestation") {
      const storedArtifact = this.requireEntry(result.artifact.artifactId, result.artifact.revision).artifact;
      const evidence = this.requireAssessmentDependency(
        "evidence-attestation",
        result.evidenceAttestationId,
        result.artifact,
        result.evidenceInputIdentity,
        reading,
      );
      const authority = this.requireAssessmentDependency(
        "authority-assessment",
        result.authorityAssessmentId,
        result.artifact,
        result.authorityInputIdentity,
        reading,
      );
      const risk = this.requireAssessmentDependency(
        "risk-assessment",
        result.riskAssessmentId,
        result.artifact,
        result.riskInputIdentity,
        reading,
      );
      if (evidence.assessment.kind !== "evidence-attestation"
        || authority.assessment.kind !== "authority-assessment"
        || risk.assessment.kind !== "risk-assessment"
        || risk.assessment.evidence.attestationId !== evidence.assessment.attestationId
        || risk.assessment.evidence.inputIdentity !== evidence.inputIdentity
        || risk.assessment.authority.assessmentId !== authority.assessment.assessmentId
        || risk.assessment.authority.inputIdentity !== authority.inputIdentity
        || result.proposal.id !== storedArtifact.sourceProposal.proposalId
        || result.proposal.revision !== storedArtifact.sourceProposal.proposalRevision) {
        throw new ArtifactRegistryError("revision_conflict", "Compiler result dependencies do not match the artifact");
      }
      return;
    }

    const compileRow = this.findCompilerResultById(result.compileAttestationId);
    if (compileRow === undefined) {
      throw new ArtifactRegistryError("not_found", "Dry-run compile dependency was not found");
    }
    const compileEntry = this.compilerResultEntryFromRow(compileRow);
    if (compileEntry.kind !== "compile-attestation") {
      throw new ArtifactRegistryError("revision_conflict", "Dry-run compile dependency kind does not match");
    }
    const compile = compileEntry.result;
    if (compile.kind !== "compile-attestation"
      || !sameArtifactRef(compile.artifact, result.artifact)
      || compile.resultId !== result.compileAttestationId
      || compile.inputIdentity !== result.compileInputIdentity
      || compile.evidenceAttestationId !== result.evidenceAttestationId
      || compile.evidenceInputIdentity !== result.evidenceInputIdentity
      || compile.riskAssessmentId !== result.riskAssessmentId
      || compile.riskInputIdentity !== result.riskInputIdentity
      || compile.authorityAssessmentId !== result.authorityAssessmentId
      || compile.authorityInputIdentity !== result.authorityInputIdentity
      || compile.worldCutIdentity !== result.worldCutIdentity
      || compile.foreignCatalogIdentity !== result.foreignCatalogIdentity
      || canonicalJsonForComparison(compile.compiler) !== canonicalJsonForComparison(result.compiler)
      || canonicalJsonForComparison(compile.usedWatermarks) !== canonicalJsonForComparison(result.checkedWatermarks)
      || canonicalJsonForComparison(compile.actionAuthorityBindings) !== canonicalJsonForComparison(result.actionAuthorityBindings)
      || canonicalJsonForComparison(compile.diff) !== canonicalJsonForComparison(result.diff)
      || canonicalJsonForComparison(compile.conflicts) !== canonicalJsonForComparison(result.conflicts)
      || result.status !== expectedDryRunStatusForRegistry(compile)) {
      throw new ArtifactRegistryError("revision_conflict", "Dry-run dependencies do not match the compile result");
    }
    this.requireAssessmentDependency("evidence-attestation", result.evidenceAttestationId, result.artifact, result.evidenceInputIdentity, reading);
    this.requireAssessmentDependency("risk-assessment", result.riskAssessmentId, result.artifact, result.riskInputIdentity, reading);
    this.requireAssessmentDependency("authority-assessment", result.authorityAssessmentId, result.artifact, result.authorityInputIdentity, reading);
  }

  private requireAssessmentDependency(
    kind: ArtifactAssessmentKind,
    recordId: string,
    artifact: ArtifactRef,
    inputIdentity: string,
    reading: boolean,
  ): ArtifactAssessmentEntry {
    const row = this.findAssessmentByRecordId(recordId);
    if (row === undefined) throw new ArtifactRegistryError("not_found", "Compiler result assessment dependency was not found");
    if (textColumn(row, "kind") !== kind) throw new ArtifactRegistryError("revision_conflict", "Compiler result assessment dependency kind does not match");
    const dependency = this.assessmentEntryFromRow(row);
    if (!sameArtifactRef(dependency.artifact, artifact) || dependency.inputIdentity !== inputIdentity) {
      throw new ArtifactRegistryError("revision_conflict", "Compiler result assessment dependency identity does not match");
    }
    if (!reading && dependency.artifact.artifactId !== artifact.artifactId) {
      throw new ArtifactRegistryError("revision_conflict", "Compiler result assessment dependency artifact does not match");
    }
    return dependency;
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

function resultInput<T extends ArtifactCompilerResult>(input: RecordArtifactCompilerResultInput<T>): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ArtifactRegistryError("invalid_input", "Compiler result input is invalid");
  }
  const hasResult = input.result !== undefined;
  const hasAttestation = input.attestation !== undefined;
  if (hasResult === hasAttestation) {
    throw new ArtifactRegistryError("invalid_input", "Compiler result input must contain exactly one result");
  }
  return hasResult ? input.result : input.attestation;
}

function parseCompileResultForRegistry(input: unknown): ArtifactCompileAttestation {
  try {
    return parseArtifactCompileAttestation(input);
  } catch {
    throw new ArtifactRegistryError("invalid_assessment", "Compile attestation failed validation");
  }
}

function parseDryRunResultForRegistry(input: unknown): NeutralDryRunAttestation {
  try {
    return parseNeutralDryRunAttestation(input);
  } catch {
    throw new ArtifactRegistryError("invalid_assessment", "Dry-run attestation failed validation");
  }
}

function canonicalCompilerResult(result: ArtifactCompilerResult): string {
  const parsed = result.kind === "compile-attestation"
    ? parseArtifactCompileAttestation(result)
    : parseNeutralDryRunAttestation(result);
  const canonical = canonicalCompilerValue(parsed, new WeakSet<object>(), 0);
  const encoded = JSON.stringify(canonical);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_COMPILER_CANONICAL_BYTES) {
    throw new ArtifactRegistryError("invalid_assessment", "Compiler result payload exceeds the canonical byte budget");
  }
  return encoded;
}

function compilerResultFromRow(row: SqlRow): ArtifactCompilerResult {
  try {
    const kind = textColumn(row, "kind");
    const payloadJson = textColumn(row, "payload_json");
    const result = kind === "compile-attestation"
      ? parseArtifactCompileAttestationJson(payloadJson)
      : kind === "dry-run-attestation"
        ? parseNeutralDryRunAttestationJson(payloadJson)
        : undefined;
    if (result === undefined || canonicalCompilerResult(result) !== payloadJson) throw new Error("Compiler result payload is not canonical");
    return result;
  } catch (error) {
    if (error instanceof ArtifactRegistryError && error.code === "invalid_assessment") {
      throw new ArtifactRegistryError("corrupt_record", "Artifact compiler result row failed validation");
    }
    throw new ArtifactRegistryError("corrupt_record", "Artifact compiler result row failed validation");
  }
}

function canonicalCompilerValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "object") throw new ArtifactRegistryError("invalid_assessment", "Compiler result contains an unsupported value");
  if (depth > 16 || seen.has(value)) throw new ArtifactRegistryError("invalid_assessment", "Compiler result contains invalid nesting");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalCompilerValue(item, seen, depth + 1));
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareUnicodeCodePoints)) {
      output[key] = canonicalCompilerValue((value as Record<string, unknown>)[key], seen, depth + 1);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function canonicalJsonForComparison(value: unknown): string {
  return JSON.stringify(canonicalCompilerValue(value, new WeakSet<object>(), 0)) ?? "";
}

function sameArtifactRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.artifactId === right.artifactId
    && left.revision === right.revision
    && left.contentHash === right.contentHash;
}

function expectedDryRunStatusForRegistry(compile: ArtifactCompileAttestation): NeutralDryRunAttestation["status"] {
  if (compile.status === "unavailable") return "unavailable";
  if (compile.status === "rejected") return "failed";
  return compile.diff.status !== "unavailable" && compile.conflicts.status === "none" ? "passed" : "failed";
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

function isCompilerResultKind(value: string): value is ArtifactCompilerResultKind {
  return value === "compile-attestation" || value === "dry-run-attestation";
}

function isCompilerResultOperation(value: string): boolean {
  return value === "compile-result" || value === "dry-run-result";
}

function normalizeSourceProposalLookup(query: unknown): ArtifactRegistrySourceProposalLookup {
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    throw new ArtifactRegistryError("invalid_input", "Source Proposal lookup is invalid");
  }
  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(query);
  } catch {
    throw new ArtifactRegistryError("invalid_input", "Source Proposal lookup is invalid");
  }
  if (keys.length !== 2 || !keys.every((key) => key === "proposalId" || key === "proposalRevision")) {
    throw new ArtifactRegistryError("invalid_input", "Source Proposal lookup is invalid");
  }
  const value = query as {
    readonly proposalId?: unknown;
    readonly proposalRevision?: unknown;
  };
  const proposalId = validateBoundedText(value.proposalId, MAX_IDEMPOTENCY_KEY_LENGTH, "source Proposal id");
  if (typeof value.proposalRevision !== "number"
    || !Number.isSafeInteger(value.proposalRevision)
    || value.proposalRevision < 1) {
    throw new ArtifactRegistryError("invalid_input", "source Proposal revision is invalid");
  }
  return {
    proposalId,
    proposalRevision: value.proposalRevision,
  };
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

function normalizeAssessmentIdentityLookup(query: unknown): ArtifactAssessmentIdentityLookup {
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    throw new ArtifactRegistryError("invalid_input", "Assessment identity lookup is invalid");
  }
  const keys = Reflect.ownKeys(query);
  if (keys.length !== 3 || !keys.every((key) => (
    key === "kind" || key === "artifact" || key === "inputIdentity"
  ))) {
    throw new ArtifactRegistryError("invalid_input", "Assessment identity lookup is invalid");
  }
  const value = query as {
    readonly kind?: unknown;
    readonly artifact?: unknown;
    readonly inputIdentity?: unknown;
  };
  if (typeof value.kind !== "string" || !isAssessmentKind(value.kind)) {
    throw new ArtifactRegistryError("invalid_input", "Assessment identity kind is invalid");
  }
  const artifact = artifactRefSchema.safeParse(value.artifact);
  if (!artifact.success) {
    throw new ArtifactRegistryError("invalid_input", "Assessment identity artifact ref is invalid");
  }
  if (typeof value.inputIdentity !== "string" || !SHA256_DIGEST.test(value.inputIdentity)) {
    throw new ArtifactRegistryError("invalid_input", "Assessment identity digest is invalid");
  }
  return {
    kind: value.kind,
    artifact: artifact.data,
    inputIdentity: value.inputIdentity,
  };
}

function normalizeCompilerResultListQuery(query: unknown): {
  readonly kind: ArtifactCompilerResultKind | undefined;
  readonly artifact: ArtifactRef;
  readonly limit: number;
} {
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    throw new ArtifactRegistryError("invalid_input", "Compiler result list query is invalid");
  }
  const value = query as { readonly kind?: unknown; readonly artifact?: unknown; readonly limit?: unknown };
  const artifact = parseArtifactRefForRegistry(value.artifact, "Compiler result artifact ref");
  const kind = value.kind === undefined ? undefined : parseCompilerResultKind(value.kind);
  const limit = value.limit === undefined ? DEFAULT_LIST_LIMIT : value.limit;
  if (typeof limit !== "number") {
    throw new ArtifactRegistryError("invalid_input", "Compiler result list limit is out of bounds");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ArtifactRegistryError("invalid_input", "Compiler result list limit is out of bounds");
  }
  return { kind, artifact, limit };
}

function normalizeCompilerResultLookup(query: unknown): ArtifactCompilerResultLookup {
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    throw new ArtifactRegistryError("invalid_input", "Compiler result lookup is invalid");
  }
  const value = query as { readonly kind?: unknown; readonly artifact?: unknown };
  return {
    kind: parseCompilerResultKind(value.kind),
    artifact: parseArtifactRefForRegistry(value.artifact, "Compiler result artifact ref"),
  };
}

function normalizeCompilerResultIdentityLookup(query: unknown): ArtifactCompilerResultIdentityLookup {
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    throw new ArtifactRegistryError("invalid_input", "Compiler result identity lookup is invalid");
  }
  const value = query as { readonly kind?: unknown; readonly artifact?: unknown; readonly inputIdentity?: unknown };
  const inputIdentity = parseDigest(value.inputIdentity, "Compiler result input identity");
  return {
    kind: parseCompilerResultKind(value.kind),
    artifact: parseArtifactRefForRegistry(value.artifact, "Compiler result artifact ref"),
    inputIdentity,
  };
}

function normalizeCompilerResultIdLookup(query: unknown): ArtifactCompilerResultIdLookup {
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    throw new ArtifactRegistryError("invalid_input", "Compiler result id lookup is invalid");
  }
  const value = query as { readonly kind?: unknown; readonly artifact?: unknown; readonly resultId?: unknown };
  const resultId = parseDigest(value.resultId, "Compiler result id");
  return {
    kind: parseCompilerResultKind(value.kind),
    artifact: parseArtifactRefForRegistry(value.artifact, "Compiler result artifact ref"),
    resultId,
  };
}

function parseCompilerResultKind(value: unknown): ArtifactCompilerResultKind {
  if (typeof value !== "string" || !isCompilerResultKind(value)) {
    throw new ArtifactRegistryError("invalid_input", "Compiler result kind is invalid");
  }
  return value;
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    throw new ArtifactRegistryError("invalid_input", `${label} is invalid`);
  }
  return value;
}

function parseArtifactRefForRegistry(value: unknown, label: string): ArtifactRef {
  const parsed = artifactRefSchema.safeParse(value);
  if (!parsed.success) throw new ArtifactRegistryError("invalid_input", `${label} is invalid`);
  return parsed.data;
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

function assertCompilerResultSemanticMatch(
  existing: ArtifactCompilerResultEntry,
  kind: ArtifactCompilerResultKind,
  artifact: ArtifactRef,
  inputIdentity: string,
  resultId: string,
  payloadJson: string,
): void {
  if (existing.kind !== kind
    || !sameArtifactRef(existing.artifact, artifact)
    || existing.inputIdentity !== inputIdentity
    || existing.resultId !== resultId
    || canonicalCompilerResult(existing.result) !== payloadJson) {
    throw new ArtifactRegistryError("revision_conflict", "Compiler result identity conflicts with an existing row");
  }
}

function operationFromRow(row: SqlRow): OperationRow {
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
  if (action !== "created" && action !== "revision_appended" && action !== "superseded"
    && action !== "assessment_recorded" && action !== "compile_recorded" && action !== "dry_run_recorded") {
    throw new ArtifactRegistryError("corrupt_record", "Artifact audit action is invalid");
  }
  const reason = nullableTextColumn(row, "reason");
  const kind = nullableTextColumn(row, "record_kind");
  if (kind !== undefined && !isAssessmentKind(kind) && !isCompilerResultKind(kind)) {
    throw new ArtifactRegistryError("corrupt_record", "Artifact audit assessment kind is invalid");
  }
  const recordId = nullableTextColumn(row, "record_id");
  if ((action === "assessment_recorded" || action === "compile_recorded" || action === "dry_run_recorded")
    && (kind === undefined || recordId === undefined)) {
    throw new ArtifactRegistryError("corrupt_record", "Assessment/result audit metadata is incomplete");
  }
  if (action === "compile_recorded" && kind !== "compile-attestation") {
    throw new ArtifactRegistryError("corrupt_record", "Compile audit kind is invalid");
  }
  if (action === "dry_run_recorded" && kind !== "dry-run-attestation") {
    throw new ArtifactRegistryError("corrupt_record", "Dry-run audit kind is invalid");
  }
  if (action === "assessment_recorded" && (kind === undefined || !isAssessmentKind(kind))) {
    throw new ArtifactRegistryError("corrupt_record", "Assessment audit kind is invalid");
  }
  if (action !== "assessment_recorded" && action !== "compile_recorded" && action !== "dry_run_recorded"
    && (kind !== undefined || recordId !== undefined)) {
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

function quoteSqlIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error("Invalid SQLite identifier");
  return `\"${value}\"`;
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
