import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { WritableSecretVault } from "@hob-agent/agent-layer/model-credentials";

import {
  ProductBootstrapConfigurationConflictError,
  ProductBootstrapConfigStore,
  type ProductVoiceRuntimeConfig,
} from "./product-bootstrap-config-store.js";
import { ProductOperationalVoiceSettings } from "./product-operational-voice-settings.js";
import { ProductVoiceCleanupLedger } from "./product-voice-cleanup-ledger.js";
import { ProductVoiceSetup } from "./product-voice-setup.js";
import {
  PrivateVoiceGateway,
  type PrivateVoiceGatewayRuntime,
} from "./voice/private-voice-gateway.js";
import type {
  PrivateVoiceProviderRuntimeStatus,
  PrivateVoiceSynthesisInput,
  PrivateVoiceSynthesisResult,
  PrivateVoiceTranscriptionInput,
  PrivateVoiceTranscriptionResult,
} from "./voice/private-voice-provider-runtime.js";

class MemoryVault implements WritableSecretVault {
  readonly values = new Map<string, string>();
  readonly deleted: string[] = [];

  read(reference: string): Promise<string | undefined> { return Promise.resolve(this.values.get(reference)); }
  write(reference: string, value: string): Promise<void> { this.values.set(reference, value); return Promise.resolve(); }
  delete(reference: string): Promise<void> {
    this.deleted.push(reference);
    this.values.delete(reference);
    return Promise.resolve();
  }
}

class UnavailableReadVault extends MemoryVault {
  reads = 0;
  override read(_reference: string): Promise<string | undefined> {
    this.reads += 1;
    return Promise.reject(new Error("private voice credential is temporarily unavailable"));
  }
}

class SlowWriteVault extends MemoryVault {
  private releaseWrite: (() => void) | undefined;
  private readonly writeGate = new Promise<void>((resolve) => { this.releaseWrite = resolve; });
  private writeStartedResolve: (() => void) | undefined;
  readonly writeStarted = new Promise<void>((resolve) => { this.writeStartedResolve = resolve; });

  override async write(reference: string, value: string): Promise<void> {
    this.writeStartedResolve?.();
    await this.writeGate;
    await super.write(reference, value);
  }

  finishWrite(): void { this.releaseWrite?.(); }
}

class ReadyRuntime implements PrivateVoiceGatewayRuntime {
  status: PrivateVoiceProviderRuntimeStatus = { status: "active" };
  readonly captureMode: "encoded_audio" | "pcm_s16le";
  cancelCalls = 0;
  cancelRetryCalls = 0;
  disposeCalls = 0;
  retryHandler: (() => Promise<PrivateVoiceProviderRuntimeStatus>) | undefined;

  constructor(readonly config: ProductVoiceRuntimeConfig) {
    this.captureMode = config.asr.transport === "wyoming" ? "pcm_s16le" : "encoded_audio";
  }

  start(): Promise<PrivateVoiceProviderRuntimeStatus> { return Promise.resolve(this.status); }
  async retry(): Promise<PrivateVoiceProviderRuntimeStatus> {
    this.status = await (this.retryHandler?.() ?? Promise.resolve(this.status));
    return this.status;
  }
  transcribe(_input: PrivateVoiceTranscriptionInput): Promise<PrivateVoiceTranscriptionResult> {
    return Promise.resolve({ status: "transcribed", text: "家庭语音" });
  }
  synthesize(_input: PrivateVoiceSynthesisInput): Promise<PrivateVoiceSynthesisResult> {
    return Promise.resolve({ status: "synthesized", mimeType: "audio/wav", audio: new Uint8Array([1]) });
  }
  cancelRetry(): void { this.cancelRetryCalls += 1; }
  cancel(): void { this.cancelCalls += 1; }
  dispose(): Promise<void> { this.disposeCalls += 1; return Promise.resolve(); }
}

class HangingStartRuntime extends ReadyRuntime {
  private releaseStart: (() => void) | undefined;
  private readonly startGate = new Promise<void>((resolve) => { this.releaseStart = resolve; });
  private startedResolve: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => { this.startedResolve = resolve; });

  override async start(): Promise<PrivateVoiceProviderRuntimeStatus> {
    this.startedResolve?.();
    await this.startGate;
    return this.status;
  }

  override cancel(): void {
    super.cancel();
    this.finishStart();
  }

  finishStart(): void { this.releaseStart?.(); }
}

class DelayedCommitLedger extends ProductVoiceCleanupLedger {
  override markCommitted(): Promise<void> {
    return Promise.reject(new Error("ledger temporarily unavailable"));
  }
}

class RejectSecondReserveLedger extends ProductVoiceCleanupLedger {
  private reservations = 0;

  override async reserve(input: Parameters<ProductVoiceCleanupLedger["reserve"]>[0]): Promise<void> {
    this.reservations += 1;
    if (this.reservations === 2) throw new Error("voice ledger is full");
    await super.reserve(input);
  }
}

class AbortAfterReserveLedger extends ProductVoiceCleanupLedger {
  constructor(directory: string, private readonly controller: AbortController) {
    super(directory);
  }

  override async reserve(input: Parameters<ProductVoiceCleanupLedger["reserve"]>[0]): Promise<void> {
    await super.reserve(input);
    this.controller.abort();
  }
}

const baseDraft = {
  householdName: "梧桐家",
  agentName: "小满",
  modelReference: "custom/home-model",
  modelBaseURL: "https://model.example.test/v1",
  modelProfile: {
    id: "custom:setup:voice-settings",
    provider: "custom",
    kind: "api_key" as const,
    secretRef: "keychain:hob-agent/setup-model:voice-settings:model",
  },
  bridges: [],
};

test("enables both verified private voice tracks through the stable gateway and one configuration CAS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-enable-"));
  const vault = new MemoryVault();
  const configurationStore = new ProductBootstrapConfigStore(directory, () => new Date("2026-08-24T02:00:00.000Z"));
  await configurationStore.commit(0, baseDraft);
  const ledger = new ProductVoiceCleanupLedger(directory, () => new Date("2026-08-24T02:01:00.000Z"));
  const gateway = new PrivateVoiceGateway();
  const runtimes: ReadyRuntime[] = [];
  const voiceSetup = new ProductVoiceSetup({
    vault,
    createStageNonce: () => "verified",
    probe: async () => ({ status: "ready", latencyMs: 12 }),
  });
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup,
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "candidate_next",
    createProviderRuntime: (config) => {
      const runtime = new ReadyRuntime(config);
      runtimes.push(runtime);
      return runtime;
    },
  });

  try {
    const result = await settings.configure({
      expectedGeneration: 1,
      asr: {
        kind: "asr",
        transport: "openai_http",
        endpoint: "http://127.0.0.1:9000/v1",
        credential: "asr-private-key",
        model: "whisper-large-v3",
      },
      tts: {
        kind: "tts",
        transport: "openai_http",
        endpoint: "http://127.0.0.1:9001/v1",
        credential: "tts-private-key",
        model: "local-tts",
        locale: "zh-CN",
        voice: "warm",
      },
    });

    assert.deepEqual(result, { status: "configured", generation: 2 });
    assert.equal(runtimes.length, 1);
    assert.equal(gateway.status, "active");
    assert.equal(gateway.beginTurn()?.providerGeneration, "candidate_next");
    const configuration = await configurationStore.load();
    assert.equal(configuration?.generation, 2);
    assert.equal(configuration?.activatedAt, "2026-08-24T02:00:00.000Z");
    assert.deepEqual(configuration?.voice, {
      asr: {
        transport: "openai_http",
        endpoint: "http://127.0.0.1:9000",
        credentialRef: "keychain:hob-agent/voice:asr:candidate_next:verified",
        model: "whisper-large-v3",
      },
      tts: {
        transport: "openai_http",
        endpoint: "http://127.0.0.1:9001",
        credentialRef: "keychain:hob-agent/voice:tts:candidate_next:verified",
        model: "local-tts",
        locale: "zh-CN",
        voice: "warm",
      },
    });
    assert.deepEqual((await ledger.load()).entries.map(({ track, phase, committedGeneration }) => ({
      track,
      phase,
      committedGeneration,
    })), [
      { track: "asr", phase: "active", committedGeneration: 2 },
      { track: "tts", phase: "active", committedGeneration: 2 },
    ]);
    assert.equal(vault.values.size, 2);
  } finally {
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps the current product generation and removes exact candidate credentials when one track probe fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-probe-failure-"));
  const vault = new MemoryVault();
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, baseDraft);
  const ledger = new ProductVoiceCleanupLedger(directory);
  const gateway = new PrivateVoiceGateway();
  const voiceSetup = new ProductVoiceSetup({
    vault,
    createStageNonce: () => "failed_probe",
    probe: async ({ track }) => track.kind === "asr"
      ? { status: "ready", latencyMs: 8 }
      : { status: "credential_rejected" },
  });
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup,
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "candidate_failed",
    createProviderRuntime: (config) => new ReadyRuntime(config),
  });

  try {
    assert.deepEqual(await settings.configure({
      expectedGeneration: 1,
      asr: {
        kind: "asr",
        transport: "openai_http",
        endpoint: "http://127.0.0.1:9000",
        credential: "asr-candidate-secret",
      },
      tts: {
        kind: "tts",
        transport: "openai_http",
        endpoint: "http://127.0.0.1:9001",
        credential: "rejected-tts-secret",
        locale: "zh-CN",
      },
    }), { status: "probe_failed", track: "tts", reason: "credential_rejected" });
    assert.equal((await configurationStore.load())?.generation, 1);
    assert.equal((await configurationStore.load())?.voice, undefined);
    assert.equal(gateway.status, "disabled");
    assert.equal(vault.values.size, 0);
    assert.deepEqual(new Set(vault.deleted), new Set([
      "keychain:hob-agent/voice:asr:candidate_failed:failed_probe",
      "keychain:hob-agent/voice:tts:candidate_failed:failed_probe",
    ]));
    assert.deepEqual((await ledger.load()).entries, []);
  } finally {
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps the old gateway generation and retires the candidate when the configuration CAS conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-conflict-"));
  const vault = new MemoryVault();
  const durableStore = new ProductBootstrapConfigStore(directory);
  await durableStore.commit(0, baseDraft);
  const ledger = new ProductVoiceCleanupLedger(directory);
  const oldRuntime = new ReadyRuntime({
    asr: { transport: "wyoming", endpoint: "wyoming://127.0.0.1:10300" },
    tts: { transport: "wyoming", endpoint: "wyoming://127.0.0.1:10301", locale: "zh-CN" },
  });
  const gateway = new PrivateVoiceGateway({
    configGeneration: 1,
    providerGeneration: "existing_generation",
    runtime: oldRuntime,
  });
  const candidates: ReadyRuntime[] = [];
  const settings = new ProductOperationalVoiceSettings({
    configurationStore: {
      load: () => durableStore.load(),
      commitVoice: async () => { throw new ProductBootstrapConfigurationConflictError(); },
    },
    gateway,
    voiceSetup: new ProductVoiceSetup({
      vault,
      createStageNonce: () => "conflict",
      probe: async () => ({ status: "ready", latencyMs: 4 }),
    }),
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "candidate_conflict",
    createProviderRuntime: (config) => {
      const runtime = new ReadyRuntime(config);
      candidates.push(runtime);
      return runtime;
    },
  });

  try {
    assert.deepEqual(await settings.configure({
      expectedGeneration: 1,
      asr: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9100", credential: "new-asr" },
      tts: { kind: "tts", transport: "openai_http", endpoint: "http://127.0.0.1:9101", credential: "new-tts", locale: "zh-CN" },
    }), { status: "conflict" });
    assert.equal(gateway.beginTurn()?.providerGeneration, "existing_generation");
    assert.equal(oldRuntime.disposeCalls, 0);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.disposeCalls, 1);
    assert.equal(vault.values.size, 0);
    assert.deepEqual((await ledger.load()).entries, []);
    assert.equal((await durableStore.load())?.generation, 1);
  } finally {
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancels a hanging candidate probe and leaves the active household voice unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-cancel-probe-"));
  const vault = new MemoryVault();
  const oldAsrRef = "keychain:hob-agent/voice:asr:cancel_probe_old:asr";
  const oldTtsRef = "keychain:hob-agent/voice:tts:cancel_probe_old:tts";
  const oldVoice: ProductVoiceRuntimeConfig = {
    asr: { transport: "openai_http", endpoint: "http://127.0.0.1:9700", credentialRef: oldAsrRef },
    tts: { transport: "openai_http", endpoint: "http://127.0.0.1:9701", credentialRef: oldTtsRef, locale: "zh-CN" },
  };
  vault.values.set(oldAsrRef, "old-asr");
  vault.values.set(oldTtsRef, "old-tts");
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, { ...baseDraft, voice: oldVoice });
  const ledger = new ProductVoiceCleanupLedger(directory);
  await ledger.adoptCommitted({ candidateId: "cancel_probe_old", track: "asr", credentialRef: oldAsrRef, committedGeneration: 1 });
  await ledger.adoptCommitted({ candidateId: "cancel_probe_old", track: "tts", credentialRef: oldTtsRef, committedGeneration: 1 });
  const oldRuntime = new ReadyRuntime(oldVoice);
  const gateway = new PrivateVoiceGateway({ configGeneration: 1, providerGeneration: "cancel_probe_old", runtime: oldRuntime });
  let probeStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { probeStarted = resolve; });
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup: new ProductVoiceSetup({
      vault,
      createStageNonce: () => "hanging_probe",
      probe: async ({ signal }) => {
        probeStarted?.();
        return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ status: "unavailable" }), { once: true }));
      },
    }),
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "cancel_probe_next",
    createProviderRuntime: (config) => new ReadyRuntime(config),
  });
  const controller = new AbortController();

  try {
    const configuration = settings.configure({
      expectedGeneration: 1,
      signal: controller.signal,
      asr: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9710", credential: "candidate-asr" },
      tts: { kind: "tts", transport: "openai_http", endpoint: "http://127.0.0.1:9711", credential: "candidate-tts", locale: "zh-CN" },
    });
    await started;
    controller.abort();

    assert.deepEqual(await configuration, { status: "cancelled" });
    assert.equal((await configurationStore.load())?.generation, 1);
    assert.deepEqual((await configurationStore.load())?.voice, oldVoice);
    assert.equal(gateway.beginTurn()?.providerGeneration, "cancel_probe_old");
    assert.equal(vault.values.get(oldAsrRef), "old-asr");
    assert.equal(vault.values.get(oldTtsRef), "old-tts");
    assert.equal(vault.values.has("keychain:hob-agent/voice:asr:cancel_probe_next:hanging_probe"), false);
    assert.deepEqual((await ledger.load()).entries.map((entry) => entry.credentialRef).sort(), [oldAsrRef, oldTtsRef].sort());
  } finally {
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("retires a voice credential lease when cancellation lands immediately after reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-cancel-after-reserve-"));
  const vault = new MemoryVault();
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, baseDraft);
  const controller = new AbortController();
  const ledger = new AbortAfterReserveLedger(directory, controller);
  const gateway = new PrivateVoiceGateway();
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup: new ProductVoiceSetup({
      vault,
      createStageNonce: () => "cancelled_after_reserve",
      probe: async () => ({ status: "ready", latencyMs: 1 }),
    }),
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "cancel_after_reserve_candidate",
    createProviderRuntime: (config) => new ReadyRuntime(config),
  });

  try {
    assert.deepEqual(await settings.configure({
      expectedGeneration: 1,
      signal: controller.signal,
      asr: {
        kind: "asr",
        transport: "openai_http",
        endpoint: "http://127.0.0.1:9720",
        credential: "candidate-asr",
      },
      tts: {
        kind: "tts",
        transport: "openai_http",
        endpoint: "http://127.0.0.1:9721",
        credential: "candidate-tts",
        locale: "zh-CN",
      },
    }), { status: "cancelled" });
    assert.deepEqual((await ledger.load()).entries, []);
    assert.equal(vault.values.size, 0);
    assert.equal((await configurationStore.load())?.generation, 1);
  } finally {
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("retires the exact candidate credential when the voice transport throws", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-transport-throw-"));
  const vault = new MemoryVault();
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, baseDraft);
  const ledger = new ProductVoiceCleanupLedger(directory);
  const gateway = new PrivateVoiceGateway();
  const preparedVoice = new ProductVoiceSetup({
    vault,
    createStageNonce: () => "transport_throw",
  });
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup: {
      prepare: (input) => preparedVoice.prepare(input),
      execute: async (input) => {
        const reference = input.prepared.stage.credentialRef;
        const credential = input.prepared.credential;
        if (reference !== undefined && credential !== undefined) await vault.write(reference, credential);
        throw new Error("voice transport failed outside its bounded result");
      },
      discard: (stage) => preparedVoice.discard(stage),
    },
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "transport_throw_candidate",
    createProviderRuntime: (config) => new ReadyRuntime(config),
  });

  try {
    assert.deepEqual(await settings.configure({
      expectedGeneration: 1,
      asr: {
        kind: "asr",
        transport: "openai_http",
        endpoint: "http://127.0.0.1:9730",
        credential: "candidate-asr",
      },
      tts: {
        kind: "tts",
        transport: "openai_http",
        endpoint: "http://127.0.0.1:9731",
        credential: "candidate-tts",
        locale: "zh-CN",
      },
    }), { status: "unavailable" });
    assert.deepEqual((await ledger.load()).entries, []);
    assert.equal(vault.values.size, 0);
    assert.equal((await configurationStore.load())?.generation, 1);
  } finally {
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps configuration busy through a slow credential write, then deletes the settled candidate exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-cancel-slow-write-"));
  const vault = new SlowWriteVault();
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, baseDraft);
  const ledger = new ProductVoiceCleanupLedger(directory);
  const gateway = new PrivateVoiceGateway();
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup: new ProductVoiceSetup({
      vault,
      createStageNonce: () => "slow_write",
      probe: async () => ({ status: "ready", latencyMs: 1 }),
    }),
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "slow_write_candidate",
    createProviderRuntime: (config) => new ReadyRuntime(config),
  });
  const controller = new AbortController();
  const input = {
    expectedGeneration: 1,
    asr: { kind: "asr" as const, transport: "openai_http" as const, endpoint: "http://127.0.0.1:9715", credential: "candidate-asr" },
    tts: { kind: "tts" as const, transport: "openai_http" as const, endpoint: "http://127.0.0.1:9716", credential: "candidate-tts", locale: "zh-CN" },
  };

  try {
    const configuration = settings.configure({ ...input, signal: controller.signal });
    await vault.writeStarted;
    controller.abort();
    assert.deepEqual(await settings.configure(input), { status: "busy" });
    vault.finishWrite();

    assert.deepEqual(await configuration, { status: "cancelled" });
    const candidateRef = "keychain:hob-agent/voice:asr:slow_write_candidate:slow_write";
    assert.equal(vault.values.has(candidateRef), false);
    assert.deepEqual(vault.deleted, [candidateRef]);
    assert.deepEqual((await ledger.load()).entries, []);
    assert.equal((await configurationStore.load())?.generation, 1);
    assert.equal(gateway.status, "disabled");
  } finally {
    vault.finishWrite();
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("closes an operational voice mutation before it can commit and waits for its credential cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-close-"));
  const vault = new MemoryVault();
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, baseDraft);
  let probeStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { probeStarted = resolve; });
  let finishProbe: (() => void) | undefined;
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway: new PrivateVoiceGateway(),
    voiceSetup: new ProductVoiceSetup({
      vault,
      createStageNonce: () => "close",
      probe: ({ signal }) => new Promise((resolve) => {
        finishProbe = () => resolve({ status: "unavailable" });
        probeStarted?.();
        signal?.addEventListener("abort", () => resolve({ status: "unavailable" }), { once: true });
      }),
    }),
    cleanupLedger: new ProductVoiceCleanupLedger(directory),
    vault,
    createCandidateId: () => "close_candidate",
    createProviderRuntime: (config) => new ReadyRuntime(config),
  });
  const input = {
    expectedGeneration: 1,
    asr: { kind: "asr" as const, transport: "openai_http" as const, endpoint: "http://127.0.0.1:9715", credential: "candidate-asr" },
    tts: { kind: "tts" as const, transport: "openai_http" as const, endpoint: "http://127.0.0.1:9716", credential: "candidate-tts", locale: "zh-CN" },
  };
  let pending: Promise<unknown> | undefined;
  try {
    pending = settings.configure(input);
    await started;

    await settings.closeAndDrain();

    assert.deepEqual(await pending, { status: "cancelled" });
    assert.deepEqual(await settings.configure(input), { status: "cancelled" });
    assert.equal((await configurationStore.load())?.generation, 1);
    assert.equal(vault.values.size, 0);
    assert.deepEqual(await new ProductVoiceCleanupLedger(directory).listPending(), []);
  } finally {
    finishProbe?.();
    await pending?.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancels a hanging candidate runtime before commit and removes its exact staged credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-cancel-runtime-"));
  const vault = new MemoryVault();
  const oldAsrRef = "keychain:hob-agent/voice:asr:cancel_runtime_old:asr";
  const oldTtsRef = "keychain:hob-agent/voice:tts:cancel_runtime_old:tts";
  const oldVoice: ProductVoiceRuntimeConfig = {
    asr: { transport: "openai_http", endpoint: "http://127.0.0.1:9720", credentialRef: oldAsrRef },
    tts: { transport: "openai_http", endpoint: "http://127.0.0.1:9721", credentialRef: oldTtsRef, locale: "zh-CN" },
  };
  vault.values.set(oldAsrRef, "old-asr");
  vault.values.set(oldTtsRef, "old-tts");
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, { ...baseDraft, voice: oldVoice });
  const ledger = new ProductVoiceCleanupLedger(directory);
  await ledger.adoptCommitted({ candidateId: "cancel_runtime_old", track: "asr", credentialRef: oldAsrRef, committedGeneration: 1 });
  await ledger.adoptCommitted({ candidateId: "cancel_runtime_old", track: "tts", credentialRef: oldTtsRef, committedGeneration: 1 });
  const oldRuntime = new ReadyRuntime(oldVoice);
  const gateway = new PrivateVoiceGateway({ configGeneration: 1, providerGeneration: "cancel_runtime_old", runtime: oldRuntime });
  let candidate: HangingStartRuntime | undefined;
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup: new ProductVoiceSetup({ vault, createStageNonce: () => "hanging_runtime", probe: async () => ({ status: "ready", latencyMs: 2 }) }),
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "cancel_runtime_next",
    createProviderRuntime: (config) => {
      candidate = new HangingStartRuntime(config);
      return candidate;
    },
  });
  const controller = new AbortController();

  try {
    const configuration = settings.configure({
      expectedGeneration: 1,
      signal: controller.signal,
      asr: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9730", credential: "candidate-asr" },
      tts: { kind: "tts", transport: "openai_http", endpoint: "http://127.0.0.1:9731", credential: "candidate-tts", locale: "zh-CN" },
    });
    await waitFor(() => candidate !== undefined);
    await candidate!.started;
    controller.abort();

    assert.deepEqual(await configuration, { status: "cancelled" });
    assert.equal(candidate?.cancelCalls, 1);
    assert.equal(candidate?.disposeCalls, 1);
    assert.equal((await configurationStore.load())?.generation, 1);
    assert.deepEqual((await configurationStore.load())?.voice, oldVoice);
    assert.equal(gateway.beginTurn()?.providerGeneration, "cancel_runtime_old");
    assert.equal(vault.values.get(oldAsrRef), "old-asr");
    assert.equal(vault.values.get(oldTtsRef), "old-tts");
    assert.equal(vault.values.has("keychain:hob-agent/voice:asr:cancel_runtime_next:hanging_runtime"), false);
    assert.equal(vault.values.has("keychain:hob-agent/voice:tts:cancel_runtime_next:hanging_runtime"), false);
    assert.deepEqual((await ledger.load()).entries.map((entry) => entry.credentialRef).sort(), [oldAsrRef, oldTtsRef].sort());
  } finally {
    candidate?.finishStart();
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("linearizes an abort that races with the durable configuration commit as one completed configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-cancel-commit-race-"));
  const vault = new MemoryVault();
  const durableStore = new ProductBootstrapConfigStore(directory);
  await durableStore.commit(0, baseDraft);
  const controller = new AbortController();
  const gateway = new PrivateVoiceGateway();
  const settings = new ProductOperationalVoiceSettings({
    configurationStore: {
      load: () => durableStore.load(),
      commitVoice: async (expectedGeneration, voice) => {
        controller.abort();
        return durableStore.commitVoice(expectedGeneration, voice);
      },
    },
    gateway,
    voiceSetup: new ProductVoiceSetup({ vault, probe: async () => ({ status: "ready", latencyMs: 1 }) }),
    cleanupLedger: new ProductVoiceCleanupLedger(directory),
    vault,
    createCandidateId: () => "commit_race_candidate",
    createProviderRuntime: (config) => new ReadyRuntime(config),
  });

  try {
    assert.deepEqual(await settings.configure({
      expectedGeneration: 1,
      signal: controller.signal,
      asr: { kind: "asr", transport: "wyoming", endpoint: "wyoming://127.0.0.1:9740" },
      tts: { kind: "tts", transport: "wyoming", endpoint: "wyoming://127.0.0.1:9741", locale: "zh-CN" },
    }), { status: "configured", generation: 2 });
    assert.equal(controller.signal.aborted, true);
    assert.equal((await durableStore.load())?.generation, 2);
    assert.equal(gateway.beginTurn()?.providerGeneration, "commit_race_candidate");
  } finally {
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns busy for a second configuration request while the first candidate is still being verified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-busy-"));
  const vault = new MemoryVault();
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, baseDraft);
  const ledger = new ProductVoiceCleanupLedger(directory);
  const gateway = new PrivateVoiceGateway();
  let releaseProbe: (() => void) | undefined;
  const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
  let firstProbeStarted: (() => void) | undefined;
  const probeStarted = new Promise<void>((resolve) => { firstProbeStarted = resolve; });
  let probeCalls = 0;
  let candidateNumber = 0;
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup: new ProductVoiceSetup({
      vault,
      probe: async () => {
        probeCalls += 1;
        if (probeCalls === 1) {
          firstProbeStarted?.();
          await probeGate;
        }
        return { status: "ready", latencyMs: 3 };
      },
    }),
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => `candidate_${++candidateNumber}`,
    createProviderRuntime: (config) => new ReadyRuntime(config),
  });
  const input = {
    expectedGeneration: 1,
    asr: { kind: "asr" as const, transport: "wyoming" as const, endpoint: "wyoming://127.0.0.1:10300" },
    tts: { kind: "tts" as const, transport: "wyoming" as const, endpoint: "wyoming://127.0.0.1:10301", locale: "zh-CN" },
  };

  try {
    const first = settings.configure(input);
    await probeStarted;
    assert.deepEqual(await settings.configure(input), { status: "busy" });
    assert.equal(probeCalls, 1);
    releaseProbe?.();
    assert.deepEqual(await first, { status: "configured", generation: 2 });
  } finally {
    releaseProbe?.();
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("publishes the committed provider while a delayed ledger promotion remains recoverable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-ledger-delay-"));
  const vault = new MemoryVault();
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, baseDraft);
  const ledger = new DelayedCommitLedger(directory);
  const gateway = new PrivateVoiceGateway();
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup: new ProductVoiceSetup({
      vault,
      createStageNonce: () => "ledger_delay",
      probe: async () => ({ status: "ready", latencyMs: 5 }),
    }),
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "candidate_ledger_delay",
    createProviderRuntime: (config) => new ReadyRuntime(config),
  });

  try {
    assert.deepEqual(await settings.configure({
      expectedGeneration: 1,
      asr: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9200", credential: "asr-secret" },
      tts: { kind: "tts", transport: "openai_http", endpoint: "http://127.0.0.1:9201", credential: "tts-secret", locale: "zh-CN" },
    }), { status: "configured", generation: 2 });
    assert.equal(gateway.beginTurn()?.providerGeneration, "candidate_ledger_delay");
    assert.equal((await configurationStore.load())?.generation, 2);
    assert.deepEqual((await ledger.load()).entries.map((entry) => entry.phase), ["staged", "staged"]);
    assert.equal(vault.values.size, 2);
  } finally {
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("disables new turns immediately and cleans the previous exact credentials after its last lease drains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-disable-"));
  const vault = new MemoryVault();
  const oldAsrRef = "keychain:hob-agent/voice:asr:initial_voice:asr_secret";
  const oldTtsRef = "keychain:hob-agent/voice:tts:initial_voice:tts_secret";
  vault.values.set(oldAsrRef, "old-asr");
  vault.values.set(oldTtsRef, "old-tts");
  const oldVoice: ProductVoiceRuntimeConfig = {
    asr: { transport: "openai_http", endpoint: "http://127.0.0.1:9300", credentialRef: oldAsrRef },
    tts: { transport: "openai_http", endpoint: "http://127.0.0.1:9301", credentialRef: oldTtsRef, locale: "zh-CN" },
  };
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, { ...baseDraft, voice: oldVoice });
  const ledger = new ProductVoiceCleanupLedger(directory);
  await ledger.adoptCommitted({ candidateId: "initial_voice", track: "asr", credentialRef: oldAsrRef, committedGeneration: 1 });
  await ledger.adoptCommitted({ candidateId: "initial_voice", track: "tts", credentialRef: oldTtsRef, committedGeneration: 1 });
  const oldRuntime = new ReadyRuntime(oldVoice);
  const gateway = new PrivateVoiceGateway({ configGeneration: 1, providerGeneration: "initial_voice", runtime: oldRuntime });
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup: new ProductVoiceSetup({ vault, probe: async () => ({ status: "ready", latencyMs: 1 }) }),
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "unused_candidate",
    createProviderRuntime: (config) => new ReadyRuntime(config),
  });
  const lease = gateway.beginTurn();
  assert.ok(lease);

  try {
    assert.deepEqual(await settings.disable({ expectedGeneration: 1 }), { status: "disabled", generation: 2 });
    assert.equal(gateway.status, "disabled");
    assert.equal(gateway.beginTurn(), undefined);
    assert.equal((await configurationStore.load())?.voice, undefined);
    assert.equal(oldRuntime.disposeCalls, 0);
    assert.equal(vault.values.size, 2);

    await lease.release();
    await settings.drainMaintenance();
    assert.equal(oldRuntime.disposeCalls, 1);
    assert.equal(vault.values.size, 0);
    assert.deepEqual(new Set(vault.deleted), new Set([oldAsrRef, oldTtsRef]));
    assert.deepEqual((await ledger.load()).entries, []);
  } finally {
    await lease.release();
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps an old voice turn on its provider while a reconfiguration serves new turns and drains old credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-reconfigure-"));
  const vault = new MemoryVault();
  const oldAsrRef = "keychain:hob-agent/voice:asr:old_candidate:asr";
  const oldTtsRef = "keychain:hob-agent/voice:tts:old_candidate:tts";
  vault.values.set(oldAsrRef, "old-asr");
  vault.values.set(oldTtsRef, "old-tts");
  const oldVoice: ProductVoiceRuntimeConfig = {
    asr: { transport: "openai_http", endpoint: "http://127.0.0.1:9400", credentialRef: oldAsrRef },
    tts: { transport: "openai_http", endpoint: "http://127.0.0.1:9401", credentialRef: oldTtsRef, locale: "zh-CN" },
  };
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, { ...baseDraft, voice: oldVoice });
  await configurationStore.commitModel(1, {
    modelReference: "custom/home-model",
    modelBaseURL: "https://model.example.test/v1",
    modelProfile: {
      id: "custom:operational:unrelated_model",
      provider: "custom",
      kind: "api_key",
      secretRef: "keychain:hob-agent/model:unrelated_model:credential",
    },
  });
  const ledger = new ProductVoiceCleanupLedger(directory);
  await ledger.adoptCommitted({ candidateId: "old_candidate", track: "asr", credentialRef: oldAsrRef, committedGeneration: 1 });
  await ledger.adoptCommitted({ candidateId: "old_candidate", track: "tts", credentialRef: oldTtsRef, committedGeneration: 1 });
  const oldRuntime = new ReadyRuntime(oldVoice);
  const gateway = new PrivateVoiceGateway({ configGeneration: 1, providerGeneration: "old_candidate", runtime: oldRuntime });
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup: new ProductVoiceSetup({ vault, probe: async () => ({ status: "ready", latencyMs: 2 }) }),
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "new_candidate",
    createProviderRuntime: (config) => new ReadyRuntime(config),
  });
  const oldLease = gateway.beginTurn();
  assert.ok(oldLease);

  try {
    assert.deepEqual(await settings.configure({
      expectedGeneration: 2,
      asr: { kind: "asr", transport: "wyoming", endpoint: "wyoming://127.0.0.1:10400" },
      tts: { kind: "tts", transport: "wyoming", endpoint: "wyoming://127.0.0.1:10401", locale: "zh-CN", voice: "calm" },
    }), { status: "configured", generation: 3 });
    assert.equal(gateway.beginTurn()?.providerGeneration, "new_candidate");
    assert.deepEqual(await oldLease.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" }), {
      status: "transcribed",
      text: "家庭语音",
    });
    assert.equal(oldRuntime.disposeCalls, 0);
    assert.equal(vault.values.size, 2);

    await oldLease.release();
    await waitFor(async () => oldRuntime.disposeCalls === 1
      && vault.values.size === 0
      && (await ledger.load()).entries.length === 0);
  } finally {
    await oldLease.release();
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("stages new OpenAI credential locators when blank fields retain the saved credentials during reconfiguration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-retain-credentials-"));
  const vault = new MemoryVault();
  const oldAsrRef = "keychain:hob-agent/voice:asr:retained_old:asr";
  const oldTtsRef = "keychain:hob-agent/voice:tts:retained_old:tts";
  vault.values.set(oldAsrRef, "saved-asr-secret");
  vault.values.set(oldTtsRef, "saved-tts-secret");
  const oldVoice: ProductVoiceRuntimeConfig = {
    asr: { transport: "openai_http", endpoint: "http://127.0.0.1:9420", credentialRef: oldAsrRef, model: "old-asr" },
    tts: { transport: "openai_http", endpoint: "http://127.0.0.1:9421", credentialRef: oldTtsRef, locale: "zh-CN", model: "old-tts" },
  };
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, { ...baseDraft, voice: oldVoice });
  const ledger = new ProductVoiceCleanupLedger(directory);
  await ledger.adoptCommitted({ candidateId: "retained_old", track: "asr", credentialRef: oldAsrRef, committedGeneration: 1 });
  await ledger.adoptCommitted({ candidateId: "retained_old", track: "tts", credentialRef: oldTtsRef, committedGeneration: 1 });
  const oldRuntime = new ReadyRuntime(oldVoice);
  const gateway = new PrivateVoiceGateway({ configGeneration: 1, providerGeneration: "retained_old", runtime: oldRuntime });
  const probedCredentials = new Map<"asr" | "tts", string | undefined>();
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup: new ProductVoiceSetup({
      vault,
      createStageNonce: () => "retained_next",
      probe: async ({ track, credential }) => {
        probedCredentials.set(track.kind, credential);
        return { status: "ready", latencyMs: 2 };
      },
    }),
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "retained_next",
    createProviderRuntime: (config) => new ReadyRuntime(config),
  });
  const oldLease = gateway.beginTurn();
  assert.ok(oldLease);

  try {
    assert.deepEqual(await settings.configure({
      expectedGeneration: 1,
      asr: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9420", model: "new-asr", credential: "" },
      tts: { kind: "tts", transport: "openai_http", endpoint: "http://127.0.0.1:9421", locale: "zh-CN", model: "new-tts", credential: "" },
    }), { status: "configured", generation: 2 });
    assert.deepEqual(probedCredentials, new Map([
      ["asr", "saved-asr-secret"],
      ["tts", "saved-tts-secret"],
    ]));

    const current = await configurationStore.load();
    const currentAsrRef = current?.voice?.asr.credentialRef;
    const currentTtsRef = current?.voice?.tts.credentialRef;
    assert.equal(currentAsrRef, "keychain:hob-agent/voice:asr:retained_next:retained_next");
    assert.equal(currentTtsRef, "keychain:hob-agent/voice:tts:retained_next:retained_next");
    assert.notEqual(currentAsrRef, oldAsrRef);
    assert.notEqual(currentTtsRef, oldTtsRef);
    assert.equal(vault.values.get(currentAsrRef ?? ""), "saved-asr-secret");
    assert.equal(vault.values.get(currentTtsRef ?? ""), "saved-tts-secret");
    assert.equal(vault.values.get(oldAsrRef), "saved-asr-secret");
    assert.equal(vault.values.get(oldTtsRef), "saved-tts-secret");
    assert.equal(oldRuntime.disposeCalls, 0);

    await oldLease.release();
    await settings.drainMaintenance();
    assert.equal(oldRuntime.disposeCalls, 1);
    assert.equal(vault.values.has(oldAsrRef), false);
    assert.equal(vault.values.has(oldTtsRef), false);
    assert.equal(vault.values.get(currentAsrRef ?? ""), "saved-asr-secret");
    assert.equal(vault.values.get(currentTtsRef ?? ""), "saved-tts-secret");
  } finally {
    await oldLease.release();
    await settings.closeAndDrain();
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("never reads or forwards a saved credential when a blank field targets a new endpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-retained-read-failure-"));
  const vault = new UnavailableReadVault();
  const oldAsrRef = "keychain:hob-agent/voice:asr:read_failure_old:asr";
  const oldTtsRef = "keychain:hob-agent/voice:tts:read_failure_old:tts";
  vault.values.set(oldAsrRef, "saved-asr-secret");
  vault.values.set(oldTtsRef, "saved-tts-secret");
  const oldVoice: ProductVoiceRuntimeConfig = {
    asr: { transport: "openai_http", endpoint: "http://127.0.0.1:9430", credentialRef: oldAsrRef },
    tts: { transport: "openai_http", endpoint: "http://127.0.0.1:9431", credentialRef: oldTtsRef, locale: "zh-CN" },
  };
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, { ...baseDraft, voice: oldVoice });
  const ledger = new ProductVoiceCleanupLedger(directory);
  await ledger.adoptCommitted({ candidateId: "read_failure_old", track: "asr", credentialRef: oldAsrRef, committedGeneration: 1 });
  await ledger.adoptCommitted({ candidateId: "read_failure_old", track: "tts", credentialRef: oldTtsRef, committedGeneration: 1 });
  const oldRuntime = new ReadyRuntime(oldVoice);
  const gateway = new PrivateVoiceGateway({ configGeneration: 1, providerGeneration: "read_failure_old", runtime: oldRuntime });
  let runtimeCreates = 0;
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup: new ProductVoiceSetup({
      vault,
      probe: async ({ credential }) => credential === undefined
        ? { status: "credential_rejected" }
        : { status: "ready", latencyMs: 2 },
    }),
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "read_failure_next",
    createProviderRuntime: (config) => {
      runtimeCreates += 1;
      return new ReadyRuntime(config);
    },
  });

  try {
    assert.deepEqual(await settings.configure({
      expectedGeneration: 1,
      asr: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9440", credential: "" },
      tts: { kind: "tts", transport: "openai_http", endpoint: "http://127.0.0.1:9441", locale: "zh-CN", credential: "" },
    }), { status: "probe_failed", track: "asr", reason: "credential_rejected" });
    assert.equal((await configurationStore.load())?.generation, 1);
    assert.deepEqual((await configurationStore.load())?.voice, oldVoice);
    assert.equal(gateway.beginTurn()?.providerGeneration, "read_failure_old");
    assert.equal(runtimeCreates, 0);
    assert.equal(vault.reads, 0);
    assert.equal(vault.values.size, 2);
  } finally {
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("projects the active self-hosted services without exposing credential locators or values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-projection-"));
  const vault = new MemoryVault();
  const voice: ProductVoiceRuntimeConfig = {
    asr: {
      transport: "openai_http",
      endpoint: "https://voice.example.test",
      credentialRef: "keychain:hob-agent/voice:asr:projected_voice:asr",
      model: "private-asr",
    },
    tts: {
      transport: "wyoming",
      endpoint: "wyoming://voice.local:10200",
      locale: "zh-CN",
      voice: "warm",
    },
  };
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, { ...baseDraft, voice });
  const gateway = new PrivateVoiceGateway({
    configGeneration: 1,
    providerGeneration: "projected_voice",
    runtime: new ReadyRuntime(voice),
  });
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup: new ProductVoiceSetup({ vault }),
    cleanupLedger: new ProductVoiceCleanupLedger(directory),
    vault,
    createCandidateId: () => "unused_candidate",
    createProviderRuntime: (config) => new ReadyRuntime(config),
  });

  try {
    const projection = await settings.projection();
    assert.deepEqual(projection, {
      status: "active",
      generation: 1,
      configured: true,
      asr: {
        transport: "openai_http",
        endpoint: "https://voice.example.test",
        model: "private-asr",
        credentialConfigured: true,
      },
      tts: {
        transport: "wyoming",
        endpoint: "wyoming://voice.local:10200",
        locale: "zh-CN",
        voice: "warm",
        credentialConfigured: false,
      },
    });
    assert.equal(JSON.stringify(projection).includes("keychain:"), false);
  } finally {
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancels only a bounded provider retry and allows the same saved services to recover later", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-retry-"));
  const vault = new MemoryVault();
  const voice: ProductVoiceRuntimeConfig = {
    asr: { transport: "wyoming", endpoint: "wyoming://127.0.0.1:10500" },
    tts: { transport: "wyoming", endpoint: "wyoming://127.0.0.1:10501", locale: "zh-CN" },
  };
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, { ...baseDraft, voice });
  const runtime = new ReadyRuntime(voice);
  runtime.status = { status: "degraded", reason: "endpoint_unreachable" };
  let finishRetry: ((status: PrivateVoiceProviderRuntimeStatus) => void) | undefined;
  runtime.retryHandler = () => new Promise((resolve) => { finishRetry = resolve; });
  const gateway = new PrivateVoiceGateway({ configGeneration: 1, providerGeneration: "retry_voice", runtime });
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup: new ProductVoiceSetup({ vault }),
    cleanupLedger: new ProductVoiceCleanupLedger(directory),
    vault,
    createCandidateId: () => "unused_candidate",
    createProviderRuntime: (config) => new ReadyRuntime(config),
  });

  try {
    const retry = settings.retry();
    assert.equal(gateway.status, "retrying");
    settings.cancelRetry();
    assert.equal(runtime.cancelRetryCalls, 1);
    assert.equal(runtime.cancelCalls, 0);
    finishRetry?.({ status: "active" });
    assert.equal(await retry, "degraded");

    runtime.retryHandler = async () => ({ status: "active" });
    assert.equal(await settings.retry(), "active");
    assert.equal((await configurationStore.load())?.generation, 1);
  } finally {
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleans a previously verified track when the next credential reservation cannot start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-reserve-failure-"));
  const vault = new MemoryVault();
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, baseDraft);
  const ledger = new RejectSecondReserveLedger(directory);
  const gateway = new PrivateVoiceGateway();
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup: new ProductVoiceSetup({
      vault,
      createStageNonce: () => "reserve_failure",
      probe: async () => ({ status: "ready", latencyMs: 2 }),
    }),
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "candidate_reserve_failure",
    createProviderRuntime: (config) => new ReadyRuntime(config),
  });

  try {
    assert.deepEqual(await settings.configure({
      expectedGeneration: 1,
      asr: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9500", credential: "asr-secret" },
      tts: { kind: "tts", transport: "openai_http", endpoint: "http://127.0.0.1:9501", credential: "tts-secret", locale: "zh-CN" },
    }), { status: "unavailable" });
    assert.equal(vault.values.size, 0);
    assert.deepEqual(vault.deleted, ["keychain:hob-agent/voice:asr:candidate_reserve_failure:reserve_failure"]);
    assert.deepEqual((await ledger.load()).entries, []);
    assert.equal((await configurationStore.load())?.generation, 1);
  } finally {
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleans verified candidate credentials when its provider runtime cannot be constructed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-runtime-construction-"));
  const vault = new MemoryVault();
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, baseDraft);
  const ledger = new ProductVoiceCleanupLedger(directory);
  const gateway = new PrivateVoiceGateway();
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup: new ProductVoiceSetup({
      vault,
      createStageNonce: () => "runtime_failure",
      probe: async () => ({ status: "ready", latencyMs: 2 }),
    }),
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "candidate_runtime_failure",
    createProviderRuntime: () => { throw new Error("provider runtime unavailable"); },
  });

  try {
    assert.deepEqual(await settings.configure({
      expectedGeneration: 1,
      asr: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9600", credential: "asr-secret" },
      tts: { kind: "tts", transport: "openai_http", endpoint: "http://127.0.0.1:9601", credential: "tts-secret", locale: "zh-CN" },
    }), { status: "unavailable" });
    assert.equal(vault.values.size, 0);
    assert.deepEqual((await ledger.load()).entries, []);
    assert.equal((await configurationStore.load())?.generation, 1);
    assert.equal(gateway.status, "disabled");
  } finally {
    await gateway.dispose({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps committed credential ownership for restart when shutdown wins the in-memory gateway swap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-voice-swap-shutdown-"));
  const vault = new MemoryVault();
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, baseDraft);
  const ledger = new ProductVoiceCleanupLedger(directory);
  const gateway = new PrivateVoiceGateway();
  await gateway.dispose({ force: true });
  const candidates: ReadyRuntime[] = [];
  const settings = new ProductOperationalVoiceSettings({
    configurationStore,
    gateway,
    voiceSetup: new ProductVoiceSetup({
      vault,
      createStageNonce: () => "swap_shutdown",
      probe: async () => ({ status: "ready", latencyMs: 2 }),
    }),
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "candidate_swap_shutdown",
    createProviderRuntime: (config) => {
      const runtime = new ReadyRuntime(config);
      candidates.push(runtime);
      return runtime;
    },
  });

  try {
    assert.deepEqual(await settings.configure({
      expectedGeneration: 1,
      asr: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9700", credential: "asr-secret" },
      tts: { kind: "tts", transport: "openai_http", endpoint: "http://127.0.0.1:9701", credential: "tts-secret", locale: "zh-CN" },
    }), { status: "unavailable" });
    assert.equal((await configurationStore.load())?.generation, 2);
    assert.equal((await configurationStore.load())?.voice?.asr.credentialRef,
      "keychain:hob-agent/voice:asr:candidate_swap_shutdown:swap_shutdown");
    assert.equal(vault.values.size, 2);
    assert.deepEqual((await ledger.load()).entries.map((entry) => entry.phase), ["active", "active"]);
    assert.equal(candidates[0]?.disposeCalls, 1);
    assert.deepEqual(await settings.projection(), {
      status: "degraded",
      generation: 2,
      configured: true,
      asr: {
        transport: "openai_http",
        endpoint: "http://127.0.0.1:9700",
        credentialConfigured: true,
      },
      tts: {
        transport: "openai_http",
        endpoint: "http://127.0.0.1:9701",
        locale: "zh-CN",
        credentialConfigured: true,
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for operational voice maintenance");
}
