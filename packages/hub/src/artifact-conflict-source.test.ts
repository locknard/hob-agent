import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactRegistryEntry } from "./artifact-registry.js";
import type {
  ArtifactRiskConflictResult,
} from "./artifact-risk-producer.js";
import {
  ArtifactRiskConflictSource,
  ArtifactRiskConflictSourceError,
  type ArtifactRiskConflictArtifactRegistry,
  type ArtifactRiskConflictProposalSource,
} from "./artifact-conflict-source.js";
import {
  createArtifactRevision,
  type ArtifactContent,
  type ArtifactRef,
  type ArtifactRevision,
} from "./neutral-artifact.js";
import type { HubVerifiedProposalSource } from "./proposal-store.js";

const capturedAt = "2026-08-20T04:00:00.000Z";

function deviceContent(
  target: string,
  value = 0.5,
  trigger = "hwc-trigger",
): ArtifactContent {
  return {
    trigger: { kind: "capability_changed", source: { hwCapabilityId: trigger } },
    conditions: [],
    actions: [{ kind: "set_level", target: { hwCapabilityId: target }, value }],
    rollback: { kind: "restore_previous_state", target: { hwCapabilityId: target }, maxAgeSeconds: 900 },
    postconditions: [{
      kind: "capability_value",
      source: { hwCapabilityId: target },
      operator: "equals",
      value,
      withinSeconds: 120,
    }],
  };
}

function artifact(
  content: ArtifactContent = deviceContent("hwc-target"),
  artifactId = "artifact-source-candidate",
  proposalId = "proposal-source",
  proposalRevision = 2,
): ArtifactRevision {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId,
    revision: 1,
    title: "Conflict source fixture",
    summary: "A bounded conflict source fixture.",
    sourceProposal: { proposalId, proposalRevision },
    content,
    createdAt: capturedAt,
  });
}

function ref(value: ArtifactRevision): ArtifactRef {
  return {
    artifactId: value.artifactId,
    revision: value.revision,
    contentHash: value.contentHash,
  };
}

function source(
  value: ArtifactRevision,
  matches: readonly { identity: string; relation: "duplicate" | "conflict" | "possible_overlap" }[] = [],
): HubVerifiedProposalSource {
  return {
    proposalId: value.sourceProposal.proposalId,
    revision: value.sourceProposal.proposalRevision,
    kind: "automation-draft",
    status: "approved",
    applicationStatus: "not_available",
    title: value.title,
    summary: value.summary,
    intent: {
      type: "automation-draft",
      description: "Review a bounded conflict source fixture.",
      rollback: "Restore the previous state.",
    },
    evidence: {
      references: [],
      watermarks: [{
        bridgeId: "bridge-source",
        epochId: "epoch-source",
        lastSeq: 1,
        freshness: "fresh",
        gapCount: 0,
      }],
    },
    conflictCheck: {
      status: "checked",
      existingAutomationCount: matches.length,
      matches: [...matches],
    },
    risk: { level: "low", reasons: [], requiresHumanApproval: true },
    artifactCandidate: { schemaVersion: "1", content: value.content },
  };
}

class StubProposalSource implements ArtifactRiskConflictProposalSource {
  readonly calls: Array<{ proposalId: string; revision: number }> = [];
  value: unknown;
  error: unknown;

  constructor(value: unknown) {
    this.value = value;
  }

  withApprovedProposalAtRevision<T>(
    proposalId: string,
    revision: number,
    operation: (source: HubVerifiedProposalSource) => T,
  ): T {
    this.calls.push({ proposalId, revision });
    if (this.error !== undefined) throw this.error;
    return operation(this.value as HubVerifiedProposalSource);
  }
}

class StubRegistry implements ArtifactRiskConflictArtifactRegistry {
  readonly listCalls: Array<{ limit?: number }> = [];
  entries: readonly ArtifactRegistryEntry[];

  constructor(readonly candidate: ArtifactRevision, entries: readonly ArtifactRevision[] = []) {
    this.entries = [entry(candidate), ...entries.map((value) => entry(value))];
  }

  getRevision(artifactId: string, revision: number): ArtifactRegistryEntry | undefined {
    return this.entries.find((value) => value.artifact.artifactId === artifactId && value.artifact.revision === revision);
  }

  list(query: { readonly limit?: number } = {}): readonly ArtifactRegistryEntry[] {
    this.listCalls.push({ limit: query.limit });
    return this.entries.slice(0, query.limit);
  }
}

function entry(
  value: ArtifactRevision,
  status: "draft" | "superseded" = "draft",
  tombstone = false,
): ArtifactRegistryEntry {
  return { artifact: value, status, tombstone, audit: [] };
}

function makeSource(
  candidate: ArtifactRevision,
  entries: readonly ArtifactRevision[] = [],
  matches: readonly { identity: string; relation: "duplicate" | "conflict" | "possible_overlap" }[] = [],
): { readonly source: ArtifactRiskConflictSource; readonly proposals: StubProposalSource; readonly registry: StubRegistry } {
  const proposals = new StubProposalSource(source(candidate, matches));
  const registry = new StubRegistry(candidate, entries);
  return { source: new ArtifactRiskConflictSource({ proposals, registry }), proposals, registry };
}

test("reads the exact draft and approved proposal, then maps closed proposal conflicts", () => {
  const candidate = artifact();
  const environment = makeSource(candidate, [], [
    { identity: "opaque-overlap", relation: "possible_overlap" },
    { identity: "opaque-duplicate", relation: "duplicate" },
    { identity: "opaque-conflict", relation: "conflict" },
  ]);

  const result = environment.source.assess({
    artifact: ref(candidate),
    hwCapabilityIds: ["hwc-target", "hwc-trigger"],
  });

  assert.deepEqual(result, {
    status: "duplicate",
    findings: [
      { kind: "foreign_rule", severity: "blocking", reason: "duplicate", reference: "opaque-duplicate" },
      { kind: "foreign_rule", severity: "blocking", reason: "foreign_rule", reference: "opaque-conflict" },
      { kind: "foreign_rule", severity: "warning", reason: "possible_overlap", reference: "opaque-overlap" },
    ],
  });
  assert.deepEqual(environment.proposals.calls, [{ proposalId: "proposal-source", revision: 2 }]);
  assert.deepEqual(environment.registry.listCalls, [{ limit: 200 }]);
  assert.equal(JSON.stringify(result).includes("Conflict source fixture"), false);
});

test("blocks exact behavior and conflicting target actions, but only warns for shared references", () => {
  const candidate = artifact(deviceContent("hwc-target", 0.5));
  const duplicate = artifact(deviceContent("hwc-target", 0.5), "artifact-duplicate");
  const conflicting = artifact(deviceContent("hwc-target", 0.8), "artifact-conflict");
  const sharedOnly = artifact(deviceContent("hwc-other", 0.8, "hwc-target"), "artifact-shared");

  const duplicateEnvironment = makeSource(candidate, [duplicate]);
  assert.deepEqual(duplicateEnvironment.source.assess({
    artifact: ref(candidate),
    hwCapabilityIds: ["hwc-target", "hwc-trigger"],
  }), {
    status: "duplicate",
    findings: [{
      kind: "existing_artifact",
      severity: "blocking",
      reason: "duplicate",
      reference: duplicate.contentHash,
    }],
  });

  const conflictEnvironment = makeSource(candidate, [conflicting]);
  assert.deepEqual(conflictEnvironment.source.assess({
    artifact: ref(candidate),
    hwCapabilityIds: ["hwc-target", "hwc-trigger"],
  }), {
    status: "possible_overlap",
    findings: [{
      kind: "existing_artifact",
      severity: "blocking",
      reason: "existing_artifact",
      hwCapabilityId: "hwc-target",
      reference: conflicting.contentHash,
    }, {
      kind: "existing_artifact",
      severity: "warning",
      reason: "possible_overlap",
      hwCapabilityId: "hwc-trigger",
      reference: conflicting.contentHash,
    }],
  });

  const sharedEnvironment = makeSource(candidate, [sharedOnly]);
  assert.deepEqual(sharedEnvironment.source.assess({
    artifact: ref(candidate),
    hwCapabilityIds: ["hwc-target", "hwc-trigger"],
  }), {
    status: "possible_overlap",
    findings: [{
      kind: "existing_artifact",
      severity: "warning",
      reason: "possible_overlap",
      hwCapabilityId: "hwc-target",
      reference: sharedOnly.contentHash,
    }],
  });
});

test("excludes the exact self and superseded or tombstoned registry rows", () => {
  const candidate = artifact();
  const superseded = artifact(deviceContent("hwc-target", 0.8), "artifact-superseded");
  const tombstoned = artifact(deviceContent("hwc-target", 0.9), "artifact-tombstoned");
  const environment = makeSource(candidate, [superseded, tombstoned]);
  environment.registry.entries = [
    entry(candidate),
    entry(superseded, "superseded", true),
    entry(tombstoned, "draft", true),
  ];

  assert.deepEqual(environment.source.assess({
    artifact: ref(candidate),
    hwCapabilityIds: ["hwc-target", "hwc-trigger"],
  }), { status: "none", findings: [] });
});

test("returns unavailable for source faults, mismatches, malformed rows, and a bounded scan", () => {
  const candidate = artifact();
  const cases: Array<() => ArtifactRiskConflictResult> = [];

  const missingProposal = makeSource(candidate);
  missingProposal.proposals.error = new Error("provider rule id must not escape");
  cases.push(() => missingProposal.source.assess({ artifact: ref(candidate), hwCapabilityIds: ["hwc-target", "hwc-trigger"] }));

  const mismatchedProposal = makeSource(candidate);
  mismatchedProposal.proposals.value = source(artifact(deviceContent("hwc-other"), "artifact-other"));
  cases.push(() => mismatchedProposal.source.assess({ artifact: ref(candidate), hwCapabilityIds: ["hwc-target", "hwc-trigger"] }));

  const malformedRegistry = makeSource(candidate);
  malformedRegistry.registry.entries = [{
    artifact: { ...candidate, contentHash: `sha256:${"f".repeat(64)}` },
    status: "draft",
    tombstone: false,
    audit: [],
  } as ArtifactRegistryEntry];
  cases.push(() => malformedRegistry.source.assess({ artifact: ref(candidate), hwCapabilityIds: ["hwc-target", "hwc-trigger"] }));

  const truncated = makeSource(candidate);
  truncated.registry.entries = [
    entry(candidate),
    ...Array.from({ length: 199 }, (_, index) => entry(
      artifact(deviceContent(`hwc-other-${index}`), `artifact-other-${index}`),
    )),
  ];
  cases.push(() => truncated.source.assess({ artifact: ref(candidate), hwCapabilityIds: ["hwc-target", "hwc-trigger"] }));

  for (const run of cases) {
    const result = run();
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.findings, [{
      kind: "stale_evidence",
      severity: "blocking",
      reason: "conflict_unavailable",
    }]);
    assert.equal(JSON.stringify(result).includes("provider"), false);
    assert.equal(JSON.stringify(result).includes("native"), false);
  }
});

test("requires a strict request and canonical capability scope", () => {
  const candidate = artifact();
  const environment = makeSource(candidate);

  assert.throws(
    () => new ArtifactRiskConflictSource({ registry: environment.registry } as never),
    (error: unknown) => error instanceof ArtifactRiskConflictSourceError && error.code === "invalid_input",
  );
  assert.throws(
    () => environment.source.assess({ artifact: ref(candidate), hwCapabilityIds: ["hwc-trigger", "hwc-target"] }),
    (error: unknown) => error instanceof ArtifactRiskConflictSourceError && error.code === "invalid_input",
  );
  assert.throws(
    () => environment.source.assess({ artifact: ref(candidate), hwCapabilityIds: ["hwc-target", "hwc-target"] }),
    (error: unknown) => error instanceof ArtifactRiskConflictSourceError && error.code === "invalid_input",
  );
  assert.throws(
    () => environment.source.assess({ artifact: ref(candidate), hwCapabilityIds: ["hwc-target", "hwc-trigger"], content: candidate.content } as never),
    (error: unknown) => error instanceof ArtifactRiskConflictSourceError && error.code === "invalid_input",
  );
});

test("sorts findings deterministically and returns an immutable restart-stable result", () => {
  const candidate = artifact();
  const first = artifact(deviceContent("hwc-a", 0.8, "hwc-target"), "artifact-z");
  const second = artifact(deviceContent("hwc-b", 0.8, "hwc-target"), "artifact-a");
  const environment = makeSource(candidate, [first, second]);
  environment.registry.entries = [entry(candidate), entry(first), entry(second)];

  const input = { artifact: ref(candidate), hwCapabilityIds: ["hwc-target", "hwc-trigger"] } as const;
  const firstResult = environment.source.assess(input);
  const secondResult = environment.source.assess(input);

  assert.deepEqual(secondResult, firstResult);
  assert.deepEqual(firstResult.findings.map((finding) => finding.hwCapabilityId), ["hwc-target", "hwc-target"]);
  assert.ok(Object.isFrozen(firstResult));
  assert.ok(Object.isFrozen(firstResult.findings));
  assert.ok(Object.isFrozen(firstResult.findings[0]));
});
