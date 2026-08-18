import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthProfileConfigStore } from "./auth-profile-config-store.js";
import { AuthProfileStateStore } from "./auth-profile-state-store.js";
import { loadPersistedAuthProfileCoordinator } from "./auth-profile-runtime-loader.js";

test("rebuilds profile selection from private config and non-secret state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-agent-auth-runtime-"));
  const durable = new AuthProfileStateStore(":memory:");
  try {
    const config = new AuthProfileConfigStore(join(directory, "profiles.json"));
    await config.upsert({ id: "gpt:first", provider: "gpt", kind: "api_key", secretRef: "keychain:hob-agent/gpt:first" });
    await config.upsert({ id: "gpt:second", provider: "gpt", kind: "api_key", secretRef: "keychain:hob-agent/gpt:second" });
    await config.setOrder("gpt", ["gpt:second", "gpt:first"]);

    const profiles = await loadPersistedAuthProfileCoordinator(config, durable);

    assert.deepEqual(profiles.resolveOrder("gpt", 1_000), ["gpt:second", "gpt:first"]);
    assert.equal(durable.contains("keychain:hob-agent/gpt:first"), false);
  } finally {
    durable.close();
    await rm(directory, { recursive: true, force: true });
  }
});
