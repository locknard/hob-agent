import assert from "node:assert/strict";
import test from "node:test";

import { providerSetup } from "./model-providers.js";

test("publishes the DSH route catalog without resolving credentials", () => {
  assert.deepEqual(
    ["gpt", "claude", "deepseek", "kimi", "glm", "custom"].map((provider) => {
      const setup = providerSetup(
        provider as never,
        provider === "custom" ? { baseURL: "https://models.example.test/v1" } : undefined,
      );
      return [setup.id, setup.runtimeProviderId, setup.credentialEnv];
    }),
    [
      ["gpt", "openai", "OPENAI_API_KEY"],
      ["claude", "anthropic", "ANTHROPIC_API_KEY"],
      ["deepseek", "deepseek", "DEEPSEEK_API_KEY"],
      ["kimi", "moonshotai", "MOONSHOT_API_KEY"],
      ["glm", "zai", "ZAI_API_KEY"],
      ["custom", "hob-custom-openai", "HOB_CUSTOM_MODEL_API_KEY"],
    ],
  );
});

test("validates one HTTPS OpenAI-compatible custom deployment endpoint", () => {
  assert.equal(
    providerSetup("custom", { baseURL: "https://models.example.test:8443/v1/" }).baseURL,
    "https://models.example.test:8443/v1",
  );
  for (const baseURL of [
    "http://models.example.test/v1",
    "https://user:secret@models.example.test/v1",
    "https://models.example.test/v1?token=secret",
    "https://models.example.test/v1#fragment",
  ]) {
    assert.throws(() => providerSetup("custom", { baseURL }), /custom model endpoint/i);
  }
  assert.throws(() => providerSetup("custom"), /custom model endpoint/i);
  assert.throws(
    () => providerSetup("deepseek", { baseURL: "https://models.example.test/v1" }),
    /only valid for custom/i,
  );
});

test("publishes provider setup without exposing credential values", () => {
  const setup = providerSetup("glm");
  assert.equal(setup.runtimeProviderId, "zai");
  assert.equal(setup.credentialEnv, "ZAI_API_KEY");
  assert.equal(Object.hasOwn(setup, "piProviderId"), false);
  assert.throws(() => providerSetup("unknown" as never), /Unsupported model provider/);
});
