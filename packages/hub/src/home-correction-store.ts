import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensurePrivateSqliteFiles } from "./sqlite-private-files.js";

export type HomeCorrectionType = "household_fact" | "household_preference" | "future_behavior";
export type HomeCorrectionOutcome = "updated" | "proposal_created";

export interface HomeCorrectionAuditRecord {
  readonly id: string;
  readonly adviceId: string;
  readonly actorId: string;
  readonly correctionType: HomeCorrectionType;
  readonly correction: string;
  readonly idempotencyKey: string;
  readonly outcome: HomeCorrectionOutcome;
  readonly destination: string;
  readonly proposalId?: string;
  readonly proposalCount?: number;
  readonly createdAt: string;
}

export interface HomeCorrectionReservation {
  readonly id: string;
  readonly adviceId: string;
  readonly actorId: string;
  readonly correctionType: HomeCorrectionType;
  readonly correction: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly ownerId: string;
  readonly leaseUntil: string;
}

export interface HomeCorrectionReservationInput {
  readonly id: string;
  readonly adviceId: string;
  readonly actorId: string;
  readonly correctionType: HomeCorrectionType;
  readonly correction: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export type HomeCorrectionReservationClaim =
  | { readonly status: "acquired"; readonly reservation: HomeCorrectionReservation }
  | { readonly status: "busy"; readonly reservation: HomeCorrectionReservation }
  | { readonly status: "committed"; readonly record: HomeCorrectionAuditRecord };

export interface HomeCorrectionStore {
  findByActorAndIdempotencyKey(actorId: string, idempotencyKey: string): HomeCorrectionAuditRecord | undefined;
  findLatestForAdvice(adviceId: string, actorId: string): HomeCorrectionAuditRecord | undefined;
  reserve(
    input: HomeCorrectionReservationInput,
    ownerId: string,
    now: string,
    leaseMs: number,
  ): HomeCorrectionReservationClaim;
  complete(ownerId: string, record: HomeCorrectionAuditRecord): HomeCorrectionAuditRecord;
  listAudit(): readonly HomeCorrectionAuditRecord[];
  close?(): void;
}

export interface FileHomeCorrectionStoreOptions {
  readonly path: string;
}

/** Durable local audit/idempotency state for explicit conversation corrections. */
export class FileHomeCorrectionStore implements HomeCorrectionStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(options: FileHomeCorrectionStoreOptions) {
    if (!options || typeof options.path !== "string" || options.path.trim() === "") {
      throw new TypeError("Home correction store path is required");
    }
    this.path = options.path;
    if (!isMemoryPath(this.path)) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      this.db = new DatabaseSync(this.path);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS home_correction_audit (
          id TEXT PRIMARY KEY,
          advice_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          correction_type TEXT NOT NULL,
          correction_text TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          outcome TEXT NOT NULL,
          destination TEXT NOT NULL,
          proposal_id TEXT,
          proposal_count INTEGER,
          created_at TEXT NOT NULL,
          UNIQUE(actor_id, idempotency_key)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS home_correction_advice_actor
          ON home_correction_audit(advice_id, actor_id, created_at DESC, id DESC);
        CREATE TABLE IF NOT EXISTS home_correction_reservations (
          id TEXT PRIMARY KEY,
          advice_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          correction_type TEXT NOT NULL,
          correction_text TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          lease_until TEXT NOT NULL,
          UNIQUE(actor_id, idempotency_key)
        ) STRICT;
      `);
      const columns = this.db.prepare("PRAGMA table_info(home_correction_audit)").all() as readonly { name?: unknown }[];
      if (!columns.some((column) => column.name === "correction_text")) {
        this.db.exec("ALTER TABLE home_correction_audit ADD COLUMN correction_text TEXT NOT NULL DEFAULT ''");
      }
      ensurePrivateSqliteFiles(this.path);
    } catch {
      throw new HomeCorrectionStoreError("io", "Unable to open home correction store");
    }
  }

  findByActorAndIdempotencyKey(actorId: string, idempotencyKey: string): HomeCorrectionAuditRecord | undefined {
    this.assertOpen();
    const row = this.db.prepare(`SELECT id, advice_id, actor_id, correction_type, correction_text, idempotency_key,
      outcome, destination, proposal_id, proposal_count, created_at
      FROM home_correction_audit WHERE actor_id = ? AND idempotency_key = ?`).get(actorId, idempotencyKey) as RawCorrectionRow | undefined;
    return row === undefined ? undefined : parseRecord(row);
  }

  findLatestForAdvice(adviceId: string, actorId: string): HomeCorrectionAuditRecord | undefined {
    this.assertOpen();
    const row = this.db.prepare(`SELECT id, advice_id, actor_id, correction_type, correction_text, idempotency_key,
      outcome, destination, proposal_id, proposal_count, created_at
      FROM home_correction_audit WHERE advice_id = ? AND actor_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(adviceId, actorId) as RawCorrectionRow | undefined;
    return row === undefined ? undefined : parseRecord(row);
  }

  reserve(
    input: HomeCorrectionReservationInput,
    ownerId: string,
    now: string,
    leaseMs: number,
  ): HomeCorrectionReservationClaim {
    this.assertOpen();
    const parsed = validateReservationInput(input);
    validateOwnerAndLease(ownerId, now, leaseMs);
    const leaseUntil = leaseUntilFor(now, leaseMs);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const committed = this.selectAuditByKey(parsed.actorId, parsed.idempotencyKey);
      if (committed !== undefined) {
        this.db.exec("COMMIT");
        return { status: "committed", record: committed };
      }
      const existingRow = this.db.prepare(`SELECT id, advice_id, actor_id, correction_type, correction_text,
        idempotency_key, created_at, owner_id, lease_until
        FROM home_correction_reservations WHERE actor_id = ? AND idempotency_key = ?`)
        .get(parsed.actorId, parsed.idempotencyKey) as RawReservationRow | undefined;
      if (existingRow !== undefined) {
        const existing = parseReservation(existingRow);
        if (existing.ownerId === ownerId || Date.parse(existing.leaseUntil) <= Date.parse(now)) {
          this.db.prepare(`UPDATE home_correction_reservations
            SET owner_id = ?, lease_until = ? WHERE actor_id = ? AND idempotency_key = ?`)
            .run(ownerId, leaseUntil, parsed.actorId, parsed.idempotencyKey);
          this.db.exec("COMMIT");
          return {
            status: "acquired",
            reservation: { ...existing, ownerId, leaseUntil },
          };
        }
        this.db.exec("COMMIT");
        return { status: "busy", reservation: existing };
      }
      this.db.prepare(`INSERT INTO home_correction_reservations
        (id, advice_id, actor_id, correction_type, correction_text, idempotency_key, created_at, owner_id, lease_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(parsed.id, parsed.adviceId, parsed.actorId, parsed.correctionType, parsed.correction,
          parsed.idempotencyKey, parsed.createdAt, ownerId, leaseUntil);
      this.db.exec("COMMIT");
      return {
        status: "acquired",
        reservation: { ...parsed, ownerId, leaseUntil },
      };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the persistence error */ }
      if (error instanceof HomeCorrectionStoreError) throw error;
      throw new HomeCorrectionStoreError("io", error instanceof Error ? error.message : "Unable to reserve correction");
    } finally {
      ensurePrivateSqliteFiles(this.path);
    }
  }

  complete(ownerId: string, record: HomeCorrectionAuditRecord): HomeCorrectionAuditRecord {
    this.assertOpen();
    const parsed = validateAuditRecord(record);
    if (typeof ownerId !== "string" || ownerId.trim() === "") {
      throw new HomeCorrectionStoreError("io", "Correction reservation owner is invalid");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.selectAuditByKey(parsed.actorId, parsed.idempotencyKey);
      if (existing !== undefined) {
        this.db.prepare(`DELETE FROM home_correction_reservations
          WHERE actor_id = ? AND idempotency_key = ?`)
          .run(parsed.actorId, parsed.idempotencyKey);
        this.db.exec("COMMIT");
        return existing;
      }
      const reservationRow = this.db.prepare(`SELECT id, advice_id, actor_id, correction_type, correction_text,
        idempotency_key, created_at, owner_id, lease_until
        FROM home_correction_reservations WHERE actor_id = ? AND idempotency_key = ?`)
        .get(parsed.actorId, parsed.idempotencyKey) as RawReservationRow | undefined;
      if (reservationRow === undefined) {
        throw new HomeCorrectionStoreError("conflict", "Correction reservation is missing");
      }
      const reservation = parseReservation(reservationRow);
      if (reservation.ownerId !== ownerId || !reservationMatchesRecord(reservation, parsed)) {
        throw new HomeCorrectionStoreError("conflict", "Correction reservation is not owned by this operation");
      }
      this.db.prepare(`INSERT INTO home_correction_audit
        (id, advice_id, actor_id, correction_type, correction_text, idempotency_key, outcome, destination, proposal_id, proposal_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(parsed.id, parsed.adviceId, parsed.actorId, parsed.correctionType, parsed.correction, parsed.idempotencyKey,
          parsed.outcome, parsed.destination, parsed.proposalId ?? null, parsed.proposalCount ?? null, parsed.createdAt);
      this.db.prepare(`DELETE FROM home_correction_reservations
        WHERE actor_id = ? AND idempotency_key = ? AND owner_id = ?`)
        .run(parsed.actorId, parsed.idempotencyKey, ownerId);
      this.db.exec("COMMIT");
      return parsed;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the persistence error */ }
      if (error instanceof HomeCorrectionStoreError) throw error;
      throw new HomeCorrectionStoreError("io", error instanceof Error ? error.message : "Unable to complete correction");
    } finally {
      ensurePrivateSqliteFiles(this.path);
    }
  }

  listAudit(): readonly HomeCorrectionAuditRecord[] {
    this.assertOpen();
    const rows = this.db.prepare(`SELECT id, advice_id, actor_id, correction_type, correction_text, idempotency_key,
      outcome, destination, proposal_id, proposal_count, created_at
      FROM home_correction_audit ORDER BY created_at ASC, id ASC`).all() as RawCorrectionRow[];
    return rows.map(parseRecord);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new HomeCorrectionStoreError("io", "Home correction store is closed");
  }

  private selectAuditByKey(actorId: string, idempotencyKey: string): HomeCorrectionAuditRecord | undefined {
    const row = this.db.prepare(`SELECT id, advice_id, actor_id, correction_type, correction_text, idempotency_key,
      outcome, destination, proposal_id, proposal_count, created_at
      FROM home_correction_audit WHERE actor_id = ? AND idempotency_key = ?`)
      .get(actorId, idempotencyKey) as RawCorrectionRow | undefined;
    return row === undefined ? undefined : parseRecord(row);
  }
}

/** Deterministic test/embedding store; production supplies FileHomeCorrectionStore. */
export class InMemoryHomeCorrectionStore implements HomeCorrectionStore {
  private readonly records: HomeCorrectionAuditRecord[] = [];
  private readonly reservations = new Map<string, HomeCorrectionReservation>();

  findByActorAndIdempotencyKey(actorId: string, idempotencyKey: string): HomeCorrectionAuditRecord | undefined {
    return this.records.find((record) => record.actorId === actorId && record.idempotencyKey === idempotencyKey);
  }

  findLatestForAdvice(adviceId: string, actorId: string): HomeCorrectionAuditRecord | undefined {
    return [...this.records].reverse().find((record) => record.adviceId === adviceId && record.actorId === actorId);
  }

  reserve(
    input: HomeCorrectionReservationInput,
    ownerId: string,
    now: string,
    leaseMs: number,
  ): HomeCorrectionReservationClaim {
    const parsed = validateReservationInput(input);
    validateOwnerAndLease(ownerId, now, leaseMs);
    const committed = this.findByActorAndIdempotencyKey(parsed.actorId, parsed.idempotencyKey);
    if (committed !== undefined) return { status: "committed", record: committed };
    const key = reservationKey(parsed.actorId, parsed.idempotencyKey);
    const existing = this.reservations.get(key);
    const leaseUntil = leaseUntilFor(now, leaseMs);
    if (existing !== undefined) {
      if (existing.ownerId === ownerId || Date.parse(existing.leaseUntil) <= Date.parse(now)) {
        const acquired = { ...existing, ownerId, leaseUntil };
        this.reservations.set(key, acquired);
        return { status: "acquired", reservation: acquired };
      }
      return { status: "busy", reservation: { ...existing } };
    }
    const reservation = { ...parsed, ownerId, leaseUntil };
    this.reservations.set(key, reservation);
    return { status: "acquired", reservation };
  }

  complete(ownerId: string, record: HomeCorrectionAuditRecord): HomeCorrectionAuditRecord {
    const parsed = validateAuditRecord(record);
    const existing = this.findByActorAndIdempotencyKey(parsed.actorId, parsed.idempotencyKey);
    const key = reservationKey(parsed.actorId, parsed.idempotencyKey);
    if (existing !== undefined) {
      this.reservations.delete(key);
      return existing;
    }
    const reservation = this.reservations.get(key);
    if (reservation === undefined) throw new HomeCorrectionStoreError("conflict", "Correction reservation is missing");
    if (reservation.ownerId !== ownerId || !reservationMatchesRecord(reservation, parsed)) {
      throw new HomeCorrectionStoreError("conflict", "Correction reservation is not owned by this operation");
    }
    this.records.push(cloneRecord(parsed));
    this.reservations.delete(key);
    return cloneRecord(parsed);
  }

  listAudit(): readonly HomeCorrectionAuditRecord[] {
    return this.records.map(cloneRecord);
  }
}

export class HomeCorrectionStoreError extends Error {
  constructor(readonly code: "io" | "conflict", message: string) {
    super(message);
    this.name = "HomeCorrectionStoreError";
  }
}

interface RawCorrectionRow {
  readonly id?: unknown;
  readonly advice_id?: unknown;
  readonly actor_id?: unknown;
  readonly correction_type?: unknown;
  readonly correction_text?: unknown;
  readonly idempotency_key?: unknown;
  readonly outcome?: unknown;
  readonly destination?: unknown;
  readonly proposal_id?: unknown;
  readonly proposal_count?: unknown;
  readonly created_at?: unknown;
}

interface RawReservationRow {
  readonly id?: unknown;
  readonly advice_id?: unknown;
  readonly actor_id?: unknown;
  readonly correction_type?: unknown;
  readonly correction_text?: unknown;
  readonly idempotency_key?: unknown;
  readonly created_at?: unknown;
  readonly owner_id?: unknown;
  readonly lease_until?: unknown;
}

function parseRecord(raw: RawCorrectionRow): HomeCorrectionAuditRecord {
  if (!isRecord(raw)
    || typeof raw.id !== "string"
    || typeof raw.advice_id !== "string"
    || typeof raw.actor_id !== "string"
    || !isCorrectionType(raw.correction_type)
    || typeof raw.correction_text !== "string"
    || typeof raw.idempotency_key !== "string"
    || !isOutcome(raw.outcome)
    || typeof raw.destination !== "string"
    || typeof raw.created_at !== "string"
    || (raw.proposal_id !== null && raw.proposal_id !== undefined && typeof raw.proposal_id !== "string")
    || (raw.proposal_count !== null && raw.proposal_count !== undefined
      && (!Number.isSafeInteger(raw.proposal_count) || Number(raw.proposal_count) < 0))) {
    throw new HomeCorrectionStoreError("io", "Stored home correction audit is invalid");
  }
  return {
    id: raw.id,
    adviceId: raw.advice_id,
    actorId: raw.actor_id,
    correctionType: raw.correction_type,
    correction: raw.correction_text,
    idempotencyKey: raw.idempotency_key,
    outcome: raw.outcome,
    destination: raw.destination,
    ...(raw.proposal_id === null || raw.proposal_id === undefined ? {} : { proposalId: raw.proposal_id }),
    ...(raw.proposal_count === null || raw.proposal_count === undefined ? {} : { proposalCount: Number(raw.proposal_count) }),
    createdAt: raw.created_at,
  };
}

function validateAuditRecord(record: HomeCorrectionAuditRecord): HomeCorrectionAuditRecord {
  if (!record || typeof record !== "object"
    || typeof record.id !== "string"
    || typeof record.adviceId !== "string"
    || typeof record.actorId !== "string"
    || !isCorrectionType(record.correctionType)
    || typeof record.correction !== "string"
    || typeof record.idempotencyKey !== "string"
    || !isOutcome(record.outcome)
    || typeof record.destination !== "string"
    || typeof record.createdAt !== "string"
    || (record.proposalId !== undefined && typeof record.proposalId !== "string")
    || (record.proposalCount !== undefined && (!Number.isSafeInteger(record.proposalCount) || record.proposalCount < 0))) {
    throw new HomeCorrectionStoreError("io", "Home correction audit is invalid");
  }
  return cloneRecord(record);
}

function validateReservationInput(input: HomeCorrectionReservationInput): HomeCorrectionReservationInput {
  if (!input || typeof input !== "object"
    || typeof input.id !== "string"
    || typeof input.adviceId !== "string"
    || typeof input.actorId !== "string"
    || !isCorrectionType(input.correctionType)
    || typeof input.correction !== "string"
    || typeof input.idempotencyKey !== "string"
    || typeof input.createdAt !== "string") {
    throw new HomeCorrectionStoreError("io", "Home correction reservation is invalid");
  }
  return { ...input };
}

function validateOwnerAndLease(ownerId: string, now: string, leaseMs: number): void {
  if (typeof ownerId !== "string" || ownerId.trim() === ""
    || typeof now !== "string" || !Number.isFinite(Date.parse(now))
    || !Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new HomeCorrectionStoreError("io", "Home correction reservation lease is invalid");
  }
}

function leaseUntilFor(now: string, leaseMs: number): string {
  return new Date(Date.parse(now) + leaseMs).toISOString();
}

function parseReservation(raw: RawReservationRow): HomeCorrectionReservation {
  if (!isRecord(raw)
    || typeof raw.id !== "string"
    || typeof raw.advice_id !== "string"
    || typeof raw.actor_id !== "string"
    || !isCorrectionType(raw.correction_type)
    || typeof raw.correction_text !== "string"
    || typeof raw.idempotency_key !== "string"
    || typeof raw.created_at !== "string"
    || typeof raw.owner_id !== "string"
    || typeof raw.lease_until !== "string"
    || !Number.isFinite(Date.parse(raw.created_at))
    || !Number.isFinite(Date.parse(raw.lease_until))) {
    throw new HomeCorrectionStoreError("io", "Stored home correction reservation is invalid");
  }
  return {
    id: raw.id,
    adviceId: raw.advice_id,
    actorId: raw.actor_id,
    correctionType: raw.correction_type,
    correction: raw.correction_text,
    idempotencyKey: raw.idempotency_key,
    createdAt: raw.created_at,
    ownerId: raw.owner_id,
    leaseUntil: raw.lease_until,
  };
}

function reservationKey(actorId: string, idempotencyKey: string): string {
  return `${actorId}\u0000${idempotencyKey}`;
}

function reservationMatchesRecord(
  reservation: HomeCorrectionReservation,
  record: HomeCorrectionAuditRecord,
): boolean {
  return reservation.id === record.id
    && reservation.adviceId === record.adviceId
    && reservation.actorId === record.actorId
    && reservation.correctionType === record.correctionType
    && reservation.correction === record.correction
    && reservation.idempotencyKey === record.idempotencyKey;
}

function cloneRecord(record: HomeCorrectionAuditRecord): HomeCorrectionAuditRecord {
  return { ...record };
}

function isCorrectionType(value: unknown): value is HomeCorrectionType {
  return value === "household_fact" || value === "household_preference" || value === "future_behavior";
}

function isOutcome(value: unknown): value is HomeCorrectionOutcome {
  return value === "updated" || value === "proposal_created";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMemoryPath(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}
