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
  createNeutralWorldCut,
  neutralCompileInputIdentity,
  parseArtifactCompileAttestation,
  parseArtifactCompileInput,
  parseNeutralConflictResult,
  parseNeutralDiff,
  parseNeutralDryRunAttestation,
  parseArtifactCompileInputJson,
  deriveArtifactCapabilityScope,
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
  return { artifactRef, evidence, risk, authority, watermark, capabilityScope };
}

function curtainInput() {
  const artifact = curtainArtifact();
  const bound = boundAssessments(artifact);
  const device = createNeutralDeviceSummary({
    hwCapabilityId: "hwc-curtain-level",
    schema: "hob.cover.level",
    schemaVersion: "1.0.0",
    semanticKind: "cover",
    currentValue: 0.2,
    validity: "valid",
    actionCompatibility: [{
      order: 1,
      kind: "set_level",
      status: "incompatible",
      reason: "set_level_unsupported",
    }],
  });
  const worldCut = createNeutralWorldCut({ devices: [device], watermarks: [bound.watermark] });
  const conflict = createNeutralConflictInput({
    bridgeId: bound.watermark.bridgeId,
    epochId: bound.watermark.epochId,
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
    worldCut,
    foreignCatalogIdentity: digest("f"),
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

test("preserves action order in a bounded neutral diff and supports missing-before unavailable", () => {
  const diff = createNeutralDiff({
    status: "unavailable",
    operations: [
      { order: 1, kind: "set_level", hwCapabilityId: "hwc-curtain-level", actionAuthorityCandidateId: "candidate-curtain", after: 0.65 },
      { order: 2, kind: "notify_local", after: "Curtain state needs review." },
    ],
    unchangedCount: 0,
    redacted: true,
  });
  assert.deepEqual(diff.operations.map((operation) => operation.order), [1, 2]);
  assert.equal(diff.operations[0]?.before, undefined);
  assert.deepEqual(parseNeutralDiff(diff), diff);
  assert.throws(() => createNeutralDiff({ ...diff, operations: [diff.operations[1]!, diff.operations[0]!] }));
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
    usedWatermarks: input.worldCut.watermarks,
    diff,
    conflicts: createNeutralConflictResult({ status: "none", findings: [] }),
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
    conflictInputIdentity: digest("d"),
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
    currentValue: true,
    validity: "valid",
    actionCompatibility: [{
      order: 1,
      kind: "set_boolean",
      status: "compatible",
      before: true,
      after: false,
    }],
  });
  const watermark = bound.watermark;
  const worldCut = createNeutralWorldCut({ devices: [device], watermarks: [watermark] });
  const conflict = createNeutralConflictInput({
    bridgeId: watermark.bridgeId,
    epochId: watermark.epochId,
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
    worldCut,
    foreignCatalogIdentity: digest("d"),
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
    currentValue: true,
    validity: "valid" as const,
    actionCompatibility: [{ order: 1, kind: "set_boolean" as const, status: "compatible" as const, before: true, after: false }],
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
    currentValue: false,
    validity: "valid",
    actionCompatibility: [],
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
    bridgeId: "bridge-notify",
    epochId: "epoch-notify",
    catalogIdentity: digest("b"),
    status: "unavailable",
    findings: [{ kind: "foreign_rule", severity: "blocking", reason: "foreign_catalog_unavailable", reference: "foreign-check-notify" }],
  });
  const authority = createArtifactAuthorityAssessment({
    artifact: bound.artifactRef,
    assessmentId: "authority-notify",
    authorityRegistryIdentity: digest("a"),
    candidates: [],
    checkedWatermarks: [],
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
  const input = createArtifactCompileInput({
    artifact,
    proposal: { id: artifact.sourceProposal.proposalId, revision: artifact.sourceProposal.proposalRevision, status: "approved" },
    evidence: bound.evidence,
    risk,
    authority,
    worldCut,
    foreignCatalogIdentity: digest("b"),
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
    usedWatermarks: [],
    diff: createNeutralDiff({ status: "unavailable", operations: [], unchangedCount: 0, redacted: true }),
    conflicts: createNeutralConflictResult({ status: "unavailable", findings: [{ kind: "foreign_rule", severity: "blocking", reason: "foreign_catalog_unavailable", reference: "foreign-check-notify" }] }),
    blockingReasons: ["foreign_catalog_unavailable"],
  });
  const dryRun = createNeutralDryRunAttestation({
    compile,
    status: "unavailable",
    checkedWatermarks: [],
    diff: compile.diff,
    conflicts: compile.conflicts,
    summary: "Foreign rule catalog is unavailable; no simulation was performed.",
  });
  assert.equal(dryRun.writesPerformed, false);
  assert.equal(dryRun.status, "unavailable");
  assert.deepEqual(parseNeutralDryRunAttestation(dryRun), dryRun);
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
  const secondCheck = createNeutralConflictInput({
    bridgeId: "bridge-compiler-2",
    epochId: "epoch-compiler-2",
    catalogIdentity: input.foreignCatalogIdentity,
    status: "current",
    findings: [],
  });
  const { inputIdentity: _identity, ...draft } = input;
  const first = createArtifactCompileInput({
    ...draft,
    foreignRuleChecks: [input.foreignRuleChecks[0]!, secondCheck],
  });
  const second = createArtifactCompileInput({
    ...draft,
    foreignRuleChecks: [secondCheck, input.foreignRuleChecks[0]!],
  });
  assert.equal(first.inputIdentity, second.inputIdentity);
  assert.deepEqual(first.foreignRuleChecks.map((check) => check.bridgeId), ["bridge-compiler-1", "bridge-compiler-2"]);
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
