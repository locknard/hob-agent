import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { ArtifactRegistry } from "./artifact-registry.js";
import { ArtifactPreparationServiceError } from "./artifact-preparation-service.js";
import { AuthorityCandidateRegistry } from "../authority/authority-candidate-registry.js";
import { HomeArtifactService } from "../home/home-artifact-service.js";
import { createArtifactPipelineComposition } from "./artifact-pipeline-composition.js";
import {
  SqliteProposalStore,
  type CreateProposalInput,
} from "../home/proposal-store.js";
import type {
  HomeWorldBridgeSnapshot,
  HomeWorldEvidenceResult,
  HomeWorldImportedHistoryReplayResult,
  HomeWorldSnapshot,
} from "../world/home-world-service.js";
import type { ArtifactContent } from "./neutral-artifact.js";

const capturedAt = "2026-08-20T01:00:00.000Z";
const bridgeId = "bridge-pipeline-fixture";
const epochId = "epoch-pipeline-fixture";
const historyCapabilityId = "hwc-pipeline-history";
const historyHwId = "hw-pipeline-history";
const historyImportId = "import-pipeline-history";
const historyRange = {
  since: "2026-08-19T23:00:00.000Z",
  until: "2026-08-20T00:00:00.000Z",
};

const historyReference = {
  bridgeId,
  hwId: historyHwId,
  capabilityId: historyCapabilityId,
  observedAt: "2026-08-19T23:10:00.000Z",
  source: "imported-history" as const,
  origin: "imported" as const,
  importId: historyImportId,
  historySeq: 1,
  sourceRange: historyRange,
};

function notifyContent(): ArtifactContent {
  return {
    trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "08:00" },
    conditions: [],
    actions: [{ kind: "notify_local", message: "Review the household note." }],
    rollback: { kind: "no_remote_change" },
    postconditions: [],
  };
}

function historyContent(): ArtifactContent {
  return {
    trigger: { kind: "capability_changed", source: { hwCapabilityId: historyCapabilityId } },
    conditions: [],
    actions: [{ kind: "notify_local", message: "Review the imported behavior." }],
    rollback: { kind: "no_remote_change" },
    postconditions: [],
  };
}

function approvedProposal(options: { readonly importedHistory?: boolean } = {}): {
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
      references: options.importedHistory === true ? [historyReference] : [],
      watermarks: [{
        bridgeId,
        epochId,
        lastSeq: 42,
        freshness: "fresh",
        gapCount: 0,
      }],
      ...(options.importedHistory === true ? {
        importedHistory: {
          requestedSince: historyRange.since,
          requestedUntil: historyRange.until,
          truncated: false,
          coverage: [{ bridgeId, status: "partial" as const, reasons: ["retention_floor_unknown" as const] }],
        },
      } : {}),
    },
    conflictCheck: { status: "checked", existingAutomationCount: 0, matches: [] },
    dryRun: { status: "not_run", summary: "No automation artifact exists yet." },
    risk: { level: "low", reasons: [], requiresHumanApproval: true },
    intent: {
      type: "notify_local",
      description: "Send a local review note.",
      rollback: "No remote change exists.",
    },
    artifactCandidate: {
      schemaVersion: "1",
      content: options.importedHistory === true ? historyContent() : notifyContent(),
    },
  });
  return {
    proposals,
    proposalId: pending.id,
    proposalRevision: pending.revision,
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

function homeWorldFixture(options: {
  readonly importedHistory?: boolean;
  readonly replayUnavailable?: boolean;
  readonly replayThrows?: boolean;
  readonly replayObserver?: () => void;
} = {}) {
  const bridge = bridgeSnapshot();
  const historyBinding = {
    bridgeId,
    nativeId: "native-pipeline-history",
    nativeInstanceId: "instance-pipeline-history",
  };
  const historyCapability = {
    hwCapabilityId: historyCapabilityId,
    hwId: historyHwId,
    schema: "ha.entity",
    schemaVersion: "1.0.0",
    semanticKind: "switch" as const,
    bindings: [historyBinding],
  };
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
    devices: options.importedHistory === true ? [{
      bridgeId,
      hwId: historyHwId,
      nativeId: historyBinding.nativeId,
      bindings: [historyBinding],
      capabilities: [historyCapability],
      descriptor: {
        nativeId: historyBinding.nativeId,
        capabilities: [{
          nativeInstanceId: historyBinding.nativeInstanceId,
          schema: historyCapability.schema,
          schemaVersion: historyCapability.schemaVersion,
          semanticKind: historyCapability.semanticKind,
        }],
      },
      states: [{
        nativeId: historyBinding.nativeId,
        nativeInstanceId: historyBinding.nativeInstanceId,
        attrs: { state: "on" },
        time: { sourceTsQuality: "platform" },
        origin: "observed" as const,
      }],
      validity: "valid" as const,
    }] : [],
  };
  const calls = { control: 0, credentials: 0, replay: 0 };
  const homeWorld = {
    snapshot: () => snapshot,
    queryRecentEvidence: (): HomeWorldEvidenceResult => ({
      requestedSince: capturedAt,
      requestedUntil: capturedAt,
      events: options.importedHistory === true ? [{
        hwId: historyHwId,
        hwCapabilityId: historyCapabilityId,
        value: "on",
        observedAt: capturedAt,
        sourceTs: capturedAt,
        sourceTsQuality: "platform" as const,
        origin: "observed" as const,
        provenance: { bridgeId, epochId, seq: 42 },
      }] : [],
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
    queryImportedHistoryForReplay: (
      _input: unknown,
      importedWindow: { readonly requestedSince: string; readonly requestedUntil: string },
      expectedReferences: readonly typeof historyReference[],
    ): HomeWorldImportedHistoryReplayResult => {
      calls.replay += 1;
      options.replayObserver?.();
      if (options.replayThrows === true) throw new Error("history replay unavailable");
      if (options.replayUnavailable === true) {
        return {
          requestedSince: importedWindow.requestedSince,
          requestedUntil: importedWindow.requestedUntil,
          references: [],
          samples: [],
          coverage: [{ bridgeId, status: "unavailable", reasons: ["history_unavailable"] }],
          truncated: false,
        };
      }
      return {
        requestedSince: importedWindow.requestedSince,
        requestedUntil: importedWindow.requestedUntil,
        references: expectedReferences,
        samples: expectedReferences.map((reference) => ({
          bridgeId: reference.bridgeId,
          importId: reference.importId,
          historySeq: reference.historySeq,
          sourceTs: reference.observedAt,
          sourceTsQuality: "platform" as const,
          value: true,
        })),
        coverage: [{ bridgeId, status: "partial", reasons: ["retention_floor_unknown"] }],
        truncated: false,
      };
    },
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

test("keeps the preparation writer private while the root-mounted Registry reader stays available", async () => {
  const proposal = approvedProposal();
  const artifacts = new ArtifactRegistry({ path: ":memory:", now: () => capturedAt });
  const authorityCandidates = new AuthorityCandidateRegistry({ path: ":memory:", now: () => capturedAt });
  const context = new Context();
  const world = homeWorldFixture();

  await context.plugin(HomeArtifactService, { registry: artifacts });

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
    assert.equal(world.calls.replay, 0);
  } finally {
    await composition.stop();
    await context.fiber.dispose();
    authorityCandidates.close();
    artifacts.close();
    proposal.proposals.close();
  }
});

test("runs imported history replay after compiler results and persists its independent assessment", async () => {
  const proposal = approvedProposal({ importedHistory: true });
  const artifacts = new ArtifactRegistry({ path: ":memory:", now: () => capturedAt });
  const authorityCandidates = new AuthorityCandidateRegistry({ path: ":memory:", now: () => capturedAt });
  const context = new Context();
  const replayOrder: string[] = [];
  const world = homeWorldFixture({
    importedHistory: true,
    replayObserver: () => {
      const draft = artifacts.list({ limit: 1 })[0]!.artifact;
      const ref = { artifactId: draft.artifactId, revision: draft.revision, contentHash: draft.contentHash };
      replayOrder.push(artifacts.listResults({ artifact: ref, limit: 20 }).length === 2
        ? "after-compiler"
        : "before-compiler");
    },
  });
  await context.plugin(HomeArtifactService, { registry: artifacts });
  const composition = await createArtifactPipelineComposition({
    context,
    proposals: proposal.proposals,
    homeWorld: world.homeWorld,
    artifacts,
    authorityCandidates,
    now: () => capturedAt,
  });

  try {
    await composition.prepare({ proposalId: proposal.proposalId, proposalRevision: proposal.proposalRevision });
    assert.equal(world.calls.replay, 1);
    assert.deepEqual(replayOrder, ["after-compiler"]);
    await composition.prepare({ proposalId: proposal.proposalId, proposalRevision: proposal.proposalRevision });
    assert.equal(world.calls.replay, 2);
    const artifact = artifacts.list({ limit: 1 })[0]!.artifact;
    const compilerRows = artifacts.listResults({ artifact: {
      artifactId: artifact.artifactId,
      revision: artifact.revision,
      contentHash: artifact.contentHash,
    }, limit: 20 });
    const replayRows = artifacts.listAttestations({
      kind: "history-replay-attestation",
      artifact: {
        artifactId: artifact.artifactId,
        revision: artifact.revision,
        contentHash: artifact.contentHash,
      },
      limit: 20,
    });
    assert.equal(replayRows.length, 1);
    assert.equal(replayRows[0]!.assessment.kind, "history-replay-attestation");
    assert.equal(replayRows[0]!.assessment.status, "passed");
    assert.deepEqual(
      compilerRows.map((row) => row.kind).sort(),
      ["compile-attestation", "dry-run-attestation"],
    );
  } finally {
    await composition.stop();
    await context.fiber.dispose();
    authorityCandidates.close();
    artifacts.close();
    proposal.proposals.close();
  }
});

test("persists an unavailable replay as its own failed preparation stage without compiler-lane pollution", async () => {
  const proposal = approvedProposal({ importedHistory: true });
  const artifacts = new ArtifactRegistry({ path: ":memory:", now: () => capturedAt });
  const authorityCandidates = new AuthorityCandidateRegistry({ path: ":memory:", now: () => capturedAt });
  const context = new Context();
  const world = homeWorldFixture({ importedHistory: true, replayUnavailable: true });
  await context.plugin(HomeArtifactService, { registry: artifacts });
  const composition = await createArtifactPipelineComposition({
    context,
    proposals: proposal.proposals,
    homeWorld: world.homeWorld,
    artifacts,
    authorityCandidates,
    now: () => capturedAt,
  });

  try {
    await assert.rejects(
      composition.prepare({ proposalId: proposal.proposalId, proposalRevision: proposal.proposalRevision }),
      (error: unknown) => error instanceof ArtifactPreparationServiceError
        && error.stage === "history-replay"
        && error.code === "failed",
    );
    const artifact = artifacts.list({ limit: 1 })[0]!.artifact;
    const ref = {
      artifactId: artifact.artifactId,
      revision: artifact.revision,
      contentHash: artifact.contentHash,
    };
    assert.equal(artifacts.listResults({ artifact: ref, limit: 20 }).length, 2);
    const replayRows = artifacts.listAttestations({ kind: "history-replay-attestation", artifact: ref, limit: 20 });
    assert.equal(replayRows.length, 1);
    assert.equal(replayRows[0]!.assessment.status, "unavailable");
  } finally {
    await composition.stop();
    await context.fiber.dispose();
    authorityCandidates.close();
    artifacts.close();
    proposal.proposals.close();
  }
});

test("keeps compiler results intact when the imported replay World seam is absent", async () => {
  const proposal = approvedProposal({ importedHistory: true });
  const artifacts = new ArtifactRegistry({ path: ":memory:", now: () => capturedAt });
  const authorityCandidates = new AuthorityCandidateRegistry({ path: ":memory:", now: () => capturedAt });
  const context = new Context();
  const fixture = homeWorldFixture({ importedHistory: true });
  const { queryImportedHistoryForReplay: _replay, ...worldWithoutReplay } = fixture.homeWorld;
  await context.plugin(HomeArtifactService, { registry: artifacts });
  const composition = await createArtifactPipelineComposition({
    context,
    proposals: proposal.proposals,
    homeWorld: worldWithoutReplay,
    artifacts,
    authorityCandidates,
    now: () => capturedAt,
  });

  try {
    await assert.rejects(
      composition.prepare({ proposalId: proposal.proposalId, proposalRevision: proposal.proposalRevision }),
      (error: unknown) => error instanceof ArtifactPreparationServiceError
        && error.stage === "history-replay",
    );
    const artifact = artifacts.list({ limit: 1 })[0]!.artifact;
    const ref = {
      artifactId: artifact.artifactId,
      revision: artifact.revision,
      contentHash: artifact.contentHash,
    };
    assert.equal(artifacts.listResults({ artifact: ref, limit: 20 }).length, 2);
    assert.equal(artifacts.listAttestations({ kind: "history-replay-attestation", artifact: ref, limit: 20 }).length, 0);
  } finally {
    await composition.stop();
    await context.fiber.dispose();
    authorityCandidates.close();
    artifacts.close();
    proposal.proposals.close();
  }
});

test("keeps compiler results intact when the imported replay World seam throws", async () => {
  const proposal = approvedProposal({ importedHistory: true });
  const artifacts = new ArtifactRegistry({ path: ":memory:", now: () => capturedAt });
  const authorityCandidates = new AuthorityCandidateRegistry({ path: ":memory:", now: () => capturedAt });
  const context = new Context();
  const world = homeWorldFixture({ importedHistory: true, replayThrows: true });
  await context.plugin(HomeArtifactService, { registry: artifacts });
  const composition = await createArtifactPipelineComposition({
    context,
    proposals: proposal.proposals,
    homeWorld: world.homeWorld,
    artifacts,
    authorityCandidates,
    now: () => capturedAt,
  });

  try {
    await assert.rejects(
      composition.prepare({ proposalId: proposal.proposalId, proposalRevision: proposal.proposalRevision }),
      (error: unknown) => error instanceof ArtifactPreparationServiceError
        && error.stage === "history-replay",
    );
    assert.equal(world.calls.replay, 1);
    const artifact = artifacts.list({ limit: 1 })[0]!.artifact;
    const ref = {
      artifactId: artifact.artifactId,
      revision: artifact.revision,
      contentHash: artifact.contentHash,
    };
    assert.equal(artifacts.listResults({ artifact: ref, limit: 20 }).length, 2);
    assert.equal(artifacts.listAttestations({ kind: "history-replay-attestation", artifact: ref, limit: 20 }).length, 0);
  } finally {
    await composition.stop();
    await context.fiber.dispose();
    authorityCandidates.close();
    artifacts.close();
    proposal.proposals.close();
  }
});
