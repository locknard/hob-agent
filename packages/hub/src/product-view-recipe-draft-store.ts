import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensurePrivateSqliteFiles } from "./sqlite-private-files.js";

const MAX_DRAFTS = 32;
const MAX_SOURCE_BYTES = 65_536;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export interface ProductViewRecipeDraftSummary {
  readonly draftId: string;
  readonly revision: number;
  readonly label: string;
  readonly updatedAt: string;
}

export interface ProductViewRecipeDraft extends ProductViewRecipeDraftSummary {
  readonly ownerPrincipalId: string;
  readonly source: string;
}

export interface CreateProductViewRecipeDraft {
  readonly ownerPrincipalId: string;
  readonly label: string;
  readonly source: string;
  readonly idempotencyKey: string;
}

export interface UpdateProductViewRecipeDraft {
  readonly draftId: string;
  readonly ownerPrincipalId: string;
  readonly expectedRevision: number;
  readonly label: string;
  readonly source: string;
}

export interface RemoveProductViewRecipeDraft {
  readonly draftId: string;
  readonly ownerPrincipalId: string;
  readonly expectedRevision: number;
}

export interface ProductViewRecipeDraftStore {
  create(input: CreateProductViewRecipeDraft): ProductViewRecipeDraft;
  update(input: UpdateProductViewRecipeDraft): ProductViewRecipeDraft;
  remove(input: RemoveProductViewRecipeDraft): void;
  read(draftId: string, ownerPrincipalId: string): ProductViewRecipeDraft | undefined;
  list(ownerPrincipalId: string): readonly ProductViewRecipeDraftSummary[];
  close?(): void;
}

export type ProductViewRecipeDraftStoreErrorCode =
  | "invalid_input"
  | "capacity_full"
  | "idempotency_conflict"
  | "revision_conflict"
  | "not_found"
  | "corrupt"
  | "storage_unavailable";

export class ProductViewRecipeDraftStoreError extends Error {
  constructor(readonly code: ProductViewRecipeDraftStoreErrorCode) {
    super(`Product view recipe draft store: ${code}`);
    this.name = "ProductViewRecipeDraftStoreError";
  }
}

export interface SqliteProductViewRecipeDraftStoreOptions {
  readonly path: string;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  readonly busyTimeoutMs?: number;
}

interface DraftRow {
  readonly draft_id: string;
  readonly owner_principal_id: string;
  readonly revision: number;
  readonly label: string;
  readonly source: string;
  readonly updated_at: string;
  readonly input_digest: string;
}

/** Private Hub-owned persistence for inert layout authoring drafts. */
export class SqliteProductViewRecipeDraftStore implements ProductViewRecipeDraftStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly idFactory: () => string;
  private readonly clock: () => Date;
  private closed = false;

  constructor(options: SqliteProductViewRecipeDraftStoreOptions) {
    if (typeof options?.path !== "string" || options.path.trim().length === 0) {
      throw new TypeError("Product view recipe draft store path is required");
    }
    this.path = options.path;
    this.idFactory = options.idFactory ?? (() => `draft-${randomUUID()}`);
    this.clock = options.clock ?? (() => new Date());
    if (!isMemoryPath(this.path)) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      const busyTimeoutMs = validBusyTimeout(options.busyTimeoutMs);
      this.db = new DatabaseSync(this.path);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=${busyTimeoutMs};`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS product_view_recipe_drafts (
          draft_id TEXT PRIMARY KEY,
          owner_principal_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          label TEXT NOT NULL,
          source TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          input_digest TEXT NOT NULL,
          UNIQUE (owner_principal_id, idempotency_key)
        ) STRICT;
      `);
      ensurePrivateSqliteFiles(this.path);
    } catch {
      throw new ProductViewRecipeDraftStoreError("storage_unavailable");
    }
  }

  create(input: CreateProductViewRecipeDraft): ProductViewRecipeDraft {
    this.assertOpen();
    const ownerPrincipalId = validPrincipal(input?.ownerPrincipalId);
    const label = validLabel(input?.label);
    const source = validSource(input?.source);
    const idempotencyKey = validIdentifier(input?.idempotencyKey);
    const inputDigest = draftInputDigest(label, source);
    begin(this.db);
    try {
      const existing = this.db.prepare(`
        SELECT draft_id, owner_principal_id, revision, label, source, updated_at, input_digest
        FROM product_view_recipe_drafts
        WHERE owner_principal_id = ? AND idempotency_key = ?
      `).get(ownerPrincipalId, idempotencyKey) as unknown as DraftRow | undefined;
      if (existing !== undefined) {
        const existingRecord = record(existing);
        validStoredDigest(existing.input_digest);
        if (existing.input_digest !== inputDigest) throw storeError("idempotency_conflict");
        this.db.exec("COMMIT");
        return existingRecord;
      }
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM product_view_recipe_drafts").get() as { count: number };
      if (!Number.isSafeInteger(count.count) || count.count < 0) throw storeError("corrupt");
      if (count.count >= MAX_DRAFTS) throw storeError("capacity_full");
      const draftId = generatedIdentifier(this.idFactory);
      const updatedAt = validTimestamp(this.clock());
      this.db.prepare(`
        INSERT INTO product_view_recipe_drafts (
          draft_id, owner_principal_id, revision, label, source, updated_at, idempotency_key, input_digest
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      `).run(draftId, ownerPrincipalId, label, source, updatedAt, idempotencyKey, inputDigest);
      ensurePrivateSqliteFiles(this.path);
      this.db.exec("COMMIT");
      return Object.freeze({ draftId, ownerPrincipalId, revision: 1, label, source, updatedAt });
    } catch (error) {
      rollback(this.db);
      throw stableStoreError(error);
    }
  }

  update(input: UpdateProductViewRecipeDraft): ProductViewRecipeDraft {
    this.assertOpen();
    const draftId = validIdentifier(input?.draftId);
    const ownerPrincipalId = validPrincipal(input?.ownerPrincipalId);
    const expectedRevision = validRevision(input?.expectedRevision);
    const label = validLabel(input?.label);
    const source = validSource(input?.source);
    const updatedAt = validTimestamp(this.clock());
    begin(this.db);
    try {
      const existing = this.db.prepare(`
        SELECT draft_id, owner_principal_id, revision, label, source, updated_at, input_digest
        FROM product_view_recipe_drafts
        WHERE draft_id = ? AND owner_principal_id = ?
      `).get(draftId, ownerPrincipalId) as unknown as DraftRow | undefined;
      if (existing === undefined) throw storeError("not_found");
      record(existing);
      validStoredDigest(existing.input_digest);
      if (existing.revision !== expectedRevision) throw storeError("revision_conflict");
      const revision = expectedRevision + 1;
      const result = this.db.prepare(`
        UPDATE product_view_recipe_drafts
        SET revision = ?, label = ?, source = ?, updated_at = ?
        WHERE draft_id = ? AND owner_principal_id = ? AND revision = ?
      `).run(revision, label, source, updatedAt, draftId, ownerPrincipalId, expectedRevision);
      if (Number(result.changes) !== 1) throw storeError("revision_conflict");
      ensurePrivateSqliteFiles(this.path);
      this.db.exec("COMMIT");
      return Object.freeze({ draftId, ownerPrincipalId, revision, label, source, updatedAt });
    } catch (error) {
      rollback(this.db);
      throw stableStoreError(error);
    }
  }

  remove(input: RemoveProductViewRecipeDraft): void {
    this.assertOpen();
    const draftId = validIdentifier(input?.draftId);
    const ownerPrincipalId = validPrincipal(input?.ownerPrincipalId);
    const expectedRevision = validRevision(input?.expectedRevision);
    begin(this.db);
    try {
      const existing = this.db.prepare(`
        SELECT draft_id, owner_principal_id, revision, label, source, updated_at, input_digest
        FROM product_view_recipe_drafts
        WHERE draft_id = ? AND owner_principal_id = ?
      `).get(draftId, ownerPrincipalId) as unknown as DraftRow | undefined;
      if (existing === undefined) throw storeError("not_found");
      record(existing);
      validStoredDigest(existing.input_digest);
      if (existing.revision !== expectedRevision) throw storeError("revision_conflict");
      const result = this.db.prepare(`
        DELETE FROM product_view_recipe_drafts
        WHERE draft_id = ? AND owner_principal_id = ? AND revision = ?
      `).run(draftId, ownerPrincipalId, expectedRevision);
      if (Number(result.changes) !== 1) throw storeError("revision_conflict");
      ensurePrivateSqliteFiles(this.path);
      this.db.exec("COMMIT");
    } catch (error) {
      rollback(this.db);
      throw stableStoreError(error);
    }
  }

  read(draftId: string, ownerPrincipalId: string): ProductViewRecipeDraft | undefined {
    this.assertOpen();
    const normalizedDraftId = validIdentifier(draftId);
    const normalizedOwner = validPrincipal(ownerPrincipalId);
    try {
      const row = this.db.prepare(`
        SELECT draft_id, owner_principal_id, revision, label, source, updated_at, input_digest
        FROM product_view_recipe_drafts
        WHERE draft_id = ? AND owner_principal_id = ?
      `).get(normalizedDraftId, normalizedOwner) as unknown as DraftRow | undefined;
      if (row === undefined) return undefined;
      const validated = record(row);
      validStoredDigest(row.input_digest);
      return validated;
    } catch (error) {
      throw stableStoreError(error);
    }
  }

  list(ownerPrincipalId: string): readonly ProductViewRecipeDraftSummary[] {
    this.assertOpen();
    const owner = validPrincipal(ownerPrincipalId);
    try {
      const rows = this.db.prepare(`
        SELECT draft_id, owner_principal_id, revision, label, source, updated_at, input_digest
        FROM product_view_recipe_drafts
        WHERE owner_principal_id = ?
        ORDER BY updated_at DESC, draft_id ASC
        LIMIT 32
      `).all(owner) as unknown as DraftRow[];
      return Object.freeze(rows.map((row) => {
        const validated = record(row);
        validStoredDigest(row.input_digest);
        return summary(validated);
      }));
    } catch (error) {
      throw stableStoreError(error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    ensurePrivateSqliteFiles(this.path);
  }

  private assertOpen(): void {
    if (this.closed) throw storeError("storage_unavailable");
  }
}

function record(row: DraftRow): ProductViewRecipeDraft {
  try {
    return Object.freeze({
      draftId: validIdentifier(row.draft_id),
      ownerPrincipalId: validPrincipal(row.owner_principal_id),
      revision: validRevision(row.revision),
      label: validLabel(row.label),
      source: validSource(row.source),
      updatedAt: validStoredTimestamp(row.updated_at),
    });
  } catch {
    throw storeError("corrupt");
  }
}

function summary(row: Pick<ProductViewRecipeDraft, "draftId" | "revision" | "label" | "updatedAt">): ProductViewRecipeDraftSummary {
  try {
    return Object.freeze({
      draftId: validIdentifier(row.draftId),
      revision: validRevision(row.revision),
      label: validLabel(row.label),
      updatedAt: validStoredTimestamp(row.updatedAt),
    });
  } catch {
    throw storeError("corrupt");
  }
}

function validPrincipal(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || value.trim() !== value || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw storeError("invalid_input");
  }
  return value;
}

function validLabel(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 80 || value.trim() !== value || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw storeError("invalid_input");
  }
  return value;
}

function validSource(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_SOURCE_BYTES || value.includes("\u0000")) {
    throw storeError("invalid_input");
  }
  return value;
}

function validIdentifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw storeError("invalid_input");
  return value;
}

function validRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw storeError("invalid_input");
  return value as number;
}

function validTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw storeError("storage_unavailable");
  return value.toISOString();
}

function validStoredTimestamp(value: unknown): string {
  if (typeof value !== "string") throw storeError("corrupt");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw storeError("corrupt");
  return value;
}

function validStoredDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw storeError("corrupt");
  return value;
}

function generatedIdentifier(factory: () => string): string {
  try {
    return validIdentifier(factory());
  } catch {
    throw storeError("storage_unavailable");
  }
}

function validBusyTimeout(value: unknown): number {
  if (value === undefined) return 5_000;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 5_000) {
    throw new TypeError("Product view recipe draft store busy timeout is invalid");
  }
  return value as number;
}

function draftInputDigest(label: string, source: string): string {
  return createHash("sha256").update(JSON.stringify({ label, source })).digest("hex");
}

function stableStoreError(error: unknown): ProductViewRecipeDraftStoreError {
  return error instanceof ProductViewRecipeDraftStoreError ? error : storeError("storage_unavailable");
}

function storeError(code: ProductViewRecipeDraftStoreErrorCode): ProductViewRecipeDraftStoreError {
  return new ProductViewRecipeDraftStoreError(code);
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Transaction cleanup is complete when SQLite has already rolled back.
  }
}

function begin(db: DatabaseSync): void {
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch {
    throw storeError("storage_unavailable");
  }
}

function isMemoryPath(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}
