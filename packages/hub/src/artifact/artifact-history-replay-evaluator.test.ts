import assert from "node:assert/strict";
import test from "node:test";

import {
  createHistoryReplayInput,
  type HistoryReplayInputDraft,
  type HistoryReplayNeutralSample,
} from "./artifact-history-replay-attestation.js";
import { createArtifactRevision, type ArtifactRevision } from "./neutral-artifact.js";
import { evaluateHistoryReplay } from "./artifact-history-replay-evaluator.js";

const range = { since: "2026-08-20T00:00:00.000Z", until: "2026-08-21T00:00:00.000Z" };
const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function artifact(options: {
  trigger?: ArtifactRevision["content"]["trigger"];
  conditions?: ArtifactRevision["content"]["conditions"];
  actions?: ArtifactRevision["content"]["actions"];
} = {}): ArtifactRevision {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: "artifact-history-evaluator-1",
    revision: 1,
    title: "Notify after a capability changes",
    summary: "A neutral history evaluator fixture.",
    sourceProposal: { proposalId: "proposal-history-evaluator-1", proposalRevision: 1 },
    content: {
      trigger: options.trigger ?? { kind: "capability_changed", source: { hwCapabilityId: "hwc-trigger" } },
      conditions: options.conditions ?? [{
        kind: "capability_value",
        source: { hwCapabilityId: "hwc-condition" },
        operator: "equals",
        value: true,
      }],
      actions: options.actions ?? [{ kind: "notify_local", message: "A reviewed change occurred." }],
      rollback: { kind: "no_remote_change" },
      postconditions: [],
    },
    createdAt: "2026-08-20T00:00:00.000Z",
  });
}

function sample(
  historySeq: number,
  sourceTs: string,
  capabilityId: string,
  value: HistoryReplayNeutralSample["value"],
): { ref: HistoryReplayInputDraft["refs"][number]; sample: HistoryReplayNeutralSample } {
  return {
    ref: {
      bridgeId: "bridge-history-evaluator-1",
      hwId: "hw-history-evaluator-1",
      capabilityId,
      observedAt: sourceTs,
      source: "imported-history",
      origin: "imported",
      importId: "import-history-evaluator-1",
      historySeq,
      sourceRange: range,
    },
    sample: {
      bridgeId: "bridge-history-evaluator-1",
      importId: "import-history-evaluator-1",
      historySeq,
      sourceTs,
      sourceTsQuality: "platform",
      value,
    },
  };
}

function replayInput(
  revision: ArtifactRevision,
  events: readonly ReturnType<typeof sample>[],
) {
  return createHistoryReplayInput({
    artifact: {
      artifactId: revision.artifactId,
      revision: revision.revision,
      contentHash: revision.contentHash,
    },
    proposal: {
      id: revision.sourceProposal.proposalId,
      revision: revision.sourceProposal.proposalRevision,
      proposalEvidenceIdentity: digest("b"),
    },
    compile: { resultId: digest("c"), inputIdentity: digest("d") },
    dryRun: { resultId: digest("e"), inputIdentity: digest("f") },
    refs: events.map((event) => event.ref),
    samples: events.map((event) => event.sample),
    coverage: [{
      bridgeId: "bridge-history-evaluator-1",
      status: "partial",
      reasons: ["retention_floor_unknown"],
    }],
    truncated: false,
    evaluator: { id: "neutral-history-replay", version: "1.0.0" },
  });
}

test("replays capability changes in source-time order and evaluates conditions on the changed state", () => {
  const revision = artifact();
  const events = [
    sample(5, "2026-08-20T00:00:02.000Z", "hwc-condition", false),
    sample(4, "2026-08-20T00:00:03.000Z", "hwc-trigger", true),
    sample(3, "2026-08-20T00:00:04.000Z", "hwc-condition", true),
    sample(2, "2026-08-20T00:00:01.000Z", "hwc-trigger", false),
    sample(1, "2026-08-20T00:00:05.000Z", "hwc-trigger", false),
  ];

  const result = evaluateHistoryReplay(revision, replayInput(revision, events));

  assert.deepEqual(result, {
    status: "passed",
    matchedSampleCount: 5,
    triggerCount: 2,
    actionCount: 1,
    reasons: [],
  });
  assert.deepEqual(Object.keys(result).sort(), ["actionCount", "matchedSampleCount", "reasons", "status", "triggerCount"]);
  assert.equal(JSON.stringify(result).includes("bridge-history-evaluator-1"), false);
});

test("uses the exact identity tie-breaker when samples share a source timestamp", () => {
  const revision = artifact();
  const events = [
    sample(1, "2026-08-20T00:00:01.000Z", "hwc-trigger", false),
    sample(3, "2026-08-20T00:00:02.000Z", "hwc-trigger", true),
    sample(2, "2026-08-20T00:00:02.000Z", "hwc-condition", true),
  ];

  const result = evaluateHistoryReplay(revision, replayInput(revision, events));

  assert.deepEqual(result, {
    status: "passed",
    matchedSampleCount: 3,
    triggerCount: 1,
    actionCount: 1,
    reasons: [],
  });
});

test("keeps scalar equality strict instead of coercing string and number values", () => {
  const revision = artifact({ conditions: [{
    kind: "capability_value",
    source: { hwCapabilityId: "hwc-condition" },
    operator: "equals",
    value: 1,
  }] });
  const events = [
    sample(1, "2026-08-20T00:00:01.000Z", "hwc-trigger", false),
    sample(2, "2026-08-20T00:00:02.000Z", "hwc-condition", "1"),
    sample(3, "2026-08-20T00:00:03.000Z", "hwc-trigger", true),
  ];

  const result = evaluateHistoryReplay(revision, replayInput(revision, events));

  assert.deepEqual(result, {
    status: "passed",
    matchedSampleCount: 3,
    triggerCount: 1,
    actionCount: 0,
    reasons: [],
  });
});

test("supports strict not_equals and numeric greater/less comparisons", () => {
  const notEqualsRevision = artifact({ conditions: [{
    kind: "capability_value",
    source: { hwCapabilityId: "hwc-condition" },
    operator: "not_equals",
    value: 1,
  }] });
  const numericEvents = [
    sample(1, "2026-08-20T00:00:01.000Z", "hwc-trigger", false),
    sample(2, "2026-08-20T00:00:02.000Z", "hwc-condition", "1"),
    sample(3, "2026-08-20T00:00:03.000Z", "hwc-trigger", true),
  ];
  assert.equal(evaluateHistoryReplay(notEqualsRevision, replayInput(notEqualsRevision, numericEvents)).actionCount, 1);

  const greaterRevision = artifact({ conditions: [{
    kind: "capability_value",
    source: { hwCapabilityId: "hwc-condition" },
    operator: "greater_than",
    value: 2,
  }] });
  const greaterEvents = [
    sample(1, "2026-08-20T00:00:01.000Z", "hwc-trigger", false),
    sample(2, "2026-08-20T00:00:02.000Z", "hwc-condition", 3),
    sample(3, "2026-08-20T00:00:03.000Z", "hwc-trigger", true),
  ];
  assert.equal(evaluateHistoryReplay(greaterRevision, replayInput(greaterRevision, greaterEvents)).actionCount, 1);

  const lessRevision = artifact({ conditions: [{
    kind: "capability_value",
    source: { hwCapabilityId: "hwc-condition" },
    operator: "less_than",
    value: 4,
  }] });
  const lessEvents = greaterEvents.map((event) => event === greaterEvents[1]
    ? sample(2, "2026-08-20T00:00:02.000Z", "hwc-condition", 3)
    : event);
  assert.equal(evaluateHistoryReplay(lessRevision, replayInput(lessRevision, lessEvents)).actionCount, 1);
});

test("returns evaluator_unavailable for missing condition samples, nonnumeric comparisons, and identity mismatch", () => {
  const missingRevision = artifact();
  const missingEvents = [
    sample(1, "2026-08-20T00:00:01.000Z", "hwc-trigger", false),
    sample(2, "2026-08-20T00:00:02.000Z", "hwc-trigger", true),
  ];
  assert.deepEqual(
    evaluateHistoryReplay(missingRevision, replayInput(missingRevision, missingEvents)),
    {
      status: "unavailable",
      matchedSampleCount: 2,
      triggerCount: 0,
      actionCount: 0,
      reasons: ["evaluator_unavailable"],
    },
  );

  const nonnumericRevision = artifact({ conditions: [{
    kind: "capability_value",
    source: { hwCapabilityId: "hwc-condition" },
    operator: "greater_than",
    value: 2,
  }] });
  const nonnumericEvents = [
    sample(1, "2026-08-20T00:00:01.000Z", "hwc-condition", "three"),
    sample(2, "2026-08-20T00:00:02.000Z", "hwc-trigger", false),
    sample(3, "2026-08-20T00:00:03.000Z", "hwc-trigger", true),
  ];
  const nonnumeric = evaluateHistoryReplay(nonnumericRevision, replayInput(nonnumericRevision, nonnumericEvents));
  assert.equal(nonnumeric.status, "unavailable");
  assert.deepEqual(nonnumeric.reasons, ["evaluator_unavailable"]);
  assert.equal(nonnumeric.matchedSampleCount, 3);

  const mismatched = evaluateHistoryReplay(
    { ...missingRevision, contentHash: digest("f") },
    replayInput(missingRevision, missingEvents),
  );
  assert.deepEqual(mismatched, {
    status: "unavailable",
    matchedSampleCount: 0,
    triggerCount: 0,
    actionCount: 0,
    reasons: ["evaluator_unavailable"],
  });

  const baseInput = replayInput(missingRevision, missingEvents);
  const { inputIdentity: _inputIdentity, ...inputDraft } = baseInput;
  const mismatchedProposalInput = createHistoryReplayInput({
    ...inputDraft,
    proposal: { ...inputDraft.proposal, id: "proposal-other" },
  });
  assert.deepEqual(evaluateHistoryReplay(missingRevision, mismatchedProposalInput), {
    status: "unavailable",
    matchedSampleCount: 0,
    triggerCount: 0,
    actionCount: 0,
    reasons: ["evaluator_unavailable"],
  });

  const { inputIdentity: _evaluatorIdentity, ...evaluatorDraft } = baseInput;
  const mismatchedEvaluatorInput = createHistoryReplayInput({
    ...evaluatorDraft,
    evaluator: { id: "another-evaluator", version: "9.0.0" },
  });
  assert.deepEqual(evaluateHistoryReplay(missingRevision, mismatchedEvaluatorInput), {
    status: "unavailable",
    matchedSampleCount: 0,
    triggerCount: 0,
    actionCount: 0,
    reasons: ["evaluator_unavailable"],
  });
});

test("does not borrow current time for schedule triggers", () => {
  const revision = artifact({
    trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "09:00" },
    conditions: [],
  });
  const events = [sample(1, "2026-08-20T00:00:01.000Z", "hwc-unrelated", true)];

  assert.deepEqual(evaluateHistoryReplay(revision, replayInput(revision, events)), {
    status: "unavailable",
    matchedSampleCount: 1,
    triggerCount: 0,
    actionCount: 0,
    reasons: ["evaluator_unavailable"],
  });
});

test("multiplies matching triggers by the bounded artifact action count", () => {
  const revision = artifact({
    conditions: [],
    actions: [
      { kind: "notify_local", message: "one" },
      { kind: "notify_local", message: "two" },
      { kind: "notify_local", message: "three" },
      { kind: "notify_local", message: "four" },
    ],
  });
  const events = Array.from({ length: 5 }, (_, index) => {
    const sourceTs = new Date(Date.parse("2026-08-20T00:00:00.000Z") + index * 1_000).toISOString();
    return sample(index + 1, sourceTs, "hwc-trigger", index === 0 ? false : index % 2 === 1);
  });

  const result = evaluateHistoryReplay(revision, replayInput(revision, events));

  assert.equal(result.status, "passed");
  assert.equal(result.triggerCount, 4);
  assert.equal(result.actionCount, 16);
  assert.ok(result.actionCount <= 200);
});
