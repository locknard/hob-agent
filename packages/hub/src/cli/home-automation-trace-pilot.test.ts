import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeAdapter, Envelope } from "@hob/bridge-contract";

import {
  parseHomeAutomationTracePilotArgs,
  runHomeAutomationTracePilot,
} from "./home-automation-trace-pilot.js";

const ENV = {
  HOB_DATA_DIR: "/tmp/hob-trace-pilot-test",
  HOB_TRACE_BRIDGE_ID: "bridge-a",
  HOB_BRIDGES: JSON.stringify([{
    bridgeId: "bridge-a",
    adapterType: "home-assistant",
    config: { baseUrl: "http://ha.invalid:8123", authenticationPrincipal: "pilot" },
    credentialRefs: { "access-token": "HOB_HA_TOKEN" },
  }]),
  HOB_HA_TOKEN: "test-ha-token",
} as const;

test("projects one exact foreign-rule trace without exposing provider data", async () => {
  let disposed = 0;
  let resyncs = 0;
  let traceRequest: unknown;
  const adapter = fakeAdapter({
    events: async function* () {
      yield envelope(1, "epoch-a", { kind: "sync-start", snapshotId: "snapshot", remoteInstanceId: "remote", reason: "initial" });
      yield envelope(2, "epoch-a", { kind: "sync-complete", manifest: { snapshotId: "snapshot", deviceEnvelopeCount: 0, stateEnvelopeCount: 0 } });
      yield stateEnvelope(3, "epoch-a");
      yield envelope(4, "epoch-a", {
        kind: "ext",
        ext: "causality@1",
        payload: { refSeq: 3, cause: { kind: "foreign_rule", ruleRef: "rule:opaque" } },
      });
    },
    async readTrace(request) {
      traceRequest = request;
      return {
        status: "complete",
        ruleRef: "rule:opaque",
        target: { epochId: "epoch-a", seq: 3 },
        run: {
          automationLabel: "Private automation name",
          state: "completed",
          outcome: "completed",
          startedAt: "2026-08-25T00:00:00.000Z",
          finishedAt: "2026-08-25T00:00:01.000Z",
          steps: [{ ordinal: 1, kind: "action", status: "executed" }],
          truncated: false,
        },
      };
    },
    async dispose() { disposed += 1; },
    async requestResync() { resyncs += 1; return { status: "completed" as const }; },
  });

  const report = await runHomeAutomationTracePilot(ENV, {
    timeoutSeconds: 1,
    createAdapter: () => adapter,
  });

  assert.deepEqual(report, {
    outcome: "exact_run",
    status: "complete",
    runState: "completed",
    runOutcome: "completed",
  });
  assert.deepEqual(traceRequest, {
    ruleRef: "rule:opaque",
    target: { epochId: "epoch-a", seq: 3 },
  });
  assert.equal(disposed, 1);
  assert.equal(resyncs, 0);
  const serialized = JSON.stringify(report);
  for (const forbidden of ["Private", "automationLabel", "rule:opaque", "epoch-a", "2026-08-25", "native-device"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("keeps the bounded result when timer cleanup reports an internal failure", async () => {
  let disposed = 0;
  const adapter = fakeAdapter({
    events: () => foreignRuleEvents("cleanup-rule"),
    async readTrace() {
      return {
        status: "complete" as const,
        ruleRef: "cleanup-rule",
        target: { epochId: "epoch-a", seq: 3 },
        run: {
          state: "completed" as const,
          outcome: "completed" as const,
          steps: [],
          truncated: false,
        },
      };
    },
    async dispose() { disposed += 1; },
    async requestResync() { return { status: "completed" as const }; },
  });

  const report = await runHomeAutomationTracePilot(ENV, {
    timeoutSeconds: 1,
    createAdapter: () => adapter,
    scheduleTimeout() {
      return { cancel() { throw new Error("timer cleanup detail"); } };
    },
  });

  assert.deepEqual(report, {
    outcome: "exact_run",
    status: "complete",
    runState: "completed",
    runOutcome: "completed",
  });
  assert.equal(disposed, 1);
});

test("returns not_observed on timeout without reading a trace or invoking control", async () => {
  let disposed = 0;
  let traceReads = 0;
  let receivedDelay = 0;
  let aborted = false;
  let fireTimeout!: () => void;
  const adapter = fakeAdapter({
    events: async function* (signal) {
      fireTimeout();
      if (signal.aborted) {
        aborted = true;
        return;
      }
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true });
      });
    },
    async readTrace() {
      traceReads += 1;
      throw new Error("must not read");
    },
    async dispose() { disposed += 1; },
    async requestResync() { return { status: "completed" as const }; },
  });

  const report = await runHomeAutomationTracePilot(ENV, {
    timeoutSeconds: 1,
    createAdapter: () => adapter,
    scheduleTimeout(callback, delayMs) {
      receivedDelay = delayMs;
      fireTimeout = callback;
      return { cancel() {} };
    },
  });

  assert.deepEqual(report, {
    outcome: "not_observed",
    status: "unknown",
    reasons: ["timeout"],
  });
  assert.equal(receivedDelay, 1_000);
  assert.equal(aborted, true);
  assert.equal(traceReads, 0);
  assert.equal(disposed, 1);
});

test("accepts only integer timeout argument text within the bounded window", () => {
  assert.equal(parseHomeAutomationTracePilotArgs([]), 60);
  assert.equal(parseHomeAutomationTracePilotArgs(["--timeout-seconds", "1"]), 1);
  assert.equal(parseHomeAutomationTracePilotArgs(["--timeout-seconds", "900"]), 900);
  for (const args of [
    ["--timeout-seconds", "0"],
    ["--timeout-seconds", "901"],
    ["--timeout-seconds", "1.0"],
    ["--timeout-seconds", "-1"],
    ["--timeout-seconds", "NaN"],
  ]) {
    assert.throws(() => parseHomeAutomationTracePilotArgs(args), /timeout/i);
  }
});

test("does not reuse a state across sync generations or through an intervening event", async () => {
  let traceReads = 0;
  let disposed = 0;
  const adapter = fakeAdapter({
    events: async function* () {
      yield envelope(1, "epoch-a", { kind: "sync-start", snapshotId: "snapshot-a", remoteInstanceId: "remote-a", reason: "initial" });
      yield envelope(2, "epoch-a", { kind: "sync-complete", manifest: { snapshotId: "snapshot-a", deviceEnvelopeCount: 0, stateEnvelopeCount: 0 } });
      yield stateEnvelope(3, "epoch-a");
      yield envelope(4, "epoch-b", { kind: "sync-start", snapshotId: "snapshot-b", remoteInstanceId: "remote-b", reason: "resync" });
      yield envelope(5, "epoch-b", { kind: "sync-complete", manifest: { snapshotId: "snapshot-b", deviceEnvelopeCount: 0, stateEnvelopeCount: 0 } });
      yield envelope(6, "epoch-b", {
        kind: "ext",
        ext: "causality@1",
        payload: { refSeq: 3, cause: { kind: "foreign_rule", ruleRef: "stale-rule" } },
      });
      yield stateEnvelope(7, "epoch-b");
      yield envelope(8, "epoch-b", { kind: "heartbeat" });
      yield envelope(9, "epoch-b", {
        kind: "ext",
        ext: "causality@1",
        payload: { refSeq: 7, cause: { kind: "foreign_rule", ruleRef: "intervening-rule" } },
      });
    },
    async readTrace() { traceReads += 1; throw new Error("must not read"); },
    async dispose() { disposed += 1; },
    async requestResync() { return { status: "completed" as const }; },
  });

  const report = await runHomeAutomationTracePilot(ENV, {
    timeoutSeconds: 1,
    createAdapter: () => adapter,
  });

  assert.deepEqual(report, { outcome: "not_observed", status: "unknown", reasons: ["stream_ended"] });
  assert.equal(traceReads, 0);
  assert.equal(disposed, 1);
});

test("does not treat snapshot or imported state as a natural trace target", async () => {
  let traceReads = 0;
  let disposed = 0;
  const adapter = fakeAdapter({
    events: async function* () {
      yield envelope(1, "epoch-a", { kind: "sync-start", snapshotId: "snapshot-a", remoteInstanceId: "remote-a", reason: "initial" });
      yield stateEnvelope(2, "epoch-a");
      yield envelope(3, "epoch-a", {
        kind: "ext",
        ext: "causality@1",
        payload: { refSeq: 2, cause: { kind: "foreign_rule", ruleRef: "snapshot-rule" } },
      });
      yield envelope(4, "epoch-a", { kind: "sync-complete", manifest: { snapshotId: "snapshot-a", deviceEnvelopeCount: 0, stateEnvelopeCount: 1 } });
      yield importedStateEnvelope(5, "epoch-a");
      yield envelope(6, "epoch-a", {
        kind: "ext",
        ext: "causality@1",
        payload: { refSeq: 5, cause: { kind: "foreign_rule", ruleRef: "imported-rule" } },
      });
    },
    async readTrace() { traceReads += 1; throw new Error("must not read"); },
    async dispose() { disposed += 1; },
    async requestResync() { return { status: "completed" as const }; },
  });

  const report = await runHomeAutomationTracePilot(ENV, {
    timeoutSeconds: 1,
    createAdapter: () => adapter,
  });

  assert.deepEqual(report, { outcome: "not_observed", status: "unknown", reasons: ["stream_ended"] });
  assert.equal(traceReads, 0);
  assert.equal(disposed, 1);
});

test("keeps a retained-rule result separate from an unavailable exact trace", async () => {
  const results = [
    {
      status: "unknown" as const,
      target: { epochId: "epoch-a", seq: 3 },
      reasons: ["trace_not_retained" as const],
    },
    {
      status: "unavailable" as const,
      target: { epochId: "epoch-a", seq: 3 },
      reasons: ["permission_denied" as const],
    },
  ];

  for (const [index, expected] of results.entries()) {
    let disposed = 0;
    let readCount = 0;
    const adapter = fakeAdapter({
      events: () => foreignRuleEvents(`rule-${index}`),
      async readTrace() {
        readCount += 1;
        return { ...expected, ruleRef: `rule-${index}` };
      },
      async dispose() { disposed += 1; },
      async requestResync() { return { status: "completed" as const }; },
    });

    const report = await runHomeAutomationTracePilot(ENV, {
      timeoutSeconds: 1,
      createAdapter: () => adapter,
    });

    assert.deepEqual(report, {
      outcome: "rule_only",
      status: expected.status,
      reasons: expected.reasons,
    });
    assert.equal(readCount, 1);
    assert.equal(disposed, 1);
  }
});

test("projects a partial exact run without returning trace labels, steps, or timestamps", async () => {
  const adapter = fakeAdapter({
    events: () => foreignRuleEvents("partial-rule"),
    async readTrace() {
      return {
        status: "partial" as const,
        ruleRef: "partial-rule",
        target: { epochId: "epoch-a", seq: 3 },
        reasons: ["unsupported_trace" as const],
        run: {
          automationLabel: "Private name",
          state: "running" as const,
          outcome: "unknown" as const,
          startedAt: "2026-08-25T00:00:00.000Z",
          steps: [{ ordinal: 1, kind: "trigger" as const, status: "executed" as const }],
          truncated: true,
        },
      };
    },
    async dispose() {},
    async requestResync() { return { status: "completed" as const }; },
  });

  const report = await runHomeAutomationTracePilot(ENV, {
    timeoutSeconds: 1,
    createAdapter: () => adapter,
  });

  assert.deepEqual(report, {
    outcome: "exact_run",
    status: "partial",
    runState: "running",
    runOutcome: "unknown",
    reasons: ["unsupported_trace"],
  });
  const serialized = JSON.stringify(report);
  for (const forbidden of ["Private", "automationLabel", "2026-08-25", "steps", "partial-rule"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("rejects a valid trace result that echoes a different rule or evidence target", async () => {
  for (const mismatch of [
    { ruleRef: "different-rule", target: { epochId: "epoch-a", seq: 3 } },
    { ruleRef: "matched-rule", target: { epochId: "epoch-a", seq: 4 } },
  ]) {
    const adapter = fakeAdapter({
      events: () => foreignRuleEvents("matched-rule"),
      async readTrace() {
        return {
          status: "complete" as const,
          ...mismatch,
          run: {
            state: "completed" as const,
            outcome: "completed" as const,
            steps: [],
            truncated: false,
          },
        };
      },
      async dispose() {},
      async requestResync() { return { status: "completed" as const }; },
    });

    assert.deepEqual(await runHomeAutomationTracePilot(ENV, {
      timeoutSeconds: 1,
      createAdapter: () => adapter,
    }), {
      outcome: "rule_only",
      status: "unavailable",
      reasons: ["invalid_response"],
    });
  }
});

test("fails closed on a malformed stream envelope without reading a trace", async () => {
  let traceReads = 0;
  let disposed = 0;
  const adapter = fakeAdapter({
    events: async function* () {
      yield { malformed: true } as never;
    },
    async readTrace() { traceReads += 1; throw new Error("must not read"); },
    async dispose() { disposed += 1; },
    async requestResync() { return { status: "completed" as const }; },
  });

  const report = await runHomeAutomationTracePilot(ENV, {
    timeoutSeconds: 1,
    createAdapter: () => adapter,
  });

  assert.deepEqual(report, {
    outcome: "unavailable",
    status: "unavailable",
    reasons: ["invalid_response"],
  });
  assert.equal(traceReads, 0);
  assert.equal(disposed, 1);
});

test("maps a stream failure to a fixed unavailable reason and still disposes", async () => {
  let disposed = 0;
  const adapter = fakeAdapter({
    events: async function* () {
      throw new Error("private upstream detail");
    },
    readTrace: async () => undefined,
    async dispose() { disposed += 1; },
    async requestResync() { return { status: "completed" as const }; },
  });

  const report = await runHomeAutomationTracePilot(ENV, {
    timeoutSeconds: 1,
    createAdapter: () => adapter,
  });

  assert.deepEqual(report, {
    outcome: "unavailable",
    status: "unavailable",
    reasons: ["stream_unavailable"],
  });
  assert.equal(disposed, 1);
});

test("does not hang when an exact trace read ignores the abort signal", async () => {
  let disposed = 0;
  let fireTimeout!: () => void;
  const adapter = fakeAdapter({
    events: () => foreignRuleEvents("stuck-rule"),
    async readTrace() {
      fireTimeout();
      return await new Promise<never>(() => {});
    },
    async dispose() { disposed += 1; },
    async requestResync() { return { status: "completed" as const }; },
  });

  const run = runHomeAutomationTracePilot(ENV, {
    timeoutSeconds: 1,
    createAdapter: () => adapter,
    scheduleTimeout(callback) {
      fireTimeout = callback;
      return { cancel() {} };
    },
  });
  const result = await Promise.race([
    run.then((report) => ({ kind: "report" as const, report })),
    new Promise<{ readonly kind: "hung" }>((resolve) => setTimeout(() => resolve({ kind: "hung" }), 50)),
  ]);

  assert.notEqual(result.kind, "hung");
  assert.deepEqual(result, {
    kind: "report",
    report: { outcome: "rule_only", status: "unavailable", reasons: ["timeout"] },
  });
  assert.equal(disposed, 1);
});

test("reports missing trace extension without starting the event stream", async () => {
  let streamStarted = 0;
  let disposed = 0;
  const adapter = fakeAdapter({
    events: async function* () { streamStarted += 1; },
    readTrace: async () => undefined,
    dispose: async () => { disposed += 1; },
    requestResync: async () => ({ status: "completed" as const }),
    traceExtension: false,
  });

  const report = await runHomeAutomationTracePilot(ENV, {
    timeoutSeconds: 1,
    createAdapter: () => adapter,
  });

  assert.deepEqual(report, {
    outcome: "unavailable",
    status: "unavailable",
    reasons: ["trace_unavailable"],
  });
  assert.equal(streamStarted, 0);
  assert.equal(disposed, 1);
});

test("turns an already-cancelled pilot into a bounded not-observed result", async () => {
  const cancellation = new AbortController();
  cancellation.abort();
  let disposed = 0;
  const adapter = fakeAdapter({
    events: async function* (signal) {
      assert.equal(signal.aborted, true);
    },
    readTrace: async () => undefined,
    async dispose() { disposed += 1; },
    async requestResync() { return { status: "completed" as const }; },
  });

  const report = await runHomeAutomationTracePilot(ENV, {
    timeoutSeconds: 1,
    signal: cancellation.signal,
    createAdapter: () => adapter,
  });

  assert.deepEqual(report, { outcome: "not_observed", status: "unknown", reasons: ["cancelled"] });
  assert.equal(disposed, 1);
});

test("rejects an unknown configured bridge without constructing an adapter", async () => {
  let constructed = 0;
  const report = await runHomeAutomationTracePilot({
    ...ENV,
    HOB_TRACE_BRIDGE_ID: "bridge-missing",
  }, {
    timeoutSeconds: 1,
    createAdapter: () => {
      constructed += 1;
      return fakeAdapter({
        events: async function* () {},
        readTrace: async () => undefined,
        dispose: async () => {},
        requestResync: async () => ({ status: "completed" as const }),
      });
    },
  });

  assert.deepEqual(report, {
    outcome: "unavailable",
    status: "unavailable",
    reasons: ["configuration_invalid"],
  });
  assert.equal(constructed, 0);
});

function fakeAdapter(input: {
  readonly events: (signal: AbortSignal) => AsyncIterable<Envelope>;
  readonly readTrace: (request: unknown, signal: AbortSignal) => Promise<unknown>;
  readonly dispose: () => Promise<void>;
  readonly requestResync: (signal: AbortSignal) => Promise<unknown>;
  readonly traceExtension?: boolean;
}): BridgeAdapter {
  return {
    info: {
      bridgeId: "bridge-a",
      coreVersion: "6.5.0",
      ecosystem: "home-assistant",
      heartbeatIntervalMs: 60_000,
      extensions: [{ id: "automationTrace", version: "1.0.0" }],
    },
    events: input.events,
    control: {
      requestResync: input.requestResync,
      dispose: input.dispose,
    },
    extension(name) {
      if (name !== "automationTrace@1" || input.traceExtension === false) return undefined;
      return { readTrace: input.readTrace } as never;
    },
  };
}

function envelope(seq: number, epochId: string, event: Envelope["event"]): Envelope {
  return { seq, epochId, event };
}

function stateEnvelope(seq: number, epochId: string): Envelope {
  return envelope(seq, epochId, {
    kind: "state",
    state: {
      nativeId: "native-device",
      nativeInstanceId: "native-instance",
      attrs: { state: "on" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  });
}

function importedStateEnvelope(seq: number, epochId: string): Envelope {
  return envelope(seq, epochId, {
    kind: "state",
    state: {
      nativeId: "native-device",
      nativeInstanceId: "native-instance",
      attrs: { state: "on" },
      time: { sourceTsQuality: "none" },
      origin: "imported",
    },
  });
}

async function* foreignRuleEvents(ruleRef: string): AsyncIterable<Envelope> {
  yield envelope(1, "epoch-a", { kind: "sync-start", snapshotId: "snapshot", remoteInstanceId: "remote", reason: "initial" });
  yield envelope(2, "epoch-a", { kind: "sync-complete", manifest: { snapshotId: "snapshot", deviceEnvelopeCount: 0, stateEnvelopeCount: 0 } });
  yield stateEnvelope(3, "epoch-a");
  yield envelope(4, "epoch-a", {
    kind: "ext",
    ext: "causality@1",
    payload: { refSeq: 3, cause: { kind: "foreign_rule", ruleRef } },
  });
}
