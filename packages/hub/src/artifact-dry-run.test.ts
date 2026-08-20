import assert from "node:assert/strict";
import test from "node:test";

import {
  computeNeutralForeignCatalogIdentity,
  createArtifactCompileInput,
  createNeutralConflictInput,
  createNeutralConflictResult,
  createNeutralWorldCut,
} from "./artifact-compiler-contract.js";
import {
  createArtifactAuthorityAssessment,
  createArtifactEvidenceAttestation,
  createArtifactRiskAssessment,
} from "./artifact-assessments.js";
import { compileNeutralArtifact } from "./artifact-compiler.js";
import { produceNeutralDryRun } from "./artifact-dry-run.js";
import { createArtifactRevision } from "./neutral-artifact.js";

const capturedAt = "2026-08-20T01:00:00.000Z";
const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function makeNotifyInput() {
  const artifact = createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: "artifact-dry-run-1",
    revision: 1,
    title: "Send a local review note",
    summary: "A notify-only dry-run fixture.",
    sourceProposal: { proposalId: "proposal-dry-run-1", proposalRevision: 1 },
    content: {
      trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "09:00" },
      conditions: [],
      actions: [{ kind: "notify_local", message: "Review the household state." }],
      rollback: { kind: "no_remote_change" },
      postconditions: [],
    },
    createdAt: capturedAt,
  });
  const artifactRef = { artifactId: artifact.artifactId, revision: artifact.revision, contentHash: artifact.contentHash };
  const watermark = {
    bridgeId: "bridge-dry-run-1",
    epochId: "epoch-dry-run-1",
    lastSeq: 7,
    lastSyncCompleteAt: capturedAt,
    freshness: "fresh" as const,
    gapCount: 0,
  };
  const evidence = createArtifactEvidenceAttestation({
    artifact: artifactRef,
    attestationId: "evidence-dry-run-1",
    source: "home-world-consistent-cut",
    sourceProposal: { proposalId: artifact.sourceProposal.proposalId, proposalRevision: artifact.sourceProposal.proposalRevision },
    proposalEvidenceIdentity: digest("e"),
    selectedHwCapabilityIds: [],
    capturedAt,
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  });
  const authority = createArtifactAuthorityAssessment({
    artifact: artifactRef,
    assessmentId: "authority-dry-run-1",
    authorityRegistryIdentity: digest("a"),
    candidates: [],
    checkedWatermarks: [watermark],
    assessedAt: capturedAt,
  }, { hwCapabilityIds: [] });
  const currentConflict = { sourceIdentity: digest("c"), result: createNeutralConflictResult({ status: "none", findings: [] }) };
  const risk = createArtifactRiskAssessment({
    artifact: artifactRef,
    assessmentId: "risk-dry-run-1",
    evidence: { attestationId: evidence.attestationId, inputIdentity: evidence.inputIdentity },
    authority: { assessmentId: authority.assessmentId, inputIdentity: authority.inputIdentity },
    conflictInputIdentity: currentConflict.sourceIdentity,
    class: "observe_or_notify",
    reasons: ["Notify-only dry-run fixture."],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
    assessedAt: capturedAt,
  });
  const worldCut = createNeutralWorldCut({ devices: [], watermarks: [watermark] });
  const foreignCheck = createNeutralConflictInput({
    bridgeId: watermark.bridgeId,
    epochId: watermark.epochId,
    watermark,
    catalogIdentity: digest("f"),
    status: "current",
    findings: [],
  });
  return createArtifactCompileInput({
    artifact,
    proposal: { id: artifact.sourceProposal.proposalId, revision: artifact.sourceProposal.proposalRevision, status: "approved" },
    evidence,
    risk,
    authority,
    currentConflict,
    worldCut,
    foreignCatalogIdentity: computeNeutralForeignCatalogIdentity([foreignCheck]),
    foreignRuleChecks: [foreignCheck],
    compiler: { id: "neutral-compiler", version: "1.0.0" },
  });
}

test("produces a dry-run only from compile output and records no writes", () => {
  const input = makeNotifyInput();
  const compile = compileNeutralArtifact(input);
  const dryRun = produceNeutralDryRun(compile);

  assert.equal(dryRun.status, "passed");
  assert.equal(dryRun.writesPerformed, false);
  assert.equal(dryRun.compileAttestationId, compile.resultId);
  assert.deepEqual(dryRun.diff, compile.diff);
  assert.deepEqual(dryRun.conflicts, compile.conflicts);
  assert.deepEqual(produceNeutralDryRun(compile), dryRun);
  assert.equal(Object.isFrozen(dryRun), true);
});

test("fails closed with the contract error for malformed dry-run input", () => {
  const compile = compileNeutralArtifact(makeNotifyInput());
  assert.throws(
    () => produceNeutralDryRun({ ...compile, resultId: digest("x") } as never),
    (error: unknown) => error instanceof TypeError && error.name === "ArtifactCompilerContractError",
  );
});

test("keeps a deterministic conflict in the compile result and fails its dry-run", () => {
  const input = makeNotifyInput();
  const { inputIdentity: _identity, ...draft } = input;
  const finding = { kind: "foreign_rule" as const, severity: "warning" as const, reason: "possible_overlap" as const };
  const foreignCheck = createNeutralConflictInput({
    ...input.foreignRuleChecks[0]!,
    findings: [finding],
  });
  const conflictedInput = createArtifactCompileInput({
    ...draft,
    currentConflict: {
      sourceIdentity: input.currentConflict.sourceIdentity,
      result: createNeutralConflictResult({
        status: "possible_overlap",
        findings: [finding],
      }),
    },
    foreignCatalogIdentity: computeNeutralForeignCatalogIdentity([foreignCheck]),
    foreignRuleChecks: [foreignCheck],
  });
  const compile = compileNeutralArtifact(conflictedInput);
  const dryRun = produceNeutralDryRun(compile);

  assert.equal(compile.status, "compiled");
  assert.equal(compile.conflicts.status, "possible_overlap");
  assert.equal(dryRun.status, "failed");
  assert.equal(dryRun.writesPerformed, false);
});

test("maps unavailable compile dependencies to an unavailable, non-writing dry-run", () => {
  const input = makeNotifyInput();
  const watermark = input.worldCut.watermarks[0]!;
  const foreignCheck = createNeutralConflictInput({
    bridgeId: watermark.bridgeId,
    epochId: watermark.epochId,
    watermark,
    catalogIdentity: digest("f"),
    status: "unavailable",
    findings: [{ kind: "foreign_rule", severity: "blocking", reason: "foreign_catalog_unavailable" }],
  });
  const { inputIdentity: _identity, ...draft } = input;
  const unavailableInput = createArtifactCompileInput({
    ...draft,
    currentConflict: {
      sourceIdentity: input.currentConflict.sourceIdentity,
      result: createNeutralConflictResult({
        status: "unavailable",
        findings: [{ kind: "foreign_rule", severity: "blocking", reason: "foreign_catalog_unavailable" }],
      }),
    },
    foreignCatalogIdentity: computeNeutralForeignCatalogIdentity([foreignCheck]),
    foreignRuleChecks: [foreignCheck],
  });
  const compile = compileNeutralArtifact(unavailableInput);
  const dryRun = produceNeutralDryRun(compile);

  assert.equal(compile.status, "unavailable");
  assert.equal(dryRun.status, "unavailable");
  assert.equal(dryRun.writesPerformed, false);
});
