import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProductSetupDraftStore } from "./product-setup-draft-store.js";
import type { ProductVoiceSetupStage } from "./product-voice-setup.js";

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
        baseURL: "http://127.0.0.1:8081/v1/",
      },
    });
    assert.deepEqual(modelReady, {
      ...named,
      revision: 3,
      stage: "bridge",
      model: {
        provider: "custom",
        modelId: "deepseek-v4-flash-0731",
        baseURL: "http://127.0.0.1:8081/v1",
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
      stage: "voice",
      bridge: {
        adapterType: "home-assistant",
        label: "Home Assistant",
        endpoint: "http://ha.local:8123",
        summary: { states: 21, entities: 20, devices: 8, areas: 4 },
      },
    });
    const skipped = await store.skipVoice({ sessionToken: token, expectedRevision: 4 });
    assert.deepEqual(skipped, { draft: { ...bridgeReady, revision: 5, stage: "map", voiceSkipped: true }, replaced: [] });
    assert.deepEqual(await store.activationCandidateForSession(token, 5), {
      householdName: "梧桐家",
      agentName: "小满",
      modelReference: "custom/deepseek-v4-flash-0731",
      modelBaseURL: "http://127.0.0.1:8081/v1",
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
    assert.deepEqual(await restarted.loadForSession(token), skipped.draft);
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

    await store.skipVoice({ sessionToken: token, expectedRevision: 4 });
    assert.deepEqual(await store.activationCandidateForSession(token, 5), {
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

test("retains independently probed voice tracks and adds them to the activation candidate only when both are ready", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-draft-voice-"));
  const token = "voice-private-setup-session-token-value";
  try {
    const store = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-voice-id");
    await prepareVoiceStage(store, token);

    const asr: ProductVoiceSetupStage = {
      kind: "asr", transport: "wyoming", endpoint: "wyoming://voice.local:10700",
      model: "tiny",
    };
    const stagedAsr = await store.recordVoiceProbe({ sessionToken: token, expectedRevision: 4, stage: asr, latencyMs: 18 });
    assert.deepEqual(stagedAsr, {
      draft: { draftId: "draft-voice-id", revision: 5, stage: "voice", householdName: "测试家", agentName: "测试助手", model: { provider: "custom", modelId: "fixture-model" }, bridge: { adapterType: "fixture-peer", label: "Fixture peer", summary: { states: 5, entities: 4, devices: 3, areas: 2 } }, voice: { asr: { transport: "wyoming", endpoint: "wyoming://voice.local:10700", model: "tiny", probeLatencyMs: 18 } } },
      replaced: [],
    });
    const restartedAfterAsr = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "unused-id");
    const resumed = await restartedAfterAsr.loadForSession(token);
    assert.deepEqual(resumed?.voice, { asr: { transport: "wyoming", endpoint: "wyoming://voice.local:10700", model: "tiny", probeLatencyMs: 18 } });
    assert.equal(JSON.stringify(resumed).includes("credentialRef"), false);
    assert.equal(await store.activationCandidateForSession(token, 5), undefined);

    const tts: ProductVoiceSetupStage = {
      kind: "tts", transport: "openai_http", endpoint: "http://127.0.0.1:9880",
      credentialRef: "keychain:hob-agent/voice:tts:draft-voice-id:tts-one", locale: "zh-CN", voice: "warm", model: "kokoro",
    };
    await store.reserveVoiceCredential({ sessionToken: token, expectedRevision: 5, stage: tts });
    const stagedTts = await store.recordVoiceProbe({ sessionToken: token, expectedRevision: 5, stage: tts, latencyMs: 21 });
    assert.equal(stagedTts.draft.stage, "map");
    assert.deepEqual(stagedTts.replaced, []);
    assert.deepEqual((await store.activationCandidateForSession(token, 6))?.voice, {
      asr: { transport: asr.transport, endpoint: asr.endpoint, model: asr.model },
      tts: { transport: tts.transport, endpoint: tts.endpoint, credentialRef: tts.credentialRef, locale: tts.locale, voice: tts.voice, model: tts.model },
    });
    const source = await readFile(join(directory, "setup-draft.json"), "utf8");
    assert.equal(source.includes("raw-voice-credential"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires a durable credential staging lease before accepting credential-backed voice evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-draft-voice-lease-"));
  const token = "voice-lease-private-setup-session-token-value";
  const staged: ProductVoiceSetupStage = {
    kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9880",
    credentialRef: "keychain:hob-agent/voice:asr:draft-voice-lease:staged",
  };
  try {
    const store = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-voice-lease");
    await prepareVoiceStage(store, token, "draft-voice-lease");
    await assert.rejects(
      store.recordVoiceProbe({ sessionToken: token, expectedRevision: 4, stage: staged, latencyMs: 10 }),
      /staging lease/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps a setup draft in the voice stage while a credential staging lease is active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-draft-voice-staging-skip-"));
  const token = "voice-staging-skip-private-setup-session-token";
  const staged: ProductVoiceSetupStage = {
    kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9880",
    credentialRef: "keychain:hob-agent/voice:asr:draft-voice-staging-skip:staged",
  };
  try {
    const store = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-voice-staging-skip");
    await prepareVoiceStage(store, token, "draft-voice-staging-skip");
    await store.reserveVoiceCredential({ sessionToken: token, expectedRevision: 4, stage: staged });
    await assert.rejects(
      store.skipVoice({ sessionToken: token, expectedRevision: 4 }),
      /credential staging is active/,
    );
    assert.equal((await store.loadForSession(token))?.stage, "voice");
    assert.equal(await store.activationCandidateForSession(token, 4), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retires cold-start staging atomically while active voice credentials stay selected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-draft-voice-staging-retire-"));
  const token = "voice-staging-retire-private-setup-session-token";
  const active: ProductVoiceSetupStage = {
    kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9880",
    credentialRef: "keychain:hob-agent/voice:asr:draft-voice-staging-retire:active",
  };
  const orphaned: ProductVoiceSetupStage = {
    kind: "tts", transport: "openai_http", endpoint: "http://127.0.0.1:9881",
    credentialRef: "keychain:hob-agent/voice:tts:draft-voice-staging-retire:orphaned", locale: "zh-CN",
  };
  try {
    const store = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-voice-staging-retire");
    await prepareVoiceStage(store, token, "draft-voice-staging-retire");
    await store.reserveVoiceCredential({ sessionToken: token, expectedRevision: 4, stage: active });
    await store.recordVoiceProbe({ sessionToken: token, expectedRevision: 4, stage: active, latencyMs: 10 });
    await store.reserveVoiceCredential({ sessionToken: token, expectedRevision: 5, stage: orphaned });

    assert.equal(await store.retireVoiceStagingForRecovery(), 1);
    assert.deepEqual(await store.pendingVoiceStagingForRecovery(), []);
    assert.deepEqual(await store.pendingVoiceCleanupForMaintenance(), [orphaned]);
    assert.equal((await store.loadForSession(token))?.voice?.asr?.endpoint, active.endpoint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shares one bounded capacity across retired cleanup and in-flight staging", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-draft-voice-shared-capacity-"));
  const token = "voice-shared-capacity-private-setup-session-token";
  try {
    const store = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-voice-shared-capacity");
    await prepareVoiceStage(store, token, "draft-voice-shared-capacity");
    for (let index = 0; index < 5; index += 1) {
      const stage: ProductVoiceSetupStage = {
        kind: "asr", transport: "openai_http", endpoint: `http://127.0.0.1:${9880 + index}`,
        credentialRef: `keychain:hob-agent/voice:asr:draft-voice-shared-capacity:active-${index}`,
      };
      await store.reserveVoiceCredential({ sessionToken: token, expectedRevision: 4 + index, stage });
      await store.recordVoiceProbe({ sessionToken: token, expectedRevision: 4 + index, stage, latencyMs: 10 });
    }
    for (let index = 0; index < 4; index += 1) {
      const stage: ProductVoiceSetupStage = {
        kind: "tts", transport: "openai_http", endpoint: `http://127.0.0.1:${9980 + index}`,
        credentialRef: `keychain:hob-agent/voice:tts:draft-voice-shared-capacity:staging-${index}`, locale: "zh-CN",
      };
      await store.reserveVoiceCredential({ sessionToken: token, expectedRevision: 9, stage });
    }
    await assert.rejects(store.reserveVoiceCredential({
      sessionToken: token,
      expectedRevision: 9,
      stage: {
        kind: "tts", transport: "openai_http", endpoint: "http://127.0.0.1:9999",
        credentialRef: "keychain:hob-agent/voice:tts:draft-voice-shared-capacity:overflow", locale: "zh-CN",
      },
    }), /cleanup backlog is full/);

    assert.equal(await store.retireVoiceStagingForRecovery(), 4);
    assert.equal((await store.pendingVoiceCleanupForMaintenance()).length, 8);
    assert.deepEqual(await store.pendingVoiceStagingForRecovery(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports exact replaced and skipped voice stages for the controller to discard", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-draft-voice-discard-"));
  const token = "voice-discard-private-setup-session-token-value";
  try {
    const store = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-voice-discard-id");
    await prepareVoiceStage(store, token, "draft-voice-discard-id");
    const first: ProductVoiceSetupStage = { kind: "asr", transport: "wyoming", endpoint: "wyoming://voice.local:10700" };
    const second: ProductVoiceSetupStage = { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9880", credentialRef: "keychain:hob-agent/voice:asr:draft-voice-discard-id:asr-two" };
    await store.recordVoiceProbe({ sessionToken: token, expectedRevision: 4, stage: first, latencyMs: 9 });
    await store.reserveVoiceCredential({ sessionToken: token, expectedRevision: 5, stage: second });
    assert.deepEqual(
      (await store.recordVoiceProbe({ sessionToken: token, expectedRevision: 5, stage: second, latencyMs: 10 })).replaced,
      [first],
    );
    await assert.rejects(
      store.recordVoiceProbe({
        sessionToken: token,
        expectedRevision: 6,
        latencyMs: 1,
        stage: { ...first, credential: "raw-voice-credential" } as ProductVoiceSetupStage,
      }),
      /Voice setup stage is invalid/,
    );
    const skipped = await store.skipVoice({ sessionToken: token, expectedRevision: 6 });
    assert.equal(skipped.draft.stage, "map");
    assert.deepEqual(skipped.replaced, [second]);
    assert.equal((await store.activationCandidateForSession(token, 7))?.voice, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maintains only retired voice credentials after the setup session expires", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-draft-voice-maintenance-"));
  const token = "voice-maintenance-private-setup-session-token";
  let now = new Date("2026-08-23T02:00:00.000Z");
  const retired: ProductVoiceSetupStage = {
    kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9881",
    credentialRef: "keychain:hob-agent/voice:asr:draft-voice-maintenance:retired",
  };
  const active: ProductVoiceSetupStage = {
    kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9882",
    credentialRef: "keychain:hob-agent/voice:asr:draft-voice-maintenance:active",
  };
  try {
    const store = new ProductSetupDraftStore(directory, () => now, () => "draft-voice-maintenance");
    await prepareVoiceStage(store, token, "draft-voice-maintenance");
    await store.reserveVoiceCredential({ sessionToken: token, expectedRevision: 4, stage: retired });
    await store.recordVoiceProbe({ sessionToken: token, expectedRevision: 4, stage: retired, latencyMs: 10 });
    await store.reserveVoiceCredential({ sessionToken: token, expectedRevision: 5, stage: active });
    await store.recordVoiceProbe({ sessionToken: token, expectedRevision: 5, stage: active, latencyMs: 11 });

    now = new Date("2026-08-23T15:00:00.000Z");
    const restarted = new ProductSetupDraftStore(directory, () => now, () => "unused-id");
    assert.equal(await restarted.loadForSession(token), undefined);
    assert.deepEqual(await restarted.pendingVoiceCleanupForMaintenance(), [retired]);

    await restarted.ackVoiceCleanupForMaintenance(retired);
    assert.deepEqual(await restarted.pendingVoiceCleanupForMaintenance(), []);
    const source = await readFile(join(directory, "setup-draft.json"), "utf8");
    assert.equal(source.includes(retired.credentialRef!), false);
    assert.equal(source.includes(active.credentialRef!), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stores a canonical OpenAI root and rejects a Wyoming TTS model in setup evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-draft-voice-contract-"));
  const token = "voice-contract-private-setup-session-token-value";
  try {
    const store = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-voice-contract");
    await prepareVoiceStage(store, token, "draft-voice-contract");
    const staged = await store.recordVoiceProbe({
      sessionToken: token,
      expectedRevision: 4,
      latencyMs: 10,
      stage: { kind: "asr", transport: "openai_http", endpoint: "https://voice.example.test/v1/" },
    });
    assert.deepEqual(staged.draft.voice, {
      asr: { transport: "openai_http", endpoint: "https://voice.example.test", probeLatencyMs: 10 },
    });
    await assert.rejects(store.recordVoiceProbe({
      sessionToken: token,
      expectedRevision: 5,
      latencyMs: 10,
      stage: { kind: "tts", transport: "wyoming", endpoint: "wyoming://127.0.0.1:10700", locale: "zh-CN", model: "unsupported-model-field" },
    }), /Voice setup stage is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads a completed v1 map draft without adding a voice configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-draft-v1-voice-"));
  const token = "legacy-map-private-setup-session-token-value";
  try {
    const store = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-legacy-map-id");
    await prepareVoiceStage(store, token, "draft-legacy-map-id");
    await store.skipVoice({ sessionToken: token, expectedRevision: 4 });
    const path = join(directory, "setup-draft.json");
    const legacy = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    legacy.version = "hob.setup-draft/v1";
    delete legacy.voiceSkipped;
    await writeFile(path, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    assert.equal((await store.activationCandidateForSession(token, 5))?.voice, undefined);
    await store.establishSession({ sessionToken: token, sessionExpiresAt: new Date("2026-08-23T15:00:00.000Z") });
    const migrated = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.equal(migrated.version, "hob.setup-draft/v2");
    assert.equal(migrated.voiceSkipped, true);
    assert.equal((await store.activationCandidateForSession(token, 5))?.voice, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects v1 drafts that contain voice-stage or voice-cleanup fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-draft-v1-voice-reject-"));
  const token = "legacy-voice-reject-private-setup-session-token";
  try {
    const store = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-legacy-voice-reject");
    await prepareVoiceStage(store, token, "draft-legacy-voice-reject");
    await store.skipVoice({ sessionToken: token, expectedRevision: 4 });
    const path = join(directory, "setup-draft.json");
    const legacy = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    legacy.version = "hob.setup-draft/v1";
    delete legacy.voiceSkipped;
    const forbiddenVoiceFields: Readonly<Record<string, unknown>> = {
      voice: { asr: { transport: "openai_http", endpoint: "http://voice.local", credentialRef: "keychain:hob-agent/voice:asr:draft-legacy-voice-reject:stage" } },
      voiceProbeLatencyMs: { asr: 10 },
      voiceSkipped: true,
      voiceCleanup: [{ kind: "asr", transport: "openai_http", endpoint: "http://voice.local", credentialRef: "keychain:hob-agent/voice:asr:draft-legacy-voice-reject:stage" }],
    };
    for (const [field, fieldValue] of Object.entries(forbiddenVoiceFields)) {
      const invalid = { ...legacy, [field]: fieldValue };
      await writeFile(path, `${JSON.stringify(invalid)}\n`, { mode: 0o600 });
      await assert.rejects(store.loadForSession(token), /Setup voice evidence is invalid/);
    }
    legacy.stage = "voice";
    await writeFile(path, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    await assert.rejects(store.loadForSession(token), /Setup voice evidence is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resumes v1 identity and bridge drafts through the new voice setup path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-draft-v1-resume-"));
  const token = "legacy-resume-private-setup-session-token-value";
  const now = () => new Date("2026-08-23T02:00:00.000Z");
  try {
    const identityStore = new ProductSetupDraftStore(directory, now, () => "draft-legacy-resume-id");
    await identityStore.establishSession({ sessionToken: token, sessionExpiresAt: new Date("2026-08-23T14:00:00.000Z") });
    const path = join(directory, "setup-draft.json");
    const identity = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    identity.version = "hob.setup-draft/v1";
    await writeFile(path, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
    const resumedIdentity = new ProductSetupDraftStore(directory, now, () => "unused-id");
    assert.equal((await resumedIdentity.loadForSession(token))?.stage, "identity");
    await resumedIdentity.saveIdentity({ sessionToken: token, expectedRevision: 1, householdName: "测试家", agentName: "测试助手" });
    await resumedIdentity.recordModelProbe({
      sessionToken: token, expectedRevision: 2, latencyMs: 20,
      stage: { profile: { id: "custom:setup:draft-legacy-resume-id", provider: "custom", kind: "api_key", secretRef: "keychain:hob-agent/setup-model:draft-legacy-resume-id:stage-1" }, modelId: "fixture-model" },
    });
    const bridge = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    bridge.version = "hob.setup-draft/v1";
    await writeFile(path, `${JSON.stringify(bridge)}\n`, { mode: 0o600 });
    const resumedBridge = new ProductSetupDraftStore(directory, now, () => "unused-id");
    assert.equal((await resumedBridge.loadForSession(token))?.stage, "bridge");
    assert.equal((await resumedBridge.recordBridgeProbe({
      sessionToken: token, expectedRevision: 3, latencyMs: 25, summary: { states: 5, entities: 4, devices: 3, areas: 2 },
      stage: { bridgeId: "bridge-abcdef0123456789", adapterType: "fixture-peer", label: "Fixture peer", config: { room: "lab" }, credentialRefs: { session: "keychain:hob-agent/bridge:bridge-abcdef0123456789:session" } },
    })).stage, "voice");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function prepareVoiceStage(store: ProductSetupDraftStore, token: string, draftId = "draft-voice-id"): Promise<void> {
  await store.establishSession({ sessionToken: token, sessionExpiresAt: new Date("2026-08-23T14:00:00.000Z") });
  await store.saveIdentity({ sessionToken: token, expectedRevision: 1, householdName: "测试家", agentName: "测试助手" });
  await store.recordModelProbe({
    sessionToken: token, expectedRevision: 2, latencyMs: 20,
    stage: { profile: { id: `custom:setup:${draftId}`, provider: "custom", kind: "api_key", secretRef: `keychain:hob-agent/setup-model:${draftId}:stage-1` }, modelId: "fixture-model" },
  });
  const bridge = await store.recordBridgeProbe({
    sessionToken: token, expectedRevision: 3, latencyMs: 25, summary: { states: 5, entities: 4, devices: 3, areas: 2 },
    stage: { bridgeId: "bridge-abcdef0123456789", adapterType: "fixture-peer", label: "Fixture peer", config: { room: "lab" }, credentialRefs: { session: "keychain:hob-agent/bridge:bridge-abcdef0123456789:session" } },
  });
  assert.equal(bridge.stage, "voice");
}
