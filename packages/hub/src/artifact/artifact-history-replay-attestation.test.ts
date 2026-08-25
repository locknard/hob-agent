import assert from "node:assert/strict";
import test from "node:test";

import {
  computeHistoryReplayInputIdentity,
  computeHistoryReplayResultIdentity,
  createHistoryReplayInput,
  createHistoryReplayResult,
  parseHistoryReplayInput,
  parseHistoryReplayResult,
  type HistoryReplayEvaluation,
  type HistoryReplayInputDraft,
} from "./artifact-history-replay-attestation.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const range = { since: "2026-08-24T23:00:00.000Z", until: "2026-08-25T00:00:00.000Z" };

function draft(overrides: Partial<HistoryReplayInputDraft> = {}): HistoryReplayInputDraft {
  return {
    artifact: {
      artifactId: "artifact-history-replay-1",
      revision: 3,
      contentHash: digest("a"),
    },
    proposal: {
      id: "proposal-history-replay-1",
      revision: 2,
      proposalEvidenceIdentity: digest("b"),
    },
    compile: { resultId: digest("c"), inputIdentity: digest("d") },
    dryRun: { resultId: digest("e"), inputIdentity: digest("f") },
    refs: [
      {
        bridgeId: "bridge-history-replay-1",
        hwId: "hw-history-replay-1",
        capabilityId: "cap-history-replay-1",
        observedAt: "2026-08-24T23:10:00.000Z",
        source: "imported-history",
        origin: "imported",
        importId: "import-history-replay-1",
        historySeq: 1,
        sourceRange: range,
      },
      {
        bridgeId: "bridge-history-replay-1",
        hwId: "hw-history-replay-1",
        capabilityId: "cap-history-replay-1",
        observedAt: "2026-08-24T23:20:00.000Z",
        source: "imported-history",
        origin: "imported",
        importId: "import-history-replay-1",
        historySeq: 2,
        sourceRange: range,
      },
    ],
    samples: [
      {
        bridgeId: "bridge-history-replay-1",
        importId: "import-history-replay-1",
        historySeq: 1,
        sourceTs: "2026-08-24T23:10:00.000Z",
        sourceTsQuality: "platform",
        value: "off",
      },
      {
        bridgeId: "bridge-history-replay-1",
        importId: "import-history-replay-1",
        historySeq: 2,
        sourceTs: "2026-08-24T23:20:00.000Z",
        sourceTsQuality: "platform",
        value: "on",
      },
    ],
    coverage: [{
      bridgeId: "bridge-history-replay-1",
      status: "partial",
      reasons: ["retention_floor_unknown"],
    }],
    truncated: false,
    evaluator: { id: "neutral-history-replay", version: "1.0.0" },
    ...overrides,
  };
}

const passedEvaluation: HistoryReplayEvaluation = {
  status: "passed",
  matchedSampleCount: 2,
  triggerCount: 1,
  actionCount: 1,
  reasons: [],
};

test("creates a frozen deterministic input and a passed partial replay result", () => {
  const input = createHistoryReplayInput(draft());
  const result = createHistoryReplayResult(input, passedEvaluation);

  assert.equal(input.inputIdentity, computeHistoryReplayInputIdentity(input));
  assert.equal(result.inputIdentity, input.inputIdentity);
  assert.equal(result.status, "passed");
  assert.equal(result.coverage, "partial");
  assert.deepEqual(result.counts, {
    referenceCount: 2,
    sampleCount: 2,
    matchedSampleCount: 2,
    triggerCount: 1,
    actionCount: 1,
  });
  assert.deepEqual(result.reasons, ["retention_floor_unknown"]);
  assert.equal(result.writesPerformed, false);
  assert.equal(result.resultId, computeHistoryReplayResultIdentity(result));
  assert.equal(Object.isFrozen(input), true);
  assert.equal(Object.isFrozen(input.refs), true);
  assert.equal(Object.isFrozen(result), true);
});

test("rejects duplicate refs, non-one-to-one samples, and non-platform or out-of-range source time", () => {
  const base = draft();
  assert.throws(
    () => parseHistoryReplayInput({ ...base, inputIdentity: digest("0"), refs: [base.refs[0], base.refs[0]], samples: [base.samples[0], base.samples[0]] }),
    /identity|duplicate|ref/i,
  );
  const input = createHistoryReplayInput(base);
  assert.throws(
    () => createHistoryReplayInput({ ...base, samples: [{ ...base.samples[0], historySeq: 99 }, base.samples[1]] }),
    /sample|ref|match/i,
  );
  assert.throws(
    () => createHistoryReplayInput({ ...base, samples: [{ ...base.samples[0], sourceTsQuality: "device" as "platform" }, base.samples[1]] }),
    /platform|sourceTsQuality/i,
  );
  assert.throws(
    () => createHistoryReplayInput({ ...base, samples: [{ ...base.samples[0], sourceTs: "2026-08-24T22:59:59.000Z" }, base.samples[1]] }),
    /range|sourceTs|observedAt/i,
  );
  assert.equal(input.refs.length, 2);
});

test("rejects provider, native, live, and causal fields through strict nested schemas", () => {
  const base = draft();
  assert.throws(
    () => createHistoryReplayInput({
      ...base,
      refs: [{ ...base.refs[0], nativeId: "entity.invalid" } as typeof base.refs[number], base.refs[1]],
    }),
    /unrecognized|nativeId|invalid/i,
  );
  assert.throws(
    () => createHistoryReplayInput({
      ...base,
      samples: [{ ...base.samples[0], liveCut: { epochId: "epoch", lastSeq: 1 } } as typeof base.samples[number], base.samples[1]],
    }),
    /unrecognized|liveCut|invalid/i,
  );
  assert.throws(
    () => createHistoryReplayInput({ ...base, traceRef: "trace" } as HistoryReplayInputDraft & { traceRef: string }),
    /unrecognized|traceRef|invalid/i,
  );
});

test("does not produce passed when coverage is unavailable, truncated, or has a history gap", () => {
  const unavailableInput = createHistoryReplayInput(draft({
    refs: [],
    samples: [],
    coverage: [{
      bridgeId: "bridge-history-replay-1",
      status: "unavailable",
      reasons: ["history_unavailable"],
    }],
  }));
  const unavailable = createHistoryReplayResult(unavailableInput, {
    ...passedEvaluation,
    matchedSampleCount: 0,
    triggerCount: 0,
    actionCount: 0,
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.coverage, "unavailable");
  assert.equal(unavailable.writesPerformed, false);
  assert.deepEqual(unavailable.reasons, ["history_unavailable"]);

  const gapInput = createHistoryReplayInput(draft({
    coverage: [{
      bridgeId: "bridge-history-replay-1",
      status: "partial",
      reasons: ["history_gap"],
    }],
  }));
  const gap = createHistoryReplayResult(gapInput, passedEvaluation);
  assert.equal(gap.status, "unavailable");
  assert.equal(gap.coverage, "unavailable");
  assert.deepEqual(gap.reasons, ["history_gap"]);

  const truncatedInput = createHistoryReplayInput(draft({ truncated: true }));
  const truncated = createHistoryReplayResult(truncatedInput, passedEvaluation);
  assert.equal(truncated.status, "unavailable");
  assert.equal(truncated.coverage, "unavailable");
  assert.deepEqual(truncated.reasons, ["query_truncated", "retention_floor_unknown"]);
});

test("blocks passed for every imported-history coverage failure reason", () => {
  const blockedReasons = [
    "bridge_not_ready",
    "missing_consistent_baseline",
    "journal_query_unavailable",
    "source_conflict",
    "imported_quota",
    "history_range_unavailable",
  ] as const;
  for (const reason of blockedReasons) {
    const input = createHistoryReplayInput(draft({
      coverage: [{
        bridgeId: "bridge-history-replay-1",
        status: "partial",
        reasons: [reason],
      }],
    }));
    const result = createHistoryReplayResult(input, passedEvaluation);
    assert.equal(result.status, "unavailable");
    assert.equal(result.coverage, "unavailable");
    assert.deepEqual(result.reasons, [reason]);
  }
});

test("requires every partial coverage bridge to contribute a selected sample before passing", () => {
  const input = createHistoryReplayInput(draft({
    coverage: [
      {
        bridgeId: "bridge-history-replay-1",
        status: "partial",
        reasons: ["retention_floor_unknown"],
      },
      {
        bridgeId: "bridge-history-replay-empty",
        status: "partial",
        reasons: ["retention_floor_unknown"],
      },
    ],
  }));
  const result = createHistoryReplayResult(input, passedEvaluation);
  assert.equal(result.status, "unavailable");
  assert.equal(result.coverage, "unavailable");
});

test("keeps evaluator failure explicit without claiming a successful replay", () => {
  const input = createHistoryReplayInput(draft());
  const result = createHistoryReplayResult(input, {
    status: "failed",
    matchedSampleCount: 1,
    triggerCount: 0,
    actionCount: 0,
    reasons: ["replay_mismatch"],
  });

  assert.equal(result.status, "failed");
  assert.equal(result.coverage, "partial");
  assert.deepEqual(result.reasons, ["replay_mismatch", "retention_floor_unknown"]);
});

test("rejects tampered input and result identities", () => {
  const input = createHistoryReplayInput(draft());
  const result = createHistoryReplayResult(input, passedEvaluation);

  assert.throws(
    () => createHistoryReplayInput({ ...draft(), inputIdentity: digest("0") }),
    /unrecognized|inputIdentity|invalid/i,
  );
  assert.throws(
    () => parseHistoryReplayInput({ ...input, inputIdentity: digest("0") }),
    /identity/i,
  );
  assert.throws(
    () => parseHistoryReplayResult({ ...result, resultId: digest("0") }),
    /identity/i,
  );
  assert.throws(
    () => parseHistoryReplayResult({ ...result, inputIdentity: digest("0") }),
    /identity/i,
  );
});
