import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "@hob/bridge-contract";
import {
  CAPABILITY_SEMANTICS_ALLOWLIST,
  checkCapabilityAction,
  checkCapabilityPredicate,
  resolveCapabilityRead,
} from "./capability-semantics.js";

const haCapability = {
  schema: "ha.entity",
  schemaVersion: "1.0.0",
} as const;

const haCoverCapability = {
  schema: "ha.cover",
  schemaVersion: "1.0.0",
} as const;

const miotCapability = {
  schema: "miot.property",
  schemaVersion: "1.0.0",
} as const;

function state(attrs: Record<string, JsonValue>, options: {
  validity?: "valid" | "stale" | "invalid" | "invalid-source" | "present-but-invalid" | "unavailable";
  freshness?: "fresh" | "stale-gap";
} = {}) {
  return {
    attrs,
    validity: options.validity ?? "valid",
    freshness: options.freshness ?? "fresh",
  };
}

function booleanAction(value: boolean) {
  return {
    kind: "set_boolean" as const,
    target: { hwCapabilityId: "hc-1" },
    value,
  };
}

function levelAction(value = 0.65) {
  return {
    kind: "set_level" as const,
    target: { hwCapabilityId: "hc-1" },
    value,
  };
}

test("exposes only the reviewed exact schema/version allowlist", () => {
  assert.deepEqual(CAPABILITY_SEMANTICS_ALLOWLIST, [
    "ha.entity@1.0.0",
    "ha.cover@1.0.0",
    "miot.property@1.0.0",
  ]);
  assert.equal(Object.isFrozen(CAPABILITY_SEMANTICS_ALLOWLIST), true);

  const unsupported = resolveCapabilityRead({
    capability: { schema: "ha.entity", schemaVersion: "1.1.0" },
    state: state({ state: "on" }),
  });
  assert.deepEqual(unsupported, { status: "unsupported", reason: "schema_unsupported" });
});

test("reads HA state as a string and permits equality predicates only", () => {
  const read = resolveCapabilityRead({
    capability: haCapability,
    state: state({ state: "on", brightness: 200 }),
  });
  assert.deepEqual(read, {
    status: "available",
    value: "on",
    valueType: "string",
    operators: ["equals", "not_equals"],
  });

  assert.deepEqual(checkCapabilityPredicate({
    capability: haCapability,
    state: state({ state: "on" }),
    operator: "equals",
    value: "on",
  }), {
    status: "compatible",
    operator: "equals",
    valueType: "string",
  });
  assert.deepEqual(checkCapabilityPredicate({
    capability: haCapability,
    state: state({ state: "on" }),
    operator: "greater_than",
    value: "off",
  }), {
    status: "incompatible",
    reason: "operator_unsupported",
  });
});

test("reads reviewed HA cover level as a normalized number with numeric predicates", () => {
  const read = resolveCapabilityRead({
    capability: haCoverCapability,
    state: state({ state: "open", level: 0.37, setLevelSupported: true }),
  });
  assert.deepEqual(read, {
    status: "available",
    value: 0.37,
    valueType: "number",
    operators: ["equals", "not_equals", "greater_than", "less_than"],
  });

  assert.deepEqual(checkCapabilityPredicate({
    capability: haCoverCapability,
    state: state({ state: "open", level: 0.37, setLevelSupported: true }),
    operator: "greater_than",
    value: 0.2,
  }), {
    status: "compatible",
    operator: "greater_than",
    valueType: "number",
  });
  assert.deepEqual(checkCapabilityPredicate({
    capability: haCoverCapability,
    state: state({ state: "open", level: 0.37, setLevelSupported: true }),
    operator: "equals",
    value: "open",
  }), {
    status: "incompatible",
    reason: "predicate_type_mismatch",
  });
});

test("accepts HA cover set_level only with explicit support and exact integer-percent values", () => {
  assert.deepEqual(checkCapabilityAction({
    capability: haCoverCapability,
    state: state({ state: "open", level: 0.37, setLevelSupported: true }),
    action: levelAction(0.65),
  }), {
    status: "compatible",
    kind: "set_level",
    before: 0.37,
    after: 0.65,
  });
  assert.equal(checkCapabilityAction({
    capability: haCoverCapability,
    state: state({ state: "open", level: 0.37, setLevelSupported: true }),
    action: levelAction(0.29),
  }).status, "compatible");

  assert.deepEqual(checkCapabilityAction({
    capability: haCoverCapability,
    state: state({ state: "open", level: 0.37 }),
    action: levelAction(0.65),
  }), {
    status: "incompatible",
    kind: "set_level",
    reason: "action_mapping_unreviewed",
  });
  assert.deepEqual(checkCapabilityAction({
    capability: haCoverCapability,
    state: state({ state: "open", level: 0.37, setLevelSupported: false }),
    action: levelAction(0.65),
  }), {
    status: "incompatible",
    kind: "set_level",
    reason: "not_writable",
  });
  assert.deepEqual(checkCapabilityAction({
    capability: haCoverCapability,
    state: state({ state: "open", level: 0.37, setLevelSupported: true }),
    action: levelAction(0.655),
  }), {
    status: "incompatible",
    kind: "set_level",
    reason: "action_mapping_unreviewed",
  });
  assert.deepEqual(checkCapabilityAction({
    capability: haCoverCapability,
    state: state({ state: "open", level: 0.37, setLevelSupported: true }),
    action: levelAction(0.6500000000000001),
  }), {
    status: "incompatible",
    kind: "set_level",
    reason: "action_mapping_unreviewed",
  });
  assert.deepEqual(checkCapabilityAction({
    capability: haCoverCapability,
    state: state({ state: "open", setLevelSupported: true }),
    action: levelAction(0.65),
  }), {
    status: "unavailable",
    kind: "set_level",
    reason: "state_missing",
  });
  assert.deepEqual(checkCapabilityAction({
    capability: haCoverCapability,
    state: state({ state: "open", level: 1.01, setLevelSupported: true }),
    action: levelAction(0.65),
  }), {
    status: "incompatible",
    kind: "set_level",
    reason: "value_invalid",
  });
  assert.deepEqual(resolveCapabilityRead({
    capability: haCoverCapability,
    state: {
      attrs: { state: "open", level: 0.37, setLevelSupported: true },
      validity: "valid",
    },
  }), {
    status: "unavailable",
    reason: "state_stale",
  });
});

test("treats explicit HA cover unavailability as unavailable despite retained level attrs", () => {
  for (const attrs of [
    { state: "open", level: 0.37, setLevelSupported: true, available: false },
    { state: "unavailable", level: 0.37, setLevelSupported: true },
    { state: "unknown", level: 0.37, setLevelSupported: true },
  ]) {
    assert.deepEqual(resolveCapabilityRead({
      capability: haCoverCapability,
      state: state(attrs),
    }), {
      status: "unavailable",
      reason: "state_invalid",
    });
    assert.deepEqual(checkCapabilityAction({
      capability: haCoverCapability,
      state: state(attrs),
      action: levelAction(0.65),
    }), {
      status: "unavailable",
      kind: "set_level",
      reason: "state_invalid",
    });
  }
});

test("does not coerce numeric-looking HA text or use semanticKind as authority", () => {
  const hintedCapability = {
    ...haCapability,
    semanticKind: "cover",
  } as unknown as typeof haCapability;
  const read = resolveCapabilityRead({
    capability: hintedCapability,
    state: state({ state: "21.5" }),
  });
  assert.equal(read.status, "available");
  if (read.status === "available") assert.equal(read.valueType, "string");

  assert.deepEqual(checkCapabilityPredicate({
    capability: hintedCapability,
    state: state({ state: "21.5" }),
    operator: "greater_than",
    value: 20,
  }), {
    status: "incompatible",
    reason: "operator_unsupported",
  });
  assert.deepEqual(resolveCapabilityRead({
    capability: haCapability,
    state: state({ state: 21.5 }),
  }), {
    status: "unsupported",
    reason: "value_invalid",
  });
  assert.deepEqual(checkCapabilityAction({
    capability: hintedCapability,
    state: state({ state: "open" }),
    action: levelAction(),
  }), {
    status: "incompatible",
    kind: "set_level",
    reason: "set_level_unsupported",
  });
});

test("reads MIoT scalar values with type-safe operators and rejects composite values", () => {
  assert.deepEqual(resolveCapabilityRead({
    capability: miotCapability,
    state: state({ value: 37, format: "uint8", unit: "percentage", writable: true }),
  }), {
    status: "available",
    value: 37,
    valueType: "number",
    operators: ["equals", "not_equals", "greater_than", "less_than"],
  });
  assert.deepEqual(checkCapabilityPredicate({
    capability: miotCapability,
    state: state({ value: 37, format: "uint8", writable: true }),
    operator: "greater_than",
    value: 20,
  }), {
    status: "compatible",
    operator: "greater_than",
    valueType: "number",
  });
  assert.deepEqual(checkCapabilityPredicate({
    capability: miotCapability,
    state: state({ value: 37, format: "uint8", writable: true }),
    operator: "greater_than",
    value: "20",
  }), {
    status: "incompatible",
    reason: "predicate_type_mismatch",
  });
  assert.deepEqual(resolveCapabilityRead({
    capability: miotCapability,
    state: state({ value: [1, 2], format: "array", writable: false }),
  }), {
    status: "unsupported",
    reason: "value_unsupported",
  });
  assert.deepEqual(resolveCapabilityRead({
    capability: miotCapability,
    state: state({ value: "open", format: "string", writable: false }),
  }), {
    status: "available",
    value: "open",
    valueType: "string",
    operators: ["equals", "not_equals"],
  });
  assert.deepEqual(resolveCapabilityRead({
    capability: miotCapability,
    state: state({ value: null, format: "null", writable: false }),
  }), {
    status: "available",
    value: null,
    valueType: "null",
    operators: ["equals", "not_equals"],
  });
});

test("only MIoT bool plus writable is action-compatible and returns neutral before/after", () => {
  const input = {
    capability: miotCapability,
    state: state({ value: true, format: "bool", unit: "none", writable: true }),
    action: booleanAction(false),
  };
  const result = checkCapabilityAction(input);
  assert.deepEqual(result, {
    status: "compatible",
    kind: "set_boolean",
    before: true,
    after: false,
  });
  assert.deepEqual(Object.keys(result).sort(), ["after", "before", "kind", "status"]);
  assert.equal("authority" in result, false);
  assert.equal("route" in result, false);
  assert.equal("nativeId" in result, false);

  assert.deepEqual(checkCapabilityAction({
    capability: miotCapability,
    state: state({ value: true, format: "bool", writable: false }),
    action: booleanAction(false),
  }), {
    status: "incompatible",
    kind: "set_boolean",
    reason: "not_writable",
  });
  assert.deepEqual(checkCapabilityAction({
    capability: miotCapability,
    state: state({ value: 37, format: "uint8", unit: "percentage", writable: true }),
    action: booleanAction(false),
  }), {
    status: "incompatible",
    kind: "set_boolean",
    reason: "action_mapping_unreviewed",
  });
});

test("fails closed for set_level on generic HA and MIoT schemas", () => {
  assert.deepEqual(checkCapabilityAction({
    capability: haCapability,
    state: state({ state: "open" }),
    action: levelAction(),
  }), {
    status: "incompatible",
    kind: "set_level",
    reason: "set_level_unsupported",
  });
  assert.deepEqual(checkCapabilityAction({
    capability: miotCapability,
    state: state({ value: 37, format: "uint8", unit: "percentage", writable: true }),
    action: levelAction(),
  }), {
    status: "incompatible",
    kind: "set_level",
    reason: "set_level_unsupported",
  });
});

test("returns unavailable for missing, stale, and invalid state without before", () => {
  assert.deepEqual(resolveCapabilityRead({ capability: miotCapability }), {
    status: "unavailable",
    reason: "state_missing",
  });
  assert.deepEqual(resolveCapabilityRead({
    capability: miotCapability,
    state: state({ format: "bool", writable: true }),
  }), {
    status: "unavailable",
    reason: "state_missing",
  });
  assert.deepEqual(resolveCapabilityRead({
    capability: miotCapability,
    state: state({ value: true, format: "bool", writable: true }, { validity: "stale" }),
  }), {
    status: "unavailable",
    reason: "state_stale",
  });
  assert.deepEqual(checkCapabilityAction({
    capability: miotCapability,
    state: state({ value: true, format: "bool", writable: true }, { freshness: "stale-gap" }),
    action: booleanAction(false),
  }), {
    status: "unavailable",
    kind: "set_boolean",
    reason: "state_stale",
  });
  assert.deepEqual(checkCapabilityAction({
    capability: miotCapability,
    state: state({ value: true, format: "bool", writable: true }, { validity: "invalid-source" }),
    action: booleanAction(false),
  }), {
    status: "unavailable",
    kind: "set_boolean",
    reason: "state_invalid",
  });
});

test("deep-freezes bounded resolver outputs", () => {
  const read = resolveCapabilityRead({
    capability: miotCapability,
    state: state({ value: true, format: "bool", writable: true }),
  });
  assert.equal(Object.isFrozen(read), true);
  if (read.status === "available") {
    assert.equal(Object.isFrozen(read.operators), true);
    assert.throws(() => (read.operators as string[]).push("greater_than"), TypeError);
  }

  const action = checkCapabilityAction({
    capability: miotCapability,
    state: state({ value: true, format: "bool", writable: true }),
    action: booleanAction(false),
  });
  assert.equal(Object.isFrozen(action), true);
});
