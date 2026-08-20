import assert from "node:assert/strict";
import test from "node:test";

import {
  FOREIGN_RULES_EXTENSION,
  foreignRuleListSchema,
  foreignRuleCatalogSchema,
  type ForeignRulesHandle,
} from "./bridge-foreign-rules.js";
import type { ExtensionHandleRegistry } from "./bridge-contract.js";

test("defines the bounded optional foreignRules v2 extension handle with an exact watermark", async () => {
  assert.deepEqual(FOREIGN_RULES_EXTENSION, { id: "foreignRules", version: "2.0.0" });
  const handle: ExtensionHandleRegistry["foreignRules@2"] = {
    catalog: async () => ({
      epochId: "epoch-a",
      lastSeq: 4,
      complete: true,
      rules: [{ ruleRef: "rule-1", name: "Arrival light", enabled: true }],
    }),
  } satisfies ForeignRulesHandle;
  assert.equal(typeof handle.catalog, "function");
  assert.equal(foreignRuleCatalogSchema.safeParse(await handle.catalog()).success, true);
  assert.equal(foreignRuleCatalogSchema.safeParse({
    epochId: "epoch-a",
    complete: true,
    rules: [],
  }).success, false);
  assert.equal(foreignRuleListSchema.safeParse(new Array(257).fill({ ruleRef: "rule" })).success, false);
});
