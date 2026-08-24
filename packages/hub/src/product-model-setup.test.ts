import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProviderProbeResult } from "@hob-agent/agent-layer/model-credential-probe";

import { ProductModelSetup } from "./product-model-setup.js";
import { ProductModelCleanupLedger } from "./product-model-cleanup-ledger.js";
import { ProductSetupDraftStore } from "./product-setup-draft-store.js";

class MemoryVault {
  readonly values = new Map<string, string>();
  readonly deleted: string[] = [];

  read(reference: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(reference));
  }

  write(reference: string, value: string): Promise<void> {
    this.values.set(reference, value);
    return Promise.resolve();
  }

  delete(reference: string): Promise<void> {
    this.deleted.push(reference);
    this.values.delete(reference);
    return Promise.resolve();
  }
}

async function reserveSetupLease(stage: Parameters<ProductSetupDraftStore["reserveModelCredential"]>[0]["stage"]) {
  const directory = await mkdtemp(join(tmpdir(), "hob-model-setup-draft-lease-"));
  const token = "private-model-setup-test-token-value-123456";
  const draftId = stage.profile.id.split(":")[2]!;
  const store = new ProductSetupDraftStore(directory, () => new Date("2026-08-24T10:00:00.000Z"), () => draftId);
  await store.establishSession({ sessionToken: token, sessionExpiresAt: new Date("2026-08-25T10:00:00.000Z") });
  await store.saveIdentity({ sessionToken: token, expectedRevision: 1, householdName: "测试家", agentName: "hob" });
  const lease = await store.reserveModelCredential({ sessionToken: token, expectedRevision: 2, stage });
  return { lease, dispose: () => rm(directory, { recursive: true, force: true }) };
}

test("uses the selected encrypted-vault source for new model setup locators", () => {
  const setup = new ProductModelSetup({ credentialRefSource: "vault", createStageNonce: () => "vault-stage" });
  const preparation = setup.prepare({
    setupId: "vault-draft",
    provider: "gpt",
    modelId: "gpt-5",
    apiKey: "request-secret",
  });
  assert.equal(preparation.status, "prepared");
  if (preparation.status !== "prepared") assert.fail("expected a prepared model candidate");
  assert.equal(setup.stageSetup(preparation.prepared, "vault-draft").profile.secretRef, "vault:hob-agent/setup-model:vault-draft:vault-stage");
});

test("executes a durably leased custom OpenAI-compatible model probe without selecting a primary profile", async () => {
  const vault = new MemoryVault();
  const calls: Array<{ profileId: string; secretRef: string; modelId: string; baseURL?: string }> = [];
  const setup = new ProductModelSetup({
    vault,
    createStageNonce: () => "probe-1",
    probe: async (input): Promise<ProviderProbeResult> => {
      calls.push({
        profileId: input.profile.id,
        secretRef: input.profile.secretRef ?? "",
        modelId: input.modelId,
        baseURL: input.baseURL,
      });
      return { model: "custom/qwen3", status: "ok", latencyMs: 42 };
    },
  });

  const preparation = setup.prepare({
    setupId: "draft-a",
    provider: "custom",
    modelId: "qwen3",
    baseURL: "https://models.example.test/v1/",
    apiKey: "custom-secret",
  });
  assert.equal(preparation.status, "prepared");
  if (preparation.status !== "prepared") assert.fail("expected a prepared model candidate");
  const stage = setup.stageSetup(preparation.prepared, "draft-a");
  await assert.rejects(
    setup.execute({ prepared: preparation.prepared, stage, credentialLease: { stage } as never }),
    /durable staging lease/,
  );
  assert.equal(vault.values.size, 0);
  const owner = await reserveSetupLease(stage);
  const result = await setup.execute({ prepared: preparation.prepared, stage, credentialLease: owner.lease });

  assert.deepEqual(result, {
    status: "ready",
    latencyMs: 42,
    staged: {
      profile: {
        id: "custom:setup:draft-a",
        provider: "custom",
        kind: "api_key",
        secretRef: "keychain:hob-agent/setup-model:draft-a:probe-1",
      },
      modelId: "qwen3",
      baseURL: "https://models.example.test/v1",
    },
  });
  assert.deepEqual(calls, [{
    profileId: "custom:setup:draft-a",
    secretRef: "keychain:hob-agent/setup-model:draft-a:probe-1",
    modelId: "qwen3",
    baseURL: "https://models.example.test/v1",
  }]);
  assert.equal(vault.values.get("keychain:hob-agent/setup-model:draft-a:probe-1"), "custom-secret");
  assert.equal(vault.values.has("keychain:hob-agent/custom:primary"), false);
  if (result.status !== "ready") assert.fail("expected ready model probe");
  await setup.discard(result.staged);
  assert.equal(vault.values.has("keychain:hob-agent/setup-model:draft-a:probe-1"), false);
  await owner.dispose();
});

test("returns a failed result from a durably leased model probe for its owner to clean up", async () => {
  const vault = new MemoryVault();
  const setup = new ProductModelSetup({
    vault,
    createStageNonce: () => "failed-probe",
    probe: async (): Promise<ProviderProbeResult> => ({
      model: "gpt/gpt-5",
      status: "auth",
      latencyMs: 9,
    }),
  });

  const preparation = setup.prepare({
    setupId: "draft-b",
    provider: "gpt",
    modelId: "gpt-5",
    apiKey: "wrong-secret",
  });
  assert.equal(preparation.status, "prepared");
  if (preparation.status !== "prepared") assert.fail("expected a prepared model candidate");
  const stage = setup.stageSetup(preparation.prepared, "draft-b");
  const owner = await reserveSetupLease(stage);
  const result = await setup.execute({ prepared: preparation.prepared, stage, credentialLease: owner.lease });

  assert.deepEqual(result, { status: "rejected" });
  assert.deepEqual(vault.deleted, []);
  assert.equal(vault.values.get("keychain:hob-agent/setup-model:draft-b:failed-probe"), "wrong-secret");
  await owner.dispose();
});

test("returns a closed missing outcome before staging an incomplete model", () => {
  const vault = new MemoryVault();
  const setup = new ProductModelSetup({
    vault,
    probe: async (): Promise<ProviderProbeResult> => ({ model: "unused", status: "ok", latencyMs: 0 }),
  });

  const result = setup.prepare({
    setupId: "draft-c",
    provider: "custom",
    modelId: "qwen3",
    baseURL: "https://models.example.test/v1",
    apiKey: "",
  });

  assert.deepEqual(result, { status: "missing", field: "apiKey" });
  assert.equal(vault.values.size, 0);
});

test("requires a caller-owned durable lease before an operational model credential write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-model-setup-lease-"));
  const vault = new MemoryVault();
  const setup = new ProductModelSetup({
    vault,
    createStageNonce: () => "nonce-next",
    probe: async (): Promise<ProviderProbeResult> => ({ model: "gpt/gpt-5", status: "ok", latencyMs: 5 }),
  });
  try {
    const preparation = setup.prepare({ setupId: "ignored-by-operational-settings", provider: "gpt", modelId: "gpt-5", apiKey: "candidate-secret" });
    assert.equal(preparation.status, "prepared");
    if (preparation.status !== "prepared") assert.fail("expected a prepared model candidate");
    const stage = setup.stageOperational(preparation.prepared, "candidate-next");
    await assert.rejects(setup.execute({ prepared: preparation.prepared, stage, credentialLease: {} as never }), /durable staging lease/);
    const lease = await new ProductModelCleanupLedger(directory).reserve({ candidateId: "candidate-next", credentialRef: stage.profile.secretRef!, expectedGeneration: 1 });
    const outcome = await setup.execute({ prepared: preparation.prepared, stage, credentialLease: lease });
    assert.equal(outcome.status, "ready");
    assert.equal(vault.values.get("keychain:hob-agent/model:candidate-next:nonce-next"), "candidate-secret");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
