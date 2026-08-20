import assert from "node:assert/strict";
import test from "node:test";

import {
  createArtifactAuthorityAssessment,
  createArtifactEvidenceAttestation,
  type ArtifactAuthorityAssessment,
  type ArtifactEvidenceAttestation,
} from "./artifact-assessments.js";
import { ArtifactRegistry } from "./artifact-registry.js";
import {
  createArtifactRevision,
  type ArtifactContent,
  type ArtifactRef,
  type ArtifactRevision,
} from "./neutral-artifact.js";
import {
  ArtifactRiskProducer,
  ArtifactRiskProducerError,
  type ArtifactRiskRegistry,
  type ArtifactRiskConflictPort,
  type ArtifactRiskConflictResult,
} from "./artifact-risk-producer.js";

const capturedAt = "2026-08-20T04:00:00.000Z";
const watermark = {
  bridgeId: "bridge-risk-fixture",
  epochId: "epoch-risk-fixture",
  lastSeq: 18,
  lastSyncCompleteAt: "2026-08-20T03:59:00.000Z",
  freshness: "fresh" as const,
  gapCount: 0,
};

const deviceContent: ArtifactContent = {
  trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "08:00" },
  conditions: [],
  actions: [{ kind: "set_level", target: { hwCapabilityId: "hwc-cover-1" }, value: 0.5 }],
  rollback: { kind: "restore_previous_state", target: { hwCapabilityId: "hwc-cover-1" }, maxAgeSeconds: 900 },
  postconditions: [{
    kind: "capability_value",
    source: { hwCapabilityId: "hwc-cover-1" },
    operator: "equals",
    value: 0.5,
    withinSeconds: 120,
  }],
};

const notifyContent: ArtifactContent = {
  trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "08:00" },
  conditions: [],
  actions: [{ kind: "notify_local", message: "Review this household note." }],
  rollback: { kind: "no_remote_change" },
  postconditions: [],
};

function artifact(content: ArtifactContent = deviceContent, artifactId = "artifact-risk-fixture"): ArtifactRevision {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId,
    revision: 1,
    title: "Risk fixture",
    summary: "A bounded risk producer fixture.",
    sourceProposal: { proposalId: "proposal-risk-fixture", proposalRevision: 2 },
    content,
    createdAt: "2026-08-20T03:00:00.000Z",
  });
}

function ref(value: ArtifactRevision): ArtifactRef {
  return { artifactId: value.artifactId, revision: value.revision, contentHash: value.contentHash };
}

function evidenceAssessment(
  artifactRef: ArtifactRef,
  overrides: Partial<Parameters<typeof createArtifactEvidenceAttestation>[0]> = {},
): ArtifactEvidenceAttestation {
  return createArtifactEvidenceAttestation({
    artifact: artifactRef,
    attestationId: "evidence-risk-fixture",
    capturedAt,
    source: "home-world-consistent-cut",
    sourceProposal: { proposalId: "proposal-risk-fixture", proposalRevision: 2 },
    proposalEvidenceIdentity: `sha256:${"1".repeat(64)}`,
    selectedHwCapabilityIds: ["hwc-cover-1"],
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
    ...overrides,
  });
}

function authorityAssessment(
  artifactRef: ArtifactRef,
  overrides: Partial<Parameters<typeof createArtifactAuthorityAssessment>[0]> = {},
  scope: readonly string[] = ["hwc-cover-1"],
): ArtifactAuthorityAssessment {
  return createArtifactAuthorityAssessment({
    artifact: artifactRef,
    assessmentId: "authority-risk-fixture",
    assessedAt: capturedAt,
    authorityRegistryIdentity: `sha256:${"2".repeat(64)}`,
    candidates: scope.map((hwCapabilityId, index) => ({
      actionAuthorityCandidateId: index === 0 ? "candidate-risk-fixture" : `candidate-risk-fixture-${index}`,
      hwCapabilityId,
      status: "available" as const,
    })),
    checkedWatermarks: [watermark],
    ...overrides,
  }, { hwCapabilityIds: scope });
}

class StubConflictPort implements ArtifactRiskConflictPort {
  readonly calls: Array<{ artifact: ArtifactRef; hwCapabilityIds: readonly string[] }> = [];
  result: ArtifactRiskConflictResult = { status: "none", findings: [] };

  assess(input: { artifact: ArtifactRef; hwCapabilityIds: readonly string[] }): ArtifactRiskConflictResult {
    this.calls.push(input);
    return this.result;
  }
}

interface Environment {
  readonly producer: ArtifactRiskProducer;
  readonly registry: ArtifactRegistry;
  readonly conflict: StubConflictPort;
  readonly artifact: ArtifactRevision;
  readonly ref: ArtifactRef;
  readonly close: () => void;
}

function environment(
  content: ArtifactContent = deviceContent,
  options: {
    readonly evidence?: ArtifactEvidenceAttestation;
    readonly authority?: ArtifactAuthorityAssessment;
    readonly recordEvidence?: boolean;
    readonly recordAuthority?: boolean;
    readonly now?: () => string;
  } = {},
): Environment {
  const registry = new ArtifactRegistry({ path: ":memory:", now: () => capturedAt });
  const stored = registry.createDraft({ artifact: artifact(content), idempotencyKey: "artifact-risk-fixture:v1" });
  const artifactRef = ref(stored.artifact);
  const notifyOnly = content.actions.every((action) => action.kind === "notify_local");
  const capabilityIds = capabilityRefsForTest(content);
  const actionIds = actionCapabilityIdsForTest(content);
  const evidence = options.evidence ?? evidenceAssessment(
    artifactRef,
    { selectedHwCapabilityIds: capabilityIds },
  );
  const authority = options.authority ?? authorityAssessment(
    artifactRef,
    notifyOnly ? { candidates: [] } : {},
    notifyOnly ? [] : actionIds,
  );
  if (options.recordEvidence !== false) {
    registry.recordEvidenceAttestation({ assessment: evidence, idempotencyKey: "evidence-risk-fixture:v1" });
  }
  if (options.recordAuthority !== false) {
    registry.recordAuthorityAssessment({ assessment: authority, idempotencyKey: "authority-risk-fixture:v1" });
  }
  const conflict = new StubConflictPort();
  const producer = new ArtifactRiskProducer({
    registry,
    conflict,
    now: options.now ?? (() => capturedAt),
  });
  return {
    producer,
    registry,
    conflict,
    artifact: stored.artifact,
    ref: artifactRef,
    close: () => registry.close(),
  };
}

test("selects exact latest assessments and classifies a reversible device artifact", () => {
  const env = environment();
  try {
    const latestEvidence = evidenceAssessment(env.ref, {
      attestationId: "evidence-risk-latest",
      watermarks: [{ ...watermark, lastSeq: watermark.lastSeq + 1 }],
    });
    const latestAuthority = authorityAssessment(env.ref, {
      assessmentId: "authority-risk-latest",
      authorityRegistryIdentity: `sha256:${"4".repeat(64)}`,
      checkedWatermarks: [{ ...watermark, lastSeq: watermark.lastSeq + 1 }],
    });
    env.registry.recordEvidenceAttestation({ assessment: latestEvidence, idempotencyKey: "evidence-risk-latest:v1" });
    env.registry.recordAuthorityAssessment({ assessment: latestAuthority, idempotencyKey: "authority-risk-latest:v1" });
    const first = env.producer.produce(env.ref);

    assert.equal(first.kind, "risk-assessment");
    assert.equal(first.assessment.class, "comfort_reversible");
    assert.equal(first.assessment.requiresHumanApproval, true);
    assert.equal(first.assessment.policyId, "policy-home-v1");
    assert.equal(first.assessment.policyVersion, "1.0.0");
    assert.equal(first.assessment.evidence.attestationId, "evidence-risk-latest");
    assert.equal(first.assessment.authority.assessmentId, "authority-risk-latest");
    assert.deepEqual(env.conflict.calls, [{ artifact: env.ref, hwCapabilityIds: ["hwc-cover-1"] }]);
    assert.equal(JSON.stringify(first).includes("foreign_rule"), false);
  } finally {
    env.close();
  }
});

test("classifies notify-only artifacts with no authority candidate", () => {
  const env = environment(notifyContent);
  try {
    const entry = env.producer.produce(env.ref);
    assert.equal(entry.assessment.class, "observe_or_notify");
    assert.deepEqual(entry.assessment.authority, {
      assessmentId: "authority-risk-fixture",
      inputIdentity: entry.assessment.authority.inputIdentity,
    });
    assert.equal(env.conflict.calls[0]?.hwCapabilityIds.length, 0);
  }
  finally { env.close(); }
});

test("rejects caller-supplied risk identity, reasons, class, and conflict input", () => {
  const env = environment();
  try {
    assert.throws(
      () => env.producer.produce({ ...env.ref, class: "observe_or_notify", reasons: [], conflictInputIdentity: "x" } as never),
      (error: unknown) => error instanceof ArtifactRiskProducerError && error.code === "invalid_input",
    );
    assert.equal(env.conflict.calls.length, 0);
  } finally {
    env.close();
  }
});

test("fails closed when evidence is missing, partial, or unavailable", () => {
  const noEvidence = environment(deviceContent, { recordEvidence: false });
  try {
    assert.throws(
      () => noEvidence.producer.produce(noEvidence.ref),
      (error: unknown) => error instanceof ArtifactRiskProducerError && error.code === "assessment_unavailable",
    );
  } finally {
    noEvidence.close();
  }

  const partial = environment(deviceContent, { recordEvidence: false });
  try {
    partial.registry.recordEvidenceAttestation({
      assessment: evidenceAssessment(partial.ref, {
        coverage: "partial",
        reasons: ["history_gap"],
        watermarks: [{ ...watermark, freshness: "stale", gapCount: 1 }],
      }),
      idempotencyKey: "evidence-risk-partial:v1",
    });
    assert.throws(
      () => partial.producer.produce(partial.ref),
      (error: unknown) => error instanceof ArtifactRiskProducerError && error.code === "assessment_unavailable",
    );
  } finally {
    partial.close();
  }
});

test("fails closed when authority scope is incomplete or unavailable", () => {
  const env = environment();
  try {
    const incomplete = createArtifactAuthorityAssessment({
      artifact: env.ref,
      assessmentId: "authority-incomplete",
      assessedAt: capturedAt,
      authorityRegistryIdentity: `sha256:${"3".repeat(64)}`,
      candidates: [],
      checkedWatermarks: [watermark],
    }, { hwCapabilityIds: [] });
    env.registry.recordAuthorityAssessment({ assessment: incomplete, idempotencyKey: "authority-incomplete:v1" });
    assert.throws(
      () => env.producer.produce(env.ref),
      (error: unknown) => error instanceof ArtifactRiskProducerError && error.code === "assessment_unavailable",
    );

    const unavailable = authorityAssessment(env.ref, {
      assessmentId: "authority-unavailable",
      candidates: [{
        actionAuthorityCandidateId: "candidate-risk-fixture",
        hwCapabilityId: "hwc-cover-1",
        status: "unavailable",
      }],
    });
    env.registry.recordAuthorityAssessment({ assessment: unavailable, idempotencyKey: "authority-unavailable:v1" });
    assert.throws(
      () => env.producer.produce(env.ref),
      (error: unknown) => error instanceof ArtifactRiskProducerError && error.code === "assessment_unavailable",
    );
  } finally {
    env.close();
  }
});

test("fails closed for blocking and unavailable conflicts", () => {
  for (const result of [
    {
      status: "duplicate" as const,
      findings: [{ kind: "existing_artifact" as const, severity: "blocking" as const, reason: "existing_artifact" as const }],
    },
    {
      status: "unavailable" as const,
      findings: [{ kind: "stale_evidence" as const, severity: "warning" as const, reason: "stale_evidence" as const }],
    },
  ]) {
    const env = environment();
    try {
      env.conflict.result = result;
      assert.throws(
        () => env.producer.produce(env.ref),
        (error: unknown) => error instanceof ArtifactRiskProducerError && (
          error.code === "conflict_blocked" || error.code === "conflict_unavailable"
        ),
      );
    } finally {
      env.close();
    }
  }
});

test("uses a deterministic conflict identity and returns the same immutable row on replay", () => {
  const env = environment();
  try {
    const first = env.producer.produce(env.ref);
    const second = env.producer.produce(env.ref);
    assert.deepEqual(second, first);
    assert.equal(env.registry.listAttestations({ kind: "risk-assessment", artifact: env.ref }).length, 1);

    env.conflict.result = {
      status: "possible_overlap",
      findings: [{ kind: "foreign_rule", severity: "warning", reason: "foreign_rule" }],
    };
    const changed = env.producer.produce(env.ref);
    assert.notEqual(changed.assessment.conflictInputIdentity, first.assessment.conflictInputIdentity);
    assert.notEqual(changed.assessment.inputIdentity, first.assessment.inputIdentity);
    assert.equal(env.registry.listAttestations({ kind: "risk-assessment", artifact: env.ref }).length, 2);
  } finally {
    env.close();
  }
});

test("rejects assessment rows whose artifact ref is not exact", () => {
  const env = environment();
  try {
    const original = env.registry.latestAttestation.bind(env.registry);
    (env.registry as unknown as { latestAttestation: typeof original }).latestAttestation = ((query) => {
      const entry = original(query);
      return entry === undefined ? undefined : {
        ...entry,
        artifact: { ...entry.artifact, artifactId: "other-artifact" },
      };
    }) as typeof original;
    assert.throws(
      () => env.producer.produce(env.ref),
      (error: unknown) => error instanceof ArtifactRiskProducerError && error.code === "assessment_unavailable",
    );
  } finally {
    env.close();
  }
});

test("replays the original risk row when the Hub clock advances", () => {
  let tick = 0;
  const env = environment(deviceContent, {
    now: () => tick++ === 0 ? capturedAt : "2026-08-20T05:00:00.000Z",
  });
  try {
    const first = env.producer.produce(env.ref);
    const replay = env.producer.produce(env.ref);

    assert.deepEqual(replay, first);
    assert.equal(env.registry.listAttestations({ kind: "risk-assessment", artifact: env.ref }).length, 1);
    assert.equal(first.assessment.assessedAt, capturedAt);
  } finally {
    env.close();
  }
});

test("binds evidence conflict scope to trigger, condition, action, rollback, and postcondition references", () => {
  const content: ArtifactContent = {
    trigger: { kind: "capability_changed", source: { hwCapabilityId: "hwc-trigger" } },
    conditions: [{
      kind: "capability_value",
      source: { hwCapabilityId: "hwc-condition" },
      operator: "equals",
      value: true,
    }],
    actions: [{ kind: "set_boolean", target: { hwCapabilityId: "hwc-action" }, value: true }],
    rollback: { kind: "restore_previous_state", target: { hwCapabilityId: "hwc-action" }, maxAgeSeconds: 900 },
    postconditions: [{
      kind: "capability_value",
      source: { hwCapabilityId: "hwc-action" },
      operator: "equals",
      value: true,
      withinSeconds: 120,
    }],
  };
  const incomplete = environment(content, { recordEvidence: false });
  try {
    incomplete.registry.recordEvidenceAttestation({
      assessment: evidenceAssessment(incomplete.ref, { selectedHwCapabilityIds: ["hwc-action"] }),
      idempotencyKey: "evidence-risk-incomplete-scope:v1",
    });
    assert.throws(
      () => incomplete.producer.produce(incomplete.ref),
      (error: unknown) => error instanceof ArtifactRiskProducerError && error.code === "assessment_unavailable",
    );
  } finally {
    incomplete.close();
  }

  const env = environment(content);
  try {
    env.producer.produce(env.ref);
    assert.deepEqual(env.conflict.calls[0]?.hwCapabilityIds, ["hwc-action", "hwc-condition", "hwc-trigger"]);
  } finally {
    env.close();
  }
});

test("replays an older exact risk identity after a newer risk row exists", () => {
  let tick = 0;
  const env = environment(deviceContent, {
    now: () => [
      "2026-08-20T04:00:00.000Z",
      "2026-08-20T05:00:00.000Z",
      "2026-08-20T06:00:00.000Z",
    ][tick++] ?? "2026-08-20T07:00:00.000Z",
  });
  try {
    const first = env.producer.produce(env.ref);
    env.conflict.result = {
      status: "possible_overlap",
      findings: [{ kind: "foreign_rule", severity: "warning", reason: "foreign_rule" }],
    };
    env.producer.produce(env.ref);
    env.conflict.result = { status: "none", findings: [] };
    const replay = env.producer.produce(env.ref);

    assert.deepEqual(replay, first);
    assert.equal(env.registry.listAttestations({ kind: "risk-assessment", artifact: env.ref }).length, 2);
  } finally {
    env.close();
  }
});

test("returns a race winner when another writer commits before the local insert reports failure", () => {
  const env = environment();
  try {
    const raceRegistry = new InsertThenThrowRiskRegistry(env.registry);
    const producer = new ArtifactRiskProducer({
      registry: raceRegistry,
      conflict: env.conflict,
      now: () => capturedAt,
    });
    const result = producer.produce(env.ref);

    assert.equal(result.kind, "risk-assessment");
    assert.equal(env.registry.listAttestations({ kind: "risk-assessment", artifact: env.ref }).length, 1);
  } finally {
    env.close();
  }
});

class InsertThenThrowRiskRegistry implements ArtifactRiskRegistry {
  private injected = false;

  constructor(private readonly inner: ArtifactRegistry) {}

  getRevision(...args: Parameters<ArtifactRegistry["getRevision"]>): ReturnType<ArtifactRegistry["getRevision"]> {
    return this.inner.getRevision(...args);
  }

  latestAttestation(...args: Parameters<ArtifactRegistry["latestAttestation"]>): ReturnType<ArtifactRegistry["latestAttestation"]> {
    return this.inner.latestAttestation(...args);
  }

  attestationByInputIdentity(...args: Parameters<ArtifactRegistry["attestationByInputIdentity"]>): ReturnType<ArtifactRegistry["attestationByInputIdentity"]> {
    return this.inner.attestationByInputIdentity(...args);
  }

  recordRiskAssessment(...args: Parameters<ArtifactRegistry["recordRiskAssessment"]>): ReturnType<ArtifactRegistry["recordRiskAssessment"]> {
    const result = this.inner.recordRiskAssessment(...args);
    if (!this.injected) {
      this.injected = true;
      throw new Error("simulated post-commit race");
    }
    return result;
  }
}

function capabilityRefsForTest(content: ArtifactContent): string[] {
  const ids = new Set<string>();
  if (content.trigger.kind === "capability_changed") ids.add(content.trigger.source.hwCapabilityId);
  for (const condition of content.conditions) ids.add(condition.source.hwCapabilityId);
  for (const action of content.actions) {
    if (action.kind !== "notify_local") ids.add(action.target.hwCapabilityId);
  }
  if (content.rollback.kind === "restore_previous_state") ids.add(content.rollback.target.hwCapabilityId);
  for (const postcondition of content.postconditions) ids.add(postcondition.source.hwCapabilityId);
  return [...ids].sort();
}

function actionCapabilityIdsForTest(content: ArtifactContent): string[] {
  return [...new Set(content.actions
    .filter((action) => action.kind !== "notify_local")
    .map((action) => action.target.hwCapabilityId))].sort();
}
