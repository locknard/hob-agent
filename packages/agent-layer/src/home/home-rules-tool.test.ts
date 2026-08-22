import assert from "node:assert/strict";
import test from "node:test";

import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import { Context } from "@deepseek-ai/cordis";

import { apply, HomeRulesCoverageService, pageHomeRules } from "./home-rules-tool.js";

const CATALOGS = [
  {
    bridgeId: "bridge-b",
    status: "unavailable" as const,
    rules: [],
  },
  {
    bridgeId: "bridge-a",
    status: "available" as const,
    epochId: "epoch-a",
    rules: [
      { ruleRef: "rule-2", name: "Ventilation fallback", enabled: true },
      { ruleRef: "rule-1", name: "Window ventilation", enabled: true, updatedAt: "2026-08-19T01:00:00.000Z" },
      { ruleRef: "rule-3", enabled: false },
    ],
  },
];

test("pages neutral existing-rule metadata and preserves unavailable coverage", () => {
  const first = pageHomeRules(CATALOGS, { limit: 2 });
  assert.deepEqual(first.catalogs, [
    { bridgeId: "bridge-a", status: "available", epochId: "epoch-a", ruleCount: 3 },
    { bridgeId: "bridge-b", status: "unavailable" },
  ]);
  assert.deepEqual(first.rules, [
    { bridgeId: "bridge-a", ruleRef: "rule-1", name: "Window ventilation", enabled: true, updatedAt: "2026-08-19T01:00:00.000Z" },
    { bridgeId: "bridge-a", ruleRef: "rule-2", name: "Ventilation fallback", enabled: true },
  ]);
  assert.equal(first.page.returnedRules, 2);
  assert.equal(first.page.totalRules, 3);
  assert.match(first.catalogVersion, /^[a-f0-9]{64}$/);
  assert.equal(typeof first.page.nextCursor, "string");

  const second = pageHomeRules(CATALOGS, { limit: 2, cursor: first.page.nextCursor });
  assert.equal(second.catalogVersion, first.catalogVersion);
  assert.deepEqual(second.rules, [{ bridgeId: "bridge-a", ruleRef: "rule-3", enabled: false }]);
  assert.equal(second.page.nextCursor, undefined);

  const reordered = pageHomeRules([
    { ...CATALOGS[1]!, rules: [...CATALOGS[1]!.rules].reverse() },
    CATALOGS[0]!,
  ], { limit: 2 });
  assert.equal(reordered.catalogVersion, first.catalogVersion);
});

test("opens autonomous proposal coverage only after a stable ordered rule catalog is exhausted", async () => {
  const ctx = new Context();
  await ctx.plugin(HomeRulesCoverageService);
  ctx.homeRulesCoverage.beginObservation();
  assert.throws(() => ctx.homeRulesCoverage.assertProposalAllowed(), /rule catalog/i);

  const first = pageHomeRules(CATALOGS, { limit: 2 });
  ctx.homeRulesCoverage.record({ limit: 2 }, first);
  assert.throws(() => ctx.homeRulesCoverage.assertProposalAllowed(), /rule catalog/i);

  const secondQuery = { limit: 2, cursor: first.page.nextCursor };
  const second = pageHomeRules(CATALOGS, secondQuery);
  ctx.homeRulesCoverage.record(secondQuery, second);
  assert.doesNotThrow(() => ctx.homeRulesCoverage.assertProposalAllowed());

  ctx.homeRulesCoverage.beginObservation();
  ctx.homeRulesCoverage.record({ limit: 2 }, first);
  ctx.homeRulesCoverage.record(secondQuery, { ...second, catalogVersion: "0".repeat(64) });
  assert.throws(() => ctx.homeRulesCoverage.assertProposalAllowed(), /rule catalog/i);
  ctx.homeRulesCoverage.endObservation();
  await ctx.fiber.dispose();
});

test("rejects malformed cursors and unbounded rule queries", () => {
  assert.throws(() => pageHomeRules(CATALOGS, { limit: 51 }), /limit/);
  assert.throws(() => pageHomeRules(CATALOGS, { cursor: "not-a-valid-cursor" }), /cursor/);
});

test("registers a bounded read-only existing-rule tool over HomeWorld", async () => {
  let registered: ToolDefinition | undefined;
  const homeWorld = {
    marker: "bound",
    async foreignRuleCatalog() {
      assert.equal(this.marker, "bound");
      return CATALOGS;
    },
  };
  const ctx = {
    homeWorld,
    get: () => undefined,
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => undefined;
      },
    },
  } as unknown as Context;

  apply(ctx);
  assert.equal(registered?.name, "get_home_rules");
  const value = await registered!.execute({ limit: 10 }, {} as never);
  assert.equal(value.page.totalRules, 3);
  assert.equal(JSON.stringify(value).includes("automation."), false);
  assert.deepEqual(Object.keys(registered?.parameters.properties ?? {}), ["cursor", "limit"]);
});
