import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

import { InMemorySecretVault } from "./pi-credential-store.js";
import {
  createProfileCredentialStore,
  mountProfileCredentialProvider,
} from "./profile-credential-runtime.js";

test("maps a selected API-key profile to its provider route without exposing other providers", async () => {
  const credentials = createProfileCredentialStore(
    { id: "gpt:primary", provider: "gpt", kind: "api_key", secretRef: "env:OPENAI_API_KEY" },
    new InMemorySecretVault({ "env:OPENAI_API_KEY": "test-key" }),
  );

  assert.deepEqual(await credentials.read("openai"), { type: "api_key", key: "test-key" });
  assert.equal(await credentials.read("anthropic"), undefined);
  assert.deepEqual(await credentials.list(), [{ providerId: "openai", type: "api_key" }]);
});

test("refuses profiles that cannot safely serve an API-key runtime", () => {
  const vault = new InMemorySecretVault({});
  assert.throws(
    () => createProfileCredentialStore({ id: "claude:oauth", provider: "claude", kind: "oauth" }, vault),
    /API-key profile/,
  );
  assert.throws(
    () => createProfileCredentialStore({ id: "gpt:missing", provider: "gpt", kind: "api_key" }, vault),
    /secret reference/,
  );
});

test("mounts a selected API-key profile through the DSH credential seam", async () => {
  const ctx = new Context();
  const values: Record<string, string> = {
    "keychain:hob-agent/deepseek:primary": "first-key",
  };
  const fiber = await mountProfileCredentialProvider(ctx, {
    id: "deepseek:primary",
    provider: "deepseek",
    kind: "api_key",
    secretRef: "keychain:hob-agent/deepseek:primary",
  }, {
    read: async (reference) => values[reference],
  });

  const ref = credentialRef("DEEPSEEK_API_KEY");
  assert.deepEqual(await ctx.credentials.resolve(ref), {
    value: "first-key",
    source: "profile",
  });
  values["keychain:hob-agent/deepseek:primary"] = "rotated-key";
  assert.deepEqual(await ctx.credentials.resolve(ref), {
    value: "rotated-key",
    source: "profile",
  });

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("keeps profile runtime types on the DSH seam", async () => {
  const source = await readFile(new URL("./profile-credential-runtime.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /@earendil-works\/pi-ai/);
});
