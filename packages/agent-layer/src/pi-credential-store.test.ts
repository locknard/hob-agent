import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentSecretVault, InMemorySecretVault, ProfileCredentialStore } from "./pi-credential-store.js";

test("reads only explicitly allowed environment secret references", async () => {
  const vault = new EnvironmentSecretVault(
    { OPENAI_API_KEY: "allowed-secret", UNRELATED_SECRET: "must-not-be-read" },
    ["OPENAI_API_KEY"],
  );

  assert.equal(await vault.read("env:OPENAI_API_KEY"), "allowed-secret");
  assert.equal(await vault.read("env:UNRELATED_SECRET"), undefined);
  assert.equal(await vault.read("keychain:openai"), undefined);
});

test("rejects malformed env references without inspecting or exposing environment values", async () => {
  let reads = 0;
  const environment = new Proxy({ OPENAI_API_KEY: "allowed-secret", OTHER_SECRET: "must-not-leak" }, {
    get(target, property, receiver) {
      if (typeof property === "string" && property !== "OPENAI_API_KEY") reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const vault = new EnvironmentSecretVault(environment, ["OPENAI_API_KEY"]);

  for (const reference of ["env:OPENAI_API_KEY ", "env:OPENAI\nAPI_KEY", "env:../OPENAI_API_KEY", "env:OTHER_SECRET"]) {
    assert.equal(await vault.read(reference), undefined);
  }
  assert.equal(reads, 0);
  assert.equal(await vault.read("env:OTHER_SECRET"), undefined);
});

test("treats an empty or whitespace-only allowlisted value as unavailable", async () => {
  const vault = new EnvironmentSecretVault(
    { EMPTY: "", BLANK: "   ", PRESENT: " key-with-padding " },
    ["EMPTY", "BLANK", "PRESENT"],
  );

  assert.equal(await vault.read("env:EMPTY"), undefined);
  assert.equal(await vault.read("env:BLANK"), undefined);
  assert.equal(await vault.read("env:PRESENT"), " key-with-padding ");
});

test("adapts selected profile credentials to pi-ai without exposing keys in list", async () => {
  const vault = new InMemorySecretVault({ "secret:gpt": "sk-test" });
  const store = new ProfileCredentialStore(vault, { openai: "secret:gpt" });

  assert.deepEqual(await store.list(), [{ providerId: "openai", type: "api_key" }]);
  assert.deepEqual(await store.read("openai"), { type: "api_key", key: "sk-test" });
  assert.equal(JSON.stringify(await store.list()).includes("sk-test"), false);
});
