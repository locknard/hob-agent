import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AuthProfile, WritableSecretVault } from "@hob-agent/agent-layer/model-credentials";
import type { ProviderProbeResult } from "@hob-agent/agent-layer/model-credential-probe";

import { ProductBootstrapConfigStore } from "./product-bootstrap-config-store.js";
import { ProductModelCleanupLedger } from "./product-model-cleanup-ledger.js";
import { ProductModelSetup } from "./product-model-setup.js";
import { ProductOperationalModelSettings } from "./product-operational-model-settings.js";

class MemoryVault implements WritableSecretVault {
  readonly values = new Map<string, string>();
  readonly deleted: string[] = [];
  read(reference: string): Promise<string | undefined> { return Promise.resolve(this.values.get(reference)); }
  write(reference: string, value: string): Promise<void> { this.values.set(reference, value); return Promise.resolve(); }
  delete(reference: string): Promise<void> { this.deleted.push(reference); this.values.delete(reference); return Promise.resolve(); }
}

class FailOnceDeleteVault extends MemoryVault {
  private remainingFailures = 1;

  override delete(reference: string): Promise<void> {
    this.deleted.push(reference);
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      return Promise.reject(new Error("keychain is temporarily unavailable"));
    }
    this.values.delete(reference);
    return Promise.resolve();
  }
}

class Resolver {
  status(): { readonly state: "ready" } { return { state: "ready" }; }
  readonly prepared: Array<{ readonly profile: AuthProfile }> = [];
  activated: { readonly profile: AuthProfile } | undefined;
  private releaseDrain: (() => void) | undefined;
  readonly drained = new Promise<void>((resolve) => { this.releaseDrain = resolve; });
  async prepare(candidate: { readonly profile: AuthProfile }): Promise<{ readonly profile: AuthProfile }> { this.prepared.push(candidate); return candidate; }
  activate(prepared: { readonly profile: AuthProfile }): { readonly drained: Promise<void> } { this.activated = prepared; return { drained: this.drained }; }
  discard(_prepared: { readonly profile: AuthProfile }): Promise<void> { return Promise.resolve(); }
  finishDrain(): void { this.releaseDrain?.(); }
}

class MutableResolver extends Resolver {
  state: "ready" | "degraded" = "degraded";
  override status(): { readonly state: "ready" | "degraded" } { return { state: this.state }; }
}

class DelayedPromotionLedger extends ProductModelCleanupLedger {
  override markCommitted(): Promise<void> { return Promise.reject(new Error("ledger write interrupted")); }
}

const baseDraft = {
  householdName: "梧桐家", agentName: "小满", modelReference: "gpt/gpt-4.1", bridges: [],
  modelProfile: { id: "gpt:setup:initial", provider: "gpt", kind: "api_key" as const, secretRef: "keychain:hob-agent/setup-model:initial:nonce" },
};

test("switches a probed operational model through ledger, CAS, synchronous activation, and post-drain cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-model-"));
  const vault = new MemoryVault();
  const oldRef = baseDraft.modelProfile.secretRef;
  vault.values.set(oldRef, "old-secret");
  const store = new ProductBootstrapConfigStore(directory);
  await store.commit(0, baseDraft);
  const resolver = new Resolver();
  const settings = new ProductOperationalModelSettings({
    configurationStore: store,
    resolver,
    modelSetup: new ProductModelSetup({ vault, createStageNonce: () => "nonce-next", probe: async (): Promise<ProviderProbeResult> => ({ model: "gpt/gpt-5", status: "ok", latencyMs: 4 }) }),
    cleanupLedger: new ProductModelCleanupLedger(directory), vault,
    createCandidateId: () => "candidate-next",
  });
  try {
    const result = await settings.configure({ expectedGeneration: 1, provider: "gpt", modelId: "gpt-5", apiKey: "new-secret" });
    assert.deepEqual(result, { status: "configured", generation: 2 });
    assert.deepEqual(await settings.projection(), {
      status: "active", generation: 2, configured: true, modelReference: "gpt/gpt-5",
      credentialConfigured: true,
    });
    const nextRef = "keychain:hob-agent/model:candidate-next:nonce-next";
    assert.equal(vault.values.get(nextRef), "new-secret");
    assert.equal(vault.values.get(oldRef), "old-secret");
    assert.deepEqual((await new ProductModelCleanupLedger(directory).load()).entries.map((entry) => entry.phase), ["active", "active"]);
    resolver.finishDrain();
    await settings.drainMaintenance();
    assert.equal(vault.values.has(oldRef), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reuses only the exact active credential for a blank same-provider canonical endpoint request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-model-reuse-"));
  const vault = new MemoryVault();
  const activeRef = "keychain:hob-agent/model:active-candidate:active-nonce";
  vault.values.set(activeRef, "saved-secret");
  const store = new ProductBootstrapConfigStore(directory);
  await store.commit(0, {
    ...baseDraft, modelReference: "custom/active-model", modelBaseURL: "https://models.example.test/v1",
    modelProfile: { id: "custom:operational:active-candidate", provider: "custom", kind: "api_key", secretRef: activeRef },
  });
  const ledger = new ProductModelCleanupLedger(directory);
  await ledger.adoptCommitted({
    candidateId: "active-candidate",
    credentialRef: activeRef,
    committedGeneration: 1,
  });
  // Voice changes share the product CAS generation but do not replace the
  // exact model credential owner.
  await store.commitVoice(1, undefined);
  const resolver = new Resolver();
  const settings = new ProductOperationalModelSettings({
    configurationStore: store, resolver,
    modelSetup: new ProductModelSetup({ vault, createStageNonce: () => "reuse-nonce", probe: async (): Promise<ProviderProbeResult> => ({ model: "custom/next", status: "ok", latencyMs: 1 }) }),
    cleanupLedger: ledger, vault, createCandidateId: () => "reuse-candidate",
  });
  try {
    const result = await settings.configure({ expectedGeneration: 2, provider: "custom", modelId: "next", baseURL: "https://models.example.test/v1/", apiKey: "" });
    assert.deepEqual(result, { status: "configured", generation: 3 });
    assert.equal(vault.values.get("keychain:hob-agent/model:reuse-candidate:reuse-nonce"), "saved-secret");
    assert.equal((await settings.projection()).status, "active");
    resolver.finishDrain();
    await settings.drainMaintenance();
    assert.equal(vault.deleted.includes(activeRef), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("adopts the committed candidate when promotion is interrupted after the model CAS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-model-ledger-recover-"));
  const vault = new MemoryVault();
  const store = new ProductBootstrapConfigStore(directory);
  await store.commit(0, baseDraft);
  const settings = new ProductOperationalModelSettings({
    configurationStore: store, resolver: new Resolver(),
    modelSetup: new ProductModelSetup({ vault, createStageNonce: () => "recover-nonce", probe: async (): Promise<ProviderProbeResult> => ({ model: "gpt/gpt-5", status: "ok", latencyMs: 1 }) }),
    cleanupLedger: new DelayedPromotionLedger(directory), vault, createCandidateId: () => "recover-candidate",
  });
  try {
    assert.deepEqual(await settings.configure({ expectedGeneration: 1, provider: "gpt", modelId: "gpt-5", apiKey: "new-secret" }), { status: "configured", generation: 2 });
    assert.equal((await new ProductModelCleanupLedger(directory).load()).entries[0]?.phase, "active");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleans a reserved candidate when its model probe throws before CAS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-model-probe-throw-"));
  const vault = new MemoryVault();
  const store = new ProductBootstrapConfigStore(directory);
  await store.commit(0, baseDraft);
  const setup = new ProductModelSetup({ vault, createStageNonce: () => "throw-nonce" });
  const settings = new ProductOperationalModelSettings({
    configurationStore: store, resolver: new Resolver(),
    modelSetup: {
      prepare: setup.prepare.bind(setup), stageOperational: setup.stageOperational.bind(setup), discard: setup.discard.bind(setup),
      execute: async () => { throw new Error("probe transport failed"); },
    },
    cleanupLedger: new ProductModelCleanupLedger(directory), vault, createCandidateId: () => "throw-candidate",
  });
  try {
    assert.deepEqual(await settings.configure({ expectedGeneration: 1, provider: "gpt", modelId: "gpt-5", apiKey: "candidate-secret" }), { status: "unavailable" });
    assert.equal((await store.load())?.generation, 1);
    assert.deepEqual(await new ProductModelCleanupLedger(directory).listPending(), []);
    assert.equal(vault.deleted.includes("keychain:hob-agent/model:throw-candidate:throw-nonce"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancels a hanging operational model probe without committing or retaining its staged credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-model-probe-cancel-"));
  const vault = new MemoryVault();
  const store = new ProductBootstrapConfigStore(directory);
  await store.commit(0, baseDraft);
  const resolver = new Resolver();
  let probeStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { probeStarted = resolve; });
  const settings = new ProductOperationalModelSettings({
    configurationStore: store,
    resolver,
    modelSetup: new ProductModelSetup({
      vault,
      createStageNonce: () => "cancelled-nonce",
      probe: async ({ signal }) => new Promise((resolve) => {
        probeStarted?.();
        signal?.addEventListener("abort", () => resolve({ model: "gpt/gpt-5", status: "unavailable", latencyMs: 0 }), { once: true });
      }),
    }),
    cleanupLedger: new ProductModelCleanupLedger(directory),
    vault,
    createCandidateId: () => "cancelled-candidate",
  });
  const controller = new AbortController();
  try {
    const pending = settings.configure({ expectedGeneration: 1, provider: "gpt", modelId: "gpt-5", apiKey: "request-local-secret", signal: controller.signal });
    await started;
    assert.deepEqual(await settings.configure({ expectedGeneration: 1, provider: "gpt", modelId: "gpt-5", apiKey: "different-secret" }), { status: "busy" });
    controller.abort();
    assert.deepEqual(await pending, { status: "cancelled" });
    assert.equal((await store.load())?.generation, 1);
    assert.deepEqual(resolver.prepared, []);
    assert.equal(vault.values.has("keychain:hob-agent/model:cancelled-candidate:cancelled-nonce"), false);
    assert.deepEqual(await new ProductModelCleanupLedger(directory).listPending(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("closes an operational model mutation before it can commit and waits for its credential cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-model-close-"));
  const vault = new MemoryVault();
  const store = new ProductBootstrapConfigStore(directory);
  await store.commit(0, baseDraft);
  let probeStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { probeStarted = resolve; });
  let finishProbe: ((result: ProviderProbeResult) => void) | undefined;
  const settings = new ProductOperationalModelSettings({
    configurationStore: store,
    resolver: new Resolver(),
    modelSetup: new ProductModelSetup({
      vault,
      createStageNonce: () => "close-nonce",
      probe: ({ signal }) => new Promise((resolve) => {
        finishProbe = resolve;
        probeStarted?.();
        signal?.addEventListener("abort", () => resolve({ model: "gpt/gpt-5", status: "unavailable", latencyMs: 0 }), { once: true });
      }),
    }),
    cleanupLedger: new ProductModelCleanupLedger(directory),
    vault,
    createCandidateId: () => "close-candidate",
  });
  let pending: Promise<unknown> | undefined;
  try {
    pending = settings.configure({
      expectedGeneration: 1,
      provider: "gpt",
      modelId: "gpt-5",
      apiKey: "request-local-secret",
    });
    await started;

    await settings.closeAndDrain();

    assert.deepEqual(await pending, { status: "cancelled" });
    assert.deepEqual(await settings.configure({
      expectedGeneration: 1,
      provider: "gpt",
      modelId: "gpt-5",
      apiKey: "later-request-secret",
    }), { status: "cancelled" });
    assert.equal((await store.load())?.generation, 1);
    assert.equal(vault.values.has("keychain:hob-agent/model:close-candidate:close-nonce"), false);
    assert.deepEqual(await new ProductModelCleanupLedger(directory).listPending(), []);
  } finally {
    finishProbe?.({ model: "gpt/gpt-5", status: "unavailable", latencyMs: 0 });
    await pending?.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancels provider preparation before commit and retires the exact staged credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-model-provider-cancel-"));
  const vault = new MemoryVault();
  const store = new ProductBootstrapConfigStore(directory);
  await store.commit(0, baseDraft);
  let prepareStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { prepareStarted = resolve; });
  const resolver = {
    status: () => ({ state: "ready" as const }),
    prepare: (_candidate: unknown, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      prepareStarted?.();
      if (signal === undefined) {
        setImmediate(() => reject(new Error("provider preparation received no cancellation signal")));
        return;
      }
      signal.addEventListener("abort", () => reject(new Error("provider preparation cancelled")), { once: true });
    }),
    activate: () => { throw new Error("cancelled provider preparation must not activate"); },
    discard: () => Promise.resolve(),
  };
  const settings = new ProductOperationalModelSettings({
    configurationStore: store,
    resolver,
    modelSetup: new ProductModelSetup({
      vault,
      createStageNonce: () => "provider-cancel-nonce",
      probe: async (): Promise<ProviderProbeResult> => ({ model: "gpt/gpt-5", status: "ok", latencyMs: 1 }),
    }),
    cleanupLedger: new ProductModelCleanupLedger(directory),
    vault,
    createCandidateId: () => "provider-cancel-candidate",
  });
  const controller = new AbortController();
  try {
    const pending = settings.configure({
      expectedGeneration: 1,
      provider: "gpt",
      modelId: "gpt-5",
      apiKey: "request-local-secret",
      signal: controller.signal,
    });
    await started;
    controller.abort();
    assert.deepEqual(await pending, { status: "cancelled" });
    assert.equal((await store.load())?.generation, 1);
    assert.equal(vault.values.has("keychain:hob-agent/model:provider-cancel-candidate:provider-cancel-nonce"), false);
    assert.deepEqual(await new ProductModelCleanupLedger(directory).listPending(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps the exact active credential after a retry drains the prior runtime generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-model-retry-"));
  const vault = new MemoryVault();
  const reference = "keychain:hob-agent/model:retry-candidate:retry-nonce";
  vault.values.set(reference, "saved-secret");
  const store = new ProductBootstrapConfigStore(directory);
  await store.commit(0, {
    ...baseDraft,
    modelProfile: { id: "gpt:operational:retry-candidate", provider: "gpt", kind: "api_key", secretRef: reference },
  });
  const resolver = new Resolver();
  const ledger = new ProductModelCleanupLedger(directory);
  await ledger.adoptCommitted({ candidateId: "retry-candidate", credentialRef: reference, committedGeneration: 1 });
  const settings = new ProductOperationalModelSettings({
    configurationStore: store, resolver,
    modelSetup: new ProductModelSetup({ vault }), cleanupLedger: ledger, vault, createCandidateId: () => "unused",
  });
  try {
    assert.equal(await settings.retry(), "active");
    resolver.finishDrain();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(vault.values.get(reference), "saved-secret");
    assert.equal((await ledger.load()).entries[0]?.phase, "active");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers a retired setup model credential after its first operational cleanup attempt fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-model-setup-retirement-"));
  const vault = new FailOnceDeleteVault();
  const setupReference = "keychain:hob-agent/setup-model:first-home:setup-nonce";
  const operationalReference = "keychain:hob-agent/model:replacement-model:operational-nonce";
  vault.values.set(setupReference, "first-setup-secret");
  const store = new ProductBootstrapConfigStore(directory);
  await store.commit(0, {
    ...baseDraft,
    modelProfile: {
      id: "gpt:setup:first-home",
      provider: "gpt",
      kind: "api_key",
      secretRef: setupReference,
    },
  });
  const resolver = new Resolver();
  const ledger = new ProductModelCleanupLedger(directory);
  const modelSetup = new ProductModelSetup({
    vault,
    createStageNonce: () => "operational-nonce",
    probe: async (): Promise<ProviderProbeResult> => ({ model: "gpt/gpt-5", status: "ok", latencyMs: 1 }),
  });
  const settings = new ProductOperationalModelSettings({
    configurationStore: store,
    resolver,
    modelSetup,
    cleanupLedger: ledger,
    vault,
    createCandidateId: () => "replacement-model",
  });
  try {
    assert.deepEqual(await settings.configure({
      expectedGeneration: 1,
      provider: "gpt",
      modelId: "gpt-5",
      apiKey: "replacement-secret",
    }), { status: "configured", generation: 2 });
    assert.equal((await store.load())?.modelProfile.secretRef, operationalReference);

    resolver.finishDrain();
    await settings.drainMaintenance();

    assert.equal(vault.values.get(setupReference), "first-setup-secret");
    const pending = await ledger.listPending();
    assert.equal(pending.length, 1);
    assert.deepEqual(
      pending[0] === undefined ? undefined : {
        credentialRef: pending[0].credentialRef,
        phase: pending[0].phase,
        reason: pending[0].reason,
      },
      { credentialRef: setupReference, phase: "pending_cleanup", reason: "retired" },
    );

    const recovered = new ProductOperationalModelSettings({
      configurationStore: store,
      resolver: new Resolver(),
      modelSetup,
      cleanupLedger: ledger,
      vault,
      createCandidateId: () => "unused",
    });
    await recovered.sweepCleanup();

    assert.equal(vault.values.has(setupReference), false);
    assert.equal(vault.values.get(operationalReference), "replacement-secret");
    assert.deepEqual(await ledger.listPending(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancels provider preparation for retry without activating a replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-model-retry-cancel-"));
  const vault = new MemoryVault();
  const store = new ProductBootstrapConfigStore(directory);
  await store.commit(0, baseDraft);
  let prepareStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { prepareStarted = resolve; });
  let receivedSignal = false;
  let activated = false;
  const resolver = {
    status: () => ({ state: "ready" as const }),
    prepare: (_candidate: unknown, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      prepareStarted?.();
      receivedSignal = signal !== undefined;
      if (signal === undefined) {
        setImmediate(() => reject(new Error("retry preparation received no cancellation signal")));
        return;
      }
      signal.addEventListener("abort", () => reject(new Error("retry preparation cancelled")), { once: true });
    }),
    activate: () => { activated = true; return { drained: Promise.resolve() }; },
    discard: () => Promise.resolve(),
  };
  const settings = new ProductOperationalModelSettings({
    configurationStore: store,
    resolver,
    modelSetup: new ProductModelSetup({ vault }),
    cleanupLedger: new ProductModelCleanupLedger(directory),
    vault,
    createCandidateId: () => "unused",
  });
  try {
    const pending = settings.retry();
    await started;
    settings.cancelRetry();
    assert.equal(await pending, "active");
    assert.equal(receivedSignal, true);
    assert.equal(activated, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("projects the resolver's live steady state after the product activates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-model-live-state-"));
  const vault = new MemoryVault();
  const store = new ProductBootstrapConfigStore(directory);
  await store.commit(0, baseDraft);
  const resolver = new MutableResolver();
  const settings = new ProductOperationalModelSettings({
    configurationStore: store,
    resolver,
    modelSetup: new ProductModelSetup({ vault }),
    cleanupLedger: new ProductModelCleanupLedger(directory),
    vault,
    createCandidateId: () => "unused",
  });
  try {
    resolver.state = "ready";
    assert.equal((await settings.projection()).status, "active");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps a working model active when a retry candidate cannot be prepared", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-operational-model-retry-failure-state-"));
  const vault = new MemoryVault();
  const store = new ProductBootstrapConfigStore(directory);
  await store.commit(0, baseDraft);
  const resolver = new Resolver();
  resolver.prepare = async () => { throw new Error("candidate unavailable"); };
  const settings = new ProductOperationalModelSettings({
    configurationStore: store,
    resolver,
    modelSetup: new ProductModelSetup({ vault }),
    cleanupLedger: new ProductModelCleanupLedger(directory),
    vault,
    createCandidateId: () => "unused",
  });
  try {
    assert.equal(await settings.retry(), "active");
    assert.equal((await settings.projection()).status, "active");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
