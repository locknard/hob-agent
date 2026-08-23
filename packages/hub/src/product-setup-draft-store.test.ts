import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProductSetupDraftStore } from "./product-setup-draft-store.js";

test("persists one private setup session and resumes its identity stage after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-draft-"));
  const token = "private-setup-session-token-with-enough-entropy";
  const now = new Date("2026-08-23T02:00:00.000Z");
  try {
    const store = new ProductSetupDraftStore(directory, () => now, () => "draft-stable-id");
    const established = await store.establishSession({
      sessionToken: token,
      sessionExpiresAt: new Date("2026-08-23T14:00:00.000Z"),
    });
    assert.deepEqual(established, { draftId: "draft-stable-id", revision: 1, stage: "identity" });
    assert.equal(await store.loadForSession("different-private-session-token-value"), undefined);

    const named = await store.saveIdentity({
      sessionToken: token,
      expectedRevision: 1,
      householdName: "梧桐家",
      agentName: "小满",
    });
    assert.deepEqual(named, {
      draftId: "draft-stable-id",
      revision: 2,
      stage: "model",
      householdName: "梧桐家",
      agentName: "小满",
    });

    const modelReady = await store.recordModelProbe({
      sessionToken: token,
      expectedRevision: 2,
      latencyMs: 42,
      stage: {
        profile: {
          id: "custom:setup:draft-stable-id",
          provider: "custom",
          kind: "api_key",
          secretRef: "keychain:hob-agent/setup-model:draft-stable-id:stage-1",
        },
        modelId: "deepseek-v4-flash-0731",
        baseURL: "https://model.example.test/v1",
      },
    });
    assert.deepEqual(modelReady, {
      ...named,
      revision: 3,
      stage: "bridge",
      model: {
        provider: "custom",
        modelId: "deepseek-v4-flash-0731",
        baseURL: "https://model.example.test/v1",
      },
    });
    const bridgeReady = await store.recordBridgeProbe({
      sessionToken: token,
      expectedRevision: 3,
      latencyMs: 30,
      summary: { states: 21, entities: 20, devices: 8, areas: 4 },
      stage: {
        bridgeId: "bridge-0123456789abcdef",
        adapterType: "home-assistant",
        label: "Home Assistant",
        endpoint: "http://ha.local:8123",
        config: { baseUrl: "http://ha.local:8123" },
        credentialRefs: { "access-token": "keychain:hob-agent/bridge:bridge-0123456789abcdef:access-token" },
      },
    });
    assert.deepEqual(bridgeReady, {
      ...modelReady,
      revision: 4,
      stage: "map",
      bridge: {
        adapterType: "home-assistant",
        label: "Home Assistant",
        endpoint: "http://ha.local:8123",
        summary: { states: 21, entities: 20, devices: 8, areas: 4 },
      },
    });
    assert.deepEqual(await store.activationCandidateForSession(token, 4), {
      householdName: "梧桐家",
      agentName: "小满",
      modelReference: "custom/deepseek-v4-flash-0731",
      modelBaseURL: "https://model.example.test/v1",
      modelProfile: {
        id: "custom:setup:draft-stable-id",
        provider: "custom",
        kind: "api_key",
        secretRef: "keychain:hob-agent/setup-model:draft-stable-id:stage-1",
      },
      bridges: [{
        bridgeId: "bridge-0123456789abcdef",
        adapterType: "home-assistant",
        config: { baseUrl: "http://ha.local:8123" },
        credentialRefs: { "access-token": "keychain:hob-agent/bridge:bridge-0123456789abcdef:access-token" },
      }],
    });

    const restarted = new ProductSetupDraftStore(directory, () => now, () => "unused-id");
    assert.deepEqual(await restarted.loadForSession(token), bridgeReady);
    const path = join(directory, "setup-draft.json");
    const source = await readFile(path, "utf8");
    assert.equal(source.includes(token), false);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns no activation candidate before map or for a stale draft revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-draft-candidate-"));
  const token = "candidate-private-setup-session-token-value";
  try {
    const store = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-candidate-id");
    await store.establishSession({
      sessionToken: token,
      sessionExpiresAt: new Date("2026-08-23T14:00:00.000Z"),
    });
    assert.equal(await store.activationCandidateForSession(token, 1), undefined);
    await store.saveIdentity({ sessionToken: token, expectedRevision: 1, householdName: "家", agentName: "hob" });
    assert.equal(await store.activationCandidateForSession(token, 1), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retains a fixture peer's exact non-secret activation configuration without Home Assistant assumptions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-draft-peer-"));
  const token = "fixture-peer-private-setup-session-token-value";
  try {
    const store = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-peer-id");
    await store.establishSession({ sessionToken: token, sessionExpiresAt: new Date("2026-08-23T14:00:00.000Z") });
    await store.saveIdentity({ sessionToken: token, expectedRevision: 1, householdName: "测试家", agentName: "测试助手" });
    await store.recordModelProbe({
      sessionToken: token,
      expectedRevision: 2,
      latencyMs: 20,
      stage: {
        profile: {
          id: "custom:setup:draft-peer-id",
          provider: "custom",
          kind: "api_key",
          secretRef: "keychain:hob-agent/setup-model:draft-peer-id:stage-1",
        },
        modelId: "fixture-model",
        baseURL: "https://model.example.test/v1",
      },
    });
    await store.recordBridgeProbe({
      sessionToken: token,
      expectedRevision: 3,
      latencyMs: 25,
      summary: { states: 5, entities: 4, devices: 3, areas: 2 },
      stage: {
        bridgeId: "bridge-abcdef0123456789",
        adapterType: "fixture-peer",
        label: "Fixture peer",
        endpoint: "fixture://peer.local",
        config: { serverAddress: "fixture://peer.local", room: "lab" },
        credentialRefs: { session: "keychain:hob-agent/bridge:bridge-abcdef0123456789:session" },
      },
    });

    assert.deepEqual(await store.activationCandidateForSession(token, 4), {
      householdName: "测试家",
      agentName: "测试助手",
      modelReference: "custom/fixture-model",
      modelBaseURL: "https://model.example.test/v1",
      modelProfile: {
        id: "custom:setup:draft-peer-id",
        provider: "custom",
        kind: "api_key",
        secretRef: "keychain:hob-agent/setup-model:draft-peer-id:stage-1",
      },
      bridges: [{
        bridgeId: "bridge-abcdef0123456789",
        adapterType: "fixture-peer",
        config: { serverAddress: "fixture://peer.local", room: "lab" },
        credentialRefs: { session: "keychain:hob-agent/bridge:bridge-abcdef0123456789:session" },
      }],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps setup identity changes revision-bound and expires the private session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-draft-guard-"));
  let now = new Date("2026-08-23T02:00:00.000Z");
  const token = "another-private-setup-session-token-value";
  try {
    const store = new ProductSetupDraftStore(directory, () => now, () => "draft-guard-id");
    await store.establishSession({
      sessionToken: token,
      sessionExpiresAt: new Date("2026-08-23T02:10:00.000Z"),
    });
    await assert.rejects(
      store.saveIdentity({
        sessionToken: token,
        expectedRevision: 2,
        householdName: "家",
        agentName: "hob",
      }),
      /revision conflict/,
    );
    now = new Date("2026-08-23T02:11:00.000Z");
    assert.equal(await store.loadForSession(token), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
