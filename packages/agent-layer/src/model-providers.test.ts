import assert from "node:assert/strict";
import test from "node:test";

import { providerSetup } from "./model-providers.js";

test("publishes the DSH route catalog without resolving credentials", () => {
  assert.deepEqual(
    ["gpt", "claude", "deepseek", "kimi", "glm"].map((provider) => {
      const setup = providerSetup(provider as never);
      return [setup.id, setup.runtimeProviderId, setup.credentialEnv];
    }),
    [
      ["gpt", "openai", "OPENAI_API_KEY"],
      ["claude", "anthropic", "ANTHROPIC_API_KEY"],
      ["deepseek", "deepseek", "DEEPSEEK_API_KEY"],
      ["kimi", "moonshotai", "MOONSHOT_API_KEY"],
      ["glm", "zai", "ZAI_API_KEY"],
    ],
  );
});

test("publishes provider setup without exposing credential values", () => {
  assert.equal(providerSetup("glm").runtimeProviderId, "zai");
  assert.equal(providerSetup("glm").credentialEnv, "ZAI_API_KEY");
  assert.throws(() => providerSetup("unknown" as never), /Unsupported model provider/);
});
