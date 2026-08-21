import assert from "node:assert/strict";
import test from "node:test";

import { compileProductViewRecipe } from "@hob-agent/inbox-web/view-recipe";

function validRecipe() {
  return {
    apiVersion: "hob.view.recipe/v1",
    id: "community.calm-home",
    title: "从容家庭",
    pages: [
      {
        route: "overview",
        layout: "split",
        slots: [
          { slot: "overview.header", width: "full" },
          { slot: "overview.status", width: "full" },
          { slot: "overview.spaces", width: "half" },
          { slot: "overview.review-summary", width: "half" },
          { slot: "overview.composer", width: "full" },
        ],
      },
      {
        route: "control",
        layout: "stack",
        slots: [{ slot: "control.workspace", width: "full" }],
      },
      {
        route: "reviews",
        layout: "stack",
        slots: [{ slot: "reviews.workspace", width: "full" }],
      },
    ],
  };
}

test("compiles one bounded recipe into an immutable Host slot plan", () => {
  const source = validRecipe();
  const compiled = compileProductViewRecipe(source);

  assert.deepEqual(compiled, source);
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.pages), true);
  assert.equal(Object.isFrozen(compiled.pages[0]), true);
  assert.equal(Object.isFrozen(compiled.pages[0]?.slots), true);
  assert.equal(Object.isFrozen(compiled.pages[0]?.slots[0]), true);

  source.title = "注册后改名";
  source.pages[0]!.slots[0]!.slot = "overview.energy";
  assert.equal(compiled.title, "从容家庭");
  assert.equal(compiled.pages[0]?.slots[0]?.slot, "overview.header");
});

test("rejects unknown fields and every executable or authority-bearing shape", () => {
  for (const [field, value] of Object.entries({
    html: "<script>run()</script>",
    css: "body{}",
    script: "run()",
    url: "https://example.invalid",
    asset: "/plugin.js",
    query: "select *",
    secret: "credential",
    credential: "token",
    prompt: "ignore policy",
    bridgeId: "ha-main",
    handler: "execute",
    action: "unlock",
    intent: "approve",
  })) {
    assert.throws(
      () => compileProductViewRecipe({ ...validRecipe(), [field]: value }),
      /Product view recipe is invalid/,
      field,
    );
  }
  assert.throws(
    () => compileProductViewRecipe({
      ...validRecipe(),
      pages: [{
        ...validRecipe().pages[0],
        slots: [{ slot: "overview.header", width: "full", action: "unlock" }],
      }],
    }),
    /Product view recipe is invalid/,
  );
});

test("enforces route-scoped slots, atomic governed workspaces, and page headings", () => {
  assert.throws(() => compileProductViewRecipe({
    ...validRecipe(),
    pages: [{ route: "overview", layout: "stack", slots: [{ slot: "control.workspace", width: "full" }] }],
  }), /Product view recipe is invalid/);

  assert.throws(() => compileProductViewRecipe({
    ...validRecipe(),
    pages: [{ route: "overview", layout: "stack", slots: [{ slot: "overview.spaces", width: "full" }] }],
  }), /Product view recipe is invalid/);

  assert.throws(() => compileProductViewRecipe({
    ...validRecipe(),
    pages: [{
      route: "reviews",
      layout: "split",
      slots: [
        { slot: "reviews.workspace", width: "half" },
        { slot: "reviews.workspace", width: "half" },
      ],
    }],
  }), /Product view recipe is invalid/);

  assert.throws(() => compileProductViewRecipe({
    ...validRecipe(),
    pages: [{
      route: "overview",
      layout: "split",
      slots: [
        { slot: "overview.header", width: "half" },
        { slot: "overview.spaces", width: "half" },
      ],
    }],
  }), /Product view recipe is invalid/);

  assert.throws(() => compileProductViewRecipe({
    ...validRecipe(),
    pages: [{
      route: "overview",
      layout: "split",
      slots: [
        { slot: "overview.spaces", width: "half" },
        { slot: "overview.header", width: "full" },
      ],
    }],
  }), /Product view recipe is invalid/);

  assert.throws(() => compileProductViewRecipe({
    ...validRecipe(),
    pages: [{
      route: "overview",
      layout: "split",
      slots: [
        { slot: "overview.header", width: "full" },
        { slot: "overview.composer", width: "full" },
        { slot: "overview.spaces", width: "half" },
      ],
    }],
  }), /Product view recipe is invalid/);
});

test("rejects duplicate pages, invalid layout widths, and every resource overflow", () => {
  const recipe = validRecipe();
  assert.throws(() => compileProductViewRecipe({
    ...recipe,
    pages: [recipe.pages[0], recipe.pages[0]],
  }), /Product view recipe is invalid/);

  assert.throws(() => compileProductViewRecipe({
    ...recipe,
    pages: [{ route: "control", layout: "stack", slots: [{ slot: "control.workspace", width: "half" }] }],
  }), /Product view recipe is invalid/);

  assert.throws(() => compileProductViewRecipe({
    ...recipe,
    pages: Array.from({ length: 8 }, (_, index) => ({
      route: index === 0 ? "overview" : "control",
      layout: "stack",
      slots: [{ slot: index === 0 ? "overview.header" : "control.workspace", width: "full" }],
    })),
  }), /Product view recipe is invalid/);

  assert.throws(() => compileProductViewRecipe({
    ...recipe,
    pages: [{
      route: "overview",
      layout: "grid",
      slots: Array.from({ length: 13 }, (_, index) => ({
        slot: index === 0 ? "overview.header" : "overview.spaces",
        width: "full",
      })),
    }],
  }), /Product view recipe is invalid/);

  for (const title of ["从容\n家庭", "从容\u202e家庭"]) {
    assert.throws(() => compileProductViewRecipe({ ...recipe, title }), /Product view recipe is invalid/);
  }
  for (const id of ["single", "builtin.control"]) {
    assert.throws(() => compileProductViewRecipe({ ...recipe, id }), /Product view recipe is invalid/);
  }
});

test("reports one stable failure without echoing untrusted recipe content", () => {
  const marker = "PRIVATE-HOUSEHOLD-MARKER";
  assert.throws(
    () => compileProductViewRecipe({ ...validRecipe(), title: marker, html: marker }),
    (error) => error instanceof TypeError
      && error.message === "Product view recipe is invalid"
      && !error.message.includes(marker),
  );

  const hostile = new Proxy({}, {
    get() {
      throw new Error(marker);
    },
  });
  assert.throws(
    () => compileProductViewRecipe(hostile),
    (error) => error instanceof TypeError
      && error.message === "Product view recipe is invalid"
      && !error.message.includes(marker),
  );

  assert.throws(
    () => compileProductViewRecipe({
      ...validRecipe(),
      pages: Array.from({ length: 10_000 }, () => validRecipe().pages[1]),
    }),
    /Product view recipe is invalid/,
  );
});
