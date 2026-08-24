import assert from "node:assert/strict";
import test from "node:test";

import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import { apply } from "./home-automation-trace-tool.js";

const query = {
  hwCapabilityId: "hc-light",
  provenance: { bridgeId: "bridge-a", epochId: "epoch-a", seq: 17 },
};

function contextFor(homeWorld: Record<string, unknown>): () => ToolDefinition {
  let registered: ToolDefinition | undefined;
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
  return () => {
    assert.notEqual(registered, undefined);
    return registered!;
  };
}

test("projects an exact trace port result without exposing native identifiers", async () => {
  let received: unknown;
  let receivedSignal: AbortSignal | undefined;
  const homeWorld = {
    marker: "bound",
    async queryAutomationTrace(input: unknown, signal?: AbortSignal) {
      assert.equal(this.marker, "bound");
      received = input;
      receivedSignal = signal;
      return {
        status: "complete",
        coverage: "exact_run",
        hwCapabilityId: query.hwCapabilityId,
        provenance: query.provenance,
        automationLabel: "Arrival lights",
        run: {
          state: "completed",
          outcome: "completed",
          startedAt: "2026-08-25T10:00:00.000Z",
          finishedAt: "2026-08-25T10:00:01.250Z",
        },
        steps: [
          { ordinal: 1, kind: "trigger", status: "executed" },
          { ordinal: 2, kind: "condition", status: "passed" },
          { ordinal: 3, kind: "action", status: "executed" },
        ],
        reasons: [],
        truncated: false,
      };
    },
  };
  const registered = contextFor(homeWorld)();
  assert.equal(registered.name, "get_home_automation_trace");

  const controller = new AbortController();
  const value = await registered.execute(query, { signal: controller.signal } as never);

  assert.deepEqual(received, query);
  assert.equal(receivedSignal, controller.signal);
  assert.deepEqual(value, {
    status: "complete",
    coverage: "exact_run",
    automationLabel: "Arrival lights",
    run: {
      state: "completed",
      outcome: "completed",
      startedAt: "2026-08-25T10:00:00.000Z",
      finishedAt: "2026-08-25T10:00:01.250Z",
    },
    steps: [
      { ordinal: 1, kind: "trigger", status: "executed" },
      { ordinal: 2, kind: "condition", status: "passed" },
      { ordinal: 3, kind: "action", status: "executed" },
    ],
    reasons: [],
    truncated: false,
  });
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "ruleRef", "traceRef", "runId", "context", "entityId", "config", "provider", "ha-rule-secret",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("accepts HomeWorld's safe result only for the exact returned capability and provenance", async () => {
  const registered = contextFor({
    queryAutomationTrace() {
      return {
        status: "complete",
        coverage: "exact_run",
        hwCapabilityId: query.hwCapabilityId,
        provenance: query.provenance,
        automationLabel: "Arrival lights",
        run: {
          state: "completed",
          outcome: "completed",
          startedAt: "2026-08-25T10:00:00.000Z",
          finishedAt: "2026-08-25T10:00:01.250Z",
        },
        steps: [{ ordinal: 1, kind: "action", status: "executed" }],
        reasons: [],
        truncated: false,
      };
    },
  })();

  assert.deepEqual(await registered.execute(query, {} as never), {
    status: "complete",
    coverage: "exact_run",
    automationLabel: "Arrival lights",
    run: {
      state: "completed",
      outcome: "completed",
      startedAt: "2026-08-25T10:00:00.000Z",
      finishedAt: "2026-08-25T10:00:01.250Z",
    },
    steps: [{ ordinal: 1, kind: "action", status: "executed" }],
    reasons: [],
    truncated: false,
  });
});

test("accepts contract timestamps with an explicit numeric UTC offset", async () => {
  const registered = contextFor({
    queryAutomationTrace() {
      return {
        status: "complete",
        coverage: "exact_run",
        hwCapabilityId: query.hwCapabilityId,
        provenance: query.provenance,
        run: {
          state: "completed",
          outcome: "completed",
          startedAt: "2026-08-25T18:00:00.000+08:00",
          finishedAt: "2026-08-25T18:00:01.250+08:00",
        },
        steps: [],
        reasons: [],
        truncated: false,
      };
    },
  })();

  assert.deepEqual(await registered.execute(query, {} as never), {
    status: "complete",
    coverage: "exact_run",
    run: {
      state: "completed",
      outcome: "completed",
      startedAt: "2026-08-25T18:00:00.000+08:00",
      finishedAt: "2026-08-25T18:00:01.250+08:00",
    },
    steps: [],
    reasons: [],
    truncated: false,
  });
});

test("keeps a rule-only result honest when an exact trace is unavailable", async () => {
  const registered = contextFor({
    queryAutomationTrace() {
      return {
        status: "unknown",
        coverage: "rule_only",
        hwCapabilityId: query.hwCapabilityId,
        provenance: query.provenance,
        reasons: ["association_missing"],
        truncated: false,
      };
    },
  })();

  assert.deepEqual(await registered.execute(query, {} as never), {
    status: "unknown",
    coverage: "rule_only",
    reasons: ["association_missing"],
    truncated: false,
  });
});

test("maps HomeWorld coverage reasons while dropping its internal identity fields", async () => {
  const registered = contextFor({
    queryAutomationTrace() {
      return {
        status: "unavailable",
        coverage: "rule_only",
        hwCapabilityId: query.hwCapabilityId,
        provenance: query.provenance,
        reasons: ["unsupported_trace"],
        truncated: false,
      };
    },
  })();

  assert.deepEqual(await registered.execute(query, {} as never), {
    status: "unavailable",
    coverage: "rule_only",
    reasons: ["trace_unavailable"],
    truncated: false,
  });
});

test("fails closed for malformed or provider-shaped trace results", async () => {
  const results = [
    {
      status: "complete",
      ruleRef: "ha-rule-secret",
      target: { epochId: "epoch-a", seq: 17 },
      run: {
        state: "completed",
        outcome: "completed",
        steps: [],
        truncated: false,
      },
    },
    {
      status: "complete",
      ruleRef: "ha-rule-secret",
      target: { epochId: "epoch-a", seq: 17 },
      run: {
        state: "completed",
        outcome: "completed",
        steps: [],
        truncated: false,
        runId: "native-run-id",
      },
      reasons: [],
    },
    {
      status: "complete",
      ruleRef: "ha-rule-secret",
      target: { epochId: "epoch-a", seq: 17 },
      run: {
        state: "completed",
        outcome: "completed",
        steps: new Array(33).fill({ ordinal: 1, kind: "unknown", status: "unknown" }),
        truncated: false,
      },
      reasons: [],
    },
    {
      status: "unknown",
      ruleRef: "ha-rule-secret",
      target: { epochId: "epoch-a", seq: 17 },
      reasons: ["__proto__"],
    },
  ];
  const registered = contextFor({
    queryAutomationTrace() {
      return results.shift();
    },
  })();

  for (let index = 0; index < 4; index += 1) {
    assert.deepEqual(await registered.execute(query, {} as never), {
      status: "unavailable",
      coverage: "not_available",
      reasons: ["invalid_response"],
      truncated: false,
    });
  }
});

test("rejects an inexact provenance query before calling HomeWorld", async () => {
  let calls = 0;
  const registered = contextFor({
    queryAutomationTrace() {
      calls += 1;
      return undefined;
    },
  })();

  await assert.rejects(
    registered.execute({
      ...query,
      provenance: { ...query.provenance, seq: 0 },
      unexpected: true,
    }, {} as never),
    /home automation trace query is invalid/,
  );
  assert.equal(calls, 0);
});
