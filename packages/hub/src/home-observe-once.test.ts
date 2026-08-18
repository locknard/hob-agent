import assert from "node:assert/strict";
import test from "node:test";

import { observeHomeEnvironment } from "./home-observe-once.js";

const ENV = {
  HOB_DATA_DIR: "/tmp/hob-observe-test",
  HOB_BRIDGES: JSON.stringify([{
    bridgeId: "bridge-a",
    adapterType: "home-assistant",
    config: { baseUrl: "http://ha.invalid:8123", authenticationPrincipal: "owner" },
    credentialRefs: { "access-token": "HOB_HA_TOKEN" },
  }]),
  HOB_HA_TOKEN: "test-ha-token",
  HOB_MODEL: "deepseek/deepseek-v4-flash",
  DEEPSEEK_API_KEY: "test-model-key",
  HOB_INBOX_AUTH_TOKEN: "x".repeat(32),
  HOB_INBOX_PORT: "8787",
  HOB_OBSERVATION_INTERVAL_MINUTES: "360",
};

test("runs one governed observation without mounting HTTP or recurring scheduling", async () => {
  let started = 0;
  let stopped = 0;
  let observations = 0;
  let receivedOptions: Record<string, unknown> | undefined;
  const proposals: unknown[] = [];
  const audit = createAuditStub();
  const context = {
    homeWorld: {
      snapshot: () => ({
        bridges: { "bridge-a": {} },
        bridgeWatermarks: [{ bridgeId: "bridge-a" }],
        diagnostics: [{ bridgeId: "bridge-a", connectionState: "ready", currentProcessReadyAt: "2026-08-19T03:59:00.000Z" }],
      }),
    },
    homeProposals: {
      list: () => proposals,
    },
    homeAgent: {
      observationStatus: "idle" as const,
      async requestObservation() {
        observations += 1;
        proposals.push({ status: "pending_review" });
      },
    },
    homeObservationAudit: audit,
  };

  const report = await observeHomeEnvironment(ENV, {
    createRuntime(options) {
      receivedOptions = options as unknown as Record<string, unknown>;
      return {
        context: context as never,
        async start() { started += 1; },
        async stop() { stopped += 1; },
      };
    },
  });

  assert.deepEqual(report, { outcome: "completed", proposal: "created" });
  assert.equal(started, 1);
  assert.equal(stopped, 1);
  assert.equal(observations, 1);
  assert.deepEqual(audit.starts.map((attempt) => attempt.trigger), ["one_shot"]);
  assert.deepEqual(audit.completions.map((attempt) => attempt.outcome), ["proposal_created"]);
  assert.equal("observation" in receivedOptions!, false);
  assert.equal("inboxHttp" in receivedOptions!, false);
});

test("does not call the model when a proposal is already pending", async () => {
  let observations = 0;
  const report = await observeHomeEnvironment(ENV, {
    createRuntime() {
      return {
        context: {
          homeWorld: {
            snapshot: () => ({
              bridges: { "bridge-a": {} },
              bridgeWatermarks: [{ bridgeId: "bridge-a" }],
              diagnostics: [{ bridgeId: "bridge-a", connectionState: "ready", currentProcessReadyAt: "2026-08-19T03:59:00.000Z" }],
            }),
          },
          homeProposals: { list: () => [{ status: "pending_review" }] },
          homeAgent: {
            observationStatus: "idle" as const,
            async requestObservation() { observations += 1; },
          },
          homeObservationAudit: createAuditStub(),
        } as never,
        async start() {},
        async stop() {},
      };
    },
  });

  assert.deepEqual(report, { outcome: "not_run", reason: "proposal_pending", proposal: "already_pending" });
  assert.equal(observations, 0);
});

test("reports a completed observation that intentionally creates no proposal", async () => {
  const audit = createAuditStub();
  const report = await observeHomeEnvironment(ENV, {
    createRuntime() {
      return {
        context: {
          homeWorld: {
            snapshot: () => ({
              bridges: { "bridge-a": {} },
              bridgeWatermarks: [{ bridgeId: "bridge-a" }],
              diagnostics: [{ bridgeId: "bridge-a", connectionState: "ready", currentProcessReadyAt: "2026-08-19T03:59:00.000Z" }],
            }),
          },
          homeProposals: { list: () => [] },
          homeAgent: {
            observationStatus: "idle" as const,
            async requestObservation() { return "mapping_uncertain" as const; },
          },
          homeObservationAudit: audit,
        } as never,
        async start() {},
        async stop() {},
      };
    },
  });

  assert.deepEqual(report, { outcome: "completed", proposal: "none", disposition: "mapping_uncertain" });
  assert.equal(audit.completions[0]?.disposition, "mapping_uncertain");
});

function createAuditStub() {
  const starts: { id: string; trigger: string; startedAt: string }[] = [];
  const completions: { id: string; completedAt: string; outcome: string; disposition?: string }[] = [];
  return {
    starts,
    completions,
    begin(input: { trigger: string; startedAt: string }) {
      const id = `observation-${starts.length + 1}`;
      starts.push({ id, ...input });
      return id;
    },
    complete(input: { id: string; completedAt: string; outcome: string; disposition?: string }) {
      completions.push(input);
    },
    list() { return []; },
  };
}
