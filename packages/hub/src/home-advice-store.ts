import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  parseHomeAdviceReport,
  type HomeAdviceReport,
} from "@hob-agent/agent-layer/home-advice-report";

import { ensurePrivateSqliteFiles } from "./sqlite-private-files.js";

export type HomeAdviceRecord = {
  readonly id: string;
  readonly question: string;
  readonly createdAt: string;
} & (
  | { readonly status: "running" }
  | { readonly status: "failed"; readonly completedAt: string }
  | { readonly status: "completed"; readonly completedAt: string; readonly report: HomeAdviceReport }
);

export interface HomeAdviceStore {
  begin(input: { readonly question: string; readonly createdAt: string }): string;
  complete(input: { readonly id: string; readonly report: HomeAdviceReport; readonly completedAt: string }): void;
  fail(input: { readonly id: string; readonly completedAt: string }): void;
  get(id: string): HomeAdviceRecord | undefined;
  list(query?: { readonly limit?: number }): readonly HomeAdviceRecord[];
}

export interface SqliteHomeAdviceStoreOptions {
  readonly path: string;
  readonly idFactory?: () => string;
}

type Row = Record<string, unknown>;

/** Private durable request/response documents; provider errors are never stored. */
export class SqliteHomeAdviceStore implements HomeAdviceStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly idFactory: () => string;
  private closed = false;

  constructor(options: SqliteHomeAdviceStoreOptions) {
    if (!options || typeof options.path !== "string" || options.path.length === 0) {
      throw new TypeError("home advice path is required");
    }
    this.path = options.path;
    this.idFactory = options.idFactory ?? randomUUID;
    if (this.path !== ":memory:" && !this.path.startsWith("file::memory:")) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS home_advice (
        advice_id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        report_json TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK ((status = 'running' AND report_json IS NULL AND completed_at IS NULL)
          OR (status = 'failed' AND report_json IS NULL AND completed_at IS NOT NULL)
          OR (status = 'completed' AND report_json IS NOT NULL AND completed_at IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS home_advice_created
        ON home_advice (created_at DESC, advice_id DESC);
    `);
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
      (advice_id, question, status, report_json, created_at, completed_at)
      VALUES (?, ?, 'running', NULL, ?, NULL)`).run(id, question, input.createdAt);
    this.ensurePrivateFiles();
    return id;
  }

  complete(input: { readonly id: string; readonly report: HomeAdviceReport; readonly completedAt: string }): void {
    const report = parseHomeAdviceReport(input?.report);
    this.finish(input?.id, input?.completedAt, "completed", JSON.stringify(report));
  }

  fail(input: { readonly id: string; readonly completedAt: string }): void {
    this.finish(input?.id, input?.completedAt, "failed", null);
  }

  get(id: string): HomeAdviceRecord | undefined {
    if (!isBoundedId(id)) throw new TypeError("Invalid home advice id");
    const row = this.db.prepare(`SELECT advice_id, question, status, report_json, created_at, completed_at
      FROM home_advice WHERE advice_id = ?`).get(id) as Row | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  list(query: { readonly limit?: number } = {}): readonly HomeAdviceRecord[] {
    const limit = query.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Invalid home advice query limit");
    }
    const rows = this.db.prepare(`SELECT advice_id, question, status, report_json, created_at, completed_at
      FROM home_advice ORDER BY created_at DESC, advice_id DESC LIMIT ?`).all(limit) as Row[];
    return rows.map(fromRow);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private finish(id: string, completedAt: string, status: "completed" | "failed", reportJson: string | null): void {
    if (!isBoundedId(id) || !isIsoTimestamp(completedAt)) throw new TypeError("Invalid home advice completion");
    const row = this.db.prepare("SELECT created_at, status FROM home_advice WHERE advice_id = ?").get(id) as Row | undefined;
    if (row?.status !== "running") throw new Error("Home advice lifecycle conflict");
    if (!isIsoTimestamp(row.created_at) || Date.parse(completedAt) < Date.parse(String(row.created_at))) {
      throw new TypeError("Invalid home advice completion time");
    }
    const result = this.db.prepare(`UPDATE home_advice
      SET status = ?, report_json = ?, completed_at = ?
      WHERE advice_id = ? AND status = 'running'`).run(status, reportJson, completedAt, id);
    this.ensurePrivateFiles();
    if (Number(result.changes) !== 1) throw new Error("Home advice lifecycle conflict");
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
  const completedAt = row.completed_at;
  if (!isBoundedId(id) || typeof question !== "string" || validateQuestion(question) !== question || !isIsoTimestamp(createdAt)) {
    throw new Error("Stored home advice is corrupt");
  }
  if (status === "running" && row.report_json === null && completedAt === null) {
    return { id, question, status, createdAt };
  }
  if (status === "failed" && row.report_json === null && isIsoTimestamp(completedAt)) {
    return { id, question, status, createdAt, completedAt };
  }
  if (status === "completed" && typeof row.report_json === "string" && isIsoTimestamp(completedAt)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.report_json);
    } catch {
      throw new Error("Stored home advice is corrupt");
    }
    return { id, question, status, createdAt, completedAt, report: parseHomeAdviceReport(parsed) };
  }
  throw new Error("Stored home advice is corrupt");
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length >= 1 && value.length <= 200;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && value.includes("T");
}
