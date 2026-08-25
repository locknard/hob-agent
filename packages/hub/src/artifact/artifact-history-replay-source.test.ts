import assert from "node:assert/strict";
import test from "node:test";

import { computeProposalEvidenceIdentity } from "./artifact-assessments.js";
import {
  createHistoryReplaySource,
  HistoryReplaySourceError,
  type HistoryReplaySource,
} from "./artifact-history-replay-source.js";
import { createArtifactRevision, type ArtifactRevision } from "./neutral-artifact.js";
import type { HubVerifiedProposalSource } from "./proposal-source-port.js";

const range = {
  since: "2026-08-20T00:00:00.000Z",
  until: "2026-08-21T00:00:00.000Z",
};

const importedReference = {
  bridgeId: "bridge-history-source-a",
  hwId: "hw-history-source-trigger",
  capabilityId: "hwc-history-source-trigger",
  observedAt: "2026-08-20T04:00:00.000Z",
  source: "imported-history" as const,
  origin: "imported" as const,
  importId: "import-history-source-a",
  historySeq: 7,
  sourceRange: range,
};

const fallbackReference = {
  bridgeId: "bridge-history-source-b",
  hwId: "hw-history-source-target",
  capabilityId: "hwc-history-source-target",
  observedAt: "2026-08-20T04:05:00.000Z",
  source: "current-state" as const,
};

const candidateContent: ArtifactRevision["content"] = {
  trigger: {
    kind: "capability_changed",
    source: { hwCapabilityId: "hwc-history-source-trigger" },
  },
  conditions: [{
    kind: "capability_value",
    source: { hwCapabilityId: "hwc-history-source-target" },
    operator: "equals",
    value: false,
  }],
  actions: [{
    kind: "set_boolean",
    target: { hwCapabilityId: "hwc-history-source-target" },
    value: true,
  }],
  rollback: {
    kind: "restore_previous_state",
    target: { hwCapabilityId: "hwc-history-source-target" },
    maxAgeSeconds: 900,
  },
  postconditions: [{
    kind: "capability_value",
    source: { hwCapabilityId: "hwc-history-source-target" },
    operator: "equals",
    value: true,
    withinSeconds: 30,
  }],
};

function artifact(): ArtifactRevision {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: "artifact-history-source-1",
    revision: 3,
    title: "Review a bounded history behavior",
    summary: "A neutral history replay source fixture.",
    sourceProposal: {
      proposalId: "proposal-history-source-1",
      proposalRevision: 4,
    },
    content: candidateContent,
    createdAt: "2026-08-20T00:00:00.000Z",
  });
}

function source(value: ArtifactRevision): HubVerifiedProposalSource {
  return {
    proposalId: value.sourceProposal.proposalId,
    revision: value.sourceProposal.proposalRevision,
    kind: "automation-draft",
    status: "pending_review",
    applicationStatus: "not_available",
    title: value.title,
    summary: value.summary,
    intent: {
      type: "automation-draft",
      description: "Review the bounded behavior.",
      rollback: "Restore the previous value.",
    },
    evidence: {
      references: [importedReference, fallbackReference],
      watermarks: [{
        bridgeId: "bridge-history-source-a",
        epochId: "epoch-history-source-a",
        lastSeq: 10,
        freshness: "fresh",
        gapCount: 0,
      }],
      importedHistory: {
        requestedSince: range.since,
        requestedUntil: range.until,
        truncated: false,
        coverage: [
          {
            bridgeId: "bridge-history-source-a",
            status: "partial",
            reasons: ["retention_floor_unknown"],
          },
          {
            bridgeId: "bridge-history-source-b",
            status: "unavailable",
            reasons: ["empty_or_purged"],
          },
        ],
      },
    },
    conflictCheck: {
      status: "checked",
      existingAutomationCount: 0,
      matches: [],
    },
    risk: {
      level: "low",
      reasons: [],
      requiresHumanApproval: true,
    },
    artifactCandidate: {
      schemaVersion: "1",
      content: value.content,
    },
  };
}

test("creates a bounded replay source from exact imported and current-state evidence", () => {
  const revision = artifact();
  const proposal = source(revision);
  const result = createHistoryReplaySource(proposal, revision);

  const expected: HistoryReplaySource = {
    artifact: {
      artifactId: revision.artifactId,
      revision: revision.revision,
      contentHash: revision.contentHash,
    },
    proposal: {
      id: proposal.proposalId,
      revision: proposal.revision,
      proposalEvidenceIdentity: computeProposalEvidenceIdentity(proposal.evidence),
    },
    query: {
      hwCapabilityIds: [
        "hwc-history-source-target",
        "hwc-history-source-trigger",
      ],
      lookbackHours: 24,
      limit: 50,
    },
    requestedWindow: {
      requestedSince: range.since,
      requestedUntil: range.until,
    },
    expectedReferences: [importedReference],
    fallbackReferences: [fallbackReference],
    coverage: [
      {
        bridgeId: "bridge-history-source-a",
        status: "partial",
        reasons: ["retention_floor_unknown"],
      },
      {
        bridgeId: "bridge-history-source-b",
        status: "unavailable",
        reasons: ["empty_or_purged"],
      },
    ],
    truncated: false,
  };

  assert.deepEqual(result, expected);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.query), true);
  assert.equal(Object.isFrozen(result.expectedReferences), true);
  assert.equal("content" in result, false);
  assert.equal("value" in result, false);
});

test("rejects proposal, candidate, temporal, legacy, and unknown evidence identities", () => {
  const revision = artifact();
  const valid = source(revision);

  assert.throws(
    () => createHistoryReplaySource({ ...valid, proposalId: "proposal-other" }, revision),
    (error: unknown) => error instanceof HistoryReplaySourceError && error.code === "invalid_source",
  );
  assert.throws(
    () => createHistoryReplaySource({
      ...valid,
      artifactCandidate: { ...valid.artifactCandidate, content: { ...candidateContent, conditions: [] } },
    }, revision),
    HistoryReplaySourceError,
  );
  assert.throws(
    () => createHistoryReplaySource({
      ...valid,
      evidence: { ...valid.evidence, temporal: {} },
    }, revision),
    HistoryReplaySourceError,
  );
  assert.throws(
    () => createHistoryReplaySource({
      ...valid,
      evidence: {
        ...valid.evidence,
        references: [{
          bridgeId: "bridge-history-source-a",
          observedAt: importedReference.observedAt,
        }],
      },
    }, revision),
    HistoryReplaySourceError,
  );
  assert.throws(
    () => createHistoryReplaySource({
      ...valid,
      evidence: { ...valid.evidence, unsupported: true },
    }, revision),
    HistoryReplaySourceError,
  );
});

test("derives every capability reference and rejects missing evidence or unrelated coverage", () => {
  const revision = artifact();
  const valid = source(revision);
  const missingTarget = {
    ...valid,
    evidence: {
      ...valid.evidence,
      references: [importedReference],
    },
  };
  assert.throws(() => createHistoryReplaySource(missingTarget, revision), HistoryReplaySourceError);

  const unrelatedCoverage = {
    ...valid,
    evidence: {
      ...valid.evidence,
      importedHistory: {
        ...valid.evidence.importedHistory!,
        coverage: [
          ...valid.evidence.importedHistory!.coverage,
          {
            bridgeId: "bridge-unrelated",
            status: "partial" as const,
            reasons: ["retention_floor_unknown" as const],
          },
        ],
      },
    },
  };
  const result = createHistoryReplaySource(unrelatedCoverage, revision);
  assert.deepEqual(result.coverage.map((item) => item.bridgeId), [
    "bridge-history-source-a",
    "bridge-history-source-b",
  ]);
  assert.deepEqual(result.expectedReferences, [importedReference]);
});

test("derives query scope from trigger, conditions, device target, rollback, and postconditions", () => {
  const original = artifact();
  const { contentHash: _contentHash, ...artifactInput } = original;
  const revision = createArtifactRevision({
    ...artifactInput,
    content: {
      ...candidateContent,
      conditions: [{
        kind: "capability_value",
        source: { hwCapabilityId: "hwc-history-source-condition" },
        operator: "equals",
        value: false,
      }],
    },
  });
  const base = source(revision);
  const conditionReference = {
    ...importedReference,
    hwId: "hw-history-source-condition",
    capabilityId: "hwc-history-source-condition",
    importId: "import-history-source-condition",
    historySeq: 8,
  };
  const result = createHistoryReplaySource({
    ...base,
    evidence: {
      ...base.evidence,
      references: [importedReference, conditionReference, fallbackReference],
    },
  }, revision);

  assert.deepEqual(result.query.hwCapabilityIds, [
    "hwc-history-source-condition",
    "hwc-history-source-target",
    "hwc-history-source-trigger",
  ]);
  assert.deepEqual(result.expectedReferences, [conditionReference, importedReference]);
});

test("keeps an empty imported set honest when current-state fallback covers the artifact", () => {
  const revision = artifact();
  const valid = source(revision);
  const emptyImported = {
    ...valid,
    evidence: {
      ...valid.evidence,
      references: [
        {
          ...fallbackReference,
          capabilityId: "hwc-history-source-trigger",
          hwId: "hw-history-source-trigger",
        },
        fallbackReference,
      ],
      importedHistory: {
        ...valid.evidence.importedHistory!,
        coverage: [{
          bridgeId: "bridge-history-source-b",
          status: "unavailable" as const,
          reasons: ["empty_or_purged" as const],
        }],
      },
    },
  };

  const result = createHistoryReplaySource(emptyImported, revision);
  assert.deepEqual(result.expectedReferences, []);
  assert.deepEqual(result.fallbackReferences.map((item) => item.capabilityId), [
    "hwc-history-source-target",
    "hwc-history-source-trigger",
  ]);
  assert.deepEqual(result.coverage, [{
    bridgeId: "bridge-history-source-b",
    status: "unavailable",
    reasons: ["empty_or_purged"],
  }]);
});

test("rejects invalid windows, duplicate evidence, missing coverage, and non-unique reasons", () => {
  const revision = artifact();
  const valid = source(revision);

  for (const window of [
    { requestedSince: "2026-08-20T00:00:00.000Z", requestedUntil: "2026-08-20T00:30:00.000Z" },
    { requestedSince: "2026-08-20T00:00:00.000Z", requestedUntil: "2026-08-28T01:00:00.000Z" },
    { requestedSince: "2026-08-21T00:00:00.000Z", requestedUntil: "2026-08-20T00:00:00.000Z" },
  ]) {
    assert.throws(() => createHistoryReplaySource({
      ...valid,
      evidence: { ...valid.evidence, importedHistory: { ...valid.evidence.importedHistory!, ...window } },
    }, revision), HistoryReplaySourceError);
  }

  assert.throws(() => createHistoryReplaySource({
    ...valid,
    evidence: {
      ...valid.evidence,
      references: [importedReference, importedReference],
    },
  }, revision), HistoryReplaySourceError);
  assert.throws(() => createHistoryReplaySource({
    ...valid,
    evidence: {
      ...valid.evidence,
      references: [{
        ...importedReference,
        observedAt: "2026-08-21T00:00:00.000Z",
      }],
    },
  }, revision), HistoryReplaySourceError);
  assert.throws(() => createHistoryReplaySource({
    ...valid,
    evidence: {
      ...valid.evidence,
      importedHistory: {
        ...valid.evidence.importedHistory!,
        coverage: [{
          bridgeId: "bridge-history-source-a",
          status: "partial" as const,
          reasons: ["retention_floor_unknown" as const, "retention_floor_unknown" as const],
        }],
      },
    },
  }, revision), HistoryReplaySourceError);
  assert.throws(() => createHistoryReplaySource({
    ...valid,
    evidence: {
      ...valid.evidence,
      importedHistory: {
        ...valid.evidence.importedHistory!,
        coverage: [{
          bridgeId: "bridge-history-source-a",
          status: "partial" as const,
          reasons: ["retention_floor_unknown" as const],
        }],
      },
    },
  }, revision), HistoryReplaySourceError);
  assert.throws(() => createHistoryReplaySource({
    ...valid,
    evidence: {
      ...valid.evidence,
      importedHistory: {
        ...valid.evidence.importedHistory!,
        coverage: [
          {
            bridgeId: "bridge-history-source-a",
            status: "unavailable" as const,
            reasons: ["history_unavailable" as const],
          },
          {
            bridgeId: "bridge-history-source-b",
            status: "unavailable" as const,
            reasons: ["empty_or_purged" as const],
          },
        ],
      },
    },
  }, revision), HistoryReplaySourceError);
});
