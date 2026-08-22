import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { ArtifactRegistry } from "./artifact-registry.js";
import { AuthorityCandidateRegistry } from "../authority/authority-candidate-registry.js";
import { createArtifactPipelineComposition } from "./artifact-pipeline-composition.js";
import {
  SqliteProposalStore,
  type CreateProposalInput,
} from "../proposal-store.js";
import type {
  HomeWorldBridgeSnapshot,
  HomeWorldEvidenceResult,
  HomeWorldSnapshot,
} from "../home-world-service.js";
import type { ArtifactContent } from "./neutral-artifact.js";

const capturedAt = "2026-08-20T01:00:00.000Z";
const bridgeId = "bridge-pipeline-fixture";
const epochId = "epoch-pipeline-fixture";

function notifyContent(): ArtifactContent {
  return {
    trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "08:00" },
    conditions: [],
    actions: [{ kind: "notify_local", message: "Review the household note." }],
    rollback: { kind: "no_remote_change" },
    postconditions: [],
  };
}

function approvedProposal(): {
  readonly proposals: SqliteProposalStore;
  readonly proposalId: string;
  readonly proposalRevision: number;
} {
  let id = 0;
  const proposals = new SqliteProposalStore({
    path: ":memory:",
    now: () => capturedAt,
    id: () => `proposal-pipeline-fixture-${++id}`,
  });
  const pending = proposals.create({
    kind: "automation-draft",
    title: "Review the household note",
    summary: "Send one local review notification without a remote change.",
    idempotencyKey: "pipeline-proposal",
    provenance: { producer: "pipeline-fixture" },
    evidence: {
      references: [],
      watermarks: [{
        bridgeId,
        epochId,
        lastSeq: 42,
        freshness: "fresh",
        gapCount: 0,
      }],
    },
    conflictCheck: { status: "checked", existingAutomationCount: 0, matches: [] },
    dryRun: { status: "not_run", summary: "No automation artifact exists yet." },
    risk: { level: "low", reasons: [], requiresHumanApproval: true },
    intent: {
      type: "notify_local",
      description: "Send a local review note.",
      rollback: "No remote change exists.",
    },
    artifactCandidate: { schemaVersion: "1", content: notifyContent() },
  });
  const approved = proposals.review({
    proposalId: pending.id,
    expectedRevision: pending.revision,
    decision: "approved",
    reviewer: "household-fixture",
    feedbackCode: "useful_as_is",
  });
  return {
    proposals,
    proposalId: approved.id,
    proposalRevision: approved.revision,
  };
}

function bridgeSnapshot(): HomeWorldBridgeSnapshot {
  return {
    bridgeId,
    adapterType: "fixture",
    diagnostics: {
      connectionState: "ready",
      droppedInvalidCount: 0,
      strippedFieldsCount: 0,
      staleEpochDropCount: 0,
      foldedStateCount: 0,
      unsupportedSchemaCount: 0,
      protocolViolationCount: 0,
      historyGapCount: 0,
      recentHistoryGaps: [],
      lastSyncCompleteAt: capturedAt,
    },
    watermark: { bridgeId, epochId, lastSeq: 42, lastSyncCompleteAt: capturedAt },
    devices: [],
    extensions: {},
    metrics: { consistency: "ready", eventActivity: "idle", connection: "up" },
  };
}

function homeWorldFixture() {
  const bridge = bridgeSnapshot();
  const snapshot: HomeWorldSnapshot = {
    generatedAt: capturedAt,
    bridges: { [bridgeId]: bridge },
    watermarkVector: { [bridgeId]: bridge.watermark },
    bridgeWatermarks: [bridge.watermark!],
    watermarks: [bridge.watermark!],
    diagnostics: [{ bridgeId, connectionState: "ready", lastSyncCompleteAt: capturedAt }],
    metrics: {
      consistency: [{ bridgeId, state: "ready", lastSyncCompleteAt: capturedAt }],
      eventActivity: [{ bridgeId }],
      connectionActivity: [{ bridgeId, state: "ready" }],
    },
    spaces: [],
    devices: [],
  };
  const calls = { control: 0, credentials: 0 };
  const homeWorld = {
    snapshot: () => snapshot,
    queryRecentEvidence: (): HomeWorldEvidenceResult => ({
      requestedSince: capturedAt,
      requestedUntil: capturedAt,
      events: [],
      coverage: [{
        bridgeId,
        epochId,
        baselineSeq: 42,
        baselineAt: capturedAt,
        status: "complete",
        reasons: [],
      }],
      truncated: false,
    }),
    foreignRuleCatalog: async () => [{
      bridgeId,
      status: "available" as const,
      epochId,
      lastSeq: 42,
      rules: [],
    }],
    // Deliberately untyped forbidden surfaces: preparation must not discover
    // or invoke ecosystem control/credential capabilities from this fixture.
    control: () => {
      calls.control += 1;
      throw new Error("bridge control must not be reached");
    },
    credentials: {
      resolve: () => {
        calls.credentials += 1;
        throw new Error("bridge credentials must not be resolved");
      },
    },
  };
  return { homeWorld, calls };
}

test("keeps the preparation writer private while its shared Registry is readable after notify-only approval", async () => {
  const proposal = approvedProposal();
  const artifacts = new ArtifactRegistry({ path: ":memory:", now: () => capturedAt });
  const authorityCandidates = new AuthorityCandidateRegistry({ path: ":memory:", now: () => capturedAt });
  const context = new Context();
  const world = homeWorldFixture();

  // This is the RED contract for the future root-private composition. The
  // factory is intentionally not present yet; production wiring must compose
  // the real Artifact producers/coordinators around these narrow seams.
  const composition = await createArtifactPipelineComposition({
    context,
    proposals: proposal.proposals,
    homeWorld: world.homeWorld,
    artifacts,
    authorityCandidates,
    now: () => capturedAt,
  });

  try {
    const receipt = await composition.prepare({
      proposalId: proposal.proposalId,
      proposalRevision: proposal.proposalRevision,
    });

    assert.equal(receipt.compilation.dryRun.writesPerformed, false);
    assert.equal(artifacts.list({ limit: 20 }).length, 1);
    assert.equal(authorityCandidates.audit().length, 0);

    const review = context.homeArtifacts.reviewForProposal(
      proposal.proposalId,
      proposal.proposalRevision,
    );
    assert.equal(review?.compile.status, "compiled");
    assert.equal(review?.dryRun.status, "passed");
    assert.equal(review?.writesPerformed, false);
    assert.equal(review?.dryRun.writesPerformed, false);

    for (const forbidden of [
      "homePreparation",
      "homePreparationPipeline",
      "homePreparationJobs",
      "homeArtifactRegistry",
      "artifactRegistry",
      "homeAuthorityCandidates",
      "authorityCandidates",
      "authorityCandidateRegistry",
    ]) {
      assert.equal(forbidden in context, false, forbidden);
    }
    assert.equal(world.calls.control, 0);
    assert.equal(world.calls.credentials, 0);
  } finally {
    await composition.stop();
    await context.fiber.dispose();
    authorityCandidates.close();
    artifacts.close();
    proposal.proposals.close();
  }
});
