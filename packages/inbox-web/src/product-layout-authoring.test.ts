import assert from "node:assert/strict";
import test from "node:test";

import { renderProductLayoutAuthoring } from "./product-layout-authoring.js";

const source = JSON.stringify({
  apiVersion: "hob.view.recipe/v1",
  id: "community.calm-household",
  title: "从容家庭",
  pages: [{
    route: "overview",
    layout: "stack",
    slots: [{ slot: "overview.header", width: "full" }],
  }],
});

test("renders one owner-scoped layout workspace with bounded redacted publication history", () => {
  const publication = Object.freeze({
    generationId: "generation-current-private",
    recipeId: "community.calm-household",
    title: "从容家庭",
    draftId: "draft-1",
    draftRevision: 1,
    recipeDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
    source,
    publishedBy: "admin-1",
    publishedAt: "2026-08-22T01:00:00.000Z",
  });
  const html = renderProductLayoutAuthoring({
    model: { route: "settings" },
    ownerPrincipalId: "admin-1",
    selectedDraftId: "draft-1",
    preview: true,
    notice: "published",
    acceptsDynamic: () => true,
    drafts: {
      create() { throw new Error("unused"); },
      update() { throw new Error("unused"); },
      remove() { throw new Error("unused"); },
      read() {
        return {
          draftId: "draft-1",
          ownerPrincipalId: "admin-1",
          revision: 1,
          label: "从容家庭草稿",
          source,
          updatedAt: "2026-08-22T01:00:00.000Z",
        };
      },
      list() {
        return [{
          draftId: "draft-1",
          revision: 1,
          label: "从容家庭草稿",
          updatedAt: "2026-08-22T01:00:00.000Z",
        }];
      },
      listActivePublications() { return [publication]; },
      canRollbackPublication() { return false; },
      listPublicationEvents() {
        return Array.from({ length: 10 }, (_, index) => ({
          eventId: `event-${index + 1}`,
          kind: index === 9 ? "rolled_back" as const : "published" as const,
          recipeId: "community.calm-household",
          generationId: `generation-${index + 1}-private`,
          actorPrincipalId: `actor-${index + 1}`,
          occurredAt: `2026-08-22T01:${String(index).padStart(2, "0")}:00.000Z`,
        }));
      },
    },
  });

  assert.match(html, /布局工作室/);
  assert.match(html, /data-layout-preview-status="ready"/);
  assert.match(html, /<iframe[^>]+inert[^>]+sandbox/);
  assert.match(html, /布局版本已发布/);
  assert.match(html, /恢复了上一版 community\.calm-household/);
  assert.match(html, /actor-10/);
  assert.match(html, /actor-3/);
  assert.doesNotMatch(html, /actor-[12](?:<|\s|·)/);
  const history = html.slice(html.indexOf('<div class="product-layout-publication-history">'));
  assert.doesNotMatch(history, /generation-[a-z0-9-]+-private/);
  assert.ok(html.indexOf("actor-10") < html.indexOf("actor-3"));
});

test("renders a calm recovery surface when draft storage is unavailable", () => {
  const html = renderProductLayoutAuthoring({
    model: { route: "settings" },
    ownerPrincipalId: "admin-1",
    acceptsDynamic: () => true,
    drafts: {
      create() { throw new Error("unused"); },
      update() { throw new Error("unused"); },
      remove() { throw new Error("unused"); },
      read() { throw new Error("storage"); },
      list() { throw new Error("storage"); },
    },
  });

  assert.match(html, /草稿存储正在恢复/);
  assert.match(html, /连接恢复后可继续编辑/);
});
