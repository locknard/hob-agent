import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { HomeObservationOutcome } from "./home-observation-scheduler.js";
import type { HomeObservationDisposition } from "@hob-agent/agent-layer/home-observation-report";
import { ensurePrivateSqliteFiles } from "./sqlite-private-files.js";

export type ObservationTrigger = "startup" | "scheduled" | "manual" | "one_shot";

export type ObservationAuditRecord = {
  readonly id: string;
  readonly trigger: ObservationTrigger;
  readonly startedAt: string;
} & (
  | { readonly status: "running" }
  | { readonly status: "interrupted" }
  | {
      readonly status: "completed";
      readonly completedAt: string;
      readonly outcome: HomeObservationOutcome;
      readonly disposition?: HomeObservationDisposition;
    }
);

export interface ObservationAuditStore {
  begin(input: { readonly trigger: ObservationTrigger; readonly startedAt: string }): string;
  complete(input: {
    readonly id: string;
    readonly completedAt: string;
    readonly outcome: HomeObservationOutcome;
    readonly disposition?: HomeObservationDisposition;
  }): void;
  list(query?: { readonly limit?: number }): readonly ObservationAuditRecord[];
}

export interface SqliteObservationAuditStoreOptions {
  readonly path: string;
  readonly idFactory?: () => string;
}

type ObservationRow = Record<string, unknown>;

const TRIGGERS = new Set<ObservationTrigger>(["startup", "scheduled", "manual", "one_shot"]);
const OUTCOMES = new Set<HomeObservationOutcome>([
  "proposal_created",
  "no_proposal",
  "world_not_ready",
  "proposal_pending",
  "agent_busy",
  "failed",
]);
const DISPOSITIONS = new Set<HomeObservationDisposition>([
  "no_material_value",
  "insufficient_evidence",
  "existing_rule_overlap",
  "mapping_uncertain",
  "other_uncertainty",
]);

export class ObservationAuditError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "corrupt", message: string) {
    super(message);
    this.name = "ObservationAuditError";
  }
}

/** Metadata-only durable ledger for Hub-owned autonomous observation attempts. */
export class SqliteObservationAuditStore implements ObservationAuditStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly idFactory: () => string;
  private closed = false;

  constructor(options: SqliteObservationAuditStoreOptions) {
    if (!options || typeof options.path !== "string" || options.path.length === 0) {
      throw new TypeError("observation audit path is required");
    }
    this.path = options.path;
    this.idFactory = options.idFactory ?? randomUUID;
    if (this.path !== ":memory:" && !this.path.startsWith("file::memory:")) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observation_attempts (
        observation_id TEXT PRIMARY KEY,
        trigger TEXT NOT NULL,
        started_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'interrupted')),
        completed_at TEXT,
        outcome TEXT,
        disposition TEXT,
        CHECK ((status IN ('running', 'interrupted') AND completed_at IS NULL AND outcome IS NULL)
          OR (status = 'completed' AND completed_at IS NOT NULL AND outcome IS NOT NULL)),
        CHECK (disposition IS NULL OR (outcome = 'no_proposal' AND disposition IN
          ('no_material_value', 'insufficient_evidence', 'existing_rule_overlap', 'mapping_uncertain', 'other_uncertainty')))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS observation_attempts_started
        ON observation_attempts (started_at DESC, observation_id DESC);
    `);
    const columns = this.db.prepare("PRAGMA table_info(observation_attempts)").all() as ObservationRow[];
    if (!columns.some((column) => column.name === "disposition")) {
      this.db.exec("ALTER TABLE observation_attempts ADD COLUMN disposition TEXT");
    }
    this.db.prepare(`UPDATE observation_attempts SET status = 'interrupted'
      WHERE status = 'running'`).run();
    this.ensurePrivateFiles();
  }

  begin(input: { readonly trigger: ObservationTrigger; readonly startedAt: string }): string {
    if (!input || !TRIGGERS.has(input.trigger) || !isIsoTimestamp(input.startedAt)) {
      throw new ObservationAuditError("invalid", "Invalid observation audit start");
    }
    const id = this.idFactory();
    if (!isBoundedId(id)) {
      throw new ObservationAuditError("invalid", "Invalid observation audit id");
    }
    try {
      this.db.prepare(`INSERT INTO observation_attempts
        (observation_id, trigger, started_at, status, completed_at, outcome)
        VALUES (?, ?, ?, 'running', NULL, NULL)`).run(id, input.trigger, input.startedAt);
      return id;
    } catch (error) {
      if (isConstraintError(error)) {
        throw new ObservationAuditError("conflict", "Observation audit conflict");
      }
      throw error;
    } finally {
      this.ensurePrivateFiles();
    }
  }

  complete(input: {
    readonly id: string;
    readonly completedAt: string;
    readonly outcome: HomeObservationOutcome;
    readonly disposition?: HomeObservationDisposition;
  }): void {
    if (!input
      || !isBoundedId(input.id)
      || !isIsoTimestamp(input.completedAt)
      || !OUTCOMES.has(input.outcome)
      || (input.disposition !== undefined
        && (input.outcome !== "no_proposal" || !DISPOSITIONS.has(input.disposition)))) {
      throw new ObservationAuditError("invalid", "Invalid observation audit completion");
    }
    const row = this.db.prepare(`SELECT started_at, status
      FROM observation_attempts WHERE observation_id = ?`).get(input.id) as ObservationRow | undefined;
    if (row === undefined || row.status !== "running") {
      throw new ObservationAuditError("conflict", "Observation audit conflict");
    }
    const startedAt = String(row.started_at);
    if (!isIsoTimestamp(startedAt) || Date.parse(input.completedAt) < Date.parse(startedAt)) {
      throw new ObservationAuditError("invalid", "Invalid observation audit completion time");
    }
    const result = this.db.prepare(`UPDATE observation_attempts
      SET status = 'completed', completed_at = ?, outcome = ?, disposition = ?
      WHERE observation_id = ? AND status = 'running'`).run(
      input.completedAt,
      input.outcome,
      input.disposition ?? null,
      input.id,
    );
    this.ensurePrivateFiles();
    if (Number(result.changes) !== 1) {
      throw new ObservationAuditError("conflict", "Observation audit conflict");
    }
  }

  list(query: { readonly limit?: number } = {}): readonly ObservationAuditRecord[] {
    const limit = query.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Invalid observation audit query limit");
    }
    const rows = this.db.prepare(`SELECT observation_id, trigger, started_at, status, completed_at, outcome, disposition
      FROM observation_attempts
      ORDER BY started_at DESC, observation_id DESC LIMIT ?`).all(limit) as ObservationRow[];
    return rows.map(fromRow);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private ensurePrivateFiles(): void {
    ensurePrivateSqliteFiles(this.path);
  }
}

function fromRow(row: ObservationRow): ObservationAuditRecord {
  const id = String(row.observation_id);
  const trigger = String(row.trigger) as ObservationTrigger;
  const startedAt = String(row.started_at);
  if (!isBoundedId(id) || !TRIGGERS.has(trigger) || !isIsoTimestamp(startedAt)) {
    throw new ObservationAuditError("corrupt", "Observation audit row is corrupt");
  }
  if ((row.status === "running" || row.status === "interrupted")
    && row.completed_at === null
    && row.outcome === null) {
    return { id, trigger, startedAt, status: row.status };
  }
  const completedAt = String(row.completed_at);
  const outcome = String(row.outcome) as HomeObservationOutcome;
  const disposition = row.disposition === null || row.disposition === undefined
    ? undefined
    : String(row.disposition) as HomeObservationDisposition;
  if (row.status !== "completed"
    || !isIsoTimestamp(completedAt)
    || Date.parse(completedAt) < Date.parse(startedAt)
    || !OUTCOMES.has(outcome)
    || (disposition !== undefined && (outcome !== "no_proposal" || !DISPOSITIONS.has(disposition)))) {
    throw new ObservationAuditError("corrupt", "Observation audit row is corrupt");
  }
  return {
    id,
    trigger,
    startedAt,
    completedAt,
    status: "completed",
    outcome,
    ...(disposition === undefined ? {} : { disposition }),
  };
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && Number.isFinite(Date.parse(value))
    && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length >= 1 && value.length <= 200;
}

function isConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String((error as Error & { code?: unknown }).code) : "";
  return code.startsWith("ERR_SQLITE_CONSTRAINT") || /constraint/i.test(error.message);
}
