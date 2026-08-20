import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeProposalEvidenceIdentity } from "./artifact-assessments.js";
import { ArtifactRegistry, type ArtifactAssessmentEntry } from "./artifact-registry.js";
import {
  createArtifactRevision,
  type ArtifactContent,
  type ArtifactRef,
} from "./neutral-artifact.js";
import type { HomeWorldBridgeSnapshot, HomeWorldEvidenceCoverage } from "./home-world-service.js";
import type { HubVerifiedProposalSource } from "./proposal-store.js";
import {
  ArtifactEvidenceProducer,
  ArtifactEvidenceProducerError,
  type ArtifactEvidenceHomeWorldPort,
  type ArtifactEvidenceRegistry,
  type ApprovedArtifactProposalSource,
} from "./artifact-evidence-producer.js";

const capturedAt = "2026-08-20T03:00:00.000Z";

const content = {
  trigger: {
    kind: "capability_changed" as const,
    source: { hwCapabilityId: "hwc-sensor" },
  },
  conditions: [{
    kind: "capability_value" as const,
    source: { hwCapabilityId: "hwc-sensor" },
    operator: "equals" as const,
    value: true,
  }],
  actions: [{
    kind: "set_boolean" as const,
    target: { hwCapabilityId: "hwc-action" },
    value: true,
  }],
  rollback: {
    kind: "restore_previous_state" as const,
    target: { hwCapabilityId: "hwc-action" },
    maxAgeSeconds: 900,
  },
  postconditions: [{
    kind: "capability_value" as const,
    source: { hwCapabilityId: "hwc-action" },
    operator: "equals" as const,
    value: true,
    withinSeconds: 60,
  }],
};

const sourceEvidence = {
  references: [],
  watermarks: [{
    bridgeId: "bridge-source",
    epochId: "epoch-source",
    lastSeq: 3,
    freshness: "fresh" as const,
    gapCount: 0,
  }],
};

function source(candidateContent: ArtifactContent = content): HubVerifiedProposalSource {
  return {
    proposalId: "proposal-evidence-1",
    revision: 4,
    kind: "automation-draft",
    status: "approved",
    applicationStatus: "not_available",
    title: "Evidence fixture",
    summary: "A bounded evidence fixture.",
    intent: {
      type: "automation-draft",
      description: "Collect bounded neutral evidence.",
      rollback: "Restore the previous state.",
    },
    evidence: sourceEvidence,
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
      content: candidateContent,
    },
  };
}

function artifact(candidateContent: ArtifactContent = content, artifactId = "artifact-evidence-1") {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId,
    revision: 1,
    title: "Evidence fixture",
    summary: "A bounded evidence fixture.",
    sourceProposal: {
      proposalId: "proposal-evidence-1",
      proposalRevision: 4,
    },
    content: candidateContent,
    createdAt: "2026-08-20T02:00:00.000Z",
  });
}

function ref(value: ReturnType<typeof artifact>): ArtifactRef {
  return {
    artifactId: value.artifactId,
    revision: value.revision,
    contentHash: value.contentHash,
  };
}

function bridgeSnapshot(
  bridgeId = "bridge-action",
  epochId = "epoch-action",
  lastSeq = 9,
  connectionState: "ready" | "degraded" | "down" = "ready",
  historyGapCount = 0,
): HomeWorldBridgeSnapshot {
  return {
    bridgeId,
    adapterType: "fixture",
    diagnostics: {
      connectionState,
      lastSyncCompleteAt: "2026-08-20T02:59:00.000Z",
      lastEventReceivedAt: "2026-08-20T02:59:30.000Z",
      lastSuccessfulContactAt: "2026-08-20T02:59:30.000Z",
      droppedInvalidCount: 0,
      strippedFieldsCount: 0,
      staleEpochDropCount: 0,
      foldedStateCount: 0,
      unsupportedSchemaCount: 0,
      protocolViolationCount: 0,
      historyGapCount,
      recentHistoryGaps: [],
    },
    watermark: { bridgeId, epochId, lastSeq },
    devices: [],
    extensions: {},
    metrics: {
      consistency: connectionState === "ready" ? "ready" : "degraded",
      eventActivity: "active",
      connection: connectionState === "down" ? "down" : connectionState === "ready" ? "up" : "degraded",
    },
  };
}

class StubProposalSource implements ApprovedArtifactProposalSource {
  readonly calls: Array<{ proposalId: string; revision: number }> = [];

  constructor(readonly value: HubVerifiedProposalSource) {}

  withApprovedProposalAtRevision<T>(
    proposalId: string,
    revision: number,
    operation: (source: HubVerifiedProposalSource) => T,
  ): T {
    this.calls.push({ proposalId, revision });
    return operation(this.value);
  }
}

class StubHomeWorld implements ArtifactEvidenceHomeWorldPort {
  readonly queries: Array<{ hwCapabilityIds: readonly string[]; lookbackHours: number; limit?: number }> = [];

  constructor(
    readonly coverage: readonly HomeWorldEvidenceCoverage[] = [{
      bridgeId: "bridge-action",
      epochId: "epoch-action",
      baselineSeq: 9,
      status: "complete",
      reasons: [],
    }],
    readonly watermarks = [{
      bridgeId: "bridge-action",
      epochId: "epoch-action",
      lastSeq: 9,
      lastSyncCompleteAt: "2026-08-20T02:59:00.000Z",
    }],
    readonly bridges: Readonly<Record<string, HomeWorldBridgeSnapshot>> = {
      "bridge-action": bridgeSnapshot(),
    },
  ) {}

  queryRecentEvidence(input: Parameters<ArtifactEvidenceHomeWorldPort["queryRecentEvidence"]>[0]) {
    this.queries.push(input);
    return {
      requestedSince: "2026-08-19T03:00:00.000Z",
      requestedUntil: capturedAt,
      events: [],
      coverage: this.coverage,
      truncated: false,
    };
  }

  snapshot() {
    return {
      bridgeWatermarks: this.watermarks,
      bridges: this.bridges,
    };
  }
}

class StubRegistry implements ArtifactEvidenceRegistry {
  readonly records: ArtifactAssessmentEntry[] = [];

  constructor(readonly value: ReturnType<typeof artifact>) {}

  getRevision(artifactId: string, revision: number) {
    if (artifactId !== this.value.artifactId || revision !== this.value.revision) return undefined;
    return { artifact: this.value, status: "draft" as const, tombstone: false, audit: [] };
  }

  listAttestations() {
    return this.records;
  }

  recordEvidenceAttestation(input: Parameters<ArtifactEvidenceRegistry["recordEvidenceAttestation"]>[0]) {
    const entry = {
      kind: input.assessment.kind,
      recordId: input.assessment.attestationId,
      artifact: input.assessment.artifact,
      inputIdentity: input.assessment.inputIdentity,
      recordedAt: capturedAt,
      assessment: input.assessment,
      audit: [],
    };
    this.records.push(entry);
    return entry;
  }
}

test("produces evidence from exact artifact/source and HomeWorld dynamic cut", () => {
  const value = artifact();
  const proposals = new StubProposalSource(source());
  const homeWorld = new StubHomeWorld();
  const registry = new StubRegistry(value);
  const producer = new ArtifactEvidenceProducer({
    proposals,
    homeWorld,
    registry,
    now: () => capturedAt,
  });

  const result = producer.produce({ artifact: ref(value) });

  assert.equal(result.kind, "evidence-attestation");
  if (result.assessment.kind !== "evidence-attestation") throw new Error("expected evidence assessment");
  assert.deepEqual(result.assessment.sourceProposal, value.sourceProposal);
  assert.equal(result.assessment.proposalEvidenceIdentity, computeProposalEvidenceIdentity(source().evidence));
  assert.deepEqual(result.assessment.selectedHwCapabilityIds, ["hwc-action", "hwc-sensor"]);
  assert.deepEqual(homeWorld.queries, [{
    hwCapabilityIds: ["hwc-action", "hwc-sensor"],
    lookbackHours: 24,
    limit: 200,
  }]);
  assert.deepEqual(proposals.calls, [{ proposalId: "proposal-evidence-1", revision: 4 }]);
  assert.equal(registry.records.length, 1);
});

test("preserves partial coverage and diagnostic gap count without claiming fresh evidence", () => {
  const value = artifact();
  const proposals = new StubProposalSource(source());
  const homeWorld = new StubHomeWorld(
    [{
      bridgeId: "bridge-action",
      epochId: "epoch-action",
      baselineSeq: 9,
      status: "partial",
      reasons: ["history_gap"],
    }],
    [{
      bridgeId: "bridge-action",
      epochId: "epoch-action",
      lastSeq: 9,
      lastSyncCompleteAt: capturedAt,
    }],
    { "bridge-action": bridgeSnapshot("bridge-action", "epoch-action", 9, "degraded", 3) },
  );
  const registry = new StubRegistry(value);
  const result = new ArtifactEvidenceProducer({ proposals, homeWorld, registry, now: () => capturedAt })
    .produce({ artifact: ref(value) });

  if (result.assessment.kind !== "evidence-attestation") throw new Error("expected evidence assessment");
  assert.equal(result.assessment.coverage, "partial");
  assert.deepEqual(result.assessment.reasons, ["history_gap"]);
  assert.deepEqual(result.assessment.watermarks.map((item) => ({
    bridgeId: item.bridgeId,
    freshness: item.freshness,
    gapCount: item.gapCount,
  })), [{ bridgeId: "bridge-action", freshness: "stale", gapCount: 3 }]);
});

test("keeps unavailable coverage explicit against a retained matching watermark", () => {
  const value = artifact();
  const homeWorld = new StubHomeWorld(
    [{
      bridgeId: "bridge-action",
      epochId: "epoch-action",
      baselineSeq: 9,
      status: "unavailable",
      reasons: ["bridge_not_ready"],
    }],
    [{
      bridgeId: "bridge-action",
      epochId: "epoch-action",
      lastSeq: 9,
      lastSyncCompleteAt: capturedAt,
    }],
    { "bridge-action": bridgeSnapshot("bridge-action", "epoch-action", 9, "down") },
  );
  const result = new ArtifactEvidenceProducer({
    proposals: new StubProposalSource(source()),
    homeWorld,
    registry: new StubRegistry(value),
    now: () => capturedAt,
  }).produce({ artifact: ref(value) });

  if (result.assessment.kind !== "evidence-attestation") throw new Error("expected evidence assessment");
  assert.equal(result.assessment.coverage, "unavailable");
  assert.deepEqual(result.assessment.reasons, ["bridge_not_ready"]);
  assert.deepEqual(result.assessment.watermarks.map((item) => ({
    bridgeId: item.bridgeId,
    freshness: item.freshness,
    gapCount: item.gapCount,
  })), [{ bridgeId: "bridge-action", freshness: "stale", gapCount: 0 }]);
});

test("allows notify-only artifacts to carry an empty capability selection", () => {
  const notifyContent: ArtifactContent = {
    trigger: {
      kind: "schedule" as const,
      timezone: "Etc/UTC",
      daysOfWeek: [1],
      at: "08:00",
    },
    conditions: [],
    actions: [{ kind: "notify_local" as const, message: "Review this locally." }],
    rollback: { kind: "no_remote_change" as const },
    postconditions: [],
  };
  const value = artifact(notifyContent, "artifact-evidence-notify");
  const homeWorld = new StubHomeWorld();
  const result = new ArtifactEvidenceProducer({
    proposals: new StubProposalSource(source(notifyContent)),
    homeWorld,
    registry: new StubRegistry(value),
    now: () => capturedAt,
  }).produce({ artifact: ref(value) });

  if (result.assessment.kind !== "evidence-attestation") throw new Error("expected evidence assessment");
  assert.deepEqual(result.assessment.selectedHwCapabilityIds, []);
  assert.deepEqual(homeWorld.queries, []);
});

test("rejects caller-supplied dynamic fields and does not call HomeWorld", () => {
  const value = artifact();
  const homeWorld = new StubHomeWorld();
  const producer = new ArtifactEvidenceProducer({
    proposals: new StubProposalSource(source()),
    homeWorld,
    registry: new StubRegistry(value),
    now: () => capturedAt,
  });

  for (const field of ["watermarks", "coverage", "inputIdentity", "content"]) {
    assert.throws(
      () => producer.produce({ artifact: ref(value), [field]: [] } as never),
      /unsupported fields/i,
    );
  }
  assert.deepEqual(homeWorld.queries, []);
});

test("rejects a Registry seam that cannot perform bounded evidence lookup", () => {
  const value = artifact();
  assert.throws(
    () => new ArtifactEvidenceProducer({
      proposals: new StubProposalSource(source()),
      homeWorld: new StubHomeWorld(),
      registry: {
        getRevision: () => ({ artifact: value, status: "draft", tombstone: false, audit: [] }),
        listAttestations: undefined,
        recordEvidenceAttestation: () => {
          throw new Error("unreachable");
        },
      } as never,
    }),
    (error: unknown) => error instanceof ArtifactEvidenceProducerError && error.code === "invalid_input",
  );
});

test("fails closed when the approved source or Artifact content does not match", () => {
  const value = artifact();
  const homeWorld = new StubHomeWorld();
  const registry = new StubRegistry(value);
  const mismatchedContent: ArtifactContent = {
    ...content,
    actions: [{
      kind: "set_boolean" as const,
      target: { hwCapabilityId: "hwc-action" },
      value: false,
    }],
    postconditions: [{
      kind: "capability_value" as const,
      source: { hwCapabilityId: "hwc-action" },
      operator: "equals" as const,
      value: false,
      withinSeconds: 60,
    }],
  };
  const mismatchedSource = source(mismatchedContent);
  const producer = new ArtifactEvidenceProducer({
    proposals: new StubProposalSource(mismatchedSource),
    homeWorld,
    registry,
    now: () => capturedAt,
  });

  assert.throws(() => producer.produce({ artifact: ref(value) }), /does not match the Artifact/i);
  assert.deepEqual(homeWorld.queries, []);
  assert.equal(registry.records.length, 0);

  const forgedSource = { ...source(), proposalId: "proposal-other" } as HubVerifiedProposalSource;
  assert.throws(
    () => new ArtifactEvidenceProducer({
      proposals: new StubProposalSource(forgedSource),
      homeWorld,
      registry,
      now: () => capturedAt,
    }).produce({ artifact: ref(value) }),
    /does not match the Artifact/i,
  );
});

test("fails closed when a history gap has no exact diagnostic count", () => {
  const value = artifact();
  const homeWorld = new StubHomeWorld(
    [{
      bridgeId: "bridge-action",
      epochId: "epoch-action",
      baselineSeq: 9,
      status: "partial",
      reasons: ["history_gap"],
    }],
    [{
      bridgeId: "bridge-action",
      epochId: "epoch-action",
      lastSeq: 9,
      lastSyncCompleteAt: capturedAt,
    }],
    {},
  );
  const registry = new StubRegistry(value);

  assert.throws(
    () => new ArtifactEvidenceProducer({
      proposals: new StubProposalSource(source()),
      homeWorld,
      registry,
      now: () => capturedAt,
    }).produce({ artifact: ref(value) }),
    /exact diagnostic gap count/i,
  );
  assert.equal(registry.records.length, 0);
});

test("replays the same attestation after an Artifact Registry restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-artifact-evidence-producer-"));
  const path = join(directory, "artifacts.sqlite");
  const value = artifact();
  const proposals = new StubProposalSource(source());
  try {
    const firstRegistry = new ArtifactRegistry({ path, now: () => capturedAt });
    firstRegistry.createDraft({ artifact: value, idempotencyKey: "seed-artifact-evidence" });
    const first = new ArtifactEvidenceProducer({
      proposals,
      homeWorld: new StubHomeWorld(),
      registry: firstRegistry,
      now: () => capturedAt,
    }).produce({ artifact: ref(value) });
    firstRegistry.close();

    const secondRegistry = new ArtifactRegistry({ path, now: () => "2026-08-20T04:00:00.000Z" });
    try {
      const replay = new ArtifactEvidenceProducer({
        proposals,
        homeWorld: new StubHomeWorld(),
        registry: secondRegistry,
        now: () => "2026-08-20T04:00:00.000Z",
      }).produce({ artifact: ref(value) });
      assert.deepEqual(replay, first);
      assert.equal(secondRegistry.listAttestations({
        kind: "evidence-attestation",
        artifact: ref(value),
        limit: 200,
      }).length, 1);
      assert.equal(secondRegistry.audit({ limit: 200 }).filter((item) => item.action === "assessment_recorded").length, 1);
    } finally {
      secondRegistry.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a changed consistent watermark instead of persisting a mixed cut", () => {
  const value = artifact();
  const homeWorld = new StubHomeWorld(
    [{
      bridgeId: "bridge-action",
      epochId: "epoch-action",
      baselineSeq: 9,
      status: "complete",
      reasons: [],
    }],
    [{
      bridgeId: "bridge-action",
      epochId: "epoch-new",
      lastSeq: 10,
      lastSyncCompleteAt: capturedAt,
    }],
    { "bridge-action": bridgeSnapshot("bridge-action", "epoch-new", 10) },
  );
  const registry = new StubRegistry(value);
  const producer = new ArtifactEvidenceProducer({
    proposals: new StubProposalSource(source()),
    homeWorld,
    registry,
    now: () => capturedAt,
  });

  assert.throws(() => producer.produce({ artifact: ref(value) }), /watermark changed/i);
  assert.equal(registry.records.length, 0);
});

test("rejects a new watermark after an unavailable coverage result", () => {
  const value = artifact();
  const homeWorld = new StubHomeWorld(
    [{
      bridgeId: "bridge-action",
      status: "unavailable",
      reasons: ["missing_consistent_baseline"],
    }],
    [{
      bridgeId: "bridge-action",
      epochId: "epoch-new",
      lastSeq: 10,
      lastSyncCompleteAt: capturedAt,
    }],
    { "bridge-action": bridgeSnapshot("bridge-action", "epoch-new", 10) },
  );
  const registry = new StubRegistry(value);

  assert.throws(
    () => new ArtifactEvidenceProducer({
      proposals: new StubProposalSource(source()),
      homeWorld,
      registry,
      now: () => capturedAt,
    }).produce({ artifact: ref(value) }),
    /watermark changed/i,
  );
  assert.equal(registry.records.length, 0);
});
