import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactRegistry, type ArtifactRegistryEntry } from "./artifact-registry.js";
import {
  SqliteProposalStore,
} from "../home/proposal-store.js";
import type { HubVerifiedProposalSource } from "./proposal-source-port.js";
import {
  ArtifactProducer,
  type ApprovedProposalSource,
  type ArtifactDraftRegistry,
} from "./artifact-producer.js";

const createdAt = "2026-08-20T01:00:00.000Z";

const candidateContent = {
  trigger: {
    kind: "schedule" as const,
    timezone: "Etc/UTC",
    daysOfWeek: [1] as const,
    at: "08:00",
  },
  conditions: [{
    kind: "capability_value" as const,
    source: { hwCapabilityId: "hwc-light-1" },
    operator: "equals" as const,
    value: true,
  }],
  actions: [{
    kind: "set_level" as const,
    target: { hwCapabilityId: "hwc-cover-1" },
    value: 0.65,
    transitionSeconds: 30,
  }],
  rollback: {
    kind: "restore_previous_state" as const,
    target: { hwCapabilityId: "hwc-cover-1" },
    maxAgeSeconds: 900,
  },
  postconditions: [{
    kind: "capability_value" as const,
    source: { hwCapabilityId: "hwc-cover-1" },
    operator: "equals" as const,
    value: 0.65,
    withinSeconds: 120,
  }],
};

function source(overrides: Partial<HubVerifiedProposalSource> = {}): HubVerifiedProposalSource {
  return {
    proposalId: "proposal-approved-1",
    revision: 2,
    kind: "automation-draft",
    status: "pending_review",
    applicationStatus: "not_available",
    title: "Morning comfort",
    summary: "Review a bounded morning comfort behavior.",
    intent: {
      type: "automation-draft",
      description: "Adjust a selected capability on weekday mornings.",
      rollback: "Restore the previous value within the bounded window.",
    },
    evidence: {
      references: [],
      watermarks: [{
        bridgeId: "bridge-a",
        epochId: "epoch-a",
        lastSeq: 7,
        freshness: "fresh",
        gapCount: 0,
      }],
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
      content: candidateContent,
    },
    ...overrides,
  };
}

class StubProposalSource implements ApprovedProposalSource {
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

class StubArtifactRegistry implements ArtifactDraftRegistry {
  readonly calls: Array<Parameters<ArtifactDraftRegistry["createDraft"]>[0]> = [];

  createDraft(input: Parameters<ArtifactDraftRegistry["createDraft"]>[0]): ArtifactRegistryEntry {
    this.calls.push(input);
    return {
      artifact: input.artifact,
      status: "draft",
      tombstone: false,
      audit: [],
    };
  }
}

test("creates revision one from the exact pending candidate and excludes dynamic authority inputs", () => {
  const proposals = new StubProposalSource(source());
  const registry = new StubArtifactRegistry();
  const producer = new ArtifactProducer({
    proposals,
    registry,
    now: () => createdAt,
  });

  const entry = producer.produce({ proposalId: "proposal-approved-1", proposalRevision: 2 });
  const artifact = entry.artifact;
  assert.deepEqual(proposals.calls, [{ proposalId: "proposal-approved-1", revision: 2 }]);
  assert.equal(artifact.revision, 1);
  assert.equal(artifact.createdAt, createdAt);
  assert.equal(artifact.title, "Morning comfort");
  assert.equal(artifact.summary, "Review a bounded morning comfort behavior.");
  assert.deepEqual(artifact.sourceProposal, {
    proposalId: "proposal-approved-1",
    proposalRevision: 2,
  });
  assert.deepEqual(artifact.content, candidateContent);
  assert.equal("evidence" in artifact, false);
  assert.equal("risk" in artifact, false);
  assert.equal("authority" in artifact, false);
  assert.equal("bridgeId" in artifact, false);
  assert.equal("nativeId" in artifact, false);
  assert.equal("remoteInstanceId" in artifact, false);
  assert.equal(registry.calls.length, 1);
  assert.equal(registry.calls[0]?.idempotencyKey.startsWith("artifact-producer-v1-"), true);
  assert.equal(registry.calls[0]?.actor, undefined);
});

test("composes the real prepared Proposal gate with the real immutable Registry", () => {
  const proposals = new SqliteProposalStore({ path: ":memory:", now: () => createdAt });
  const registry = new ArtifactRegistry({ path: ":memory:", now: () => createdAt });
  try {
    const pending = proposals.create({
      kind: "automation-draft",
      title: "Morning comfort",
      summary: "Review a bounded morning comfort behavior.",
      idempotencyKey: "producer-integration-proposal:v1",
      provenance: { producer: "hub-producer-integration" },
      evidence: source().evidence,
      conflictCheck: source().conflictCheck,
      dryRun: { status: "not_run", summary: "No simulation has run." },
      risk: source().risk,
      intent: source().intent,
      artifactCandidate: source().artifactCandidate,
    });
    const producer = new ArtifactProducer({ proposals, registry, now: () => createdAt });

    const entry = producer.produce({
      proposalId: pending.id,
      proposalRevision: pending.revision,
    });

    assert.equal(entry.artifact.sourceProposal.proposalId, pending.id);
    assert.equal(entry.artifact.sourceProposal.proposalRevision, pending.revision);
    assert.deepEqual(entry.artifact.content, candidateContent);
    assert.deepEqual(registry.getRevision(entry.artifact.artifactId, 1), entry);
  } finally {
    registry.close();
    proposals.close();
  }
});

test("rejects caller fields and never invokes the source or registry", () => {
  const proposals = new StubProposalSource(source());
  const registry = new StubArtifactRegistry();
  const producer = new ArtifactProducer({ proposals, registry, now: () => createdAt });

  assert.throws(
    () => producer.produce({
      proposalId: "proposal-approved-1",
      proposalRevision: 2,
      content: candidateContent,
    } as never),
    /request contains unsupported fields/i,
  );
  assert.throws(
    () => producer.produce({
      proposalId: "proposal-approved-1",
      proposalRevision: 2,
      evidence: { watermarks: [] },
      risk: "low",
      authority: "available",
      route: "bridge-a",
    } as never),
    /request contains unsupported fields/i,
  );
  assert.deepEqual(proposals.calls, []);
  assert.equal(registry.calls.length, 0);
});

test("replays the same generated artifact idempotently after registry restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-artifact-producer-"));
  const path = join(directory, "artifacts.sqlite");
  try {
    const proposals = new StubProposalSource(source());
    const firstRegistry = new ArtifactRegistry({ path, now: () => createdAt });
    const firstProducer = new ArtifactProducer({ proposals, registry: firstRegistry, now: () => createdAt });
    const first = firstProducer.produce({ proposalId: "proposal-approved-1", proposalRevision: 2 });
    firstRegistry.close();

    const secondRegistry = new ArtifactRegistry({ path, now: () => "2026-08-20T02:00:00.000Z" });
    try {
      const secondProducer = new ArtifactProducer({ proposals, registry: secondRegistry, now: () => "2026-08-20T02:00:00.000Z" });
      const replay = secondProducer.produce({ proposalId: "proposal-approved-1", proposalRevision: 2 });
      assert.deepEqual(replay, first);
      assert.equal(secondRegistry.list({ artifactId: first.artifact.artifactId }).length, 1);
      assert.equal(secondRegistry.audit().length, 1);
    } finally {
      secondRegistry.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed when the source gate does not return the requested pending revision", () => {
  const proposals = new StubProposalSource(source({ proposalId: "other", revision: 3 }));
  const registry = new StubArtifactRegistry();
  const producer = new ArtifactProducer({ proposals, registry, now: () => createdAt });

  assert.throws(
    () => producer.produce({ proposalId: "proposal-approved-1", proposalRevision: 2 }),
    /source identity does not match request/i,
  );
  assert.equal(registry.calls.length, 0);
});
