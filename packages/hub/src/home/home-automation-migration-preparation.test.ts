import assert from "node:assert/strict";
import test from "node:test";

import type { ForeignRuleArtifactCandidate } from "../artifact/foreign-rule-artifact-candidate.js";
import type { ProposalCreationResult } from "./proposal-store.js";
import type { HomeAutomationMigrationAssessment } from "./home-automation-migration.js";
import {
  HomeAutomationMigrationPreparationService,
  type HomeAutomationMigrationPreparationCandidateSource,
  type HomeAutomationMigrationPreparationProposalPort,
  type HomeAutomationMigrationPreparationWorldPort,
} from "./home-automation-migration-preparation.js";

const SOURCE = {
  bridgeId: "bridge-ha",
  epochId: "epoch-1",
  lastSeq: 12,
} as const;

const FINGERPRINT = `sha256:${"a".repeat(64)}`;

const CONTENT = {
  trigger: { kind: "capability_changed" as const, source: { hwCapabilityId: "hwc-living-room" } },
  conditions: [],
  actions: [{ kind: "set_boolean" as const, target: { hwCapabilityId: "hwc-living-room" }, value: true }],
  rollback: { kind: "restore_previous_state" as const, target: { hwCapabilityId: "hwc-living-room" }, maxAgeSeconds: 900 },
  postconditions: [{
    kind: "capability_value" as const,
    source: { hwCapabilityId: "hwc-living-room" },
    operator: "equals" as const,
    value: true,
    withinSeconds: 60,
  }],
};

const assessment: HomeAutomationMigrationAssessment = {
  migrationId: "migration-1",
  idempotencyKey: `sha256:${"b".repeat(64)}`,
  inputDigest: `sha256:${"c".repeat(64)}`,
  sourceBridgeId: SOURCE.bridgeId,
  sourceEpochId: SOURCE.epochId,
  sourceLastSeq: SOURCE.lastSeq,
  analysisMode: "trusted_neutral",
  rules: [{
    ruleRef: "rule-1",
    name: "Living room light",
    triggerClass: "state",
    conditionClass: "flat_and",
    actionClass: "reversible",
    sourceFingerprint: FINGERPRINT,
    disposition: "eligible",
  }],
  status: "assessed",
  createdAt: "2026-08-24T00:00:00.000Z",
  assessedAt: "2026-08-24T00:00:01.000Z",
};

const candidate: ForeignRuleArtifactCandidate = {
  status: "candidate",
  sourceFingerprint: FINGERPRINT,
  ruleRef: "rule-1",
  title: "Living room light",
  content: CONTENT,
};

class StubCandidateSource implements HomeAutomationMigrationPreparationCandidateSource {
  assessment: HomeAutomationMigrationAssessment | undefined = assessment;
  candidate: unknown = candidate;
  getCalls: string[] = [];
  createCalls: Array<{ migrationId: string; ruleRef: string; signal?: AbortSignal }> = [];

  get(migrationId: string): HomeAutomationMigrationAssessment | undefined {
    this.getCalls.push(migrationId);
    return this.assessment;
  }

  async createArtifactCandidate(
    input: { readonly migrationId: string; readonly ruleRef: string },
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<unknown> {
    this.createCalls.push({ ...input, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    return this.candidate;
  }
}

class StubWorld implements HomeAutomationMigrationPreparationWorldPort {
  snapshotCalls = 0;

  snapshot() {
    this.snapshotCalls += 1;
    return {
      devices: [
        {
          hwId: "hw-device-living-room",
          validity: "valid" as const,
          capabilities: [{ hwCapabilityId: "hwc-living-room" }],
        },
        {
          hwId: "hw-device-unrelated-stale",
          validity: "stale" as const,
          capabilities: [{ hwCapabilityId: "hwc-unrelated" }],
        },
      ],
    };
  }
}

class StubProposals implements HomeAutomationMigrationPreparationProposalPort {
  inputs: unknown[] = [];
  result: ProposalCreationResult = {
    kind: "created",
    proposal: { id: "proposal-1" } as never,
  };
  applyCalls = 0;
  approveCalls = 0;
  deployCalls = 0;

  async createMigrationDraftGoverned(input: never): Promise<ProposalCreationResult> {
    this.inputs.push(input);
    return this.result;
  }
}

function setup() {
  const source = new StubCandidateSource();
  const world = new StubWorld();
  const proposals = new StubProposals();
  const service = new HomeAutomationMigrationPreparationService({ source, world, proposals });
  return { source, world, proposals, service };
}

test("creates a migration-lane review draft from one exact eligible migration candidate", async () => {
  const { source, world, proposals, service } = setup();
  const controller = new AbortController();

  const result = await service.createReviewDraft({
    migrationId: assessment.migrationId,
    ruleRef: "rule-1",
  }, { signal: controller.signal });

  assert.equal(result.outcome, "created");
  assert.deepEqual(source.getCalls, [assessment.migrationId]);
  assert.deepEqual(source.createCalls, [{
    migrationId: assessment.migrationId,
    ruleRef: "rule-1",
    signal: controller.signal,
  }]);
  assert.equal(world.snapshotCalls, 1);
  assert.equal(proposals.inputs.length, 1);
  const input = proposals.inputs[0] as Record<string, unknown>;
  assert.equal(input.kind, "automation-draft");
  assert.equal(input.title, candidate.title);
  assert.deepEqual(input.selectedHwIds, ["hw-device-living-room"]);
  assert.deepEqual(input.artifactCandidate, { schemaVersion: "1", content: CONTENT });
  assert.equal(Object.hasOwn(input, "provenance"), false);
  assert.equal(typeof input.idempotencyKey, "string");
  assert.equal(typeof input.dedupKey, "string");
  assert.notEqual(input.idempotencyKey, "");
  assert.notEqual(input.dedupKey, "");
  assert.equal(JSON.stringify(input).includes(FINGERPRINT), false);
  assert.equal(proposals.applyCalls, 0);
  assert.equal(proposals.approveCalls, 0);
  assert.equal(proposals.deployCalls, 0);
});

test("reuses deterministic proposal identity for one source cut and changes it for a new cut or fingerprint", async () => {
  const { source, proposals, service } = setup();

  await service.createReviewDraft({ migrationId: assessment.migrationId, ruleRef: "rule-1" });
  const first = proposals.inputs[0] as Record<string, unknown>;
  await service.createReviewDraft({ migrationId: assessment.migrationId, ruleRef: "rule-1" });
  const replay = proposals.inputs[1] as Record<string, unknown>;
  assert.equal(replay.idempotencyKey, first.idempotencyKey);
  assert.equal(replay.dedupKey, first.dedupKey);

  source.assessment = { ...assessment, sourceLastSeq: assessment.sourceLastSeq + 1 };
  await service.createReviewDraft({ migrationId: assessment.migrationId, ruleRef: "rule-1" });
  const changedCut = proposals.inputs[2] as Record<string, unknown>;
  assert.notEqual(changedCut.idempotencyKey, first.idempotencyKey);
  assert.notEqual(changedCut.dedupKey, first.dedupKey);

  source.assessment = {
    ...assessment,
    rules: [{ ...assessment.rules[0]!, sourceFingerprint: `sha256:${"d".repeat(64)}` }],
  };
  source.candidate = { ...candidate, sourceFingerprint: `sha256:${"d".repeat(64)}` };
  await service.createReviewDraft({ migrationId: assessment.migrationId, ruleRef: "rule-1" });
  const changed = proposals.inputs[3] as Record<string, unknown>;
  assert.notEqual(changed.idempotencyKey, first.idempotencyKey);
  assert.notEqual(changed.dedupKey, first.dedupKey);
});

test("fails closed for malformed input, extra fields, and throwing Proxy values", async () => {
  const { source, proposals, service } = setup();
  const malformed = await service.createReviewDraft({ migrationId: "", ruleRef: "rule-1" });
  assert.deepEqual(malformed, { outcome: "needs_attention", reason: "invalid_input" });
  const extra = await service.createReviewDraft({ migrationId: assessment.migrationId, ruleRef: "rule-1", extra: true } as never);
  assert.deepEqual(extra, { outcome: "needs_attention", reason: "invalid_input" });
  const throwing = new Proxy({ migrationId: assessment.migrationId, ruleRef: "rule-1" }, {
    ownKeys() { throw new Error("provider detail"); },
  });
  const closed = await service.createReviewDraft(throwing as never);
  assert.deepEqual(closed, { outcome: "needs_attention", reason: "invalid_input" });
  assert.equal(source.getCalls.length, 0);
  assert.equal(proposals.inputs.length, 0);
  assert.equal(JSON.stringify(closed).includes("provider detail"), false);
});

test("rejects non-assessed, unsupported, unavailable, and stale candidates without creating proposals", async () => {
  const { source, proposals, service } = setup();
  source.assessment = { ...assessment, status: "needs_attention" };
  assert.deepEqual(await service.createReviewDraft({ migrationId: assessment.migrationId, ruleRef: "rule-1" }), {
    outcome: "needs_attention",
    reason: "assessment_not_eligible",
  });
  source.assessment = assessment;
  for (const [candidateResult, reason] of [
    [{ status: "needs_attention", reason: "unsupported" }, "unsupported"],
    [{ status: "needs_attention", reason: "translation_unavailable" }, "candidate_unavailable"],
    [{ status: "needs_attention", reason: "stale_source" }, "stale_source"],
  ] as const) {
    source.candidate = candidateResult;
    assert.deepEqual(await service.createReviewDraft({ migrationId: assessment.migrationId, ruleRef: "rule-1" }), {
      outcome: "needs_attention",
      reason,
    });
  }
  source.candidate = { ...candidate, sourceFingerprint: `sha256:${"d".repeat(64)}` };
  assert.deepEqual(await service.createReviewDraft({ migrationId: assessment.migrationId, ruleRef: "rule-1" }), {
    outcome: "needs_attention",
    reason: "stale_source",
  });
  assert.equal(proposals.inputs.length, 0);
});

test("rejects unsupported device scope and notify-only candidates without inventing authority", async () => {
  const { source, world, proposals, service } = setup();
  world.snapshot = () => ({ devices: [] });
  assert.deepEqual(await service.createReviewDraft({ migrationId: assessment.migrationId, ruleRef: "rule-1" }), {
    outcome: "needs_attention",
    reason: "scope_unavailable",
  });

  world.snapshot = () => ({ devices: [{
    hwId: "hw-device-living-room",
    validity: "valid" as const,
    capabilities: [],
  }] });
  source.candidate = {
    ...candidate,
    content: {
      trigger: { kind: "schedule", timezone: "Asia/Shanghai", daysOfWeek: [1], at: "08:00" },
      conditions: [],
      actions: [{ kind: "notify_local", message: "Good morning" }],
      rollback: { kind: "no_remote_change" },
      postconditions: [],
    },
  };
  assert.deepEqual(await service.createReviewDraft({ migrationId: assessment.migrationId, ruleRef: "rule-1" }), {
    outcome: "needs_attention",
    reason: "scope_unavailable",
  });
  assert.equal(proposals.inputs.length, 0);
});

test("maps migration-lane capacity and suppression results without bypassing its owner", async () => {
  const { proposals, service } = setup();
  for (const result of [
    { kind: "capacity_full" as const },
    { kind: "suppressed" as const, reason: "dedup_latched" as const, dedupKey: "dedup" },
  ]) {
    proposals.result = result;
    const output = await service.createReviewDraft({ migrationId: assessment.migrationId, ruleRef: "rule-1" });
    assert.deepEqual(output, {
      outcome: "needs_attention",
      reason: result.kind,
    });
  }
});
