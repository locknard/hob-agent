import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryHomeAutomationMigrationStore,
  SqliteHomeAutomationMigrationStore,
} from "./home-automation-migration-store.js";

const createdAt = "2026-08-24T08:00:00.000Z";
const discovered = {
  migrationId: "1".repeat(32),
  idempotencyKey: "2".repeat(32),
  inputDigest: `sha256:${"3".repeat(64)}`,
  sourceBridgeId: "bridge-ha",
  sourceEpochId: "epoch-1",
  sourceLastSeq: 12,
  analysisMode: "metadata_only" as const,
  rules: [{
    ruleRef: "ha-rule-1",
    name: "晚间灯光",
    enabled: true,
    updatedAt: createdAt,
    triggerClass: "metadata_only" as const,
    conditionClass: "metadata_only" as const,
    actionClass: "metadata_only" as const,
    disposition: "metadata_only" as const,
    reason: "translation_unavailable" as const,
  }],
  createdAt,
};

test("in-memory store preserves discovered to assessed transitions and recovery", () => {
  const store = new InMemoryHomeAutomationMigrationStore();
  assert.equal(store.discover(discovered).outcome, "created");
  assert.deepEqual(store.recover().map((item) => item.migrationId), [discovered.migrationId]);
  assert.throws(() => store.assess({
    migrationId: discovered.migrationId,
    status: "assessed",
    assessedAt: createdAt,
    rules: [],
  }), /corrupt/);
  assert.equal(store.assess({
    migrationId: discovered.migrationId,
    status: "assessed",
    assessedAt: createdAt,
    rules: discovered.rules,
  }), true);
  assert.equal(store.recover().length, 0);
  assert.equal(store.get(discovered.migrationId)?.status, "assessed");
  assert.equal(store.closeAssessment({ migrationId: discovered.migrationId, closedAt: createdAt, reason: "household_closed" }), true);
  assert.equal(store.get(discovered.migrationId)?.status, "closed");
});

test("in-memory store rejects an assessment status that disagrees with rule dispositions before writing", () => {
  const store = new InMemoryHomeAutomationMigrationStore();
  store.discover(discovered);
  const needsAttentionRule = {
    ...discovered.rules[0]!,
    triggerClass: "unknown" as const,
    conditionClass: "unknown" as const,
    actionClass: "unknown" as const,
    disposition: "needs_attention" as const,
    reason: "analysis_incomplete" as const,
  };

  assert.throws(() => store.assess({
    migrationId: discovered.migrationId,
    status: "assessed",
    assessedAt: createdAt,
    rules: [needsAttentionRule],
  }), /corrupt/);
  assert.equal(store.get(discovered.migrationId)?.status, "discovered");
});

test("same idempotency digest replays and a different digest conflicts", () => {
  const store = new InMemoryHomeAutomationMigrationStore();
  const first = store.discover(discovered);
  const replay = store.discover({ ...discovered, migrationId: "4".repeat(32) });
  assert.equal(replay.outcome, "existing");
  assert.deepEqual(replay.assessment, first.assessment);
  assert.throws(() => store.discover({ ...discovered, inputDigest: `sha256:${"5".repeat(64)}` }), /idempotency key conflicts/);
});

test("sqlite store recovers discovered records after restart and rejects corrupt rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-"));
  const path = join(directory, "migrations.sqlite");
  try {
    const first = new SqliteHomeAutomationMigrationStore({ path });
    first.discover(discovered);
    first.close();

    const second = new SqliteHomeAutomationMigrationStore({ path });
    assert.deepEqual(second.recover().map((item) => item.migrationId), [discovered.migrationId]);
    second.close();

    const corrupt = new SqliteHomeAutomationMigrationStore({ path });
    corrupt.close();
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE home_automation_migrations SET rules_json = ? WHERE migration_id = ?")
      .run("{}", discovered.migrationId);
    raw.close();
    const reopenedCorrupt = new SqliteHomeAutomationMigrationStore({ path });
    assert.throws(() => reopenedCorrupt.get(discovered.migrationId), /stored home automation migration is corrupt/i);
    reopenedCorrupt.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite store rejects a source fingerprint on a non-eligible persisted rule", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-fingerprint-"));
  const path = join(directory, "migrations.sqlite");
  try {
    const store = new SqliteHomeAutomationMigrationStore({ path });
    store.discover(discovered);
    store.close();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE home_automation_migrations SET rules_json = ? WHERE migration_id = ?")
      .run(JSON.stringify([{ ...discovered.rules[0], sourceFingerprint: `sha256:${"a".repeat(64)}` }]), discovered.migrationId);
    raw.close();

    const reopened = new SqliteHomeAutomationMigrationStore({ path });
    assert.throws(() => reopened.get(discovered.migrationId), /stored home automation migration is corrupt/i);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite store round-trips an eligible source fingerprint across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-fingerprint-roundtrip-"));
  const path = join(directory, "migrations.sqlite");
  const sourceFingerprint = `sha256:${"c".repeat(64)}`;
  try {
    const first = new SqliteHomeAutomationMigrationStore({ path });
    first.discover({ ...discovered, analysisMode: "trusted_neutral" });
    assert.equal(first.assess({
      migrationId: discovered.migrationId,
      status: "assessed",
      assessedAt: createdAt,
      rules: [{
        ruleRef: "ha-rule-1",
        name: "晚间灯光",
        enabled: true,
        updatedAt: createdAt,
        triggerClass: "state",
        conditionClass: "flat_and",
        actionClass: "reversible",
        sourceFingerprint,
        disposition: "eligible",
        workflow: {
          status: "assessed",
          sourceFingerprint,
          assessedAt: createdAt,
        },
      }],
    }), true);
    first.close();

    const second = new SqliteHomeAutomationMigrationStore({ path });
    assert.equal(second.get(discovered.migrationId)?.rules[0]?.sourceFingerprint, sourceFingerprint);
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite assessment is a checked CAS when another writer wins before UPDATE", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-cas-"));
  const path = join(directory, "migrations.sqlite");
  try {
    const owner = new SqliteHomeAutomationMigrationStore({ path });
    owner.discover(discovered);
    const loser = new SqliteHomeAutomationMigrationStore({ path });

    // Model a competing writer winning after the loser read the discovered row:
    // SQLite's IGNORE trigger makes the CAS UPDATE affect zero rows while the
    // transaction itself remains valid. The store must report the lost CAS.
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TRIGGER migration_cas_loser
      BEFORE UPDATE OF rules_json ON home_automation_migrations
      WHEN OLD.migration_id = '${discovered.migrationId}'
      BEGIN SELECT RAISE(IGNORE); END;`);
    raw.close();

    assert.equal(loser.assess({
      migrationId: discovered.migrationId,
      status: "assessed",
      assessedAt: createdAt,
      rules: discovered.rules,
    }), false);
    assert.equal(owner.get(discovered.migrationId)?.status, "discovered");
    loser.close();
    owner.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite store rejects an assessment status that disagrees with rule dispositions before writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-status-"));
  const path = join(directory, "migrations.sqlite");
  try {
    const store = new SqliteHomeAutomationMigrationStore({ path });
    store.discover(discovered);
    const needsAttentionRule = {
      ...discovered.rules[0]!,
      triggerClass: "unknown" as const,
      conditionClass: "unknown" as const,
      actionClass: "unknown" as const,
      disposition: "needs_attention" as const,
      reason: "analysis_incomplete" as const,
    };

    assert.throws(() => store.assess({
      migrationId: discovered.migrationId,
      status: "assessed",
      assessedAt: createdAt,
      rules: [needsAttentionRule],
    }), /corrupt/);
    assert.equal(store.get(discovered.migrationId)?.status, "discovered");
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite rule workflow transition is a strict per-rule CAS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-workflow-cas-"));
  const path = join(directory, "migrations.sqlite");
  const sourceFingerprint = `sha256:${"d".repeat(64)}`;
  const eligibleRules = [{
    ruleRef: "ha-rule-1",
    name: "晚间灯光",
    enabled: true,
    updatedAt: createdAt,
    triggerClass: "state" as const,
    conditionClass: "flat_and" as const,
    actionClass: "reversible" as const,
    sourceFingerprint,
    disposition: "eligible" as const,
    workflow: { status: "assessed" as const, sourceFingerprint, assessedAt: createdAt },
  }];
  try {
    const owner = new SqliteHomeAutomationMigrationStore({ path });
    owner.discover({ ...discovered, analysisMode: "trusted_neutral", rules: discovered.rules });
    assert.equal(owner.assess({ migrationId: discovered.migrationId, status: "assessed", assessedAt: createdAt, rules: eligibleRules }), true);
    const contender = new SqliteHomeAutomationMigrationStore({ path });
    const command = {
      migrationId: discovered.migrationId,
      ruleRef: "ha-rule-1",
      from: "assessed" as const,
      to: "translated" as const,
      transitionedAt: createdAt,
      proposalId: "proposal-cas",
      candidateProposalRevision: 1,
      candidateContentHash: `sha256:${"e".repeat(64)}`,
    };
    assert.equal(owner.transitionRuleWorkflow(command), true);
    assert.equal(contender.transitionRuleWorkflow(command), false);
    assert.equal(owner.get(discovered.migrationId)?.rules[0]?.workflow?.status, "translated");
    assert.throws(() => owner.transitionRuleWorkflow({ ...command, from: "translated", to: "simulated", nativeBody: "blocked" } as never), /workflow transition is invalid/);
    contender.close();
    owner.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite workflow JSON rejects bridge-shaped or semantically incomplete records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-workflow-corrupt-"));
  const path = join(directory, "migrations.sqlite");
  const sourceFingerprint = `sha256:${"f".repeat(64)}`;
  try {
    const store = new SqliteHomeAutomationMigrationStore({ path });
    store.discover({ ...discovered, analysisMode: "trusted_neutral" });
    assert.equal(store.assess({
      migrationId: discovered.migrationId,
      status: "assessed",
      assessedAt: createdAt,
      rules: [{
        ruleRef: "ha-rule-1",
        name: "晚间灯光",
        enabled: true,
        updatedAt: createdAt,
        triggerClass: "state",
        conditionClass: "flat_and",
        actionClass: "reversible",
        sourceFingerprint,
        disposition: "eligible",
        workflow: { status: "assessed", sourceFingerprint, assessedAt: createdAt },
      }],
    }), true);
    store.close();
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE home_automation_migrations SET rules_json = ? WHERE migration_id = ?").run(JSON.stringify([{
      ruleRef: "ha-rule-1",
      triggerClass: "state",
      conditionClass: "flat_and",
      actionClass: "reversible",
      sourceFingerprint,
      disposition: "eligible",
      workflow: {
        status: "translated",
        sourceFingerprint,
        assessedAt: createdAt,
        proposalId: "proposal-corrupt",
        candidateProposalRevision: 1,
        candidateContentHash: `sha256:${"1".repeat(64)}`,
        translatedAt: createdAt,
        bridgeId: "must-not-persist",
      },
    }]), discovered.migrationId);
    raw.close();
    const reopened = new SqliteHomeAutomationMigrationStore({ path });
    assert.throws(() => reopened.get(discovered.migrationId), /stored home automation migration is corrupt/i);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite persisted ready workflow rejects a proposal revision gap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-ready-gap-"));
  const path = join(directory, "migrations.sqlite");
  const sourceFingerprint = `sha256:${"a".repeat(64)}`;
  try {
    const store = new SqliteHomeAutomationMigrationStore({ path });
    store.discover({ ...discovered, analysisMode: "trusted_neutral" });
    assert.equal(store.assess({
      migrationId: discovered.migrationId,
      status: "assessed",
      assessedAt: createdAt,
      rules: [{
        ruleRef: "ha-rule-1",
        name: "晚间灯光",
        enabled: true,
        updatedAt: createdAt,
        triggerClass: "state",
        conditionClass: "flat_and",
        actionClass: "reversible",
        sourceFingerprint,
        disposition: "eligible",
        workflow: { status: "assessed", sourceFingerprint, assessedAt: createdAt },
      }],
    }), true);
    store.close();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE home_automation_migrations SET rules_json = ? WHERE migration_id = ?").run(JSON.stringify([{
      ruleRef: "ha-rule-1",
      name: "晚间灯光",
      enabled: true,
      updatedAt: createdAt,
      triggerClass: "state",
      conditionClass: "flat_and",
      actionClass: "reversible",
      sourceFingerprint,
      disposition: "eligible",
      workflow: {
        status: "ready",
        sourceFingerprint,
        assessedAt: createdAt,
        proposalId: "proposal-gap",
        candidateProposalRevision: 1,
        candidateContentHash: `sha256:${"b".repeat(64)}`,
        translatedAt: createdAt,
        artifactId: "artifact-gap",
        artifactRevision: 1,
        artifactContentHash: `sha256:${"c".repeat(64)}`,
        compileResultId: `sha256:${"d".repeat(64)}`,
        dryRunResultId: `sha256:${"e".repeat(64)}`,
        simulatedAt: createdAt,
        readyAt: createdAt,
        reviewProposalRevision: 3,
      },
    }]), discovered.migrationId);
    raw.close();

    const reopened = new SqliteHomeAutomationMigrationStore({ path });
    assert.throws(() => reopened.get(discovered.migrationId), /stored home automation migration is corrupt/i);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
