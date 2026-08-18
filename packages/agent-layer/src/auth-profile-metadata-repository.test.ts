import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthProfileConfigStore } from "./auth-profile-config-store.js";
import { AuthProfileMetadataRepository } from "./auth-profile-metadata-repository.js";
import { AuthProfileStateStore } from "./auth-profile-state-store.js";

test("writes locator configuration and non-secret runtime metadata through one repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-agent-auth-repository-"));
  const state = new AuthProfileStateStore(":memory:");
  try {
    const config = new AuthProfileConfigStore(join(directory, "profiles.json"));
    const repository = new AuthProfileMetadataRepository(config, state);
    await repository.upsert({
      id: "gpt:primary",
      provider: "gpt",
      kind: "api_key",
      secretRef: "keychain:hob-agent/gpt:primary",
    });
    await repository.setOrder("gpt", ["gpt:primary"]);

    assert.deepEqual((await config.load()).order, { gpt: ["gpt:primary"] });
    assert.deepEqual(state.order("gpt"), ["gpt:primary"]);
    assert.equal(state.contains("keychain:hob-agent/gpt:primary"), false);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("removes profile metadata and every order reference through one repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-agent-auth-repository-"));
  const state = new AuthProfileStateStore(":memory:");
  try {
    const config = new AuthProfileConfigStore(join(directory, "profiles.json"));
    const repository = new AuthProfileMetadataRepository(config, state);
    await repository.upsert({ id: "gpt:primary", provider: "gpt", kind: "api_key", secretRef: "keychain:hob-agent/gpt:primary" });
    await repository.upsert({ id: "gpt:backup", provider: "gpt", kind: "api_key", secretRef: "keychain:hob-agent/gpt:backup" });
    await repository.setOrder("gpt", ["gpt:primary", "gpt:backup"]);

    await repository.remove("gpt:primary");

    assert.deepEqual((await config.load()).order, { gpt: ["gpt:backup"] });
    assert.deepEqual(state.order("gpt"), ["gpt:backup"]);
    assert.deepEqual(state.list("gpt").map((profile) => profile.id), ["gpt:backup"]);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
