import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  parseHomeAdviceReport,
  type HomeAdviceReport,
} from "@hob-agent/agent-layer/home-advice-report";

import { ensurePrivateSqliteFiles } from "./sqlite-private-files.js";

export type HomeAdviceProgressType =
  | "accepted"
  | "inspecting_home"
  | "reading_inventory"
  | "checking_rules"
  | "evaluating_evidence"
  | "composing_answer"
  | "background"
  | "completed"
  | "failed"
  | "cancelled";

export interface HomeAdviceProgressData {
  readonly adviceId: string;
  readonly at: string;
  readonly stage: HomeAdviceProgressType;
}

export interface HomeAdviceProgressEvent {
  /** Monotonic per-advice replay identifier. Older events may be pruned. */
  readonly id: number;
  readonly type: HomeAdviceProgressType;
  readonly data: HomeAdviceProgressData;
}

export type HomeAdviceCompletionStatus = "completed" | "failed" | "cancelled";

export interface HomeAdviceCompletionNotification {
  readonly adviceId: string;
  readonly status: HomeAdviceCompletionStatus;
  readonly completedAt: string;
  readonly eventId: number;
}

export type HomeAdviceRecord = {
  readonly id: string;
  readonly question: string;
  readonly createdAt: string;
} & (
  | { readonly status: "running" }
  | { readonly status: "background"; readonly backgroundAt: string }
  | { readonly status: "failed"; readonly completedAt: string; readonly backgroundAt?: string }
  | {
    readonly status: "completed";
    readonly completedAt: string;
    readonly report: HomeAdviceReport;
    readonly backgroundAt?: string;
  }
);

export interface HomeAdviceStore {
  begin(input: { readonly question: string; readonly createdAt: string }): string;
  background(input: { readonly id: string; readonly backgroundAt: string }): boolean;
  complete(input: { readonly id: string; readonly report: HomeAdviceReport; readonly completedAt: string }): boolean;
  fail(input: {
    readonly id: string;
    readonly completedAt: string;
    readonly eventType?: "failed" | "cancelled";
  }): boolean;
  appendProgress(input: {
    readonly id: string;
    readonly type: Exclude<HomeAdviceProgressType, "completed" | "failed" | "cancelled">;
    readonly at: string;
  }): HomeAdviceProgressEvent;
  events(id: string, afterSeq?: number): readonly HomeAdviceProgressEvent[];
  peekNextCompletionNotification(): HomeAdviceCompletionNotification | undefined;
  acknowledgeCompletionNotification(id: string): boolean;
  get(id: string): HomeAdviceRecord | undefined;
  list(query?: { readonly limit?: number; readonly status?: HomeAdviceRecord["status"] }): readonly HomeAdviceRecord[];
}

export interface SqliteHomeAdviceStoreOptions {
  readonly path: string;
  readonly idFactory?: () => string;
  /** Durable lifecycle events retained per advice; bounded to keep replay local. */
  readonly maxProgressEventsPerAdvice?: number;
}

type Row = Record<string, unknown>;

const EVENT_TYPES = [
  "accepted",
  "inspecting_home",
  "reading_inventory",
  "checking_rules",
  "evaluating_evidence",
  "composing_answer",
  "background",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly HomeAdviceProgressType[];

const NON_TERMINAL_EVENT_TYPES = [
  "accepted",
  "inspecting_home",
  "reading_inventory",
  "checking_rules",
  "evaluating_evidence",
  "composing_answer",
  "background",
] as const satisfies readonly Exclude<HomeAdviceProgressType, "completed" | "failed" | "cancelled">[];

/** Private durable request/response documents; provider errors and raw tool data are never stored. */
export class SqliteHomeAdviceStore implements HomeAdviceStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly idFactory: () => string;
  private readonly maxProgressEventsPerAdvice: number;
  private closed = false;

  constructor(options: SqliteHomeAdviceStoreOptions) {
    if (!options || typeof options.path !== "string" || options.path.length === 0) {
      throw new TypeError("home advice path is required");
    }
    this.path = options.path;
    this.idFactory = options.idFactory ?? randomUUID;
    this.maxProgressEventsPerAdvice = boundedOption(
      options.maxProgressEventsPerAdvice ?? 64,
      "home advice progress event limit",
      1,
      256,
    );
    if (this.path !== ":memory:" && !this.path.startsWith("file::memory:")) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.ensureSchema();
    // A running turn has no safe owner after a process restart. A background
    // turn is explicitly durable and is recovered by HomeAdviceService.
    this.db.prepare(`UPDATE home_advice SET status = 'failed', completed_at = created_at
      WHERE status = 'running'`).run();
    this.ensurePrivateFiles();
  }

  begin(input: { readonly question: string; readonly createdAt: string }): string {
    const question = validateQuestion(input?.question);
    if (!isIsoTimestamp(input?.createdAt)) throw new TypeError("Invalid home advice creation time");
    const id = this.idFactory();
    if (!isBoundedId(id)) throw new TypeError("Invalid home advice id");
    this.db.prepare(`INSERT INTO home_advice
      (advice_id, question, status, report_json, created_at, background_at, completed_at, completion_notification_pending)
      VALUES (?, ?, 'running', NULL, ?, NULL, NULL, 0)`).run(id, question, input.createdAt);
    this.ensurePrivateFiles();
    return id;
  }

  background(input: { readonly id: string; readonly backgroundAt: string }): boolean {
    if (!isBoundedId(input?.id) || !isIsoTimestamp(input?.backgroundAt)) {
      throw new TypeError("Invalid home advice background transition");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT created_at, status FROM home_advice WHERE advice_id = ?`)
        .get(input.id) as Row | undefined;
      if (row?.status !== "running") {
        this.db.exec("ROLLBACK");
        return false;
      }
      if (!isIsoTimestamp(row.created_at) || Date.parse(input.backgroundAt) < Date.parse(row.created_at)) {
        throw new TypeError("Invalid home advice background time");
      }
      this.insertProgress(input.id, "background", input.backgroundAt);
      const result = this.db.prepare(`UPDATE home_advice
        SET status = 'background', background_at = ?
        WHERE advice_id = ? AND status = 'running'`).run(input.backgroundAt, input.id);
      if (Number(result.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.exec("COMMIT");
      this.ensurePrivateFiles();
      return true;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  complete(input: { readonly id: string; readonly report: HomeAdviceReport; readonly completedAt: string }): boolean {
    const report = parseHomeAdviceReport(input?.report);
    return this.finish(input?.id, input?.completedAt, "completed", JSON.stringify(report), "completed");
  }

  fail(input: {
    readonly id: string;
    readonly completedAt: string;
    readonly eventType?: "failed" | "cancelled";
  }): boolean {
    const eventType = input?.eventType ?? "failed";
    return this.finish(input?.id, input?.completedAt, eventType, null, eventType);
  }

  appendProgress(input: {
    readonly id: string;
    readonly type: Exclude<HomeAdviceProgressType, "completed" | "failed" | "cancelled">;
    readonly at: string;
  }): HomeAdviceProgressEvent {
    if (!isBoundedId(input?.id) || !isNonTerminalProgressType(input?.type) || !isIsoTimestamp(input?.at)) {
      throw new TypeError("Invalid home advice progress event");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT status FROM home_advice WHERE advice_id = ?`).get(input.id) as Row | undefined;
      if (row?.status !== "running" && row?.status !== "background") {
        throw new Error("Home advice progress lifecycle conflict");
      }
      const event = this.insertProgress(input.id, input.type, input.at);
      this.db.exec("COMMIT");
      this.ensurePrivateFiles();
      return event;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  events(id: string, afterSeq = 0): readonly HomeAdviceProgressEvent[] {
    if (!isBoundedId(id)) throw new TypeError("Invalid home advice id");
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new TypeError("Invalid home advice progress cursor");
    const rows = this.db.prepare(`SELECT event_id, stage, event_at
      FROM home_advice_events WHERE advice_id = ? AND event_id > ? ORDER BY event_id ASC`).all(id, afterSeq) as Row[];
    return rows.map((row) => fromEventRow(id, row));
  }

  /** Reads the oldest notification while acknowledgement remains an explicit product step. */
  peekNextCompletionNotification(): HomeAdviceCompletionNotification | undefined {
    const row = this.db.prepare(`SELECT advice_id, status, completed_at, completion_notification_pending
      FROM home_advice
      WHERE completion_notification_pending = 1 AND status IN ('completed', 'failed')
      ORDER BY completed_at ASC, advice_id ASC LIMIT 1`).get() as Row | undefined;
    return row === undefined ? undefined : this.completionNotificationFromRow(row);
  }

  acknowledgeCompletionNotification(id: string): boolean {
    if (!isBoundedId(id)) throw new TypeError("Invalid home advice id");
    const result = this.db.prepare(`UPDATE home_advice SET completion_notification_pending = 0
      WHERE advice_id = ? AND completion_notification_pending = 1
        AND status IN ('completed', 'failed')`).run(id);
    this.ensurePrivateFiles();
    return Number(result.changes) === 1;
  }

  private completionNotificationFromRow(row: Row): HomeAdviceCompletionNotification {
    const adviceId = row.advice_id;
    if (!isBoundedId(adviceId) || !isIsoTimestamp(row.completed_at)) {
      throw new Error("Stored home advice completion is corrupt");
    }
    const eventRow = this.db.prepare(`SELECT event_id, stage
      FROM home_advice_events WHERE advice_id = ? ORDER BY event_id DESC LIMIT 1`).get(adviceId) as Row | undefined;
    if (typeof eventRow?.event_id !== "number"
      || !Number.isSafeInteger(eventRow.event_id)
      || !isCompletionEventType(eventRow.stage)) {
      throw new Error("Stored home advice completion is corrupt");
    }
    return {
      adviceId,
      status: eventRow.stage,
      completedAt: row.completed_at,
      eventId: eventRow.event_id,
    };
  }

  get(id: string): HomeAdviceRecord | undefined {
    if (!isBoundedId(id)) throw new TypeError("Invalid home advice id");
    const row = this.db.prepare(`SELECT advice_id, question, status, report_json, created_at, background_at, completed_at
      FROM home_advice WHERE advice_id = ?`).get(id) as Row | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  list(query: { readonly limit?: number; readonly status?: HomeAdviceRecord["status"] } = {}): readonly HomeAdviceRecord[] {
    const limit = query.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Invalid home advice query limit");
    }
    if (query.status !== undefined && !isRecordStatus(query.status)) {
      throw new TypeError("Invalid home advice status filter");
    }
    const statement = query.status === undefined
      ? `SELECT advice_id, question, status, report_json, created_at, background_at, completed_at
        FROM home_advice ORDER BY created_at DESC, advice_id DESC LIMIT ?`
      : `SELECT advice_id, question, status, report_json, created_at, background_at, completed_at
        FROM home_advice WHERE status = ? ORDER BY created_at DESC, advice_id DESC LIMIT ?`;
    const rows = query.status === undefined
      ? this.db.prepare(statement).all(limit) as Row[]
      : this.db.prepare(statement).all(query.status, limit) as Row[];
    return rows.map(fromRow);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private finish(
    id: string,
    completedAt: string,
    status: "completed" | "failed" | "cancelled",
    reportJson: string | null,
    eventType: "completed" | "failed" | "cancelled",
  ): boolean {
    if (!isBoundedId(id) || !isIsoTimestamp(completedAt)) throw new TypeError("Invalid home advice completion");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT created_at, background_at, status FROM home_advice WHERE advice_id = ?`)
        .get(id) as Row | undefined;
      if (row?.status !== "running" && row?.status !== "background") {
        this.db.exec("ROLLBACK");
        return false;
      }
      const lowerBound = row.status === "background" ? row.background_at : row.created_at;
      if (!isIsoTimestamp(lowerBound) || Date.parse(completedAt) < Date.parse(lowerBound)) {
        throw new TypeError("Invalid home advice completion time");
      }
      this.insertProgress(id, eventType, completedAt);
      const result = this.db.prepare(`UPDATE home_advice
        SET status = ?, report_json = ?, completed_at = ?, completion_notification_pending = 1
        WHERE advice_id = ? AND status IN ('running', 'background')`).run(
        status === "cancelled" ? "failed" : status,
        reportJson,
        completedAt,
        id,
      );
      if (Number(result.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.exec("COMMIT");
      this.ensurePrivateFiles();
      return true;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  private insertProgress(
    adviceId: string,
    type: HomeAdviceProgressType,
    at: string,
  ): HomeAdviceProgressEvent {
    const previous = this.db.prepare(`SELECT MAX(event_id) AS event_id
      FROM home_advice_events WHERE advice_id = ?`).get(adviceId) as Row | undefined;
    const previousId = previous?.event_id;
    const eventId = previousId === null || previousId === undefined ? 1 : Number(previousId) + 1;
    if (!Number.isSafeInteger(eventId)) throw new Error("Home advice progress cursor exhausted");
    this.db.prepare(`INSERT INTO home_advice_events (advice_id, event_id, stage, event_at)
      VALUES (?, ?, ?, ?)`).run(adviceId, eventId, type, at);
    const pruneBeforeOrAt = eventId - this.maxProgressEventsPerAdvice;
    if (pruneBeforeOrAt > 0) {
      this.db.prepare(`DELETE FROM home_advice_events WHERE advice_id = ? AND event_id <= ?`)
        .run(adviceId, pruneBeforeOrAt);
    }
    return {
      id: eventId,
      type,
      data: { adviceId, at, stage: type },
    };
  }

  private ensureSchema(): void {
    const existing = this.db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'home_advice'`).get() as Row | undefined;
    if (existing !== undefined) {
      const columns = new Set(
        (this.db.prepare("PRAGMA table_info(home_advice)").all() as Row[])
          .map((row) => row.name)
          .filter((name): name is string => typeof name === "string"),
      );
      if (!columns.has("background_at") || !columns.has("completion_notification_pending")) {
        this.migrateLegacyTable();
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS home_advice (
        advice_id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'background', 'completed', 'failed')),
        report_json TEXT,
        created_at TEXT NOT NULL,
        background_at TEXT,
        completed_at TEXT,
        completion_notification_pending INTEGER NOT NULL DEFAULT 0
          CHECK (completion_notification_pending IN (0, 1)),
        CHECK ((status = 'running' AND report_json IS NULL AND background_at IS NULL
          AND completed_at IS NULL AND completion_notification_pending = 0)
          OR (status = 'background' AND report_json IS NULL AND background_at IS NOT NULL
            AND completed_at IS NULL AND completion_notification_pending = 0)
          OR (status = 'failed' AND report_json IS NULL AND completed_at IS NOT NULL)
          OR (status = 'completed' AND report_json IS NOT NULL AND completed_at IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS home_advice_created
        ON home_advice (created_at DESC, advice_id DESC);
      CREATE TABLE IF NOT EXISTS home_advice_events (
        advice_id TEXT NOT NULL,
        event_id INTEGER NOT NULL CHECK (event_id >= 1),
        stage TEXT NOT NULL CHECK (stage IN (
          'accepted', 'inspecting_home', 'reading_inventory', 'checking_rules',
          'evaluating_evidence', 'composing_answer', 'background', 'completed',
          'failed', 'cancelled'
        )),
        event_at TEXT NOT NULL,
        PRIMARY KEY (advice_id, event_id),
        FOREIGN KEY (advice_id) REFERENCES home_advice(advice_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS home_advice_events_cursor
        ON home_advice_events (advice_id, event_id ASC);
    `);
  }

  private migrateLegacyTable(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const legacy = "home_advice_legacy_upgrade";
      const existingLegacy = this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(legacy) as Row | undefined;
      if (existingLegacy !== undefined) throw new Error("Home advice schema migration is already in progress");
      this.db.exec(`ALTER TABLE home_advice RENAME TO ${legacy};`);
      this.db.exec("DROP INDEX IF EXISTS home_advice_created;");
      this.createAdviceTable();
      this.db.exec(`INSERT INTO home_advice
        (advice_id, question, status, report_json, created_at, background_at, completed_at, completion_notification_pending)
        SELECT advice_id, question, status, report_json, created_at, NULL, completed_at, 0
        FROM ${legacy};
        DROP TABLE ${legacy};`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  private createAdviceTable(): void {
    this.db.exec(`CREATE TABLE home_advice (
      advice_id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'background', 'completed', 'failed')),
      report_json TEXT,
      created_at TEXT NOT NULL,
      background_at TEXT,
      completed_at TEXT,
      completion_notification_pending INTEGER NOT NULL DEFAULT 0
        CHECK (completion_notification_pending IN (0, 1)),
      CHECK ((status = 'running' AND report_json IS NULL AND background_at IS NULL
        AND completed_at IS NULL AND completion_notification_pending = 0)
        OR (status = 'background' AND report_json IS NULL AND background_at IS NOT NULL
          AND completed_at IS NULL AND completion_notification_pending = 0)
        OR (status = 'failed' AND report_json IS NULL AND completed_at IS NOT NULL)
        OR (status = 'completed' AND report_json IS NOT NULL AND completed_at IS NOT NULL))
    ) STRICT;`);
  }

  private rollback(): void {
    try {
      this.db.exec("ROLLBACK");
    } catch {
      // The transaction already rolled back or the database is closing.
    }
  }

  private ensurePrivateFiles(): void {
    ensurePrivateSqliteFiles(this.path);
  }
}

export function validateHomeAdviceQuestion(value: unknown): string {
  return validateQuestion(value);
}

function validateQuestion(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Home advice question must be text");
  const question = value.trim();
  if (question.length < 1 || question.length > 1_000) {
    throw new TypeError("Home advice question must contain from 1 to 1000 characters");
  }
  return question;
}

function fromRow(row: Row): HomeAdviceRecord {
  const id = row.advice_id;
  const question = row.question;
  const status = row.status;
  const createdAt = row.created_at;
  const backgroundAt = row.background_at;
  const completedAt = row.completed_at;
  if (!isBoundedId(id) || typeof question !== "string" || validateQuestion(question) !== question || !isIsoTimestamp(createdAt)) {
    throw new Error("Stored home advice is corrupt");
  }
  if (status === "running" && row.report_json === null && backgroundAt === null && completedAt === null) {
    return { id, question, status, createdAt };
  }
  if (status === "background" && row.report_json === null && isIsoTimestamp(backgroundAt) && completedAt === null) {
    return { id, question, status, createdAt, backgroundAt };
  }
  if (status === "failed" && row.report_json === null && isIsoTimestamp(completedAt)) {
    return {
      id,
      question,
      status,
      createdAt,
      completedAt,
      ...(isIsoTimestamp(backgroundAt) ? { backgroundAt } : {}),
    };
  }
  if (status === "completed" && typeof row.report_json === "string" && isIsoTimestamp(completedAt)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.report_json);
    } catch {
      throw new Error("Stored home advice is corrupt");
    }
    return {
      id,
      question,
      status,
      createdAt,
      completedAt,
      report: parseHomeAdviceReport(parsed),
      ...(isIsoTimestamp(backgroundAt) ? { backgroundAt } : {}),
    };
  }
  throw new Error("Stored home advice is corrupt");
}

function fromEventRow(adviceId: string, row: Row): HomeAdviceProgressEvent {
  const id = row.event_id;
  const type = row.stage;
  const at = row.event_at;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || !isProgressType(type) || !isIsoTimestamp(at)) {
    throw new Error("Stored home advice progress is corrupt");
  }
  return { id, type, data: { adviceId, at, stage: type } };
}

function isNonTerminalProgressType(value: unknown): value is Exclude<HomeAdviceProgressType, "completed" | "failed" | "cancelled"> {
  return typeof value === "string" && (NON_TERMINAL_EVENT_TYPES as readonly string[]).includes(value);
}

function isProgressType(value: unknown): value is HomeAdviceProgressType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

function isCompletionEventType(value: unknown): value is HomeAdviceCompletionStatus {
  return value === "completed" || value === "failed" || value === "cancelled";
}

function isRecordStatus(value: unknown): value is HomeAdviceRecord["status"] {
  return value === "running" || value === "background" || value === "completed" || value === "failed";
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length >= 1 && value.length <= 200;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && value.includes("T");
}

function boundedOption(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be from ${minimum} to ${maximum}`);
  }
  return value;
}
