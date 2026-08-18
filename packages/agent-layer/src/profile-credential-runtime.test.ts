import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySecretVault } from "./pi-credential-store.js";
import { createProfileCredentialStore } from "./profile-credential-runtime.js";

test("maps a selected API-key profile to its pi provider without exposing other providers", async () => {
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
