import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOMATION_TRACE_EXTENSION,
  AUTOMATION_TRACE_EXTENSION_KEY,
  automationTraceReasonSchema,
  automationTraceCoverageSchema,
  automationTraceRequestSchema,
  automationTraceResultSchema,
  automationTraceRunSchema,
  type AutomationTraceHandle,
  type AutomationTraceRun,
} from "./bridge-automation-trace.js";
import type { ExtensionHandleRegistry } from "./bridge-contract.js";

const target = { epochId: "epoch-a", seq: 17 };
const request = { ruleRef: "rule-arrival", target };

const completeRun: AutomationTraceRun = {
  automationLabel: "Arrival lights",
  state: "completed",
  outcome: "completed",
  startedAt: "2026-08-25T10:00:00.000Z",
  finishedAt: "2026-08-25T10:00:01.250Z",
  steps: [
    { ordinal: 1, kind: "trigger", status: "executed" },
    { ordinal: 2, kind: "condition", status: "passed" },
    { ordinal: 3, kind: "action", status: "executed" },
  ],
  truncated: false,
};

test("defines automationTrace@1 and registers its read-only handle", async () => {
  assert.deepEqual(AUTOMATION_TRACE_EXTENSION, {
    id: "automationTrace",
    version: "1.0.0",
  });
  assert.equal(AUTOMATION_TRACE_EXTENSION_KEY, "automationTrace@1");

  const handle: ExtensionHandleRegistry["automationTrace@1"] = {
    readTrace: async (_request, _options) => ({
      status: "complete",
      ruleRef: request.ruleRef,
      target,
      run: completeRun,
    }),
  } satisfies AutomationTraceHandle;

  assert.equal(typeof handle.readTrace, "function");
  const result = await handle.readTrace(request, { signal: new AbortController().signal });
  assert.equal(automationTraceResultSchema.safeParse(result).success, true);
});

test("accepts only bounded aggregate stable-trace identity coverage", async () => {
  const coverage = {
    status: "partial" as const,
    totalAutomationEntities: 15,
    stableTraceIdentityEntities: 1,
    missingTraceIdentityEntities: 14,
    ambiguousTraceIdentityEntities: 0,
  };
  const handle: AutomationTraceHandle = {
    readTrace: async () => ({
      status: "complete",
      ruleRef: request.ruleRef,
      target,
      run: completeRun,
    }),
    coverage: async ({ signal }) => {
      assert.equal(signal.aborted, false);
      return coverage;
    },
  };

  assert.equal(automationTraceCoverageSchema.safeParse(
    await handle.coverage!({ signal: new AbortController().signal }),
  ).success, true);
  assert.equal(automationTraceCoverageSchema.safeParse({
    ...coverage,
    stableTraceIdentityEntities: 2,
  }).success, false);
  assert.equal(automationTraceCoverageSchema.safeParse({
    ...coverage,
    nativeId: "must-not-cross-contract",
  }).success, false);
  assert.equal(automationTraceCoverageSchema.safeParse({
    status: "partial",
    totalAutomationEntities: 15,
    stableTraceIdentityEntities: 1,
    missingTraceIdentityEntities: 13,
    ambiguousTraceIdentityEntities: 0,
  }).success, false);
});

test("accepts the four closed result states with their required fields", () => {
  assert.equal(automationTraceResultSchema.safeParse({
    status: "complete",
    ruleRef: request.ruleRef,
    target,
    run: completeRun,
  }).success, true);
  assert.equal(automationTraceResultSchema.safeParse({
    status: "partial",
    ruleRef: request.ruleRef,
    target,
    run: completeRun,
    reasons: ["unsupported_trace"],
  }).success, true);
  assert.equal(automationTraceResultSchema.safeParse({
    status: "unknown",
    ruleRef: request.ruleRef,
    target,
    reasons: ["association_missing"],
  }).success, true);
  assert.equal(automationTraceResultSchema.safeParse({
    status: "unavailable",
    ruleRef: request.ruleRef,
    target,
    reasons: ["permission_denied"],
  }).success, true);
});

test("rejects malformed requests, duplicate reasons, and status-specific fields", () => {
  assert.equal(automationTraceRequestSchema.safeParse({
    ruleRef: " rule",
    target,
  }).success, false);
  assert.equal(automationTraceRequestSchema.safeParse({
    ruleRef: "rule",
    target: { epochId: "", seq: 1 },
  }).success, false);
  assert.equal(automationTraceRequestSchema.safeParse({
    ruleRef: "rule",
    target: { epochId: "epoch", seq: Number.MAX_SAFE_INTEGER + 1 },
  }).success, false);
  assert.equal(automationTraceRequestSchema.safeParse({
    ruleRef: "rule",
    target,
    nativeId: "light.kitchen",
  }).success, false);

  assert.equal(automationTraceResultSchema.safeParse({
    status: "complete",
    ruleRef: request.ruleRef,
    target,
    run: completeRun,
    reasons: [],
  }).success, false);
  assert.equal(automationTraceResultSchema.safeParse({
    status: "partial",
    ruleRef: request.ruleRef,
    target,
    run: completeRun,
    reasons: ["association_missing", "association_missing"],
  }).success, false);
  assert.equal(automationTraceResultSchema.safeParse({
    status: "unknown",
    ruleRef: request.ruleRef,
    target,
  }).success, false);
});

test("bounds neutral run fields and rejects raw trace/provider fields", () => {
  assert.equal(automationTraceRunSchema.safeParse({
    ...completeRun,
    steps: new Array(33).fill({ ordinal: 1, kind: "unknown", status: "unknown" }),
  }).success, false);
  assert.equal(automationTraceRunSchema.safeParse({
    ...completeRun,
    steps: [{ ordinal: 1, kind: "action", status: "failed", errorKind: "provider_error" }],
  }).success, false);
  assert.equal(automationTraceRunSchema.safeParse({
    ...completeRun,
    runId: "native-run-id",
  }).success, false);
  assert.equal(automationTraceRunSchema.safeParse({
    ...completeRun,
    context: { id: "native-context" },
  }).success, false);
  assert.equal(automationTraceRunSchema.safeParse({
    ...completeRun,
    error: "raw provider error",
  }).success, false);
  assert.equal(automationTraceReasonSchema.safeParse("recorder_gap").success, false);
});

test("rejects a run whose finish precedes its start", () => {
  assert.equal(automationTraceRunSchema.safeParse({
    ...completeRun,
    startedAt: "2026-08-25T10:00:02.000Z",
    finishedAt: "2026-08-25T10:00:01.000Z",
  }).success, false);
});

test("rejects status and reason combinations with contradictory evidence semantics", () => {
  assert.equal(automationTraceResultSchema.safeParse({
    status: "unavailable",
    ruleRef: request.ruleRef,
    target,
    reasons: ["trace_not_retained"],
  }).success, false);
  assert.equal(automationTraceResultSchema.safeParse({
    status: "unknown",
    ruleRef: request.ruleRef,
    target,
    reasons: ["permission_denied"],
  }).success, false);
  assert.equal(automationTraceResultSchema.safeParse({
    status: "partial",
    ruleRef: request.ruleRef,
    target,
    run: completeRun,
    reasons: ["association_missing"],
  }).success, false);
});

test("represents a bounded step projection as partial invalid_response", () => {
  assert.equal(automationTraceResultSchema.safeParse({
    status: "partial",
    ruleRef: request.ruleRef,
    target,
    run: {
      ...completeRun,
      steps: Array.from({ length: 32 }, (_, index) => ({
        ordinal: index + 1,
        kind: "unknown",
        status: "unknown",
      })),
      truncated: true,
    },
    reasons: ["invalid_response"],
  }).success, true);
});
