import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HomeAutomationMigrationIdempotencyConflictError,
  HomeAutomationMigrationService,
  type HomeAutomationMigrationAssessment,
  type HomeAutomationMigrationInput,
} from "./home-automation-migration-service.js";
import {
  InMemoryHomeAutomationMigrationStore,
  SqliteHomeAutomationMigrationStore,
} from "./home-automation-migration-store.js";
import { computeHomeAutomationMigrationSimulationDigest } from "./home-automation-migration-simulation.js";

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

function simulationReceiptFor(
  sourceFingerprint: string,
  candidateContentHash: string,
  preparation: {
    readonly artifactId: string;
    readonly artifactRevision: number;
    readonly artifactContentHash: string;
    readonly compileResultId: string;
    readonly dryRunResultId: string;
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

test("eligible rules advance through an independent durable workflow with neutral refs only", async () => {
  const sourceFingerprint = `sha256:${"1".repeat(64)}`;
  const candidateContentHash = `sha256:${"2".repeat(64)}`;
  const compileResultId = `sha256:${"3".repeat(64)}`;
  const dryRunResultId = `sha256:${"4".repeat(64)}`;
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
      }),
    },
  });
  const created = await migration.create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
  const lifecycle = migration as unknown as {
    translateRule(input: unknown): HomeAutomationMigrationAssessment | undefined;
    simulateRule(input: unknown): HomeAutomationMigrationAssessment | undefined;
    readyRule(input: unknown): HomeAutomationMigrationAssessment | undefined;
  };
  assert.equal(created.assessment.rules[0]?.workflow?.status, "assessed");
  const translated = lifecycle.translateRule({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "assessed",
    proposalId: "proposal-neutral-1",
    candidateProposalRevision: 1,
    candidateContentHash,
  });
  assert.equal(translated?.rules[0]?.workflow?.status, "translated");
  assert.equal(translated?.rules[0]?.workflow?.sourceFingerprint, sourceFingerprint);
  assert.equal("bridgeId" in (translated?.rules[0]?.workflow ?? {}), false);
  assert.equal("nativeId" in (translated?.rules[0]?.workflow ?? {}), false);
  assert.equal("provider" in (translated?.rules[0]?.workflow ?? {}), false);

  const simulated = lifecycle.simulateRule({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "translated",
    artifactId: "artifact-neutral-1",
    artifactRevision: 2,
    artifactContentHash: `sha256:${"5".repeat(64)}`,
    compileResultId,
    dryRunResultId,
    simulationReceipt: simulationReceiptFor(sourceFingerprint, candidateContentHash, {
      artifactId: "artifact-neutral-1", artifactRevision: 2, artifactContentHash: `sha256:${"5".repeat(64)}`,
      compileResultId, dryRunResultId,
    }),
  });
  assert.equal(simulated?.rules[0]?.workflow?.status, "simulated");
  assert.equal(simulated?.rules[0]?.workflow?.compileResultId, compileResultId);
  assert.throws(() => lifecycle.readyRule({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "simulated",
    reviewProposalRevision: 3,
  }), /immediately follow/);
  const ready = lifecycle.readyRule({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "simulated",
    reviewProposalRevision: 2,
  });
  assert.equal(ready?.rules[0]?.workflow?.status, "ready");
  assert.equal(ready?.rules[0]?.workflow?.reviewProposalRevision, 2);
  assert.equal(ready?.status, "assessed");
});

test("an approved ready rule records a durable switch, verification, rollback, and restore chain", async () => {
  const service = new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "b".repeat(32),
    idempotencyKeyFactory: () => "c".repeat(32),
    translator: {
      assess: async (request) => ({
        ruleRef: request.ruleRef,
        trigger: { kind: "state" },
        condition: { kind: "flat_and" },
        action: { kind: "reversible" },
        sourceFingerprint: eligibleFingerprint,
      }),
    },
  });
  const created = await service.create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
  service.translateRule({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "assessed",
    proposalId: "proposal-switch",
    candidateProposalRevision: 1,
    candidateContentHash: `sha256:${"1".repeat(64)}`,
  });
  service.simulateRule({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "translated",
    artifactId: "artifact-switch",
    artifactRevision: 1,
    artifactContentHash: `sha256:${"2".repeat(64)}`,
    compileResultId: `sha256:${"3".repeat(64)}`,
    dryRunResultId: `sha256:${"4".repeat(64)}`,
    simulationReceipt: simulationReceiptFor(eligibleFingerprint, `sha256:${"1".repeat(64)}`, {
      artifactId: "artifact-switch", artifactRevision: 1, artifactContentHash: `sha256:${"2".repeat(64)}`,
      compileResultId: `sha256:${"3".repeat(64)}`, dryRunResultId: `sha256:${"4".repeat(64)}`,
    }),
  });
  service.readyRule({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "simulated",
    reviewProposalRevision: 2,
  });

  const switching = service.startRuleSwitch({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "ready",
    approvedProposalRevision: 3,
    switchOperationId: "a".repeat(32),
    switchActor: "member:alice",
    sourceWasEnabled: true,
  });
  assert.equal(switching?.rules[0]?.workflow?.status, "switching");
  assert.equal(switching?.rules[0]?.workflow?.proposalId, "proposal-switch");
  assert.equal(switching?.rules[0]?.workflow?.approvedProposalRevision, 3);

  const verified = service.verifyRuleSwitch({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "switching",
    deploymentId: "deployment-1",
    deploymentTarget: "home-assistant",
    deploymentConfigFingerprint: `sha256:${"5".repeat(64)}`,
  });
  assert.equal(verified?.rules[0]?.workflow?.status, "verified");
  assert.equal(verified?.rules[0]?.workflow?.switchOperationId, "a".repeat(32));

  const rollingBack = service.startRuleRollback({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "verified",
    rollbackOperationId: "b".repeat(32),
    rollbackActor: "member:alice",
  });
  assert.equal(rollingBack?.rules[0]?.workflow?.status, "rolling_back");

  const restored = service.restoreRule({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "rolling_back",
  });
  assert.equal(restored?.rules[0]?.workflow?.status, "restored");
  assert.equal(restored?.rules[0]?.workflow?.deploymentTarget, "home-assistant");
});

test("failed switch and rollback operations can resume with fresh operation receipts", async () => {
  const service = new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "d".repeat(32),
    idempotencyKeyFactory: () => "e".repeat(32),
    translator: {
      assess: async (request) => ({
        ruleRef: request.ruleRef,
        trigger: { kind: "state" },
        condition: { kind: "flat_and" },
        action: { kind: "reversible" },
        sourceFingerprint: eligibleFingerprint,
      }),
    },
  });
  const created = await service.create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
  service.translateRule({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "assessed", proposalId: "proposal-resume", candidateProposalRevision: 1, candidateContentHash: `sha256:${"6".repeat(64)}` });
  service.simulateRule({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "translated", artifactId: "artifact-resume", artifactRevision: 1, artifactContentHash: `sha256:${"7".repeat(64)}`, compileResultId: `sha256:${"8".repeat(64)}`, dryRunResultId: `sha256:${"9".repeat(64)}`, simulationReceipt: simulationReceiptFor(eligibleFingerprint, `sha256:${"6".repeat(64)}`, { artifactId: "artifact-resume", artifactRevision: 1, artifactContentHash: `sha256:${"7".repeat(64)}`, compileResultId: `sha256:${"8".repeat(64)}`, dryRunResultId: `sha256:${"9".repeat(64)}` }) });
  service.readyRule({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "simulated", reviewProposalRevision: 2 });
  service.startRuleSwitch({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "ready", approvedProposalRevision: 3, switchOperationId: "1".repeat(32), switchActor: "member:alice", sourceWasEnabled: true });
  const failedSwitch = service.failRuleWorkflow({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "switching", reason: "switch_failed" });
  assert.equal(failedSwitch?.rules[0]?.workflow?.status, "needs_attention");
  assert.equal(service.resumeRuleSwitch({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "needs_attention", switchOperationId: "1".repeat(32), switchActor: "member:alice" }), undefined);

  const resumedSwitch = service.resumeRuleSwitch({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "needs_attention",
    switchOperationId: "2".repeat(32),
    switchActor: "member:bob",
  });
  assert.equal(resumedSwitch?.rules[0]?.workflow?.status, "switching");
  assert.equal(resumedSwitch?.rules[0]?.workflow?.switchOperationId, "2".repeat(32));
  assert.equal(resumedSwitch?.rules[0]?.workflow?.approvedProposalRevision, 3);
  assert.equal(resumedSwitch?.rules[0]?.workflow?.sourceWasEnabled, true);

  service.verifyRuleSwitch({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "switching", deploymentId: "deployment-resume", deploymentTarget: "home-assistant", deploymentConfigFingerprint: `sha256:${"a".repeat(64)}` });
  const failedVerification = service.failRuleWorkflow({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "verified", reason: "verification_failed" });
  assert.equal(failedVerification?.rules[0]?.workflow?.status, "needs_attention");
  const resumedRollback = service.resumeRuleRollback({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "needs_attention", rollbackOperationId: "3".repeat(32), rollbackActor: "member:bob" });
  assert.equal(resumedRollback?.rules[0]?.workflow?.status, "rolling_back");
  assert.equal(resumedRollback?.rules[0]?.workflow?.deploymentId, "deployment-resume");
  assert.equal(resumedRollback?.rules[0]?.workflow?.rollbackOperationId, "3".repeat(32));

  const failedRollback = service.failRuleWorkflow({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "rolling_back", reason: "rollback_unknown" });
  assert.equal(failedRollback?.rules[0]?.workflow?.status, "needs_attention");
  assert.equal(service.resumeRuleRollback({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "needs_attention", rollbackOperationId: "3".repeat(32), rollbackActor: "member:bob" }), undefined);
  const resumedAgain = service.resumeRuleRollback({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "needs_attention", rollbackOperationId: "4".repeat(32), rollbackActor: "member:carol" });
  assert.equal(resumedAgain?.rules[0]?.workflow?.status, "rolling_back");
  assert.equal(resumedAgain?.rules[0]?.workflow?.rollbackOperationId, "4".repeat(32));

  assert.equal(service.resumeRuleRollback({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "needs_attention",
    rollbackOperationId: "5".repeat(32),
    rollbackActor: "member:carol",
    nativeBody: "blocked",
  } as never), undefined);
});

test("restores a failed switch only with the exact failure receipt and keeps switch evidence", async () => {
  const service = new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "9".repeat(32),
    idempotencyKeyFactory: () => "a".repeat(32),
    translator: {
      assess: async (request) => ({
        ruleRef: request.ruleRef,
        trigger: { kind: "state" },
        condition: { kind: "flat_and" },
        action: { kind: "reversible" },
        sourceFingerprint: eligibleFingerprint,
      }),
    },
  });
  const created = await service.create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
  service.translateRule({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "assessed", proposalId: "proposal-failed-switch", candidateProposalRevision: 1, candidateContentHash: `sha256:${"1".repeat(64)}` });
  service.simulateRule({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "translated", artifactId: "artifact-failed-switch", artifactRevision: 1, artifactContentHash: `sha256:${"2".repeat(64)}`, compileResultId: `sha256:${"3".repeat(64)}`, dryRunResultId: `sha256:${"4".repeat(64)}`, simulationReceipt: simulationReceiptFor(eligibleFingerprint, `sha256:${"1".repeat(64)}`, { artifactId: "artifact-failed-switch", artifactRevision: 1, artifactContentHash: `sha256:${"2".repeat(64)}`, compileResultId: `sha256:${"3".repeat(64)}`, dryRunResultId: `sha256:${"4".repeat(64)}` }) });
  service.readyRule({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "simulated", reviewProposalRevision: 2 });
  service.startRuleSwitch({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "ready", approvedProposalRevision: 3, switchOperationId: "5".repeat(32), switchActor: "member:alice", sourceWasEnabled: true });
  const failed = service.failRuleWorkflow({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "switching", reason: "switch_failed" });
  const failedWorkflow = failed?.rules[0]?.workflow;
  assert.equal(failedWorkflow?.status, "needs_attention");

  const staleReceipt = {
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "needs_attention" as const,
    expectedApprovedProposalRevision: failedWorkflow?.approvedProposalRevision,
    expectedFailureReason: failedWorkflow?.failureReason,
    expectedSwitchOperationId: failedWorkflow?.switchOperationId,
    expectedSwitchStartedAt: failedWorkflow?.switchStartedAt,
  };
  assert.equal(service.resumeRuleSwitch({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "needs_attention",
    switchOperationId: "6".repeat(32),
    switchActor: "member:bob",
  })?.rules[0]?.workflow?.status, "switching");
  assert.equal(service.failRuleWorkflow({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "switching",
    reason: "switch_failed",
  })?.rules[0]?.workflow?.status, "needs_attention");
  assert.equal(service.restoreFailedSwitch(staleReceipt), undefined);
  const currentFailed = service.get(created.assessment.migrationId)?.rules[0]?.workflow;
  assert.equal(currentFailed?.switchOperationId, "6".repeat(32));
  const restored = service.restoreFailedSwitch({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "needs_attention",
    expectedApprovedProposalRevision: currentFailed!.approvedProposalRevision!,
    expectedFailureReason: currentFailed!.failureReason as "switch_failed" | "switch_unknown",
    expectedSwitchOperationId: currentFailed!.switchOperationId!,
    expectedSwitchStartedAt: currentFailed!.switchStartedAt!,
  });
  const restoredWorkflow = restored?.rules[0]?.workflow;
  assert.equal(restoredWorkflow?.status, "restored");
  assert.equal(restoredWorkflow?.failureReason, "switch_failed");
  assert.equal(restoredWorkflow?.switchOperationId, "6".repeat(32));
  assert.equal(restoredWorkflow?.switchActor, "member:bob");
  assert.equal(restoredWorkflow?.deploymentId, undefined);
  assert.equal(restoredWorkflow?.deploymentTarget, undefined);
  assert.equal(restoredWorkflow?.deploymentConfigFingerprint, undefined);
  assert.equal(typeof restoredWorkflow?.restoredAt, "string");

  assert.equal(service.restoreFailedSwitch({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "needs_attention",
    expectedApprovedProposalRevision: currentFailed!.approvedProposalRevision!,
    expectedFailureReason: currentFailed!.failureReason as "switch_failed" | "switch_unknown",
    expectedSwitchOperationId: currentFailed!.switchOperationId!,
    expectedSwitchStartedAt: currentFailed!.switchStartedAt!,
  }), undefined);
});

test("source-stale preflight and unrelated failure reasons cannot resume switching", async () => {
  const service = new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "f".repeat(32),
    idempotencyKeyFactory: () => "0".repeat(32),
    translator: { assess: async (request) => ({ ruleRef: request.ruleRef, trigger: { kind: "state" }, condition: { kind: "flat_and" }, action: { kind: "reversible" }, sourceFingerprint: eligibleFingerprint }) },
  });
  const created = await service.create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
  service.translateRule({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "assessed", proposalId: "proposal-preflight-resume", candidateProposalRevision: 1, candidateContentHash: `sha256:${"a".repeat(64)}` });
  service.simulateRule({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "translated", artifactId: "artifact-preflight-resume", artifactRevision: 1, artifactContentHash: `sha256:${"b".repeat(64)}`, compileResultId: `sha256:${"c".repeat(64)}`, dryRunResultId: `sha256:${"d".repeat(64)}`, simulationReceipt: simulationReceiptFor(eligibleFingerprint, `sha256:${"a".repeat(64)}`, { artifactId: "artifact-preflight-resume", artifactRevision: 1, artifactContentHash: `sha256:${"b".repeat(64)}`, compileResultId: `sha256:${"c".repeat(64)}`, dryRunResultId: `sha256:${"d".repeat(64)}` }) });
  service.readyRule({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "simulated", reviewProposalRevision: 2 });
  service.failRuleWorkflow({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "ready", reason: "source_stale" });
  assert.equal(service.resumeRuleSwitch({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "needs_attention", switchOperationId: "6".repeat(32), switchActor: "member:alice" }), undefined);
});

test("switch recovery receipts survive SQLite restart and duplicate resumes do not mutate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-resume-restart-"));
  const path = join(directory, "migrations.sqlite");
  try {
    const firstStore = new SqliteHomeAutomationMigrationStore({ path });
    const first = new HomeAutomationMigrationService({
      store: firstStore,
      clock: () => now,
      migrationIdFactory: () => "1".repeat(32),
      idempotencyKeyFactory: () => "2".repeat(32),
      translator: { assess: async (request) => ({ ruleRef: request.ruleRef, trigger: { kind: "state" }, condition: { kind: "flat_and" }, action: { kind: "reversible" }, sourceFingerprint: eligibleFingerprint }) },
    });
    const created = await first.create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
    first.translateRule({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "assessed", proposalId: "proposal-sqlite-resume", candidateProposalRevision: 1, candidateContentHash: `sha256:${"3".repeat(64)}` });
    first.simulateRule({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "translated", artifactId: "artifact-sqlite-resume", artifactRevision: 1, artifactContentHash: `sha256:${"4".repeat(64)}`, compileResultId: `sha256:${"5".repeat(64)}`, dryRunResultId: `sha256:${"6".repeat(64)}`, simulationReceipt: simulationReceiptFor(eligibleFingerprint, `sha256:${"3".repeat(64)}`, { artifactId: "artifact-sqlite-resume", artifactRevision: 1, artifactContentHash: `sha256:${"4".repeat(64)}`, compileResultId: `sha256:${"5".repeat(64)}`, dryRunResultId: `sha256:${"6".repeat(64)}` }) });
    first.readyRule({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "simulated", reviewProposalRevision: 2 });
    first.startRuleSwitch({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "ready", approvedProposalRevision: 3, switchOperationId: "7".repeat(32), switchActor: "member:alice", sourceWasEnabled: true });
    first.failRuleWorkflow({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "switching", reason: "switch_unknown" });
    first.close();

    const secondStore = new SqliteHomeAutomationMigrationStore({ path });
    const second = new HomeAutomationMigrationService({ store: secondStore, clock: () => now });
    const resumed = second.resumeRuleSwitch({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "needs_attention", switchOperationId: "8".repeat(32), switchActor: "member:bob" });
    assert.equal(resumed?.rules[0]?.workflow?.status, "switching");
    assert.equal(resumed?.rules[0]?.workflow?.switchOperationId, "8".repeat(32));
    assert.equal(resumed?.rules[0]?.workflow?.approvedProposalRevision, 3);
    assert.equal(second.resumeRuleSwitch({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "needs_attention", switchOperationId: "9".repeat(32), switchActor: "member:carol" }), undefined);
    assert.equal(second.get(created.assessment.migrationId)?.rules[0]?.workflow?.status, "switching");

    second.verifyRuleSwitch({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "switching", deploymentId: "deployment-sqlite-resume", deploymentTarget: "home-assistant", deploymentConfigFingerprint: `sha256:${"a".repeat(64)}` });
    second.failRuleWorkflow({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "verified", reason: "verification_failed" });
    const rollback = second.resumeRuleRollback({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "needs_attention", rollbackOperationId: "b".repeat(32), rollbackActor: "member:bob" });
    assert.equal(rollback?.rules[0]?.workflow?.status, "rolling_back");
    assert.equal(rollback?.rules[0]?.workflow?.deploymentId, "deployment-sqlite-resume");
    second.close();

    const third = new SqliteHomeAutomationMigrationStore({ path });
    assert.equal(third.get(created.assessment.migrationId)?.rules[0]?.workflow?.status, "rolling_back");
    assert.equal(third.get(created.assessment.migrationId)?.rules[0]?.workflow?.rollbackOperationId, "b".repeat(32));
    third.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow failure keeps a fixed reason and metadata or unsupported rules cannot advance", async () => {
  const failedService = new HomeAutomationMigrationService({
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
        sourceFingerprint: `sha256:${"6".repeat(64)}`,
      }),
    },
  });
  const failed = await failedService.create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
  const failedLifecycle = failedService as unknown as {
    translateRule(input: unknown): HomeAutomationMigrationAssessment | undefined;
    failRuleWorkflow(input: unknown): HomeAutomationMigrationAssessment | undefined;
  };
  const translated = failedLifecycle.translateRule({
    migrationId: failed.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "assessed",
    proposalId: "proposal-neutral-2",
    candidateProposalRevision: 1,
    candidateContentHash: `sha256:${"7".repeat(64)}`,
  });
  const failedWorkflow = failedLifecycle.failRuleWorkflow({
    migrationId: failed.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "translated",
    reason: "compile_failed",
  });
  assert.equal(translated?.rules[0]?.workflow?.status, "translated");
  assert.equal(failedWorkflow?.rules[0]?.workflow?.status, "needs_attention");
  assert.equal(failedWorkflow?.rules[0]?.workflow?.failureReason, "compile_failed");
  assert.equal(failedWorkflow?.rules[0]?.workflow?.candidateContentHash, `sha256:${"7".repeat(64)}`);
  const retried = failedService.retryRuleWorkflow({
    migrationId: failed.assessment.migrationId,
    ruleRef: "ha-rule-1",
    proposalId: "proposal-neutral-retry",
    candidateProposalRevision: 2,
    candidateContentHash: `sha256:${"8".repeat(64)}`,
  });
  assert.equal(retried?.rules[0]?.workflow?.status, "translated");
  assert.equal(retried?.rules[0]?.workflow?.failureReason, undefined);

  const simulated = failedService.simulateRule({
    migrationId: failed.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "translated",
    artifactId: "artifact-failure-retry",
    artifactRevision: 1,
    artifactContentHash: `sha256:${"9".repeat(64)}`,
    compileResultId: `sha256:${"a".repeat(64)}`,
    dryRunResultId: `sha256:${"b".repeat(64)}`,
    simulationReceipt: simulationReceiptFor(`sha256:${"6".repeat(64)}`, `sha256:${"8".repeat(64)}`, {
      artifactId: "artifact-failure-retry", artifactRevision: 1, artifactContentHash: `sha256:${"9".repeat(64)}`,
      compileResultId: `sha256:${"a".repeat(64)}`, dryRunResultId: `sha256:${"b".repeat(64)}`,
    }),
  });
  const simulationFailure = failedService.failRuleWorkflow({
    migrationId: failed.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "simulated",
    reason: "simulation_failed",
  });
  assert.equal(simulated?.rules[0]?.workflow?.status, "simulated");
  assert.equal(simulationFailure?.rules[0]?.workflow?.status, "needs_attention");
  assert.equal(simulationFailure?.rules[0]?.workflow?.artifactId, "artifact-failure-retry");
  const simulationRetry = failedService.retryRuleWorkflow({
    migrationId: failed.assessment.migrationId,
    ruleRef: "ha-rule-1",
    artifactId: "artifact-failure-retry-2",
    artifactRevision: 2,
    artifactContentHash: `sha256:${"c".repeat(64)}`,
    compileResultId: `sha256:${"d".repeat(64)}`,
    dryRunResultId: `sha256:${"e".repeat(64)}`,
    simulationReceipt: simulationReceiptFor(`sha256:${"6".repeat(64)}`, `sha256:${"8".repeat(64)}`, {
      artifactId: "artifact-failure-retry-2", artifactRevision: 2, artifactContentHash: `sha256:${"c".repeat(64)}`,
      compileResultId: `sha256:${"d".repeat(64)}`, dryRunResultId: `sha256:${"e".repeat(64)}`,
    }),
  });
  assert.equal(simulationRetry?.rules[0]?.workflow?.status, "simulated");
  assert.equal(simulationRetry?.rules[0]?.workflow?.artifactRevision, 2);
  assert.equal(failedService.failRuleWorkflow({
    migrationId: failed.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "simulated",
    reason: "simulation_failed",
    nativeBody: "rejected",
  } as never), undefined);
  assert.equal(failedService.retryRuleWorkflow(new Proxy({
    migrationId: failed.assessment.migrationId,
    ruleRef: "ha-rule-1",
  }, { get() { throw new Error("provider getter"); } }) as never), undefined);
  assert.equal(failedService.translateRule({
    migrationId: failed.assessment.migrationId,
    ruleRef: "missing-rule",
    from: "assessed",
    proposalId: "proposal-neutral-missing",
    candidateProposalRevision: 1,
    candidateContentHash: `sha256:${"f".repeat(64)}`,
  }), undefined);

  const metadata = new HomeAutomationMigrationService({ store: new InMemoryHomeAutomationMigrationStore(), clock: () => now });
  const metadataAssessment = await metadata.create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
  const metadataLifecycle = metadata as unknown as { translateRule(input: unknown): HomeAutomationMigrationAssessment | undefined };
  assert.equal(metadataLifecycle.translateRule({
    migrationId: metadataAssessment.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "assessed",
    proposalId: "proposal-neutral-3",
    candidateProposalRevision: 1,
    candidateContentHash: `sha256:${"8".repeat(64)}`,
  }), undefined);

  const unsupportedService = new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "9".repeat(32),
    idempotencyKeyFactory: () => "a".repeat(32),
    translator: {
      assess: async (request) => ({
        ruleRef: request.ruleRef,
        trigger: { kind: "state" },
        condition: { kind: "unsupported" },
        action: { kind: "reversible" },
      }),
    },
  });
  const unsupported = await unsupportedService.create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
  const unsupportedLifecycle = unsupportedService as unknown as { translateRule(input: unknown): HomeAutomationMigrationAssessment | undefined };
  assert.equal(unsupportedLifecycle.translateRule({
    migrationId: unsupported.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "assessed",
    proposalId: "proposal-neutral-4",
    candidateProposalRevision: 1,
    candidateContentHash: `sha256:${"9".repeat(64)}`,
  }), undefined);
});

test("each eligible rule keeps an independent workflow across a SQLite restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-automation-migration-workflow-"));
  const path = join(directory, "migrations.sqlite");
  const sourceFingerprint = `sha256:${"a".repeat(64)}`;
  try {
    const firstStore = new SqliteHomeAutomationMigrationStore({ path });
    const first = new HomeAutomationMigrationService({
      store: firstStore,
      clock: () => now,
      migrationIdFactory: () => "1".repeat(32),
      idempotencyKeyFactory: () => "2".repeat(32),
      translator: {
        assess: async (request) => ({
          ruleRef: request.ruleRef,
          trigger: { kind: "state" },
          condition: { kind: "flat_and" },
          action: { kind: "reversible" },
          sourceFingerprint,
        }),
      },
    });
    const created = await first.create({ catalog: catalog() });
    const translated = first.translateRule({
      migrationId: created.assessment.migrationId,
      ruleRef: "ha-rule-1",
      from: "assessed",
      proposalId: "proposal-restart-safe",
      candidateProposalRevision: 3,
      candidateContentHash: `sha256:${"b".repeat(64)}`,
    });
    assert.equal(translated?.rules[0]?.workflow?.status, "translated");
    assert.equal(translated?.rules[1]?.workflow?.status, "assessed");
    first.close();

    const secondStore = new SqliteHomeAutomationMigrationStore({ path });
    const second = new HomeAutomationMigrationService({ store: secondStore, clock: () => now });
    const restarted = second.get(created.assessment.migrationId);
    assert.equal(restarted?.rules[0]?.workflow?.status, "translated");
    assert.equal(restarted?.rules[1]?.workflow?.status, "assessed");
    const simulated = second.simulateRule({
      migrationId: created.assessment.migrationId,
      ruleRef: "ha-rule-1",
      from: "translated",
      artifactId: "artifact-restart-safe",
      artifactRevision: 4,
      artifactContentHash: `sha256:${"c".repeat(64)}`,
      compileResultId: `sha256:${"d".repeat(64)}`,
      dryRunResultId: `sha256:${"e".repeat(64)}`,
      simulationReceipt: simulationReceiptFor(sourceFingerprint, `sha256:${"b".repeat(64)}`, {
        artifactId: "artifact-restart-safe", artifactRevision: 4, artifactContentHash: `sha256:${"c".repeat(64)}`,
        compileResultId: `sha256:${"d".repeat(64)}`, dryRunResultId: `sha256:${"e".repeat(64)}`,
      }),
    });
    const ready = second.readyRule({ migrationId: created.assessment.migrationId, ruleRef: "ha-rule-1", from: "simulated", reviewProposalRevision: 4 });
    assert.equal(simulated?.rules[0]?.workflow?.status, "simulated");
    assert.equal(ready?.rules[0]?.workflow?.status, "ready");
    assert.equal(ready?.rules[0]?.workflow?.reviewProposalRevision, 4);
    assert.equal(ready?.status, "assessed");
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("assessment retry recovers aggregate needs_attention before workflow transitions", async () => {
  let secondAvailable = false;
  const sourceFingerprint = `sha256:${"b".repeat(64)}`;
  const service = new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "3".repeat(32),
    idempotencyKeyFactory: () => "4".repeat(32),
    translator: {
      assess: async (request) => {
        if (request.ruleRef === "ha-rule-2" && !secondAvailable) throw new Error("temporarily unavailable");
        return {
          ruleRef: request.ruleRef,
          trigger: { kind: "state" as const },
          condition: { kind: "flat_and" as const },
          action: { kind: "reversible" as const },
          sourceFingerprint,
        };
      },
    },
  });
  const created = await service.create({ catalog: catalog() });
  assert.equal(created.assessment.status, "needs_attention");
  assert.equal(service.translateRule({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "assessed",
    proposalId: "proposal-before-retry",
    candidateProposalRevision: 1,
    candidateContentHash: `sha256:${"c".repeat(64)}`,
  }), undefined);
  secondAvailable = true;
  const retried = await service.retry({ migrationId: created.assessment.migrationId });
  assert.equal(retried?.status, "assessed");
  assert.equal(retried?.rules[0]?.workflow?.status, "assessed");
  assert.equal(retried?.rules[1]?.workflow?.status, "assessed");
  const translated = service.translateRule({
    migrationId: created.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "assessed",
    proposalId: "proposal-after-retry",
    candidateProposalRevision: 1,
    candidateContentHash: `sha256:${"c".repeat(64)}`,
  });
  assert.equal(translated?.rules[0]?.workflow?.status, "translated");
});

test("workflow transitions stay closed while the aggregate assessment is not assessed", async () => {
  const needsService = new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "5".repeat(32),
    idempotencyKeyFactory: () => "6".repeat(32),
    translator: {
      assess: async (request) => request.ruleRef === "ha-rule-1"
        ? { ruleRef: request.ruleRef, trigger: { kind: "state" }, condition: { kind: "flat_and" }, action: { kind: "reversible" }, sourceFingerprint: `sha256:${"d".repeat(64)}` }
        : undefined,
    },
  });
  const needs = await needsService.create({ catalog: catalog() });
  assert.equal(needs.assessment.status, "needs_attention");
  assert.equal(needsService.translateRule({
    migrationId: needs.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "assessed",
    proposalId: "proposal-needs-aggregate",
    candidateProposalRevision: 1,
    candidateContentHash: `sha256:${"e".repeat(64)}`,
  }), undefined);

  const closedService = new HomeAutomationMigrationService({
    store: new InMemoryHomeAutomationMigrationStore(),
    clock: () => now,
    migrationIdFactory: () => "7".repeat(32),
    idempotencyKeyFactory: () => "8".repeat(32),
    translator: {
      assess: async (request) => ({
        ruleRef: request.ruleRef,
        trigger: { kind: "state" },
        condition: { kind: "flat_and" },
        action: { kind: "reversible" },
        sourceFingerprint: `sha256:${"f".repeat(64)}`,
      }),
    },
  });
  const closed = await closedService.create({ catalog: catalog({ rules: [{ ruleRef: "ha-rule-1" }] }) });
  assert.equal(closedService.closeAssessment({ migrationId: closed.assessment.migrationId, reason: "household_closed" })?.status, "closed");
  assert.equal(closedService.translateRule({
    migrationId: closed.assessment.migrationId,
    ruleRef: "ha-rule-1",
    from: "assessed",
    proposalId: "proposal-closed",
    candidateProposalRevision: 1,
    candidateContentHash: `sha256:${"1".repeat(64)}`,
  }), undefined);
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
