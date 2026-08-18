import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { HomeObservationOutcome } from "./home-observation-scheduler.js";
import type { HomeObservationDisposition } from "@hob-agent/agent-layer/home-observation-report";
import { ensurePrivateSqliteFiles } from "./sqlite-private-files.js";

export type ObservationTrigger = "startup" | "scheduled" | "manual" | "one_shot";

export interface ObservationRunMetrics {
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly toolCalls: number;
  readonly failedToolCalls: number;
}

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
      readonly metrics?: ObservationRunMetrics;
    }
);

export interface ObservationAuditStore {
  begin(input: { readonly trigger: ObservationTrigger; readonly startedAt: string }): string;
  complete(input: {
    readonly id: string;
    readonly completedAt: string;
    readonly outcome: HomeObservationOutcome;
    readonly disposition?: HomeObservationDisposition;
    readonly metrics?: ObservationRunMetrics;
  }): void;
  list(query?: { readonly limit?: number }): readonly ObservationAuditRecord[];
  summary(): ObservationAuditSummary;
}

export interface ObservationAuditSummary {
  readonly totalAttempts: number;
  readonly completedAttempts: number;
  readonly interruptedAttempts: number;
  readonly runningAttempts: number;
  readonly outcomes: Readonly<Record<HomeObservationOutcome, number>>;
  readonly dispositions: Readonly<Record<HomeObservationDisposition, number>>;
  readonly noProposalWithoutDisposition: number;
  readonly measuredAttempts: number;
  readonly metrics: ObservationRunMetrics;
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
        duration_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_tokens INTEGER,
        tool_calls INTEGER,
        failed_tool_calls INTEGER,
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
    for (const [name, type] of [
      ["duration_ms", "INTEGER"],
      ["input_tokens", "INTEGER"],
      ["output_tokens", "INTEGER"],
      ["reasoning_tokens", "INTEGER"],
      ["tool_calls", "INTEGER"],
      ["failed_tool_calls", "INTEGER"],
    ] as const) {
      if (!columns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE observation_attempts ADD COLUMN ${name} ${type}`);
      }
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
    readonly metrics?: ObservationRunMetrics;
  }): void {
    if (!input
      || !isBoundedId(input.id)
      || !isIsoTimestamp(input.completedAt)
      || !OUTCOMES.has(input.outcome)
      || (input.disposition !== undefined
        && (input.outcome !== "no_proposal" || !DISPOSITIONS.has(input.disposition)))
      || (input.metrics !== undefined && !validMetrics(input.metrics))) {
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
      SET status = 'completed', completed_at = ?, outcome = ?, disposition = ?,
        duration_ms = ?, input_tokens = ?, output_tokens = ?, reasoning_tokens = ?,
        tool_calls = ?, failed_tool_calls = ?
      WHERE observation_id = ? AND status = 'running'`).run(
      input.completedAt,
      input.outcome,
      input.disposition ?? null,
      input.metrics?.durationMs ?? null,
      input.metrics?.inputTokens ?? null,
      input.metrics?.outputTokens ?? null,
      input.metrics?.reasoningTokens ?? null,
      input.metrics?.toolCalls ?? null,
      input.metrics?.failedToolCalls ?? null,
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
    const rows = this.db.prepare(`SELECT observation_id, trigger, started_at, status, completed_at, outcome, disposition,
        duration_ms, input_tokens, output_tokens, reasoning_tokens, tool_calls, failed_tool_calls
      FROM observation_attempts
      ORDER BY started_at DESC, observation_id DESC LIMIT ?`).all(limit) as ObservationRow[];
    return rows.map(fromRow);
  }

  /** Aggregates bounded lifecycle metadata without returning attempt identities. */
  summary(): ObservationAuditSummary {
    const lifecycles = { running: 0, completed: 0, interrupted: 0 };
    const outcomes: Record<HomeObservationOutcome, number> = {
      proposal_created: 0,
      no_proposal: 0,
      world_not_ready: 0,
      proposal_pending: 0,
      agent_busy: 0,
      failed: 0,
    };
    const dispositions: Record<HomeObservationDisposition, number> = {
      no_material_value: 0,
      insufficient_evidence: 0,
      existing_rule_overlap: 0,
      mapping_uncertain: 0,
      other_uncertainty: 0,
    };
    const lifecycleRows = this.db.prepare("SELECT status, COUNT(*) AS count FROM observation_attempts GROUP BY status").all() as ObservationRow[];
    for (const row of lifecycleRows) {
      const status = String(row.status) as keyof typeof lifecycles;
      const count = Number(row.count);
      if (!Object.hasOwn(lifecycles, status) || !Number.isSafeInteger(count) || count < 0) {
        throw new ObservationAuditError("corrupt", "Observation audit summary is corrupt");
      }
      lifecycles[status] = count;
    }
    const outcomeRows = this.db.prepare(`SELECT outcome, COUNT(*) AS count
      FROM observation_attempts WHERE status = 'completed' GROUP BY outcome`).all() as ObservationRow[];
    for (const row of outcomeRows) {
      const outcome = String(row.outcome) as HomeObservationOutcome;
      const count = Number(row.count);
      if (!Object.hasOwn(outcomes, outcome) || !Number.isSafeInteger(count) || count < 0) {
        throw new ObservationAuditError("corrupt", "Observation audit summary is corrupt");
      }
      outcomes[outcome] = count;
    }
    const dispositionRows = this.db.prepare(`SELECT disposition, COUNT(*) AS count
      FROM observation_attempts WHERE status = 'completed' AND outcome = 'no_proposal'
      GROUP BY disposition`).all() as ObservationRow[];
    let noProposalWithoutDisposition = 0;
    for (const row of dispositionRows) {
      const count = Number(row.count);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new ObservationAuditError("corrupt", "Observation audit summary is corrupt");
      }
      if (row.disposition === null || row.disposition === undefined) {
        noProposalWithoutDisposition += count;
        continue;
      }
      const disposition = String(row.disposition) as HomeObservationDisposition;
      if (!Object.hasOwn(dispositions, disposition)) {
        throw new ObservationAuditError("corrupt", "Observation audit summary is corrupt");
      }
      dispositions[disposition] = count;
    }
    const metricRow = this.db.prepare(`SELECT
        COUNT(duration_ms) AS duration_count,
        COUNT(input_tokens) AS input_count,
        COUNT(output_tokens) AS output_count,
        COUNT(reasoning_tokens) AS reasoning_count,
        COUNT(tool_calls) AS tool_count,
        COUNT(failed_tool_calls) AS failed_tool_count,
        COALESCE(SUM(duration_ms), 0) AS duration_ms,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(tool_calls), 0) AS tool_calls,
        COALESCE(SUM(failed_tool_calls), 0) AS failed_tool_calls
      FROM observation_attempts WHERE status = 'completed'`).get() as ObservationRow;
    const metricCounts = [
      metricRow.duration_count,
      metricRow.input_count,
      metricRow.output_count,
      metricRow.reasoning_count,
      metricRow.tool_count,
      metricRow.failed_tool_count,
    ].map(Number);
    const measuredAttempts = metricCounts[0]!;
    const metrics = {
      durationMs: Number(metricRow.duration_ms),
      inputTokens: Number(metricRow.input_tokens),
      outputTokens: Number(metricRow.output_tokens),
      reasoningTokens: Number(metricRow.reasoning_tokens),
      toolCalls: Number(metricRow.tool_calls),
      failedToolCalls: Number(metricRow.failed_tool_calls),
    };
    if (!metricCounts.every((count) => Number.isSafeInteger(count) && count >= 0 && count === measuredAttempts)
      || !Object.values(metrics).every((value) => Number.isSafeInteger(value) && value >= 0)
      || metrics.failedToolCalls > metrics.toolCalls) {
      throw new ObservationAuditError("corrupt", "Observation audit metrics summary is corrupt");
    }
    return {
      totalAttempts: lifecycles.running + lifecycles.completed + lifecycles.interrupted,
      completedAttempts: lifecycles.completed,
      interruptedAttempts: lifecycles.interrupted,
      runningAttempts: lifecycles.running,
      outcomes,
      dispositions,
      noProposalWithoutDisposition,
      measuredAttempts,
      metrics,
    };
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
  const metricValues = [
    row.duration_ms,
    row.input_tokens,
    row.output_tokens,
    row.reasoning_tokens,
    row.tool_calls,
    row.failed_tool_calls,
  ];
  const hasMetrics = metricValues.every((value) => value !== null && value !== undefined);
  const hasPartialMetrics = metricValues.some((value) => value !== null && value !== undefined) && !hasMetrics;
  const metrics = hasMetrics ? {
    durationMs: Number(row.duration_ms),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    toolCalls: Number(row.tool_calls),
    failedToolCalls: Number(row.failed_tool_calls),
  } : undefined;
  if (row.status !== "completed"
    || !isIsoTimestamp(completedAt)
    || Date.parse(completedAt) < Date.parse(startedAt)
    || !OUTCOMES.has(outcome)
    || (disposition !== undefined && (outcome !== "no_proposal" || !DISPOSITIONS.has(disposition)))
    || hasPartialMetrics
    || (metrics !== undefined && !validMetrics(metrics))) {
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
    ...(metrics === undefined ? {} : { metrics }),
  };
}

function validMetrics(value: ObservationRunMetrics): boolean {
  const counts = [
    value.durationMs,
    value.inputTokens,
    value.outputTokens,
    value.reasoningTokens,
    value.toolCalls,
    value.failedToolCalls,
  ];
  return counts.every((item) => Number.isSafeInteger(item) && item >= 0 && item <= 1_000_000_000_000)
    && value.durationMs <= 24 * 60 * 60 * 1_000
    && value.toolCalls <= 1_000
    && value.failedToolCalls <= value.toolCalls;
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
