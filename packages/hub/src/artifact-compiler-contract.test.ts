import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactCompileInputSchema,
  createArtifactCompileAttestation,
  createArtifactCompileInput,
  createNeutralConflictInput,
  createNeutralConflictResult,
  createNeutralDeviceSummary,
  createNeutralDiff,
  createNeutralDryRunAttestation,
  createNeutralPredicateCompatibility,
  createNeutralWorldCut,
  computeNeutralForeignCatalogIdentity,
  neutralCompileInputIdentity,
  parseArtifactCompileAttestation,
  parseArtifactCompileInput,
  parseNeutralConflictResult,
  parseNeutralDiff,
  parseNeutralDryRunAttestation,
  parseArtifactCompileInputJson,
  deriveArtifactCapabilityScope,
  type NeutralDiff,
} from "./artifact-compiler-contract.js";
import { createArtifactEvidenceAttestation, createArtifactRiskAssessment, createArtifactAuthorityAssessment } from "./artifact-assessments.js";
import { createArtifactRevision, type ArtifactRevision } from "./neutral-artifact.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const capturedAt = "2026-08-20T01:00:00.000Z";

function curtainArtifact(): ArtifactRevision {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: "artifact-curtain-compiler-1",
    revision: 1,
    title: "Close the curtain at night",
    summary: "Move the curtain to a comfortable position after sunset-like household schedule.",
    sourceProposal: { proposalId: "proposal-curtain-1", proposalRevision: 2 },
    content: {
      trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1, 2, 3, 4, 5], at: "22:00" },
      conditions: [],
      actions: [{ kind: "set_level", target: { hwCapabilityId: "hwc-curtain-level" }, value: 0.65, transitionSeconds: 10 }],
      rollback: { kind: "restore_previous_state", target: { hwCapabilityId: "hwc-curtain-level" }, maxAgeSeconds: 900 },
      postconditions: [{ kind: "capability_value", source: { hwCapabilityId: "hwc-curtain-level" }, operator: "equals", value: 0.65, withinSeconds: 120 }],
    },
    createdAt: capturedAt,
  });
}

function notifyArtifact(): ArtifactRevision {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: "artifact-notify-compiler-1",
    revision: 1,
    title: "Review the household note",
    summary: "Send a local review note.",
    sourceProposal: { proposalId: "proposal-notify-1", proposalRevision: 1 },
    content: {
      trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "09:00" },
      conditions: [],
      actions: [{ kind: "notify_local", message: "Review the curtain position." }],
      rollback: { kind: "no_remote_change" },
      postconditions: [],
    },
    createdAt: capturedAt,
  });
}

function boundAssessments(artifact: ArtifactRevision) {
  const artifactRef = {
    artifactId: artifact.artifactId,
    revision: artifact.revision,
    contentHash: artifact.contentHash,
  };
  const watermark = {
    bridgeId: "bridge-compiler-1",
    epochId: "epoch-compiler-1",
    lastSeq: 42,
    lastSyncCompleteAt: "2026-08-20T00:59:00.000Z",
    freshness: "fresh" as const,
    gapCount: 0,
  };
  const capabilityScope = deriveArtifactCapabilityScope(artifact.content);
  const evidence = createArtifactEvidenceAttestation({
    artifact: artifactRef,
    attestationId: `evidence-${artifact.artifactId}`,
    source: "home-world-consistent-cut",
    sourceProposal: { proposalId: artifact.sourceProposal.proposalId, proposalRevision: artifact.sourceProposal.proposalRevision },
    proposalEvidenceIdentity: digest("e"),
    selectedHwCapabilityIds: capabilityScope,
    capturedAt,
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  });
  const authority = createArtifactAuthorityAssessment({
    artifact: artifactRef,
    assessmentId: `authority-${artifact.artifactId}`,
    authorityRegistryIdentity: digest("a"),
    candidates: capabilityScope.map((hwCapabilityId) => ({
      actionAuthorityCandidateId: `candidate-${artifact.artifactId}-${hwCapabilityId}`,
      hwCapabilityId,
      status: "available" as const,
    })),
    checkedWatermarks: [watermark],
    assessedAt: capturedAt,
  }, { hwCapabilityIds: capabilityScope });
  const risk = createArtifactRiskAssessment({
    artifact: artifactRef,
    assessmentId: `risk-${artifact.artifactId}`,
    evidence: { attestationId: evidence.attestationId, inputIdentity: evidence.inputIdentity },
    authority: { assessmentId: authority.assessmentId, inputIdentity: authority.inputIdentity },
    conflictInputIdentity: digest("c"),
    class: artifact.content.actions[0]?.kind === "notify_local" ? "observe_or_notify" : "comfort_reversible",
    reasons: ["Bounded compiler fixture."],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
    assessedAt: capturedAt,
  });
  const currentConflict = {
    sourceIdentity: digest("c"),
    result: createNeutralConflictResult({ status: "none", findings: [] }),
  };
  return { artifactRef, evidence, risk, authority, watermark, capabilityScope, currentConflict };
}

function curtainInput() {
  const artifact = curtainArtifact();
  const bound = boundAssessments(artifact);
  const device = createNeutralDeviceSummary({
    hwCapabilityId: "hwc-curtain-level",
    schema: "hob.cover.level",
    schemaVersion: "1.0.0",
    semanticKind: "cover",
    read: { status: "available", value: 0.2 },
    validity: "valid",
    actionCompatibility: [{
      order: 1,
      kind: "set_level",
      status: "incompatible",
      reason: "set_level_unsupported",
    }],
    predicateCompatibility: [{ phase: "postcondition", order: 1, status: "compatible" }],
  });
  const worldCut = createNeutralWorldCut({ devices: [device], watermarks: [bound.watermark] });
  const conflict = createNeutralConflictInput({
    bridgeId: bound.watermark.bridgeId,
    epochId: bound.watermark.epochId,
    watermark: bound.watermark,
    catalogIdentity: digest("f"),
    status: "current",
    findings: [],
  });
  return createArtifactCompileInput({
    artifact,
    proposal: { id: artifact.sourceProposal.proposalId, revision: artifact.sourceProposal.proposalRevision, status: "approved" },
    evidence: bound.evidence,
    risk: bound.risk,
    authority: bound.authority,
    currentConflict: bound.currentConflict,
    worldCut,
    foreignCatalogIdentity: computeNeutralForeignCatalogIdentity([conflict]),
    foreignRuleChecks: [conflict],
    compiler: { id: "neutral-compiler", version: "1.0.0" },
  });
}

test("builds a frozen curtain compile input with a deterministic neutral identity", () => {
  const input = curtainInput();
  assert.equal(Object.isFrozen(input), true);
  assert.equal(Object.isFrozen(input.worldCut.devices), true);
  assert.match(input.inputIdentity, /^sha256:[0-9a-f]{64}$/);
  assert.equal(input.inputIdentity, neutralCompileInputIdentity(input));
  assert.deepEqual(parseArtifactCompileInput(input), input);
});

test("binds the explicit neutral device read status and rejects stale-value tampering", () => {
  const input = curtainInput();
  const device = input.worldCut.devices[0]!;
  assert.deepEqual(device.read, { status: "available", value: 0.2 });
  assert.equal(Object.isFrozen(device.read), true);
  assert.throws(() => createNeutralDeviceSummary({
    ...device,
    currentValue: 0.2,
  }));
  assert.throws(() => createNeutralDeviceSummary({
    ...device,
    validity: "stale",
  }));
  const changedDevice = createNeutralDeviceSummary({
    ...device,
    read: { status: "available", value: 0.3 },
  });
  assert.deepEqual(changedDevice.read, { status: "available", value: 0.3 });
  assert.throws(() => createNeutralDeviceSummary({
    ...device,
    read: { status: "unavailable", reason: "state_missing" },
    validity: "valid",
  }));
  const unsupportedDevice = createNeutralDeviceSummary({
    ...device,
    read: { status: "unsupported", reason: "schema_unsupported" },
  });
  assert.equal(unsupportedDevice.validity, "valid");
  const changedWorldCut = createNeutralWorldCut({
    devices: [{ ...device, read: { status: "available", value: 0.3 } }],
    watermarks: input.worldCut.watermarks,
  });
  assert.notEqual(changedWorldCut.cutIdentity, input.worldCut.cutIdentity);
  const { inputIdentity: _identity, ...draft } = input;
  const changedInput = createArtifactCompileInput({ ...draft, worldCut: changedWorldCut });
  assert.notEqual(changedInput.inputIdentity, input.inputIdentity);
});

test("preserves action order in a bounded neutral diff and keeps unavailable output empty", () => {
  const diff = createNeutralDiff({
    status: "changes",
    operations: [
      { actionOrder: 1, kind: "set_level", hwCapabilityId: "hwc-curtain-level", actionAuthorityCandidateId: "candidate-curtain", before: 0.2, after: 0.65 },
      { actionOrder: 2, kind: "notify_local", after: "Curtain state needs review." },
    ],
    unchangedCount: 0,
    redacted: true,
  });
  assert.deepEqual(diff.operations.map((operation) => operation.actionOrder), [1, 2]);
  assert.equal(diff.operations[0]?.before, 0.2);
  assert.deepEqual(parseNeutralDiff(diff), diff);
  assert.throws(() => createNeutralDiff({ ...diff, operations: [diff.operations[1]!, diff.operations[0]!] }));
});

test("fails closed for incomplete, unchanged, and unavailable diff operations", () => {
  const base = {
    status: "changes" as const,
    unchangedCount: 0,
    redacted: true as const,
  };
  assert.throws(() => createNeutralDiff({
    ...base,
    operations: [{ actionOrder: 1, kind: "set_level", hwCapabilityId: "hwc-curtain-level", after: 0.65 }],
  }));
  assert.throws(() => createNeutralDiff({
    ...base,
    operations: [{ actionOrder: 1, kind: "set_boolean", hwCapabilityId: "hwc-curtain-level", actionAuthorityCandidateId: "candidate", before: "false", after: true }],
  }));
  assert.throws(() => createNeutralDiff({
    ...base,
    operations: [{ actionOrder: 1, kind: "set_level", hwCapabilityId: "hwc-curtain-level", actionAuthorityCandidateId: "candidate", before: 0.65, after: 1.1 }],
  }));
  assert.throws(() => createNeutralDiff({
    ...base,
    operations: [{ actionOrder: 1, kind: "set_level", hwCapabilityId: "hwc-curtain-level", actionAuthorityCandidateId: "candidate", before: 0.65, after: 0.65 }],
  }));
  assert.throws(() => createNeutralDiff({
    ...base,
    operations: [{ actionOrder: 1, kind: "notify_local", after: "" }],
  }));
  const notifyDiff = createNeutralDiff({
    ...base,
    operations: [{ actionOrder: 1, kind: "notify_local", after: "Review the curtain position." }],
  });
  assert.throws(() => createNeutralDiff({
    ...notifyDiff,
    operations: [{ ...notifyDiff.operations[0]!, before: "unexpected" }],
  } as unknown as NeutralDiff));
  assert.throws(() => createNeutralDiff({
    status: "unavailable",
    operations: [{ actionOrder: 1, kind: "set_level", hwCapabilityId: "hwc-curtain-level", actionAuthorityCandidateId: "candidate", before: 0.2, after: 0.65 }],
    unchangedCount: 0,
    redacted: true,
  }));
});

test("compile verifies diff authority, values, and action accounting", () => {
  const input = curtainInput();
  const conflicts = input.currentConflict.result;
  const candidate = "candidate-artifact-curtain-compiler-1-hwc-curtain-level";
  const validDiff = createNeutralDiff({
    status: "changes",
    operations: [{
      actionOrder: 1,
      kind: "set_level",
      hwCapabilityId: "hwc-curtain-level",
      actionAuthorityCandidateId: candidate,
      before: 0.2,
      after: 0.65,
    }],
    unchangedCount: 0,
    redacted: true,
  });
  const createRejected = (diff: typeof validDiff) => createArtifactCompileAttestation({
    input,
    status: "rejected",
    diff,
    conflicts,
    blockingReasons: ["set_level_unsupported"],
  });
  assert.equal(createRejected(validDiff).status, "rejected");
  assert.throws(() => createRejected(createNeutralDiff({
    ...validDiff,
    operations: [{ ...validDiff.operations[0]!, actionAuthorityCandidateId: "candidate-other" }],
  })));
  assert.throws(() => createRejected(createNeutralDiff({
    ...validDiff,
    operations: [{ ...validDiff.operations[0]!, after: 0.55 }],
  })));
  assert.throws(() => createRejected(createNeutralDiff({
    ...validDiff,
    unchangedCount: 1,
  })));
  const notify = notifyArtifact();
  const notifyInput = (() => {
    const bound = boundAssessments(notify);
    const watermark = bound.watermark;
    const check = createNeutralConflictInput({
      bridgeId: watermark.bridgeId,
      epochId: watermark.epochId,
      watermark,
      catalogIdentity: digest("e"),
      status: "unavailable",
      findings: [{ kind: "foreign_rule", severity: "blocking", reason: "foreign_catalog_unavailable", reference: "notify-diff-check" }],
    });
    const authority = createArtifactAuthorityAssessment({
      artifact: bound.artifactRef,
      assessmentId: "authority-notify-diff",
      authorityRegistryIdentity: digest("a"),
      candidates: [],
      checkedWatermarks: [watermark],
      assessedAt: capturedAt,
    }, { hwCapabilityIds: [] });
    const risk = createArtifactRiskAssessment({
      artifact: bound.artifactRef,
      assessmentId: "risk-notify-diff",
      evidence: { attestationId: bound.evidence.attestationId, inputIdentity: bound.evidence.inputIdentity },
      authority: { assessmentId: authority.assessmentId, inputIdentity: authority.inputIdentity },
      conflictInputIdentity: bound.currentConflict.sourceIdentity,
      class: "observe_or_notify",
      reasons: ["Notify diff accounting fixture."],
      policyId: "policy-home-v1",
      policyVersion: "1.0.0",
      assessedAt: capturedAt,
    });
    return createArtifactCompileInput({
      artifact: notify,
      proposal: { id: notify.sourceProposal.proposalId, revision: notify.sourceProposal.proposalRevision, status: "approved" },
      evidence: bound.evidence,
      risk,
      authority,
      currentConflict: { sourceIdentity: bound.currentConflict.sourceIdentity, result: createNeutralConflictResult({ status: "unavailable", findings: [{ kind: "foreign_rule", severity: "blocking", reason: "foreign_catalog_unavailable", reference: "notify-diff-check" }] }) },
      worldCut: createNeutralWorldCut({ devices: [], watermarks: [watermark] }),
      foreignCatalogIdentity: computeNeutralForeignCatalogIdentity([check]),
      foreignRuleChecks: [check],
      compiler: { id: "neutral-compiler", version: "1.0.0" },
    });
  })();
  assert.throws(() => createArtifactCompileAttestation({
    input: notifyInput,
    status: "unavailable",
    diff: createNeutralDiff({ status: "no_change", operations: [], unchangedCount: 1, redacted: true }),
    conflicts: notifyInput.currentConflict.result,
    blockingReasons: ["foreign_catalog_unavailable"],
  }));
});

test("rejects the curtain set_level projection instead of fabricating a compiled result", () => {
  const input = curtainInput();
  const diff = createNeutralDiff({
    status: "unavailable",
    operations: [],
    unchangedCount: 0,
    redacted: true,
  });
  const result = createArtifactCompileAttestation({
    input,
    status: "rejected",
    diff,
    conflicts: input.currentConflict.result,
    blockingReasons: ["set_level_unsupported"],
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.worldCutIdentity, input.worldCut.cutIdentity);
  assert.equal(result.foreignCatalogIdentity, input.foreignCatalogIdentity);
  assert.equal("haAutomation" in result, false);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(parseArtifactCompileAttestation(result), result);
});

function booleanArtifact(): ArtifactRevision {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: "artifact-miot-bool-compiler-1",
    revision: 1,
    title: "Turn on the boolean capability",
    summary: "A reviewed MIoT boolean action fixture.",
    sourceProposal: { proposalId: "proposal-miot-bool-1", proposalRevision: 1 },
    content: {
      trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "09:00" },
      conditions: [],
      actions: [{ kind: "set_boolean", target: { hwCapabilityId: "hwc-miot-bool" }, value: false }],
      rollback: { kind: "restore_previous_state", target: { hwCapabilityId: "hwc-miot-bool" }, maxAgeSeconds: 900 },
      postconditions: [{ kind: "capability_value", source: { hwCapabilityId: "hwc-miot-bool" }, operator: "equals", value: false, withinSeconds: 120 }],
    },
    createdAt: capturedAt,
  });
}

test("accepts the reviewed MIoT boolean compatibility projection with neutral before and after", () => {
  const artifact = booleanArtifact();
  const bound = boundAssessments(artifact);
  const authority = createArtifactAuthorityAssessment({
    artifact: bound.artifactRef,
    assessmentId: "authority-miot-bool",
    authorityRegistryIdentity: digest("a"),
    candidates: [{ actionAuthorityCandidateId: "candidate-miot-bool", hwCapabilityId: "hwc-miot-bool", status: "available" }],
    checkedWatermarks: [bound.watermark],
    assessedAt: capturedAt,
  }, { hwCapabilityIds: ["hwc-miot-bool"] });
  const risk = createArtifactRiskAssessment({
    artifact: bound.artifactRef,
    assessmentId: "risk-miot-bool",
    evidence: { attestationId: bound.evidence.attestationId, inputIdentity: bound.evidence.inputIdentity },
    authority: { assessmentId: authority.assessmentId, inputIdentity: authority.inputIdentity },
    conflictInputIdentity: bound.currentConflict.sourceIdentity,
    class: "comfort_reversible",
    reasons: ["Reviewed boolean compatibility fixture."],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
    assessedAt: capturedAt,
  });
  const device = createNeutralDeviceSummary({
    hwCapabilityId: "hwc-miot-bool",
    schema: "miot.property",
    schemaVersion: "1.0.0",
    semanticKind: "switch",
    read: { status: "available", value: true },
    validity: "valid",
    actionCompatibility: [{
      order: 1,
      kind: "set_boolean",
      status: "compatible",
      before: true,
      after: false,
    }],
    predicateCompatibility: [{ phase: "postcondition", order: 1, status: "compatible" }],
  });
  const watermark = bound.watermark;
  const worldCut = createNeutralWorldCut({ devices: [device], watermarks: [watermark] });
  const conflict = createNeutralConflictInput({
    bridgeId: watermark.bridgeId,
    epochId: watermark.epochId,
    watermark,
    catalogIdentity: digest("d"),
    status: "current",
    findings: [],
  });
  const input = createArtifactCompileInput({
    artifact,
    proposal: { id: artifact.sourceProposal.proposalId, revision: artifact.sourceProposal.proposalRevision, status: "approved" },
    evidence: bound.evidence,
    risk,
    authority,
    currentConflict: bound.currentConflict,
    worldCut,
    foreignCatalogIdentity: computeNeutralForeignCatalogIdentity([conflict]),
    foreignRuleChecks: [conflict],
    compiler: { id: "neutral-compiler", version: "1.0.0" },
  });
  assert.equal(input.worldCut.devices[0]?.actionCompatibility[0]?.status, "compatible");
  assert.equal(input.worldCut.devices[0]?.actionCompatibility[0]?.before, true);
  assert.equal(input.worldCut.devices[0]?.actionCompatibility[0]?.after, false);
});

test("fails closed for missing, extra, mismatched, and non-consecutive action projections", () => {
  const input = curtainInput();
  const device = input.worldCut.devices[0]!;
  const { inputIdentity: _identity, ...draft } = input;
  const withoutProjection = createNeutralWorldCut({
    devices: [{ ...device, actionCompatibility: [] }],
    watermarks: input.worldCut.watermarks,
  });
  assert.throws(() => createArtifactCompileInput({ ...draft, worldCut: withoutProjection }));
  const extraProjection = createNeutralWorldCut({
    devices: [{ ...device, actionCompatibility: [...device.actionCompatibility, { order: 2, kind: "set_boolean", status: "incompatible", reason: "action_invalid" }] }],
    watermarks: input.worldCut.watermarks,
  });
  assert.throws(() => createArtifactCompileInput({ ...draft, worldCut: extraProjection }));
  const mismatchedProjection = createNeutralWorldCut({
    devices: [{ ...device, actionCompatibility: [{ ...device.actionCompatibility[0]!, kind: "set_boolean" }] }],
    watermarks: input.worldCut.watermarks,
  });
  assert.throws(() => createArtifactCompileInput({ ...draft, worldCut: mismatchedProjection }));
  const nonConsecutive = createNeutralWorldCut({
    devices: [{ ...device, actionCompatibility: [{ ...device.actionCompatibility[0]!, order: 2 }] }],
    watermarks: input.worldCut.watermarks,
  });
  assert.throws(() => createArtifactCompileInput({ ...draft, worldCut: nonConsecutive }));
});

test("keeps compatibility projection values closed by status and action kind", () => {
  const boolean = {
    hwCapabilityId: "hwc-miot-bool",
    schema: "miot.property",
    schemaVersion: "1.0.0",
    semanticKind: "switch" as const,
    read: { status: "available", value: true },
    validity: "valid" as const,
    actionCompatibility: [{ order: 1, kind: "set_boolean" as const, status: "compatible" as const, before: true, after: false }],
    predicateCompatibility: [],
  };
  assert.throws(() => createNeutralDeviceSummary({
    ...boolean,
    actionCompatibility: [{ ...boolean.actionCompatibility[0]!, reason: "not_writable" }],
  }));
  assert.throws(() => createNeutralDeviceSummary({
    ...boolean,
    actionCompatibility: [{ ...boolean.actionCompatibility[0]!, before: "true" }],
  }));
  assert.throws(() => createNeutralDeviceSummary({
    ...boolean,
    actionCompatibility: [{ ...boolean.actionCompatibility[0]!, after: 0.5 }],
  }));
  assert.throws(() => createNeutralDeviceSummary({
    ...boolean,
    actionCompatibility: [{ order: 1, kind: "set_boolean", status: "incompatible", reason: "not_writable", before: true, after: false }],
  }));
  assert.throws(() => createNeutralDeviceSummary({
    ...boolean,
    actionCompatibility: [{ order: 1, kind: "set_level", status: "compatible", before: 0, after: 1.1 }],
  }));
});

test("keeps predicate compatibility closed and bound by phase/order/source", () => {
  assert.throws(() => createNeutralPredicateCompatibility({ phase: "condition", order: 1, status: "compatible", reason: "operator_unsupported" }));
  assert.throws(() => createNeutralPredicateCompatibility({ phase: "condition", order: 1, status: "incompatible" }));
  const input = curtainInput();
  const device = input.worldCut.devices[0]!;
  const { inputIdentity: _identity, ...draft } = input;
  assert.throws(() => createArtifactCompileInput({
    ...draft,
    worldCut: createNeutralWorldCut({
      devices: [{ ...device, predicateCompatibility: [] }],
      watermarks: input.worldCut.watermarks,
    }),
  }));
  assert.throws(() => createArtifactCompileInput({
    ...draft,
    worldCut: createNeutralWorldCut({
      devices: [{ ...device, predicateCompatibility: [{ phase: "condition", order: 1, status: "compatible" }] }],
      watermarks: input.worldCut.watermarks,
    }),
  }));
});

test("permits no-op diff gaps but binds every shown operation to its artifact action", () => {
  const gap = createNeutralDiff({
    status: "changes",
    operations: [
      { actionOrder: 1, kind: "set_level", hwCapabilityId: "hwc-curtain-level", actionAuthorityCandidateId: "candidate-gap", before: 0.2, after: 0.65 },
      { actionOrder: 3, kind: "notify_local", after: "Review the curtain position." },
    ],
    unchangedCount: 1,
    redacted: true,
  });
  assert.deepEqual(gap.operations.map((operation) => operation.actionOrder), [1, 3]);
  assert.throws(() => createNeutralDiff({ ...gap, operations: [{ ...gap.operations[0]!, actionOrder: 1 }, { ...gap.operations[1]!, actionOrder: 1 }] }));
  const input = curtainInput();
  assert.throws(() => createArtifactCompileAttestation({
    input,
    status: "rejected",
    diff: createNeutralDiff({
      status: "changes",
      operations: [{ actionOrder: 1, kind: "set_boolean", hwCapabilityId: "hwc-curtain-level", after: true }],
      unchangedCount: 0,
      redacted: true,
    }),
    conflicts: createNeutralConflictResult({ status: "none", findings: [] }),
    blockingReasons: ["set_level_unsupported"],
  }));
});

test("binds every compatibility projection change into the world-cut and compile identities", () => {
  const input = curtainInput();
  const device = input.worldCut.devices[0]!;
  const changedWorldCut = createNeutralWorldCut({
    devices: [{
      ...device,
      actionCompatibility: [{ ...device.actionCompatibility[0]!, reason: "action_mapping_unreviewed" }],
    }],
    watermarks: input.worldCut.watermarks,
  });
  assert.notEqual(changedWorldCut.cutIdentity, input.worldCut.cutIdentity);
  const { inputIdentity: _identity, ...draft } = input;
  const changedInput = createArtifactCompileInput({ ...draft, worldCut: changedWorldCut });
  assert.notEqual(changedInput.inputIdentity, input.inputIdentity);
});

test("binds current conflict source/result and the aggregate foreign catalog identity", () => {
  const input = curtainInput();
  assert.equal(input.risk.conflictInputIdentity, input.currentConflict.sourceIdentity);
  assert.equal(input.foreignCatalogIdentity, computeNeutralForeignCatalogIdentity(input.foreignRuleChecks));
  const { inputIdentity: _identity, ...draft } = input;
  assert.throws(() => createArtifactCompileInput({
    ...draft,
    foreignCatalogIdentity: digest("z"),
  }));
  assert.throws(() => createArtifactCompileInput({
    ...draft,
    risk: createArtifactRiskAssessment({
      artifact: input.risk.artifact,
      assessmentId: "risk-current-conflict-mismatch",
      evidence: input.risk.evidence,
      authority: input.risk.authority,
      conflictInputIdentity: digest("z"),
      class: input.risk.class,
      reasons: ["Mismatched current conflict source."],
      policyId: input.risk.policyId,
      policyVersion: input.risk.policyVersion,
      assessedAt: capturedAt,
    }),
  }));
});

test("derives one available authority binding per device action and copies it to dry-run", () => {
  const input = curtainInput();
  const compile = createArtifactCompileAttestation({
    input,
    status: "rejected",
    diff: createNeutralDiff({ status: "unavailable", operations: [], unchangedCount: 0, redacted: true }),
    conflicts: input.currentConflict.result,
    blockingReasons: ["set_level_unsupported"],
  });
  assert.deepEqual(compile.actionAuthorityBindings, [{
    actionOrder: 1,
    kind: "set_level",
    hwCapabilityId: "hwc-curtain-level",
    actionAuthorityCandidateId: "candidate-artifact-curtain-compiler-1-hwc-curtain-level",
  }]);
  const dryRun = createNeutralDryRunAttestation({
    compile,
    status: "failed",
    diff: compile.diff,
    conflicts: compile.conflicts,
    summary: "The rejected compile was not eligible for a passed dry-run.",
  });
  assert.deepEqual(dryRun.checkedWatermarks, compile.usedWatermarks);
  assert.deepEqual(dryRun.actionAuthorityBindings, compile.actionAuthorityBindings);
});

test("requires unavailable output when an action has no unique available authority candidate", () => {
  const input = curtainInput();
  const authority = createArtifactAuthorityAssessment({
    artifact: input.authority.artifact,
    assessmentId: "authority-missing-candidate",
    authorityRegistryIdentity: digest("a"),
    candidates: [],
    checkedWatermarks: input.worldCut.watermarks,
    assessedAt: capturedAt,
  }, { hwCapabilityIds: ["hwc-curtain-level"] });
  const risk = createArtifactRiskAssessment({
    artifact: input.risk.artifact,
    assessmentId: "risk-missing-candidate",
    evidence: input.risk.evidence,
    authority: { assessmentId: authority.assessmentId, inputIdentity: authority.inputIdentity },
    conflictInputIdentity: input.currentConflict.sourceIdentity,
    class: input.risk.class,
    reasons: ["Missing action authority candidate."],
    policyId: input.risk.policyId,
    policyVersion: input.risk.policyVersion,
    assessedAt: capturedAt,
  });
  const { inputIdentity: _identity, ...draft } = input;
  const unavailableInput = createArtifactCompileInput({ ...draft, authority, risk });
  const compile = createArtifactCompileAttestation({
    input: unavailableInput,
    status: "unavailable",
    diff: createNeutralDiff({ status: "unavailable", operations: [], unchangedCount: 0, redacted: true }),
    conflicts: unavailableInput.currentConflict.result,
    blockingReasons: ["foreign_catalog_unavailable"],
  });
  assert.deepEqual(compile.actionAuthorityBindings, []);
  assert.ok(compile.blockingReasons.includes("authority_unavailable"));
  assert.throws(() => createArtifactCompileAttestation({
    input: unavailableInput,
    status: "compiled",
    plan: unavailableInput.artifact.content,
    diff: createNeutralDiff({ status: "no_change", operations: [], unchangedCount: 1, redacted: true }),
    conflicts: unavailableInput.currentConflict.result,
    blockingReasons: [],
  }));
});

test("derives the complete canonical capability scope and binds both sides exactly", () => {
  assert.deepEqual(deriveArtifactCapabilityScope(curtainArtifact().content), ["hwc-curtain-level"]);
  const multiReference = createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: "artifact-scope-all-refs",
    revision: 1,
    title: "Scope all references",
    summary: "Exercise every artifact capability reference position.",
    sourceProposal: { proposalId: "proposal-scope-all-refs", proposalRevision: 1 },
    content: {
      trigger: { kind: "capability_changed", source: { hwCapabilityId: "hwc-trigger" } },
      conditions: [{ kind: "capability_value", source: { hwCapabilityId: "hwc-condition" }, operator: "equals", value: true }],
      actions: [{ kind: "set_boolean", target: { hwCapabilityId: "hwc-action" }, value: true }],
      rollback: { kind: "restore_previous_state", target: { hwCapabilityId: "hwc-action" }, maxAgeSeconds: 900 },
      postconditions: [
        { kind: "capability_value", source: { hwCapabilityId: "hwc-action" }, operator: "equals", value: true, withinSeconds: 120 },
        { kind: "capability_value", source: { hwCapabilityId: "hwc-postcondition" }, operator: "equals", value: null, withinSeconds: 120 },
      ],
    },
    createdAt: capturedAt,
  });
  assert.deepEqual(deriveArtifactCapabilityScope(multiReference.content), ["hwc-action", "hwc-condition", "hwc-postcondition", "hwc-trigger"]);
  const input = curtainInput();
  const { inputIdentity: _identity, ...draft } = input;
  assert.throws(() => createArtifactCompileInput({
    ...draft,
    evidence: { ...input.evidence, selectedHwCapabilityIds: [] },
  }));
  assert.throws(() => createArtifactCompileInput({
    ...draft,
    worldCut: createNeutralWorldCut({ devices: [], watermarks: input.worldCut.watermarks }),
  }));
  const extra = createNeutralDeviceSummary({
    hwCapabilityId: "hwc-extra",
    schema: "miot.property",
    schemaVersion: "1.0.0",
    semanticKind: "switch",
    read: { status: "unsupported", reason: "schema_unsupported" },
    validity: "valid",
    actionCompatibility: [],
    predicateCompatibility: [],
  });
  assert.throws(() => createArtifactCompileInput({
    ...draft,
    worldCut: createNeutralWorldCut({ devices: [...input.worldCut.devices, extra], watermarks: input.worldCut.watermarks }),
  }));
});

test("binds world-cut bridge watermarks to evidence semantic watermarks", () => {
  const input = curtainInput();
  const { inputIdentity: _identity, ...draft } = input;
  const changed = createNeutralWorldCut({
    devices: input.worldCut.devices,
    watermarks: [{ ...input.worldCut.watermarks[0]!, lastSeq: 43 }],
  });
  assert.throws(() => createArtifactCompileInput({ ...draft, worldCut: changed }));
});

test("creates a notify-only compile and a read-only dry-run attestation", () => {
  const artifact = notifyArtifact();
  const bound = boundAssessments(artifact);
  const worldCut = createNeutralWorldCut({ devices: [], watermarks: [bound.watermark] });
  const conflict = createNeutralConflictInput({
    bridgeId: bound.watermark.bridgeId,
    epochId: bound.watermark.epochId,
    watermark: bound.watermark,
    catalogIdentity: digest("b"),
    status: "unavailable",
    findings: [{ kind: "foreign_rule", severity: "blocking", reason: "foreign_catalog_unavailable", reference: "foreign-check-notify" }],
  });
  const authority = createArtifactAuthorityAssessment({
    artifact: bound.artifactRef,
    assessmentId: "authority-notify",
    authorityRegistryIdentity: digest("a"),
    candidates: [],
    checkedWatermarks: [bound.watermark],
    assessedAt: capturedAt,
  }, { hwCapabilityIds: [] });
  const risk = createArtifactRiskAssessment({
    artifact: bound.artifactRef,
    assessmentId: "risk-notify",
    evidence: { attestationId: bound.evidence.attestationId, inputIdentity: bound.evidence.inputIdentity },
    authority: { assessmentId: authority.assessmentId, inputIdentity: authority.inputIdentity },
    conflictInputIdentity: digest("b"),
    class: "observe_or_notify",
    reasons: ["Local notification only."],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
    assessedAt: capturedAt,
  });
  const currentConflict = {
    sourceIdentity: digest("b"),
    result: createNeutralConflictResult({ status: "unavailable", findings: [{ kind: "foreign_rule", severity: "blocking", reason: "foreign_catalog_unavailable", reference: "foreign-check-notify" }] }),
  };
  const input = createArtifactCompileInput({
    artifact,
    proposal: { id: artifact.sourceProposal.proposalId, revision: artifact.sourceProposal.proposalRevision, status: "approved" },
    evidence: bound.evidence,
    risk,
    authority,
    currentConflict,
    worldCut,
    foreignCatalogIdentity: computeNeutralForeignCatalogIdentity([conflict]),
    foreignRuleChecks: [conflict],
    compiler: { id: "neutral-compiler", version: "1.0.0" },
  });
  assert.deepEqual(bound.capabilityScope, []);
  assert.deepEqual(input.evidence.selectedHwCapabilityIds, []);
  assert.deepEqual(input.worldCut.devices, []);
  assert.deepEqual(input.authority.candidates, []);
  const compile = createArtifactCompileAttestation({
    input,
    status: "unavailable",
    diff: createNeutralDiff({ status: "unavailable", operations: [], unchangedCount: 0, redacted: true }),
    conflicts: input.currentConflict.result,
    blockingReasons: ["foreign_catalog_unavailable"],
  });
  const dryRun = createNeutralDryRunAttestation({
    compile,
    status: "unavailable",
    diff: compile.diff,
    conflicts: compile.conflicts,
    summary: "Foreign rule catalog is unavailable; no simulation was performed.",
  });
  assert.equal(dryRun.writesPerformed, false);
  assert.equal(dryRun.status, "unavailable");
  assert.deepEqual(parseNeutralDryRunAttestation(dryRun), dryRun);
});

test("requires canonical blocking reasons and exact dry-run status relation", () => {
  const input = curtainInput();
  assert.throws(() => createArtifactCompileAttestation({
    input,
    status: "rejected",
    diff: createNeutralDiff({ status: "unavailable", operations: [], unchangedCount: 0, redacted: true }),
    conflicts: input.currentConflict.result,
    blockingReasons: [],
  }));
  assert.throws(() => createArtifactCompileAttestation({
    input,
    status: "rejected",
    diff: createNeutralDiff({ status: "unavailable", operations: [], unchangedCount: 0, redacted: true }),
    conflicts: input.currentConflict.result,
    blockingReasons: ["set_level_unsupported", "set_level_unsupported"],
  }));
  const compile = createArtifactCompileAttestation({
    input,
    status: "rejected",
    diff: createNeutralDiff({ status: "unavailable", operations: [], unchangedCount: 0, redacted: true }),
    conflicts: input.currentConflict.result,
    blockingReasons: ["authority_unavailable", "set_level_unsupported"],
  });
  assert.deepEqual(compile.blockingReasons, ["authority_unavailable", "set_level_unsupported"]);
  assert.throws(() => createNeutralDryRunAttestation({
    compile,
    status: "passed",
    diff: compile.diff,
    conflicts: compile.conflicts,
    summary: "A rejected compile cannot pass dry-run.",
  }));
  assert.throws(() => createNeutralDryRunAttestation({
    compile,
    status: "failed",
    diff: createNeutralDiff({ status: "unavailable", operations: [], unchangedCount: 0, redacted: true }),
    conflicts: createNeutralConflictResult({ status: "unavailable", findings: [{ kind: "foreign_rule", severity: "blocking", reason: "foreign_catalog_unavailable", reference: "mismatched-conflict" }] }),
    summary: "A dry-run cannot replace the compile conflict result.",
  }));
});

test("allows passed dry-run only for a compiled, usable, conflict-free result", () => {
  const artifact = booleanArtifact();
  const bound = boundAssessments(artifact);
  const authority = createArtifactAuthorityAssessment({
    artifact: bound.artifactRef,
    assessmentId: "authority-miot-bool-passed",
    authorityRegistryIdentity: digest("a"),
    candidates: [{ actionAuthorityCandidateId: "candidate-miot-bool-passed", hwCapabilityId: "hwc-miot-bool", status: "available" }],
    checkedWatermarks: [bound.watermark],
    assessedAt: capturedAt,
  }, { hwCapabilityIds: ["hwc-miot-bool"] });
  const risk = createArtifactRiskAssessment({
    artifact: bound.artifactRef,
    assessmentId: "risk-miot-bool-passed",
    evidence: { attestationId: bound.evidence.attestationId, inputIdentity: bound.evidence.inputIdentity },
    authority: { assessmentId: authority.assessmentId, inputIdentity: authority.inputIdentity },
    conflictInputIdentity: bound.currentConflict.sourceIdentity,
    class: "comfort_reversible",
    reasons: ["Passed fixture."],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
    assessedAt: capturedAt,
  });
  const device = createNeutralDeviceSummary({
    hwCapabilityId: "hwc-miot-bool",
    schema: "miot.property",
    schemaVersion: "1.0.0",
    semanticKind: "switch",
    read: { status: "available", value: true },
    validity: "valid",
    actionCompatibility: [{ order: 1, kind: "set_boolean", status: "compatible", before: true, after: false }],
    predicateCompatibility: [{ phase: "postcondition", order: 1, status: "compatible" }],
  });
  const conflict = createNeutralConflictInput({
    bridgeId: bound.watermark.bridgeId,
    epochId: bound.watermark.epochId,
    watermark: bound.watermark,
    catalogIdentity: digest("d"),
    status: "current",
    findings: [],
  });
  const input = createArtifactCompileInput({
    artifact,
    proposal: { id: artifact.sourceProposal.proposalId, revision: artifact.sourceProposal.proposalRevision, status: "approved" },
    evidence: bound.evidence,
    risk,
    authority,
    currentConflict: bound.currentConflict,
    worldCut: createNeutralWorldCut({ devices: [device], watermarks: [bound.watermark] }),
    foreignCatalogIdentity: computeNeutralForeignCatalogIdentity([conflict]),
    foreignRuleChecks: [conflict],
    compiler: { id: "neutral-compiler", version: "1.0.0" },
  });
  const compile = createArtifactCompileAttestation({
    input,
    status: "compiled",
    plan: artifact.content,
    diff: createNeutralDiff({ status: "no_change", operations: [], unchangedCount: 1, redacted: true }),
    conflicts: input.currentConflict.result,
    blockingReasons: [],
  });
  const dryRun = createNeutralDryRunAttestation({
    compile,
    status: "passed",
    diff: compile.diff,
    conflicts: compile.conflicts,
    summary: "Compiled neutral plan passed a read-only dry-run.",
  });
  assert.equal(dryRun.status, "passed");
});

test("replays identities across object key insertion order but changes them for dynamic cuts", () => {
  const input = curtainInput();
  const { inputIdentity: _inputIdentity, ...inputDraft } = input;
  const reordered = createArtifactCompileInput({
    compiler: { version: "1.0.0", id: "neutral-compiler" },
    foreignRuleChecks: input.foreignRuleChecks.map((check) => ({ ...check })),
    foreignCatalogIdentity: input.foreignCatalogIdentity,
    worldCut: { ...input.worldCut, devices: input.worldCut.devices.map((device) => ({ ...device })) },
    authority: input.authority,
    currentConflict: input.currentConflict,
    risk: input.risk,
    evidence: input.evidence,
    proposal: input.proposal,
    artifact: inputDraft.artifact,
  });
  assert.equal(reordered.inputIdentity, input.inputIdentity);
  const { inputIdentity: _changedInputIdentity, ...changedDraft } = input;
  assert.throws(() => createArtifactCompileInput({
    ...changedDraft,
    worldCut: createNeutralWorldCut({ devices: input.worldCut.devices, watermarks: [{ ...input.worldCut.watermarks[0]!, lastSeq: 43 }] }),
  }));
});

test("canonicalizes non-semantic world and foreign-check order without reordering actions", () => {
  const input = curtainInput();
  const { inputIdentity: _identity, ...draft } = input;
  const first = createArtifactCompileInput({
    ...draft,
    foreignRuleChecks: [input.foreignRuleChecks[0]!],
  });
  const second = createArtifactCompileInput({
    ...draft,
    foreignRuleChecks: [input.foreignRuleChecks[0]!],
  });
  assert.equal(first.inputIdentity, second.inputIdentity);
  assert.deepEqual(first.foreignRuleChecks.map((check) => check.bridgeId), ["bridge-compiler-1"]);
  assert.deepEqual(first.artifact.content.actions.map((action) => action.kind), ["set_level"]);
});

test("excludes capture timestamp metadata while retaining semantic watermark changes", () => {
  const input = curtainInput();
  const timestampOnly = createArtifactCompileInput({
    ...(() => {
      const { inputIdentity: _identity, ...draft } = input;
      return draft;
    })(),
    worldCut: createNeutralWorldCut({
      devices: input.worldCut.devices,
      watermarks: [{ ...input.worldCut.watermarks[0]!, lastSyncCompleteAt: "2026-08-20T02:00:00.000Z" }],
    }),
  });
  assert.equal(timestampOnly.inputIdentity, input.inputIdentity);
  assert.equal(timestampOnly.worldCut.cutIdentity, input.worldCut.cutIdentity);
});

test("rejects unknown, native, URL, raw-attribute, credential, and oversized fields as whole inputs", () => {
  const input = curtainInput();
  for (const field of ["providerPayload", "nativeId", "route", "url", "rawAttrs", "service", "credential"]) {
    assert.throws(() => parseArtifactCompileInput({ ...input, [field]: "forbidden" }));
  }
  assert.throws(() => parseArtifactCompileInput({ ...input, compiler: { ...input.compiler, unknown: true } }));
  assert.throws(() => parseArtifactCompileInput({ ...input, compiler: { ...input.compiler, id: "x".repeat(17_000) } }));
  assert.throws(() => parseArtifactCompileInput({ ...input, compiler: { ...input.compiler, id: "https://not-neutral.example" } }));
});

test("keeps exported schemas fail-closed and rejects duplicate JSON keys", () => {
  const input = curtainInput();
  assert.equal(artifactCompileInputSchema.safeParse({ ...input, nativeId: "forbidden" }).success, false);
  assert.equal(artifactCompileInputSchema.safeParse({ ...input, compiler: { ...input.compiler, id: "x".repeat(17_000) } }).success, false);
  assert.throws(() => parseArtifactCompileInputJson('{"inputIdentity":"sha256:' + "0".repeat(64) + '","inputIdentity":"sha256:' + "1".repeat(64) + '"}'), /duplicate/i);
});

test("re-verifies conflict status, canonical finding order, and identities on parse", () => {
  const result = createNeutralConflictResult({
    status: "possible_overlap",
    findings: [
      { kind: "foreign_rule", severity: "warning", reason: "possible_overlap", reference: "rule-b" },
      { kind: "existing_artifact", severity: "blocking", reason: "existing_artifact", reference: "artifact-a" },
    ],
  });
  assert.equal(result.findings[0]?.reference, "artifact-a");
  assert.deepEqual(parseNeutralConflictResult(result), result);
  assert.throws(() => parseNeutralConflictResult({ ...result, findings: [...result.findings].reverse() }));
  assert.throws(() => parseNeutralConflictResult({ ...result, status: "none", findings: result.findings }));
});
