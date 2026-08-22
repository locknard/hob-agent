import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { compileProductViewRecipe } from "@hob-agent/inbox-web/view-recipe";
import { runProductViewRecipeConformance } from "@hob-agent/inbox-web/view-recipe-conformance";

import { ensurePrivateSqliteFiles } from "./sqlite-private-files.js";

const MAX_DRAFTS = 32;
const MAX_SOURCE_BYTES = 65_536;
const MAX_ACTIVE_PUBLICATIONS = 16;
const MAX_PUBLICATION_GENERATIONS = 64;
const MAX_PUBLICATION_EVENTS = 256;
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
  publish(input: {
    readonly draftId: string;
    readonly ownerPrincipalId: string;
    readonly expectedRevision: number;
    readonly actorPrincipalId: string;
  }): ProductViewRecipePublication;
  rollbackPublication(input: {
    readonly recipeId: string;
    readonly expectedGenerationId: string;
    readonly actorPrincipalId: string;
  }): ProductViewRecipePublication;
  deactivatePublication(input: {
    readonly recipeId: string;
    readonly expectedGenerationId: string;
    readonly actorPrincipalId: string;
  }): void;
  listActivePublications(): readonly ProductViewRecipePublication[];
  canRollbackPublication(recipeId: string, generationId: string): boolean;
  listPublicationEvents(): readonly ProductViewRecipePublicationEvent[];
  close?(): void;
}

export interface ProductViewRecipePublication {
  readonly generationId: string;
  readonly recipeId: string;
  readonly title: string;
  readonly draftId: string;
  readonly draftRevision: number;
  readonly recipeDigest: `sha256:${string}`;
  readonly source: string;
  readonly publishedBy: string;
  readonly publishedAt: string;
}

export interface ProductViewRecipePublicationEvent {
  readonly eventId: string;
  readonly kind: "published" | "rolled_back" | "deactivated";
  readonly recipeId: string;
  readonly generationId: string;
  readonly previousGenerationId?: string;
  readonly actorPrincipalId: string;
  readonly occurredAt: string;
}

export type ProductViewRecipeDraftStoreErrorCode =
  | "invalid_input"
  | "capacity_full"
  | "idempotency_conflict"
  | "revision_conflict"
  | "not_found"
  | "recipe_invalid"
  | "publication_capacity_full"
  | "publication_conflict"
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
  readonly generationIdFactory?: () => string;
  readonly eventIdFactory?: () => string;
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

interface PublicationRow {
  readonly generation_id: string;
  readonly recipe_id: string;
  readonly title: string;
  readonly draft_id: string;
  readonly draft_revision: number;
  readonly recipe_digest: string;
  readonly source: string;
  readonly published_by: string;
  readonly published_at: string;
}

interface PublicationEventRow {
  readonly event_id: string;
  readonly kind: string;
  readonly recipe_id: string;
  readonly generation_id: string;
  readonly previous_generation_id: string | null;
  readonly actor_principal_id: string;
  readonly occurred_at: string;
}

/** Private Hub-owned persistence for inert layout authoring drafts. */
export class SqliteProductViewRecipeDraftStore implements ProductViewRecipeDraftStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly idFactory: () => string;
  private readonly generationIdFactory: () => string;
  private readonly eventIdFactory: () => string;
  private readonly clock: () => Date;
  private closed = false;

  constructor(options: SqliteProductViewRecipeDraftStoreOptions) {
    if (typeof options?.path !== "string" || options.path.trim().length === 0) {
      throw new TypeError("Product view recipe draft store path is required");
    }
    this.path = options.path;
    this.idFactory = options.idFactory ?? (() => `draft-${randomUUID()}`);
    this.generationIdFactory = options.generationIdFactory ?? (() => `generation-${randomUUID()}`);
    this.eventIdFactory = options.eventIdFactory ?? (() => `publication-event-${randomUUID()}`);
    this.clock = options.clock ?? (() => new Date());
    if (!isMemoryPath(this.path)) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      const busyTimeoutMs = validBusyTimeout(options.busyTimeoutMs);
      this.db = new DatabaseSync(this.path);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${busyTimeoutMs};`);
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

        CREATE TABLE IF NOT EXISTS product_view_recipe_publication_generations (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          generation_id TEXT NOT NULL UNIQUE,
          recipe_id TEXT NOT NULL,
          title TEXT NOT NULL,
          draft_id TEXT NOT NULL,
          draft_revision INTEGER NOT NULL CHECK (draft_revision > 0),
          recipe_digest TEXT NOT NULL,
          source TEXT NOT NULL,
          published_by TEXT NOT NULL,
          published_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS product_view_recipe_active_publications (
          recipe_id TEXT PRIMARY KEY,
          generation_id TEXT NOT NULL UNIQUE,
          FOREIGN KEY (generation_id) REFERENCES product_view_recipe_publication_generations(generation_id)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS product_view_recipe_publication_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL CHECK (kind IN ('published', 'rolled_back', 'deactivated')),
          recipe_id TEXT NOT NULL,
          generation_id TEXT NOT NULL,
          previous_generation_id TEXT,
          actor_principal_id TEXT NOT NULL,
          occurred_at TEXT NOT NULL
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

  publish(input: {
    readonly draftId: string;
    readonly ownerPrincipalId: string;
    readonly expectedRevision: number;
    readonly actorPrincipalId: string;
  }): ProductViewRecipePublication {
    this.assertOpen();
    const draftId = validIdentifier(input?.draftId);
    const ownerPrincipalId = validPrincipal(input?.ownerPrincipalId);
    const expectedRevision = validRevision(input?.expectedRevision);
    const actorPrincipalId = validPrincipal(input?.actorPrincipalId);
    if (actorPrincipalId !== ownerPrincipalId) throw storeError("invalid_input");
    begin(this.db);
    try {
      const draftRow = this.db.prepare(`
        SELECT draft_id, owner_principal_id, revision, label, source, updated_at, input_digest
        FROM product_view_recipe_drafts
        WHERE draft_id = ? AND owner_principal_id = ?
      `).get(draftId, ownerPrincipalId) as unknown as DraftRow | undefined;
      if (draftRow === undefined) throw storeError("not_found");
      const draft = record(draftRow);
      validStoredDigest(draftRow.input_digest);
      if (draft.revision !== expectedRevision) throw storeError("revision_conflict");
      const compiled = compilePublicationSource(draft.source);
      const activeRow = this.db.prepare(`
        SELECT generation_id, recipe_id, title, draft_id, draft_revision, recipe_digest, source, published_by, published_at
        FROM product_view_recipe_publication_generations
        WHERE generation_id = (
          SELECT generation_id FROM product_view_recipe_active_publications WHERE recipe_id = ?
        )
      `).get(compiled.recipeId) as unknown as PublicationRow | undefined;
      if (activeRow !== undefined) {
        const active = publication(activeRow);
        if (active.draftId === draftId && active.draftRevision === expectedRevision && active.recipeDigest === compiled.recipeDigest) {
          this.db.exec("COMMIT");
          return active;
        }
      } else {
        const activeCount = countRows(this.db, "product_view_recipe_active_publications");
        if (activeCount >= MAX_ACTIVE_PUBLICATIONS) throw storeError("publication_capacity_full");
      }
      ensurePublicationGenerationSlot(this.db);
      const generationId = generatedIdentifier(this.generationIdFactory);
      const eventId = generatedIdentifier(this.eventIdFactory);
      const publishedAt = validTimestamp(this.clock());
      this.db.prepare(`
        INSERT INTO product_view_recipe_publication_generations (
          generation_id, recipe_id, title, draft_id, draft_revision, recipe_digest,
          source, published_by, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        generationId,
        compiled.recipeId,
        compiled.title,
        draftId,
        expectedRevision,
        compiled.recipeDigest,
        compiled.source,
        actorPrincipalId,
        publishedAt,
      );
      this.db.prepare(`
        INSERT INTO product_view_recipe_active_publications (recipe_id, generation_id)
        VALUES (?, ?)
        ON CONFLICT(recipe_id) DO UPDATE SET generation_id = excluded.generation_id
      `).run(compiled.recipeId, generationId);
      appendPublicationEvent(this.db, {
        eventId,
        kind: "published",
        recipeId: compiled.recipeId,
        generationId,
        ...(activeRow === undefined ? {} : { previousGenerationId: activeRow.generation_id }),
        actorPrincipalId,
        occurredAt: publishedAt,
      });
      ensurePrivateSqliteFiles(this.path);
      this.db.exec("COMMIT");
      return publication({
        generation_id: generationId,
        recipe_id: compiled.recipeId,
        title: compiled.title,
        draft_id: draftId,
        draft_revision: expectedRevision,
        recipe_digest: compiled.recipeDigest,
        source: compiled.source,
        published_by: actorPrincipalId,
        published_at: publishedAt,
      });
    } catch (error) {
      rollback(this.db);
      throw stableStoreError(error);
    }
  }

  rollbackPublication(input: {
    readonly recipeId: string;
    readonly expectedGenerationId: string;
    readonly actorPrincipalId: string;
  }): ProductViewRecipePublication {
    this.assertOpen();
    const recipeId = validIdentifier(input?.recipeId);
    const expectedGenerationId = validIdentifier(input?.expectedGenerationId);
    const actorPrincipalId = validPrincipal(input?.actorPrincipalId);
    begin(this.db);
    try {
      const current = this.db.prepare(`
        SELECT g.sequence, g.generation_id
        FROM product_view_recipe_active_publications a
        JOIN product_view_recipe_publication_generations g ON g.generation_id = a.generation_id
        WHERE a.recipe_id = ?
      `).get(recipeId) as { sequence: number; generation_id: string } | undefined;
      if (current === undefined) throw storeError("not_found");
      if (current.generation_id !== expectedGenerationId) throw storeError("publication_conflict");
      const targetRow = this.db.prepare(`
        SELECT generation_id, recipe_id, title, draft_id, draft_revision, recipe_digest, source, published_by, published_at
        FROM product_view_recipe_publication_generations
        WHERE recipe_id = ? AND sequence < ?
        ORDER BY sequence DESC
        LIMIT 1
      `).get(recipeId, current.sequence) as unknown as PublicationRow | undefined;
      if (targetRow === undefined) throw storeError("publication_conflict");
      const target = publication(targetRow);
      const changed = this.db.prepare(`
        UPDATE product_view_recipe_active_publications
        SET generation_id = ?
        WHERE recipe_id = ? AND generation_id = ?
      `).run(target.generationId, recipeId, expectedGenerationId);
      if (Number(changed.changes) !== 1) throw storeError("publication_conflict");
      const occurredAt = validTimestamp(this.clock());
      appendPublicationEvent(this.db, {
        eventId: generatedIdentifier(this.eventIdFactory),
        kind: "rolled_back",
        recipeId,
        generationId: target.generationId,
        previousGenerationId: expectedGenerationId,
        actorPrincipalId,
        occurredAt,
      });
      ensurePrivateSqliteFiles(this.path);
      this.db.exec("COMMIT");
      return target;
    } catch (error) {
      rollback(this.db);
      throw stableStoreError(error);
    }
  }

  deactivatePublication(input: {
    readonly recipeId: string;
    readonly expectedGenerationId: string;
    readonly actorPrincipalId: string;
  }): void {
    this.assertOpen();
    const recipeId = validIdentifier(input?.recipeId);
    const expectedGenerationId = validIdentifier(input?.expectedGenerationId);
    const actorPrincipalId = validPrincipal(input?.actorPrincipalId);
    begin(this.db);
    try {
      const changed = this.db.prepare(`
        DELETE FROM product_view_recipe_active_publications
        WHERE recipe_id = ? AND generation_id = ?
      `).run(recipeId, expectedGenerationId);
      if (Number(changed.changes) !== 1) {
        const exists = this.db.prepare("SELECT 1 AS present FROM product_view_recipe_active_publications WHERE recipe_id = ?").get(recipeId);
        throw storeError(exists === undefined ? "not_found" : "publication_conflict");
      }
      const occurredAt = validTimestamp(this.clock());
      appendPublicationEvent(this.db, {
        eventId: generatedIdentifier(this.eventIdFactory),
        kind: "deactivated",
        recipeId,
        generationId: expectedGenerationId,
        actorPrincipalId,
        occurredAt,
      });
      ensurePrivateSqliteFiles(this.path);
      this.db.exec("COMMIT");
    } catch (error) {
      rollback(this.db);
      throw stableStoreError(error);
    }
  }

  listActivePublications(): readonly ProductViewRecipePublication[] {
    this.assertOpen();
    try {
      const rows = this.db.prepare(`
        SELECT g.generation_id, g.recipe_id, g.title, g.draft_id, g.draft_revision,
               g.recipe_digest, g.source, g.published_by, g.published_at
        FROM product_view_recipe_active_publications a
        JOIN product_view_recipe_publication_generations g ON g.generation_id = a.generation_id
        ORDER BY g.recipe_id ASC
        LIMIT 16
      `).all() as unknown as PublicationRow[];
      return Object.freeze(rows.map(publication));
    } catch (error) {
      throw stableStoreError(error);
    }
  }

  listPublicationEvents(): readonly ProductViewRecipePublicationEvent[] {
    this.assertOpen();
    try {
      const rows = this.db.prepare(`
        SELECT event_id, kind, recipe_id, generation_id, previous_generation_id,
               actor_principal_id, occurred_at
        FROM product_view_recipe_publication_events
        ORDER BY sequence ASC
        LIMIT 256
      `).all() as unknown as PublicationEventRow[];
      return Object.freeze(rows.map(publicationEvent));
    } catch (error) {
      throw stableStoreError(error);
    }
  }

  canRollbackPublication(recipeId: string, generationId: string): boolean {
    this.assertOpen();
    const normalizedRecipeId = validIdentifier(recipeId);
    const normalizedGenerationId = validIdentifier(generationId);
    try {
      const row = this.db.prepare(`
        SELECT EXISTS (
          SELECT 1
          FROM product_view_recipe_publication_generations older
          WHERE older.recipe_id = current.recipe_id AND older.sequence < current.sequence
        ) AS available
        FROM product_view_recipe_active_publications active
        JOIN product_view_recipe_publication_generations current ON current.generation_id = active.generation_id
        WHERE active.recipe_id = ? AND active.generation_id = ?
      `).get(normalizedRecipeId, normalizedGenerationId) as { available: number } | undefined;
      if (row === undefined) return false;
      if (row.available !== 0 && row.available !== 1) throw storeError("corrupt");
      return row.available === 1;
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

function publication(row: PublicationRow): ProductViewRecipePublication {
  try {
    const recipeDigest = validRecipeDigest(row.recipe_digest);
    const source = validSource(row.source);
    const parsed = JSON.parse(source);
    const compiled = compileProductViewRecipe(parsed);
    const report = runProductViewRecipeConformance(parsed);
    if (compiled.id !== row.recipe_id || compiled.title !== row.title || report.recipeDigest !== recipeDigest || !report.passed) {
      throw storeError("corrupt");
    }
    return Object.freeze({
      generationId: validIdentifier(row.generation_id),
      recipeId: validIdentifier(row.recipe_id),
      title: validLabel(row.title),
      draftId: validIdentifier(row.draft_id),
      draftRevision: validRevision(row.draft_revision),
      recipeDigest,
      source,
      publishedBy: validPrincipal(row.published_by),
      publishedAt: validStoredTimestamp(row.published_at),
    });
  } catch {
    throw storeError("corrupt");
  }
}

function publicationEvent(row: PublicationEventRow): ProductViewRecipePublicationEvent {
  try {
    const kind = row.kind === "published" || row.kind === "rolled_back" || row.kind === "deactivated"
      ? row.kind
      : undefined;
    if (kind === undefined) throw storeError("corrupt");
    return Object.freeze({
      eventId: validIdentifier(row.event_id),
      kind,
      recipeId: validIdentifier(row.recipe_id),
      generationId: validIdentifier(row.generation_id),
      ...(row.previous_generation_id === null ? {} : { previousGenerationId: validIdentifier(row.previous_generation_id) }),
      actorPrincipalId: validPrincipal(row.actor_principal_id),
      occurredAt: validStoredTimestamp(row.occurred_at),
    });
  } catch {
    throw storeError("corrupt");
  }
}

function compilePublicationSource(source: string): {
  readonly recipeId: string;
  readonly title: string;
  readonly recipeDigest: `sha256:${string}`;
  readonly source: string;
} {
  try {
    const input = JSON.parse(source);
    const recipe = compileProductViewRecipe(input);
    const report = runProductViewRecipeConformance(input);
    if (!report.passed || report.recipeDigest === undefined || report.recipeId !== recipe.id) {
      throw storeError("recipe_invalid");
    }
    return Object.freeze({
      recipeId: recipe.id,
      title: recipe.title,
      recipeDigest: report.recipeDigest,
      source: JSON.stringify(recipe),
    });
  } catch (error) {
    if (error instanceof ProductViewRecipeDraftStoreError) throw error;
    throw storeError("recipe_invalid");
  }
}

function validRecipeDigest(value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw storeError("corrupt");
  return value as `sha256:${string}`;
}

function countRows(db: DatabaseSync, table: "product_view_recipe_active_publications" | "product_view_recipe_publication_generations"): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  if (!Number.isSafeInteger(row.count) || row.count < 0) throw storeError("corrupt");
  return row.count;
}

function ensurePublicationGenerationSlot(db: DatabaseSync): void {
  if (countRows(db, "product_view_recipe_publication_generations") < MAX_PUBLICATION_GENERATIONS) return;
  const removed = db.prepare(`
    DELETE FROM product_view_recipe_publication_generations
    WHERE generation_id = (
      SELECT g.generation_id
      FROM product_view_recipe_publication_generations g
      LEFT JOIN product_view_recipe_active_publications a ON a.generation_id = g.generation_id
      WHERE a.generation_id IS NULL
      ORDER BY g.sequence ASC
      LIMIT 1
    )
  `).run();
  if (Number(removed.changes) !== 1) throw storeError("publication_capacity_full");
}

function appendPublicationEvent(db: DatabaseSync, event: ProductViewRecipePublicationEvent): void {
  db.prepare(`
    INSERT INTO product_view_recipe_publication_events (
      event_id, kind, recipe_id, generation_id, previous_generation_id,
      actor_principal_id, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.eventId,
    event.kind,
    event.recipeId,
    event.generationId,
    event.previousGenerationId ?? null,
    event.actorPrincipalId,
    event.occurredAt,
  );
  db.prepare(`
    DELETE FROM product_view_recipe_publication_events
    WHERE sequence IN (
      SELECT sequence FROM product_view_recipe_publication_events
      ORDER BY sequence DESC
      LIMIT -1 OFFSET ?
    )
  `).run(MAX_PUBLICATION_EVENTS);
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
