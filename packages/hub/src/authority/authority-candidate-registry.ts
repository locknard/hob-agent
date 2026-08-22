import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalAssessmentInput } from "../artifact/artifact-assessments.js";
import { ensurePrivateSqliteFiles } from "../sqlite-private-files.js";

export type AuthorityCandidateLifecycle = "active" | "superseded" | "revoked";
export type NeutralAuthorityCandidateStatus = "available" | "unavailable" | "not_approved";

/** The only candidate shape allowed to cross the authority assessment seam. */
export interface NeutralAuthorityCandidate {
  readonly actionAuthorityCandidateId: string;
  readonly hwCapabilityId: string;
  readonly status: NeutralAuthorityCandidateStatus;
}

/**
 * Hub-owned inputs for one candidate resolution. Binding and configuration
 * identities are opaque Hub digests/labels; no route or native field is
 * accepted by this boundary.
 */
export interface AuthorityCandidateResolveInput {
  readonly hwCapabilityId: string;
  readonly knownCapability: boolean;
  readonly configured: boolean;
  readonly approved: boolean;
  readonly available: boolean;
  readonly bindingIdentity?: string;
  readonly configurationIdentity?: string;
  readonly registrationGeneration?: number;
}

export interface AuthorityCandidateResolution {
  readonly authorityRegistryIdentity: `sha256:${string}`;
  readonly candidate: NeutralAuthorityCandidate;
}

export type AuthorityCandidateAuditAction = "created" | "superseded" | "revoked";

/** Metadata-only audit projection; it contains no binding or route material. */
export interface AuthorityCandidateAudit {
  readonly candidateId: string;
  readonly action: AuthorityCandidateAuditAction;
  readonly at: string;
  readonly idempotencyKey: string;
  readonly reason?: string;
}

export interface AuthorityCandidateRegistryOptions {
  readonly path: string;
  readonly now?: () => string | Date;
  /** Test seam for Hub-generated private row/audit IDs. */
  readonly id?: () => string;
}

export type AuthorityCandidateRegistryErrorCode =
  | "invalid_input"
  | "unknown_capability"
  | "stale_candidate"
  | "not_found"
  | "corrupt_record"
  | "revision_conflict"
  | "write_failed"
  | "closed";

export class AuthorityCandidateRegistryError extends Error {
  constructor(
    readonly code: AuthorityCandidateRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthorityCandidateRegistryError";
  }
}

interface CandidateIdentity {
  readonly candidateKey: string;
  readonly candidateId: string;
  readonly hwCapabilityId: string;
  readonly bindingIdentity: string;
  readonly configurationIdentity: string;
  readonly registrationGeneration: number;
  readonly approved: boolean;
}

interface CandidateRow extends CandidateIdentity {
  readonly rowId: string;
  readonly lifecycle: AuthorityCandidateLifecycle;
  readonly createdAt: string;
  readonly supersededAt?: string;
  readonly revokedAt?: string;
}

interface SqlRow extends Record<string, unknown> {}

const MAX_ID_BYTES = 200;
const MAX_AUDIT_REASON_BYTES = 1_000;
const MAX_AUDIT_LIMIT = 200;
const UNCONFIGURED_IDENTITY = "unconfigured";
const OPAQUE_SHA256 = /^sha256:[0-9a-f]{64}$/u;

/**
 * Durable Hub-private authority candidate identity. It never owns a bridge
 * adapter, credential, control, or execution path.
 */
export class AuthorityCandidateRegistry {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly id: () => string;
  private closed = false;

  constructor(options: AuthorityCandidateRegistryOptions) {
    if (!options || typeof options.path !== "string" || options.path.length === 0) {
      throw new AuthorityCandidateRegistryError("invalid_input", "Authority candidate registry path is required");
    }
    this.path = options.path;
    this.now = () => normalizeTime(options.now?.() ?? new Date());
    this.id = options.id ?? randomUUID;
    if (!isMemoryPath(this.path)) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });

    let opened: DatabaseSync | undefined;
    try {
      opened = new DatabaseSync(this.path);
      this.db = opened;
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS authority_candidates (
          candidate_key TEXT PRIMARY KEY,
          row_id TEXT NOT NULL UNIQUE,
          candidate_id TEXT NOT NULL UNIQUE,
          hw_capability_id TEXT NOT NULL,
          binding_identity TEXT NOT NULL,
          configuration_identity TEXT NOT NULL,
          registration_generation INTEGER NOT NULL,
          approved INTEGER NOT NULL,
          lifecycle TEXT NOT NULL,
          created_at TEXT NOT NULL,
          superseded_at TEXT,
          revoked_at TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS authority_operations (
          idempotency_key TEXT PRIMARY KEY,
          operation TEXT NOT NULL,
          candidate_key TEXT NOT NULL,
          row_id TEXT NOT NULL,
          candidate_id TEXT NOT NULL,
          reason TEXT,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS authority_audit (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          audit_id TEXT NOT NULL UNIQUE,
          row_id TEXT NOT NULL,
          candidate_id TEXT NOT NULL,
          action TEXT NOT NULL,
          from_lifecycle TEXT,
          to_lifecycle TEXT,
          reason TEXT,
          idempotency_key TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS authority_candidates_by_capability
          ON authority_candidates (hw_capability_id, lifecycle);
        CREATE INDEX IF NOT EXISTS authority_audit_by_row
          ON authority_audit (row_id, sequence);
      `);
      this.validateSchema();
      this.ensurePrivateFiles();
    } catch (error) {
      try {
        opened?.close();
      } catch {
        // Preserve the bounded open failure.
      }
      if (error instanceof AuthorityCandidateRegistryError) throw error;
      throw new AuthorityCandidateRegistryError(
        "write_failed",
        "Authority candidate registry could not be opened",
      );
    }
  }

  /**
   * Resolves one exact Hub capability binding. Repeated calls with the same
   * identity replay the same candidate; a changed identity atomically creates
   * a new candidate and supersedes the prior active row.
   */
  resolve(input: AuthorityCandidateResolveInput): AuthorityCandidateResolution {
    const normalized = normalizeResolveInput(input);
    if (!normalized.knownCapability) {
      throw new AuthorityCandidateRegistryError("unknown_capability", "Authority capability is unknown");
    }
    const identity = candidateIdentity(normalized);
    const operationKey = `authority-resolve-v1-${identity.candidateKey.slice("sha256:".length)}`;

    return this.writeTransaction(() => {
      const rows = this.readCapabilityRows(normalized.hwCapabilityId);
      const existing = rows.find((row) => row.candidateKey === identity.candidateKey);
      if (existing !== undefined) {
        if (existing.lifecycle === "superseded") {
          throw new AuthorityCandidateRegistryError("stale_candidate", "Authority candidate identity is superseded");
        }
        this.assertResolveHistory(existing, operationKey);
        return this.resolutionFor(existing, normalized);
      }

      const historicalSameId = this.findByCandidateId(identity.candidateId);
      if (historicalSameId !== undefined) {
        throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate identity history conflicts");
      }

      const active = rows.filter((row) => row.lifecycle === "active");
      if (active.length > 1) {
        throw new AuthorityCandidateRegistryError("corrupt_record", "Multiple active authority candidates exist");
      }
      const at = this.now();
      if (active[0] !== undefined) {
        this.transition(active[0], "superseded", at, operationKey);
      }

      const row: CandidateRow = {
        ...identity,
        rowId: this.privateId("authority-row"),
        lifecycle: "active",
        createdAt: at,
      };
      this.insertCandidate(row);
      this.insertOperation(operationKey, "resolve", row, undefined, at);
      this.insertAudit(row, "created", undefined, "active", undefined, operationKey, at);
      return this.resolutionFor(row, normalized);
    });
  }

  /** Explicitly revokes a candidate without enabling a fallback route. */
  revoke(candidateId: string, reason?: string): AuthorityCandidateResolution {
    const id = validateCandidateId(candidateId);
    const normalizedReason = reason === undefined ? undefined : validateReason(reason);
    const operationKey = `authority-revoke-v1-${id}`;

    return this.writeTransaction(() => {
      const row = this.findByCandidateId(id);
      if (row === undefined) {
        throw new AuthorityCandidateRegistryError("not_found", "Authority candidate was not found");
      }
      const rows = this.readCapabilityRows(row.hwCapabilityId);
      if (row.lifecycle === "superseded") {
        throw new AuthorityCandidateRegistryError("stale_candidate", "Authority candidate is superseded");
      }
      if (row.lifecycle === "revoked") {
        this.assertRevokeHistory(row, operationKey, normalizedReason);
        return this.resolutionFor(row, undefined);
      }
      if (rows.filter((item) => item.lifecycle === "active").length !== 1) {
        throw new AuthorityCandidateRegistryError("corrupt_record", "Active authority candidate history is ambiguous");
      }

      const at = this.now();
      this.db.prepare(`UPDATE authority_candidates
        SET lifecycle = 'revoked', revoked_at = ?
        WHERE row_id = ? AND lifecycle = 'active'`).run(at, row.rowId);
      const revoked: CandidateRow = { ...row, lifecycle: "revoked", revokedAt: at };
      this.insertOperation(operationKey, "revoke", revoked, normalizedReason, at);
      this.insertAudit(revoked, "revoked", "active", "revoked", normalizedReason, operationKey, at);
      return this.resolutionFor(revoked, undefined);
    });
  }

  /** Returns bounded metadata-only audit rows; private binding material never crosses this method. */
  audit(limit = 100): readonly AuthorityCandidateAudit[] {
    this.ensureOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AUDIT_LIMIT) {
      throw new AuthorityCandidateRegistryError("invalid_input", "Authority candidate audit limit is invalid");
    }
    try {
      const rows = this.db.prepare(`SELECT candidate_id, action, created_at, idempotency_key, reason
        FROM authority_audit ORDER BY sequence LIMIT ?`).all(limit) as SqlRow[];
      return Object.freeze(rows.map((row) => toAudit(row)));
    } catch (error) {
      if (error instanceof AuthorityCandidateRegistryError) throw error;
      throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate audit is corrupt");
    }
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
      throw new AuthorityCandidateRegistryError("write_failed", "Authority candidate write could not begin");
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
        // Preserve the bounded registry failure.
      }
      this.ensurePrivateFiles();
      if (error instanceof AuthorityCandidateRegistryError) throw error;
      throw new AuthorityCandidateRegistryError("write_failed", "Authority candidate write failed");
    }
  }

  private readCapabilityRows(hwCapabilityId: string): CandidateRow[] {
    try {
      const rows = this.db.prepare(`SELECT candidate_key, row_id, candidate_id, hw_capability_id,
          binding_identity, configuration_identity, registration_generation, approved, lifecycle,
          created_at, superseded_at, revoked_at
        FROM authority_candidates WHERE hw_capability_id = ? ORDER BY row_id`).all(hwCapabilityId) as SqlRow[];
      const parsed = rows.map((row) => fromRow(row));
      for (const row of parsed) this.assertRowHistory(row);
      this.assertSingleActive(parsed);
      return parsed;
    } catch (error) {
      if (error instanceof AuthorityCandidateRegistryError) throw error;
      throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate row is corrupt");
    }
  }

  private findByCandidateId(candidateId: string): CandidateRow | undefined {
    try {
      const row = this.db.prepare(`SELECT candidate_key, row_id, candidate_id, hw_capability_id,
          binding_identity, configuration_identity, registration_generation, approved, lifecycle,
          created_at, superseded_at, revoked_at
        FROM authority_candidates WHERE candidate_id = ?`).get(candidateId) as SqlRow | undefined;
      return row === undefined ? undefined : fromRow(row);
    } catch (error) {
      if (error instanceof AuthorityCandidateRegistryError) throw error;
      throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate row is corrupt");
    }
  }

  private assertRowHistory(row: CandidateRow): void {
    const audits = this.db.prepare(`SELECT row_id, candidate_id, action, from_lifecycle,
        to_lifecycle, reason, idempotency_key, created_at
      FROM authority_audit WHERE row_id = ? ORDER BY sequence`).all(row.rowId) as SqlRow[];
    if (audits.length < 1) throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate audit history is missing");
    const created = toInternalAudit(audits[0]!);
    if (created.action !== "created"
      || created.rowId !== row.rowId
      || created.candidateId !== row.candidateId
      || created.fromLifecycle !== undefined
      || created.toLifecycle !== "active"
      || created.createdAt !== row.createdAt) {
      throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate creation audit is inconsistent");
    }
    const transitions = audits.slice(1).map(toInternalAudit);
    if (row.lifecycle === "active") {
      if (transitions.length !== 0 || row.supersededAt !== undefined || row.revokedAt !== undefined) {
        throw new AuthorityCandidateRegistryError("corrupt_record", "Active authority candidate history is inconsistent");
      }
    } else if (row.lifecycle === "superseded") {
      if (transitions.length !== 1
        || transitions[0]?.action !== "superseded"
        || transitions[0].fromLifecycle !== "active"
        || transitions[0].toLifecycle !== "superseded"
        || transitions[0].createdAt !== row.supersededAt
        || row.revokedAt !== undefined) {
        throw new AuthorityCandidateRegistryError("corrupt_record", "Superseded authority candidate history is inconsistent");
      }
    } else if (transitions.length !== 1
      || transitions[0]?.action !== "revoked"
      || transitions[0].fromLifecycle !== "active"
      || transitions[0].toLifecycle !== "revoked"
      || transitions[0].createdAt !== row.revokedAt
      || row.supersededAt !== undefined) {
      throw new AuthorityCandidateRegistryError("corrupt_record", "Revoked authority candidate history is inconsistent");
    }

    const resolveKey = `authority-resolve-v1-${row.candidateKey.slice("sha256:".length)}`;
    const operation = this.findOperation(resolveKey);
    if (operation === undefined || operation.operation !== "resolve" || operation.candidateKey !== row.candidateKey
      || operation.rowId !== row.rowId || operation.candidateId !== row.candidateId) {
      throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate operation history is inconsistent");
    }
    if (row.lifecycle === "revoked") {
      const revokeKey = `authority-revoke-v1-${row.candidateId}`;
      const revokeOperation = this.findOperation(revokeKey);
      if (revokeOperation === undefined || revokeOperation.operation !== "revoke"
        || revokeOperation.candidateKey !== row.candidateKey
        || revokeOperation.rowId !== row.rowId
        || revokeOperation.candidateId !== row.candidateId) {
        throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate revoke history is inconsistent");
      }
    }
  }

  private assertResolveHistory(row: CandidateRow, operationKey: string): void {
    const operation = this.findOperation(operationKey);
    if (operation === undefined || operation.operation !== "resolve"
      || operation.candidateKey !== row.candidateKey
      || operation.rowId !== row.rowId
      || operation.candidateId !== row.candidateId) {
      throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate replay history is inconsistent");
    }
  }

  private assertRevokeHistory(row: CandidateRow, operationKey: string, reason: string | undefined): void {
    const operation = this.findOperation(operationKey);
    if (operation === undefined || operation.operation !== "revoke"
      || operation.candidateKey !== row.candidateKey
      || operation.rowId !== row.rowId
      || operation.candidateId !== row.candidateId
      || operation.reason !== reason) {
      throw new AuthorityCandidateRegistryError("revision_conflict", "Authority candidate revoke replay conflicts");
    }
  }

  private findOperation(idempotencyKey: string): InternalOperation | undefined {
    const row = this.db.prepare(`SELECT idempotency_key, operation, candidate_key, row_id,
        candidate_id, reason, created_at
      FROM authority_operations WHERE idempotency_key = ?`).get(idempotencyKey) as SqlRow | undefined;
    return row === undefined ? undefined : toOperation(row);
  }

  private insertCandidate(row: CandidateRow): void {
    this.db.prepare(`INSERT INTO authority_candidates
      (candidate_key, row_id, candidate_id, hw_capability_id, binding_identity,
        configuration_identity, registration_generation, approved, lifecycle, created_at,
        superseded_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.candidateKey,
      row.rowId,
      row.candidateId,
      row.hwCapabilityId,
      row.bindingIdentity,
      row.configurationIdentity,
      row.registrationGeneration,
      row.approved ? 1 : 0,
      row.lifecycle,
      row.createdAt,
      row.supersededAt ?? null,
      row.revokedAt ?? null,
    );
  }

  private insertOperation(
    idempotencyKey: string,
    operation: "resolve" | "revoke",
    row: CandidateRow,
    reason: string | undefined,
    at: string,
  ): void {
    this.db.prepare(`INSERT INTO authority_operations
      (idempotency_key, operation, candidate_key, row_id, candidate_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      idempotencyKey,
      operation,
      row.candidateKey,
      row.rowId,
      row.candidateId,
      reason ?? null,
      at,
    );
  }

  private insertAudit(
    row: CandidateRow,
    action: AuthorityCandidateAuditAction,
    fromLifecycle: AuthorityCandidateLifecycle | undefined,
    toLifecycle: AuthorityCandidateLifecycle,
    reason: string | undefined,
    idempotencyKey: string,
    at: string,
  ): void {
    this.db.prepare(`INSERT INTO authority_audit
      (audit_id, row_id, candidate_id, action, from_lifecycle, to_lifecycle,
        reason, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      this.privateId("authority-audit"),
      row.rowId,
      row.candidateId,
      action,
      fromLifecycle ?? null,
      toLifecycle,
      reason ?? null,
      idempotencyKey,
      at,
    );
  }

  private transition(
    row: CandidateRow,
    lifecycle: "superseded",
    at: string,
    idempotencyKey: string,
  ): void {
    this.db.prepare(`UPDATE authority_candidates
      SET lifecycle = 'superseded', superseded_at = ?
      WHERE row_id = ? AND lifecycle = 'active'`).run(at, row.rowId);
    const superseded: CandidateRow = { ...row, lifecycle, supersededAt: at };
    this.insertAudit(superseded, "superseded", "active", lifecycle, undefined, idempotencyKey, at);
  }

  private resolutionFor(
    row: CandidateRow,
    input: AuthorityCandidateResolveInput | undefined,
  ): AuthorityCandidateResolution {
    const identity = this.registryIdentity(row.hwCapabilityId);
    const status: NeutralAuthorityCandidateStatus = row.lifecycle === "revoked"
      ? "not_approved"
      : input === undefined || !input.configured || !input.approved
        ? (!input?.configured ? "unavailable" : "not_approved")
        : input.available ? "available" : "unavailable";
    return Object.freeze({
      authorityRegistryIdentity: identity,
      candidate: Object.freeze({
        actionAuthorityCandidateId: row.candidateId,
        hwCapabilityId: row.hwCapabilityId,
        status,
      }),
    });
  }

  private registryIdentity(hwCapabilityId: string): `sha256:${string}` {
    const rows = this.db.prepare(`SELECT candidate_key, row_id, candidate_id, hw_capability_id,
        binding_identity, configuration_identity, registration_generation, approved, lifecycle,
        created_at, superseded_at, revoked_at
      FROM authority_candidates WHERE hw_capability_id = ? ORDER BY candidate_id`).all(hwCapabilityId) as SqlRow[];
    const parsed = rows.map((row) => fromRow(row));
    for (const row of parsed) this.assertRowHistory(row);
    this.assertSingleActive(parsed);
    const heads = parsed
      .filter((row) => row.lifecycle !== "superseded")
      .map((row) => ({
        candidateId: row.candidateId,
        lifecycle: row.lifecycle,
      }));
    return digest("authority-registry-v1", { hwCapabilityId, heads });
  }

  private assertSingleActive(rows: readonly CandidateRow[]): void {
    if (rows.filter((row) => row.lifecycle === "active").length > 1) {
      throw new AuthorityCandidateRegistryError("corrupt_record", "Multiple active authority candidates exist");
    }
  }

  private privateId(prefix: string): string {
    const value = this.id();
    if (typeof value !== "string" || value.trim() === "" || value.trim() !== value || Buffer.byteLength(value, "utf8") > MAX_ID_BYTES) {
      throw new AuthorityCandidateRegistryError("write_failed", "Hub authority identity generator returned an invalid id");
    }
    return `${prefix}-${value}`;
  }

  private ensurePrivateFiles(): void {
    ensurePrivateSqliteFiles(this.path);
  }

  private validateSchema(): void {
    const required: Readonly<Record<string, readonly string[]>> = {
      authority_candidates: [
        "candidate_key", "row_id", "candidate_id", "hw_capability_id", "binding_identity",
        "configuration_identity", "registration_generation", "approved", "lifecycle", "created_at",
        "superseded_at", "revoked_at",
      ],
      authority_operations: ["idempotency_key", "operation", "candidate_key", "row_id", "candidate_id", "reason", "created_at"],
      authority_audit: ["sequence", "audit_id", "row_id", "candidate_id", "action", "from_lifecycle", "to_lifecycle", "reason", "idempotency_key", "created_at"],
    };
    for (const [table, columns] of Object.entries(required)) {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
      const names = new Set(rows.map((row) => row.name));
      if (columns.some((column) => !names.has(column))) {
        throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate registry schema is corrupt");
      }
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new AuthorityCandidateRegistryError("closed", "Authority candidate registry is closed");
  }
}

interface InternalOperation {
  readonly idempotencyKey: string;
  readonly operation: string;
  readonly candidateKey: string;
  readonly rowId: string;
  readonly candidateId: string;
  readonly reason?: string;
  readonly createdAt: string;
}

interface InternalAudit {
  readonly rowId: string;
  readonly candidateId: string;
  readonly action: AuthorityCandidateAuditAction;
  readonly fromLifecycle?: AuthorityCandidateLifecycle;
  readonly toLifecycle: AuthorityCandidateLifecycle;
  readonly reason?: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

function normalizeResolveInput(value: unknown): AuthorityCandidateResolveInput {
  if (value === null || typeof value !== "object") invalidInput();
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([
    "hwCapabilityId",
    "knownCapability",
    "configured",
    "approved",
    "available",
    "bindingIdentity",
    "configurationIdentity",
    "registrationGeneration",
  ]);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) invalidInput();

  const input = value as Record<string, unknown>;
  if (typeof input.hwCapabilityId !== "string"
    || typeof input.knownCapability !== "boolean"
    || typeof input.configured !== "boolean"
    || typeof input.approved !== "boolean"
    || typeof input.available !== "boolean") invalidInput();
  const hwCapabilityId = boundedId(input.hwCapabilityId);
  if (!input.configured) {
    if (keys.length !== 5 || input.approved || input.available) invalidInput();
    return {
      hwCapabilityId,
      knownCapability: input.knownCapability,
      configured: false,
      approved: false,
      available: false,
    };
  }
  if (keys.length !== 8
    || typeof input.bindingIdentity !== "string"
    || typeof input.configurationIdentity !== "string"
    || typeof input.registrationGeneration !== "number"
    || !Number.isSafeInteger(input.registrationGeneration)
    || input.registrationGeneration < 1) invalidInput();
  return {
    hwCapabilityId,
    knownCapability: input.knownCapability,
    configured: true,
    approved: input.approved,
    available: input.available,
    bindingIdentity: boundedOpaqueIdentity(input.bindingIdentity),
    configurationIdentity: boundedOpaqueIdentity(input.configurationIdentity),
    registrationGeneration: input.registrationGeneration,
  };
}

function candidateIdentity(input: AuthorityCandidateResolveInput): CandidateIdentity {
  const bindingIdentity = input.configured ? input.bindingIdentity! : UNCONFIGURED_IDENTITY;
  const configurationIdentity = input.configured ? input.configurationIdentity! : UNCONFIGURED_IDENTITY;
  const registrationGeneration = input.configured ? input.registrationGeneration! : 0;
  const key = digest("authority-candidate-v1", {
    hwCapabilityId: input.hwCapabilityId,
    bindingIdentity,
    configurationIdentity,
    registrationGeneration,
    approved: input.approved,
  });
  return {
    candidateKey: key,
    candidateId: `candidate-${key.slice("sha256:".length)}`,
    hwCapabilityId: input.hwCapabilityId,
    bindingIdentity,
    configurationIdentity,
    registrationGeneration,
    approved: input.approved,
  };
}

function fromRow(row: SqlRow): CandidateRow {
  try {
    const candidateKey = textColumn(row, "candidate_key");
    const rowId = textColumn(row, "row_id");
    const candidateId = textColumn(row, "candidate_id");
    const hwCapabilityId = boundedId(textColumn(row, "hw_capability_id"));
    const bindingIdentity = storedOpaqueIdentity(textColumn(row, "binding_identity"));
    const configurationIdentity = storedOpaqueIdentity(textColumn(row, "configuration_identity"));
    const registrationGeneration = integerColumn(row, "registration_generation");
    const approvedValue = integerColumn(row, "approved");
    if (approvedValue !== 0 && approvedValue !== 1) throw new Error("approval");
    const approved = approvedValue === 1;
    const isPlaceholder = bindingIdentity === UNCONFIGURED_IDENTITY
      && configurationIdentity === UNCONFIGURED_IDENTITY;
    if ((isPlaceholder && (registrationGeneration !== 0 || approved))
      || (!isPlaceholder && registrationGeneration < 1)) {
      throw new Error("generation");
    }
    const lifecycle = textColumn(row, "lifecycle");
    if (lifecycle !== "active" && lifecycle !== "superseded" && lifecycle !== "revoked") throw new Error("lifecycle");
    const createdAt = timestampColumn(row, "created_at");
    const supersededAt = nullableTimestampColumn(row, "superseded_at");
    const revokedAt = nullableTimestampColumn(row, "revoked_at");
    const expectedKey = digest("authority-candidate-v1", {
      hwCapabilityId,
      bindingIdentity,
      configurationIdentity,
      registrationGeneration,
      approved,
    });
    if (candidateKey !== expectedKey || candidateId !== `candidate-${expectedKey.slice("sha256:".length)}`) {
      throw new Error("candidate identity");
    }
    if (!rowId || Buffer.byteLength(rowId, "utf8") > MAX_ID_BYTES) throw new Error("row id");
    if (lifecycle !== "superseded" && supersededAt !== undefined) throw new Error("superseded timestamp");
    if (lifecycle !== "revoked" && revokedAt !== undefined) throw new Error("revoked timestamp");
    if (lifecycle === "superseded" && supersededAt === undefined) throw new Error("missing superseded timestamp");
    if (lifecycle === "revoked" && revokedAt === undefined) throw new Error("missing revoked timestamp");
    return {
      candidateKey,
      candidateId,
      hwCapabilityId,
      bindingIdentity,
      configurationIdentity,
      registrationGeneration,
      approved,
      rowId,
      lifecycle,
      createdAt,
      ...(supersededAt === undefined ? {} : { supersededAt }),
      ...(revokedAt === undefined ? {} : { revokedAt }),
    };
  } catch {
    throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate row failed validation");
  }
}

function toOperation(row: SqlRow): InternalOperation {
  return {
    idempotencyKey: textColumn(row, "idempotency_key"),
    operation: textColumn(row, "operation"),
    candidateKey: textColumn(row, "candidate_key"),
    rowId: textColumn(row, "row_id"),
    candidateId: textColumn(row, "candidate_id"),
    ...(nullableTextColumn(row, "reason") === undefined ? {} : { reason: nullableTextColumn(row, "reason") }),
    createdAt: timestampColumn(row, "created_at"),
  };
}

function toInternalAudit(row: SqlRow): InternalAudit {
  const action = textColumn(row, "action");
  if (action !== "created" && action !== "superseded" && action !== "revoked") {
    throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate audit action is invalid");
  }
  const fromLifecycle = nullableTextColumn(row, "from_lifecycle");
  const toLifecycle = textColumn(row, "to_lifecycle");
  if ((fromLifecycle !== undefined && !isLifecycle(fromLifecycle)) || !isLifecycle(toLifecycle)) {
    throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate audit lifecycle is invalid");
  }
  return {
    rowId: textColumn(row, "row_id"),
    candidateId: textColumn(row, "candidate_id"),
    action,
    ...(fromLifecycle === undefined ? {} : { fromLifecycle }),
    toLifecycle,
    ...(nullableTextColumn(row, "reason") === undefined ? {} : { reason: nullableTextColumn(row, "reason") }),
    idempotencyKey: textColumn(row, "idempotency_key"),
    createdAt: timestampColumn(row, "created_at"),
  };
}

function toAudit(row: SqlRow): AuthorityCandidateAudit {
  const internal = toInternalAudit(row);
  return Object.freeze({
    candidateId: internal.candidateId,
    action: internal.action,
    at: internal.createdAt,
    idempotencyKey: internal.idempotencyKey,
    ...(internal.reason === undefined ? {} : { reason: internal.reason }),
  });
}

function digest(kind: string, input: unknown): `sha256:${string}` {
  const canonical = canonicalAssessmentInput({ kind, input });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function boundedId(value: string): string {
  if (value.length === 0 || value.trim() !== value || Buffer.byteLength(value, "utf8") > MAX_ID_BYTES) invalidInput();
  return value;
}

function boundedOpaqueIdentity(value: string): string {
  if (!OPAQUE_SHA256.test(value)) invalidInput();
  return value;
}

function storedOpaqueIdentity(value: string): string {
  if (value === UNCONFIGURED_IDENTITY) return value;
  if (!OPAQUE_SHA256.test(value)) throw new Error("opaque identity");
  return value;
}

function validateCandidateId(value: string): string {
  if (typeof value !== "string" || !/^candidate-[0-9a-f]{64}$/u.test(value)) invalidInput();
  return value;
}

function validateReason(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || Buffer.byteLength(value, "utf8") > MAX_AUDIT_REASON_BYTES) invalidInput();
  return value;
}

function integerColumn(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate integer is corrupt");
  return value;
}

function textColumn(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate text is corrupt");
  }
  return value;
}

function nullableTextColumn(row: SqlRow, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() !== value) {
    throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate nullable text is corrupt");
  }
  return value;
}

function timestampColumn(row: SqlRow, column: string): string {
  const value = textColumn(row, column);
  if (Number.isNaN(Date.parse(value))) throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate timestamp is corrupt");
  return value;
}

function nullableTimestampColumn(row: SqlRow, column: string): string | undefined {
  const value = nullableTextColumn(row, column);
  if (value !== undefined && Number.isNaN(Date.parse(value))) {
    throw new AuthorityCandidateRegistryError("corrupt_record", "Authority candidate timestamp is corrupt");
  }
  return value;
}

function normalizeTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AuthorityCandidateRegistryError("invalid_input", "Authority candidate clock returned an invalid time");
  }
  return date.toISOString();
}

function isLifecycle(value: string): value is AuthorityCandidateLifecycle {
  return value === "active" || value === "superseded" || value === "revoked";
}

function invalidInput(): never {
  throw new AuthorityCandidateRegistryError("invalid_input", "Authority candidate input is invalid");
}

function isMemoryPath(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}
