import assert from "node:assert/strict";
import test from "node:test";

import {
  HOME_WORLD_EVIDENCE_COVERAGE_REASONS,
  ArtifactAssessmentError,
  artifactAuthorityAssessmentSchema,
  artifactEvidenceAttestationSchema,
  artifactRiskAssessmentSchema,
  canonicalAssessmentInput,
  computeConflictInputIdentity,
  computeAssessmentInputIdentity,
  computeProposalEvidenceIdentity,
  createArtifactAuthorityAssessment,
  createArtifactEvidenceAttestation,
  createArtifactRiskAssessment,
  parseArtifactAuthorityAssessment,
  parseArtifactEvidenceAttestation,
  parseArtifactRiskAssessment,
  preflightAssessmentInput,
} from "./artifact-assessments.js";
import type { HomeWorldEvidenceCoverageReason } from "./home-world-service.js";

type MissingCoverageReason = Exclude<
  HomeWorldEvidenceCoverageReason,
  typeof HOME_WORLD_EVIDENCE_COVERAGE_REASONS[number]
>;
const coverageReasonSetIsComplete: MissingCoverageReason extends never ? true : never = true;
void coverageReasonSetIsComplete;

const artifact = {
  artifactId: "artifact-curtain-1",
  revision: 1,
  contentHash: `sha256:${"a".repeat(64)}`,
};

const watermark = {
  bridgeId: "bridge-1",
  epochId: "epoch-1",
  lastSeq: 42,
  lastSyncCompleteAt: "2026-08-20T00:59:00.000Z",
  freshness: "fresh" as const,
  gapCount: 0,
};

const sourceProposal = { proposalId: "proposal-17", proposalRevision: 2 };
const proposalEvidenceIdentity = `sha256:${"b".repeat(64)}`;
const selectedHwCapabilityIds = ["hwc-curtain-level"];
const evidenceBindings = { sourceProposal, proposalEvidenceIdentity, selectedHwCapabilityIds };
const riskBindings = {
  evidence: { attestationId: "evidence-1", inputIdentity: `sha256:${"e".repeat(64)}` },
  authority: { assessmentId: "authority-1", inputIdentity: `sha256:${"d".repeat(64)}` },
  conflictInputIdentity: `sha256:${"c".repeat(64)}`,
};
const authorityBindings = { authorityRegistryIdentity: `sha256:${"d".repeat(64)}` };

test("creates a strict evidence attestation with the closed coverage reason set", () => {
  const result = createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-1",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  });

  assert.equal(result.kind, "evidence-attestation");
  assert.equal(result.inputIdentity, computeAssessmentInputIdentity("evidence", {
    artifact,
    source: result.source,
    sourceProposal: result.sourceProposal,
    proposalEvidenceIdentity: result.proposalEvidenceIdentity,
    selectedHwCapabilityIds: result.selectedHwCapabilityIds,
    watermarks: result.watermarks,
    coverage: result.coverage,
    reasons: result.reasons,
  }));
  assert.equal(Object.isFrozen(result.watermarks), true);
  assert.equal(Object.isFrozen(result.watermarks[0]), true);
  assert.equal(Object.isFrozen(result.reasons), true);
  assert.deepEqual(artifactEvidenceAttestationSchema.parse(result), result);
  assert.throws(() => artifactEvidenceAttestationSchema.parse({
    ...result,
    inputIdentity: `sha256:${"0".repeat(64)}`,
  }));
  assert.throws(() => artifactEvidenceAttestationSchema.parse({
    ...result,
    providerSecret: "must-not-cross",
  }), /unrecognized|unknown/i);
});

test("rejects evidence with an unknown coverage reason, duplicate bridge, or dishonest coverage", () => {
  assert.throws(() => createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-bad-reason",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "partial",
    reasons: ["vendor_secret_reason" as never],
  }));

  assert.throws(() => createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-duplicate-bridge",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark, { ...watermark, epochId: "epoch-2" }],
    coverage: "complete",
    reasons: [],
  }));

  assert.throws(() => createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-dishonest",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "partial",
    reasons: [],
  }));

  assert.throws(() => createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-stale-complete",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [{ ...watermark, freshness: "stale", gapCount: 1 }],
    coverage: "complete",
    reasons: [],
  }));
});

test("creates only Hub-owned risk classes and forces human approval", () => {
  const result = createArtifactRiskAssessment({
    ...riskBindings,
    artifact,
    assessmentId: "risk-1",
    assessedAt: "2026-08-20T01:00:00.000Z",
    class: "comfort_reversible",
    reasons: ["Bounded reversible level change with restore."],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  });

  assert.equal(result.requiresHumanApproval, true);
  assert.deepEqual(artifactRiskAssessmentSchema.parse(result), result);
  assert.throws(() => createArtifactRiskAssessment({
    ...riskBindings,
    artifact,
    assessmentId: "risk-model-claimed",
    assessedAt: "2026-08-20T01:00:00.000Z",
    class: "low" as never,
    reasons: ["model says safe"],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
    requiresHumanApproval: false,
  } as never));
});

test("creates authority candidates scoped only to Hub capability IDs", () => {
  const result = createArtifactAuthorityAssessment({
    ...authorityBindings,
    artifact,
    assessmentId: "authority-1",
    assessedAt: "2026-08-20T01:00:00.000Z",
    candidates: [{
      actionAuthorityCandidateId: "candidate-1",
      hwCapabilityId: "hwc-curtain-level",
      status: "available",
    }],
    checkedWatermarks: [watermark],
  }, { hwCapabilityIds: ["hwc-curtain-level"] });

  assert.equal(result.candidates[0]?.hwCapabilityId, "hwc-curtain-level");
  assert.equal(Object.isFrozen(result.candidates), true);
  assert.equal(Object.isFrozen(result.candidates[0]), true);
  assert.equal(Object.isFrozen(result.checkedWatermarks), true);
  assert.equal(Object.isFrozen(result.checkedWatermarks[0]), true);
  assert.deepEqual(artifactAuthorityAssessmentSchema.parse(result), result);
  assert.throws(() => createArtifactAuthorityAssessment({
    ...authorityBindings,
    artifact,
    assessmentId: "authority-route-leak",
    assessedAt: "2026-08-20T01:00:00.000Z",
    candidates: [{
      actionAuthorityCandidateId: "candidate-route-leak",
      hwCapabilityId: "hwc-curtain-level",
      status: "available",
      bridgeId: "bridge-1",
      nativeId: "entity.cover",
      adapterType: "home-assistant",
      remoteInstanceId: "remote-1",
      secret: "token",
    } as never],
    checkedWatermarks: [watermark],
  }, { hwCapabilityIds: ["hwc-curtain-level"] }));

  assert.throws(() => createArtifactAuthorityAssessment({
    ...authorityBindings,
    artifact,
    assessmentId: "authority-duplicate-watermark-bridge",
    assessedAt: "2026-08-20T01:00:00.000Z",
    candidates: [],
    checkedWatermarks: [watermark, { ...watermark, epochId: "epoch-2" }],
  }, { hwCapabilityIds: ["hwc-curtain-level"] }));
});

test("requires an explicit, bounded authority capability scope", () => {
  assert.throws(() => (createArtifactAuthorityAssessment as (...args: never[]) => unknown)({
    ...authorityBindings,
    artifact,
    assessmentId: "authority-missing-scope",
    assessedAt: "2026-08-20T01:00:00.000Z",
    candidates: [],
    checkedWatermarks: [watermark],
  }));

  assert.throws(() => createArtifactAuthorityAssessment({
    ...authorityBindings,
    artifact,
    assessmentId: "authority-duplicate-scope",
    assessedAt: "2026-08-20T01:00:00.000Z",
    candidates: [],
    checkedWatermarks: [watermark],
  }, { hwCapabilityIds: ["hwc-1", "hwc-1"] }));
});

test("rejects duplicate authority candidates and oversized assessment input", () => {
  assert.throws(() => createArtifactAuthorityAssessment({
    ...authorityBindings,
    artifact,
    assessmentId: "authority-duplicates",
    assessedAt: "2026-08-20T01:00:00.000Z",
    candidates: [
      { actionAuthorityCandidateId: "candidate-1", hwCapabilityId: "hwc-1", status: "available" },
      { actionAuthorityCandidateId: "candidate-1", hwCapabilityId: "hwc-2", status: "available" },
    ],
    checkedWatermarks: [watermark],
  }, { hwCapabilityIds: ["hwc-1", "hwc-2"] }));

  assert.throws(() => createArtifactRiskAssessment({
    ...riskBindings,
    artifact,
    assessmentId: "risk-too-many-reasons",
    assessedAt: "2026-08-20T01:00:00.000Z",
    class: "observe_or_notify",
    reasons: Array.from({ length: 11 }, (_, index) => `reason-${index}`),
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  }));
});

test("rejects identifier whitespace instead of normalizing it and enforces UTF-8 byte bounds", () => {
  assert.throws(() => createArtifactRiskAssessment({
    ...riskBindings,
    artifact,
    assessmentId: " risk-whitespace ",
    assessedAt: "2026-08-20T01:00:00.000Z",
    class: "observe_or_notify",
    reasons: ["Local notification only."],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  }));

  assert.throws(() => createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-whitespace ",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  }));

  // 51 four-byte UTF-8 code points exceed 200 bytes but are under 200 UTF-16 units.
  assert.throws(() => createArtifactRiskAssessment({
    ...riskBindings,
    artifact,
    assessmentId: "risk-utf8-bound",
    assessedAt: "2026-08-20T01:00:00.000Z",
    class: "observe_or_notify",
    reasons: ["Local notification only."],
    policyId: "😀".repeat(51),
    policyVersion: "1.0.0",
  }));
});

test("preserves bounded reason text and rejects reason edge whitespace", () => {
  const reason = "Keep the household note exactly as authored: café.";
  const result = createArtifactRiskAssessment({
    ...riskBindings,
    artifact,
    assessmentId: "risk-reason-text",
    assessedAt: "2026-08-20T01:00:00.000Z",
    class: "observe_or_notify",
    reasons: [reason],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  });

  assert.equal(result.reasons[0], reason);
  assert.throws(() => createArtifactRiskAssessment({
    ...riskBindings,
    artifact,
    assessmentId: "risk-reason-leading-space",
    assessedAt: "2026-08-20T01:00:00.000Z",
    class: "observe_or_notify",
    reasons: [" reason"],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  }));
  assert.throws(() => createArtifactRiskAssessment({
    ...riskBindings,
    artifact,
    assessmentId: "risk-reason-trailing-space",
    assessedAt: "2026-08-20T01:00:00.000Z",
    class: "observe_or_notify",
    reasons: ["reason "],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  }));
});

test("preflights resource limits and unsafe shapes before nested schema admission", () => {
  const assertRejected = (payload: unknown, code: ArtifactAssessmentError["code"]) => assert.throws(
    () => preflightAssessmentInput(payload),
    (error: unknown) => error instanceof ArtifactAssessmentError && error.code === code,
  );

  assertRejected({ ...createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-preflight-array",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  }), unknownArray: Array.from({ length: 65 }, () => "x") }, "resource_exhausted");

  const tooManyFields: Record<string, unknown> = {};
  for (let index = 0; index < 129; index += 1) tooManyFields[`field-${index}`] = index;
  assertRejected({ ...createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-preflight-fields",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  }), unknownFields: tooManyFields }, "resource_exhausted");

  const tooManyArrayItems = Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => [`array-${index}`, Array.from({ length: 64 }, () => "x")]),
  );
  assertRejected({ ...createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-preflight-array-total",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  }), unknownArrayTotals: tooManyArrayItems }, "resource_exhausted");

  const tooManyStringBytes = Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => [`string-${index}`, "x".repeat(16_000)]),
  );
  assertRejected({ ...createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-preflight-string-total",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  }), unknownStringTotals: tooManyStringBytes }, "resource_exhausted");

  const tooDeep: Record<string, unknown> = {};
  let cursor = tooDeep;
  for (let index = 0; index < 20; index += 1) {
    cursor.next = {};
    cursor = cursor.next as Record<string, unknown>;
  }
  assertRejected({ ...createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-preflight-depth",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  }), unknownDepth: tooDeep }, "resource_exhausted");

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assertRejected({ ...createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-preflight-cycle",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  }), unknownCycle: cyclic }, "invalid_assessment");

  assertRejected({ ...createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-preflight-undefined",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  }), unknownUndefined: undefined }, "invalid_assessment");
  assertRejected({ ...createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-preflight-nonfinite",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  }), unknownNonfinite: Number.NaN }, "invalid_assessment");
});

test("exported schema safeParse converts preflight failures into ordinary validation failures", () => {
  const valid = createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-safe-parse",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  });
  const unsafeInputs: unknown[] = [
    { ...valid, unknownArray: Array.from({ length: 65 }, () => "x") },
    { ...valid, unknownDepth: { next: { next: { next: { next: { next: { next: { next: { next: { next: { next: {} } } } } } } } } } } },
    (() => {
      const cycle: Record<string, unknown> = {};
      cycle.self = cycle;
      return { ...valid, unknownCycle: cycle };
    })(),
    { ...valid, unknownUndefined: undefined },
  ];

  for (const input of unsafeInputs) {
    let result: ReturnType<typeof artifactEvidenceAttestationSchema.safeParse> | undefined;
    assert.doesNotThrow(() => {
      result = artifactEvidenceAttestationSchema.safeParse(input);
    });
    assert.equal(result?.success, false);
  }
});

test("canonical input identity is key-order stable but changes with dynamic inputs", () => {
  const first = {
    artifact,
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  };
  const reordered = {
    reasons: [],
    coverage: "complete",
    watermarks: [{ ...watermark }],
    artifact: { ...artifact },
  };

  assert.equal(canonicalAssessmentInput(first), canonicalAssessmentInput(reordered));
  assert.equal(
    computeAssessmentInputIdentity("evidence", first),
    computeAssessmentInputIdentity("evidence", reordered),
  );
  assert.notEqual(
    computeAssessmentInputIdentity("evidence", first),
    computeAssessmentInputIdentity("evidence", {
      ...first,
      watermarks: [{ ...watermark, lastSeq: 43 }],
    }),
  );
  assert.match(computeAssessmentInputIdentity("evidence", first), /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => computeAssessmentInputIdentity("authority", {
    artifact,
    secret: "must-not-be-hashed",
  }));
});

test("domain-separates proposal evidence and conflict digests while rejecting forbidden keys", () => {
  const input = { references: [{ capabilityId: "hwc-curtain-level" }], complete: true };
  assert.notEqual(computeProposalEvidenceIdentity(input), computeConflictInputIdentity(input));
  assert.match(computeProposalEvidenceIdentity(input), /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => computeProposalEvidenceIdentity({ nativeId: "entity.cover" }));
  assert.throws(() => computeConflictInputIdentity({ secret: "not-for-hashing" }));
});

test("dynamic evidence refreshes change only the attestation identity, not the artifact ref", () => {
  const first = createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-refresh-1",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  });
  const refreshed = createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact: first.artifact,
    attestationId: "evidence-refresh-2",
    capturedAt: "2026-08-20T01:05:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [{ ...watermark, lastSeq: 43 }],
    coverage: "complete",
    reasons: [],
  });

  assert.notEqual(refreshed.inputIdentity, first.inputIdentity);
  assert.deepEqual(refreshed.artifact, first.artifact);
  assert.equal(refreshed.artifact.contentHash, artifact.contentHash);
});

test("dynamic watermark, gap, policy, and candidate status inputs get new identities", () => {
  const evidence = (next: Partial<typeof watermark>, coverage: "complete" | "partial", reasons: readonly string[]) =>
    createArtifactEvidenceAttestation({
      ...evidenceBindings,
      artifact,
      attestationId: "evidence-property",
      capturedAt: "2026-08-20T01:00:00.000Z",
      source: "home-world-consistent-cut",
      watermarks: [{ ...watermark, ...next }],
      coverage,
      reasons,
    });
  const complete = evidence({ lastSeq: 43 }, "complete", []);
  const watermarkChanged = evidence({ lastSeq: 44 }, "complete", []);
  const gapChanged = evidence({ gapCount: 1, freshness: "stale" }, "partial", ["history_gap"]);
  const gapChangedAgain = evidence({ gapCount: 2, freshness: "stale" }, "partial", ["history_gap"]);

  assert.notEqual(complete.inputIdentity, watermarkChanged.inputIdentity);
  assert.notEqual(gapChanged.inputIdentity, gapChangedAgain.inputIdentity);
  assert.deepEqual(complete.artifact, artifact);
  assert.deepEqual(gapChanged.artifact, artifact);

  const risk = (policyVersion: string) => createArtifactRiskAssessment({
    ...riskBindings,
    artifact,
    assessmentId: "risk-property",
    assessedAt: "2026-08-20T01:00:00.000Z",
    class: "observe_or_notify",
    reasons: ["Local notification only."],
    policyId: "policy-home-v1",
    policyVersion,
  });
  const riskOne = risk("1.0.0");
  const riskTwo = risk("1.1.0");
  assert.notEqual(riskOne.inputIdentity, riskTwo.inputIdentity);
  assert.deepEqual(riskOne.artifact, artifact);

  const authority = (status: "available" | "unavailable") => createArtifactAuthorityAssessment({
    ...authorityBindings,
    artifact,
    assessmentId: "authority-property",
    assessedAt: "2026-08-20T01:00:00.000Z",
    candidates: [{ actionAuthorityCandidateId: "candidate-property", hwCapabilityId: "hwc-curtain-level", status }],
    checkedWatermarks: [watermark],
  }, { hwCapabilityIds: ["hwc-curtain-level"] });
  const authorityAvailable = authority("available");
  const authorityUnavailable = authority("unavailable");
  assert.notEqual(authorityAvailable.inputIdentity, authorityUnavailable.inputIdentity);
  assert.deepEqual(authorityAvailable.artifact, artifact);
});

test("canonicalizes watermark and candidate vectors independent of caller array order", () => {
  const firstWatermark = { ...watermark, bridgeId: "bridge-a" };
  const secondWatermark = { ...watermark, bridgeId: "bridge-b" };
  const evidenceFirst = createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-order-1",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [secondWatermark, firstWatermark],
    coverage: "complete",
    reasons: [],
  });
  const evidenceSecond = createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-order-2",
    capturedAt: "2026-08-20T01:01:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [firstWatermark, secondWatermark],
    coverage: "complete",
    reasons: [],
  });

  assert.equal(evidenceFirst.inputIdentity, evidenceSecond.inputIdentity);
  assert.deepEqual(evidenceFirst.watermarks.map((item) => item.bridgeId), ["bridge-a", "bridge-b"]);

  const authorityFirst = createArtifactAuthorityAssessment({
    ...authorityBindings,
    artifact,
    assessmentId: "authority-order-1",
    assessedAt: "2026-08-20T01:00:00.000Z",
    candidates: [
      { actionAuthorityCandidateId: "candidate-b", hwCapabilityId: "hwc-b", status: "available" },
      { actionAuthorityCandidateId: "candidate-a", hwCapabilityId: "hwc-a", status: "available" },
    ],
    checkedWatermarks: [secondWatermark, firstWatermark],
  }, { hwCapabilityIds: ["hwc-a", "hwc-b"] });
  const authoritySecond = createArtifactAuthorityAssessment({
    ...authorityBindings,
    artifact,
    assessmentId: "authority-order-2",
    assessedAt: "2026-08-20T01:01:00.000Z",
    candidates: [
      { actionAuthorityCandidateId: "candidate-a", hwCapabilityId: "hwc-a", status: "available" },
      { actionAuthorityCandidateId: "candidate-b", hwCapabilityId: "hwc-b", status: "available" },
    ],
    checkedWatermarks: [firstWatermark, secondWatermark],
  }, { hwCapabilityIds: ["hwc-a", "hwc-b"] });

  assert.equal(authorityFirst.inputIdentity, authoritySecond.inputIdentity);
  assert.deepEqual(authorityFirst.candidates.map((item) => item.actionAuthorityCandidateId), ["candidate-a", "candidate-b"]);
  assert.deepEqual(authorityFirst.checkedWatermarks.map((item) => item.bridgeId), ["bridge-a", "bridge-b"]);

  const unsortedEvidence = {
    ...evidenceFirst,
    watermarks: [...evidenceFirst.watermarks].reverse(),
  };
  assert.throws(() => artifactEvidenceAttestationSchema.parse(unsortedEvidence));
  assert.throws(() => parseArtifactEvidenceAttestation(unsortedEvidence));

  const unsortedAuthority = {
    ...authorityFirst,
    candidates: [...authorityFirst.candidates].reverse(),
    checkedWatermarks: [...authorityFirst.checkedWatermarks].reverse(),
  };
  assert.throws(() => artifactAuthorityAssessmentSchema.parse(unsortedAuthority));
  assert.throws(() => parseArtifactAuthorityAssessment(unsortedAuthority));
});

test("authority candidate scope is explicit and rejects candidates for another capability", () => {
  assert.throws(() => createArtifactAuthorityAssessment({
    ...authorityBindings,
    artifact,
    assessmentId: "authority-out-of-scope",
    assessedAt: "2026-08-20T01:00:00.000Z",
    candidates: [{
      actionAuthorityCandidateId: "candidate-other",
      hwCapabilityId: "hwc-other",
      status: "available",
    }],
    checkedWatermarks: [watermark],
  }, { hwCapabilityIds: ["hwc-curtain-level"] }));
});

test("assessment outputs are immutable and never mutate the bound artifact ref", () => {
  const result = createArtifactRiskAssessment({
    ...riskBindings,
    artifact,
    assessmentId: "risk-frozen",
    assessedAt: "2026-08-20T01:00:00.000Z",
    class: "observe_or_notify",
    reasons: ["Local notification only."],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  });

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.artifact), true);
  assert.equal(Object.isFrozen(result.reasons), true);
  assert.throws(() => {
    (result.artifact as { revision: number }).revision = 2;
  }, TypeError);
  assert.equal(result.artifact.revision, 1);
});

test("binds evidence to the approved proposal evidence and canonical selected capability ids", () => {
  const result = createArtifactEvidenceAttestation({
    artifact,
    attestationId: "evidence-proposal-binding",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    sourceProposal: { proposalId: "proposal-17", proposalRevision: 2 },
    proposalEvidenceIdentity: `sha256:${"b".repeat(64)}`,
    selectedHwCapabilityIds: ["hwc-z", "hwc-a"],
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  } as never);

  assert.deepEqual(result.sourceProposal, { proposalId: "proposal-17", proposalRevision: 2 });
  assert.equal(result.proposalEvidenceIdentity, `sha256:${"b".repeat(64)}`);
  assert.deepEqual(result.selectedHwCapabilityIds, ["hwc-a", "hwc-z"]);
});

test("changes evidence, risk, and authority identity for every newly bound dependency", () => {
  const evidence = createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-binding-identity",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  });
  const evidenceWithProposalChange = createArtifactEvidenceAttestation({
    ...evidenceBindings,
    sourceProposal: { proposalId: "proposal-other", proposalRevision: 2 },
    artifact,
    attestationId: "evidence-binding-identity-proposal",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  });
  const evidenceWithProposalEvidenceChange = createArtifactEvidenceAttestation({
    ...evidenceBindings,
    proposalEvidenceIdentity: `sha256:${"f".repeat(64)}`,
    artifact,
    attestationId: "evidence-binding-identity-evidence",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  });
  const evidenceWithSelectionChange = createArtifactEvidenceAttestation({
    ...evidenceBindings,
    selectedHwCapabilityIds: ["hwc-other"],
    artifact,
    attestationId: "evidence-binding-identity-selection",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  });
  assert.notEqual(evidence.inputIdentity, evidenceWithProposalChange.inputIdentity);
  assert.notEqual(evidence.inputIdentity, evidenceWithProposalEvidenceChange.inputIdentity);
  assert.notEqual(evidence.inputIdentity, evidenceWithSelectionChange.inputIdentity);

  const risk = createArtifactRiskAssessment({
    ...riskBindings,
    artifact,
    assessmentId: "risk-binding-identity",
    assessedAt: "2026-08-20T01:00:00.000Z",
    class: "comfort_reversible",
    reasons: ["Bounded reversible level change with restore."],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  });
  const riskWithEvidenceChange = createArtifactRiskAssessment({
    ...riskBindings,
    evidence: { ...riskBindings.evidence, inputIdentity: `sha256:${"f".repeat(64)}` },
    artifact,
    assessmentId: "risk-binding-identity-evidence",
    assessedAt: "2026-08-20T01:00:00.000Z",
    class: "comfort_reversible",
    reasons: ["Bounded reversible level change with restore."],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  });
  const riskWithAuthorityChange = createArtifactRiskAssessment({
    ...riskBindings,
    authority: { ...riskBindings.authority, assessmentId: "authority-other" },
    artifact,
    assessmentId: "risk-binding-identity-authority",
    assessedAt: "2026-08-20T01:00:00.000Z",
    class: "comfort_reversible",
    reasons: ["Bounded reversible level change with restore."],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  });
  const riskWithConflictChange = createArtifactRiskAssessment({
    ...riskBindings,
    conflictInputIdentity: `sha256:${"f".repeat(64)}`,
    artifact,
    assessmentId: "risk-binding-identity-conflict",
    assessedAt: "2026-08-20T01:00:00.000Z",
    class: "comfort_reversible",
    reasons: ["Bounded reversible level change with restore."],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  });
  assert.notEqual(risk.inputIdentity, riskWithEvidenceChange.inputIdentity);
  assert.notEqual(risk.inputIdentity, riskWithAuthorityChange.inputIdentity);
  assert.notEqual(risk.inputIdentity, riskWithConflictChange.inputIdentity);

  const authority = createArtifactAuthorityAssessment({
    ...authorityBindings,
    artifact,
    assessmentId: "authority-binding-identity",
    assessedAt: "2026-08-20T01:00:00.000Z",
    candidates: [{
      actionAuthorityCandidateId: "candidate-binding",
      hwCapabilityId: "hwc-curtain-level",
      status: "available",
    }],
    checkedWatermarks: [watermark],
  }, { hwCapabilityIds: ["hwc-curtain-level"] });
  const authorityWithRegistryChange = createArtifactAuthorityAssessment({
    ...authorityBindings,
    authorityRegistryIdentity: `sha256:${"f".repeat(64)}`,
    artifact,
    assessmentId: "authority-binding-identity-registry",
    assessedAt: "2026-08-20T01:00:00.000Z",
    candidates: [{
      actionAuthorityCandidateId: "candidate-binding",
      hwCapabilityId: "hwc-curtain-level",
      status: "available",
    }],
    checkedWatermarks: [watermark],
  }, { hwCapabilityIds: ["hwc-curtain-level"] });
  assert.notEqual(authority.inputIdentity, authorityWithRegistryChange.inputIdentity);
});

test("missing or tampered assessment bindings fail closed", () => {
  const evidence = createArtifactEvidenceAttestation({
    ...evidenceBindings,
    artifact,
    attestationId: "evidence-binding-tamper",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  });
  const missingEvidenceProposal = { ...evidence } as Record<string, unknown>;
  delete missingEvidenceProposal.sourceProposal;
  assert.throws(() => parseArtifactEvidenceAttestation(missingEvidenceProposal), ArtifactAssessmentError);
  assert.throws(() => parseArtifactEvidenceAttestation({
    ...evidence,
    selectedHwCapabilityIds: ["hwc-other"],
  }), ArtifactAssessmentError);

  const risk = createArtifactRiskAssessment({
    ...riskBindings,
    artifact,
    assessmentId: "risk-binding-tamper",
    assessedAt: "2026-08-20T01:00:00.000Z",
    class: "comfort_reversible",
    reasons: ["Bounded reversible level change with restore."],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  });
  const missingRiskEvidence = { ...risk } as Record<string, unknown>;
  delete missingRiskEvidence.evidence;
  assert.throws(() => parseArtifactRiskAssessment(missingRiskEvidence), ArtifactAssessmentError);
  assert.throws(() => parseArtifactRiskAssessment({
    ...risk,
    conflictInputIdentity: `sha256:${"f".repeat(64)}`,
  }), ArtifactAssessmentError);

  const authority = createArtifactAuthorityAssessment({
    ...authorityBindings,
    artifact,
    assessmentId: "authority-binding-tamper",
    assessedAt: "2026-08-20T01:00:00.000Z",
    candidates: [],
    checkedWatermarks: [watermark],
  }, { hwCapabilityIds: ["hwc-curtain-level"] });
  const missingAuthorityRegistry = { ...authority } as Record<string, unknown>;
  delete missingAuthorityRegistry.authorityRegistryIdentity;
  assert.throws(() => parseArtifactAuthorityAssessment(missingAuthorityRegistry), ArtifactAssessmentError);
  assert.throws(() => parseArtifactAuthorityAssessment({
    ...authority,
    authorityRegistryIdentity: `sha256:${"f".repeat(64)}`,
  }), ArtifactAssessmentError);
});

test("requires selected capability ids to be unique and canonical on durable reads", () => {
  assert.throws(() => createArtifactEvidenceAttestation({
    ...evidenceBindings,
    selectedHwCapabilityIds: ["hwc-curtain-level", "hwc-curtain-level"],
    artifact,
    attestationId: "evidence-duplicate-capability",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  }), (error: unknown) => error instanceof ArtifactAssessmentError && error.code === "duplicate_capability");

  const canonical = createArtifactEvidenceAttestation({
    ...evidenceBindings,
    selectedHwCapabilityIds: ["hwc-z", "hwc-a"],
    artifact,
    attestationId: "evidence-selected-canonical",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  });
  assert.deepEqual(canonical.selectedHwCapabilityIds, ["hwc-a", "hwc-z"]);
  const unsorted = {
    ...canonical,
    selectedHwCapabilityIds: [...canonical.selectedHwCapabilityIds].reverse(),
  };
  assert.throws(() => artifactEvidenceAttestationSchema.parse(unsorted));
  assert.throws(() => parseArtifactEvidenceAttestation(unsorted));
});
