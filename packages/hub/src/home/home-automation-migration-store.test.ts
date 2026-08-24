import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryHomeAutomationMigrationStore,
  SqliteHomeAutomationMigrationStore,
  type HomeAutomationMigrationRestoreFailedSwitchCommand,
} from "./home-automation-migration-store.js";
import { computeHomeAutomationMigrationSimulationDigest } from "./home-automation-migration-simulation.js";

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

function simulationReceipt(
  sourceFingerprint: string,
  candidateContentHash: string,
  preparation = {
    artifactId: "artifact-simulation-receipt",
    artifactRevision: 1,
    artifactContentHash: `sha256:${"e".repeat(64)}`,
    compileResultId: `sha256:${"f".repeat(64)}`,
    dryRunResultId: `sha256:${"0".repeat(64)}`,
  },
) {
  const unsigned = {
    schemaVersion: "1" as const,
    kind: "home-automation-migration-simulation" as const,
    sourceCut: { bridgeId: "bridge-ha", epochId: "epoch-1", lastSeq: 12, configFingerprint: sourceFingerprint },
    sourceFingerprint,
    candidateContentHash,
    preparation,
    expectedTriggers: [{ eventId: "event-1", triggered: true, conditionsSatisfied: true }],
    expectedActions: [{ eventId: "event-1", actionOrder: 1, kind: "notify_local" as const, message: "review" }],
    existingRuleInterference: [],
    simulationDigest: `sha256:${"0".repeat(64)}`,
    writesPerformed: false as const,
  };
  return { ...unsigned, simulationDigest: computeHomeAutomationMigrationSimulationDigest(unsigned) };
}

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

test("requires and durably retains a complete dual-run receipt before ready", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-simulation-receipt-"));
  const path = join(directory, "migrations.sqlite");
  const sourceFingerprint = `sha256:${"a".repeat(64)}`;
  const candidateContentHash = `sha256:${"b".repeat(64)}`;
  const receipt = simulationReceipt(sourceFingerprint, candidateContentHash);
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
    const first = new SqliteHomeAutomationMigrationStore({ path });
    first.discover({ ...discovered, analysisMode: "trusted_neutral" });
    assert.equal(first.assess({ migrationId: discovered.migrationId, status: "assessed", assessedAt: createdAt, rules: eligibleRules }), true);
    assert.equal(first.transitionRuleWorkflow({
      migrationId: discovered.migrationId,
      ruleRef: "ha-rule-1",
      from: "assessed",
      to: "translated",
      transitionedAt: createdAt,
      proposalId: "proposal-simulation-receipt",
      candidateProposalRevision: 1,
      candidateContentHash,
    }), true);
    assert.equal(first.transitionRuleWorkflow({
      migrationId: discovered.migrationId,
      ruleRef: "ha-rule-1",
      from: "translated",
      to: "simulated",
      transitionedAt: createdAt,
      artifactId: "artifact-simulation-receipt",
      artifactRevision: 1,
      artifactContentHash: `sha256:${"e".repeat(64)}`,
      compileResultId: `sha256:${"f".repeat(64)}`,
      dryRunResultId: `sha256:${"0".repeat(64)}`,
      simulationReceipt: receipt,
    } as never), true);
    assert.equal(first.transitionRuleWorkflow({
      migrationId: discovered.migrationId,
      ruleRef: "ha-rule-1",
      from: "simulated",
      to: "ready",
      transitionedAt: createdAt,
      reviewProposalRevision: 2,
    }), true);
    const stored = (first as unknown as {
      getSimulationReceipt: (migrationId: string, ruleRef: string) => unknown;
    }).getSimulationReceipt(discovered.migrationId, "ha-rule-1");
    assert.deepEqual(stored, receipt);
    first.close();

    const second = new SqliteHomeAutomationMigrationStore({ path });
    assert.deepEqual((second as unknown as {
      getSimulationReceipt: (migrationId: string, ruleRef: string) => unknown;
    }).getSimulationReceipt(discovered.migrationId, "ha-rule-1"), receipt);
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects absent, provider-shaped, stale, and hash-mismatched receipts before simulated", () => {
  const sourceFingerprint = `sha256:${"a".repeat(64)}`;
  const candidateContentHash = `sha256:${"b".repeat(64)}`;
  const store = new InMemoryHomeAutomationMigrationStore();
  store.discover({ ...discovered, analysisMode: "trusted_neutral" });
  assert.equal(store.assess({
    migrationId: discovered.migrationId,
    status: "assessed",
    assessedAt: createdAt,
    rules: [{
      ruleRef: "ha-rule-1", name: "晚间灯光", enabled: true, updatedAt: createdAt,
      triggerClass: "state", conditionClass: "flat_and", actionClass: "reversible",
      sourceFingerprint, disposition: "eligible", workflow: { status: "assessed", sourceFingerprint, assessedAt: createdAt },
    }],
  }), true);
  const translated = {
    migrationId: discovered.migrationId, ruleRef: "ha-rule-1", from: "assessed" as const, to: "translated" as const,
    transitionedAt: createdAt, proposalId: "proposal-receipt-guards", candidateProposalRevision: 1, candidateContentHash,
  };
  assert.equal(store.transitionRuleWorkflow(translated), true);
  const base = {
    migrationId: discovered.migrationId, ruleRef: "ha-rule-1", from: "translated" as const, to: "simulated" as const,
    transitionedAt: createdAt, artifactId: "artifact-receipt-guards", artifactRevision: 1,
    artifactContentHash: `sha256:${"c".repeat(64)}`, compileResultId: `sha256:${"d".repeat(64)}`, dryRunResultId: `sha256:${"e".repeat(64)}`,
  };
  assert.throws(() => store.transitionRuleWorkflow(base), /workflow transition is invalid/);
  const valid = simulationReceipt(sourceFingerprint, candidateContentHash, {
    artifactId: base.artifactId,
    artifactRevision: base.artifactRevision,
    artifactContentHash: base.artifactContentHash,
    compileResultId: base.compileResultId,
    dryRunResultId: base.dryRunResultId,
  });
  const wrongPreparation = {
    ...valid,
    preparation: { ...valid.preparation, artifactId: "artifact-from-older-preparation" },
  };
  assert.equal(store.transitionRuleWorkflow({
    ...base,
    simulationReceipt: {
      ...wrongPreparation,
      simulationDigest: computeHomeAutomationMigrationSimulationDigest(wrongPreparation),
    },
  }), false);
  assert.throws(() => store.transitionRuleWorkflow({ ...base, simulationReceipt: { ...valid, nativePayload: "blocked" } } as never), /workflow transition is invalid/);
  assert.equal(store.transitionRuleWorkflow({
    ...base,
    simulationReceipt: {
      ...valid,
      sourceCut: { ...valid.sourceCut, lastSeq: valid.sourceCut.lastSeq + 1 },
      simulationDigest: computeHomeAutomationMigrationSimulationDigest({ ...valid, sourceCut: { ...valid.sourceCut, lastSeq: valid.sourceCut.lastSeq + 1 } }),
    },
  }), false);
  assert.equal(store.transitionRuleWorkflow({
    ...base,
    simulationReceipt: {
      ...valid,
      candidateContentHash: `sha256:${"f".repeat(64)}`,
      simulationDigest: computeHomeAutomationMigrationSimulationDigest({ ...valid, candidateContentHash: `sha256:${"f".repeat(64)}` }),
    },
  }), false);
  assert.throws(() => store.transitionRuleWorkflow({
    ...base,
    simulationReceipt: { ...valid, simulationDigest: `sha256:${"0".repeat(64)}` },
  }), /workflow transition is invalid/);
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

test("sqlite persists the complete switch and rollback workflow across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-switch-restart-"));
  const path = join(directory, "migrations.sqlite");
  const sourceFingerprint = `sha256:${"b".repeat(64)}`;
  const candidateContentHash = `sha256:${"c".repeat(64)}`;
  const artifactContentHash = `sha256:${"d".repeat(64)}`;
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
        workflow: { status: "assessed", sourceFingerprint, assessedAt: createdAt },
      }],
    }), true);
    assert.equal(first.transitionRuleWorkflow({
      migrationId: discovered.migrationId,
      ruleRef: "ha-rule-1",
      from: "assessed",
      to: "translated",
      transitionedAt: createdAt,
      proposalId: "proposal-switch-restart",
      candidateProposalRevision: 1,
      candidateContentHash,
    }), true);
    assert.equal(first.transitionRuleWorkflow({
      migrationId: discovered.migrationId,
      ruleRef: "ha-rule-1",
      from: "translated",
      to: "simulated",
      transitionedAt: createdAt,
      artifactId: "artifact-switch-restart",
      artifactRevision: 1,
      artifactContentHash,
      compileResultId: `sha256:${"e".repeat(64)}`,
      dryRunResultId: `sha256:${"f".repeat(64)}`,
      simulationReceipt: simulationReceipt(sourceFingerprint, candidateContentHash, {
        artifactId: "artifact-switch-restart", artifactRevision: 1, artifactContentHash,
        compileResultId: `sha256:${"e".repeat(64)}`, dryRunResultId: `sha256:${"f".repeat(64)}`,
      }),
    }), true);
    assert.equal(first.transitionRuleWorkflow({
      migrationId: discovered.migrationId,
      ruleRef: "ha-rule-1",
      from: "simulated",
      to: "ready",
      transitionedAt: createdAt,
      reviewProposalRevision: 2,
    }), true);
    assert.equal(first.transitionRuleWorkflow({
      migrationId: discovered.migrationId,
      ruleRef: "ha-rule-1",
      from: "ready",
      to: "switching",
      transitionedAt: createdAt,
      approvedProposalRevision: 3,
      switchOperationId: "1".repeat(32),
      switchActor: "member:alice",
      sourceWasEnabled: true,
    }), true);
    assert.equal(first.transitionRuleWorkflow({
      migrationId: discovered.migrationId,
      ruleRef: "ha-rule-1",
      from: "switching",
      to: "verified",
      transitionedAt: createdAt,
      deploymentId: "deployment-restart",
      deploymentTarget: "home-assistant",
      deploymentConfigFingerprint: `sha256:${"a".repeat(64)}`,
    }), true);
    assert.equal(first.transitionRuleWorkflow({
      migrationId: discovered.migrationId,
      ruleRef: "ha-rule-1",
      from: "verified",
      to: "rolling_back",
      transitionedAt: createdAt,
      rollbackOperationId: "2".repeat(32),
      rollbackActor: "member:alice",
    }), true);
    assert.equal(first.transitionRuleWorkflow({
      migrationId: discovered.migrationId,
      ruleRef: "ha-rule-1",
      from: "rolling_back",
      to: "restored",
      transitionedAt: createdAt,
    }), true);
    first.close();

    const second = new SqliteHomeAutomationMigrationStore({ path });
    const restored = second.get(discovered.migrationId)?.rules[0]?.workflow;
    assert.equal(restored?.status, "restored");
    assert.equal(restored?.proposalId, "proposal-switch-restart");
    assert.equal(restored?.reviewProposalRevision, 2);
    assert.equal(restored?.approvedProposalRevision, 3);
    assert.equal(restored?.sourceWasEnabled, true);
    assert.equal(restored?.switchOperationId, "1".repeat(32));
    assert.equal(restored?.deploymentConfigFingerprint, `sha256:${"a".repeat(64)}`);
    assert.equal(restored?.rollbackOperationId, "2".repeat(32));
    assert.equal("nativeBody" in (restored ?? {}), false);
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite rejects malformed switching fields after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-switch-corrupt-"));
  const path = join(directory, "migrations.sqlite");
  const sourceFingerprint = `sha256:${"c".repeat(64)}`;
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
        status: "switching",
        sourceFingerprint,
        assessedAt: createdAt,
        proposalId: "proposal-corrupt-switch",
        candidateProposalRevision: 1,
        candidateContentHash: `sha256:${"d".repeat(64)}`,
        translatedAt: createdAt,
        artifactId: "artifact-corrupt-switch",
        artifactRevision: 1,
        artifactContentHash: `sha256:${"e".repeat(64)}`,
        compileResultId: `sha256:${"f".repeat(64)}`,
        dryRunResultId: `sha256:${"0".repeat(64)}`,
        simulatedAt: createdAt,
        readyAt: createdAt,
        reviewProposalRevision: 2,
        approvedProposalRevision: 4,
        switchOperationId: "3".repeat(32),
        switchActor: "member:alice",
        sourceWasEnabled: true,
        switchStartedAt: createdAt,
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

test("sqlite workflow CAS rejects duplicate and competing switch starts without mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-switch-cas-"));
  const path = join(directory, "migrations.sqlite");
  const sourceFingerprint = `sha256:${"d".repeat(64)}`;
  try {
    const owner = new SqliteHomeAutomationMigrationStore({ path });
    owner.discover({ ...discovered, analysisMode: "trusted_neutral" });
    assert.equal(owner.assess({
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
    assert.equal(owner.transitionRuleWorkflow({
      migrationId: discovered.migrationId, ruleRef: "ha-rule-1", from: "assessed", to: "translated", transitionedAt: createdAt,
      proposalId: "proposal-cas-switch", candidateProposalRevision: 1, candidateContentHash: `sha256:${"e".repeat(64)}`,
    }), true);
    assert.equal(owner.transitionRuleWorkflow({
      migrationId: discovered.migrationId, ruleRef: "ha-rule-1", from: "translated", to: "simulated", transitionedAt: createdAt,
      artifactId: "artifact-cas-switch", artifactRevision: 1, artifactContentHash: `sha256:${"f".repeat(64)}`,
      compileResultId: `sha256:${"0".repeat(64)}`, dryRunResultId: `sha256:${"1".repeat(64)}`,
      simulationReceipt: simulationReceipt(sourceFingerprint, `sha256:${"e".repeat(64)}`, {
        artifactId: "artifact-cas-switch", artifactRevision: 1, artifactContentHash: `sha256:${"f".repeat(64)}`,
        compileResultId: `sha256:${"0".repeat(64)}`, dryRunResultId: `sha256:${"1".repeat(64)}`,
      }),
    }), true);
    assert.equal(owner.transitionRuleWorkflow({
      migrationId: discovered.migrationId, ruleRef: "ha-rule-1", from: "simulated", to: "ready", transitionedAt: createdAt,
      reviewProposalRevision: 2,
    }), true);
    const command = {
      migrationId: discovered.migrationId,
      ruleRef: "ha-rule-1",
      from: "ready" as const,
      to: "switching" as const,
      transitionedAt: createdAt,
      approvedProposalRevision: 3,
      switchOperationId: "4".repeat(32),
      switchActor: "member:alice",
      sourceWasEnabled: true as const,
    };
    assert.equal(owner.transitionRuleWorkflow(command), true);
    assert.equal(owner.transitionRuleWorkflow(command), false);
    assert.equal(owner.get(discovered.migrationId)?.rules[0]?.workflow?.status, "switching");
    owner.close();

    const raced = new SqliteHomeAutomationMigrationStore({ path });
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TRIGGER migration_switch_cas_loser
      BEFORE UPDATE OF rules_json ON home_automation_migrations
      WHEN OLD.migration_id = '${discovered.migrationId}'
      BEGIN SELECT RAISE(IGNORE); END;`);
    raw.close();
    assert.equal(raced.transitionRuleWorkflow({
      migrationId: discovered.migrationId,
      ruleRef: "ha-rule-1",
      from: "switching",
      to: "verified",
      transitionedAt: createdAt,
      deploymentId: "deployment-cas",
      deploymentTarget: "home-assistant",
      deploymentConfigFingerprint: `sha256:${"2".repeat(64)}`,
    }), false);
    assert.equal(raced.get(discovered.migrationId)?.rules[0]?.workflow?.status, "switching");
    raced.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed-switch restore is an exact failure CAS and persists without deployment identity", async () => {
  const sourceFingerprint = `sha256:${"a".repeat(64)}`;
  const candidateContentHash = `sha256:${"b".repeat(64)}`;
  const restoreInput = (store: InMemoryHomeAutomationMigrationStore | SqliteHomeAutomationMigrationStore): HomeAutomationMigrationRestoreFailedSwitchCommand => {
    const workflow = store.get(discovered.migrationId)?.rules[0]?.workflow;
    if (workflow === undefined || workflow.failureReason === undefined || workflow.switchOperationId === undefined
      || workflow.switchStartedAt === undefined || workflow.approvedProposalRevision === undefined) {
      throw new Error("failed-switch fixture is incomplete");
    }
    return {
      migrationId: discovered.migrationId,
      ruleRef: "ha-rule-1",
      from: "needs_attention" as const,
      expectedApprovedProposalRevision: workflow.approvedProposalRevision,
      expectedFailureReason: workflow.failureReason as "switch_failed" | "switch_unknown",
      expectedSwitchOperationId: workflow.switchOperationId,
      expectedSwitchStartedAt: workflow.switchStartedAt,
      restoredAt: createdAt,
    };
  };
  const prepareFailedSwitch = (store: InMemoryHomeAutomationMigrationStore | SqliteHomeAutomationMigrationStore): void => {
    store.discover({
      ...discovered,
      analysisMode: "trusted_neutral",
      rules: [{ ruleRef: "ha-rule-1", name: "晚间灯光", enabled: true, updatedAt: createdAt, triggerClass: "state", conditionClass: "flat_and", actionClass: "reversible", sourceFingerprint, disposition: "eligible", workflow: { status: "assessed", sourceFingerprint, assessedAt: createdAt } }],
    });
    assert.equal(store.assess({
      migrationId: discovered.migrationId,
      status: "assessed",
      assessedAt: createdAt,
      rules: [{
        ruleRef: "ha-rule-1", name: "晚间灯光", enabled: true, updatedAt: createdAt,
        triggerClass: "state", conditionClass: "flat_and", actionClass: "reversible", sourceFingerprint, disposition: "eligible",
        workflow: { status: "assessed", sourceFingerprint, assessedAt: createdAt },
      }],
    }), true);
    assert.equal(store.transitionRuleWorkflow({
      migrationId: discovered.migrationId, ruleRef: "ha-rule-1", from: "assessed", to: "translated", transitionedAt: createdAt,
      proposalId: "proposal-failed-switch-cas", candidateProposalRevision: 1, candidateContentHash,
    }), true);
    assert.equal(store.transitionRuleWorkflow({
      migrationId: discovered.migrationId, ruleRef: "ha-rule-1", from: "translated", to: "simulated", transitionedAt: createdAt,
      artifactId: "artifact-failed-switch-cas", artifactRevision: 1, artifactContentHash: `sha256:${"c".repeat(64)}`,
      compileResultId: `sha256:${"d".repeat(64)}`, dryRunResultId: `sha256:${"e".repeat(64)}`,
      simulationReceipt: simulationReceipt(sourceFingerprint, candidateContentHash, {
        artifactId: "artifact-failed-switch-cas", artifactRevision: 1, artifactContentHash: `sha256:${"c".repeat(64)}`,
        compileResultId: `sha256:${"d".repeat(64)}`, dryRunResultId: `sha256:${"e".repeat(64)}`,
      }),
    }), true);
    assert.equal(store.transitionRuleWorkflow({
      migrationId: discovered.migrationId, ruleRef: "ha-rule-1", from: "simulated", to: "ready", transitionedAt: createdAt,
      reviewProposalRevision: 2,
    }), true);
    assert.equal(store.transitionRuleWorkflow({
      migrationId: discovered.migrationId, ruleRef: "ha-rule-1", from: "ready", to: "switching", transitionedAt: createdAt,
      approvedProposalRevision: 3, switchOperationId: "f".repeat(32), switchActor: "member:alice", sourceWasEnabled: true,
    }), true);
    assert.equal(store.transitionRuleWorkflow({
      migrationId: discovered.migrationId, ruleRef: "ha-rule-1", from: "switching", to: "needs_attention", transitionedAt: createdAt,
      failureReason: "switch_failed",
    }), true);
  };

  const memory = new InMemoryHomeAutomationMigrationStore();
  prepareFailedSwitch(memory);
  assert.equal(memory.restoreFailedSwitch(restoreInput(memory)), true);
  const memoryWorkflow = memory.get(discovered.migrationId)?.rules[0]?.workflow;
  assert.equal(memoryWorkflow?.status, "restored");
  assert.equal(memoryWorkflow?.failureReason, "switch_failed");
  assert.equal(memoryWorkflow?.switchOperationId, "f".repeat(32));
  assert.equal(memoryWorkflow?.deploymentId, undefined);
  assert.equal(memory.restoreFailedSwitch(restoreInput(memory)), false);

  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-failed-switch-restore-"));
  const path = join(directory, "migrations.sqlite");
  try {
    const sqlite = new SqliteHomeAutomationMigrationStore({ path });
    prepareFailedSwitch(sqlite);
    const staleWriter = new DatabaseSync(path);
    staleWriter.exec(`CREATE TRIGGER migration_failed_switch_restore_cas_loser
      BEFORE UPDATE OF rules_json ON home_automation_migrations
      WHEN OLD.migration_id = '${discovered.migrationId}'
      BEGIN SELECT RAISE(IGNORE); END;`);
    staleWriter.close();
    assert.equal(sqlite.restoreFailedSwitch(restoreInput(sqlite)), false);
    assert.equal(sqlite.get(discovered.migrationId)?.rules[0]?.workflow?.status, "needs_attention");
    sqlite.close();

    const persisted = new SqliteHomeAutomationMigrationStore({ path });
    const raw = persisted.get(discovered.migrationId)?.rules[0]?.workflow;
    assert.equal(raw?.status, "needs_attention");
    const dropTrigger = new DatabaseSync(path);
    dropTrigger.exec("DROP TRIGGER migration_failed_switch_restore_cas_loser");
    dropTrigger.close();
    assert.equal(persisted.restoreFailedSwitch(restoreInput(persisted)), true);
    persisted.close();

    const reopened = new SqliteHomeAutomationMigrationStore({ path });
    const restored = reopened.get(discovered.migrationId)?.rules[0]?.workflow;
    assert.equal(restored?.status, "restored");
    assert.equal(restored?.failureReason, "switch_failed");
    assert.equal(restored?.switchOperationId, "f".repeat(32));
    assert.equal(restored?.deploymentId, undefined);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ready preflight failures are limited to source-stale and unknown-switch reasons", () => {
  const sourceFingerprint = `sha256:${"e".repeat(64)}`;
  const store = new InMemoryHomeAutomationMigrationStore();
  store.discover({ ...discovered, analysisMode: "trusted_neutral" });
  assert.equal(store.assess({
    migrationId: discovered.migrationId,
    status: "assessed",
    assessedAt: createdAt,
    rules: [{
      ruleRef: "ha-rule-1", name: "晚间灯光", enabled: true, updatedAt: createdAt,
      triggerClass: "state", conditionClass: "flat_and", actionClass: "reversible",
      sourceFingerprint, disposition: "eligible", workflow: { status: "assessed", sourceFingerprint, assessedAt: createdAt },
    }],
  }), true);
  assert.equal(store.transitionRuleWorkflow({
    migrationId: discovered.migrationId, ruleRef: "ha-rule-1", from: "assessed", to: "translated", transitionedAt: createdAt,
    proposalId: "proposal-preflight", candidateProposalRevision: 1, candidateContentHash: `sha256:${"f".repeat(64)}`,
  }), true);
  assert.equal(store.transitionRuleWorkflow({
    migrationId: discovered.migrationId, ruleRef: "ha-rule-1", from: "translated", to: "simulated", transitionedAt: createdAt,
    artifactId: "artifact-preflight", artifactRevision: 1, artifactContentHash: `sha256:${"0".repeat(64)}`,
    compileResultId: `sha256:${"1".repeat(64)}`, dryRunResultId: `sha256:${"2".repeat(64)}`,
    simulationReceipt: simulationReceipt(sourceFingerprint, `sha256:${"f".repeat(64)}`, {
      artifactId: "artifact-preflight", artifactRevision: 1, artifactContentHash: `sha256:${"0".repeat(64)}`,
      compileResultId: `sha256:${"1".repeat(64)}`, dryRunResultId: `sha256:${"2".repeat(64)}`,
    }),
  }), true);
  assert.equal(store.transitionRuleWorkflow({
    migrationId: discovered.migrationId, ruleRef: "ha-rule-1", from: "simulated", to: "ready", transitionedAt: createdAt,
    reviewProposalRevision: 2,
  }), true);
  assert.throws(() => store.transitionRuleWorkflow({
    migrationId: discovered.migrationId,
    ruleRef: "ha-rule-1",
    from: "ready",
    to: "needs_attention",
    transitionedAt: createdAt,
    failureReason: "switch_failed",
  }), /workflow transition is invalid/);
  assert.equal(store.get(discovered.migrationId)?.rules[0]?.workflow?.status, "ready");
  assert.equal(store.transitionRuleWorkflow({
    migrationId: discovered.migrationId,
    ruleRef: "ha-rule-1",
    from: "ready",
    to: "needs_attention",
    transitionedAt: createdAt,
    failureReason: "source_stale",
  }), true);
  const failed = store.get(discovered.migrationId)?.rules[0]?.workflow;
  assert.equal(failed?.status, "needs_attention");
  assert.equal(failed?.failureReason, "source_stale");
  assert.equal(failed?.proposalId, "proposal-preflight");
  assert.equal("switchOperationId" in (failed ?? {}), false);
});
