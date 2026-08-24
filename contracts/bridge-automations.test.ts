import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOMATIONS_EXTENSION,
  AUTOMATIONS_EXTENSION_V2,
  bridgeAutomationCommandResultV2Schema,
  bridgeAutomationDeployRequestSchema,
  bridgeAutomationDeployResultSchema,
  bridgeAutomationDeployResultV2Schema,
  bridgeAutomationOperationIdSchema,
  bridgeAutomationSetEnabledRequestSchema,
  bridgeAutomationSpecSchema,
  bridgeAutomationWithdrawRequestSchema,
} from "./bridge-automations.js";

const target = {
  hwCapabilityId: "hwc-4",
  binding: { bridgeId: "ha-main", nativeId: "switch.media_strip", nativeInstanceId: "switch.media_strip" },
};

const spec = {
  automationId: "hob_proposal_41",
  title: "睡前自动关掉多媒体室电源",
  trigger: { kind: "schedule" as const, timezone: "Asia/Shanghai", daysOfWeek: [1, 2, 3, 4, 5], at: "23:30" },
  conditions: [{ kind: "capability_value" as const, source: target, operator: "equals" as const, value: false }],
  actions: [{ kind: "set_boolean" as const, target, value: false }],
};

test("accepts a bounded automation spec with resolved bindings only", () => {
  assert.equal(AUTOMATIONS_EXTENSION.id, "automations");
  assert.equal(bridgeAutomationSpecSchema.safeParse(spec).success, true);
});

test("rejects specs without a hub-owned id, without actions, or with loose fields", () => {
  assert.equal(bridgeAutomationSpecSchema.safeParse({ ...spec, automationId: "Hob Proposal" }).success, false);
  assert.equal(bridgeAutomationSpecSchema.safeParse({ ...spec, actions: [] }).success, false);
  assert.equal(bridgeAutomationSpecSchema.safeParse({ ...spec, nativePayload: {} }).success, false);
});

test("a deployed result always names the verified native automation", () => {
  assert.equal(bridgeAutomationDeployResultSchema.safeParse({ status: "deployed", nativeAutomationId: "hob_proposal_41" }).success, true);
  assert.equal(bridgeAutomationDeployResultSchema.safeParse({ status: "deployed" }).success, false);
  assert.equal(bridgeAutomationDeployResultSchema.safeParse({ status: "rejected", reason: "unsupported" }).success, true);
});

test("automations v2 requires a bounded operation id and echoes it on every result", () => {
  const operationId = "0123456789abcdef0123456789abcdef";
  assert.equal(AUTOMATIONS_EXTENSION_V2.version, "2.0.0");
  assert.equal(bridgeAutomationOperationIdSchema.safeParse(operationId).success, true);
  assert.equal(bridgeAutomationOperationIdSchema.safeParse(operationId.toUpperCase()).success, false);
  assert.equal(bridgeAutomationOperationIdSchema.safeParse("short").success, false);

  assert.equal(bridgeAutomationDeployRequestSchema.safeParse({ operationId, spec }).success, true);
  assert.equal(bridgeAutomationSetEnabledRequestSchema.safeParse({
    operationId,
    nativeAutomationId: spec.automationId,
    enabled: false,
  }).success, true);
  assert.equal(bridgeAutomationWithdrawRequestSchema.safeParse({
    operationId,
    nativeAutomationId: spec.automationId,
  }).success, true);
  assert.equal(bridgeAutomationDeployRequestSchema.safeParse({ operationId, spec, nativePayload: {} }).success, false);

  assert.equal(bridgeAutomationDeployResultV2Schema.safeParse({
    status: "deployed",
    operationId,
    nativeAutomationId: spec.automationId,
  }).success, true);
  assert.equal(bridgeAutomationDeployResultV2Schema.safeParse({
    status: "unknown",
    operationId,
    reason: "not_confirmed",
  }).success, true);
  assert.equal(bridgeAutomationCommandResultV2Schema.safeParse({
    status: "acknowledged",
    operationId,
  }).success, true);
  assert.equal(bridgeAutomationCommandResultV2Schema.safeParse({
    status: "unknown",
    operationId,
    reason: "unavailable",
  }).success, true);
  assert.equal(bridgeAutomationCommandResultV2Schema.safeParse({ status: "acknowledged" }).success, false);
});

test("automations v1 remains strict and does not silently accept operation ids", () => {
  assert.equal(AUTOMATIONS_EXTENSION.version, "1.0.0");
  assert.equal(bridgeAutomationDeployResultSchema.safeParse({
    status: "deployed",
    nativeAutomationId: spec.automationId,
    operationId: "0123456789abcdef0123456789abcdef",
  }).success, false);
});
