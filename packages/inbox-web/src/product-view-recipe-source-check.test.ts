import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  checkProductViewRecipeSource,
  formatProductViewRecipeSourceCheck,
} from "./product-view-recipe-source-check.js";

const validSource = JSON.stringify({
  apiVersion: "hob.view.recipe/v1",
  id: "community.calm-household",
  title: "从容家庭",
  pages: [{
    route: "overview",
    layout: "split",
    slots: [
      { slot: "overview.header", width: "full" },
      { slot: "overview.status", width: "full" },
      { slot: "overview.spaces", width: "half" },
      { slot: "overview.review-summary", width: "half" },
      { slot: "overview.composer", width: "full" },
    ],
  }],
});

test("checks one bounded layout source and formats publication evidence", () => {
  const result = checkProductViewRecipeSource(validSource);

  assert.equal(result.passed, true);
  if (!result.passed) return;
  assert.equal(result.recipeId, "community.calm-household");
  assert.match(result.recipeDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.passedChecks, 7);
  assert.equal(result.totalChecks, 7);
  assert.deepEqual(formatProductViewRecipeSourceCheck(result), [
    "Layout recipe ready: community.calm-household",
    `Digest: ${result.recipeDigest}`,
    "Conformance: 7/7 passed",
  ]);
  assert.equal(Object.isFrozen(result), true);
});

test("returns stable redacted reasons for syntax, recipe, and size failures", () => {
  const marker = "private-household-marker";
  const cases = [
    { source: `{\"title\":\"${marker}`, reason: "syntax_invalid", message: "Layout recipe needs valid JSON." },
    { source: JSON.stringify({ ...JSON.parse(validSource), script: marker }), reason: "recipe_invalid", message: "Layout recipe needs a supported data-only structure." },
    { source: marker.repeat(6_000), reason: "source_too_large", message: "Layout recipe must fit within 64 KiB." },
  ] as const;

  for (const item of cases) {
    const result = checkProductViewRecipeSource(item.source);
    assert.deepEqual(result, Object.freeze({ passed: false, reason: item.reason }));
    assert.deepEqual(formatProductViewRecipeSourceCheck(result), [item.message]);
    assert.equal(JSON.stringify(result).includes(marker), false);
  }
});

test("keeps the checked developer example ready for publication", () => {
  const source = readFileSync(
    new URL("../../../examples/views/calm-household.json", import.meta.url),
    "utf8",
  );
  const result = checkProductViewRecipeSource(source);

  assert.equal(result.passed, true);
  if (!result.passed) return;
  assert.equal(result.recipeId, "community.calm-household");
  assert.equal(result.passedChecks, result.totalChecks);
});
