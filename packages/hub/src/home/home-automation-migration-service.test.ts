import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HomeAutomationMigrationIdempotencyConflictError,
  HomeAutomationMigrationService,
  type HomeAutomationMigrationInput,
} from "./home-automation-migration-service.js";
import {
  InMemoryHomeAutomationMigrationStore,
  SqliteHomeAutomationMigrationStore,
} from "./home-automation-migration-store.js";

const now = "2026-08-24T08:00:00.000Z";
const eligibleFingerprint = `sha256:${"e".repeat(64)}`;

function catalog(overrides: Record<string, unknown> = {}): HomeAutomationMigrationInput["catalog"] {
  return {
    bridgeId: "bridge-ha",
    status: "available",
    epochId: "epoch-1",
    lastSeq: 12,
    rules: [
      { ruleRef: "ha-rule-1", name: "晚间灯光", enabled: true, updatedAt: now },
      { ruleRef: "ha-rule-2", name: "离家场景", enabled: false, updatedAt: now },
    ],
    ...overrides,
  } as HomeAutomationMigrationInput["catalog"];
}

function service(store = new InMemoryHomeAutomationMigrationStore()): HomeAutomationMigrationService {
  let nextId = 0;
  return new HomeAutomationMigrationService({
    store,
    clock: () => now,
    migrationIdFactory: () => `${(++nextId).toString(16).padStart(32, "0")}`,
    idempotencyKeyFactory: () => `${(++nextId).toString(16).padStart(32, "0")}`,
  });
}

test("metadata-only foreign rule summaries are assessed without claiming migration eligibility", async () => {
  const result = await service().create({ catalog: catalog() });

  assert.equal(result.outcome, "created");
  assert.match(result.assessment.migrationId, /^[a-f0-9]{32}$/);
  assert.match(result.assessment.idempotencyKey, /^[a-f0-9]{32}$/);
  assert.equal(result.assessment.status, "assessed");
  assert.equal(result.assessment.analysisMode, "metadata_only");
  assert.deepEqual(result.assessment.rules.map((rule) => ({
    ruleRef: rule.ruleRef,
    disposition: rule.disposition,
    reason: rule.reason,
  })), [
    { ruleRef: "ha-rule-1", disposition: "metadata_only", reason: "translation_unavailable" },
    { ruleRef: "ha-rule-2", disposition: "metadata_only", reason: "translation_unavailable" },
  ]);
  assert.equal("nativeBody" in result.assessment, false);
  assert.equal("nativeBody" in result.assessment.rules[0]!, false);
});

test("only the injected translator classifies eligible and unsupported rules", async () => {
  const calls: string[] = [];
  const result = await new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "1".repeat(32),
    idempotencyKeyFactory: () => "2".repeat(32),
    translator: {
      assess: async (request) => {
        calls.push(request.ruleRef);
        return request.ruleRef === "ha-rule-1"
          ? { ruleRef: request.ruleRef, trigger: { kind: "time" }, condition: { kind: "flat_and" }, action: { kind: "reversible" }, sourceFingerprint: eligibleFingerprint }
          : { ruleRef: request.ruleRef, trigger: { kind: "unsupported" }, condition: { kind: "flat_and" }, action: { kind: "reversible" } };
      },
    },
  }).create({
    catalog: catalog({
      rules: [
        { ruleRef: "ha-rule-1", name: "晚间灯光", enabled: true, updatedAt: now },
        { ruleRef: "ha-rule-2", name: "离家场景", enabled: false, updatedAt: now },
      ],
    }),
  });

  assert.equal(result.assessment.status, "assessed");
  assert.equal(result.assessment.analysisMode, "trusted_neutral");
  assert.deepEqual(result.assessment.rules.map((rule) => [rule.disposition, rule.reason]), [
    ["eligible", undefined],
    ["unsupported", "unsupported_trigger"],
  ]);
  assert.deepEqual(calls, ["ha-rule-1", "ha-rule-2"]);

  const needsAttention = await new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "4".repeat(32),
    idempotencyKeyFactory: () => "5".repeat(32),
    translator: {
      assess: async () => ({ ruleRef: "wrong-rule", trigger: { kind: "unknown" }, condition: { kind: "flat_and" }, action: { kind: "reversible" } }),
    },
  }).create({
    catalog: catalog({ rules: [{ ruleRef: "ha-rule-1", name: "晚间灯光" }] }),
  });
  assert.equal(needsAttention.assessment.status, "needs_attention");
  assert.equal(needsAttention.assessment.rules[0]?.disposition, "needs_attention");
  assert.equal(needsAttention.assessment.rules[0]?.reason, "analysis_incomplete");
});

test("condition classification is explicit and missing condition analysis fails closed", async () => {
  const unsupportedCondition = await new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "6".repeat(32),
    idempotencyKeyFactory: () => "7".repeat(32),
    translator: {
      assess: async (request) => ({
        ruleRef: request.ruleRef,
        trigger: { kind: "state" },
        condition: { kind: "unsupported" },
        action: { kind: "reversible" },
      } as never),
    },
  }).create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
  assert.equal(unsupportedCondition.assessment.status, "assessed");
  assert.equal(unsupportedCondition.assessment.rules[0]?.disposition, "unsupported");
  assert.equal(unsupportedCondition.assessment.rules[0]?.reason, "unsupported_condition");
  assert.equal((unsupportedCondition.assessment.rules[0] as unknown as { conditionClass?: string }).conditionClass, "unsupported");

  const missingCondition = await new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "8".repeat(32),
    idempotencyKeyFactory: () => "9".repeat(32),
    translator: {
      assess: async (request) => ({
        ruleRef: request.ruleRef,
        trigger: { kind: "state" },
        action: { kind: "reversible" },
      }),
    },
  }).create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
  assert.equal(missingCondition.assessment.status, "needs_attention");
  assert.equal(missingCondition.assessment.rules[0]?.disposition, "needs_attention");
});

test("eligible analysis persists only the translator-owned source fingerprint", async () => {
  const sourceFingerprint = `sha256:${"a".repeat(64)}`;
  const migration = new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "a".repeat(32),
    idempotencyKeyFactory: () => "b".repeat(32),
    translator: {
      assess: async (request) => ({
        ruleRef: request.ruleRef,
        trigger: { kind: "state" },
        condition: { kind: "flat_and" },
        action: { kind: "reversible" },
        sourceFingerprint,
      } as never),
    },
  });
  const result = await migration.create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
  assert.equal(result.assessment.status, "assessed");
  assert.equal((result.assessment.rules[0] as unknown as { sourceFingerprint?: string }).sourceFingerprint, sourceFingerprint);

  await assert.rejects(() => new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
  }).create({
    catalog: catalog({ rules: [{ ruleRef: "ha-rule-1", sourceFingerprint }] }),
  } as never), /Foreign rule metadata is invalid/);
});

test("eligible analysis without a valid source fingerprint remains needs_attention", async () => {
  const missing = await new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "c".repeat(32),
    idempotencyKeyFactory: () => "d".repeat(32),
    translator: {
      assess: async (request) => ({
        ruleRef: request.ruleRef,
        trigger: { kind: "state" },
        condition: { kind: "flat_and" },
        action: { kind: "reversible" },
      }),
    },
  }).create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
  assert.equal(missing.assessment.status, "needs_attention");
  assert.equal(missing.assessment.rules[0]?.disposition, "needs_attention");

  const malformed = await new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "e".repeat(32),
    idempotencyKeyFactory: () => "f".repeat(32),
    translator: {
      assess: async (request) => ({
        ruleRef: request.ruleRef,
        trigger: { kind: "state" },
        condition: { kind: "flat_and" },
        action: { kind: "reversible" },
        sourceFingerprint: "sha256:not-64-hex",
      } as never),
    },
  }).create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
  assert.equal(malformed.assessment.status, "needs_attention");
  assert.equal(malformed.assessment.rules[0]?.disposition, "needs_attention");
  assert.equal("sourceFingerprint" in malformed.assessment.rules[0]!, false);
});

test("request payload cannot smuggle analysis or native rule body", async () => {
  const migration = service();
  await assert.rejects(() => migration.create({
    catalog: catalog({ rules: [{ ruleRef: "ha-rule-1", nativeBody: { trigger: "on" } }] }),
  } as never), /Foreign rule metadata is invalid/);
  await assert.rejects(() => migration.create({
    catalog: catalog(),
    analysis: { source: "trusted_neutral", rules: [] },
  } as never), /migration input is invalid/);
});

test("same idempotency key and input replays while a changed input conflicts", async () => {
  const store = new InMemoryHomeAutomationMigrationStore();
  const firstService = service(store);
  const first = await firstService.create({ catalog: catalog(), idempotencyKey: "a".repeat(32) });
  const replay = await firstService.create({ catalog: catalog(), idempotencyKey: first.assessment.idempotencyKey });

  assert.equal(replay.outcome, "existing");
  assert.deepEqual(replay.assessment, first.assessment);
  await assert.rejects(
    () => firstService.create({
      catalog: catalog({ epochId: "epoch-2" }),
      idempotencyKey: first.assessment.idempotencyKey,
    }),
    (error: unknown) => error instanceof HomeAutomationMigrationIdempotencyConflictError,
  );
});

test("translator unavailable, aborted, or malformed responses remain needs_attention", async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = await new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "c".repeat(32),
    idempotencyKeyFactory: () => "d".repeat(32),
    translator: {
      assess: async (_request, options) => {
        assert.equal(options.signal, controller.signal);
        return { ruleRef: "ha-rule-1", trigger: { kind: "time" }, condition: { kind: "flat_and" }, action: { kind: "reversible" }, sourceFingerprint: eligibleFingerprint };
      },
    },
  }).create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) }, { signal: controller.signal });
  assert.equal(aborted.assessment.status, "needs_attention");
  assert.equal(aborted.assessment.rules[0]?.disposition, "needs_attention");

  const unavailable = await new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "e".repeat(32),
    idempotencyKeyFactory: () => "f".repeat(32),
    translator: {
      assess: async () => { throw new Error("bridge unavailable"); },
    },
  }).create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
  assert.equal(unavailable.assessment.status, "needs_attention");
  assert.equal(unavailable.assessment.rules[0]?.reason, "analysis_incomplete");

  const retryStore = new InMemoryHomeAutomationMigrationStore();
  const failed = await new HomeAutomationMigrationService({
    store: retryStore,
    clock: () => now,
    migrationIdFactory: () => "1".repeat(32),
    idempotencyKeyFactory: () => "2".repeat(32),
    translator: { assess: async () => { throw new Error("temporary bridge outage"); } },
  }).create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }), idempotencyKey: "3".repeat(32) });
  assert.equal(failed.assessment.status, "needs_attention");
  const retried = await new HomeAutomationMigrationService({
    store: retryStore,
    clock: () => now,
    translator: { assess: async (request) => ({ ruleRef: request.ruleRef, trigger: { kind: "time" }, condition: { kind: "flat_and" }, action: { kind: "reversible" }, sourceFingerprint: eligibleFingerprint }) },
  }).retry({ migrationId: failed.assessment.migrationId });
  assert.equal(retried?.status, "assessed");
  assert.equal(retryStore.recover().length, 0);
});

test("idempotent create replays needs_attention without bridge I/O; retry is explicit", async () => {
  const store = new InMemoryHomeAutomationMigrationStore();
  let firstCalls = 0;
  const failed = await new HomeAutomationMigrationService({
    store,
    clock: () => now,
    migrationIdFactory: () => "1".repeat(32),
    idempotencyKeyFactory: () => "2".repeat(32),
    translator: {
      assess: async () => {
        firstCalls += 1;
        throw new Error("temporary bridge outage");
      },
    },
  }).create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }), idempotencyKey: "3".repeat(32) });
  assert.equal(firstCalls, 1);
  assert.equal(failed.assessment.status, "needs_attention");

  let replayCalls = 0;
  const replayed = await new HomeAutomationMigrationService({
    store,
    clock: () => now,
    translator: {
      assess: async (request) => {
        replayCalls += 1;
        return { ruleRef: request.ruleRef, trigger: { kind: "time" }, condition: { kind: "flat_and" }, action: { kind: "reversible" }, sourceFingerprint: eligibleFingerprint };
      },
    },
  }).create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }), idempotencyKey: failed.assessment.idempotencyKey });
  assert.equal(replayed.outcome, "existing");
  assert.deepEqual(replayed.assessment, failed.assessment);
  assert.equal(replayCalls, 0);
});

test("translator receives the exact source watermark on create, retry, and recover", async () => {
  const store = new InMemoryHomeAutomationMigrationStore();
  const seen: unknown[] = [];
  let nextMigrationId = 0;
  const unavailableTranslator = {
    assess: async (request: unknown) => {
      seen.push(request);
      throw new Error("temporary bridge outage");
    },
  };
  const firstService = new HomeAutomationMigrationService({
    store,
    clock: () => now,
    migrationIdFactory: () => `${(++nextMigrationId).toString(16).padStart(32, "0")}`,
    idempotencyKeyFactory: () => "2".repeat(32),
    translator: unavailableTranslator,
  });
  const first = await firstService.create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }), idempotencyKey: "3".repeat(32) });
  const second = await firstService.create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }), idempotencyKey: "4".repeat(32) });
  assert.equal(first.assessment.status, "needs_attention");
  assert.equal(second.assessment.status, "needs_attention");

  const recoveredTranslator = {
    assess: async (request: unknown) => {
      seen.push(request);
      const context = request as { readonly ruleRef: string };
        return { ruleRef: context.ruleRef, trigger: { kind: "state" as const }, condition: { kind: "flat_and" as const }, action: { kind: "reversible" as const }, sourceFingerprint: eligibleFingerprint };
    },
  };
  const recoveryService = new HomeAutomationMigrationService({ store, clock: () => now, translator: recoveredTranslator });
  const retried = await recoveryService.retry({ migrationId: first.assessment.migrationId });
  const recovered = await recoveryService.recover();
  assert.equal(retried?.status, "assessed");
  assert.equal(recovered[0]?.status, "assessed");
  assert.deepEqual(seen, [
    { bridgeId: "bridge-ha", epochId: "epoch-1", lastSeq: 12, ruleRef: "ha-rule-1" },
    { bridgeId: "bridge-ha", epochId: "epoch-1", lastSeq: 12, ruleRef: "ha-rule-1" },
    { bridgeId: "bridge-ha", epochId: "epoch-1", lastSeq: 12, ruleRef: "ha-rule-1" },
    { bridgeId: "bridge-ha", epochId: "epoch-1", lastSeq: 12, ruleRef: "ha-rule-1" },
  ]);
});

test("assessment completion time is captured after translator I/O", async () => {
  const times = ["2026-08-24T08:00:00.000Z", "2026-08-24T08:00:05.000Z"];
  const result = await new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => times.shift() ?? "2026-08-24T08:00:05.000Z",
    migrationIdFactory: () => "4".repeat(32),
    idempotencyKeyFactory: () => "5".repeat(32),
    translator: {
      assess: async (request) => ({ ruleRef: request.ruleRef, trigger: { kind: "time" }, condition: { kind: "flat_and" }, action: { kind: "reversible" }, sourceFingerprint: eligibleFingerprint }),
    },
  }).create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
  assert.equal(result.assessment.createdAt, "2026-08-24T08:00:00.000Z");
  assert.equal(result.assessment.assessedAt, "2026-08-24T08:00:05.000Z");
});

test("unavailable, incomplete, oversized, and native-body inputs fail closed before persistence", async () => {
  const store = new InMemoryHomeAutomationMigrationStore();
  const migration = service(store);

  await assert.rejects(() => migration.create({ catalog: catalog({ status: "unavailable", rules: [] }) }), /catalog is unavailable/);
  await assert.rejects(() => migration.create({ catalog: catalog({ rules: new Array(257).fill({ ruleRef: "rule" }) }) }), /rules exceed/);
  await assert.rejects(() => migration.create({ catalog: catalog({
    rules: [{ ruleRef: "ha-rule-1", nativeBody: { trigger: "on" } }],
  }) as never }), /Foreign rule metadata is invalid/);
  assert.equal(migration.list().length, 0);
});

test("replay, recover, and close expose durable lifecycle without actor or device payloads", async () => {
  const store = new InMemoryHomeAutomationMigrationStore();
  const migration = service(store);
  const first = await migration.create({ catalog: catalog() });
  assert.deepEqual(migration.get(first.assessment.migrationId), first.assessment);
  assert.deepEqual(migration.list().map((item) => item.migrationId), [first.assessment.migrationId]);
  assert.deepEqual(migration.replay({
    idempotencyKey: first.assessment.idempotencyKey,
    catalog: catalog(),
  }), first.assessment);
  assert.deepEqual(await migration.recover(), []);

  const closed = migration.closeAssessment({ migrationId: first.assessment.migrationId, reason: "household_closed" });
  assert.equal(closed?.status, "closed");
  assert.equal(closed?.closedFrom, "assessed");
  assert.equal(closed && "actor" in closed, false);
});

test("assessed metadata survives a service restart and retries stay read-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-service-"));
  const path = join(directory, "migrations.sqlite");
  try {
    const firstStore = new SqliteHomeAutomationMigrationStore({ path });
    const first = new HomeAutomationMigrationService({
      store: firstStore,
      clock: () => now,
      migrationIdFactory: () => "6".repeat(32),
      idempotencyKeyFactory: () => "7".repeat(32),
    });
    const created = await first.create({ catalog: catalog(), idempotencyKey: "8".repeat(32) });
    first.close();

    const secondStore = new SqliteHomeAutomationMigrationStore({ path });
    const second = new HomeAutomationMigrationService({ store: secondStore, clock: () => now });
    const replay = second.replay({ catalog: catalog(), idempotencyKey: created.assessment.idempotencyKey });
    assert.deepEqual(replay, created.assessment);
    assert.equal(second.list().length, 1);
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recover resumes a durable discovered row without retaining the source rule body", async () => {
  const store = new InMemoryHomeAutomationMigrationStore();
  store.discover({
    migrationId: "9".repeat(32),
    idempotencyKey: "a".repeat(32),
    inputDigest: `sha256:${"b".repeat(64)}`,
    sourceBridgeId: "bridge-ha",
    sourceEpochId: "epoch-1",
    sourceLastSeq: 12,
    analysisMode: "metadata_only",
    rules: [{
      ruleRef: "ha-rule-1",
      name: "晚间灯光",
      triggerClass: "metadata_only",
      conditionClass: "metadata_only",
      actionClass: "metadata_only",
      disposition: "metadata_only",
      reason: "translation_unavailable",
    }],
    createdAt: now,
  });
  const recovered = await service(store).recover();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.status, "assessed");
  assert.equal(store.recover().length, 0);
  assert.equal("nativeBody" in recovered[0]!, false);
});

test("needs-attention recovery survives SQLite restart and can be retried by a new translator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-retry-"));
  const path = join(directory, "migrations.sqlite");
  try {
    const firstStore = new SqliteHomeAutomationMigrationStore({ path });
    const failed = await new HomeAutomationMigrationService({
      store: firstStore,
      clock: () => now,
      migrationIdFactory: () => "6".repeat(32),
      idempotencyKeyFactory: () => "7".repeat(32),
      translator: { assess: async () => { throw new Error("temporary bridge outage"); } },
    }).create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
    assert.equal(failed.assessment.status, "needs_attention");
    firstStore.close();

    const secondStore = new SqliteHomeAutomationMigrationStore({ path });
    const recovered = await new HomeAutomationMigrationService({
      store: secondStore,
      clock: () => now,
      translator: { assess: async (request) => ({ ruleRef: request.ruleRef, trigger: { kind: "state" }, condition: { kind: "flat_and" }, action: { kind: "reversible" }, sourceFingerprint: eligibleFingerprint }) },
    }).recover();
    assert.equal(recovered[0]?.status, "assessed");
    assert.equal(recovered[0]?.createdAt, now);
    secondStore.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
