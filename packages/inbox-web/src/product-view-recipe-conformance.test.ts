import assert from "node:assert/strict";
import test from "node:test";

import { runProductViewRecipeConformance } from "@hob-agent/inbox-web/view-recipe-conformance";

function recipe() {
  return {
    apiVersion: "hob.view.recipe/v1",
    id: "community.calm-home",
    title: "安静家庭",
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
  };
}

test("produces one immutable redacted conformance report for a declarative layout", () => {
  const report = runProductViewRecipeConformance(recipe());

  assert.equal(report.passed, true);
  assert.equal(report.recipeId, "community.calm-home");
  assert.match(report.recipeDigest ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(report.checks.map(({ name, status }) => ({ name, status })), [
    { name: "recipe_compilation", status: "passed" },
    { name: "immutable_plan", status: "passed" },
    { name: "deterministic_render", status: "passed" },
    { name: "semantic_headings", status: "passed" },
    { name: "host_boundary", status: "passed" },
    { name: "canonical_fallback", status: "passed" },
    { name: "responsive_layout", status: "passed" },
  ]);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.checks), true);
  assert.equal(Object.isFrozen(report.checks[0]), true);
});

test("reports invalid recipe data without reflecting its content", () => {
  const marker = "private-household-marker";
  const report = runProductViewRecipeConformance({
    ...recipe(),
    title: marker,
    script: marker,
  });

  assert.equal(report.passed, false);
  assert.equal(report.recipeId, undefined);
  assert.equal(report.recipeDigest, undefined);
  assert.deepEqual(report.checks, [
    { name: "recipe_compilation", status: "failed" },
    { name: "immutable_plan", status: "blocked" },
    { name: "deterministic_render", status: "blocked" },
    { name: "semantic_headings", status: "blocked" },
    { name: "host_boundary", status: "blocked" },
    { name: "canonical_fallback", status: "blocked" },
    { name: "responsive_layout", status: "blocked" },
  ]);
  assert.equal(JSON.stringify(report).includes(marker), false);
});

test("binds the report identity to the exact ordered layout plan", () => {
  const first = runProductViewRecipeConformance(recipe());
  const changed = recipe();
  changed.pages[0]!.slots.reverse();
  const invalidOrder = runProductViewRecipeConformance(changed);
  const validChanged = recipe();
  validChanged.pages[0]!.slots[1] = { slot: "overview.agent-note", width: "full" };
  const second = runProductViewRecipeConformance(validChanged);

  assert.equal(invalidOrder.passed, false);
  assert.equal(second.passed, true);
  assert.notEqual(first.recipeDigest, second.recipeDigest);
});

test("passes every semantic workspace through the same publication boundary", () => {
  const report = runProductViewRecipeConformance({
    apiVersion: "hob.view.recipe/v1",
    id: "community.complete-home",
    title: "完整家庭",
    pages: [
      {
        route: "overview",
        layout: "stack",
        slots: [{ slot: "overview.header", width: "full" }],
      },
      {
        route: "conversation",
        layout: "stack",
        slots: [{ slot: "conversation.workspace", width: "full" }],
      },
      {
        route: "reviews",
        layout: "stack",
        slots: [{ slot: "reviews.workspace", width: "full" }],
      },
      {
        route: "activity",
        layout: "stack",
        slots: [{ slot: "activity.workspace", width: "full" }],
      },
      {
        route: "control",
        layout: "stack",
        slots: [{ slot: "control.workspace", width: "full" }],
      },
      {
        route: "settings",
        layout: "stack",
        slots: [{ slot: "settings.workspace", width: "full" }],
      },
      {
        route: "onboarding",
        layout: "stack",
        slots: [{ slot: "onboarding.workspace", width: "full" }],
      },
    ],
  });

  assert.equal(report.passed, true);
  assert.equal(report.checks.every(({ status }) => status === "passed"), true);
});
