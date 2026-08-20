import assert from "node:assert/strict";
import test from "node:test";

import {
  createArtifactAuthorityAssessment,
  createArtifactEvidenceAttestation,
  createArtifactRiskAssessment,
  type ArtifactAuthorityAssessment,
  type ArtifactEvidenceAttestation,
  type ArtifactRiskAssessment,
} from "./artifact-assessments.js";
import {
  createArtifactCompileAttestation,
  createArtifactCompileInput,
  createNeutralConflictInput,
  createNeutralConflictResult,
  createNeutralWorldCut,
  computeNeutralForeignCatalogIdentity,
  type ArtifactCompileAttestation,
  type ArtifactCompileInput,
  type NeutralDryRunAttestation,
} from "./artifact-compiler-contract.js";
import { compileNeutralArtifact } from "./artifact-compiler.js";
import { produceNeutralDryRun } from "./artifact-dry-run.js";
import {
  ArtifactCompilationCoordinator,
  ArtifactCompilationCoordinatorError,
  type ArtifactCompilationCoordinatorOptions,
  type ArtifactCompilationResultEntry,
} from "./artifact-compilation-coordinator.js";
import {
  createArtifactRevision,
  type ArtifactRef,
  type ArtifactRevision,
} from "./neutral-artifact.js";
import type { ArtifactAssessmentEntry, ArtifactRegistryEntry } from "./artifact-registry.js";

const at = "2026-08-20T01:00:00.000Z";
const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

function artifact(): ArtifactRevision {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: "artifact-compilation-coordinator-1",
    revision: 1,
    title: "Review the household note",
    summary: "Send a local review note.",
    sourceProposal: { proposalId: "proposal-compilation-coordinator-1", proposalRevision: 2 },
    content: {
      trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "09:00" },
      conditions: [],
      actions: [{ kind: "notify_local", message: "Review the curtain position." }],
      rollback: { kind: "no_remote_change" },
      postconditions: [],
    },
    createdAt: at,
  });
}

function ref(value = artifact()): ArtifactRef {
  return { artifactId: value.artifactId, revision: value.revision, contentHash: value.contentHash };
}

function watermark() {
  return {
    bridgeId: "bridge-compilation-coordinator-1",
    epochId: "epoch-compilation-coordinator-1",
    lastSeq: 42,
    lastSyncCompleteAt: "2026-08-20T00:59:00.000Z",
    freshness: "fresh" as const,
    gapCount: 0,
  };
}

function evidenceAssessment(artifactRef: ArtifactRef): ArtifactEvidenceAttestation {
  return createArtifactEvidenceAttestation({
    artifact: artifactRef,
    attestationId: "evidence-compilation-coordinator-1",
    capturedAt: at,
    source: "home-world-consistent-cut",
    sourceProposal: { proposalId: "proposal-compilation-coordinator-1", proposalRevision: 2 },
    proposalEvidenceIdentity: digest("e"),
    selectedHwCapabilityIds: [],
    watermarks: [watermark()],
    coverage: "complete",
    reasons: [],
  });
}

function authorityAssessment(artifactRef: ArtifactRef): ArtifactAuthorityAssessment {
  return createArtifactAuthorityAssessment({
    artifact: artifactRef,
    assessmentId: "authority-compilation-coordinator-1",
    assessedAt: at,
    authorityRegistryIdentity: digest("a"),
    candidates: [],
    checkedWatermarks: [watermark()],
  }, { hwCapabilityIds: [] });
}

function riskAssessment(
  artifactRef: ArtifactRef,
  evidence: ArtifactEvidenceAttestation,
  authority: ArtifactAuthorityAssessment,
): ArtifactRiskAssessment {
  return createArtifactRiskAssessment({
    artifact: artifactRef,
    assessmentId: "risk-compilation-coordinator-1",
    assessedAt: at,
    evidence: { attestationId: evidence.attestationId, inputIdentity: evidence.inputIdentity },
    authority: { assessmentId: authority.assessmentId, inputIdentity: authority.inputIdentity },
    conflictInputIdentity: digest("c"),
    class: "observe_or_notify",
    reasons: ["Bounded coordinator fixture."],
    policyId: "policy-home-v1",
    policyVersion: "1.0.0",
  });
}

function assessmentEntry(assessment: ArtifactEvidenceAttestation | ArtifactAuthorityAssessment | ArtifactRiskAssessment): ArtifactAssessmentEntry {
  const recordId = assessment.kind === "evidence-attestation" ? assessment.attestationId : assessment.assessmentId;
  return {
    kind: assessment.kind,
    recordId,
    artifact: assessment.artifact,
    inputIdentity: assessment.inputIdentity,
    recordedAt: at,
    assessment,
    audit: [],
  };
}

function resultEntry(result: ArtifactCompileAttestation | NeutralDryRunAttestation): ArtifactCompilationResultEntry {
  return {
    kind: result.kind,
    resultId: result.resultId,
    artifact: result.artifact,
    inputIdentity: result.inputIdentity,
    recordedAt: at,
    result,
  };
}

interface Fixture {
  readonly artifact: ArtifactRevision;
  readonly evidence: ArtifactEvidenceAttestation;
  readonly authority: ArtifactAuthorityAssessment;
  readonly risk: ArtifactRiskAssessment;
  readonly compileCut: {
    readonly currentConflict: {
      readonly sourceIdentity: string;
      readonly result: ReturnType<typeof createNeutralConflictResult>;
    };
    readonly foreignRuleChecks: readonly ReturnType<typeof createNeutralConflictInput>[];
    readonly foreignCatalogIdentity: string;
  };
  readonly worldCut: ReturnType<typeof createNeutralWorldCut>;
}

function fixture(): Fixture {
  const artifactValue = artifact();
  const artifactRef = ref(artifactValue);
  const evidence = evidenceAssessment(artifactRef);
  const authority = authorityAssessment(artifactRef);
  const risk = riskAssessment(artifactRef, evidence, authority);
  const check = createNeutralConflictInput({
    bridgeId: watermark().bridgeId,
    epochId: watermark().epochId,
    watermark: watermark(),
    catalogIdentity: digest("f"),
    status: "current",
    findings: [],
  });
  return {
    artifact: artifactValue,
    evidence,
    authority,
    risk,
    compileCut: {
      currentConflict: {
        sourceIdentity: risk.conflictInputIdentity,
        result: createNeutralConflictResult({ status: "none", findings: [] }),
      },
      foreignRuleChecks: [check],
      foreignCatalogIdentity: computeNeutralForeignCatalogIdentity([check]),
    },
    worldCut: createNeutralWorldCut({ devices: [], watermarks: [watermark()] }),
  };
}

function setup(overrides: Partial<{
  readonly capture: (input: unknown) => Promise<unknown>;
  readonly worldCut: (input: unknown) => unknown;
  readonly proposal: (proposalId: string) => unknown;
  readonly compiler: (input: unknown) => unknown;
  readonly dryRun: (input: unknown) => unknown;
  readonly recordCompile: (input: unknown) => unknown;
  readonly recordDryRun: (input: unknown) => unknown;
}> = {}) {
  const value = fixture();
  const order: string[] = [];
  const results: Array<ArtifactCompileAttestation | NeutralDryRunAttestation> = [];
  let compilerInput: ArtifactCompileInput | undefined;
  const registry = {
    getRevision: (_artifactId: string, _revision: number): ArtifactRegistryEntry => {
      order.push("draft");
      return { artifact: value.artifact, status: "draft", tombstone: false, audit: [] };
    },
    latestAttestation: (query: { readonly kind: string; readonly artifact: ArtifactRef }): ArtifactAssessmentEntry => {
      order.push(query.kind);
      if (query.kind === "evidence-attestation") return assessmentEntry(value.evidence);
      if (query.kind === "authority-assessment") return assessmentEntry(value.authority);
      return assessmentEntry(value.risk);
    },
    recordCompile: (input: unknown) => {
      order.push("record-compile");
      return overrides.recordCompile?.(input) ?? resultEntry(results[0]!);
    },
    recordDryRun: (input: unknown) => {
      order.push("record-dry-run");
      return overrides.recordDryRun?.(input) ?? resultEntry(results[1]!);
    },
  };
  const options: ArtifactCompilationCoordinatorOptions = {
    registry,
    proposals: {
      get: (proposalId: string) => {
        order.push("proposal");
        return overrides.proposal?.(proposalId) ?? {
          id: proposalId,
          revision: value.artifact.sourceProposal.proposalRevision,
          status: "approved" as const,
        };
      },
    },
    conflict: {
      capture: async (input: unknown) => {
        order.push("capture");
        return overrides.capture?.(input) ?? {
          assess: () => ({ status: "none", findings: [], sourceIdentity: digest("c") }),
          compileCut: () => {
            order.push("compile-cut");
            return value.compileCut;
          },
        };
      },
    },
    worldCut: {
      read: (input: unknown) => {
        order.push("world-cut");
        return overrides.worldCut?.(input) ?? value.worldCut;
      },
    },
    compiler: {
      id: "test-compiler",
      version: "1.0.0",
      compile: (input: ArtifactCompileInput) => {
      order.push("compiler");
      compilerInput = input;
      const result = overrides.compiler?.(input) ?? compileNeutralArtifact(input as never);
      if (result && typeof result === "object" && "kind" in result && result.kind === "compile-attestation") {
        results[0] = result as ArtifactCompileAttestation;
      }
      return result;
      },
    },
    dryRun: (input: unknown) => {
      order.push("dry-run");
      const result = overrides.dryRun?.(input) ?? produceNeutralDryRun(input as never);
      if (result && typeof result === "object" && "kind" in result && result.kind === "dry-run-attestation") {
        results[1] = result as NeutralDryRunAttestation;
      }
      return result;
    },
  };
  const coordinator = new ArtifactCompilationCoordinator(options);
  return { value, order, coordinator, options, get compilerInput() { return compilerInput; } };
}

test("sequences exact reads, one capture cut, pure results, and ordered persistence", async () => {
  const env = setup();
  const receipt = await env.coordinator.compile(ref(env.value.artifact));

  assert.deepEqual(env.order, [
    "draft",
    "evidence-attestation",
    "risk-assessment",
    "authority-assessment",
    "capture",
    "compile-cut",
    "world-cut",
    "proposal",
    "compiler",
    "dry-run",
    "record-compile",
    "record-dry-run",
  ]);
  assert.equal(receipt.artifact.contentHash, env.value.artifact.contentHash);
  assert.equal(receipt.compile.status, "compiled");
  assert.equal(receipt.dryRun.status, "passed");
  assert.equal(receipt.dryRun.writesPerformed, false);
  assert.equal(env.compilerInput?.compiler.id, "test-compiler");
  assert.equal(env.compilerInput?.compiler.version, "1.0.0");
});

test("requires explicit compiler metadata instead of accepting a bare compiler function", () => {
  const env = setup();
  assert.throws(
    () => new ArtifactCompilationCoordinator({ ...env.options, compiler: compileNeutralArtifact }),
    TypeError,
  );
});

test("does not compile or persist when capture cannot provide a compile cut", async () => {
  const env = setup({ capture: async () => ({ compileCut: () => undefined }) });
  await assert.rejects(
    env.coordinator.compile(ref(env.value.artifact)),
    (error: unknown) => error instanceof ArtifactCompilationCoordinatorError && error.stage === "capture",
  );
  assert.equal(env.order.includes("compiler"), false);
  assert.equal(env.order.some((item) => item.startsWith("record-")), false);
});

test("does not compile or persist when the world cut is malformed", async () => {
  const env = setup({ worldCut: () => ({}) });
  await assert.rejects(
    env.coordinator.compile(ref(env.value.artifact)),
    (error: unknown) => error instanceof ArtifactCompilationCoordinatorError && error.stage === "world-cut",
  );
  assert.equal(env.order.includes("compiler"), false);
  assert.equal(env.order.some((item) => item.startsWith("record-")), false);
});

test("replays a successful compile persist before retrying a failed dry-run persist", async () => {
  let dryRunWrites = 0;
  const env = setup({
    recordDryRun: (input) => {
      dryRunWrites += 1;
      if (dryRunWrites === 1) throw new Error("write failed");
      const result = (input as { readonly result: NeutralDryRunAttestation }).result;
      return resultEntry(result);
    },
  });
  await assert.rejects(env.coordinator.compile(ref(env.value.artifact)));
  const receipt = await env.coordinator.compile(ref(env.value.artifact));

  assert.equal(receipt.dryRun.writesPerformed, false);
  assert.deepEqual(env.order.filter((item) => item.startsWith("record-")), [
    "record-compile",
    "record-dry-run",
    "record-compile",
    "record-dry-run",
  ]);
});

test("rejects malformed dependency and compiler results before any persistence", async () => {
  const malformedEvidence = setup({
    proposal: () => ({ id: "other", revision: 2, status: "approved" }),
  });
  await assert.rejects(
    malformedEvidence.coordinator.compile(ref(malformedEvidence.value.artifact)),
    (error: unknown) => error instanceof ArtifactCompilationCoordinatorError,
  );
  assert.equal(malformedEvidence.order.some((item) => item.startsWith("record-")), false);

  const malformedCompiler = setup({ compiler: () => ({ status: "compiled" }) });
  await assert.rejects(malformedCompiler.coordinator.compile(ref(malformedCompiler.value.artifact)));
  assert.equal(malformedCompiler.order.some((item) => item.startsWith("record-")), false);
});

test("rejects a dry-run result that claims writes were performed", async () => {
  const env = setup({
    dryRun: (input) => ({
      ...(produceNeutralDryRun(input as never) as NeutralDryRunAttestation),
      writesPerformed: true,
    }),
  });
  await assert.rejects(env.coordinator.compile(ref(env.value.artifact)));
  assert.equal(env.order.includes("record-compile"), false);
  assert.equal(env.order.includes("record-dry-run"), false);
});

test("requires the exact ArtifactRef and keeps the receipt deeply frozen", async () => {
  const env = setup();
  await assert.rejects(env.coordinator.compile({ ...ref(env.value.artifact), revision: 2 } as never));
  const receipt = await env.coordinator.compile(ref(env.value.artifact));
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.artifact), true);
  assert.equal(Object.isFrozen(receipt.compile), true);
  assert.equal(Object.isFrozen(receipt.dryRun), true);
});
