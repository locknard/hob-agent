import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensurePrivateSqliteFiles } from "../sqlite-private-files.js";

export type HomeSafetyKind = "water_leak" | "smoke" | "gas" | "door_open" | "lock_unlocked";
export type HomeSafetyAlertStatus = "active" | "acknowledged" | "contained" | "resolved";

/** Durable, Hub-owned incident state. The source capability is always retained. */
export interface HomeSafetyAlertRecord {
  readonly id: string;
  readonly bindingId: string;
  readonly hwCapabilityId: string;
  readonly kind: HomeSafetyKind;
  readonly status: HomeSafetyAlertStatus;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly acknowledgedAt?: string;
  readonly acknowledgedBy?: string;
  readonly resolvedAt?: string;
}

export interface HomeSafetyStore {
  load(): readonly HomeSafetyAlertRecord[];
  save(records: readonly HomeSafetyAlertRecord[]): void;
}

/** Deterministic persistence seam for Hub safety tests and embeddings. */
export class InMemoryHomeSafetyStore implements HomeSafetyStore {
  private records: HomeSafetyAlertRecord[] = [];

  constructor(initial: readonly HomeSafetyAlertRecord[] = []) {
    validateRecords(initial);
    this.records = cloneRecords(initial);
  }

  load(): readonly HomeSafetyAlertRecord[] {
    return cloneRecords(this.records);
  }

  save(records: readonly HomeSafetyAlertRecord[]): void {
    validateRecords(records);
    this.records = cloneRecords(records);
  }
}

export interface SqliteHomeSafetyStoreOptions {
  readonly path: string;
}

/** Private local SQLite persistence for active and acknowledged incidents. */
export class SqliteHomeSafetyStore implements HomeSafetyStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(options: SqliteHomeSafetyStoreOptions | string) {
    const path = typeof options === "string" ? options : options.path;
    if (typeof path !== "string" || path.length === 0) throw new TypeError("home safety store path is required");
    this.path = path;
    if (!isMemoryPath(path)) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS home_safety_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        state_json TEXT NOT NULL
      ) STRICT;
    `);
    this.ensurePrivateFiles();
  }

  load(): readonly HomeSafetyAlertRecord[] {
    this.assertOpen();
    const row = this.db.prepare("SELECT state_json FROM home_safety_state WHERE singleton = 1").get() as
      | { state_json?: unknown }
      | undefined;
    if (row === undefined) return [];
    try {
      if (typeof row.state_json !== "string") throw new Error("state is not text");
      const parsed: unknown = JSON.parse(row.state_json);
      if (!Array.isArray(parsed)) throw new Error("state is not an array");
      validateRecords(parsed);
      return cloneRecords(parsed);
    } catch {
      throw new Error("Stored home safety state is corrupt");
    }
  }

  save(records: readonly HomeSafetyAlertRecord[]): void {
    this.assertOpen();
    validateRecords(records);
    const serialized = JSON.stringify(records);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO home_safety_state (singleton, state_json)
        VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json`).run(serialized);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the SQLite error */ }
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

  private assertOpen(): void {
    if (this.closed) throw new Error("Home safety store is closed");
  }

  private ensurePrivateFiles(): void {
    ensurePrivateSqliteFiles(this.path);
  }
}

function cloneRecords(records: readonly HomeSafetyAlertRecord[]): HomeSafetyAlertRecord[] {
  return records.map((record) => ({ ...record }));
}

function validateRecords(value: readonly HomeSafetyAlertRecord[]): void {
  if (!Array.isArray(value)) throw new TypeError("Home safety records must be an array");
  const ids = new Set<string>();
  for (const record of value) {
    if (!isRecord(record)
      || !boundedText(record.id, 200)
      || !boundedText(record.bindingId, 200)
      || !boundedText(record.hwCapabilityId, 256)
      || !isSafetyKind(record.kind)
      || !isSafetyStatus(record.status)
      || !isIsoTimestamp(record.firstObservedAt)
      || !isIsoTimestamp(record.lastObservedAt)
      || ids.has(record.id)) {
      throw new TypeError("Home safety alert record is invalid");
    }
    ids.add(record.id);
    if (record.acknowledgedAt !== undefined && !isIsoTimestamp(record.acknowledgedAt)) {
      throw new TypeError("Home safety acknowledgement time is invalid");
    }
    if (record.acknowledgedBy !== undefined && !boundedText(record.acknowledgedBy, 200)) {
      throw new TypeError("Home safety acknowledgement actor is invalid");
    }
    if (record.resolvedAt !== undefined && !isIsoTimestamp(record.resolvedAt)) {
      throw new TypeError("Home safety resolution time is invalid");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;
}

function isSafetyKind(value: unknown): value is HomeSafetyKind {
  return value === "water_leak" || value === "smoke" || value === "gas" || value === "door_open" || value === "lock_unlocked";
}

function isSafetyStatus(value: unknown): value is HomeSafetyAlertStatus {
  return value === "active" || value === "acknowledged" || value === "contained" || value === "resolved";
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && value === new Date(value).toISOString();
}

function isMemoryPath(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}
