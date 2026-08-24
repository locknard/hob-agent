import assert from "node:assert/strict";
import test from "node:test";

import {
  FOREIGN_RULE_MIGRATION_EXTENSION,
  foreignRuleMigrationResultSchema,
  type ExtensionHandleRegistry,
  type ForeignRuleMigrationHandle,
} from "./index.js";

const binding = {
  bridgeId: "bridge-ha",
  nativeId: "device-1",
  nativeInstanceId: "entity-1",
};

test("defines a separately versioned foreign rule migration extension", async () => {
  assert.deepEqual(FOREIGN_RULE_MIGRATION_EXTENSION, {
    id: "foreignRuleMigration",
    version: "1.0.0",
  });

  const result = foreignRuleMigrationResultSchema.parse({
    status: "translated",
    ruleRef: "ha-rule:opaque",
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    title: "晚间灯光",
    plan: {
      trigger: { kind: "capability_changed", source: binding },
      conditions: [{
        kind: "capability_value",
        source: binding,
        operator: "equals",
        value: "on",
      }],
      actions: [{ kind: "set_boolean", target: binding, value: true }],
    },
  });
  assert.equal(result.status, "translated");
  if (result.status === "translated" && result.plan.trigger.kind === "capability_changed") {
    assert.equal("hwCapabilityId" in result.plan.trigger.source, false);
  }
  assert.equal(JSON.stringify(result).includes("entity_id"), false);
  assert.equal(JSON.stringify(result).includes("service"), false);

  assert.deepEqual(foreignRuleMigrationResultSchema.parse({
    status: "unsupported",
    reason: "mode_not_single",
  }), { status: "unsupported", reason: "mode_not_single" });
  assert.deepEqual(foreignRuleMigrationResultSchema.parse({
    status: "unavailable",
    reason: "upstream_unavailable",
  }), { status: "unavailable", reason: "upstream_unavailable" });

  const handle: ForeignRuleMigrationHandle = {
    translate: async () => ({ status: "unsupported", reason: "unknown_rule" }),
  };
  const typed: ExtensionHandleRegistry["foreignRuleMigration@1"] = handle;
  assert.equal(typeof typed.translate, "function");
});

test("rejects unbounded or provider-shaped migration results at the contract boundary", () => {
  assert.equal(foreignRuleMigrationResultSchema.safeParse({
    status: "translated",
    ruleRef: "ha-rule:opaque",
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    title: "晚间灯光",
    plan: {
      trigger: { kind: "capability_changed", source: binding },
      conditions: [],
      actions: [{
        kind: "set_boolean",
        target: { ...binding, hwCapabilityId: "hub-cap" },
        value: true,
      }],
    },
  }).success, false);

  assert.equal(foreignRuleMigrationResultSchema.safeParse({
    status: "translated",
    ruleRef: "ha-rule:opaque",
    sourceFingerprint: "raw-config",
    title: "晚间灯光",
    plan: { trigger: { kind: "schedule", timezone: "Asia/Shanghai", at: "08:00", daysOfWeek: [1] }, conditions: [], actions: [] },
  }).success, false);

  assert.equal(foreignRuleMigrationResultSchema.safeParse({
    status: "unsupported",
    reason: "provider_error",
  }).success, false);

  assert.equal(foreignRuleMigrationResultSchema.safeParse({
    status: "unsupported",
    reason: "unknown_rule",
    detail: "provider config body",
  }).success, false);
  assert.equal(foreignRuleMigrationResultSchema.safeParse({
    status: "translated",
    ruleRef: "ha-rule:opaque",
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    title: "灯".repeat(700),
    plan: {
      trigger: { kind: "capability_changed", source: binding },
      conditions: [],
      actions: [{ kind: "set_boolean", target: binding, value: true }],
    },
  }).success, false);
  assert.equal(foreignRuleMigrationResultSchema.safeParse({
    status: "translated",
    ruleRef: "ha-rule:opaque",
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    title: "晚间灯光",
    plan: {
      trigger: { kind: "capability_changed", source: binding },
      conditions: new Array(9).fill({
        kind: "capability_value",
        source: binding,
        operator: "equals",
        value: "on",
      }),
      actions: [{ kind: "set_boolean", target: binding, value: true }],
    },
  }).success, false);
});
