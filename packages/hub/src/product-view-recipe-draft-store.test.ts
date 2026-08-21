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
