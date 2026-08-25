import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import {
  createArtifactAuthorityAssessment,
  createArtifactEvidenceAttestation,
  createArtifactRiskAssessment,
} from "../artifact/artifact-assessments.js";
import {
  computeNeutralForeignCatalogIdentity,
  createArtifactCompileAttestation,
  createArtifactCompileInput,
  createNeutralConflictInput,
  createNeutralConflictResult,
  createNeutralDiff,
  createNeutralDryRunAttestation,
  createNeutralWorldCut,
} from "../artifact/artifact-compiler-contract.js";
import {
  createHistoryReplayInput,
  createHistoryReplayResult,
} from "../artifact/artifact-history-replay-attestation.js";
import { ArtifactRegistry, type ArtifactAssessmentEntry } from "../artifact/artifact-registry.js";
import { HomeArtifactService } from "./home-artifact-service.js";
import { createArtifactRevision } from "../artifact/neutral-artifact.js";

function fixtureArtifact(options: {
  readonly artifactId?: string;
  readonly proposalId?: string;
  readonly proposalRevision?: number;
} = {}) {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: options.artifactId ?? "artifact-service-fixture",
    revision: 1,
    title: "Local reminder",
    summary: "Create one local review notification without a remote change.",
    sourceProposal: {
      proposalId: options.proposalId ?? "proposal-service-fixture",
      proposalRevision: options.proposalRevision ?? 2,
    },
    content: {
      trigger: {
        kind: "schedule",
        timezone: "Etc/UTC",
        daysOfWeek: [1],
        at: "08:00",
      },
      conditions: [],
      actions: [{ kind: "notify_local", message: "Review the morning comfort window." }],
      rollback: { kind: "no_remote_change" },
      postconditions: [],
    },
    createdAt: "2026-08-20T01:00:00.000Z",
  });
}

function fixtureCompilerResults(artifact: ReturnType<typeof fixtureArtifact>) {
  const artifactRef = {
    artifactId: artifact.artifactId,
    revision: artifact.revision,
    contentHash: artifact.contentHash,
  };
  const watermark = {
    bridgeId: "bridge-service-fixture",
    epochId: "epoch-service-fixture",
    lastSeq: 1,
    lastSyncCompleteAt: "2026-08-20T00:59:00.000Z",
    freshness: "fresh" as const,
    gapCount: 0,
  };
  const evidence = createArtifactEvidenceAttestation({
    artifact: artifactRef,
    attestationId: "evidence-service-fixture",
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    sourceProposal: artifact.sourceProposal,
    proposalEvidenceIdentity: `sha256:${"b".repeat(64)}`,
    selectedHwCapabilityIds: [],
    watermarks: [watermark],
    coverage: "complete",
    reasons: [],
  });
  const authority = createArtifactAuthorityAssessment({
    artifact: artifactRef,
    assessmentId: "authority-service-fixture",
    assessedAt: "2026-08-20T01:00:00.000Z",
    authorityRegistryIdentity: `sha256:${"d".repeat(64)}`,
    candidates: [],
    checkedWatermarks: [watermark],
  }, { hwCapabilityIds: [] });
  const risk = createArtifactRiskAssessment({
    artifact: artifactRef,
    assessmentId: "risk-service-fixture",
    assessedAt: "2026-08-20T01:00:00.000Z",
    evidence: {
      attestationId: evidence.attestationId,
      inputIdentity: evidence.inputIdentity,
    },
    authority: {
      assessmentId: authority.assessmentId,
      inputIdentity: authority.inputIdentity,
    },
    conflictInputIdentity: `sha256:${"c".repeat(64)}`,
    class: "observe_or_notify",
    reasons: ["Local notification only; no remote state changes."],
    policyId: "home-artifact-phase-one",
    policyVersion: "1.0.0",
  });
  const currentConflict = {
    sourceIdentity: risk.conflictInputIdentity,
    result: createNeutralConflictResult({ status: "none", findings: [] }),
  };
  const foreignCheck = createNeutralConflictInput({
    bridgeId: watermark.bridgeId,
    epochId: watermark.epochId,
    watermark,
    catalogIdentity: `sha256:${"f".repeat(64)}`,
    status: "current",
    findings: [],
  });
  const input = createArtifactCompileInput({
    artifact,
    proposal: {
      id: artifact.sourceProposal.proposalId,
      revision: artifact.sourceProposal.proposalRevision,
      status: "approved",
    },
    evidence,
    risk,
    authority,
    currentConflict,
    worldCut: createNeutralWorldCut({ devices: [], watermarks: [watermark] }),
    foreignCatalogIdentity: computeNeutralForeignCatalogIdentity([foreignCheck]),
    foreignRuleChecks: [foreignCheck],
    compiler: { id: "neutral-compiler", version: "1.0.0" },
  });
  const compile = createArtifactCompileAttestation({
    input,
    status: "compiled",
    plan: artifact.content,
    diff: createNeutralDiff({
      status: "changes",
      operations: [{ actionOrder: 1, kind: "notify_local", after: "Review the morning comfort window." }],
      unchangedCount: 0,
      redacted: true,
    }),
    conflicts: currentConflict.result,
    blockingReasons: [],
  });
  const dryRun = createNeutralDryRunAttestation({
    compile,
    status: "passed",
    diff: compile.diff,
    conflicts: compile.conflicts,
    summary: "The neutral dry-run found a review-only notification.",
  });
  return { artifactRef, evidence, authority, risk, compile, dryRun };
}

function fixtureHistoryReplay(
  artifact: ReturnType<typeof fixtureArtifact>,
  results: ReturnType<typeof fixtureCompilerResults>,
  options: {
    readonly proposal?: { readonly id: string; readonly revision: number };
    readonly compile?: { readonly resultId: string; readonly inputIdentity: string };
    readonly dryRun?: { readonly resultId: string; readonly inputIdentity: string };
  } = {},
) {
  const reference = {
    bridgeId: "bridge-history-service-fixture",
    hwId: "hw-history-service-fixture",
    capabilityId: "hwc-history-service-fixture",
    observedAt: "2026-08-19T23:30:00.000Z",
    source: "imported-history" as const,
    origin: "imported" as const,
    importId: "import-history-service-fixture",
    historySeq: 1,
    sourceRange: {
      since: "2026-08-19T23:00:00.000Z",
      until: "2026-08-20T00:00:00.000Z",
    },
  };
  const input = createHistoryReplayInput({
    artifact: results.artifactRef,
    proposal: {
      id: options.proposal?.id ?? artifact.sourceProposal.proposalId,
      revision: options.proposal?.revision ?? artifact.sourceProposal.proposalRevision,
      proposalEvidenceIdentity: `sha256:${"e".repeat(64)}`,
    },
    compile: {
      resultId: options.compile?.resultId ?? results.compile.resultId,
      inputIdentity: options.compile?.inputIdentity ?? results.compile.inputIdentity,
    },
    dryRun: {
      resultId: options.dryRun?.resultId ?? results.dryRun.resultId,
      inputIdentity: options.dryRun?.inputIdentity ?? results.dryRun.inputIdentity,
    },
    refs: [reference],
    samples: [{
      bridgeId: reference.bridgeId,
      importId: reference.importId,
      historySeq: reference.historySeq,
      sourceTs: reference.observedAt,
      sourceTsQuality: "platform" as const,
      value: true,
    }],
    coverage: [{
      bridgeId: reference.bridgeId,
      status: "partial" as const,
      reasons: ["retention_floor_unknown" as const],
    }],
    truncated: false,
    evaluator: { id: "neutral-history-replay", version: "1.0.0" },
  });
  return createHistoryReplayResult(input, {
    status: "passed",
    matchedSampleCount: 1,
    triggerCount: 0,
    actionCount: 0,
    reasons: [],
  });
}

test("mounts a restart-safe read-only artifact boundary with no action surface", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-artifacts-"));
  const path = join(directory, "artifacts.sqlite");
  try {
    let auditSequence = 0;
    const seed = new ArtifactRegistry({
      path,
      now: () => "2026-08-20T01:00:00.000Z",
      id: () => `artifact-audit-fixture-${++auditSequence}`,
    });
    const artifact = fixtureArtifact();
    seed.createDraft({ artifact, idempotencyKey: "seed-artifact", actor: "hub-test" });
    const artifactRef = {
      artifactId: artifact.artifactId,
      revision: artifact.revision,
      contentHash: artifact.contentHash,
    };
    const watermark = {
      bridgeId: "bridge-service-fixture",
      epochId: "epoch-service-fixture",
      lastSeq: 1,
      lastSyncCompleteAt: "2026-08-20T00:59:00.000Z",
      freshness: "fresh" as const,
      gapCount: 0,
    };
    const evidence = createArtifactEvidenceAttestation({
      artifact: artifactRef,
      attestationId: "evidence-service-fixture",
      capturedAt: "2026-08-20T01:00:00.000Z",
      source: "home-world-consistent-cut",
      sourceProposal: artifact.sourceProposal,
      proposalEvidenceIdentity: `sha256:${"b".repeat(64)}`,
      selectedHwCapabilityIds: [],
      watermarks: [watermark],
      coverage: "complete",
      reasons: [],
    });
    const authority = createArtifactAuthorityAssessment({
      artifact: artifactRef,
      assessmentId: "authority-service-fixture",
      assessedAt: "2026-08-20T01:00:00.000Z",
      authorityRegistryIdentity: `sha256:${"d".repeat(64)}`,
      candidates: [],
      checkedWatermarks: [watermark],
    }, { hwCapabilityIds: ["hwc-service-fixture"] });
    seed.recordEvidenceAttestation({
      assessment: evidence,
      idempotencyKey: "seed-artifact-evidence",
      actor: "hub-evidence",
    });
    seed.recordAuthorityAssessment({
      assessment: authority,
      idempotencyKey: "seed-artifact-authority",
      actor: "hub-authority",
    });
    const risk = createArtifactRiskAssessment({
      artifact: artifactRef,
      assessmentId: "risk-service-fixture",
      assessedAt: "2026-08-20T01:00:00.000Z",
      evidence: {
        attestationId: evidence.attestationId,
        inputIdentity: evidence.inputIdentity,
      },
      authority: {
        assessmentId: authority.assessmentId,
        inputIdentity: authority.inputIdentity,
      },
      conflictInputIdentity: `sha256:${"c".repeat(64)}`,
      class: "observe_or_notify",
      reasons: ["Local notification only; no remote state changes."],
      policyId: "home-artifact-phase-one",
      policyVersion: "1.0.0",
    });
    seed.recordRiskAssessment({
      assessment: risk,
      idempotencyKey: "seed-artifact-risk",
      actor: "hub-policy",
    });
    seed.close();

    const context = new Context();
    await context.plugin(HomeArtifactService, { path });
    const service = context.homeArtifacts;

    assert.equal(service.capabilities().schemaVersion, "1");
    assert.equal(service.capabilities().canCompile, false);
    assert.equal(service.capabilities().canSimulate, false);
    assert.equal(service.capabilities().canExecute, false);
    assert.deepEqual(service.diagnostics(), {
      status: "ready",
      schemaVersion: "1",
      lifecycleStates: ["draft", "superseded"],
      hasRecords: true,
      canCompile: false,
      canSimulate: false,
      canExecute: false,
    });
    assert.equal(JSON.stringify(service.diagnostics()).includes(artifact.title), false);
    assert.equal(service.getRevision(artifact.artifactId, 1)?.artifact.contentHash, artifact.contentHash);
    assert.equal(service.list({ limit: 1 }).length, 1);
    assert.equal(service.audit({ limit: 1 })[0]?.actor, "hub-test");
    assert.equal(service.listAttestations({
      kind: "risk-assessment",
      artifact: risk.artifact,
      limit: 1,
    })[0]?.recordId, risk.assessmentId);
    assert.equal(service.latestAttestation({
      kind: "risk-assessment",
      artifact: risk.artifact,
    })?.inputIdentity, risk.inputIdentity);
    for (const forbidden of [
      "createDraft",
      "appendRevision",
      "markSuperseded",
      "recordEvidenceAttestation",
      "recordRiskAssessment",
      "recordAuthorityAssessment",
      "compile",
      "apply",
      "execute",
    ]) {
      assert.equal(forbidden in service, false, forbidden);
    }

    await context.fiber.dispose();
    assert.throws(() => service.list({ limit: 1 }), /closed/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("projects only the exact current draft and binds the dry-run to the latest compile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-artifact-review-"));
  const path = join(directory, "artifacts.sqlite");
  try {
    const seed = new ArtifactRegistry({
      path,
      now: () => "2026-08-20T01:00:00.000Z",
      id: (() => {
        let sequence = 0;
        return () => `artifact-review-audit-${++sequence}`;
      })(),
    });
    const artifact = fixtureArtifact();
    const results = fixtureCompilerResults(artifact);
    seed.createDraft({ artifact, idempotencyKey: "review-artifact" });
    seed.recordEvidenceAttestation({
      assessment: results.evidence,
      idempotencyKey: "review-evidence",
    });
    seed.recordAuthorityAssessment({
      assessment: results.authority,
      idempotencyKey: "review-authority",
    });
    seed.recordRiskAssessment({
      assessment: results.risk,
      idempotencyKey: "review-risk",
    });
    seed.recordCompile({ result: results.compile, idempotencyKey: "review-compile" });
    seed.recordDryRun({ result: results.dryRun, idempotencyKey: "review-dry-run" });
    const historyReplay = fixtureHistoryReplay(artifact, results);
    seed.recordHistoryReplayAttestation({
      assessment: historyReplay,
      idempotencyKey: "review-history-replay",
    });
    seed.close();

    const context = new Context();
    await context.plugin(HomeArtifactService, { path });
    const snapshot = context.homeArtifacts.reviewForProposal(
      artifact.sourceProposal.proposalId,
      artifact.sourceProposal.proposalRevision,
    );

    assert.deepEqual(snapshot, {
      artifact: results.artifactRef,
      proposal: {
        id: artifact.sourceProposal.proposalId,
        revision: artifact.sourceProposal.proposalRevision,
      },
      evidence: {
        watermarks: results.compile.usedWatermarks,
      },
      compile: {
        status: results.compile.status,
        resultId: results.compile.resultId,
        inputIdentity: results.compile.inputIdentity,
        compiler: results.compile.compiler,
        usedWatermarks: results.compile.usedWatermarks,
        diff: results.compile.diff,
        conflicts: results.compile.conflicts,
        blockingReasons: results.compile.blockingReasons,
        actionAuthorityBindings: results.compile.actionAuthorityBindings,
      },
      dryRun: {
        status: results.dryRun.status,
        resultId: results.dryRun.resultId,
        inputIdentity: results.dryRun.inputIdentity,
        compileAttestationId: results.dryRun.compileAttestationId,
        compileInputIdentity: results.dryRun.compileInputIdentity,
        compiler: results.dryRun.compiler,
        checkedWatermarks: results.dryRun.checkedWatermarks,
        diff: results.dryRun.diff,
        conflicts: results.dryRun.conflicts,
        actionAuthorityBindings: results.dryRun.actionAuthorityBindings,
        writesPerformed: false,
        summary: results.dryRun.summary,
      },
      historyReplay: {
        status: historyReplay.status,
        coverage: historyReplay.coverage,
        truncated: historyReplay.truncated,
        counts: historyReplay.counts,
        reasons: historyReplay.reasons,
        writesPerformed: false,
        evaluator: historyReplay.evaluator,
        resultId: historyReplay.resultId,
        inputIdentity: historyReplay.inputIdentity,
      },
      writesPerformed: false,
    });
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot?.compile), true);
    assert.equal(Object.isFrozen(snapshot?.dryRun), true);
    assert.equal(JSON.stringify(snapshot).includes('"content"'), false);
    assert.equal(JSON.stringify(snapshot).includes('"plan"'), false);
    assert.equal(JSON.stringify(snapshot).includes("native"), false);
    assert.equal(JSON.stringify(snapshot).includes("provider"), false);
    assert.equal(JSON.stringify(snapshot).includes("secret"), false);
    assert.equal(snapshot?.writesPerformed, false);
    assert.equal(snapshot?.dryRun.writesPerformed, false);

    await context.fiber.dispose();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("omits history-replay projection when any durable binding is wrong", async () => {
  const cases = [
    {
      name: "proposal",
      replay: (artifact: ReturnType<typeof fixtureArtifact>, results: ReturnType<typeof fixtureCompilerResults>) =>
        fixtureHistoryReplay(artifact, results, { proposal: { id: "proposal-other", revision: 1 } }),
    },
    {
      name: "compile",
      replay: (artifact: ReturnType<typeof fixtureArtifact>, results: ReturnType<typeof fixtureCompilerResults>) =>
        fixtureHistoryReplay(artifact, results, {
          compile: { resultId: `sha256:${"1".repeat(64)}`, inputIdentity: `sha256:${"2".repeat(64)}` },
        }),
    },
    {
      name: "dry-run",
      replay: (artifact: ReturnType<typeof fixtureArtifact>, results: ReturnType<typeof fixtureCompilerResults>) =>
        fixtureHistoryReplay(artifact, results, {
          dryRun: { resultId: `sha256:${"3".repeat(64)}`, inputIdentity: `sha256:${"4".repeat(64)}` },
        }),
    },
  ] as const;

  for (const item of cases) {
    const directory = mkdtempSync(join(tmpdir(), `hob-home-artifact-replay-${item.name}-`));
    const path = join(directory, "artifacts.sqlite");
    const backing = new ArtifactRegistry({ path });
    const artifact = fixtureArtifact({ artifactId: `artifact-replay-${item.name}` });
    const results = fixtureCompilerResults(artifact);
    backing.createDraft({ artifact, idempotencyKey: `${item.name}-artifact` });
    backing.recordEvidenceAttestation({ assessment: results.evidence, idempotencyKey: `${item.name}-evidence` });
    backing.recordAuthorityAssessment({ assessment: results.authority, idempotencyKey: `${item.name}-authority` });
    backing.recordRiskAssessment({ assessment: results.risk, idempotencyKey: `${item.name}-risk` });
    backing.recordCompile({ result: results.compile, idempotencyKey: `${item.name}-compile` });
    backing.recordDryRun({ result: results.dryRun, idempotencyKey: `${item.name}-dry-run` });
    const validReplay = fixtureHistoryReplay(artifact, results);
    const mismatchedReplay = item.replay(artifact, results);
    backing.recordHistoryReplayAttestation({
      assessment: validReplay,
      idempotencyKey: `${item.name}-valid-history-replay`,
    });
    const validEntry = backing.latestAttestation({
      kind: "history-replay-attestation",
      artifact: results.artifactRef,
    });
    assert.ok(validEntry);
    const reader = {
      getRevision: (...args: Parameters<ArtifactRegistry["getRevision"]>) => backing.getRevision(...args),
      list: (...args: Parameters<ArtifactRegistry["list"]>) => backing.list(...args),
      audit: (...args: Parameters<ArtifactRegistry["audit"]>) => backing.audit(...args),
      listAttestations: (...args: Parameters<ArtifactRegistry["listAttestations"]>) => backing.listAttestations(...args),
      latestAttestation: (...args: Parameters<ArtifactRegistry["latestAttestation"]>) => {
        const result = backing.latestAttestation(...args);
        return args[0]?.kind === "history-replay-attestation" && result !== undefined
          ? { ...result, assessment: mismatchedReplay } as ArtifactAssessmentEntry
          : result;
      },
      currentBySourceProposal: (...args: Parameters<ArtifactRegistry["currentBySourceProposal"]>) => backing.currentBySourceProposal(...args),
      latestResult: (...args: Parameters<ArtifactRegistry["latestResult"]>) => backing.latestResult(...args),
    };
    const context = new Context();
    try {
      await context.plugin(HomeArtifactService, { registry: reader } as never);
      const snapshot = context.homeArtifacts.reviewForProposal(
        artifact.sourceProposal.proposalId,
        artifact.sourceProposal.proposalRevision,
      );
      assert.equal(snapshot?.historyReplay, undefined, item.name);
      await context.fiber.dispose();
    } finally {
      backing.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("returns a not-run dry-run state for an exact draft with no dry-run row and no snapshot for a missing source", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-artifact-review-empty-"));
  const path = join(directory, "artifacts.sqlite");
  try {
    const seed = new ArtifactRegistry({ path });
    const artifact = fixtureArtifact();
    const results = fixtureCompilerResults(artifact);
    seed.createDraft({ artifact, idempotencyKey: "empty-review-artifact" });
    seed.recordEvidenceAttestation({
      assessment: results.evidence,
      idempotencyKey: "empty-review-evidence",
    });
    seed.recordAuthorityAssessment({
      assessment: results.authority,
      idempotencyKey: "empty-review-authority",
    });
    seed.recordRiskAssessment({
      assessment: results.risk,
      idempotencyKey: "empty-review-risk",
    });
    seed.recordCompile({ result: results.compile, idempotencyKey: "empty-review-compile" });
    seed.close();

    const context = new Context();
    await context.plugin(HomeArtifactService, { path });
    const snapshot = context.homeArtifacts.reviewForProposal(
      artifact.sourceProposal.proposalId,
      artifact.sourceProposal.proposalRevision,
    );
    assert.deepEqual(snapshot, {
      artifact: results.artifactRef,
      proposal: {
        id: artifact.sourceProposal.proposalId,
        revision: artifact.sourceProposal.proposalRevision,
      },
      evidence: { watermarks: results.compile.usedWatermarks },
      compile: {
        status: results.compile.status,
        resultId: results.compile.resultId,
        inputIdentity: results.compile.inputIdentity,
        compiler: results.compile.compiler,
        usedWatermarks: results.compile.usedWatermarks,
        diff: results.compile.diff,
        conflicts: results.compile.conflicts,
        blockingReasons: results.compile.blockingReasons,
        actionAuthorityBindings: results.compile.actionAuthorityBindings,
      },
      dryRun: {
        status: "not_run",
        writesPerformed: false,
      },
      writesPerformed: false,
    });
    assert.equal(context.homeArtifacts.reviewForProposal("missing-proposal", 1), undefined);
    await context.fiber.dispose();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("projects an exact current draft as not-run before compilation and uses latest evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-artifact-review-not-run-"));
  const path = join(directory, "artifacts.sqlite");
  try {
    const seed = new ArtifactRegistry({ path });
    const artifact = fixtureArtifact();
    const results = fixtureCompilerResults(artifact);
    seed.createDraft({ artifact, idempotencyKey: "not-run-review-artifact" });
    seed.recordEvidenceAttestation({
      assessment: results.evidence,
      idempotencyKey: "not-run-review-evidence",
    });
    seed.close();

    const context = new Context();
    await context.plugin(HomeArtifactService, { path });
    const snapshot = context.homeArtifacts.reviewForProposal(
      artifact.sourceProposal.proposalId,
      artifact.sourceProposal.proposalRevision,
    );

    assert.deepEqual(snapshot, {
      artifact: results.artifactRef,
      proposal: {
        id: artifact.sourceProposal.proposalId,
        revision: artifact.sourceProposal.proposalRevision,
      },
      evidence: { watermarks: results.evidence.watermarks },
      compile: { status: "not_run" },
      dryRun: {
        status: "not_run",
        writesPerformed: false,
      },
      writesPerformed: false,
    });
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot?.compile), true);
    assert.equal(Object.isFrozen(snapshot?.dryRun), true);
    await context.fiber.dispose();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uses the exact Registry source lookup beyond 200 unrelated revisions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-artifact-review-bound-"));
  const path = join(directory, "artifacts.sqlite");
  try {
    const seed = new ArtifactRegistry({ path });
    for (let index = 0; index <= 200; index += 1) {
      seed.createDraft({
        artifact: fixtureArtifact({
          artifactId: `artifact-service-unrelated-${String(index).padStart(3, "0")}`,
          proposalId: `proposal-service-unrelated-${index}`,
        }),
        idempotencyKey: `bounded-review-artifact-${index}`,
      });
    }
    const target = fixtureArtifact({ artifactId: "artifact-target", proposalId: "target-proposal" });
    const results = fixtureCompilerResults(target);
    seed.createDraft({ artifact: target, idempotencyKey: "bounded-review-target" });
    seed.recordEvidenceAttestation({ assessment: results.evidence, idempotencyKey: "bounded-review-target-evidence" });
    seed.recordAuthorityAssessment({ assessment: results.authority, idempotencyKey: "bounded-review-target-authority" });
    seed.recordRiskAssessment({ assessment: results.risk, idempotencyKey: "bounded-review-target-risk" });
    seed.recordCompile({ result: results.compile, idempotencyKey: "bounded-review-target-compile" });
    seed.recordDryRun({ result: results.dryRun, idempotencyKey: "bounded-review-target-dry-run" });
    seed.close();

    const context = new Context();
    await context.plugin(HomeArtifactService, { path });
    const snapshot = context.homeArtifacts.reviewForProposal("target-proposal", 2);
    assert.equal(snapshot?.artifact.artifactId, target.artifactId);
    assert.deepEqual(snapshot?.proposal, { id: "target-proposal", revision: 2 });
    await context.fiber.dispose();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uses an injected registry reader without taking ownership or widening the review surface", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-artifact-borrowed-"));
  const path = join(directory, "artifacts.sqlite");
  const backing = new ArtifactRegistry({ path });
  const artifact = fixtureArtifact({ artifactId: "artifact-borrowed-reader" });
  backing.createDraft({ artifact, idempotencyKey: "borrowed-reader-artifact" });
  const calls = { list: 0, getRevision: 0 };
  const reader = {
    getRevision: (...args: Parameters<ArtifactRegistry["getRevision"]>) => {
      calls.getRevision += 1;
      return backing.getRevision(...args);
    },
    list: (...args: Parameters<ArtifactRegistry["list"]>) => {
      calls.list += 1;
      return backing.list(...args);
    },
    audit: (...args: Parameters<ArtifactRegistry["audit"]>) => backing.audit(...args),
    listAttestations: (...args: Parameters<ArtifactRegistry["listAttestations"]>) => backing.listAttestations(...args),
    latestAttestation: (...args: Parameters<ArtifactRegistry["latestAttestation"]>) => backing.latestAttestation(...args),
    currentBySourceProposal: (...args: Parameters<ArtifactRegistry["currentBySourceProposal"]>) => backing.currentBySourceProposal(...args),
    latestResult: (...args: Parameters<ArtifactRegistry["latestResult"]>) => backing.latestResult(...args),
  };
  const context = new Context();
  try {
    // The reader is deliberately narrow and has no close or mutation methods.
    // Supplying no path ensures the service cannot silently construct another owner.
    await context.plugin(HomeArtifactService, { registry: reader } as never);
    const service = context.homeArtifacts;

    assert.equal(service.diagnostics().hasRecords, true);
    assert.equal(service.list({ limit: 1 }).length, 1);
    assert.equal(service.getRevision(artifact.artifactId, artifact.revision)?.artifact.artifactId, artifact.artifactId);
    assert.ok(calls.list > 0);
    assert.ok(calls.getRevision > 0);
    assert.equal(service.capabilities().canCompile, false);
    assert.equal(service.capabilities().canSimulate, false);
    assert.equal(service.capabilities().canExecute, false);
    for (const forbidden of ["getRegistry", "compile", "producer"]) {
      assert.equal(forbidden in service, false, forbidden);
    }

    await context.fiber.dispose();
    assert.equal(backing.list({ limit: 1 }).length, 1);
  } finally {
    backing.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("closes the default owned registry when the service stops", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-artifact-owned-"));
  const path = join(directory, "artifacts.sqlite");
  const context = new Context();
  try {
    await context.plugin(HomeArtifactService, { path });
    const service = context.homeArtifacts;
    assert.equal(service.capabilities().canCompile, false);
    assert.equal(service.capabilities().canSimulate, false);
    assert.equal(service.capabilities().canExecute, false);
    await context.fiber.dispose();
    assert.throws(() => service.list({ limit: 1 }), /closed/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
