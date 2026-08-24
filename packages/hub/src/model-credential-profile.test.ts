import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthProfileConfigStore } from "@hob-agent/agent-layer/model-credentials";

import {
  loadSelectedModelCredential,
  provisionPrimaryModelApiKey,
} from "./model-credential-profile.js";

test("provisions the primary API-key profile without persisting the secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-model-credential-"));
  const writes = new Map<string, string>();
  const vault = {
    read: async (reference: string) => writes.get(reference),
    write: async (reference: string, value: string) => { writes.set(reference, value); },
    delete: async (reference: string) => { writes.delete(reference); },
  };

  const profile = await provisionPrimaryModelApiKey(directory, "deepseek", "test-secret", vault);

  assert.deepEqual(profile, {
    id: "deepseek:primary",
    provider: "deepseek",
    kind: "api_key",
    secretRef: "keychain:hob-agent/deepseek:primary",
  });
  assert.equal(writes.get(profile.secretRef), "test-secret");
  const path = join(directory, "auth-profiles.json");
  const raw = await readFile(path, "utf8");
  assert.equal(raw.includes("test-secret"), false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await new AuthProfileConfigStore(path).load()).order.deepseek, ["deepseek:primary"]);
});

test("provisions and loads a primary profile with the selected encrypted-vault source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-model-credential-vault-"));
  const writes = new Map<string, string>();
  const vault = {
    read: async (reference: string) => writes.get(reference),
    write: async (reference: string, value: string) => { writes.set(reference, value); },
    delete: async (reference: string) => { writes.delete(reference); },
  };
  const profile = await provisionPrimaryModelApiKey(directory, "gpt", "vault-secret", vault, "vault");
  assert.equal(profile.secretRef, "vault:hob-agent/gpt:primary");
  assert.equal(writes.get(profile.secretRef), "vault-secret");
  assert.deepEqual(await loadSelectedModelCredential(directory, "gpt", vault), { profile, vault });
});

test("loads only the explicitly ordered profile for the selected provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-model-credential-select-"));
  const store = new AuthProfileConfigStore(join(directory, "auth-profiles.json"));
  await store.upsert({
    id: "deepseek:primary",
    provider: "deepseek",
    kind: "api_key",
    secretRef: "keychain:hob-agent/deepseek:primary",
  });
  await store.setOrder("deepseek", ["deepseek:primary"]);
  const vault = { read: async () => "available" };

  assert.deepEqual(await loadSelectedModelCredential(directory, "deepseek", vault), {
    profile: {
      id: "deepseek:primary",
      provider: "deepseek",
      kind: "api_key",
      secretRef: "keychain:hob-agent/deepseek:primary",
    },
    vault,
  });
  assert.equal(await loadSelectedModelCredential(directory, "gpt", vault), undefined);
});

test("fails closed when ordered profile metadata cannot authenticate the provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-model-credential-invalid-"));
  const store = new AuthProfileConfigStore(join(directory, "auth-profiles.json"));
  await store.upsert({
    id: "wrong",
    provider: "gpt",
    kind: "api_key",
    secretRef: "keychain:hob-agent/wrong",
  });
  await store.setOrder("deepseek", ["wrong"]);

  await assert.rejects(
    loadSelectedModelCredential(directory, "deepseek", { read: async () => "available" }),
    /ordered credential profile/i,
  );
});
