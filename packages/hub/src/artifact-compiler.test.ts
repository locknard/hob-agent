import assert from "node:assert/strict";
import test from "node:test";

import {
  computeNeutralForeignCatalogIdentity,
  createArtifactCompileInput,
  createNeutralConflictInput,
  createNeutralConflictResult,
  createNeutralDeviceSummary,
  createNeutralWorldCut,
  deriveArtifactCapabilityScope,
  type ArtifactCompileInput,
} from "./artifact-compiler-contract.js";
import {
  createArtifactAuthorityAssessment,
  createArtifactEvidenceAttestation,
  createArtifactRiskAssessment,
} from "./artifact-assessments.js";
import { compileNeutralArtifact } from "./artifact-compiler.js";
import { createArtifactRevision, type ArtifactRevision } from "./neutral-artifact.js";

const capturedAt = "2026-08-20T01:00:00.000Z";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function makeArtifact(withNotify = false, withCapabilityTrigger = false, withNoOpGap = false): ArtifactRevision {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: "artifact-compiler-engine-1",
    revision: 1,
    title: "Turn off the boolean capability",
    summary: "A bounded compiler fixture.",
    sourceProposal: { proposalId: "proposal-compiler-engine-1", proposalRevision: 1 },
    content: {
      trigger: withCapabilityTrigger
        ? { kind: "capability_changed", source: { hwCapabilityId: "hwc-compiler-bool" } }
        : { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "09:00" },
      conditions: [],
      actions: withNoOpGap
        ? [
            { kind: "set_boolean", target: { hwCapabilityId: "hwc-compiler-bool" }, value: true },
            { kind: "notify_local", message: "Review the boolean capability." },
            { kind: "set_boolean", target: { hwCapabilityId: "hwc-compiler-bool" }, value: false },
          ]
        : withNotify
        ? [
            { kind: "notify_local", message: "Review the boolean capability." },
            { kind: "set_boolean", target: { hwCapabilityId: "hwc-compiler-bool" }, value: false },
          ]
        : [{ kind: "set_boolean", target: { hwCapabilityId: "hwc-compiler-bool" }, value: false }],
      rollback: { kind: "restore_previous_state", target: { hwCapabilityId: "hwc-compiler-bool" }, maxAgeSeconds: 900 },
      postconditions: [{ kind: "capability_value", source: { hwCapabilityId: "hwc-compiler-bool" }, operator: "equals", value: false, withinSeconds: 120 }],
    },
    createdAt: capturedAt,
  });
}

function makeInput(withNotify = false, withCapabilityTrigger = false, withNoOpGap = false): ArtifactCompileInput {
  const artifact = makeArtifact(withNotify, withCapabilityTrigger, withNoOpGap);
  const artifactRef = {
    artifactId: artifact.artifactId,
    revision: artifact.revision,
    contentHash: artifact.contentHash,
  };
  const watermark = {
    bridgeId: "bridge-compiler-engine-1",
    epochId: "epoch-compiler-engine-1",
    lastSeq: 42,
    lastSyncCompleteAt: "2026-08-20T00:59:00.000Z",
    freshness: "fresh" as const,
    gapCount: 0,
  };
  const scope = deriveArtifactCapabilityScope(artifact.content);
  const evidence = createArtifactEvidenceAttestation({
    artifact: artifactRef,
    attestationId: "evidence-compiler-engine-1",
    source: "home-world-consistent-cut",
    sourceProposal: { proposalId: artifact.sourceProposal.proposalId, proposalRevision: artifact.sourceProposal.proposalRevision },
    proposalEvidenceIdentity: digest("e"),
    selectedHwCapabilityIds: scope,
    capturedAt,
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  });
  const authority = createArtifactAuthorityAssessment({
    artifact: artifactRef,
    assessmentId: "authority-compiler-engine-1",
    authorityRegistryIdentity: digest("a"),
    candidates: [{
      actionAuthorityCandidateId: "candidate-compiler-engine-1",
      hwCapabilityId: "hwc-compiler-bool",
      status: "available",
    }],
    checkedWatermarks: [watermark],
    assessedAt: capturedAt,
  }, { hwCapabilityIds: scope });
  const currentConflict = {
    sourceIdentity: digest("c"),
    result: createNeutralConflictResult({ status: "none", findings: [] }),
  };
  const risk = createArtifactRiskAssessment({
    artifact: artifactRef,
    assessmentId: "risk-compiler-engine-1",
    evidence: { attestationId: evidence.attestationId, inputIdentity: evidence.inputIdentity },
    authority: { assessmentId: authority.assessmentId, inputIdentity: authority.inputIdentity },
    conflictInputIdentity: currentConflict.sourceIdentity,
    class: "comfort_reversible",
    reasons: ["Bounded compiler fixture."],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
    assessedAt: capturedAt,
  });
  const device = createNeutralDeviceSummary({
    hwCapabilityId: "hwc-compiler-bool",
    schema: "miot.property",
    schemaVersion: "1.0.0",
    semanticKind: "switch",
    read: { status: "available", value: true },
    validity: "valid",
    actionCompatibility: withNoOpGap
      ? [
          { order: 1, kind: "set_boolean", status: "compatible", before: true, after: true },
          { order: 3, kind: "set_boolean", status: "compatible", before: true, after: false },
        ]
      : [{ order: withNotify ? 2 : 1, kind: "set_boolean", status: "compatible", before: true, after: false }],
    predicateCompatibility: [{ phase: "postcondition", order: 1, status: "compatible" }],
  });
  const worldCut = createNeutralWorldCut({ devices: [device], watermarks: [watermark] });
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

test("compiles only the parsed neutral input and emits a frozen authority-bound diff", () => {
  const input = makeInput();
  const result = compileNeutralArtifact(input);

  assert.equal(result.status, "compiled");
  assert.deepEqual(result.plan, input.artifact.content);
  assert.deepEqual(result.diff, {
    status: "changes",
    operations: [{
      actionOrder: 1,
      kind: "set_boolean",
      hwCapabilityId: "hwc-compiler-bool",
      actionAuthorityCandidateId: "candidate-compiler-engine-1",
      before: true,
      after: false,
    }],
    unchangedCount: 0,
    redacted: true,
  });
  assert.deepEqual(result.conflicts, input.currentConflict.result);
  assert.deepEqual(result.actionAuthorityBindings, [{
    actionOrder: 1,
    kind: "set_boolean",
    hwCapabilityId: "hwc-compiler-bool",
    actionAuthorityCandidateId: "candidate-compiler-engine-1",
  }]);
  assert.deepEqual(compileNeutralArtifact(input), result);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.diff), true);
});

test("retains artifact action order across notify and device diff operations", () => {
  const result = compileNeutralArtifact(makeInput(true));

  assert.equal(result.status, "compiled");
  assert.deepEqual(result.diff.operations.map((operation) => operation.actionOrder), [1, 2]);
  assert.equal(result.diff.unchangedCount, 0);
});

test("keeps a no-op action gap in the original artifact action order", () => {
  const result = compileNeutralArtifact(makeInput(false, false, true));

  assert.equal(result.status, "compiled");
  assert.deepEqual(result.diff.operations.map((operation) => operation.actionOrder), [2, 3]);
  assert.equal(result.diff.unchangedCount, 1);
});

test("accounts for a compatible no-op as no_change without fabricating an operation", () => {
  const input = makeInput();
  const device = input.worldCut.devices[0]!;
  const { inputIdentity: _identity, ...draft } = input;
  const noOpInput = createArtifactCompileInput({
    ...draft,
    worldCut: createNeutralWorldCut({
      devices: [{
        ...device,
        read: { status: "available", value: false },
        actionCompatibility: [{ ...device.actionCompatibility[0]!, before: false, after: false }],
      }],
      watermarks: input.worldCut.watermarks,
    }),
  });
  const result = compileNeutralArtifact(noOpInput);

  assert.equal(result.status, "compiled");
  assert.deepEqual(result.diff.operations, []);
  assert.equal(result.diff.status, "no_change");
  assert.equal(result.diff.unchangedCount, 1);
});

test("rejects deterministic action incompatibility after checking unavailable dependencies", () => {
  const input = makeInput();
  const device = input.worldCut.devices[0]!;
  const { inputIdentity: _identity, ...draft } = input;
  const rejectedInput = createArtifactCompileInput({
    ...draft,
    worldCut: createNeutralWorldCut({
      devices: [{
        ...device,
        actionCompatibility: [{ order: 1, kind: "set_boolean", status: "incompatible", reason: "not_writable" }],
      }],
      watermarks: input.worldCut.watermarks,
    }),
  });
  const result = compileNeutralArtifact(rejectedInput);

  assert.equal(result.status, "rejected");
  assert.ok(result.blockingReasons.includes("not_writable"));
  assert.equal(result.diff.status, "unavailable");
});

test("rejects an unknown risk policy identity instead of compiling it", () => {
  const input = makeInput();
  const risk = createArtifactRiskAssessment({
    artifact: input.risk.artifact,
    assessmentId: "risk-compiler-unknown-policy",
    evidence: input.risk.evidence,
    authority: input.risk.authority,
    conflictInputIdentity: input.risk.conflictInputIdentity,
    class: input.risk.class,
    reasons: ["Unknown policy fixture."],
    policyId: "policy-unknown",
    policyVersion: "9.9.9",
    assessedAt: capturedAt,
  });
  const { inputIdentity: _identity, ...draft } = input;
  const unknownPolicyInput = createArtifactCompileInput({ ...draft, risk });
  const result = compileNeutralArtifact(unknownPolicyInput);

  assert.equal(result.status, "rejected");
  assert.deepEqual(result.blockingReasons, ["policy_blocked"]);
});

test("keeps pending proposal input unavailable and rejected proposal input rejected", () => {
  const input = makeInput();
  const { inputIdentity: _identity, ...draft } = input;
  const pending = compileNeutralArtifact(createArtifactCompileInput({
    ...draft,
    proposal: { ...input.proposal, status: "pending_review" },
  }));
  const rejected = compileNeutralArtifact(createArtifactCompileInput({
    ...draft,
    proposal: { ...input.proposal, status: "rejected" },
  }));

  assert.equal(pending.status, "unavailable");
  assert.ok(pending.blockingReasons.includes("not_ready"));
  assert.equal(rejected.status, "rejected");
  assert.ok(rejected.blockingReasons.includes("policy_blocked"));
});

test("gives authority unavailability priority over deterministic action rejection", () => {
  const input = makeInput();
  const authority = createArtifactAuthorityAssessment({
    artifact: input.authority.artifact,
    assessmentId: "authority-compiler-unavailable",
    authorityRegistryIdentity: digest("a"),
    candidates: [],
    checkedWatermarks: input.worldCut.watermarks,
    assessedAt: capturedAt,
  }, { hwCapabilityIds: ["hwc-compiler-bool"] });
  const risk = createArtifactRiskAssessment({
    artifact: input.risk.artifact,
    assessmentId: "risk-compiler-authority-unavailable",
    evidence: input.risk.evidence,
    authority: { assessmentId: authority.assessmentId, inputIdentity: authority.inputIdentity },
    conflictInputIdentity: input.risk.conflictInputIdentity,
    class: input.risk.class,
    reasons: ["Authority unavailable fixture."],
    policyId: input.risk.policyId,
    policyVersion: input.risk.policyVersion,
    assessedAt: capturedAt,
  });
  const { inputIdentity: _identity, ...draft } = input;
  const unavailableInput = createArtifactCompileInput({
    ...draft,
    authority,
    risk,
    worldCut: createNeutralWorldCut({
      devices: [{
        ...input.worldCut.devices[0]!,
        actionCompatibility: [{ order: 1, kind: "set_boolean", status: "incompatible", reason: "not_writable" }],
      }],
      watermarks: input.worldCut.watermarks,
    }),
  });
  const result = compileNeutralArtifact(unavailableInput);

  assert.equal(result.status, "unavailable");
  assert.ok(result.blockingReasons.includes("authority_unavailable"));
  assert.ok(result.blockingReasons.includes("not_writable"));
});

test("uses precomputed predicate compatibility for rejection and unavailability", () => {
  const input = makeInput();
  const device = input.worldCut.devices[0]!;
  const { inputIdentity: _identity, ...draft } = input;
  const incompatible = compileNeutralArtifact(createArtifactCompileInput({
    ...draft,
    worldCut: createNeutralWorldCut({
      devices: [{
        ...device,
        predicateCompatibility: [{ phase: "postcondition", order: 1, status: "incompatible", reason: "predicate_type_mismatch" }],
      }],
      watermarks: input.worldCut.watermarks,
    }),
  }));
  const unavailable = compileNeutralArtifact(createArtifactCompileInput({
    ...draft,
    worldCut: createNeutralWorldCut({
      devices: [{
        ...device,
        predicateCompatibility: [{ phase: "postcondition", order: 1, status: "unavailable", reason: "state_missing" }],
      }],
      watermarks: input.worldCut.watermarks,
    }),
  }));

  assert.equal(incompatible.status, "rejected");
  assert.ok(incompatible.blockingReasons.includes("predicate_type_mismatch"));
  assert.equal(unavailable.status, "unavailable");
  assert.ok(unavailable.blockingReasons.includes("state_missing"));
});

test("uses only the precomputed capability-change read status", () => {
  const input = makeInput(false, true);
  const device = input.worldCut.devices[0]!;
  const { inputIdentity: _identity, ...draft } = input;
  const unsupported = compileNeutralArtifact(createArtifactCompileInput({
    ...draft,
    worldCut: createNeutralWorldCut({
      devices: [{ ...device, read: { status: "unsupported", reason: "schema_unsupported" } }],
      watermarks: input.worldCut.watermarks,
    }),
  }));
  const unavailable = compileNeutralArtifact(createArtifactCompileInput({
    ...draft,
    worldCut: createNeutralWorldCut({
      devices: [{ ...device, read: { status: "unavailable", reason: "state_missing" }, validity: "unavailable" }],
      watermarks: input.worldCut.watermarks,
    }),
  }));

  assert.equal(unsupported.status, "rejected");
  assert.ok(unsupported.blockingReasons.includes("schema_unsupported"));
  assert.equal(unavailable.status, "unavailable");
  assert.ok(unavailable.blockingReasons.includes("state_missing"));
});

test("rejects malformed compiler input with the neutral contract error", () => {
  assert.throws(
    () => compileNeutralArtifact({ ...makeInput(), compiler: { id: "neutral-compiler", version: "not-semver" } } as never),
    (error: unknown) => error instanceof TypeError && error.name === "ArtifactCompilerContractError",
  );
});

test("uses unavailable before rejected when an input dependency is unavailable", () => {
  const input = makeInput();
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
  const unavailableInput = {
    ...draft,
    currentConflict: {
      ...input.currentConflict,
      result: createNeutralConflictResult({
        status: "unavailable",
        findings: [{ kind: "foreign_rule", severity: "blocking", reason: "foreign_catalog_unavailable" }],
      }),
    },
    foreignCatalogIdentity: computeNeutralForeignCatalogIdentity([foreignCheck]),
    foreignRuleChecks: [foreignCheck],
  };
  const parsedUnavailableInput = createArtifactCompileInput(unavailableInput);
  const result = compileNeutralArtifact(parsedUnavailableInput);
  assert.equal(result.status, "unavailable");
  assert.ok(result.blockingReasons.includes("foreign_catalog_unavailable"));
  assert.equal(result.diff.status, "unavailable");
});
