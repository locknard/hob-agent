import assert from "node:assert/strict";
import test from "node:test";

import {
  FOREIGN_RULE_CONTROL_EXTENSION,
  foreignRuleControlSetEnabledRequestSchema,
  foreignRuleControlSetEnabledResultSchema,
  foreignRuleControlStatusRequestSchema,
  foreignRuleControlStatusResultSchema,
  type ExtensionHandleRegistry,
  type ForeignRuleControlHandle,
} from "./index.js";

const RULE_REF = "ha-rule:opaque";
const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const OPERATION_ID = "0123456789abcdef0123456789abcdef";

test("defines a bounded foreign rule control extension with verified read-back", () => {
  assert.deepEqual(FOREIGN_RULE_CONTROL_EXTENSION, {
    id: "foreignRuleControl",
    version: "1.0.0",
  });

  assert.deepEqual(foreignRuleControlStatusRequestSchema.parse({ ruleRef: RULE_REF }), { ruleRef: RULE_REF });
  assert.deepEqual(foreignRuleControlSetEnabledRequestSchema.parse({
    ruleRef: RULE_REF,
    expectedSourceFingerprint: FINGERPRINT,
    enabled: false,
    operationId: OPERATION_ID,
  }), {
    ruleRef: RULE_REF,
    expectedSourceFingerprint: FINGERPRINT,
    enabled: false,
    operationId: OPERATION_ID,
  });

  assert.deepEqual(foreignRuleControlStatusResultSchema.parse({
    status: "running",
    sourceFingerprint: FINGERPRINT,
  }), { status: "running", sourceFingerprint: FINGERPRINT });
  assert.deepEqual(foreignRuleControlStatusResultSchema.parse({
    status: "paused",
    sourceFingerprint: FINGERPRINT,
  }), { status: "paused", sourceFingerprint: FINGERPRINT });
  assert.deepEqual(foreignRuleControlStatusResultSchema.parse({ status: "missing" }), { status: "missing" });
  assert.deepEqual(foreignRuleControlStatusResultSchema.parse({ status: "unknown", reason: "invalid_response" }), {
    status: "unknown",
    reason: "invalid_response",
  });

  assert.deepEqual(foreignRuleControlSetEnabledResultSchema.parse({
    status: "paused",
    sourceFingerprint: FINGERPRINT,
  }), { status: "paused", sourceFingerprint: FINGERPRINT });
  assert.deepEqual(foreignRuleControlSetEnabledResultSchema.parse({ status: "rejected", reason: "stale_source" }), {
    status: "rejected",
    reason: "stale_source",
  });
  assert.deepEqual(foreignRuleControlSetEnabledResultSchema.parse({ status: "unknown", reason: "upstream_unavailable" }), {
    status: "unknown",
    reason: "upstream_unavailable",
  });

  const handle: ForeignRuleControlHandle = {
    status: async () => ({ status: "missing" }),
    setEnabled: async () => ({ status: "rejected", reason: "not_found" }),
  };
  const typed: ExtensionHandleRegistry["foreignRuleControl@1"] = handle;
  assert.equal(typeof typed.status, "function");
  assert.equal(typeof typed.setEnabled, "function");
});

test("rejects unbounded, stale, or provider-shaped foreign rule control values", () => {
  assert.equal(foreignRuleControlStatusRequestSchema.safeParse({ ruleRef: RULE_REF, nativeId: "arrival_light" }).success, false);
  assert.equal(foreignRuleControlSetEnabledRequestSchema.safeParse({
    ruleRef: RULE_REF,
    expectedSourceFingerprint: FINGERPRINT,
    enabled: false,
    operationId: OPERATION_ID.toUpperCase(),
  }).success, false);
  assert.equal(foreignRuleControlSetEnabledRequestSchema.safeParse({
    ruleRef: RULE_REF,
    expectedSourceFingerprint: "raw-config",
    enabled: false,
    operationId: OPERATION_ID,
  }).success, false);
  assert.equal(foreignRuleControlSetEnabledRequestSchema.safeParse({
    ruleRef: RULE_REF,
    expectedSourceFingerprint: FINGERPRINT,
    enabled: false,
    operationId: "0".repeat(31),
  }).success, false);
  assert.equal(foreignRuleControlStatusResultSchema.safeParse({
    status: "running",
    sourceFingerprint: FINGERPRINT,
    nativePayload: {},
  }).success, false);
  assert.equal(foreignRuleControlSetEnabledResultSchema.safeParse({
    status: "rejected",
    reason: "provider_error",
  }).success, false);
  assert.equal(foreignRuleControlSetEnabledResultSchema.safeParse({
    status: "running",
  }).success, false);
});
