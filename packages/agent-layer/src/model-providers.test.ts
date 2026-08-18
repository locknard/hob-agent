import assert from "node:assert/strict";
import test from "node:test";

import { createProviderModels, providerSetup } from "./model-providers.js";

test("registers the supported provider catalog without resolving credentials", () => {
  const models = createProviderModels();

  assert.deepEqual(
    models.getProviders().map((provider) => provider.id).sort(),
    ["anthropic", "deepseek", "moonshotai", "openai", "zai"],
  );
  assert.equal(models.getModel("openai", "gpt-5.4")?.provider, "openai");
  assert.equal(models.getModel("anthropic", "claude-sonnet-4-6")?.provider, "anthropic");
  assert.equal(models.getModel("deepseek", "deepseek-v4-flash")?.provider, "deepseek");
  assert.equal(models.getModel("moonshotai", "kimi-k2.6")?.provider, "moonshotai");
  assert.equal(models.getModel("zai", "glm-5.2")?.provider, "zai");
});

test("publishes provider setup without exposing credential values", () => {
  assert.deepEqual(providerSetup("glm"), {
    id: "glm",
    piProviderId: "zai",
    credentialEnv: "ZAI_API_KEY",
  });
  assert.throws(() => providerSetup("unknown" as never), /Unsupported model provider/);
});

test("passes an injected credential store into pi provider resolution", async () => {
  let reads = 0;
  const credentials = {
    read: async () => {
      reads += 1;
      return { type: "api_key" as const, key: "test-only-key" };
    },
    list: async () => [],
    modify: async () => undefined,
    delete: async () => {},
  };
  const models = createProviderModels({ credentials });

  const auth = await models.getAuth("openai");

  assert.equal(reads, 1);
  assert.equal(auth?.auth.apiKey, "test-only-key");
});
