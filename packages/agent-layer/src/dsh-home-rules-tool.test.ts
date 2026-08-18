import assert from "node:assert/strict";
import test from "node:test";

import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import { apply, pageHomeRules } from "./dsh-home-rules-tool.js";

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
  assert.equal(typeof first.page.nextCursor, "string");

  const second = pageHomeRules(CATALOGS, { limit: 2, cursor: first.page.nextCursor });
  assert.deepEqual(second.rules, [{ bridgeId: "bridge-a", ruleRef: "rule-3", enabled: false }]);
  assert.equal(second.page.nextCursor, undefined);
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
