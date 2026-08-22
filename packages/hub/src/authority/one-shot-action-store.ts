import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensurePrivateSqliteFiles } from "../sqlite-private-files.js";

/** The durable state owned by the one-shot action plane. */
export interface OneShotActionStoreState {
  readonly tickets: readonly Record<string, unknown>[];
  readonly activities: readonly Record<string, unknown>[];
  readonly expirySummaryCursor?: number;
}

export interface OneShotActionStore {
  load(): OneShotActionStoreState | undefined;
  save(state: OneShotActionStoreState): void;
}

/** A deterministic persistence seam for composition and domain tests. */
export class InMemoryOneShotActionStore implements OneShotActionStore {
  private value: OneShotActionStoreState | undefined;

  constructor(initial?: OneShotActionStoreState) {
    if (initial !== undefined) validateState(initial);
    this.value = initial === undefined ? undefined : clone(initial);
  }

  load(): OneShotActionStoreState | undefined {
    return this.value === undefined ? undefined : clone(this.value);
  }

  save(state: OneShotActionStoreState): void {
    validateState(state);
    this.value = clone(state);
  }
}

export interface SqliteOneShotActionStoreOptions {
  readonly path: string;
}

/** Private local SQLite persistence for execution tickets and activity. */
export class SqliteOneShotActionStore implements OneShotActionStore {
  private readonly db: DatabaseSync;
  private closed = false;
  readonly path: string;

  constructor(options: SqliteOneShotActionStoreOptions | string) {
    const path = typeof options === "string" ? options : options.path;
    if (typeof path !== "string" || path.length === 0) throw new TypeError("one-shot action store path is required");
    this.path = path;
    if (!isMemoryPath(path)) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS one_shot_action_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        state_json TEXT NOT NULL
      ) STRICT;
    `);
    this.ensurePrivateFiles();
  }

  load(): OneShotActionStoreState | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT state_json FROM one_shot_action_state WHERE singleton = 1").get() as
      | { state_json?: unknown }
      | undefined;
    if (row === undefined) return undefined;
    try {
      if (typeof row.state_json !== "string") throw new Error("state is not text");
      const parsed: unknown = JSON.parse(row.state_json);
      validateState(parsed);
      return clone(parsed);
    } catch {
      throw new Error("Stored one-shot action state is corrupt");
    }
  }

  save(state: OneShotActionStoreState): void {
    this.assertOpen();
    validateState(state);
    const serialized = JSON.stringify(state);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO one_shot_action_state (singleton, state_json)
        VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json`).run(serialized);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original SQLite failure.
      }
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
    if (this.closed) throw new Error("One-shot action store is closed");
  }

  private ensurePrivateFiles(): void {
    ensurePrivateSqliteFiles(this.path);
  }
}

function isMemoryPath(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateState(value: unknown): asserts value is OneShotActionStoreState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("one-shot action state is invalid");
  }
  const state = value as Record<string, unknown>;
  if (!Array.isArray(state.tickets) || !Array.isArray(state.activities)) {
    throw new Error("one-shot action state is invalid");
  }
  if (state.expirySummaryCursor !== undefined
    && (!Number.isSafeInteger(state.expirySummaryCursor)
      || (state.expirySummaryCursor as number) < 0
      || (state.expirySummaryCursor as number) > state.activities.length)) {
    throw new Error("one-shot action expiry cursor is invalid");
  }
  const ids = new Set<string>();
  for (const item of [...state.tickets, ...state.activities]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("one-shot action record is invalid");
    }
    const id = (item as Record<string, unknown>).id;
    if (typeof id !== "string" || id.length < 1 || id.length > 200 || ids.has(id)) {
      throw new Error("one-shot action record id is invalid");
    }
    ids.add(id);
  }
}
