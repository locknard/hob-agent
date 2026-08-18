import { DatabaseSync } from "node:sqlite";

import type {
  BridgeBindingRecord,
  BridgeRegistryStore,
} from "./bridge-registry.js";
import { ensurePrivateSqliteFiles } from "./sqlite-private-files.js";

type SqlRow = Record<string, unknown>;

/**
 * Small durable identity store for the bridge registry. It intentionally owns
 * only registry bindings; ingest events and world state remain in the journal
 * boundary. A save is one SQLite transaction, so a restart cannot observe a
 * partially written identity record.
 */
export class SqliteBridgeRegistryStore implements BridgeRegistryStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    if (typeof path !== "string" || path.length === 0) throw new TypeError("registry path is required");
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_registry (
        bridge_id TEXT PRIMARY KEY,
        adapter_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        generation INTEGER NOT NULL,
        remote_instance_id TEXT
      ) STRICT;
    `);
    this.ensurePrivateFile();
  }

  get(bridgeId: string): BridgeBindingRecord | undefined {
    const row = this.db.prepare(`SELECT bridge_id, adapter_type, created_at, generation, remote_instance_id
      FROM bridge_registry WHERE bridge_id = ?`).get(bridgeId) as SqlRow | undefined;
    if (row === undefined) return undefined;
    return fromRow(row);
  }

  save(record: BridgeBindingRecord): void {
    validateRecord(record);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO bridge_registry
        (bridge_id, adapter_type, created_at, generation, remote_instance_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(bridge_id) DO UPDATE SET
          adapter_type = excluded.adapter_type,
          created_at = excluded.created_at,
          generation = excluded.generation,
          remote_instance_id = excluded.remote_instance_id`).run(
        record.bridgeId,
        record.adapterType,
        record.createdAt,
        record.generation,
        record.remoteInstanceId ?? null,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFile();
    }
  }

  list(): readonly BridgeBindingRecord[] {
    const rows = this.db.prepare(`SELECT bridge_id, adapter_type, created_at, generation, remote_instance_id
      FROM bridge_registry ORDER BY bridge_id`).all() as SqlRow[];
    return rows.map(fromRow);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private ensurePrivateFile(): void {
    ensurePrivateSqliteFiles(this.path);
  }
}

function validateRecord(record: BridgeBindingRecord): void {
  if (!record || typeof record !== "object") throw new TypeError("registry record is required");
  for (const [name, value] of [
    ["bridgeId", record.bridgeId],
    ["adapterType", record.adapterType],
    ["createdAt", record.createdAt],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) throw new TypeError(`registry ${name} is required`);
  }
  if (!Number.isSafeInteger(record.generation) || record.generation < 1) {
    throw new TypeError("registry generation must be a positive safe integer");
  }
  if (record.remoteInstanceId !== undefined
    && (typeof record.remoteInstanceId !== "string" || record.remoteInstanceId.length === 0)) {
    throw new TypeError("registry remoteInstanceId must be non-empty when present");
  }
}

function fromRow(row: SqlRow): BridgeBindingRecord {
  const remoteInstanceId = row.remote_instance_id === null || row.remote_instance_id === undefined
    ? undefined
    : String(row.remote_instance_id);
  return {
    bridgeId: String(row.bridge_id),
    adapterType: String(row.adapter_type),
    createdAt: String(row.created_at),
    generation: Number(row.generation),
    ...(remoteInstanceId === undefined ? {} : { remoteInstanceId }),
  };
}
