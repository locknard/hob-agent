import assert from "node:assert/strict";
import test from "node:test";

import {
  createArtifactAuthorityAssessment,
  createArtifactEvidenceAttestation,
  createArtifactRiskAssessment,
} from "./artifact-assessments.js";
import {
  ArtifactMutationCoordinator,
  ArtifactMutationCoordinatorError,
  type ArtifactMutationAuthorityProducer,
  type ArtifactMutationArtifactProducer,
  type ArtifactMutationEvidenceProducer,
  type ArtifactMutationRiskProducer,
} from "./artifact-mutation-coordinator.js";
import {
  createArtifactRevision,
  type ArtifactRef,
} from "./neutral-artifact.js";
import type {
  ArtifactAssessment,
  ArtifactAssessmentEntry,
  ArtifactRegistryEntry,
} from "./artifact-registry.js";

const at = "2026-08-20T05:00:00.000Z";
const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

const content = {
  trigger: { kind: "schedule" as const, timezone: "Etc/UTC", daysOfWeek: [1], at: "08:00" },
  conditions: [],
  actions: [{ kind: "notify_local" as const, message: "Review this household note." }],
  rollback: { kind: "no_remote_change" as const },
  postconditions: [],
};

function artifact() {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: "artifact-coordinator-1",
    revision: 1,
    title: "Coordinator fixture",
    summary: "A bounded coordinator fixture.",
    sourceProposal: { proposalId: "proposal-coordinator-1", proposalRevision: 2 },
    content,
    createdAt: at,
  });
}

function ref(value = artifact()): ArtifactRef {
  return { artifactId: value.artifactId, revision: value.revision, contentHash: value.contentHash };
}

function rows(value = artifact()): {
  artifact: ArtifactRegistryEntry;
  evidence: ArtifactAssessmentEntry;
  authority: ArtifactAssessmentEntry;
  risk: ArtifactAssessmentEntry;
} {
  const artifactRef = ref(value);
  const evidence = createArtifactEvidenceAttestation({
    artifact: artifactRef,
    attestationId: "evidence-coordinator-1",
    capturedAt: at,
    source: "home-world-consistent-cut",
    sourceProposal: { proposalId: "proposal-coordinator-1", proposalRevision: 2 },
    proposalEvidenceIdentity: digest("1"),
    selectedHwCapabilityIds: [],
    watermarks: [{
      bridgeId: "bridge-coordinator-1",
      epochId: "epoch-coordinator-1",
      lastSeq: 1,
      freshness: "fresh",
      gapCount: 0,
    }],
    coverage: "complete",
    reasons: [],
  });
  const authority = createArtifactAuthorityAssessment({
    artifact: artifactRef,
    assessmentId: "authority-coordinator-1",
    assessedAt: at,
    authorityRegistryIdentity: digest("2"),
    candidates: [],
    checkedWatermarks: [],
  }, { hwCapabilityIds: [] });
  const risk = createArtifactRiskAssessment({
    artifact: artifactRef,
    assessmentId: "risk-coordinator-1",
    assessedAt: at,
    evidence: { attestationId: evidence.attestationId, inputIdentity: evidence.inputIdentity },
    authority: { assessmentId: authority.assessmentId, inputIdentity: authority.inputIdentity },
    conflictInputIdentity: digest("3"),
    class: "observe_or_notify",
    reasons: [],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  });
  return {
    artifact: { artifact: value, status: "draft", tombstone: false, audit: [] },
    evidence: row(evidence),
    authority: row(authority),
    risk: row(risk),
  };
}

function row(assessment: ArtifactAssessment): ArtifactAssessmentEntry {
  return {
    kind: assessment.kind,
    recordId: assessment.kind === "evidence-attestation" ? assessment.attestationId : assessment.assessmentId,
    artifact: assessment.artifact,
    inputIdentity: assessment.inputIdentity,
    recordedAt: at,
    assessment,
    audit: [],
  };
}

function recordId(assessment: ArtifactAssessment): string {
  return assessment.kind === "evidence-attestation" ? assessment.attestationId : assessment.assessmentId;
}

class ArtifactStub implements ArtifactMutationArtifactProducer {
  readonly calls: unknown[] = [];
  constructor(readonly result: ArtifactRegistryEntry, readonly order: string[]) {}
  produce(input: { readonly proposalId: string; readonly proposalRevision: number }): ArtifactRegistryEntry {
    this.order.push("artifact");
    this.calls.push(input);
    return this.result;
  }
}

class AssessmentStub implements ArtifactMutationEvidenceProducer, ArtifactMutationAuthorityProducer, ArtifactMutationRiskProducer {
  readonly calls: unknown[] = [];
  constructor(readonly result: ArtifactAssessmentEntry, readonly stage: string, readonly order: string[]) {}
  produce(input: unknown): ArtifactAssessmentEntry {
    this.order.push(this.stage);
    this.calls.push(input);
    return this.result;
  }
}

function coordinator(options?: {
  readonly value?: ReturnType<typeof rows>;
  readonly artifact?: ArtifactMutationArtifactProducer;
  readonly evidence?: ArtifactMutationEvidenceProducer;
  readonly authority?: ArtifactMutationAuthorityProducer;
  readonly risk?: ArtifactMutationRiskProducer;
}) {
  const value = options?.value ?? rows();
  const order: string[] = [];
  const artifactProducer = options?.artifact ?? new ArtifactStub(value.artifact, order);
  const evidenceProducer = options?.evidence ?? new AssessmentStub(value.evidence, "evidence", order);
  const authorityProducer = options?.authority ?? new AssessmentStub(value.authority, "authority", order);
  const riskProducer = options?.risk ?? new AssessmentStub(value.risk, "risk", order);
  return {
    value,
    order,
    artifactProducer,
    evidenceProducer,
    authorityProducer,
    riskProducer,
    coordinator: new ArtifactMutationCoordinator({
      artifact: artifactProducer,
      evidence: evidenceProducer,
      authority: authorityProducer,
      risk: riskProducer,
    }),
  };
}

test("runs proposal production in artifact, evidence, authority, risk order", () => {
  const env = coordinator();
  const receipt = env.coordinator.fromApprovedProposal({ proposalId: "proposal-coordinator-1", proposalRevision: 2 });

  assert.deepEqual(receipt, {
    artifact: ref(env.value.artifact.artifact),
    evidence: { attestationId: "evidence-coordinator-1", inputIdentity: env.value.evidence.inputIdentity },
    authority: { assessmentId: "authority-coordinator-1", inputIdentity: env.value.authority.inputIdentity },
    risk: { assessmentId: "risk-coordinator-1", inputIdentity: env.value.risk.inputIdentity },
  });
  assert.deepEqual((env.artifactProducer as ArtifactStub).calls, [{ proposalId: "proposal-coordinator-1", proposalRevision: 2 }]);
  assert.deepEqual((env.evidenceProducer as AssessmentStub).calls, [{ artifact: ref(env.value.artifact.artifact) }]);
  assert.deepEqual((env.authorityProducer as AssessmentStub).calls, [ref(env.value.artifact.artifact)]);
  assert.deepEqual((env.riskProducer as AssessmentStub).calls, [ref(env.value.artifact.artifact)]);
  assert.deepEqual(env.order, ["artifact", "evidence", "authority", "risk"]);
});

test("refresh runs only the three assessment stages for an exact ref", () => {
  const env = coordinator();
  const artifactRef = ref(env.value.artifact.artifact);

  const receipt = env.coordinator.refresh(artifactRef);

  assert.equal(receipt.artifact.revision, 1);
  assert.equal((env.artifactProducer as ArtifactStub).calls.length, 0);
  assert.deepEqual((env.evidenceProducer as AssessmentStub).calls, [{ artifact: artifactRef }]);
});

test("rejects unsupported command fields before invoking any producer", () => {
  const env = coordinator();
  for (const field of ["content", "watermarks", "candidates", "conflict", "risk", "route", "actor", "idempotencyKey"] as const) {
    assert.throws(
      () => env.coordinator.fromApprovedProposal({
        proposalId: "proposal-coordinator-1",
        proposalRevision: 2,
        [field]: field === "watermarks" || field === "candidates" ? [] : "caller-value",
      } as never),
      (error: unknown) => error instanceof TypeError,
    );
    assert.throws(
      () => env.coordinator.refresh({ ...ref(env.value.artifact.artifact), [field]: [] } as never),
      (error: unknown) => error instanceof TypeError,
    );
  }
  assert.equal((env.artifactProducer as ArtifactStub).calls.length, 0);
  assert.equal((env.evidenceProducer as AssessmentStub).calls.length, 0);
});

test("normalizes a stage failure without exposing the producer error", () => {
  const failing: ArtifactMutationEvidenceProducer = {
    produce: () => { throw new Error("native provider secret"); },
  };
  const env = coordinator({ evidence: failing });

  assert.throws(
    () => env.coordinator.fromApprovedProposal({ proposalId: "proposal-coordinator-1", proposalRevision: 2 }),
    (error: unknown) => error instanceof ArtifactMutationCoordinatorError
      && error.stage === "evidence"
      && !error.message.includes("native provider secret"),
  );
  assert.equal((env.authorityProducer as AssessmentStub).calls.length, 0);
  assert.equal((env.riskProducer as AssessmentStub).calls.length, 0);
});

test("rejects mismatched Registry rows at their owning stage", () => {
  const baseline = rows();
  const artifactRef = ref(baseline.artifact.artifact);
  const cases: readonly {
    readonly stage: "evidence" | "authority" | "risk";
    readonly result: ArtifactAssessmentEntry;
    readonly assertNotCalled: (env: ReturnType<typeof coordinator>) => number;
  }[] = [
    {
      stage: "evidence",
      result: baseline.authority,
      assertNotCalled: (env) => (env.authorityProducer as AssessmentStub).calls.length,
    },
    {
      stage: "authority",
      result: { ...baseline.authority, artifact: { ...artifactRef, artifactId: "artifact-other" } },
      assertNotCalled: (env) => (env.riskProducer as AssessmentStub).calls.length,
    },
    {
      stage: "risk",
      result: { ...baseline.risk, recordId: "risk-wrong-record" },
      assertNotCalled: () => 0,
    },
  ];

  for (const item of cases) {
    const env = item.stage === "evidence"
      ? coordinator({ evidence: new AssessmentStub(item.result, "evidence", []) })
      : item.stage === "authority"
        ? coordinator({ authority: new AssessmentStub(item.result, "authority", []) })
        : coordinator({ risk: new AssessmentStub(item.result, "risk", []) });
    assert.throws(
      () => env.coordinator.refresh(artifactRef),
      (error: unknown) => error instanceof ArtifactMutationCoordinatorError
        && error.stage === item.stage
        && error.code === "registry_mismatch",
    );
    assert.equal(item.assertNotCalled(env), 0);
  }
});

test("checks every assessment row kind, ref, record identity, and input identity", () => {
  const baseline = rows();
  const artifactRef = ref(baseline.artifact.artifact);
  const stageCases = [
    {
      stage: "evidence" as const,
      expected: baseline.evidence,
      wrongKind: baseline.authority,
    },
    {
      stage: "authority" as const,
      expected: baseline.authority,
      wrongKind: baseline.evidence,
    },
    {
      stage: "risk" as const,
      expected: baseline.risk,
      wrongKind: baseline.evidence,
    },
  ] as const;

  for (const item of stageCases) {
    const mutations: readonly ArtifactAssessmentEntry[] = [
      item.wrongKind,
      { ...item.expected, artifact: { ...artifactRef, artifactId: "artifact-mismatch" } },
      { ...item.expected, recordId: "record-mismatch" },
      { ...item.expected, inputIdentity: digest("f") },
    ];
    for (const result of mutations) {
      const producer = new AssessmentStub(result, item.stage, []);
      const env = item.stage === "evidence"
        ? coordinator({ evidence: producer })
        : item.stage === "authority"
          ? coordinator({ authority: producer })
          : coordinator({ risk: producer });
      assert.throws(
        () => env.coordinator.refresh(artifactRef),
        (error: unknown) => error instanceof ArtifactMutationCoordinatorError
          && error.stage === item.stage
          && error.code === "registry_mismatch",
      );
    }
  }
});

test("rejects an artifact row whose source Proposal identity does not match the command", () => {
  const wrongArtifact = createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: "artifact-coordinator-other",
    revision: 1,
    title: "Coordinator fixture",
    summary: "A bounded coordinator fixture.",
    sourceProposal: { proposalId: "proposal-other", proposalRevision: 1 },
    content,
    createdAt: at,
  });
  const env = coordinator({
    artifact: new ArtifactStub({ artifact: wrongArtifact, status: "draft", tombstone: false, audit: [] }, []),
  });

  assert.throws(
    () => env.coordinator.fromApprovedProposal({ proposalId: "proposal-coordinator-1", proposalRevision: 2 }),
    (error: unknown) => error instanceof ArtifactMutationCoordinatorError
      && error.stage === "artifact"
      && error.code === "registry_mismatch",
  );
  assert.equal((env.evidenceProducer as AssessmentStub).calls.length, 0);
});

test("rejects a risk row whose dependencies do not equal the same-run evidence and authority identities", () => {
  const baseline = rows();
  const artifactRef = ref(baseline.artifact.artifact);
  const mismatchedEvidenceRisk = createArtifactRiskAssessment({
    artifact: artifactRef,
    assessmentId: "risk-coordinator-mismatch-evidence",
    assessedAt: at,
    evidence: { attestationId: "evidence-other", inputIdentity: digest("e") },
    authority: {
      assessmentId: recordId(baseline.authority.assessment),
      inputIdentity: baseline.authority.inputIdentity,
    },
    conflictInputIdentity: digest("4"),
    class: "observe_or_notify",
    reasons: [],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  });
  const mismatchedAuthorityRisk = createArtifactRiskAssessment({
    artifact: artifactRef,
    assessmentId: "risk-coordinator-mismatch-authority",
    assessedAt: at,
    evidence: {
      attestationId: recordId(baseline.evidence.assessment),
      inputIdentity: baseline.evidence.inputIdentity,
    },
    authority: { assessmentId: "authority-other", inputIdentity: digest("a") },
    conflictInputIdentity: digest("5"),
    class: "observe_or_notify",
    reasons: [],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  });

  for (const assessment of [mismatchedEvidenceRisk, mismatchedAuthorityRisk]) {
    const env = coordinator({ risk: new AssessmentStub(row(assessment), "risk", []) });
    assert.throws(
      () => env.coordinator.refresh(artifactRef),
      (error: unknown) => error instanceof ArtifactMutationCoordinatorError
        && error.stage === "risk"
        && error.code === "registry_mismatch",
    );
  }
});

test("normalizes every producer-stage failure and stops the remaining pipeline", () => {
  const stages = ["artifact", "evidence", "authority", "risk"] as const;
  for (const stage of stages) {
    const failure = { produce: () => { throw new Error("provider-native detail"); } };
    const env = stage === "artifact"
      ? coordinator({ artifact: failure })
      : stage === "evidence"
        ? coordinator({ evidence: failure })
        : stage === "authority"
          ? coordinator({ authority: failure })
          : coordinator({ risk: failure });
    assert.throws(
      () => env.coordinator.fromApprovedProposal({ proposalId: "proposal-coordinator-1", proposalRevision: 2 }),
      (error: unknown) => error instanceof ArtifactMutationCoordinatorError
        && error.stage === stage
        && error.code === "producer_failed"
        && !error.message.includes("provider-native detail"),
    );
    if (stage === "artifact") assert.equal(env.order.length, 0);
    if (stage === "evidence") assert.deepEqual(env.order, ["artifact"]);
    if (stage === "authority") assert.deepEqual(env.order, ["artifact", "evidence"]);
    if (stage === "risk") assert.deepEqual(env.order, ["artifact", "evidence", "authority"]);
  }
});

test("an explicit retry replays earlier stages after a partial immutable write", () => {
  const value = rows();
  const order: string[] = [];
  const authority: ArtifactMutationAuthorityProducer = {
    calls: 0,
    produce(input: ArtifactRef): ArtifactAssessmentEntry {
      this.calls += 1;
      order.push(`authority-${this.calls}`);
      if (this.calls === 1) throw new Error("authority write interrupted");
      return value.authority;
    },
  } as ArtifactMutationAuthorityProducer & { calls: number };
  const env = coordinator({ authority });

  assert.throws(
    () => env.coordinator.fromApprovedProposal({ proposalId: "proposal-coordinator-1", proposalRevision: 2 }),
    (error: unknown) => error instanceof ArtifactMutationCoordinatorError && error.stage === "authority",
  );
  const retry = env.coordinator.fromApprovedProposal({ proposalId: "proposal-coordinator-1", proposalRevision: 2 });

  assert.equal(retry.risk.assessmentId, recordId(value.risk.assessment));
  assert.equal((env.artifactProducer as ArtifactStub).calls.length, 2);
  assert.equal((env.evidenceProducer as AssessmentStub).calls.length, 2);
  assert.equal((env.riskProducer as AssessmentStub).calls.length, 1);
  assert.deepEqual(order, ["authority-1", "authority-2"]);
});

test("returns a deeply frozen metadata-only receipt and is stable across coordinator reconstruction", () => {
  const first = coordinator();
  const second = coordinator();
  const command = { proposalId: "proposal-coordinator-1", proposalRevision: 2 };
  const firstReceipt = first.coordinator.fromApprovedProposal(command);
  const secondReceipt = second.coordinator.fromApprovedProposal(command);

  assert.deepEqual(firstReceipt, secondReceipt);
  assert.equal(Object.isFrozen(firstReceipt), true);
  assert.equal(Object.isFrozen(firstReceipt.artifact), true);
  assert.equal(Object.isFrozen(firstReceipt.evidence), true);
  assert.equal(Object.isFrozen(firstReceipt.authority), true);
  assert.equal(Object.isFrozen(firstReceipt.risk), true);
  assert.equal("contentHash" in firstReceipt.artifact, true);
  assert.equal("content" in firstReceipt, false);
  assert.equal("watermarks" in firstReceipt, false);
  assert.equal("candidates" in firstReceipt, false);
  assert.throws(() => {
    (firstReceipt.artifact as { artifactId: string }).artifactId = "mutated";
  }, TypeError);
  assert.throws(() => {
    (firstReceipt.evidence as { inputIdentity: string }).inputIdentity = digest("f");
  }, TypeError);
});

test("constructor and method receivers are strict and expose only two commands", () => {
  const env = coordinator();
  assert.throws(
    () => new ArtifactMutationCoordinator({
      artifact: env.artifactProducer,
      evidence: env.evidenceProducer,
      authority: env.authorityProducer,
      risk: env.riskProducer,
      actor: "caller",
    } as never),
    TypeError,
  );
  assert.deepEqual(Object.getOwnPropertyNames(ArtifactMutationCoordinator.prototype), [
    "constructor",
    "fromApprovedProposal",
    "refresh",
  ]);
  const detached = env.coordinator.refresh;
  assert.throws(() => detached(ref(env.value.artifact.artifact)), TypeError);
});
