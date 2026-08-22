import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthProfileConfigStore } from "./auth-profile-config-store.js";

test("persists profile locators and order in a private config file without secret material", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-agent-auth-config-"));
  const path = join(directory, "profiles.json");
  try {
    const store = new AuthProfileConfigStore(path);
    await store.upsert({
      id: "gpt:primary",
      provider: "gpt",
      kind: "api_key",
      secretRef: "keychain:hob-agent/gpt:primary",
    });
    await store.setOrder("gpt", ["gpt:primary"]);

    assert.deepEqual(await store.load(), {
      profiles: [{
        id: "gpt:primary",
        provider: "gpt",
        kind: "api_key",
        secretRef: "keychain:hob-agent/gpt:primary",
      }],
      order: { gpt: ["gpt:primary"] },
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await readFile(path, "utf8")).includes("api-key-value"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes same-process profile configuration mutations without losing updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-agent-auth-config-"));
  const path = join(directory, "profiles.json");
  try {
    const store = new AuthProfileConfigStore(path);
    await Promise.all([
      store.upsert({ id: "gpt:primary", provider: "gpt", kind: "api_key", secretRef: "keychain:hob-agent/gpt:primary" }),
      store.upsert({ id: "gpt:backup", provider: "gpt", kind: "api_key", secretRef: "keychain:hob-agent/gpt:backup" }),
      store.setOrder("gpt", ["gpt:primary", "gpt:backup"]),
    ]);

    assert.deepEqual((await store.load()).profiles.map((profile) => profile.id).sort(), ["gpt:backup", "gpt:primary"]);
    assert.deepEqual((await store.load()).order, { gpt: ["gpt:primary", "gpt:backup"] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when another process holds the profile configuration lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-agent-auth-config-"));
  const path = join(directory, "profiles.json");
  try {
    await writeFile(`${path}.lock`, "held", { mode: 0o600 });
    const store = new AuthProfileConfigStore(path, { lockTimeoutMs: 10, lockRetryMs: 1 });
    await assert.rejects(
      store.upsert({ id: "gpt:primary", provider: "gpt", kind: "api_key", secretRef: "keychain:hob-agent/gpt:primary" }),
      /lock timed out/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an unsupported persisted profile configuration version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-agent-auth-config-"));
  const path = join(directory, "profiles.json");
  try {
    await writeFile(path, JSON.stringify({ version: 2, profiles: [], order: {} }), { mode: 0o600 });
    await assert.rejects(new AuthProfileConfigStore(path).load(), /Unsupported auth profile configuration version/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removes a profile and scrubs it from every explicit provider order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-agent-auth-config-"));
  const path = join(directory, "profiles.json");
  try {
    const store = new AuthProfileConfigStore(path);
    await store.upsert({ id: "gpt:primary", provider: "gpt", kind: "api_key", secretRef: "keychain:hob-agent/gpt:primary" });
    await store.upsert({ id: "gpt:backup", provider: "gpt", kind: "api_key", secretRef: "keychain:hob-agent/gpt:backup" });
    await store.setOrder("gpt", ["gpt:primary", "gpt:backup"]);

    await store.remove("gpt:primary");

    assert.deepEqual(await store.load(), {
      profiles: [{ id: "gpt:backup", provider: "gpt", kind: "api_key", secretRef: "keychain:hob-agent/gpt:backup" }],
      order: { gpt: ["gpt:backup"] },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
