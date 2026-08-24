import assert from "node:assert/strict";
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

async function setup(path: string) {
  const context = new Context();
  const worldFiber = await context.plugin(StubHomeWorld);
  const migrationFiber = await context.plugin(HomeAutomationMigrationRuntimeService, { path });
  return { context, world: context.homeWorld as unknown as StubHomeWorld, worldFiber, migrationFiber };
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
