import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProductModelSetupInput, ProductModelSetupStage } from "./product-model-setup.js";
import { ProductSetupController } from "./product-setup-controller.js";
import { ProductSetupDraftStore } from "./product-setup-draft-store.js";

test("binds a ready model probe to the exact durable setup revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-controller-"));
  const token = "controller-private-setup-session-token-value";
  const probed: ProductModelSetupInput[] = [];
  const discarded: ProductModelSetupStage[] = [];
  const bridgeCalls: unknown[] = [];
  const stage: ProductModelSetupStage = {
    profile: {
      id: "custom:setup:draft-controller",
      provider: "custom",
      kind: "api_key",
      secretRef: "keychain:hob-agent/setup-model:draft-controller:stage-1",
    },
    modelId: "deepseek-v4-flash-0731",
    baseURL: "https://model.example.test/v1",
  };
  const controller = new ProductSetupController(
    new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-controller"),
    {
      probe: async (input) => { probed.push(input); return { status: "ready", latencyMs: 35, staged: stage }; },
      discard: async (input) => { discarded.push(input); },
    },
    {
      probe: async (input) => {
        bridgeCalls.push(input);
        return {
          status: "ready" as const,
          latencyMs: 22,
          summary: { states: 10, entities: 9, devices: 4, areas: 2 },
          stage: {
            bridgeId: "bridge-fedcba9876543210",
            adapterType: "fixture-peer",
            label: "Fixture peer",
            config: { endpoint: "fixture://peer.local" },
            credentialRefs: { session: "keychain:hob-agent/bridge:bridge-fedcba9876543210:session" },
          },
        };
      },
      discard: async () => undefined,
    },
  );
  try {
    await controller.establishSession({ sessionToken: token, sessionExpiresAt: new Date("2026-08-23T14:00:00.000Z") });
    await controller.saveIdentity({
      sessionToken: token,
      expectedRevision: 1,
      householdName: "梧桐家",
      agentName: "小满",
    });
    const result = await controller.probeModel({
      sessionToken: token,
      expectedRevision: 2,
      provider: "custom",
      modelId: "deepseek-v4-flash-0731",
      baseURL: "https://model.example.test/v1",
      apiKey: "request-local-model-secret",
    });
    assert.equal(result.status, "ready");
    assert.equal(probed.length, 1);
    assert.equal(discarded.length, 0);
    assert.deepEqual(await controller.loadForSession(token), result.status === "ready" ? result.draft : undefined);

    const stale = await controller.probeModel({
      sessionToken: token,
      expectedRevision: 2,
      provider: "custom",
      modelId: "other-model",
      baseURL: "https://model.example.test/v1",
      apiKey: "another-request-local-secret",
    });
    assert.deepEqual(stale, { status: "conflict" });
    assert.equal(probed.length, 1);

    const bridge = await controller.probeBridge({
      sessionToken: token,
      expectedRevision: 3,
      adapterType: "fixture-peer",
      config: { endpoint: "fixture://peer.local" },
      credential: "request-local-bridge-secret",
    });
    assert.equal(bridge.status, "ready");
    assert.equal(bridgeCalls.length, 1);
    assert.deepEqual(bridgeCalls, [{
      setupId: "draft-controller",
      adapterType: "fixture-peer",
      config: { endpoint: "fixture://peer.local" },
      credential: "request-local-bridge-secret",
    }]);
    assert.deepEqual(await controller.activationCandidateForSession(token, 4), {
      householdName: "梧桐家",
      agentName: "小满",
      modelReference: "custom/deepseek-v4-flash-0731",
      modelBaseURL: "https://model.example.test/v1",
      modelProfile: stage.profile,
      bridges: [{
        bridgeId: "bridge-fedcba9876543210",
        adapterType: "fixture-peer",
        config: { endpoint: "fixture://peer.local" },
        credentialRefs: { session: "keychain:hob-agent/bridge:bridge-fedcba9876543210:session" },
      }],
    });
    assert.equal(await controller.activationCandidateForSession(token, 3), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
