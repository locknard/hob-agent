import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderProbeResult } from "@hob-agent/agent-layer/model-credential-probe";

import { ProductModelSetup } from "./product-model-setup.js";

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

test("probes a staged custom OpenAI-compatible model without selecting a primary profile", async () => {
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

  const result = await setup.probe({
    setupId: "draft-a",
    provider: "custom",
    modelId: "qwen3",
    baseURL: "https://models.example.test/v1/",
    apiKey: "custom-secret",
  });

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
});

test("removes a staged credential when its live probe is not ready", async () => {
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

  const result = await setup.probe({
    setupId: "draft-b",
    provider: "gpt",
    modelId: "gpt-5",
    apiKey: "wrong-secret",
  });

  assert.deepEqual(result, { status: "rejected" });
  assert.deepEqual(vault.deleted, ["keychain:hob-agent/setup-model:draft-b:failed-probe"]);
  assert.equal(vault.values.size, 0);
});

test("returns a closed missing outcome before staging an incomplete model", async () => {
  const vault = new MemoryVault();
  const setup = new ProductModelSetup({
    vault,
    probe: async (): Promise<ProviderProbeResult> => ({ model: "unused", status: "ok", latencyMs: 0 }),
  });

  const result = await setup.probe({
    setupId: "draft-c",
    provider: "custom",
    modelId: "qwen3",
    baseURL: "https://models.example.test/v1",
    apiKey: "",
  });

  assert.deepEqual(result, { status: "missing", field: "apiKey" });
  assert.equal(vault.values.size, 0);
});
