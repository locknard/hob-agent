import assert from "node:assert/strict";
import test from "node:test";

import type { ForeignRuleMigrationResult } from "@hob/bridge-contract";

import { HomeAutomationMigrationTranslator } from "./home-automation-migration-world-translator.js";

const REQUEST = Object.freeze({
  bridgeId: "bridge-ha",
  epochId: "epoch-42",
  lastSeq: 712,
  ruleRef: "ha-rule:evening-light",
});

const binding = {
  bridgeId: REQUEST.bridgeId,
  nativeId: "light.living-room",
  nativeInstanceId: "light.living-room:main",
} as const;

const fingerprint = `sha256:${"a".repeat(64)}`;

function translated(overrides: Record<string, unknown> = {}): ForeignRuleMigrationResult {
  return {
    status: "translated",
    ruleRef: REQUEST.ruleRef,
    sourceFingerprint: fingerprint,
    title: "Evening light",
    plan: {
      trigger: { kind: "capability_changed", source: binding },
      conditions: [],
      actions: [{ kind: "set_boolean", target: binding, value: true }],
    },
    ...overrides,
  } as ForeignRuleMigrationResult;
}

function translatorWith(result: unknown, onCall?: (input: unknown) => void): HomeAutomationMigrationTranslator {
  return new HomeAutomationMigrationTranslator({
    translateForeignRule: async (input) => {
      onCall?.(input);
      return result;
    },
  });
}

test("maps a translated schedule into bounded assessment classes", async () => {
  const translator = translatorWith(translated({
    plan: {
      trigger: { kind: "schedule", timezone: "Asia/Shanghai", daysOfWeek: [1, 3, 5], at: "20:30" },
      conditions: [],
      actions: [{ kind: "set_level", target: binding, level: 0.35 }],
    },
  }));

  assert.deepEqual(await translator.assess(REQUEST, { signal: new AbortController().signal }), {
    ruleRef: REQUEST.ruleRef,
    sourceFingerprint: fingerprint,
    trigger: { kind: "time" },
    condition: { kind: "flat_and" },
    action: { kind: "reversible" },
  });
});

test("maps a translated capability trigger and notification-only plan", async () => {
  const translator = translatorWith(translated({
    plan: {
      trigger: { kind: "capability_changed", source: binding },
      conditions: [{
        kind: "capability_value",
        source: binding,
        operator: "equals",
        value: "on",
      }],
      actions: [{ kind: "notify_local", message: "Review the evening light" }],
    },
  }));

  assert.deepEqual(await translator.assess(REQUEST, { signal: new AbortController().signal }), {
    ruleRef: REQUEST.ruleRef,
    sourceFingerprint: fingerprint,
    trigger: { kind: "state" },
    condition: { kind: "flat_and" },
    action: { kind: "reversible" },
  });
});

test("forwards the source watermark and exact signal without rewriting either", async () => {
  const signal = new AbortController().signal;
  let forwarded: unknown;
  const translator = translatorWith(translated(), (input) => {
    forwarded = input;
  });

  const result = await translator.assess(REQUEST, { signal });

  assert.deepEqual(forwarded, { ...REQUEST, signal });
  assert.equal((forwarded as { signal: AbortSignal }).signal, signal);
  assert.equal((forwarded as { lastSeq: number }).lastSeq, REQUEST.lastSeq);
  assert.deepEqual(result, {
    ruleRef: REQUEST.ruleRef,
    sourceFingerprint: fingerprint,
    trigger: { kind: "state" },
    condition: { kind: "flat_and" },
    action: { kind: "reversible" },
  });
});

test("maps unsupported trigger reasons to trigger unsupported and keeps other dimensions unknown", async (t) => {
  for (const reason of ["multiple_triggers", "unsupported_trigger"] as const) {
    await t.test(reason, async () => {
      assert.deepEqual(await translatorWith({ status: "unsupported", reason }).assess(REQUEST, {
        signal: new AbortController().signal,
      }), {
        ruleRef: REQUEST.ruleRef,
        trigger: { kind: "unsupported" },
        condition: { kind: "unknown" },
        action: { kind: "unknown" },
      });
    });
  }
});

test("maps unsupported condition to condition unsupported and keeps other dimensions unknown", async () => {
  assert.deepEqual(await translatorWith({ status: "unsupported", reason: "unsupported_condition" }).assess(REQUEST, {
    signal: new AbortController().signal,
  }), {
    ruleRef: REQUEST.ruleRef,
    trigger: { kind: "unknown" },
    condition: { kind: "unsupported" },
    action: { kind: "unknown" },
  });
});

test("maps unsupported action reasons to action unsupported and keeps other dimensions unknown", async (t) => {
  for (const reason of [
    "unsupported_action",
    "multiple_targets",
    "mode_not_single",
    "unsupported_structure",
  ] as const) {
    await t.test(reason, async () => {
      assert.deepEqual(await translatorWith({ status: "unsupported", reason }).assess(REQUEST, {
        signal: new AbortController().signal,
      }), {
        ruleRef: REQUEST.ruleRef,
        trigger: { kind: "unknown" },
        condition: { kind: "unknown" },
        action: { kind: "unsupported" },
      });
    });
  }
});

test("redacts unknown, stale, unavailable, and invalid translation outcomes", async (t) => {
  const outcomes: readonly [string, unknown][] = [
    ["unknown rule", { status: "unsupported", reason: "unknown_rule" }],
    ["unbound target", { status: "unsupported", reason: "unbound_target" }],
    ["stale source", { status: "stale_source" }],
    ["unavailable", { status: "unavailable", reason: "upstream_unavailable" }],
    ["invalid status", { status: "provider_error", detail: "provider secret" }],
    ["malformed translated", { ...translated(), plan: { actions: [] } }],
    ["provider-shaped result", { ...translated(), nativeConfig: "secret", providerReason: "secret" }],
  ];

  for (const [name, outcome] of outcomes) {
    await t.test(name, async () => {
      const result = await translatorWith(outcome).assess(REQUEST, { signal: new AbortController().signal });
      assert.equal(result, undefined);
      assert.equal(JSON.stringify(result ?? null).includes("secret"), false);
    });
  }
});

test("redacts a translated result whose rule reference does not match the request", async () => {
  const result = await translatorWith(translated({ ruleRef: "ha-rule:other" })).assess(REQUEST, {
    signal: new AbortController().signal,
  });
  assert.equal(result, undefined);
});

test("redacts contract, port, abort, and proxy failures", async (t) => {
  await t.test("contract proxy getter", async () => {
    const result = await translatorWith(new Proxy(translated(), {
      get() {
        throw new Error("provider getter");
      },
    })).assess(REQUEST, { signal: new AbortController().signal });
    assert.equal(result, undefined);
  });

  await t.test("port throws", async () => {
    const translator = new HomeAutomationMigrationTranslator({
      translateForeignRule: async () => {
        throw new Error("provider failure");
      },
    });
    assert.equal(await translator.assess(REQUEST, { signal: new AbortController().signal }), undefined);
  });

  await t.test("signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const translator = translatorWith(translated());
    assert.equal(await translator.assess(REQUEST, { signal: controller.signal }), undefined);
  });

  await t.test("request proxy getter", async () => {
    const request = new Proxy(REQUEST, {
      get(target, property, receiver) {
        if (property === "ruleRef") throw new Error("provider request getter");
        return Reflect.get(target, property, receiver);
      },
    });
    assert.equal(await translatorWith(translated()).assess(request, { signal: new AbortController().signal }), undefined);
  });
});
