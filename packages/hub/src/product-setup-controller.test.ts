import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProductModelSetupInput, ProductModelSetupStage } from "./product-model-setup.js";
import { ProductModelSetup } from "./product-model-setup.js";
import { ProductVoiceSetup, type ProductVoiceSetupStage } from "./product-voice-setup.js";
import { ProductSetupController } from "./product-setup-controller.js";
import { ProductSetupDraftStore } from "./product-setup-draft-store.js";

test("binds a ready model probe to the exact durable setup revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-controller-"));
  const token = "controller-private-setup-session-token-value";
  const probed: ProductModelSetupInput[] = [];
  const discarded: ProductModelSetupStage[] = [];
  const bridgeCalls: string[] = [];
  const bridgeStage = {
    bridgeId: "bridge-fedcba9876543210",
    adapterType: "fixture-peer",
    label: "Fixture peer",
    config: { endpoint: "fixture://peer.local" },
    credentialRefs: { session: "keychain:hob-agent/bridge:bridge-fedcba9876543210:session" },
  };
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
      prepare: (input) => {
        probed.push(input);
        return { status: "prepared" as const, prepared: {
          provider: "custom" as const,
          modelId: "deepseek-v4-flash-0731",
          baseURL: "https://model.example.test/v1",
          apiKey: "request-local-model-secret",
        } };
      },
      stageSetup: () => stage,
      execute: async ({ stage: staged, credentialLease }) => {
        assert.equal(staged, stage);
        assert.equal(credentialLease.stage, stage);
        return { status: "ready" as const, latencyMs: 35, staged: stage };
      },
      discard: async (input) => { discarded.push(input); },
    },
    {
      prepare: (input) => {
        bridgeCalls.push("prepare");
        assert.deepEqual(input, {
          setupId: "draft-controller", adapterType: "fixture-peer",
          config: { endpoint: "fixture://peer.local" }, credential: "request-local-bridge-secret",
        });
        return { status: "prepared" as const, prepared: {
          adapterType: "fixture-peer", label: "Fixture peer", config: { endpoint: "fixture://peer.local" },
          credentialAlias: "session", credential: "request-local-bridge-secret",
        } };
      },
      stageSetup: () => {
        bridgeCalls.push("stage");
        return bridgeStage;
      },
      execute: async ({ stage, credentialLease }) => {
        bridgeCalls.push("execute");
        assert.equal(stage, bridgeStage);
        assert.equal(credentialLease.stage, bridgeStage);
        return {
          status: "ready" as const,
          latencyMs: 22,
          summary: { states: 10, entities: 9, devices: 4, areas: 2 },
          review: {
            areas: [{ name: "客厅", deviceCount: 3 }, { name: "卧室", deviceCount: 0 }],
            unassignedDeviceCount: 1,
            complete: true,
          },
          stage: bridgeStage,
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
    assert.deepEqual(bridgeCalls, ["prepare", "stage", "execute"]);
    assert.deepEqual(bridge.status === "ready" ? bridge.draft.bridge?.review : undefined, {
      areas: [{ name: "客厅", deviceCount: 3 }, { name: "卧室", deviceCount: 0 }],
      unassignedDeviceCount: 1,
      complete: true,
    });
    const skipped = await controller.skipVoice({ sessionToken: token, expectedRevision: 4 });
    assert.equal(skipped.stage, "map");
    assert.deepEqual(await controller.activationCandidateForSession(token, 5), {
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
    assert.equal(await controller.activationCandidateForSession(token, 4), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancelling a model setup probe waits for its provider and removes the exact staged credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-controller-model-cancel-"));
  const token = "controller-model-cancel-private-token";
  const stage: ProductModelSetupStage = {
    profile: {
      id: "custom:setup:draft-model-cancel",
      provider: "custom",
      kind: "api_key",
      secretRef: "keychain:hob-agent/setup-model:draft-model-cancel:stage-1",
    },
    modelId: "fixture-model",
  };
  let signalSeen: AbortSignal | undefined;
  let beginProbe: (() => void) | undefined;
  let finishProbe: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { beginProbe = resolve; });
  const settled = new Promise<void>((resolve) => { finishProbe = resolve; });
  const discarded: ProductModelSetupStage[] = [];
  try {
    const drafts = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-model-cancel");
    await drafts.establishSession({ sessionToken: token, sessionExpiresAt: new Date("2026-08-23T14:00:00.000Z") });
    await drafts.saveIdentity({ sessionToken: token, expectedRevision: 1, householdName: "测试家", agentName: "测试助手" });
    const controller = new ProductSetupController(
      drafts,
      {
        prepare: () => ({ status: "prepared" as const, prepared: { provider: "custom" as const, modelId: "fixture-model", apiKey: "request-local-model-secret" } }),
        stageSetup: () => stage,
        execute: async ({ signal }) => {
          signalSeen = signal;
          beginProbe?.();
          await settled;
          return { status: "ready" as const, latencyMs: 12, staged: stage };
        },
        discard: async (candidate) => { discarded.push(candidate); },
      },
      unavailableBridgeSetup(),
    );
    const abort = new AbortController();
    const probing = controller.probeModel({
      sessionToken: token,
      expectedRevision: 2,
      provider: "custom",
      modelId: "fixture-model",
      apiKey: "request-local-model-secret",
      signal: abort.signal,
    });
    await started;
    abort.abort();
    let complete = false;
    void probing.finally(() => { complete = true; }).catch(() => undefined);
    await Promise.resolve();
    assert.equal(complete, false);
    finishProbe?.();

    assert.deepEqual(await probing, { status: "unavailable" });
    assert.equal(signalSeen, abort.signal);
    assert.deepEqual(discarded, [stage]);
    assert.deepEqual(await drafts.loadForSession(token), {
      draftId: "draft-model-cancel",
      revision: 2,
      stage: "model",
      householdName: "测试家",
      agentName: "测试助手",
    });
  } finally {
    finishProbe?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retires the exact bridge lease when its probe does not produce durable bridge evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-controller-bridge-cleanup-"));
  const token = "controller-bridge-cleanup-private-token";
  const stage = {
    bridgeId: "bridge-0123456789abcdef", adapterType: "fixture-peer", label: "Fixture peer",
    config: { endpoint: "fixture://peer.local" },
    credentialRefs: { session: "keychain:hob-agent/bridge:bridge-0123456789abcdef:session" },
  };
  const discarded: typeof stage[] = [];
  try {
    const drafts = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-bridge-cleanup");
    await drafts.establishSession({ sessionToken: token, sessionExpiresAt: new Date("2026-08-23T14:00:00.000Z") });
    await drafts.saveIdentity({ sessionToken: token, expectedRevision: 1, householdName: "测试家", agentName: "测试助手" });
    const model = { profile: { id: "custom:setup:draft-bridge-cleanup", provider: "custom" as const, kind: "api_key" as const, secretRef: "keychain:hob-agent/setup-model:draft-bridge-cleanup:one" }, modelId: "fixture" };
    await drafts.reserveModelCredential({ sessionToken: token, expectedRevision: 2, stage: model });
    await drafts.recordModelProbe({ sessionToken: token, expectedRevision: 2, stage: model, latencyMs: 1 });
    const controller = new ProductSetupController(drafts, unavailableModelSetup(), {
      prepare: () => ({ status: "prepared" as const, prepared: {
        adapterType: "fixture-peer", label: "Fixture peer", config: stage.config,
        credentialAlias: "session", credential: "request-local-bridge-secret",
      } }),
      stageSetup: () => stage,
      execute: async () => ({ status: "credential_rejected" as const }),
      discard: async (candidate) => { discarded.push(candidate); },
    }, unavailableVoiceSetup(() => undefined));

    assert.deepEqual(await controller.probeBridge({
      sessionToken: token, expectedRevision: 3, adapterType: "fixture-peer",
      config: stage.config, credential: "request-local-bridge-secret",
    }), { status: "credential_rejected" });
    assert.deepEqual(discarded, [stage]);
    assert.deepEqual(await drafts.pendingBridgeStagingForRecovery(), []);
    assert.deepEqual(await drafts.pendingBridgeCleanupForMaintenance(), []);
    assert.equal((await drafts.loadForSession(token))?.stage, "bridge");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("moves a failed model probe to durable cleanup when its immediate delete fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-controller-model-cleanup-"));
  const sessionToken = "controller-model-cleanup-private-session-token";
  const vault = new ToggleModelVault();
  vault.deleteAvailable = false;
  try {
    const drafts = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-model-cleanup");
    await drafts.establishSession({ sessionToken, sessionExpiresAt: new Date("2026-08-23T14:00:00.000Z") });
    await drafts.saveIdentity({ sessionToken, expectedRevision: 1, householdName: "测试家", agentName: "测试助手" });
    const failing = new ProductSetupController(
      drafts,
      new ProductModelSetup({
        vault,
        createStageNonce: () => "delete-fails",
        probe: async () => ({ model: "gpt/gpt-5", status: "auth", latencyMs: 4 }),
      }),
      unavailableBridgeSetup(),
      unavailableVoiceSetup(() => undefined),
    );

    assert.deepEqual(await failing.probeModel({
      sessionToken,
      expectedRevision: 2,
      provider: "gpt",
      modelId: "gpt-5",
      apiKey: "request-local-model-secret",
    }), { status: "rejected" });
    const stage: ProductModelSetupStage = {
      profile: { id: "gpt:setup:draft-model-cleanup", provider: "gpt", kind: "api_key", secretRef: "keychain:hob-agent/setup-model:draft-model-cleanup:delete-fails" },
      modelId: "gpt-5",
    };
    assert.deepEqual(await drafts.pendingModelCleanupForMaintenance(), [stage]);

    vault.deleteAvailable = true;
    const restarted = new ProductSetupController(
      new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "unused-id"),
      new ProductModelSetup({ vault }),
      unavailableBridgeSetup(),
      unavailableVoiceSetup(() => undefined),
    );
    await restarted.loadForSession(sessionToken);
    assert.deepEqual(await drafts.pendingModelCleanupForMaintenance(), []);
    assert.equal(vault.values.has(stage.profile.secretRef!), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent model probes for one draft behind the durable staging lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-controller-model-concurrency-"));
  const sessionToken = "controller-model-concurrency-private-session-token";
  const vault = new ToggleModelVault();
  let releaseProbe: (() => void) | undefined;
  let signalProbeStarted: (() => void) | undefined;
  const probeStarted = new Promise<void>((resolve) => { signalProbeStarted = resolve; });
  const probeReleased = new Promise<void>((resolve) => { releaseProbe = resolve; });
  try {
    const drafts = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-model-concurrency");
    await drafts.establishSession({ sessionToken, sessionExpiresAt: new Date("2026-08-23T14:00:00.000Z") });
    await drafts.saveIdentity({ sessionToken, expectedRevision: 1, householdName: "测试家", agentName: "测试助手" });
    const controller = new ProductSetupController(
      drafts,
      new ProductModelSetup({
        vault,
        createStageNonce: () => "in-flight",
        probe: async () => {
          signalProbeStarted?.();
          await probeReleased;
          return { model: "gpt/gpt-5", status: "ok", latencyMs: 4 };
        },
      }),
      unavailableBridgeSetup(),
      unavailableVoiceSetup(() => undefined),
    );
    const input = { sessionToken, expectedRevision: 2, provider: "gpt", modelId: "gpt-5", apiKey: "request-local-model-secret" } as const;
    const first = controller.probeModel(input);
    await probeStarted;
    const second = controller.probeModel(input);
    let secondSettled = false;
    void second.finally(() => { secondSettled = true; }).catch(() => undefined);
    await Promise.resolve();
    assert.equal(secondSettled, false);
    releaseProbe?.();
    assert.equal((await first).status, "ready");
    assert.deepEqual(await second, { status: "conflict" });
    assert.equal(vault.values.size, 1);
    assert.deepEqual(await drafts.pendingModelCleanupForMaintenance(), []);
  } finally {
    releaseProbe?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("removes a newly staged credential when its setup revision changes before voice evidence is recorded", async () => {
  const asrStage: ProductVoiceSetupStage = {
    kind: "asr",
    transport: "openai_http",
    endpoint: "http://127.0.0.1:9880",
    credentialRef: "keychain:hob-agent/voice:asr:draft-voice:asr-stage",
    model: "gpt-4o-mini-transcribe",
  };
  const discarded: ProductVoiceSetupStage[] = [];
  const voiceCalls: unknown[] = [];
  const drafts = {
    loadForSession: async () => ({ draftId: "draft-voice", revision: 4, stage: "voice" as const }),
    reserveVoiceCredential: async () => undefined,
    recordVoiceProbe: async () => { throw new Error("Setup draft revision conflict"); },
  } as unknown as ProductSetupDraftStore;
  const controller = new ProductSetupController(
    drafts,
    unavailableModelSetup(),
    { probe: async () => ({ status: "incompatible" as const }), discard: async () => undefined },
    {
      prepare: (input) => {
        voiceCalls.push(input);
        return { status: "prepared" as const, prepared: { stage: asrStage, credential: "request-local-voice-secret" } };
      },
      execute: async () => ({ status: "ready" as const, latencyMs: 41, staged: asrStage }),
      discard: async (stage) => { discarded.push(stage); },
    },
  );

  const result = await controller.probeVoice({
    sessionToken: "controller-private-setup-session-token-value",
    expectedRevision: 4,
    track: {
      kind: "asr",
      transport: "openai_http",
      endpoint: "http://127.0.0.1:9880",
      credential: "request-local-voice-secret",
      model: "gpt-4o-mini-transcribe",
    },
  });

  assert.deepEqual(result, { status: "conflict" });
  assert.deepEqual(voiceCalls, [{
    setupId: "draft-voice",
    track: {
      kind: "asr",
      transport: "openai_http",
      endpoint: "http://127.0.0.1:9880",
      credential: "request-local-voice-secret",
      model: "gpt-4o-mini-transcribe",
    },
  }]);
  assert.deepEqual(discarded, [asrStage]);
});

test("recovers an exact credential written before a process stops before voice evidence is recorded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-controller-voice-staging-restart-"));
  const token = "controller-voice-staging-restart-private-token";
  const vault = new VoiceMemoryVault();
  try {
    const drafts = new ProductSetupDraftStore(
      directory,
      () => new Date("2026-08-23T02:00:00.000Z"),
      () => "draft-voice-staging-restart",
    );
    await prepareVoiceDraft(drafts, token, "draft-voice-staging-restart");
    const setup = new ProductVoiceSetup({
      vault,
      createStageNonce: () => "written-before-record",
      probe: async () => ({ status: "ready", latencyMs: 12 }),
    });
    const preparation = setup.prepare({
      setupId: "draft-voice-staging-restart",
      track: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9880", credential: "request-local-secret" },
    });
    if (preparation.status !== "prepared") assert.fail("expected prepared voice credential");
    await assert.rejects(
      setup.execute({ prepared: preparation.prepared, credentialLease: { stage: preparation.prepared.stage } as never }),
      /durable staging lease/,
    );
    assert.equal(vault.values.size, 0);
    const credentialLease = await drafts.reserveVoiceCredential({
      sessionToken: token,
      expectedRevision: 4,
      stage: preparation.prepared.stage,
    });
    const probed = await setup.execute({
      prepared: preparation.prepared,
      credentialLease,
    });
    assert.equal(probed.status, "ready");
    assert.equal(vault.values.has(preparation.prepared.stage.credentialRef!), true);

    const restarted = new ProductSetupController(
      new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "unused-id"),
      unavailableModelSetup(),
      unavailableBridgeSetup(),
      setup,
    );
    await restarted.recoverVoiceCredentialStaging();
    await restarted.sweepVoiceCredentialCleanup();
    assert.equal(vault.values.has(preparation.prepared.stage.credentialRef!), false);
    assert.deepEqual(await drafts.pendingVoiceCleanupForMaintenance(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("promotes a leased credential into active voice evidence and leaves it outside cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-controller-voice-active-"));
  const token = "controller-voice-active-private-token";
  const vault = new VoiceMemoryVault();
  try {
    const drafts = new ProductSetupDraftStore(
      directory,
      () => new Date("2026-08-23T02:00:00.000Z"),
      () => "draft-voice-active",
    );
    await prepareVoiceDraft(drafts, token, "draft-voice-active");
    const voice = new ProductVoiceSetup({
      vault,
      createStageNonce: () => "active-voice",
      probe: async () => ({ status: "ready", latencyMs: 12 }),
    });
    const controller = new ProductSetupController(drafts, unavailableModelSetup(), unavailableBridgeSetup(), voice);
    const result = await controller.probeVoice({
      sessionToken: token,
      expectedRevision: 4,
      track: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9880", credential: "request-local-secret" },
    });
    assert.equal(result.status, "ready");
    const reference = "keychain:hob-agent/voice:asr:draft-voice-active:active-voice";
    assert.equal(vault.values.has(reference), true);
    assert.deepEqual(await drafts.pendingVoiceCleanupForMaintenance(), []);

    await controller.loadForSession(token);
    assert.equal(vault.values.has(reference), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removes and acknowledges a credential lease immediately when its voice probe is rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-controller-voice-rejected-"));
  const token = "controller-voice-rejected-private-token";
  const vault = new VoiceMemoryVault();
  try {
    const drafts = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-voice-rejected");
    await prepareVoiceDraft(drafts, token, "draft-voice-rejected");
    const controller = new ProductSetupController(
      drafts,
      unavailableModelSetup(),
      unavailableBridgeSetup(),
      new ProductVoiceSetup({
        vault,
        createStageNonce: () => "rejected",
        probe: async () => ({ status: "credential_rejected" }),
      }),
    );
    assert.deepEqual(await controller.probeVoice({
      sessionToken: token,
      expectedRevision: 4,
      track: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9880", credential: "request-local-secret" },
    }), { status: "credential_rejected" });
    assert.equal(vault.values.size, 0);
    assert.deepEqual(await drafts.pendingVoiceStagingForRecovery(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("moves cold-start staging into retired cleanup so the same process can retry a failed delete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-controller-voice-rejected-recovery-"));
  const token = "controller-voice-rejected-recovery-private-token";
  const vault = new ToggleVoiceVault();
  try {
    const drafts = new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "draft-voice-rejected-recovery");
    await prepareVoiceDraft(drafts, token, "draft-voice-rejected-recovery");
    const setup = new ProductVoiceSetup({
      vault,
      createStageNonce: () => "rejected",
      probe: async () => ({ status: "credential_rejected" }),
    });
    const controller = new ProductSetupController(drafts, unavailableModelSetup(), unavailableBridgeSetup(), setup);
    vault.deleteAvailable = false;
    assert.equal((await controller.probeVoice({
      sessionToken: token,
      expectedRevision: 4,
      track: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9880", credential: "request-local-secret" },
    })).status, "credential_rejected");
    assert.equal((await drafts.pendingVoiceStagingForRecovery()).length, 1);

    const restarted = new ProductSetupController(
      new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "unused-id"),
      unavailableModelSetup(),
      unavailableBridgeSetup(),
      setup,
    );
    await restarted.recoverVoiceCredentialStaging();
    assert.equal((await drafts.pendingVoiceStagingForRecovery()).length, 0);
    assert.equal((await drafts.pendingVoiceCleanupForMaintenance()).length, 1);

    vault.deleteAvailable = true;
    await restarted.sweepVoiceCredentialCleanup();
    assert.equal(vault.values.size, 0);
    assert.deepEqual(await drafts.pendingVoiceCleanupForMaintenance(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps an in-flight staging lease intact while another setup request sweeps retired credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-controller-voice-staging-concurrency-"));
  const token = "controller-voice-staging-concurrency-private-token";
  const vault = new VoiceMemoryVault();
  try {
    const drafts = new ProductSetupDraftStore(
      directory,
      () => new Date("2026-08-23T02:00:00.000Z"),
      () => "draft-voice-staging-concurrency",
    );
    await prepareVoiceDraft(drafts, token, "draft-voice-staging-concurrency");
    const voice = new ProductVoiceSetup({
      vault,
      createStageNonce: () => "in-flight",
      probe: async () => ({ status: "ready", latencyMs: 12 }),
    });
    const preparation = voice.prepare({
      setupId: "draft-voice-staging-concurrency",
      track: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9880", credential: "request-local-secret" },
    });
    if (preparation.status !== "prepared") assert.fail("expected prepared voice credential");
    const credentialLease = await drafts.reserveVoiceCredential({ sessionToken: token, expectedRevision: 4, stage: preparation.prepared.stage });
    await voice.execute({ prepared: preparation.prepared, credentialLease });

    const concurrentRequest = new ProductSetupController(drafts, unavailableModelSetup(), unavailableBridgeSetup(), voice);
    await concurrentRequest.loadForSession(token);
    assert.equal(vault.values.has(preparation.prepared.stage.credentialRef!), true);
    assert.deepEqual(await drafts.pendingVoiceStagingForRecovery(), [preparation.prepared.stage]);

    await drafts.recordVoiceProbe({
      sessionToken: token,
      expectedRevision: 4,
      stage: preparation.prepared.stage,
      latencyMs: 12,
    });
    assert.deepEqual(await drafts.pendingVoiceStagingForRecovery(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes skip behind an in-flight voice probe and preserves the completed voice revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-controller-voice-skip-concurrency-"));
  const token = "controller-voice-skip-concurrency-private-token";
  const vault = new VoiceMemoryVault();
  let releaseProbe: (() => void) | undefined;
  let signalProbeStarted: (() => void) | undefined;
  const probeStarted = new Promise<void>((resolve) => { signalProbeStarted = resolve; });
  const probeReleased = new Promise<void>((resolve) => { releaseProbe = resolve; });
  try {
    const drafts = new ProductSetupDraftStore(
      directory,
      () => new Date("2026-08-23T02:00:00.000Z"),
      () => "draft-voice-skip-concurrency",
    );
    await prepareVoiceDraft(drafts, token, "draft-voice-skip-concurrency");
    const controller = new ProductSetupController(
      drafts,
      unavailableModelSetup(),
      unavailableBridgeSetup(),
      new ProductVoiceSetup({
        vault,
        createStageNonce: () => "in-flight",
        probe: async () => {
          signalProbeStarted?.();
          await probeReleased;
          return { status: "ready", latencyMs: 12 };
        },
      }),
    );
    const probe = controller.probeVoice({
      sessionToken: token,
      expectedRevision: 4,
      track: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9880", credential: "request-local-secret" },
    });
    await probeStarted;
    const skip = controller.skipVoice({ sessionToken: token, expectedRevision: 4 });
    let skipSettled = false;
    void skip.finally(() => { skipSettled = true; }).catch(() => undefined);
    await Promise.resolve();
    assert.equal(skipSettled, false);

    releaseProbe?.();
    assert.equal((await probe).status, "ready");
    await assert.rejects(skip, /revision conflict/);
    const latest = await drafts.loadForSession(token);
    assert.equal(latest?.stage, "voice");
    assert.equal(latest?.revision, 5);
    assert.equal(await drafts.activationCandidateForSession(token, 5), undefined);
    const source = await readFile(join(directory, "setup-draft.json"), "utf8");
    assert.equal(source.includes("request-local-secret"), false);
  } finally {
    releaseProbe?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps the verified voice result when cleanup of an older credential fails", async () => {
  const asrStage: ProductVoiceSetupStage = {
    kind: "asr",
    transport: "openai_http",
    endpoint: "http://127.0.0.1:9880",
    credentialRef: "keychain:hob-agent/voice:asr:draft-voice:next-stage",
  };
  const olderStage: ProductVoiceSetupStage = {
    kind: "asr",
    transport: "openai_http",
    endpoint: "http://127.0.0.1:9881",
    credentialRef: "keychain:hob-agent/voice:asr:draft-voice:older-stage",
  };
  const drafts = {
    loadForSession: async () => ({ draftId: "draft-voice", revision: 4, stage: "voice" as const }),
    reserveVoiceCredential: async () => undefined,
    recordVoiceProbe: async () => ({
      draft: { draftId: "draft-voice", revision: 5, stage: "voice" as const },
      replaced: [olderStage],
    }),
    skipVoice: async () => ({
      draft: { draftId: "draft-voice", revision: 5, stage: "map" as const },
      replaced: [olderStage],
    }),
  } as unknown as ProductSetupDraftStore;
  const controller = new ProductSetupController(
    drafts,
    unavailableModelSetup(),
    { probe: async () => ({ status: "incompatible" as const }), discard: async () => undefined },
    {
      prepare: () => ({ status: "prepared" as const, prepared: { stage: asrStage } }),
      execute: async () => ({ status: "ready" as const, latencyMs: 41, staged: asrStage }),
      discard: async () => { throw new Error("keychain cleanup unavailable"); },
    },
  );

  const verified = await controller.probeVoice({
    sessionToken: "controller-private-setup-session-token-value",
    expectedRevision: 4,
    track: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9880" },
  });
  assert.deepEqual(verified, { status: "ready", draft: { draftId: "draft-voice", revision: 5, stage: "voice" } });

  const skipped = await controller.skipVoice({
    sessionToken: "controller-private-setup-session-token-value",
    expectedRevision: 4,
  });
  assert.deepEqual(skipped, { draftId: "draft-voice", revision: 5, stage: "map" });
});

test("retries a failed replaced voice credential cleanup after restart without repeating a successful delete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-controller-voice-cleanup-restart-"));
  const token = "controller-voice-cleanup-restart-private-token";
  const olderStage: ProductVoiceSetupStage = {
    kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9881",
    credentialRef: "keychain:hob-agent/voice:asr:draft-voice-cleanup-restart:older-stage",
  };
  const nextStage: ProductVoiceSetupStage = {
    kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9882",
    credentialRef: "keychain:hob-agent/voice:asr:draft-voice-cleanup-restart:next-stage",
  };
  const discarded: ProductVoiceSetupStage[] = [];
  try {
    const drafts = new ProductSetupDraftStore(
      directory,
      () => new Date("2026-08-23T02:00:00.000Z"),
      () => "draft-voice-cleanup-restart",
    );
    await prepareVoiceDraft(drafts, token, "draft-voice-cleanup-restart");
    await drafts.reserveVoiceCredential({ sessionToken: token, expectedRevision: 4, stage: olderStage });
    await drafts.recordVoiceProbe({ sessionToken: token, expectedRevision: 4, stage: olderStage, latencyMs: 10 });

    const failingController = new ProductSetupController(
      drafts,
      unavailableModelSetup(),
      unavailableBridgeSetup(),
      {
        prepare: () => ({ status: "prepared" as const, prepared: { stage: nextStage } }),
        execute: async () => ({ status: "ready" as const, latencyMs: 12, staged: nextStage }),
        discard: async (stage) => {
          assert.deepEqual(stage, olderStage);
          throw new Error("keychain unavailable");
        },
      },
    );
    assert.equal((await failingController.probeVoice({
      sessionToken: token,
      expectedRevision: 5,
      track: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9882" },
    })).status, "ready");

    const restartedController = new ProductSetupController(
      new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "unused-id"),
      unavailableModelSetup(),
      unavailableBridgeSetup(),
      unavailableVoiceSetup((stage) => { discarded.push(stage); }),
    );
    assert.equal((await restartedController.loadForSession(token))?.revision, 6);
    assert.deepEqual(discarded, [olderStage]);
    await restartedController.loadForSession(token);
    assert.deepEqual(discarded, [olderStage]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries a failed skipped voice credential cleanup on the next setup load", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-controller-voice-cleanup-skip-"));
  const token = "controller-voice-cleanup-skip-private-token";
  const staged: ProductVoiceSetupStage = {
    kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9880",
    credentialRef: "keychain:hob-agent/voice:asr:draft-voice-cleanup-skip:staged",
  };
  const discarded: ProductVoiceSetupStage[] = [];
  try {
    const drafts = new ProductSetupDraftStore(
      directory,
      () => new Date("2026-08-23T02:00:00.000Z"),
      () => "draft-voice-cleanup-skip",
    );
    await prepareVoiceDraft(drafts, token, "draft-voice-cleanup-skip");
    await drafts.reserveVoiceCredential({ sessionToken: token, expectedRevision: 4, stage: staged });
    await drafts.recordVoiceProbe({ sessionToken: token, expectedRevision: 4, stage: staged, latencyMs: 10 });
    const failingController = new ProductSetupController(
      drafts,
      unavailableModelSetup(),
      unavailableBridgeSetup(),
      unavailableVoiceSetup(() => { throw new Error("keychain unavailable"); }),
    );
    assert.equal((await failingController.skipVoice({ sessionToken: token, expectedRevision: 5 })).stage, "map");

    const retryingController = new ProductSetupController(
      new ProductSetupDraftStore(directory, () => new Date("2026-08-23T02:00:00.000Z"), () => "unused-id"),
      unavailableModelSetup(),
      unavailableBridgeSetup(),
      unavailableVoiceSetup((stage) => { discarded.push(stage); }),
    );
    assert.equal((await retryingController.loadForSession(token))?.stage, "map");
    assert.deepEqual(discarded, [staged]);
    await retryingController.loadForSession(token);
    assert.deepEqual(discarded, [staged]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sweeps retired voice credentials after an expired setup session and retries only the failed locator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-setup-controller-voice-maintenance-"));
  const token = "controller-voice-maintenance-private-token";
  let now = new Date("2026-08-23T02:00:00.000Z");
  const retired: ProductVoiceSetupStage = {
    kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9881",
    credentialRef: "keychain:hob-agent/voice:asr:draft-voice-maintenance:retired",
  };
  const next: ProductVoiceSetupStage = {
    kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9882",
    credentialRef: "keychain:hob-agent/voice:asr:draft-voice-maintenance:next",
  };
  const discarded: ProductVoiceSetupStage[] = [];
  try {
    const store = new ProductSetupDraftStore(directory, () => now, () => "draft-voice-maintenance");
    await prepareVoiceDraft(store, token, "draft-voice-maintenance");
    await store.reserveVoiceCredential({ sessionToken: token, expectedRevision: 4, stage: retired });
    await store.recordVoiceProbe({ sessionToken: token, expectedRevision: 4, stage: retired, latencyMs: 10 });
    await store.reserveVoiceCredential({ sessionToken: token, expectedRevision: 5, stage: next });
    await store.recordVoiceProbe({ sessionToken: token, expectedRevision: 5, stage: next, latencyMs: 11 });
    now = new Date("2026-08-23T15:00:00.000Z");

    let unavailable = true;
    const controller = new ProductSetupController(
      new ProductSetupDraftStore(directory, () => now, () => "unused-id"),
      unavailableModelSetup(),
      unavailableBridgeSetup(),
      {
        prepare: () => ({ status: "unavailable" as const }),
        execute: async () => ({ status: "unavailable" as const }),
        discard: async (stage) => {
          discarded.push(stage);
          if (unavailable) throw new Error("keychain unavailable");
        },
      },
    );
    const maintenance = controller as unknown as { sweepVoiceCredentialCleanup(): Promise<void> };

    await maintenance.sweepVoiceCredentialCleanup();
    assert.deepEqual(discarded, [retired]);
    assert.deepEqual(await store.pendingVoiceCleanupForMaintenance(), [retired]);

    unavailable = false;
    await maintenance.sweepVoiceCredentialCleanup();
    assert.deepEqual(discarded, [retired, retired]);
    assert.deepEqual(await store.pendingVoiceCleanupForMaintenance(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function unavailableModelSetup() {
  return {
    prepare: () => ({ status: "unavailable" as const }),
    stageSetup: () => { throw new Error("not reached"); },
    execute: async () => ({ status: "unavailable" as const }),
    discard: async () => undefined,
  };
}

function unavailableBridgeSetup() {
  return {
    prepare: () => ({ status: "incompatible" as const }),
    stageSetup: () => { throw new Error("not reached"); },
    execute: async () => ({ status: "incompatible" as const }),
    discard: async () => undefined,
  };
}

function unavailableVoiceSetup(discard: (stage: ProductVoiceSetupStage) => Promise<void> | void) {
  return {
    prepare: () => ({ status: "unavailable" as const }),
    execute: async () => ({ status: "unavailable" as const }),
    discard: async (stage: ProductVoiceSetupStage) => { await discard(stage); },
  };
}

class VoiceMemoryVault {
  readonly values = new Map<string, string>();

  read(reference: string): Promise<string | undefined> { return Promise.resolve(this.values.get(reference)); }
  write(reference: string, value: string): Promise<void> { this.values.set(reference, value); return Promise.resolve(); }
  delete(reference: string): Promise<void> { this.values.delete(reference); return Promise.resolve(); }
}

class ToggleVoiceVault extends VoiceMemoryVault {
  deleteAvailable = true;

  override delete(reference: string): Promise<void> {
    if (!this.deleteAvailable) return Promise.reject(new Error("Keychain is temporarily unavailable"));
    return super.delete(reference);
  }
}

class ToggleModelVault {
  readonly values = new Map<string, string>();
  deleteAvailable = true;

  read(reference: string): Promise<string | undefined> { return Promise.resolve(this.values.get(reference)); }
  write(reference: string, value: string): Promise<void> { this.values.set(reference, value); return Promise.resolve(); }
  delete(reference: string): Promise<void> {
    if (!this.deleteAvailable) return Promise.reject(new Error("Keychain is temporarily unavailable"));
    this.values.delete(reference);
    return Promise.resolve();
  }
}

async function prepareVoiceDraft(store: ProductSetupDraftStore, token: string, draftId: string): Promise<void> {
  await store.establishSession({ sessionToken: token, sessionExpiresAt: new Date("2026-08-23T14:00:00.000Z") });
  await store.saveIdentity({ sessionToken: token, expectedRevision: 1, householdName: "测试家", agentName: "测试助手" });
  const modelStage = { profile: { id: `custom:setup:${draftId}`, provider: "custom" as const, kind: "api_key" as const, secretRef: `keychain:hob-agent/setup-model:${draftId}:stage-1` }, modelId: "fixture-model" };
  await store.reserveModelCredential({ sessionToken: token, expectedRevision: 2, stage: modelStage });
  await store.recordModelProbe({
    sessionToken: token,
    expectedRevision: 2,
    latencyMs: 20,
    stage: modelStage,
  });
  const bridgeStage = { bridgeId: "bridge-abcdef0123456789", adapterType: "fixture-peer", label: "Fixture peer", config: { room: "lab" }, credentialRefs: { session: "keychain:hob-agent/bridge:bridge-abcdef0123456789:session" } };
  await store.reserveBridgeCredential({ sessionToken: token, expectedRevision: 3, stage: bridgeStage });
  await store.recordBridgeProbe({
    sessionToken: token,
    expectedRevision: 3,
    latencyMs: 25,
    summary: { states: 5, entities: 4, devices: 3, areas: 2 },
    stage: bridgeStage,
  });
}
