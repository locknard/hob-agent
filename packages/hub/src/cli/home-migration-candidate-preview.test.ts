import assert from "node:assert/strict";
import test from "node:test";

import type { HomeAutomationMigrationAssessment } from "../home/home-automation-migration.js";
import {
  parseHomeMigrationCandidatePreviewArgs,
  previewHomeMigrationCandidates,
  type HomeMigrationCandidatePreviewRuntime,
} from "./home-migration-candidate-preview.js";

const BRIDGE_ID = "bridge-a";
const ASSESSMENT_ID = "a".repeat(32);
const SOURCE_FINGERPRINT = `sha256:${"d".repeat(64)}`;
const ENV = {
  HOB_DATA_DIR: "/tmp/hob-home-migration-candidate-preview-test",
  HOB_BRIDGES: JSON.stringify([{
    bridgeId: BRIDGE_ID,
    adapterType: "home-assistant",
    config: {
      baseUrl: "http://ha.invalid:8123",
      authenticationPrincipal: "household-member",
    },
    credentialRefs: { "access-token": "HOB_HA_TOKEN" },
  }]),
};

test("requires one explicit lowercase 32-hex assessment id", () => {
  assert.deepEqual(parseHomeMigrationCandidatePreviewArgs(["--assessment-id", ASSESSMENT_ID]), {
    assessmentId: ASSESSMENT_ID,
  });
  assert.throws(() => parseHomeMigrationCandidatePreviewArgs([]), /--assessment-id is required/);
  assert.throws(() => parseHomeMigrationCandidatePreviewArgs(["--assessment-id", "A".repeat(32)]), /invalid assessment id/);
  assert.throws(() => parseHomeMigrationCandidatePreviewArgs(["--assessment-id", "a".repeat(31)]), /invalid assessment id/);
  assert.throws(() => parseHomeMigrationCandidatePreviewArgs(["--unknown", ASSESSMENT_ID]), /unknown argument/);
  assert.throws(() => parseHomeMigrationCandidatePreviewArgs(["--assessment-id", ASSESSMENT_ID, "extra"]), /unknown argument/);
});

test("previews only eligible rules into an opaque aggregate and can be rerun", async () => {
  const calls: string[] = [];
  let closeCalls = 0;
  const assessment = assessedAssessment();
  const runtime: HomeMigrationCandidatePreviewRuntime = {
    snapshot: () => readySnapshot(),
    get: (migrationId) => migrationId === ASSESSMENT_ID ? assessment : undefined,
    async createArtifactCandidate(input) {
      calls.push(input.ruleRef);
      if (input.ruleRef === "private-rule-stale") {
        return { status: "needs_attention", reason: "stale_source" };
      }
      return {
        status: "candidate",
        sourceFingerprint: SOURCE_FINGERPRINT,
        ruleRef: "private-rule-candidate",
        title: "Private title",
        content: {} as never,
      };
    },
    async close() { closeCalls += 1; },
  };

  const first = await previewHomeMigrationCandidates(ENV, ASSESSMENT_ID, {
    createRuntime: () => runtime,
  });
  const replay = await previewHomeMigrationCandidates(ENV, ASSESSMENT_ID, {
    createRuntime: () => runtime,
  });

  const expected = {
    schemaVersion: "1",
    outcome: "previewed",
    assessmentId: ASSESSMENT_ID,
    eligibleRuleCount: 2,
    candidateRuleCount: 1,
    needsAttentionRuleCount: 1,
    needsAttentionByReason: {
      assessment_not_eligible: 0,
      stale_source: 1,
      translation_unavailable: 0,
      unsupported: 0,
      invalid_input: 0,
      resolver_failed: 0,
      unbound_target: 0,
      multiple_targets: 0,
      invalid_title: 0,
      artifact_invalid: 0,
      candidate_unavailable: 0,
      candidate_timeout: 0,
    },
    remoteWritesPerformed: false,
  } as const;
  assert.deepEqual(first, expected);
  assert.deepEqual(replay, expected);
  assert.deepEqual(calls, ["private-rule-candidate", "private-rule-stale", "private-rule-candidate", "private-rule-stale"]);
  assert.equal(closeCalls, 2);
  const serialized = JSON.stringify(first);
  for (const secret of ["private-rule", "Private title", "bridge-a", "epoch", "fingerprint", "native", "entity", "http://"]) {
    assert.equal(serialized.includes(secret), false, `receipt leaked ${secret}`);
  }
});

test("returns fixed fail-closed reasons for missing, non-assessed, and inconsistent assessments", async () => {
  let calls = 0;
  const runtime: HomeMigrationCandidatePreviewRuntime = {
    snapshot: () => readySnapshot(),
    get: (migrationId) => {
      if (migrationId === "b".repeat(32)) return { ...assessedAssessment(), migrationId: "b".repeat(32), status: "discovered", assessedAt: undefined };
      if (migrationId === "c".repeat(32)) return { ...inconsistentAssessment(), migrationId: "c".repeat(32) };
      return undefined;
    },
    async createArtifactCandidate() {
      calls += 1;
      return { status: "needs_attention", reason: "candidate_unavailable" };
    },
    async close() {},
  };

  assert.deepEqual(await previewHomeMigrationCandidates(ENV, "f".repeat(32), { createRuntime: () => runtime }), {
    schemaVersion: "1",
    outcome: "needs_attention",
    assessmentId: "f".repeat(32),
    reason: "assessment_not_found",
    remoteWritesPerformed: false,
  });
  assert.deepEqual(await previewHomeMigrationCandidates(ENV, "b".repeat(32), { createRuntime: () => runtime }), {
    schemaVersion: "1",
    outcome: "needs_attention",
    assessmentId: "b".repeat(32),
    reason: "assessment_not_assessed",
    remoteWritesPerformed: false,
  });
  assert.deepEqual(await previewHomeMigrationCandidates(ENV, "c".repeat(32), { createRuntime: () => runtime }), {
    schemaVersion: "1",
    outcome: "needs_attention",
    assessmentId: "c".repeat(32),
    reason: "assessment_inconsistent",
    remoteWritesPerformed: false,
  });
  assert.equal(calls, 0);
});

test("rejects an assessment whose source bridge is not configured before waiting", async () => {
  let snapshotCalls = 0;
  let closeCalls = 0;
  const runtime: HomeMigrationCandidatePreviewRuntime = {
    snapshot: () => { snapshotCalls += 1; return readySnapshot(); },
    get: () => ({ ...assessedAssessment(), sourceBridgeId: "bridge-not-configured" }),
    async createArtifactCandidate() {
      throw new Error("must not create a candidate");
    },
    async close() { closeCalls += 1; },
  };

  assert.deepEqual(await previewHomeMigrationCandidates(ENV, ASSESSMENT_ID, { createRuntime: () => runtime }), {
    schemaVersion: "1",
    outcome: "needs_attention",
    assessmentId: ASSESSMENT_ID,
    reason: "source_unavailable",
    remoteWritesPerformed: false,
  });
  assert.equal(snapshotCalls, 0);
  assert.equal(closeCalls, 1);
});

test("requires the exact assessment source watermark before previewing any candidate", async () => {
  let calls = 0;
  let closeCalls = 0;
  const runtime: HomeMigrationCandidatePreviewRuntime = {
    snapshot: () => ({
      ...readySnapshot(),
      bridgeWatermarks: [{ bridgeId: BRIDGE_ID, epochId: "different-epoch", lastSeq: 17 }],
    }),
    get: () => assessedAssessment(),
    async createArtifactCandidate() {
      calls += 1;
      return { status: "candidate", sourceFingerprint: SOURCE_FINGERPRINT, ruleRef: "secret", title: "secret", content: {} as never };
    },
    async close() { closeCalls += 1; },
  };

  assert.deepEqual(await previewHomeMigrationCandidates(ENV, ASSESSMENT_ID, { createRuntime: () => runtime }), {
    schemaVersion: "1",
    outcome: "needs_attention",
    assessmentId: ASSESSMENT_ID,
    reason: "source_unstable",
    remoteWritesPerformed: false,
  });
  assert.equal(calls, 0);
  assert.equal(closeCalls, 1);
});

test("returns source-unstable when the source watermark drifts after candidate preview", async () => {
  let snapshotCalls = 0;
  let closeCalls = 0;
  const runtime: HomeMigrationCandidatePreviewRuntime = {
    snapshot: () => {
      snapshotCalls += 1;
      return snapshotCalls < 3
        ? readySnapshot()
        : {
          ...readySnapshot(),
          bridgeWatermarks: [{ bridgeId: BRIDGE_ID, epochId: "drifted-epoch", lastSeq: 18 }],
        };
    },
    get: () => ({ ...assessedAssessment(), rules: [assessedAssessment().rules[0]!] }),
    async createArtifactCandidate() {
      return { status: "candidate", sourceFingerprint: SOURCE_FINGERPRINT, ruleRef: "secret", title: "secret", content: {} as never };
    },
    async close() { closeCalls += 1; },
  };

  assert.deepEqual(await previewHomeMigrationCandidates(ENV, ASSESSMENT_ID, { createRuntime: () => runtime }), {
    schemaVersion: "1",
    outcome: "needs_attention",
    assessmentId: ASSESSMENT_ID,
    reason: "source_unstable",
    remoteWritesPerformed: false,
  });
  assert.equal(snapshotCalls, 3);
  assert.equal(closeCalls, 1);
});

test("returns ready-timeout without invoking candidates and closes once", async () => {
  let now = 0;
  let calls = 0;
  let closeCalls = 0;
  const runtime: HomeMigrationCandidatePreviewRuntime = {
    snapshot: () => ({ ...readySnapshot(), diagnostics: [{ ...readySnapshot().diagnostics[0]!, connectionState: "degraded" }] }),
    get: () => assessedAssessment(),
    async createArtifactCandidate() {
      calls += 1;
      return { status: "needs_attention", reason: "candidate_unavailable" };
    },
    async close() { closeCalls += 1; },
  };

  assert.deepEqual(await previewHomeMigrationCandidates(ENV, ASSESSMENT_ID, {
    readyTimeoutMs: 1_000,
    pollMs: 1_000,
    createRuntime: () => runtime,
    wait: async () => {},
    now: () => now += 1_000,
  }), {
    schemaVersion: "1",
    outcome: "needs_attention",
    assessmentId: ASSESSMENT_ID,
    reason: "ready_timeout",
    remoteWritesPerformed: false,
  });
  assert.equal(calls, 0);
  assert.equal(closeCalls, 1);
});

test("aborts a hanging candidate preview at the timeout and keeps the failure fixed", async () => {
  let receivedSignal: AbortSignal | undefined;
  let closeCalls = 0;
  const runtime: HomeMigrationCandidatePreviewRuntime = {
    snapshot: () => readySnapshot(),
    get: () => ({ ...assessedAssessment(), rules: [assessedAssessment().rules[0]!] }),
    async createArtifactCandidate(_input, options) {
      receivedSignal = options?.signal;
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "needs_attention", reason: "translation_unavailable" };
    },
    async close() { closeCalls += 1; },
  };

  const result = await previewHomeMigrationCandidates(ENV, ASSESSMENT_ID, {
    candidateTimeoutMs: 10,
    createRuntime: () => runtime,
  });
  assert.deepEqual(result, {
    schemaVersion: "1",
    outcome: "previewed",
    assessmentId: ASSESSMENT_ID,
    eligibleRuleCount: 1,
    candidateRuleCount: 0,
    needsAttentionRuleCount: 1,
    needsAttentionByReason: {
      assessment_not_eligible: 0,
      stale_source: 0,
      translation_unavailable: 0,
      unsupported: 0,
      invalid_input: 0,
      resolver_failed: 0,
      unbound_target: 0,
      multiple_targets: 0,
      invalid_title: 0,
      artifact_invalid: 0,
      candidate_unavailable: 0,
      candidate_timeout: 1,
    },
    remoteWritesPerformed: false,
  });
  assert.equal(receivedSignal?.aborted, true);
  assert.equal(closeCalls, 1);
});

test("bounds the total preview budget instead of waiting once per eligible rule", async () => {
  let calls = 0;
  const runtime: HomeMigrationCandidatePreviewRuntime = {
    snapshot: () => readySnapshot(),
    get: () => {
      const assessment = assessedAssessment();
      return { ...assessment, rules: [assessment.rules[0]!, assessment.rules[1]!] };
    },
    async createArtifactCandidate(_input, options) {
      calls += 1;
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "needs_attention", reason: "translation_unavailable" };
    },
    async close() {},
  };

  const result = await previewHomeMigrationCandidates(ENV, ASSESSMENT_ID, {
    candidateTimeoutMs: 10,
    createRuntime: () => runtime,
  });
  assert.equal(result.outcome, "previewed");
  if (result.outcome === "previewed") {
    assert.equal(result.eligibleRuleCount, 2);
    assert.equal(result.candidateRuleCount, 0);
    assert.equal(result.needsAttentionRuleCount, 2);
    assert.equal(result.needsAttentionByReason.candidate_timeout, 2);
  }
  assert.equal(calls, 1);
});

test("keeps the preview facade read-only and does not access proposal or bridge write methods", async () => {
  const assessment = assessedAssessment();
  let closeCalls = 0;
  const runtime = new Proxy({
    snapshot: () => readySnapshot(),
    get: () => assessment,
    async createArtifactCandidate() {
      return { status: "candidate", sourceFingerprint: SOURCE_FINGERPRINT, ruleRef: "secret", title: "secret", content: {} as never };
    },
    async close() { closeCalls += 1; },
  } satisfies HomeMigrationCandidatePreviewRuntime, {
    get(target, property, receiver) {
      if (property !== "snapshot" && property !== "get" && property !== "createArtifactCandidate" && property !== "close" && property !== "then") {
        throw new Error(`unexpected runtime method: ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  await previewHomeMigrationCandidates(ENV, ASSESSMENT_ID, { createRuntime: () => runtime });
  assert.equal(closeCalls, 1);
});

function assessedAssessment(): HomeAutomationMigrationAssessment {
  return {
    migrationId: ASSESSMENT_ID,
    idempotencyKey: "b".repeat(32),
    inputDigest: `sha256:${"c".repeat(64)}`,
    sourceBridgeId: BRIDGE_ID,
    sourceEpochId: "opaque-epoch",
    sourceLastSeq: 17,
    analysisMode: "trusted_neutral",
    rules: [
      {
        ruleRef: "private-rule-candidate",
        triggerClass: "state",
        conditionClass: "flat_and",
        actionClass: "reversible",
        sourceFingerprint: SOURCE_FINGERPRINT,
        disposition: "eligible",
        workflow: {
          status: "assessed",
          sourceFingerprint: SOURCE_FINGERPRINT,
          assessedAt: "2026-08-24T00:00:01.000Z",
        },
      },
      {
        ruleRef: "private-rule-stale",
        triggerClass: "time",
        conditionClass: "flat_and",
        actionClass: "reversible",
        sourceFingerprint: SOURCE_FINGERPRINT,
        disposition: "eligible",
        workflow: {
          status: "assessed",
          sourceFingerprint: SOURCE_FINGERPRINT,
          assessedAt: "2026-08-24T00:00:01.000Z",
        },
      },
      {
        ruleRef: "private-rule-metadata",
        triggerClass: "metadata_only",
        conditionClass: "metadata_only",
        actionClass: "metadata_only",
        disposition: "metadata_only",
        reason: "translation_unavailable",
      },
    ],
    status: "assessed",
    createdAt: "2026-08-24T00:00:00.000Z",
    assessedAt: "2026-08-24T00:00:01.000Z",
  };
}

function inconsistentAssessment(): HomeAutomationMigrationAssessment {
  const assessment = assessedAssessment();
  return {
    ...assessment,
    rules: [
      assessment.rules[0]!,
      { ...assessment.rules[0]!, sourceFingerprint: undefined },
    ],
  };
}

function readySnapshot() {
  return {
    generatedAt: "2026-08-24T00:00:00.000Z",
    bridges: { [BRIDGE_ID]: {} },
    watermarkVector: { [BRIDGE_ID]: {} },
    bridgeWatermarks: [{ bridgeId: BRIDGE_ID, epochId: "opaque-epoch", lastSeq: 17 }],
    watermarks: [{ bridgeId: BRIDGE_ID, epochId: "opaque-epoch", lastSeq: 17 }],
    diagnostics: [{
      bridgeId: BRIDGE_ID,
      connectionState: "ready",
      currentProcessReadyAt: "2026-08-24T00:00:00.000Z",
    }],
    metrics: {} as never,
    spaces: [],
    devices: [],
  };
}
