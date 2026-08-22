import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOMATIONS_EXTENSION,
  bridgeAutomationDeployResultSchema,
  bridgeAutomationSpecSchema,
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
