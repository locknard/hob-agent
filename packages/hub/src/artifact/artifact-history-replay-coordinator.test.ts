import assert from "node:assert/strict";
import test from "node:test";

import {
  computeNeutralForeignCatalogIdentity,
  createArtifactCompileAttestation,
  createArtifactCompileInput,
  createNeutralConflictInput,
  createNeutralConflictResult,
  createNeutralDeviceSummary,
  createNeutralDiff,
  createNeutralDryRunAttestation,
  createNeutralWorldCut,
  type ArtifactCompileAttestation,
  type NeutralDryRunAttestation,
} from "./artifact-compiler-contract.js";
import {
  createArtifactAuthorityAssessment,
  createArtifactEvidenceAttestation,
  createArtifactRiskAssessment,
} from "./artifact-assessments.js";
import {
  createHistoryReplaySource,
  type HistoryReplaySource,
} from "./artifact-history-replay-source.js";
import {
  ArtifactHistoryReplayCoordinator,
  ArtifactHistoryReplayCoordinatorError,
  type ArtifactHistoryReplayCoordinatorOptions,
  type ArtifactHistoryReplayEntry,
} from "./artifact-history-replay-coordinator.js";
import {
  createHistoryReplayInput,
  type HistoryReplayEvaluation,
  type HistoryReplayResult,
} from "./artifact-history-replay-attestation.js";
import {
  createArtifactRevision,
  type ArtifactRef,
  type ArtifactRevision,
} from "./neutral-artifact.js";
import type { HubVerifiedProposalSource } from "./proposal-source-port.js";
import type {
  HomeWorldImportedHistoryReplayResult,
} from "../world/home-world-service.js";
import type { ArtifactAssessmentEntry, ArtifactRegistryEntry } from "./artifact-registry.js";

const AT = "2026-08-20T01:00:00.000Z";
const BRIDGE_ID = "bridge-history-coordinator-1";
const EPOCH_ID = "epoch-history-coordinator-1";
const CAPABILITY_ID = "hwc-history-coordinator-1";
const PROPOSAL_ID = "proposal-history-coordinator-1";
const ARTIFACT_ID = "artifact-history-coordinator-1";
const IMPORT_ID = "import-history-coordinator-1";
const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

const range = {
  since: "2026-08-19T23:00:00.000Z",
  until: "2026-08-20T00:00:00.000Z",
};

const importedReference = {
  bridgeId: BRIDGE_ID,
  hwId: "hw-history-coordinator-1",
  capabilityId: CAPABILITY_ID,
  observedAt: "2026-08-19T23:10:00.000Z",
  source: "imported-history" as const,
  origin: "imported" as const,
  importId: IMPORT_ID,
  historySeq: 1,
  sourceRange: range,
};

function artifact(): ArtifactRevision {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: ARTIFACT_ID,
    revision: 1,
    title: "Review a bounded history behavior",
    summary: "A neutral history replay coordinator fixture.",
    sourceProposal: { proposalId: PROPOSAL_ID, proposalRevision: 2 },
    content: {
      trigger: { kind: "capability_changed", source: { hwCapabilityId: CAPABILITY_ID } },
      conditions: [],
      actions: [{ kind: "notify_local", message: "Review the imported behavior." }],
      rollback: { kind: "no_remote_change" },
      postconditions: [],
    },
    createdAt: AT,
  });
}

function proposal(value: ArtifactRevision, overrides: Partial<HubVerifiedProposalSource> = {}): HubVerifiedProposalSource {
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
      description: "Review the imported behavior.",
      rollback: "No remote change.",
    },
    evidence: {
      references: [importedReference],
      watermarks: [{
        bridgeId: BRIDGE_ID,
        epochId: EPOCH_ID,
        lastSeq: 42,
        freshness: "fresh",
        gapCount: 0,
      }],
      importedHistory: {
        requestedSince: range.since,
        requestedUntil: range.until,
        truncated: false,
        coverage: [{ bridgeId: BRIDGE_ID, status: "partial", reasons: ["retention_floor_unknown"] }],
      },
    },
    conflictCheck: { status: "checked", existingAutomationCount: 0, matches: [] },
    risk: { level: "low", reasons: [], requiresHumanApproval: true },
    artifactCandidate: { schemaVersion: "1", content: value.content },
    ...overrides,
  };
}

function artifactRef(value: ArtifactRevision): ArtifactRef {
  return {
    artifactId: value.artifactId,
    revision: value.revision,
    contentHash: value.contentHash,
  };
}

function compilerFixtures(value: ArtifactRevision): {
  readonly compile: ArtifactCompileAttestation;
  readonly dryRun: NeutralDryRunAttestation;
} {
  const ref = artifactRef(value);
  const watermark = {
    bridgeId: BRIDGE_ID,
    epochId: EPOCH_ID,
    lastSeq: 42,
    lastSyncCompleteAt: "2026-08-20T00:59:00.000Z",
    freshness: "fresh" as const,
    gapCount: 0,
  };
  const evidence = createArtifactEvidenceAttestation({
    artifact: ref,
    attestationId: "evidence-history-coordinator-1",
    capturedAt: AT,
    source: "home-world-consistent-cut",
    sourceProposal: value.sourceProposal,
    proposalEvidenceIdentity: digest("b"),
    selectedHwCapabilityIds: [CAPABILITY_ID],
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  });
  const authority = createArtifactAuthorityAssessment({
    artifact: ref,
    assessmentId: "authority-history-coordinator-1",
    assessedAt: AT,
    authorityRegistryIdentity: digest("a"),
    candidates: [],
    checkedWatermarks: [watermark],
  }, { hwCapabilityIds: [] });
  const risk = createArtifactRiskAssessment({
    artifact: ref,
    assessmentId: "risk-history-coordinator-1",
    assessedAt: AT,
    evidence: { attestationId: evidence.attestationId, inputIdentity: evidence.inputIdentity },
    authority: { assessmentId: authority.assessmentId, inputIdentity: authority.inputIdentity },
    conflictInputIdentity: digest("c"),
    class: "observe_or_notify",
    reasons: ["Bounded history coordinator fixture."],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  });
  const conflict = createNeutralConflictResult({ status: "none", findings: [] });
  const foreignCheck = createNeutralConflictInput({
    bridgeId: BRIDGE_ID,
    epochId: EPOCH_ID,
    watermark,
    catalogIdentity: digest("f"),
    status: "current",
    findings: [],
  });
  const worldCut = createNeutralWorldCut({
    devices: [createNeutralDeviceSummary({
      hwCapabilityId: CAPABILITY_ID,
      schema: "neutral.switch",
      schemaVersion: "1.0.0",
      semanticKind: "switch",
      read: { status: "available", value: true },
      validity: "valid",
      actionCompatibility: [],
      predicateCompatibility: [],
    })],
    watermarks: [watermark],
  });
  const input = createArtifactCompileInput({
    artifact: value,
    proposal: { id: value.sourceProposal.proposalId, revision: value.sourceProposal.proposalRevision, status: "pending_review" },
    evidence,
    risk,
    authority,
    currentConflict: { sourceIdentity: risk.conflictInputIdentity, result: conflict },
    worldCut,
    foreignCatalogIdentity: computeNeutralForeignCatalogIdentity([foreignCheck]),
    foreignRuleChecks: [foreignCheck],
    compiler: { id: "history-coordinator-compiler", version: "1.0.0" },
  });
  const diff = createNeutralDiff({
    status: "changes",
    operations: [{ actionOrder: 1, kind: "notify_local", after: value.content.actions[0]!.message }],
    unchangedCount: 0,
    redacted: true,
  });
  const compile = createArtifactCompileAttestation({
    input,
    status: "compiled",
    plan: value.content,
    diff,
    conflicts: conflict,
    blockingReasons: [],
  });
  return {
    compile,
    dryRun: createNeutralDryRunAttestation({
      compile,
      status: "passed",
      diff,
      conflicts: conflict,
      summary: "Neutral dry-run passed; no writes were performed.",
    }),
  };
}

function replayWorldResult(source: HistoryReplaySource, overrides: Partial<HomeWorldImportedHistoryReplayResult> = {}): HomeWorldImportedHistoryReplayResult {
  return {
    requestedSince: source.requestedWindow.requestedSince,
    requestedUntil: source.requestedWindow.requestedUntil,
    references: source.expectedReferences,
    samples: source.expectedReferences.map((reference) => ({
      bridgeId: reference.bridgeId,
      importId: reference.importId,
      historySeq: reference.historySeq,
      sourceTs: reference.observedAt,
      sourceTsQuality: "platform" as const,
      value: "on",
    })),
    coverage: source.coverage,
    truncated: source.truncated,
    ...overrides,
  };
}

function assessmentEntry(result: HistoryReplayResult): ArtifactAssessmentEntry {
  return {
    kind: "history-replay-attestation",
    recordId: result.resultId,
    artifact: result.artifact,
    inputIdentity: result.inputIdentity,
    recordedAt: AT,
    assessment: result,
    audit: [],
  };
}

function setup(overrides: Partial<{
  readonly proposal: HubVerifiedProposalSource;
  readonly world: (source: HistoryReplaySource) => HomeWorldImportedHistoryReplayResult;
  readonly evaluation: HistoryReplayEvaluation;
  readonly evaluator: (artifact: ArtifactRevision, input: unknown) => HistoryReplayEvaluation;
  readonly record: (result: HistoryReplayResult, idempotencyKey: string) => ArtifactAssessmentEntry;
}> = {}) {
  const value = artifact();
  const compiled = compilerFixtures(value);
  const source = createHistoryReplaySource(overrides.proposal ?? proposal(value), value);
  const order: string[] = [];
  const worldQueries: unknown[] = [];
  let writes = 0;
  const options: ArtifactHistoryReplayCoordinatorOptions = {
    proposals: {
      withApprovedProposalAtRevision: (_proposalId, _revision, operation) => {
        order.push("proposal");
        return operation(overrides.proposal ?? proposal(value));
      },
    },
    world: {
      queryImportedHistoryForReplay: (query, window, expectedReferences) => {
        order.push("world");
        worldQueries.push({ query, window, expectedReferences });
        return overrides.world?.(source) ?? replayWorldResult(source);
      },
    },
    registry: {
      getRevision: (_artifactId, _revision) => {
        order.push("artifact");
        return { artifact: value, status: "draft", tombstone: false, audit: [] } satisfies ArtifactRegistryEntry;
      },
      recordHistoryReplayAttestation: ({ assessment, idempotencyKey }) => {
        order.push("record");
        writes += 1;
        return overrides.record?.(assessment, idempotencyKey) ?? assessmentEntry(assessment);
      },
    },
    evaluator: {
      id: "neutral-history-replay",
      version: "1.0.0",
      evaluate: (artifactValue, input) => {
        order.push("evaluator");
        const custom = overrides.evaluator?.(artifactValue, input);
        if (custom !== undefined) return custom;
        if (overrides.evaluation !== undefined) return overrides.evaluation;
        return ((input as { readonly samples?: readonly unknown[] }).samples?.length ?? 0) > 0
          ? { status: "passed", matchedSampleCount: 1, triggerCount: 1, actionCount: 1, reasons: [] }
          : { status: "unavailable", matchedSampleCount: 0, triggerCount: 0, actionCount: 0, reasons: ["history_unavailable"] };
      },
    },
  };
  return {
    value,
    compiled,
    source,
    order,
    worldQueries,
    get writes() { return writes; },
    coordinator: new ArtifactHistoryReplayCoordinator(options),
  };
}

function request(env: ReturnType<typeof setup>) {
  return {
    artifact: artifactRef(env.value),
    compile: env.compiled.compile,
    dryRun: env.compiled.dryRun,
  };
}

test("sequences exact artifact/proposal/world/evaluator/registry seams and returns a frozen summary without samples", () => {
  const env = setup();
  const receipt = env.coordinator.replay(request(env));

  assert.deepEqual(env.order, ["artifact", "proposal", "world", "evaluator", "record"]);
  assert.equal(receipt.result.status, "passed");
  assert.equal(receipt.result.coverage, "partial");
  assert.equal(receipt.result.writesPerformed, false);
  assert.equal("samples" in receipt, false);
  assert.equal("samples" in receipt.result, false);
  assert.deepEqual(receipt.entry, {
    kind: "history-replay-attestation",
    recordId: receipt.result.resultId,
    artifact: artifactRef(env.value),
    inputIdentity: receipt.result.inputIdentity,
    recordedAt: AT,
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.result), true);
  assert.equal(Object.isFrozen(receipt.entry), true);
  assert.equal(Object.isFrozen(receipt.entry.artifact), true);
  assert.deepEqual(env.worldQueries[0], {
    query: env.source.query,
    window: env.source.requestedWindow,
    expectedReferences: env.source.expectedReferences,
  });
});

test("persists deterministic failed and unavailable replay outcomes with conservative merged coverage", () => {
  const failed = setup({
    evaluation: {
      status: "failed",
      matchedSampleCount: 1,
      triggerCount: 0,
      actionCount: 0,
      reasons: ["replay_mismatch"],
    },
    world: (source) => replayWorldResult(source, {
      coverage: [{ bridgeId: BRIDGE_ID, status: "partial", reasons: ["query_truncated"] }],
      truncated: true,
    }),
  });
  const failedReceipt = failed.coordinator.replay(request(failed));
  assert.equal(failedReceipt.result.status, "unavailable");
  assert.equal(failedReceipt.result.coverage, "unavailable");
  assert.deepEqual(failedReceipt.result.reasons, ["query_truncated", "replay_mismatch", "retention_floor_unknown"]);
  assert.equal(failedReceipt.result.truncated, true);

  const unavailable = setup({
    world: (source) => replayWorldResult(source, {
      references: [],
      samples: [],
      coverage: [{ bridgeId: BRIDGE_ID, status: "unavailable", reasons: ["history_unavailable"] }],
    }),
  });
  const unavailableReceipt = unavailable.coordinator.replay(request(unavailable));
  assert.equal(unavailableReceipt.result.status, "unavailable");
  assert.equal(unavailableReceipt.result.coverage, "unavailable");
  assert.deepEqual(unavailableReceipt.result.reasons, ["history_unavailable", "retention_floor_unknown"]);
  assert.equal(unavailableReceipt.result.counts.referenceCount, 0);
  assert.equal(unavailableReceipt.result.counts.sampleCount, 0);
});

test("keeps missing imported source unavailable, and fails closed for identity drift or World failure", () => {
  const noImported = setup({
    proposal: proposal(artifact(), {
      evidence: {
        references: [{
          bridgeId: BRIDGE_ID,
          hwId: "hw-history-coordinator-1",
          capabilityId: CAPABILITY_ID,
          observedAt: importedReference.observedAt,
          source: "current-state",
        }],
        watermarks: [{
          bridgeId: BRIDGE_ID,
          epochId: EPOCH_ID,
          lastSeq: 42,
          freshness: "fresh",
          gapCount: 0,
        }],
        importedHistory: {
          requestedSince: range.since,
          requestedUntil: range.until,
          truncated: false,
          coverage: [{ bridgeId: BRIDGE_ID, status: "partial", reasons: ["retention_floor_unknown"] }],
        },
      },
    }),
  });
  const noImportedReceipt = noImported.coordinator.replay(request(noImported));
  assert.equal(noImportedReceipt.result.status, "unavailable");
  assert.equal(noImportedReceipt.result.counts.referenceCount, 0);
  assert.equal(noImportedReceipt.result.counts.sampleCount, 0);
  assert.equal(noImported.writes, 1);

  const drift = setup();
  assert.throws(
    () => drift.coordinator.replay({ ...request(drift), artifact: { ...request(drift).artifact, revision: 2 } }),
    (error: unknown) => error instanceof ArtifactHistoryReplayCoordinatorError,
  );
  assert.equal(drift.writes, 0);

  const worldFailure = setup({ world: () => { throw new Error("provider-shaped failure"); } });
  assert.throws(
    () => worldFailure.coordinator.replay(request(worldFailure)),
    (error: unknown) => error instanceof ArtifactHistoryReplayCoordinatorError,
  );
  assert.equal(worldFailure.writes, 0);

  const worldIdentityDrift = setup({
    world: (source) => replayWorldResult(source, {
      references: source.expectedReferences.map((reference) => ({
        ...reference,
        observedAt: "2026-08-19T23:11:00.000Z",
      })),
    }),
  });
  assert.throws(
    () => worldIdentityDrift.coordinator.replay(request(worldIdentityDrift)),
    (error: unknown) => error instanceof ArtifactHistoryReplayCoordinatorError,
  );
  assert.equal(worldIdentityDrift.writes, 0);
});

test("uses one stable history-replay input identity for registry idempotency", () => {
  const keys: string[] = [];
  const env = setup({
    record: (result, idempotencyKey) => {
      keys.push(idempotencyKey);
      return assessmentEntry(result);
    },
  });
  const first = env.coordinator.replay(request(env));
  const second = env.coordinator.replay(request(env));
  assert.equal(keys.length, 2);
  assert.equal(keys[0], `history-replay-${first.result.inputIdentity}`);
  assert.equal(keys[1], keys[0]);
  assert.equal(first.result.resultId, second.result.resultId);
  assert.equal(env.writes, 2);
});
