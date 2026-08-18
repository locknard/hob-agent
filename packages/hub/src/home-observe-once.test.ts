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
  const context = {
    homeWorld: {
      snapshot: () => ({
        bridges: { "bridge-a": {} },
        bridgeWatermarks: [{ bridgeId: "bridge-a" }],
        diagnostics: [{ bridgeId: "bridge-a", connectionState: "ready" }],
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
              diagnostics: [{ bridgeId: "bridge-a", connectionState: "ready" }],
            }),
          },
          homeProposals: { list: () => [{ status: "pending_review" }] },
          homeAgent: {
            observationStatus: "idle" as const,
            async requestObservation() { observations += 1; },
          },
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
  const report = await observeHomeEnvironment(ENV, {
    createRuntime() {
      return {
        context: {
          homeWorld: {
            snapshot: () => ({
              bridges: { "bridge-a": {} },
              bridgeWatermarks: [{ bridgeId: "bridge-a" }],
              diagnostics: [{ bridgeId: "bridge-a", connectionState: "ready" }],
            }),
          },
          homeProposals: { list: () => [] },
          homeAgent: {
            observationStatus: "idle" as const,
            async requestObservation() {},
          },
        } as never,
        async start() {},
        async stop() {},
      };
    },
  });

  assert.deepEqual(report, { outcome: "completed", proposal: "none" });
});
