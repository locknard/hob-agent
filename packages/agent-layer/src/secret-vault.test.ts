import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentSecretVault } from "./secret-vault.js";

test("reads only explicitly allowed environment secret references", async () => {
  const vault = new EnvironmentSecretVault(
    { OPENAI_API_KEY: "allowed-secret", UNRELATED_SECRET: "must-not-be-read" },
    ["OPENAI_API_KEY"],
  );

  assert.equal(await vault.read("env:OPENAI_API_KEY"), "allowed-secret");
  assert.equal(await vault.read("env:UNRELATED_SECRET"), undefined);
  assert.equal(await vault.read("keychain:openai"), undefined);
});

test("rejects malformed env references without inspecting environment values", async () => {
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
