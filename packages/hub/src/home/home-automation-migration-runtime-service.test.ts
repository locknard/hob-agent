import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";
import type { ForeignRuleMigrationResult } from "@hob/bridge-contract";

import {
  HomeAutomationMigrationRuntimeService,
} from "./home-automation-migration-runtime-service.js";
import { homeAutomationMigrationProposalIdentity } from "./home-automation-migration-preparation.js";
import { digestToken } from "./home-automation-migration-selection.js";
import { SqliteHomeAutomationMigrationStore } from "./home-automation-migration-store.js";
import { computeHomeAutomationMigrationCandidateContentHash } from "./home-automation-migration-simulator.js";
import type { HomeAutomationMigrationSimulationEvidencePort } from "./home-automation-migration-simulation.js";
import type { HomePreparationStatus } from "./home-proposal-service.js";

const SOURCE = {
  bridgeId: "bridge-ha",
  epochId: "epoch-1",
  lastSeq: 12,
} as const;

const BINDING = {
  bridgeId: SOURCE.bridgeId,
  nativeId: "light.living-room",
  nativeInstanceId: "light.living-room:main",
} as const;

const translatedRule: ForeignRuleMigrationResult = {
  status: "translated",
  ruleRef: "rule-1",
  sourceFingerprint: `sha256:${"a".repeat(64)}`,
  title: "Living room light",
  plan: {
    trigger: { kind: "capability_changed", source: BINDING },
    conditions: [],
    actions: [{ kind: "set_boolean", target: BINDING, value: true }],
  },
};

const simulationEvidence: HomeAutomationMigrationSimulationEvidencePort = {
  read: async ({ sourceCut }) => ({
    sourceCut,
    eventSamples: [{
      eventId: "event-living-room-1",
      kind: "capability_changed" as const,
      occurredAt: "2026-08-24T08:00:00.000Z",
      capabilityId: "hwc-living-room",
      values: [{ capabilityId: "hwc-living-room", value: true }],
    }],
    existingRuleSummaries: [{
      ruleRef: "existing-living-room-rule",
      enabled: true,
      trigger: { kind: "capability_changed" as const, sourceCapabilityId: "hwc-living-room" },
      actions: [{ kind: "set_boolean" as const, targetCapabilityId: "hwc-living-room", value: false }],
    }],
  }),
};

class StubHomeWorld extends Service {
  readonly catalogs = [{
    ...SOURCE,
    status: "available" as const,
    rules: [{ ruleRef: "rule-1", name: "Living room light", enabled: true }],
  }];
  translation: unknown = translatedRule;
  translationByRuleRef: Record<string, unknown> = {};
  translateCalls = 0;
  translateInputs: unknown[] = [];
  writeCalls = 0;

  constructor(ctx: Context) {
    super(ctx, "homeWorld");
  }

  async foreignRuleCatalog() {
    return this.catalogs;
  }

  snapshot() {
    return {
      devices: [{
        hwId: "hw-device-living-room",
        validity: "valid" as const,
        capabilities: [{ hwCapabilityId: "hwc-living-room" }],
      }],
    };
  }

  async translateForeignRule(input: { readonly bridgeId: string; readonly epochId: string; readonly lastSeq: number; readonly ruleRef: string; readonly signal: AbortSignal }) {
    this.translateCalls += 1;
    this.translateInputs.push(input);
    assert.equal(input.bridgeId, SOURCE.bridgeId);
    assert.equal(input.epochId, SOURCE.epochId);
    assert.equal(input.lastSeq, SOURCE.lastSeq);
    assert.ok(input.ruleRef === "rule-1" || input.ruleRef === "rule-2");
    return this.translationByRuleRef[input.ruleRef] ?? this.translation;
  }

  resolveBridgeActionTargetForBinding(input: typeof BINDING) {
    return {
      hwCapabilityId: "hwc-living-room",
      binding: { ...input },
    };
  }
}

class StubHomeProposals extends Service {
  proposal: Record<string, unknown> | undefined;
  preparation: HomePreparationStatus | undefined;
  createCalls: unknown[] = [];
  getCalls: string[] = [];
  preparationCalls: Array<{ proposalId: string; proposalRevision: number }> = [];

  constructor(ctx: Context) {
    super(ctx, "homeProposals");
  }

  async createMigrationDraftGoverned(input: Record<string, unknown>) {
    this.createCalls.push(input);
    const candidate = input.artifactCandidate as { schemaVersion: "1"; content: unknown };
    this.proposal = {
      id: "proposal-living-room",
      revision: 1,
      kind: "automation-draft",
      status: "pending_review",
      lifecycle: "preparing",
      title: input.title,
      summary: input.summary,
      intent: input.intent,
      rationale: input.rationale,
      risk: input.risk,
      artifactCandidate: candidate,
    };
    return { kind: "created" as const, proposal: this.proposal };
  }

  get(proposalId: string) {
    this.getCalls.push(proposalId);
    return this.proposal;
  }

  preparationForProposal(proposalId: string, proposalRevision: number) {
    this.preparationCalls.push({ proposalId, proposalRevision });
    return this.preparation;
  }

  findMigrationProposalByIdentity(input: { readonly dedupKey: string; readonly idempotencyKey: string }) {
    return this.proposal?.dedupKey === input.dedupKey && this.proposal?.idempotencyKey === input.idempotencyKey
      ? this.proposal
      : undefined;
  }
}

async function setup(
  path: string,
  withProposals = false,
  withSimulationEvidence = true,
  evidencePort: HomeAutomationMigrationSimulationEvidencePort = simulationEvidence,
) {
  const context = new Context();
  const worldFiber = await context.plugin(StubHomeWorld);
  const migrationFiber = await context.plugin(HomeAutomationMigrationRuntimeService, {
    path,
    ...(withSimulationEvidence ? { simulationEvidence: evidencePort } : {}),
  });
  const proposalFiber = withProposals ? await context.plugin(StubHomeProposals) : undefined;
  return {
    context,
    world: context.homeWorld as unknown as StubHomeWorld,
    proposals: withProposals ? context.homeProposals as unknown as StubHomeProposals : undefined,
    worldFiber,
    migrationFiber,
    proposalFiber,
  };
}

test("assesses the exact HomeWorld catalog cut idempotently without retaining native data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-migration-runtime-service-"));
  const path = join(directory, "migrations.sqlite");
  const { context, world, worldFiber, migrationFiber } = await setup(path);
  try {
    const controller = new AbortController();
    const first = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId, { signal: controller.signal });
    const replay = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId, { signal: controller.signal });

    assert.equal(first.outcome, "created");
    assert.equal(replay.outcome, "existing");
    assert.deepEqual(replay.assessment, first.assessment);
    assert.equal(first.assessment.sourceEpochId, SOURCE.epochId);
    assert.equal(first.assessment.sourceLastSeq, SOURCE.lastSeq);
    assert.equal(JSON.stringify(first).includes("nativeId"), false);
    assert.equal(world.translateCalls, 1);
    assert.equal((world.translateInputs[0] as { signal: AbortSignal }).signal, controller.signal);
    assert.equal(existsSync(path), true);
  } finally {
    await migrationFiber.dispose();
    await worldFiber.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("creates a review-only Artifact candidate only after an exact eligible assessment", async () => {
  const { context, world, worldFiber, migrationFiber } = await setup(":memory:");
  try {
    const assessment = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    assert.equal(assessment.outcome, "created");
    const controller = new AbortController();

    const candidate = await context.homeAutomationMigrations.createArtifactCandidate({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    }, { signal: controller.signal });

    assert.equal(candidate.status, "candidate");
    if (candidate.status === "candidate") {
      assert.deepEqual(candidate.content.actions, [{
        kind: "set_boolean",
        target: { hwCapabilityId: "hwc-living-room" },
        value: true,
      }]);
      assert.equal(JSON.stringify(candidate).includes("nativeId"), false);
      assert.equal(JSON.stringify(candidate).includes("bridgeId"), false);
    }
    assert.equal((world.translateInputs[1] as { signal: AbortSignal }).signal, controller.signal);
    assert.equal(world.writeCalls, 0);
  } finally {
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("returns fixed needs-attention results for stale translation and non-assessed migration", async () => {
  const { context, world, worldFiber, migrationFiber } = await setup(":memory:");
  try {
    const assessment = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    assert.equal(assessment.outcome, "created");
    world.translation = { status: "stale_source" };
    assert.deepEqual(await context.homeAutomationMigrations.createArtifactCandidate({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    }), { status: "needs_attention", reason: "stale_source" });
    assert.deepEqual(await context.homeAutomationMigrations.createArtifactCandidate({
      migrationId: "f".repeat(32),
      ruleRef: "rule-1",
    }), { status: "needs_attention", reason: "assessment_not_eligible" });
  } finally {
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("rejects a translated candidate when the persisted source fingerprint changed", async () => {
  const { context, world, worldFiber, migrationFiber } = await setup(":memory:");
  try {
    const assessment = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    assert.equal(assessment.outcome, "created");
    world.translation = {
      ...translatedRule,
      sourceFingerprint: `sha256:${"b".repeat(64)}`,
    };
    assert.deepEqual(await context.homeAutomationMigrations.createArtifactCandidate({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    }), { status: "needs_attention", reason: "stale_source" });
  } finally {
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("fails closed when the requested bridge catalog is unavailable or duplicated", async () => {
  const { context, world, worldFiber, migrationFiber } = await setup(":memory:");
  try {
    world.catalogs.splice(0, 1, {
      bridgeId: SOURCE.bridgeId,
      status: "unavailable",
      rules: [],
    } as never);
    assert.deepEqual(await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId), {
      outcome: "needs_attention",
      reason: "catalog_unavailable",
    });

    world.catalogs.splice(0, 1, {
      ...SOURCE,
      status: "available",
      rules: [{ ruleRef: "rule-1" }],
    }, {
      ...SOURCE,
      status: "available",
      rules: [{ ruleRef: "rule-1" }],
    });
    assert.deepEqual(await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId), {
      outcome: "needs_attention",
      reason: "catalog_unavailable",
    });
  } finally {
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("keeps malformed, extra-field, and throwing Proxy inputs closed", async () => {
  const { context, worldFiber, migrationFiber } = await setup(":memory:");
  try {
    assert.deepEqual(await (context.homeAutomationMigrations.assessBridgeCatalog as unknown as (input: unknown) => Promise<unknown>)({ bridgeId: SOURCE.bridgeId }), {
      outcome: "needs_attention",
      reason: "invalid_input",
    });
    assert.deepEqual(await context.homeAutomationMigrations.createArtifactCandidate({
      migrationId: "f".repeat(32),
      ruleRef: "rule-1",
      nativeBody: { secret: "must not escape" },
    } as never), { status: "needs_attention", reason: "invalid_input" });
    assert.equal(await context.homeAutomationMigrations.retry({ migrationId: "f".repeat(32), extra: "x" } as never), undefined);
    assert.equal(context.homeAutomationMigrations.closeAssessment({ migrationId: "f".repeat(32), reason: "household_closed", extra: "x" } as never), undefined);

    const throwing = new Proxy({ bridgeId: SOURCE.bridgeId }, {
      get() { throw new Error("provider secret"); },
    });
    assert.deepEqual(await (context.homeAutomationMigrations.assessBridgeCatalog as unknown as (input: unknown) => Promise<unknown>)(throwing), {
      outcome: "needs_attention",
      reason: "invalid_input",
    });
    assert.equal(String(JSON.stringify(await context.homeAutomationMigrations.retry(throwing as never))).includes("provider secret"), false);
  } finally {
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("maps unsupported and unavailable translations to fixed candidate reasons", async (t) => {
  for (const [name, translation, reason] of [
    ["unsupported", { status: "unsupported", reason: "unsupported_action" }, "unsupported"],
    ["unavailable", { status: "unavailable", reason: "upstream_unavailable" }, "translation_unavailable"],
  ] as const) {
    await t.test(name, async () => {
      const { context, world, worldFiber, migrationFiber } = await setup(":memory:");
      try {
        const assessment = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
        assert.equal(assessment.outcome, "created");
        world.translation = translation;
        assert.deepEqual(await context.homeAutomationMigrations.createArtifactCandidate({
          migrationId: assessment.assessment.migrationId,
          ruleRef: "rule-1",
        }), { status: "needs_attention", reason });
      } finally {
        await migrationFiber.dispose();
        await worldFiber.dispose();
      }
    });
  }
});

test("delegates retry/list/close and closes a durable store that can reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-migration-runtime-reopen-"));
  const path = join(directory, "migrations.sqlite");
  const { context, world, worldFiber, migrationFiber } = await setup(path);
  try {
    world.translation = undefined;
    const failed = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    assert.equal(failed.outcome, "created");
    assert.equal(failed.assessment.status, "needs_attention");
    assert.equal(context.homeAutomationMigrations.list().length, 1);
    world.translation = translatedRule;
    const retried = await context.homeAutomationMigrations.retry({ migrationId: failed.assessment.migrationId });
    assert.equal(retried?.status, "assessed");
    const closed = context.homeAutomationMigrations.closeAssessment({
      migrationId: failed.assessment.migrationId,
      reason: "household_closed",
    });
    assert.equal(closed?.status, "closed");
  } finally {
    await migrationFiber.dispose();
    const reopened = new SqliteHomeAutomationMigrationStore({ path });
    try {
      assert.equal(reopened.list().length, 1);
      assert.equal(reopened.list()[0]?.status, "closed");
    } finally {
      reopened.close();
    }
    await worldFiber.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart recovery links an exact committed migration Proposal while workflow is still assessed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-migration-selection-recovery-"));
  const path = join(directory, "migrations.sqlite");
  const { context, worldFiber, migrationFiber, proposalFiber, proposals } = await setup(path, true);
  try {
    const assessed = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    assert.equal(assessed.outcome, "created");
    const assessment = context.homeAutomationMigrations.get(assessed.assessment.migrationId)!;
    const rule = assessment.rules[0]!;
    const candidate = await context.homeAutomationMigrations.createArtifactCandidate({
      migrationId: assessment.migrationId,
      ruleRef: rule.ruleRef,
    });
    assert.equal(candidate.status, "candidate");
    if (candidate.status !== "candidate") throw new Error("expected migration candidate");
    const identity = homeAutomationMigrationProposalIdentity({
      migrationId: assessment.migrationId,
      ruleRef: rule.ruleRef,
      sourceBridgeId: assessment.sourceBridgeId,
      sourceEpochId: assessment.sourceEpochId,
      sourceLastSeq: assessment.sourceLastSeq,
      sourceFingerprint: rule.sourceFingerprint!,
    });
    proposals!.proposal = {
      id: "proposal-recovered",
      revision: 1,
      kind: "automation-draft",
      status: "pending_review",
      lifecycle: "preparing",
      reviewLane: "migration",
      provenance: { producer: "home-automation-migration" },
      dedupKey: identity.dedupKey,
      idempotencyKey: identity.idempotencyKey,
      title: candidate.title,
      summary: "Recovered migration candidate",
      artifactCandidate: { schemaVersion: "1", content: candidate.content },
    };
    const external = new SqliteHomeAutomationMigrationStore({ path });
    const issue = external.issueSelection({
      selectionId: "d".repeat(32),
      migrationId: assessment.migrationId,
      ruleRef: rule.ruleRef,
      principal: { principalId: "member-recovery", role: "adult_member", privateDeviceBinding: "verified" },
      sourceBridgeId: assessment.sourceBridgeId,
      sourceEpochId: assessment.sourceEpochId,
      sourceLastSeq: assessment.sourceLastSeq,
      sourceFingerprint: rule.sourceFingerprint!,
      tokenDigest: digestToken("e".repeat(32)),
      generation: "old-generation",
      issuedAt: "2026-08-24T08:00:00.000Z",
      expiresAt: "2026-08-24T08:05:00.000Z",
    });
    assert.equal(external.claimSelection({
      selectionId: issue.selection.selectionId,
      tokenDigest: issue.selection.tokenDigest,
      principal: issue.selection.principal,
      generation: issue.selection.generation,
      now: "2026-08-24T08:00:00.000Z",
    }).outcome, "claimed");
    external.close();

    const recovered = await context.homeAutomationMigrations.recoverMigrationSelections();
    assert.deepEqual(recovered, [{ name: "Living room light", status: "prepared", proposalId: "proposal-recovered" }]);
    assert.equal(proposals!.createCalls.length, 0);
    const recoveredWorkflow = context.homeAutomationMigrations.get(assessment.migrationId)?.rules[0]?.workflow;
    assert.equal(recoveredWorkflow?.status, "translated");
    assert.equal(recoveredWorkflow?.proposalId, "proposal-recovered");
    assert.equal(recoveredWorkflow?.candidateProposalRevision, 1);
    assert.equal(recoveredWorkflow?.candidateContentHash, computeHomeAutomationMigrationCandidateContentHash(candidate.content));
    assert.equal(context.homeAutomationMigrations.findWorkflowForProposal("proposal-recovered").status, "governed");
  } finally {
    await proposalFiber?.dispose();
    await migrationFiber.dispose();
    await worldFiber.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

function preparedContentHash(proposal: Record<string, unknown>): string {
  const snapshot = {
    title: proposal.title,
    summary: proposal.summary,
    intent: proposal.intent,
    rationale: proposal.rationale ?? null,
    artifactCandidate: proposal.artifactCandidate ?? null,
    risk: proposal.risk,
    actionPolicyClasses: proposal.actionPolicyClasses ?? null,
    confirmationDeviceNames: proposal.confirmationDeviceNames ?? null,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex")}`;
}

test("prepares one assessed rule through the lazy migration proposal port and replays without a second draft", async () => {
  const { context, proposals, worldFiber, migrationFiber, proposalFiber } = await setup(":memory:", true);
  try {
    assert.notEqual(proposals, undefined);
    const assessment = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    assert.equal(assessment.outcome, "created");
    const controller = new AbortController();

    const prepared = await context.homeAutomationMigrations.prepareRuleReview({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    }, { signal: controller.signal });

    assert.equal(prepared.status, "translated");
    if (prepared.status === "translated") {
      assert.equal(prepared.proposalId, "proposal-living-room");
      assert.equal(prepared.candidateProposalRevision, 1);
      assert.match(prepared.candidateContentHash, /^sha256:[a-f0-9]{64}$/u);
      assert.equal(prepared.writesPerformed, false);
      assert.equal(JSON.stringify(prepared).includes("nativeId"), false);
    }
    assert.equal(proposals?.createCalls.length, 1);
    const workflow = context.homeAutomationMigrations.get(assessment.assessment.migrationId)?.rules[0]?.workflow;
    assert.equal(workflow?.status, "translated");
    assert.equal(workflow?.proposalId, "proposal-living-room");
    assert.equal(workflow?.candidateProposalRevision, 1);

    const replay = await context.homeAutomationMigrations.prepareRuleReview({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    }, { signal: controller.signal });
    assert.deepEqual(replay, prepared);
    assert.equal(proposals?.createCalls.length, 1);
  } finally {
    await proposalFiber?.dispose();
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("refreshes a ready proposal with the candidate revision, then CASes simulated before ready", async () => {
  const { context, proposals, worldFiber, migrationFiber, proposalFiber } = await setup(":memory:", true);
  try {
    assert.notEqual(proposals, undefined);
    const assessment = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    assert.equal(assessment.outcome, "created");
    const prepared = await context.homeAutomationMigrations.prepareRuleReview({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    });
    assert.equal(prepared.status, "translated");
    const current = proposals!.proposal!;
    proposals!.proposal = {
      ...current,
      revision: 2,
      lifecycle: "ready",
      preparedContentHash: preparedContentHash(current),
      preparedArtifact: {
        artifactId: "artifact-living-room",
        revision: 1,
        contentHash: `sha256:${"b".repeat(64)}`,
        compileResultId: `sha256:${"c".repeat(64)}`,
        dryRunResultId: `sha256:${"d".repeat(64)}`,
      },
    };
    proposals!.preparation = {
      proposalId: "proposal-living-room",
      proposalRevision: 1,
      status: "succeeded",
      attempt: 1,
      version: 2,
      createdAt: "2026-08-24T00:00:02.000Z",
      updatedAt: "2026-08-24T00:00:03.000Z",
    };

    const refreshed = await context.homeAutomationMigrations.refreshRuleWorkflow({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    });
    assert.equal(refreshed.status, "ready");
    if (refreshed.status === "ready") {
      assert.equal(refreshed.candidateProposalRevision, 1);
      assert.equal(refreshed.reviewProposalRevision, 2);
      assert.deepEqual(refreshed.preparedArtifact, proposals!.proposal!.preparedArtifact);
      assert.equal(refreshed.writesPerformed, false);
    }
    assert.deepEqual(proposals!.preparationCalls, [{
      proposalId: "proposal-living-room",
      proposalRevision: 1,
    }]);
    const workflow = context.homeAutomationMigrations.get(assessment.assessment.migrationId)?.rules[0]?.workflow;
    assert.equal(workflow?.status, "ready");
    assert.equal(workflow?.candidateProposalRevision, 1);
    assert.equal(workflow?.reviewProposalRevision, 2);
    assert.equal(workflow?.artifactId, "artifact-living-room");
    assert.equal(workflow?.compileResultId, `sha256:${"c".repeat(64)}`);
    assert.equal(workflow?.dryRunResultId, `sha256:${"d".repeat(64)}`);
    assert.equal(JSON.stringify(workflow).includes("nativeId"), false);
  } finally {
    await proposalFiber?.dispose();
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("refreshes one unique translated proposal through its exact identity", async () => {
  const { context, worldFiber, migrationFiber, proposalFiber } = await setup(":memory:", true);
  try {
    const assessment = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    assert.equal(assessment.outcome, "created");
    const prepared = await context.homeAutomationMigrations.prepareRuleReview({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    });
    assert.equal(prepared.status, "translated");

    const translated = await context.homeAutomationMigrations.refreshPreparedWorkflowForProposal("proposal-living-room");
    assert.deepEqual(translated, { status: "pending", writesPerformed: false });
    assert.doesNotMatch(JSON.stringify(translated), /proposal-living-room|rule-1|migration|source|artifact|native/u);
  } finally {
    await proposalFiber?.dispose();
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("returns one neutral success when an exact proposal refresh is already ready", async () => {
  const { context, proposals, worldFiber, migrationFiber, proposalFiber } = await setup(":memory:", true);
  try {
    const assessment = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    assert.equal(assessment.outcome, "created");
    const prepared = await context.homeAutomationMigrations.prepareRuleReview({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    });
    assert.equal(prepared.status, "translated");
    const current = proposals!.proposal!;
    proposals!.proposal = {
      ...current,
      revision: 2,
      lifecycle: "ready",
      preparedContentHash: preparedContentHash(current),
      preparedArtifact: {
        artifactId: "artifact-living-room",
        revision: 1,
        contentHash: `sha256:${"b".repeat(64)}`,
        compileResultId: `sha256:${"c".repeat(64)}`,
        dryRunResultId: `sha256:${"d".repeat(64)}`,
      },
    };
    proposals!.preparation = {
      proposalId: "proposal-living-room",
      proposalRevision: 1,
      status: "succeeded",
      attempt: 1,
      version: 2,
      createdAt: "2026-08-24T00:00:02.000Z",
      updatedAt: "2026-08-24T00:00:03.000Z",
    };

    const first = await context.homeAutomationMigrations.refreshPreparedWorkflowForProposal("proposal-living-room");
    const replay = await context.homeAutomationMigrations.refreshPreparedWorkflowForProposal("proposal-living-room");
    assert.deepEqual(first, { status: "ready", writesPerformed: false });
    assert.deepEqual(replay, first);
    assert.doesNotMatch(JSON.stringify(replay), /proposal-living-room|rule-1|migration|source|artifact|native/u);
  } finally {
    await proposalFiber?.dispose();
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("fails closed for a non-migration or malformed proposal identity", async () => {
  const { context, worldFiber, migrationFiber, proposalFiber } = await setup(":memory:", true);
  try {
    const closed = { status: "not_applicable", writesPerformed: false } as const;
    assert.deepEqual(
      await context.homeAutomationMigrations.refreshPreparedWorkflowForProposal("ordinary-proposal"),
      closed,
    );
    assert.deepEqual(
      await (context.homeAutomationMigrations.refreshPreparedWorkflowForProposal as unknown as (value: unknown) => Promise<unknown>)(" "),
      closed,
    );
    assert.deepEqual(
      await (context.homeAutomationMigrations.refreshPreparedWorkflowForProposal as unknown as (value: unknown) => Promise<unknown>)(undefined),
      closed,
    );
    assert.equal(JSON.stringify(closed).includes("native"), false);
  } finally {
    await proposalFiber?.dispose();
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("fails closed when one proposal identity matches multiple migration workflows", async () => {
  const { context, proposals, world, worldFiber, migrationFiber, proposalFiber } = await setup(":memory:", true);
  try {
    world.catalogs[0]!.rules.push({ ruleRef: "rule-2", name: "Another living room light", enabled: true });
    world.translationByRuleRef["rule-2"] = { ...translatedRule, ruleRef: "rule-2" };
    const assessment = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    assert.equal(assessment.outcome, "created");
    const first = await context.homeAutomationMigrations.prepareRuleReview({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    });
    const second = await context.homeAutomationMigrations.prepareRuleReview({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-2",
    });
    assert.equal(first.status, "translated");
    assert.equal(second.status, "translated");

    assert.deepEqual(
      await context.homeAutomationMigrations.refreshPreparedWorkflowForProposal("proposal-living-room"),
      { status: "not_applicable", writesPerformed: false },
    );
    assert.equal(proposals!.preparationCalls.length, 0);
  } finally {
    await proposalFiber?.dispose();
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("does not simulate or enter ready when the server-owned evidence port is absent", async () => {
  const { context, proposals, worldFiber, migrationFiber, proposalFiber } = await setup(":memory:", true, false);
  try {
    const assessment = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    assert.equal(assessment.outcome, "created");
    const prepared = await context.homeAutomationMigrations.prepareRuleReview({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    });
    assert.equal(prepared.status, "translated");
    proposals!.proposal = {
      ...proposals!.proposal!,
      revision: 2,
      lifecycle: "ready",
      preparedContentHash: preparedContentHash(proposals!.proposal!),
      preparedArtifact: {
        artifactId: "artifact-living-room",
        revision: 1,
        contentHash: `sha256:${"b".repeat(64)}`,
        compileResultId: `sha256:${"c".repeat(64)}`,
        dryRunResultId: `sha256:${"d".repeat(64)}`,
      },
    };
    proposals!.preparation = {
      proposalId: "proposal-living-room",
      proposalRevision: 1,
      status: "succeeded",
      attempt: 1,
      version: 2,
      createdAt: "2026-08-24T00:00:02.000Z",
      updatedAt: "2026-08-24T00:00:03.000Z",
    };

    assert.deepEqual(await context.homeAutomationMigrations.refreshRuleWorkflow({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    }), { status: "needs_attention", reason: "simulation_unavailable", writesPerformed: false });
    const workflow = context.homeAutomationMigrations.get(assessment.assessment.migrationId)?.rules[0]?.workflow;
    assert.equal(workflow?.status, "needs_attention");
    assert.equal(workflow?.failureReason, "compile_unavailable");
  } finally {
    await proposalFiber?.dispose();
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("rejects evidence attested to a different source cut before simulation", async () => {
  const wrongCutEvidence: HomeAutomationMigrationSimulationEvidencePort = {
    read: async ({ sourceCut }) => ({
      sourceCut: { ...sourceCut, lastSeq: sourceCut.lastSeq + 1 },
      eventSamples: [{
        eventId: "event-wrong-cut",
        kind: "capability_changed",
        occurredAt: "2026-08-24T08:00:00.000Z",
        capabilityId: "hwc-living-room",
        values: [{ capabilityId: "hwc-living-room", value: true }],
      }],
      existingRuleSummaries: [],
    }),
  };
  const { context, proposals, worldFiber, migrationFiber, proposalFiber } = await setup(":memory:", true, true, wrongCutEvidence);
  try {
    const assessment = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    const prepared = await context.homeAutomationMigrations.prepareRuleReview({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    });
    assert.equal(prepared.status, "translated");
    proposals!.proposal = {
      ...proposals!.proposal!,
      revision: 2,
      lifecycle: "ready",
      preparedContentHash: preparedContentHash(proposals!.proposal!),
      preparedArtifact: {
        artifactId: "artifact-living-room",
        revision: 1,
        contentHash: `sha256:${"b".repeat(64)}`,
        compileResultId: `sha256:${"c".repeat(64)}`,
        dryRunResultId: `sha256:${"d".repeat(64)}`,
      },
    };
    proposals!.preparation = {
      proposalId: "proposal-living-room",
      proposalRevision: 1,
      status: "succeeded",
      attempt: 1,
      version: 2,
      createdAt: "2026-08-24T00:00:02.000Z",
      updatedAt: "2026-08-24T00:00:03.000Z",
    };

    assert.deepEqual(await context.homeAutomationMigrations.refreshRuleWorkflow({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    }), { status: "needs_attention", reason: "simulation_unavailable", writesPerformed: false });
    assert.equal(context.homeAutomationMigrations.get(assessment.assessment.migrationId)?.rules[0]?.workflow?.status, "needs_attention");
  } finally {
    await proposalFiber?.dispose();
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("exposes governed workflow state and never re-enters preparation after switching", async () => {
  const { context, proposals, worldFiber, migrationFiber, proposalFiber } = await setup(":memory:", true);
  try {
    const assessment = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    const prepared = await context.homeAutomationMigrations.prepareRuleReview({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    });
    assert.equal(prepared.status, "translated");
    proposals!.proposal = {
      ...proposals!.proposal!,
      revision: 2,
      lifecycle: "ready",
      preparedContentHash: preparedContentHash(proposals!.proposal!),
      preparedArtifact: {
        artifactId: "artifact-living-room",
        revision: 1,
        contentHash: `sha256:${"b".repeat(64)}`,
        compileResultId: `sha256:${"c".repeat(64)}`,
        dryRunResultId: `sha256:${"d".repeat(64)}`,
      },
    };
    proposals!.preparation = {
      proposalId: "proposal-living-room",
      proposalRevision: 1,
      status: "succeeded",
      attempt: 1,
      version: 2,
      createdAt: "2026-08-24T00:00:02.000Z",
      updatedAt: "2026-08-24T00:00:03.000Z",
    };
    const ready = await context.homeAutomationMigrations.refreshRuleWorkflow({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    });
    assert.equal(ready.status, "ready");

    assert.deepEqual(context.homeAutomationMigrations.findWorkflowForProposal("proposal-living-room"), {
      status: "ready",
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
      sourceBridgeId: SOURCE.bridgeId,
      sourceFingerprint: translatedRule.sourceFingerprint,
      reviewProposalRevision: 2,
    });
    assert.equal(context.homeAutomationMigrations.startRuleSwitch({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
      approvedProposalRevision: 3,
      switchOperationId: "0123456789abcdef0123456789abcdef",
      switchActor: "household-owner",
    }), true);
    assert.equal(context.homeAutomationMigrations.findWorkflowForProposal("proposal-living-room").status, "governed");
    assert.deepEqual(await context.homeAutomationMigrations.refreshPreparedWorkflowForProposal("proposal-living-room"), {
      status: "needs_attention",
      writesPerformed: false,
    });
    assert.deepEqual(await context.homeAutomationMigrations.prepareRuleReview({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    }), { status: "needs_attention", reason: "workflow_not_recoverable", writesPerformed: false });
    assert.deepEqual(await context.homeAutomationMigrations.refreshRuleWorkflow({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    }), { status: "needs_attention", reason: "workflow_not_recoverable", writesPerformed: false });

    assert.equal(context.homeAutomationMigrations.verifyRuleSwitch({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
      deploymentId: "hob_proposal_living_room",
      deploymentTarget: SOURCE.bridgeId,
      deploymentConfigFingerprint: `sha256:${"e".repeat(64)}`,
    }), true);
    assert.equal(context.homeAutomationMigrations.startRuleRollback({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
      rollbackOperationId: "fedcba9876543210fedcba9876543210",
      rollbackActor: "household-owner",
    }), true);
    assert.deepEqual(await context.homeAutomationMigrations.prepareRuleReview({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    }), { status: "needs_attention", reason: "workflow_not_recoverable", writesPerformed: false });
    assert.equal(context.homeAutomationMigrations.restoreRule({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    }), true);
    assert.equal(context.homeAutomationMigrations.findWorkflowForProposal("proposal-living-room").status, "governed");
    assert.equal(JSON.stringify(context.homeAutomationMigrations.findWorkflowForProposal("proposal-living-room")).includes("nativeId"), false);
  } finally {
    await proposalFiber?.dispose();
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("projects failure reasons and neutral switch recovery refs, then resumes with a fresh CAS receipt", async () => {
  const { context, proposals, worldFiber, migrationFiber, proposalFiber } = await setup(":memory:", true);
  try {
    const assessment = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    const prepared = await context.homeAutomationMigrations.prepareRuleReview({ migrationId: assessment.assessment.migrationId, ruleRef: "rule-1" });
    assert.equal(prepared.status, "translated");
    proposals!.proposal = {
      ...proposals!.proposal!,
      revision: 2,
      lifecycle: "ready",
      preparedContentHash: preparedContentHash(proposals!.proposal!),
      preparedArtifact: {
        artifactId: "artifact-living-room",
        revision: 1,
        contentHash: `sha256:${"b".repeat(64)}`,
        compileResultId: `sha256:${"c".repeat(64)}`,
        dryRunResultId: `sha256:${"d".repeat(64)}`,
      },
    };
    proposals!.preparation = {
      proposalId: "proposal-living-room",
      proposalRevision: 1,
      status: "succeeded",
      attempt: 1,
      version: 2,
      createdAt: "2026-08-24T00:00:02.000Z",
      updatedAt: "2026-08-24T00:00:03.000Z",
    };
    assert.equal((await context.homeAutomationMigrations.refreshRuleWorkflow({ migrationId: assessment.assessment.migrationId, ruleRef: "rule-1" })).status, "ready");
    assert.equal(context.homeAutomationMigrations.startRuleSwitch({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
      approvedProposalRevision: 3,
      switchOperationId: "0123456789abcdef0123456789abcdef",
      switchActor: "household-owner",
    }), true);
    assert.equal(context.homeAutomationMigrations.failRuleWorkflow({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
      from: "switching",
      reason: "switch_unknown",
    }), true);
    const failed = context.homeAutomationMigrations.findWorkflowForProposal("proposal-living-room");
    assert.equal(failed.status, "governed");
    if (failed.status === "governed") {
      assert.equal(failed.workflowStatus, "needs_attention");
      assert.equal(failed.migrationId, assessment.assessment.migrationId);
      assert.equal(failed.ruleRef, "rule-1");
      assert.equal(failed.sourceBridgeId, SOURCE.bridgeId);
      assert.equal(failed.sourceFingerprint, translatedRule.sourceFingerprint);
      assert.equal(failed.reviewProposalRevision, 2);
      assert.equal(failed.approvedProposalRevision, 3);
      assert.equal(failed.switchOperationId, "0123456789abcdef0123456789abcdef");
      assert.equal(failed.switchActor, "household-owner");
      assert.equal(failed.sourceWasEnabled, true);
      assert.equal(typeof failed.switchStartedAt, "string");
      assert.equal(failed.failureReason, "switch_unknown");
    }
    assert.equal(context.homeAutomationMigrations.resumeRuleSwitch({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
      switchOperationId: "fedcba9876543210fedcba9876543210",
      switchActor: "member:alice",
    }), true);
    assert.equal(context.homeAutomationMigrations.findWorkflowForProposal("proposal-living-room").workflowStatus, "switching");
  } finally {
    await proposalFiber?.dispose();
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("reopens a switching workflow as readable governed state without replaying preparation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-migration-switch-restart-"));
  const path = join(directory, "migrations.sqlite");
  let migrationId = "";
  let first: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    first = await setup(path, true);
    const assessment = await first.context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    migrationId = assessment.assessment.migrationId;
    const prepared = await first.context.homeAutomationMigrations.prepareRuleReview({ migrationId, ruleRef: "rule-1" });
    assert.equal(prepared.status, "translated");
    first.proposals!.proposal = {
      ...first.proposals!.proposal!,
      revision: 2,
      lifecycle: "ready",
      preparedContentHash: preparedContentHash(first.proposals!.proposal!),
      preparedArtifact: {
        artifactId: "artifact-living-room",
        revision: 1,
        contentHash: `sha256:${"b".repeat(64)}`,
        compileResultId: `sha256:${"c".repeat(64)}`,
        dryRunResultId: `sha256:${"d".repeat(64)}`,
      },
    };
    first.proposals!.preparation = {
      proposalId: "proposal-living-room",
      proposalRevision: 1,
      status: "succeeded",
      attempt: 1,
      version: 2,
      createdAt: "2026-08-24T00:00:02.000Z",
      updatedAt: "2026-08-24T00:00:03.000Z",
    };
    assert.equal((await first.context.homeAutomationMigrations.refreshRuleWorkflow({ migrationId, ruleRef: "rule-1" })).status, "ready");
    assert.equal(first.context.homeAutomationMigrations.startRuleSwitch({
      migrationId,
      ruleRef: "rule-1",
      approvedProposalRevision: 3,
      switchOperationId: "0123456789abcdef0123456789abcdef",
      switchActor: "household-owner",
    }), true);
  } finally {
    await first?.proposalFiber?.dispose();
    await first?.migrationFiber.dispose();
    await first?.worldFiber.dispose();
  }

  const reopened = await setup(path);
  try {
    const governed = reopened.context.homeAutomationMigrations.findWorkflowForProposal("proposal-living-room");
    assert.equal(governed.status, "governed");
    if (governed.status === "governed") {
      assert.equal(governed.workflowStatus, "switching");
      assert.equal(governed.migrationId, migrationId);
      assert.equal(governed.ruleRef, "rule-1");
      assert.equal(governed.sourceBridgeId, SOURCE.bridgeId);
      assert.equal(governed.sourceFingerprint, translatedRule.sourceFingerprint);
      assert.equal(governed.reviewProposalRevision, 2);
      assert.equal(governed.approvedProposalRevision, 3);
      assert.equal(governed.switchOperationId, "0123456789abcdef0123456789abcdef");
      assert.equal(governed.switchActor, "household-owner");
      assert.equal(governed.sourceWasEnabled, true);
    }
    assert.deepEqual(await reopened.context.homeAutomationMigrations.prepareRuleReview({ migrationId, ruleRef: "rule-1" }), {
      status: "needs_attention",
      reason: "workflow_not_recoverable",
      writesPerformed: false,
    });

    // The active switching receipt is closed with a strict failure CAS before
    // a fresh resume receipt is accepted; no persisted target fingerprint is
    // invented for this crash window.
    assert.equal(reopened.context.homeAutomationMigrations.failRuleWorkflow({
      migrationId,
      ruleRef: "rule-1",
      from: "switching",
      reason: "switch_unknown",
    }), true);
    assert.equal(reopened.context.homeAutomationMigrations.resumeRuleSwitch({
      migrationId,
      ruleRef: "rule-1",
      switchOperationId: "fedcba9876543210fedcba9876543210",
      switchActor: "member:recovery",
    }), true);
    assert.equal(reopened.context.homeAutomationMigrations.verifyRuleSwitch({
      migrationId,
      ruleRef: "rule-1",
      deploymentId: "hob_proposal_living_room",
      deploymentTarget: SOURCE.bridgeId,
      deploymentConfigFingerprint: `sha256:${"e".repeat(64)}`,
    }), true);
    assert.equal(reopened.context.homeAutomationMigrations.startRuleRollback({
      migrationId,
      ruleRef: "rule-1",
      rollbackOperationId: "abcdefabcdefabcdefabcdefabcdefab",
      rollbackActor: "member:recovery",
    }), true);
  } finally {
    await reopened.migrationFiber.dispose();
    await reopened.worldFiber.dispose();
  }

  const restarted = await setup(path);
  try {
    const activeRollback = restarted.context.homeAutomationMigrations.findWorkflowForProposal("proposal-living-room");
    assert.equal(activeRollback.status, "governed");
    if (activeRollback.status === "governed") assert.equal(activeRollback.workflowStatus, "rolling_back");
    assert.equal(restarted.context.homeAutomationMigrations.failRuleWorkflow({
      migrationId,
      ruleRef: "rule-1",
      from: "rolling_back",
      reason: "rollback_unknown",
    }), true);
    assert.equal(restarted.context.homeAutomationMigrations.resumeRuleRollback({
      migrationId,
      ruleRef: "rule-1",
      rollbackOperationId: "badc0ffee0badc0ffee0badc0ffee0ba",
      rollbackActor: "member:restart",
    }), true);
    const resumed = restarted.context.homeAutomationMigrations.findWorkflowForProposal("proposal-living-room");
    assert.equal(resumed.status, "governed");
    if (resumed.status === "governed") {
      assert.equal(resumed.workflowStatus, "rolling_back");
      assert.equal(resumed.rollbackOperationId, "badc0ffee0badc0ffee0badc0ffee0ba");
    }
  } finally {
    await restarted.migrationFiber.dispose();
    await restarted.worldFiber.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps a translated rule recoverable while succeeded preparation awaits the ready envelope", async () => {
  const { context, proposals, worldFiber, migrationFiber, proposalFiber } = await setup(":memory:", true);
  try {
    assert.notEqual(proposals, undefined);
    const assessment = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    assert.equal(assessment.outcome, "created");
    const prepared = await context.homeAutomationMigrations.prepareRuleReview({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    });
    assert.equal(prepared.status, "translated");
    proposals!.preparation = {
      proposalId: "proposal-living-room",
      proposalRevision: 1,
      status: "succeeded",
      attempt: 1,
      version: 2,
      createdAt: "2026-08-24T00:00:02.000Z",
      updatedAt: "2026-08-24T00:00:03.000Z",
    };

    const refreshed = await context.homeAutomationMigrations.refreshRuleWorkflow({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    });

    assert.equal(refreshed.status, "translated");
    assert.equal(
      context.homeAutomationMigrations.get(assessment.assessment.migrationId)?.rules[0]?.workflow?.status,
      "translated",
    );
  } finally {
    await proposalFiber?.dispose();
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("refresh failure stores only a fixed simulation failure and keeps provider details out", async () => {
  const { context, proposals, worldFiber, migrationFiber, proposalFiber } = await setup(":memory:", true);
  try {
    assert.notEqual(proposals, undefined);
    const assessment = await context.homeAutomationMigrations.assessBridgeCatalog(SOURCE.bridgeId);
    assert.equal(assessment.outcome, "created");
    const prepared = await context.homeAutomationMigrations.prepareRuleReview({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    });
    assert.equal(prepared.status, "translated");
    proposals!.proposal = {
      ...proposals!.proposal!,
      revision: 2,
      lifecycle: "ready",
      preparedContentHash: preparedContentHash(proposals!.proposal!),
    };
    proposals!.preparation = {
      proposalId: "proposal-living-room",
      proposalRevision: 1,
      status: "succeeded",
      attempt: 1,
      version: 2,
      createdAt: "2026-08-24T00:00:02.000Z",
      updatedAt: "2026-08-24T00:00:03.000Z",
    };

    const refreshed = await context.homeAutomationMigrations.refreshRuleWorkflow({
      migrationId: assessment.assessment.migrationId,
      ruleRef: "rule-1",
    });
    assert.deepEqual(refreshed, {
      status: "needs_attention",
      reason: "simulation_failed",
      writesPerformed: false,
    });
    const workflow = context.homeAutomationMigrations.get(assessment.assessment.migrationId)?.rules[0]?.workflow;
    assert.equal(workflow?.status, "needs_attention");
    assert.equal(workflow?.failureReason, "compile_failed");
    assert.equal(JSON.stringify(refreshed).includes("provider"), false);
  } finally {
    await proposalFiber?.dispose();
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});

test("keeps new workflow methods strict and fail closed for malformed or Proxy inputs", async () => {
  const { context, worldFiber, migrationFiber, proposalFiber } = await setup(":memory:", true);
  try {
    assert.deepEqual(await (context.homeAutomationMigrations.prepareRuleReview as unknown as (input: unknown) => Promise<unknown>)({
      migrationId: "f".repeat(32),
      ruleRef: "rule-1",
      nativeBody: "secret",
    }), { status: "needs_attention", reason: "invalid_input", writesPerformed: false });
    assert.deepEqual(await context.homeAutomationMigrations.refreshRuleWorkflow({
      migrationId: "f".repeat(32),
      ruleRef: "rule-1",
      extra: true,
    } as never), { status: "needs_attention", reason: "invalid_input", writesPerformed: false });
    const throwing = new Proxy({ migrationId: "f".repeat(32), ruleRef: "rule-1" }, {
      ownKeys() { throw new Error("provider detail"); },
    });
    const closed = await (context.homeAutomationMigrations.refreshRuleWorkflow as unknown as (input: unknown) => Promise<unknown>)(throwing);
    assert.deepEqual(closed, { status: "needs_attention", reason: "invalid_input", writesPerformed: false });
    assert.equal(JSON.stringify(closed).includes("provider detail"), false);
  } finally {
    await proposalFiber?.dispose();
    await migrationFiber.dispose();
    await worldFiber.dispose();
  }
});
