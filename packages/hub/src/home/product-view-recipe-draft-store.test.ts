import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  ProductViewRecipeDraftStoreError,
  SqliteProductViewRecipeDraftStore,
} from "./product-view-recipe-draft-store.js";

async function fixture(name: string) {
  const directory = await mkdtemp(join(tmpdir(), `hob-layout-draft-${name}-`));
  const path = join(directory, "layout-drafts.sqlite");
  let nextId = 0;
  const store = new SqliteProductViewRecipeDraftStore({
    path,
    idFactory: () => `draft-${++nextId}`,
    clock: () => new Date("2026-08-22T00:00:00.000Z"),
    busyTimeoutMs: 5,
  });
  return { directory, path, store };
}

test("persists inert incomplete draft source privately across reopen", async () => {
  const item = await fixture("persist");
  try {
    const created = item.store.create({
      ownerPrincipalId: "owner-a",
      label: "客厅布局",
      source: '{"apiVersion":"hob.view.recipe/v1",',
      idempotencyKey: "create-layout-1",
    });
    assert.deepEqual(created, {
      draftId: "draft-1",
      ownerPrincipalId: "owner-a",
      revision: 1,
      label: "客厅布局",
      source: '{"apiVersion":"hob.view.recipe/v1",',
      updatedAt: "2026-08-22T00:00:00.000Z",
    });
    assert.equal(Object.isFrozen(created), true);
    assert.deepEqual(item.store.list("owner-a"), [{
      draftId: "draft-1",
      revision: 1,
      label: "客厅布局",
      updatedAt: "2026-08-22T00:00:00.000Z",
    }]);
    assert.equal("source" in item.store.list("owner-a")[0]!, false);
    item.store.close();

    const reopened = new SqliteProductViewRecipeDraftStore({ path: item.path });
    assert.equal(reopened.read("draft-1", "owner-a")?.source, created.source);
    reopened.close();
    assert.equal((await stat(item.path)).mode & 0o777, 0o600);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("deduplicates create and enforces owner plus optimistic revision", async () => {
  const item = await fixture("revision");
  try {
    const command = {
      ownerPrincipalId: "owner-a",
      label: "安静家庭",
      source: "{}",
      idempotencyKey: "create-layout-2",
    };
    const created = item.store.create(command);
    assert.deepEqual(item.store.create(command), created);
    assert.equal(item.store.read(created.draftId, "owner-b"), undefined);

    const updated = item.store.update({
      draftId: created.draftId,
      ownerPrincipalId: "owner-a",
      expectedRevision: 1,
      label: "安静家庭 2",
      source: '{"pages":[]}',
    });
    assert.equal(updated.revision, 2);
    assert.equal(updated.source, '{"pages":[]}');
    assert.equal(Object.isFrozen(updated), true);
    assert.throws(() => item.store.update({
      draftId: created.draftId,
      ownerPrincipalId: "owner-a",
      expectedRevision: 1,
      label: "过期修改",
      source: "{}",
    }), (error) => error instanceof ProductViewRecipeDraftStoreError && error.code === "revision_conflict");
    assert.throws(() => item.store.update({
      draftId: created.draftId,
      ownerPrincipalId: "owner-b",
      expectedRevision: 2,
      label: "其他成员",
      source: "{}",
    }), (error) => error instanceof ProductViewRecipeDraftStoreError && error.code === "not_found");
    item.store.close();
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("rejects idempotency reuse, oversized source and the thirty-third draft", async () => {
  const item = await fixture("bounds");
  try {
    item.store.create({ ownerPrincipalId: "owner-a", label: "布局 1", source: "{}", idempotencyKey: "key-1" });
    assert.throws(() => item.store.create({
      ownerPrincipalId: "owner-a",
      label: "改写",
      source: "{}",
      idempotencyKey: "key-1",
    }), (error) => error instanceof ProductViewRecipeDraftStoreError && error.code === "idempotency_conflict");
    assert.throws(() => item.store.create({
      ownerPrincipalId: "owner-a",
      label: "过大",
      source: "x".repeat(65_537),
      idempotencyKey: "oversized",
    }), (error) => error instanceof ProductViewRecipeDraftStoreError && error.code === "invalid_input");
    for (let index = 2; index <= 32; index += 1) {
      item.store.create({
        ownerPrincipalId: "owner-a",
        label: `布局 ${index}`,
        source: "{}",
        idempotencyKey: `key-${index}`,
      });
    }
    assert.throws(() => item.store.create({
      ownerPrincipalId: "owner-a",
      label: "布局 33",
      source: "{}",
      idempotencyKey: "key-33",
    }), (error) => error instanceof ProductViewRecipeDraftStoreError && error.code === "capacity_full");
    item.store.remove({ draftId: "draft-2", ownerPrincipalId: "owner-a", expectedRevision: 1 });
    assert.equal(item.store.read("draft-2", "owner-a"), undefined);
    assert.equal(item.store.create({
      ownerPrincipalId: "owner-a",
      label: "布局 33",
      source: "{}",
      idempotencyKey: "key-33",
    }).label, "布局 33");
    item.store.close();
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("surfaces a stable storage classification while keeping source out of the error", async () => {
  const item = await fixture("redaction");
  const marker = "private-draft-marker";
  try {
    await chmod(item.path, 0o600);
    assert.throws(() => item.store.create({
      ownerPrincipalId: "owner-a",
      label: marker,
      source: `{"value":"${marker}"}`,
      idempotencyKey: "bad key",
    }), (error) => error instanceof ProductViewRecipeDraftStoreError
      && error.code === "invalid_input"
      && !error.message.includes(marker));
    item.store.close();
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("classifies a held write lock and persisted corruption without exposing the path", async () => {
  const locked = await fixture("locked");
  const blocker = new DatabaseSync(locked.path);
  blocker.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => locked.store.create({
      ownerPrincipalId: "owner-a",
      label: "锁定布局",
      source: "{}",
      idempotencyKey: "locked-create",
    }), (error) => error instanceof ProductViewRecipeDraftStoreError
      && error.code === "storage_unavailable"
      && !error.message.includes(locked.path));
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
    locked.store.close();
    await rm(locked.directory, { recursive: true, force: true });
  }

  const corrupt = await fixture("corrupt");
  try {
    const created = corrupt.store.create({
      ownerPrincipalId: "owner-a",
      label: "待校验布局",
      source: "{}",
      idempotencyKey: "corrupt-create",
    });
    corrupt.store.close();
    const raw = new DatabaseSync(corrupt.path);
    raw.prepare("UPDATE product_view_recipe_drafts SET input_digest = 'invalid' WHERE draft_id = ?").run(created.draftId);
    raw.close();
    const reopened = new SqliteProductViewRecipeDraftStore({ path: corrupt.path });
    assert.throws(() => reopened.read(created.draftId, "owner-a"), (error) =>
      error instanceof ProductViewRecipeDraftStoreError && error.code === "corrupt");
    reopened.close();
  } finally {
    await rm(corrupt.directory, { recursive: true, force: true });
  }
});

function recipeSource(title: string, statusWidth: "full" | "half" = "full"): string {
  return JSON.stringify({
    apiVersion: "hob.view.recipe/v1",
    id: "household.calm",
    title,
    pages: [{
      route: "overview",
      layout: statusWidth === "full" ? "stack" : "split",
      slots: [
        { slot: "overview.header", width: "full" },
        { slot: "overview.status", width: statusWidth },
      ],
    }],
  });
}

function namedRecipeSource(id: string, title: string): string {
  return JSON.stringify({
    apiVersion: "hob.view.recipe/v1",
    id,
    title,
    pages: [{ route: "overview", layout: "stack", slots: [{ slot: "overview.header", width: "full" }] }],
  });
}

test("publishes exact immutable generations and rolls back the active pointer", async () => {
  const item = await fixture("publication");
  try {
    const firstDraft = item.store.create({
      ownerPrincipalId: "owner-a",
      label: "安静布局",
      source: recipeSource("安静视图"),
      idempotencyKey: "publication-draft",
    });
    const first = item.store.publish({
      draftId: firstDraft.draftId,
      ownerPrincipalId: "owner-a",
      expectedRevision: 1,
      actorPrincipalId: "owner-a",
    });
    assert.equal(first.recipeId, "household.calm");
    assert.equal(first.draftRevision, 1);
    assert.match(first.recipeDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(first), true);
    assert.deepEqual(item.store.listActivePublications(), [first]);
    assert.equal(item.store.canRollbackPublication(first.recipeId, first.generationId), false);

    const secondDraft = item.store.update({
      draftId: firstDraft.draftId,
      ownerPrincipalId: "owner-a",
      expectedRevision: 1,
      label: "安静布局 2",
      source: recipeSource("安静视图 2", "half"),
    });
    const second = item.store.publish({
      draftId: secondDraft.draftId,
      ownerPrincipalId: "owner-a",
      expectedRevision: 2,
      actorPrincipalId: "owner-a",
    });
    assert.notEqual(second.generationId, first.generationId);
    assert.equal(item.store.listActivePublications()[0]?.generationId, second.generationId);
    assert.equal(item.store.canRollbackPublication(second.recipeId, second.generationId), true);
    assert.throws(() => item.store.publish({
      draftId: secondDraft.draftId,
      ownerPrincipalId: "owner-a",
      expectedRevision: 1,
      actorPrincipalId: "owner-a",
    }), (error) => error instanceof ProductViewRecipeDraftStoreError && error.code === "revision_conflict");

    const restored = item.store.rollbackPublication({
      recipeId: second.recipeId,
      expectedGenerationId: second.generationId,
      actorPrincipalId: "owner-a",
    });
    assert.equal(restored.generationId, first.generationId);
    assert.equal(item.store.canRollbackPublication(restored.recipeId, restored.generationId), false);
    assert.equal(item.store.listActivePublications()[0]?.title, "安静视图");
    assert.deepEqual(item.store.listPublicationEvents().map(({ kind }) => kind), ["published", "published", "rolled_back"]);

    item.store.deactivatePublication({
      recipeId: first.recipeId,
      expectedGenerationId: first.generationId,
      actorPrincipalId: "owner-a",
    });
    assert.deepEqual(item.store.listActivePublications(), []);
    assert.equal(item.store.listPublicationEvents().at(-1)?.kind, "deactivated");
    item.store.close();
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("keeps invalid or stale drafts outside publication history", async () => {
  const item = await fixture("publication-invalid");
  try {
    const draft = item.store.create({
      ownerPrincipalId: "owner-a",
      label: "未完成布局",
      source: '{"apiVersion":',
      idempotencyKey: "invalid-publication",
    });
    assert.throws(() => item.store.publish({
      draftId: draft.draftId,
      ownerPrincipalId: "owner-a",
      expectedRevision: 1,
      actorPrincipalId: "owner-a",
    }), (error) => error instanceof ProductViewRecipeDraftStoreError && error.code === "recipe_invalid");
    assert.deepEqual(item.store.listActivePublications(), []);
    assert.deepEqual(item.store.listPublicationEvents(), []);
    const valid = item.store.update({
      draftId: draft.draftId,
      ownerPrincipalId: "owner-a",
      expectedRevision: 1,
      label: "完成布局",
      source: recipeSource("完整视图"),
    });
    assert.throws(() => item.store.publish({
      draftId: valid.draftId,
      ownerPrincipalId: "owner-a",
      expectedRevision: 2,
      actorPrincipalId: "owner-b",
    }), (error) => error instanceof ProductViewRecipeDraftStoreError && error.code === "invalid_input");
    const published = item.store.publish({
      draftId: valid.draftId,
      ownerPrincipalId: "owner-a",
      expectedRevision: 2,
      actorPrincipalId: "owner-a",
    });
    item.store.close();
    const raw = new DatabaseSync(item.path);
    raw.prepare("UPDATE product_view_recipe_publication_generations SET recipe_digest = ? WHERE generation_id = ?")
      .run(`sha256:${"0".repeat(64)}`, published.generationId);
    raw.close();
    const reopened = new SqliteProductViewRecipeDraftStore({ path: item.path });
    assert.throws(() => reopened.listActivePublications(), (error) =>
      error instanceof ProductViewRecipeDraftStoreError && error.code === "corrupt");
    reopened.close();
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("bounds active publications, retained generations, and audit events", async () => {
  const item = await fixture("publication-bounds");
  try {
    for (let index = 1; index <= 17; index += 1) {
      const draft = item.store.create({
        ownerPrincipalId: "owner-a",
        label: `布局 ${index}`,
        source: namedRecipeSource(`household.layout-${index}`, `布局 ${index}`),
        idempotencyKey: `publication-capacity-${index}`,
      });
      if (index <= 16) {
        item.store.publish({
          draftId: draft.draftId,
          ownerPrincipalId: "owner-a",
          expectedRevision: 1,
          actorPrincipalId: "owner-a",
        });
      } else {
        assert.throws(() => item.store.publish({
          draftId: draft.draftId,
          ownerPrincipalId: "owner-a",
          expectedRevision: 1,
          actorPrincipalId: "owner-a",
        }), (error) => error instanceof ProductViewRecipeDraftStoreError && error.code === "publication_capacity_full");
      }
    }
    assert.equal(item.store.listActivePublications().length, 16);
    item.store.close();
    const raw = new DatabaseSync(item.path);
    assert.equal((raw.prepare("SELECT COUNT(*) AS count FROM product_view_recipe_publication_generations").get() as { count: number }).count, 16);
    assert.equal((raw.prepare("SELECT COUNT(*) AS count FROM product_view_recipe_publication_events").get() as { count: number }).count, 16);
    raw.close();
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }

  const generations = await fixture("generation-bounds");
  try {
    let draft = generations.store.create({
      ownerPrincipalId: "owner-a",
      label: "世代布局",
      source: namedRecipeSource("household.generations", "世代 1"),
      idempotencyKey: "generation-bounds",
    });
    generations.store.publish({ draftId: draft.draftId, ownerPrincipalId: "owner-a", expectedRevision: 1, actorPrincipalId: "owner-a" });
    for (let revision = 2; revision <= 270; revision += 1) {
      draft = generations.store.update({
        draftId: draft.draftId,
        ownerPrincipalId: "owner-a",
        expectedRevision: revision - 1,
        label: "世代布局",
        source: namedRecipeSource("household.generations", `世代 ${revision}`),
      });
      generations.store.publish({
        draftId: draft.draftId,
        ownerPrincipalId: "owner-a",
        expectedRevision: revision,
        actorPrincipalId: "owner-a",
      });
    }
    assert.equal(generations.store.listActivePublications()[0]?.draftRevision, 270);
    assert.equal(generations.store.listPublicationEvents().length, 256);
    generations.store.close();
    const raw = new DatabaseSync(generations.path);
    assert.equal((raw.prepare("SELECT COUNT(*) AS count FROM product_view_recipe_publication_generations").get() as { count: number }).count, 64);
    assert.equal((raw.prepare("SELECT COUNT(*) AS count FROM product_view_recipe_publication_events").get() as { count: number }).count, 256);
    raw.close();
  } finally {
    await rm(generations.directory, { recursive: true, force: true });
  }
});
