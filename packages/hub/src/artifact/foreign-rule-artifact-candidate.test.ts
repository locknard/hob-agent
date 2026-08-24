import assert from "node:assert/strict";
import test from "node:test";

import {
  type BridgeActionTarget,
  type ForeignRuleMigrationResult,
} from "@hob/bridge-contract";
import {
  createForeignRuleArtifactCandidate,
  type ForeignRuleArtifactCandidateResult,
} from "./foreign-rule-artifact-candidate.js";

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}` as `sha256:${string}`;

const bindings = {
  trigger: { bridgeId: "bridge-ha", nativeId: "entity-trigger", nativeInstanceId: "ha-1" },
  condition: { bridgeId: "bridge-ha", nativeId: "entity-condition", nativeInstanceId: "ha-2" },
  device: { bridgeId: "bridge-ha", nativeId: "entity-device", nativeInstanceId: "ha-3" },
  secondDevice: { bridgeId: "bridge-ha", nativeId: "entity-device-2", nativeInstanceId: "ha-4" },
} as const;

const targetForBinding = (binding: {
  readonly bridgeId: string;
  readonly nativeId: string;
  readonly nativeInstanceId: string;
}): BridgeActionTarget => ({
  hwCapabilityId: `hwc-${binding.nativeId}`,
  binding: { ...binding },
});

function translated(overrides: Record<string, unknown> = {}): ForeignRuleMigrationResult {
  return {
    status: "translated",
    ruleRef: "ha-rule:opaque-rule-1",
    sourceFingerprint: digest("a"),
    title: "Turn on the entry light",
    plan: {
      trigger: { kind: "capability_changed", source: bindings.trigger },
      conditions: [{
        kind: "capability_value",
        source: bindings.condition,
        operator: "equals",
        value: "on",
      }],
      actions: [{ kind: "set_boolean", target: bindings.device, value: true }],
    },
    ...overrides,
  } as ForeignRuleMigrationResult;
}

function resolve(binding: {
  readonly bridgeId: string;
  readonly nativeId: string;
  readonly nativeInstanceId: string;
}): BridgeActionTarget | undefined {
  return targetForBinding(binding);
}

function candidate(result: ForeignRuleArtifactCandidateResult) {
  assert.equal(result.status, "candidate");
  if (result.status !== "candidate") throw new Error("expected candidate");
  return result;
}

test("maps a translated schedule rule into a neutral candidate", () => {
  const result = candidate(createForeignRuleArtifactCandidate({
    ...translated(),
    plan: {
      trigger: { kind: "schedule", timezone: "Asia/Shanghai", daysOfWeek: [1, 3, 5], at: "08:30" },
      conditions: [],
      actions: [{ kind: "set_level", target: bindings.device, level: 0.4 }],
    },
  }, resolve));

  assert.deepEqual(result.content, {
    trigger: { kind: "schedule", timezone: "Asia/Shanghai", daysOfWeek: [1, 3, 5], at: "08:30" },
    conditions: [],
    actions: [{ kind: "set_level", target: { hwCapabilityId: "hwc-entity-device" }, value: 0.4 }],
    rollback: {
      kind: "restore_previous_state",
      target: { hwCapabilityId: "hwc-entity-device" },
      maxAgeSeconds: 900,
    },
    postconditions: [{
      kind: "capability_value",
      source: { hwCapabilityId: "hwc-entity-device" },
      operator: "equals",
      value: 0.4,
      withinSeconds: 60,
    }],
  });
});

test("maps capability trigger, neutral conditions, and all supported actions exactly", () => {
  const result = candidate(createForeignRuleArtifactCandidate({
    ...translated(),
    plan: {
      trigger: { kind: "capability_changed", source: bindings.trigger },
      conditions: [{
        kind: "capability_value",
        source: bindings.condition,
        operator: "greater_than",
        value: 0.25,
      }],
      actions: [
        { kind: "set_boolean", target: bindings.device, value: false },
        { kind: "set_level", target: bindings.device, level: 0.75 },
        { kind: "notify_local", message: "Entry light updated" },
      ],
    },
  }, resolve));

  assert.deepEqual(result.content.trigger, {
    kind: "capability_changed",
    source: { hwCapabilityId: "hwc-entity-trigger" },
  });
  assert.deepEqual(result.content.conditions, [{
    kind: "capability_value",
    source: { hwCapabilityId: "hwc-entity-condition" },
    operator: "greater_than",
    value: 0.25,
  }]);
  assert.deepEqual(result.content.actions, [
    { kind: "set_boolean", target: { hwCapabilityId: "hwc-entity-device" }, value: false },
    { kind: "set_level", target: { hwCapabilityId: "hwc-entity-device" }, value: 0.75 },
    { kind: "notify_local", message: "Entry light updated" },
  ]);
  assert.deepEqual(result.content.postconditions, [{
    kind: "capability_value",
    source: { hwCapabilityId: "hwc-entity-device" },
    operator: "equals",
    value: 0.75,
    withinSeconds: 60,
  }]);
});

test("creates a no-remote-change notification-only candidate", () => {
  const result = candidate(createForeignRuleArtifactCandidate({
    ...translated(),
    plan: {
      trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [0], at: "09:00" },
      conditions: [],
      actions: [{ kind: "notify_local", message: "Review the entry light" }],
    },
  }, resolve));

  assert.deepEqual(result.content.rollback, { kind: "no_remote_change" });
  assert.deepEqual(result.content.postconditions, []);
});

test("fails closed when a trigger, condition, or action binding is unresolved", () => {
  const result = createForeignRuleArtifactCandidate(translated(), (binding) => {
    if (binding.nativeId === bindings.condition.nativeId) return undefined;
    return resolve(binding);
  });

  assert.deepEqual(result, { status: "needs_attention", reason: "unbound_target" });
});

test("fails closed without exposing resolver errors", () => {
  const result = createForeignRuleArtifactCandidate(translated(), () => {
    throw new Error("native service payload must not escape");
  });

  assert.deepEqual(result, { status: "needs_attention", reason: "resolver_failed" });
});

test("rejects a resolver target whose bridge binding does not exactly match the requested binding", () => {
  const result = createForeignRuleArtifactCandidate(translated(), (binding) => ({
    ...targetForBinding(binding),
    binding: {
      bridgeId: "bridge-forged",
      nativeId: "native-forged",
      nativeInstanceId: "instance-forged",
    },
  }),);

  assert.deepEqual(result, { status: "needs_attention", reason: "resolver_failed" });
});

test("allows one device target and rejects multiple device targets", () => {
  const result = createForeignRuleArtifactCandidate({
    ...translated(),
    plan: {
      trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "10:00" },
      conditions: [],
      actions: [
        { kind: "set_boolean", target: bindings.device, value: true },
        { kind: "set_level", target: bindings.secondDevice, level: 0.2 },
      ],
    },
  }, resolve);

  assert.deepEqual(result, { status: "needs_attention", reason: "multiple_targets" });
});

test("rejects a title that exceeds the Artifact title bound without truncating it", () => {
  const result = createForeignRuleArtifactCandidate({
    ...translated(),
    title: "x".repeat(121),
  }, resolve);

  assert.deepEqual(result, { status: "needs_attention", reason: "invalid_title" });
});

test("rejects invalid or provider-shaped input through the strict migration contract", () => {
  const invalid = createForeignRuleArtifactCandidate({
    ...translated(),
    plan: {
      ...translated().plan,
      actions: [{ kind: "set_boolean", target: bindings.device, value: true, service: "light.turn_on" }],
    },
  }, resolve);
  assert.deepEqual(invalid, { status: "needs_attention", reason: "invalid_input" });

  const proxy = new Proxy(translated(), {
    get() {
      throw new Error("provider getter");
    },
  });
  assert.deepEqual(
    createForeignRuleArtifactCandidate(proxy, resolve),
    { status: "needs_attention", reason: "invalid_input" },
  );
});

test("rejects neutral-schema-invalid values and keeps provider tokens out of output", () => {
  const invalid = createForeignRuleArtifactCandidate({
    ...translated(),
    plan: {
      ...translated().plan,
      conditions: [{
        kind: "capability_value",
        source: bindings.condition,
        operator: "equals",
        value: "https://provider.invalid/raw-config",
      }],
    },
  }, resolve);
  assert.deepEqual(invalid, { status: "needs_attention", reason: "artifact_invalid" });

  const result = candidate(createForeignRuleArtifactCandidate(translated(), resolve));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("nativeId"), false);
  assert.equal(serialized.includes("nativeInstanceId"), false);
  assert.equal(serialized.includes("bridgeId"), false);
  assert.equal(serialized.includes("entity_id"), false);
  assert.equal(serialized.includes("service"), false);
  assert.equal(serialized.includes("raw-config"), false);
});

test("does not include provider-shaped fields in either closed result variant", () => {
  const result = createForeignRuleArtifactCandidate({
    status: "translated",
    ruleRef: "ha-rule:opaque-rule-1",
    sourceFingerprint: digest("b"),
    title: "Light",
    plan: {
      trigger: { kind: "capability_changed", source: bindings.device },
      conditions: [],
      actions: [{ kind: "set_boolean", target: bindings.device, value: true }],
    },
    providerPayload: { entity_id: "light.secret", service: "light.turn_on" },
  }, resolve);

  assert.deepEqual(result, { status: "needs_attention", reason: "invalid_input" });
  assert.equal(JSON.stringify(result).includes("light.secret"), false);
});
