import assert from "node:assert/strict";
import test from "node:test";

import {
  assessHomeMigrationEnvironment,
  parseHomeMigrationAssessmentArgs,
  type HomeMigrationAssessmentRuntime,
} from "./home-migration-assess.js";

const ENV = {
  HOB_DATA_DIR: "/tmp/hob-home-migration-assess-test",
  HOB_BRIDGES: JSON.stringify([{
    bridgeId: "bridge-a",
    adapterType: "home-assistant",
    config: {
      baseUrl: "http://ha.invalid:8123",
      authenticationPrincipal: "household-member",
    },
    credentialRefs: { "access-token": "HOB_HA_TOKEN" },
  }]),
};

const ASSESSMENT_ID = "a".repeat(32);

test("requires one explicit bounded bridge id", () => {
  assert.deepEqual(parseHomeMigrationAssessmentArgs(["--bridge-id", "bridge-a"]), {
    bridgeId: "bridge-a",
  });
  assert.throws(() => parseHomeMigrationAssessmentArgs([]), /--bridge-id is required/);
  assert.throws(() => parseHomeMigrationAssessmentArgs(["--bridge-id", "bridge-a", "--unknown"]), /unknown argument/);
  assert.throws(() => parseHomeMigrationAssessmentArgs(["--bridge-id", "bad\nbridge"]), /invalid bridge id/);
  assert.throws(() => parseHomeMigrationAssessmentArgs(["--bridge-id", "界".repeat(86)]), /invalid bridge id/);
});

test("assesses a configured bridge and emits only an opaque aggregate receipt", async () => {
  const calls: string[] = [];
  const assessment = {
    migrationId: ASSESSMENT_ID,
    idempotencyKey: "b".repeat(32),
    inputDigest: `sha256:${"c".repeat(64)}`,
    sourceBridgeId: "secret-bridge",
    sourceEpochId: "secret-epoch",
    sourceLastSeq: 17,
    analysisMode: "trusted_neutral" as const,
    rules: [
      { ruleRef: "secret-rule-eligible", name: "Private lamp", disposition: "eligible" as const },
      { ruleRef: "secret-rule-unsupported", name: "Private unsupported", disposition: "unsupported" as const },
      { ruleRef: "secret-rule-metadata", name: "Private metadata", disposition: "metadata_only" as const },
    ],
    status: "assessed" as const,
    createdAt: "2026-08-24T00:00:00.000Z",
    assessedAt: "2026-08-24T00:00:01.000Z",
  };
  const runtime: HomeMigrationAssessmentRuntime = {
    snapshot: () => readySnapshot(),
    async assessBridgeCatalog(bridgeId) {
      calls.push(bridgeId);
      return { outcome: calls.length === 1 ? "created" : "existing", assessment };
    },
    async close() {},
  };

  const first = await assessHomeMigrationEnvironment(ENV, "bridge-a", {
    createRuntime: () => runtime,
  });
  const replay = await assessHomeMigrationEnvironment(ENV, "bridge-a", {
    createRuntime: () => runtime,
  });

  assert.deepEqual(first, {
    schemaVersion: "1",
    outcome: "created",
    assessmentId: ASSESSMENT_ID,
    assessmentStatus: "assessed",
    ruleCount: 3,
    eligibleRuleCount: 1,
    metadataOnlyRuleCount: 1,
    unsupportedRuleCount: 1,
    needsAttentionRuleCount: 0,
    remoteWritesPerformed: false,
  });
  assert.deepEqual(replay, { ...first, outcome: "existing" });
  assert.deepEqual(calls, ["bridge-a", "bridge-a"]);
  const serialized = JSON.stringify(first);
  for (const secret of ["secret-bridge", "secret-epoch", "secret-rule", "Private", "native", "entity", "http://"]) {
    assert.equal(serialized.includes(secret), false, `receipt leaked ${secret}`);
  }
});

test("returns a fixed attention receipt without exposing the runtime reason payload", async () => {
  const runtime: HomeMigrationAssessmentRuntime = {
    snapshot: () => readySnapshot(),
    async assessBridgeCatalog() {
      return { outcome: "needs_attention", reason: "catalog_unavailable" as const };
    },
    async close() {},
  };

  assert.deepEqual(await assessHomeMigrationEnvironment(ENV, "bridge-a", {
    createRuntime: () => runtime,
  }), {
    schemaVersion: "1",
    outcome: "needs_attention",
    reason: "catalog_unavailable",
    remoteWritesPerformed: false,
  });
});

test("rejects a bridge that is not present in HOB_BRIDGES before creating a runtime", async () => {
  let created = false;
  await assert.rejects(() => assessHomeMigrationEnvironment(ENV, "bridge-not-configured", {
    createRuntime: () => {
      created = true;
      throw new Error("must not create runtime");
    },
  }), /configured bridge id is not configured/);
  assert.equal(created, false);
});

test("fails before the assessment call when the selected bridge never reaches a ready cut", async () => {
  let calls = 0;
  let closeCalls = 0;
  let now = 0;
  const runtime: HomeMigrationAssessmentRuntime = {
    snapshot: () => ({ ...readySnapshot(), diagnostics: [{ ...readySnapshot().diagnostics[0]!, connectionState: "degraded" }] }),
    async assessBridgeCatalog() {
      calls += 1;
      return { outcome: "needs_attention", reason: "catalog_unavailable" as const };
    },
    async close() { closeCalls += 1; },
  };

  await assert.rejects(() => assessHomeMigrationEnvironment(ENV, "bridge-a", {
    readyTimeoutMs: 1_000,
    pollMs: 1_000,
    createRuntime: () => runtime,
    wait: async () => {},
    now: () => now += 1_000,
  }), /Home Assistant bridge did not reach a ready cut/);
  assert.equal(calls, 0);
  assert.equal(closeCalls, 1);
});

test("closes the runtime exactly once when assessment throws and does not access write methods", async () => {
  let closeCalls = 0;
  const runtime = new Proxy({
    snapshot: () => readySnapshot(),
    async assessBridgeCatalog() {
      throw new Error("provider detail must not escape");
    },
    async close() { closeCalls += 1; },
  } satisfies HomeMigrationAssessmentRuntime, {
    get(target, property, receiver) {
      // `await` probes the Promise-like `then` property while assimilating the
      // factory result; it is not a runtime capability.
      if (property !== "snapshot" && property !== "assessBridgeCatalog" && property !== "close" && property !== "then") {
        throw new Error(`unexpected runtime method: ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  await assert.rejects(() => assessHomeMigrationEnvironment(ENV, "bridge-a", {
    createRuntime: () => runtime,
  }), /provider detail must not escape/);
  assert.equal(closeCalls, 1);
});

function readySnapshot() {
  return {
    generatedAt: "2026-08-24T00:00:00.000Z",
    bridges: { "bridge-a": {} },
    watermarkVector: { "bridge-a": {} },
    bridgeWatermarks: [{ bridgeId: "bridge-a", epochId: "opaque-epoch", lastSeq: 17 }],
    watermarks: [{ bridgeId: "bridge-a", epochId: "opaque-epoch", lastSeq: 17 }],
    diagnostics: [{
      bridgeId: "bridge-a",
      connectionState: "ready",
      currentProcessReadyAt: "2026-08-24T00:00:00.000Z",
    }],
    metrics: {} as never,
    spaces: [],
    devices: [],
  };
}
