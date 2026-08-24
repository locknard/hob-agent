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
import { SqliteHomeAutomationMigrationStore } from "./home-automation-migration-store.js";
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

class StubHomeWorld extends Service {
  readonly catalogs = [{
    ...SOURCE,
    status: "available" as const,
    rules: [{ ruleRef: "rule-1", name: "Living room light", enabled: true }],
  }];
  translation: unknown = translatedRule;
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
    assert.equal(input.ruleRef, "rule-1");
    return this.translation;
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
}

async function setup(path: string, withProposals = false) {
  const context = new Context();
  const worldFiber = await context.plugin(StubHomeWorld);
  const migrationFiber = await context.plugin(HomeAutomationMigrationRuntimeService, { path });
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
