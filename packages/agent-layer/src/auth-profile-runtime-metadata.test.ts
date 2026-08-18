import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthProfileConfigStore } from "./auth-profile-config-store.js";
import { AuthProfileMetadataRepository } from "./auth-profile-metadata-repository.js";
import { AuthProfileRuntimeMetadataWriter } from "./auth-profile-runtime-metadata.js";
import { loadPersistedAuthProfileCoordinator } from "./auth-profile-runtime-loader.js";
import { AuthProfileStateStore } from "./auth-profile-state-store.js";
import { PersistedAuthProfileCoordinator } from "./persisted-auth-profile-coordinator.js";

test("persists OAuth expiry before updating the running selector and preserves ready after rebuild", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-agent-auth-runtime-metadata-"));
  const config = new AuthProfileConfigStore(join(directory, "profiles.json"));
  const durable = new AuthProfileStateStore(":memory:");
  const profile = {
    id: "claude:household",
    provider: "claude",
    kind: "oauth" as const,
    secretRef: "keychain:hob-agent/claude:household",
  };
  try {
    const coordinator = new PersistedAuthProfileCoordinator([profile], durable);
    const writer = new AuthProfileRuntimeMetadataWriter(
      new AuthProfileMetadataRepository(config, durable),
      coordinator,
    );

    await writer.upsert({ ...profile, expiresAt: 10_000 });

    assert.equal(coordinator.status("claude", 1_000)[0]?.availability, "ready");
    assert.equal((await config.load()).profiles[0]?.expiresAt, 10_000);

    const rebuiltState = new AuthProfileStateStore(":memory:");
    try {
      const rebuilt = await loadPersistedAuthProfileCoordinator(config, rebuiltState);
      assert.equal(rebuilt.status("claude", 1_000)[0]?.availability, "ready");
    } finally {
      rebuiltState.close();
    }
  } finally {
    durable.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps profile order and removal synchronized in config, durable state, and selector", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-agent-auth-runtime-metadata-"));
  const config = new AuthProfileConfigStore(join(directory, "profiles.json"));
  const durable = new AuthProfileStateStore(":memory:");
  const profiles = [
    {
      id: "gpt:primary",
      provider: "gpt",
      kind: "api_key" as const,
      secretRef: "env:PRIMARY",
    },
    {
      id: "gpt:backup",
      provider: "gpt",
      kind: "api_key" as const,
      secretRef: "env:BACKUP",
    },
  ];
  try {
    const coordinator = new PersistedAuthProfileCoordinator(profiles, durable);
    const writer = new AuthProfileRuntimeMetadataWriter(
      new AuthProfileMetadataRepository(config, durable),
      coordinator,
    );
    await writer.upsert(profiles[0]);
    await writer.upsert(profiles[1]);

    await writer.setOrder("gpt", ["gpt:backup", "gpt:primary"]);
    assert.deepEqual(coordinator.resolveOrder("gpt", 1_000), ["gpt:backup", "gpt:primary"]);
    assert.deepEqual(durable.order("gpt"), ["gpt:backup", "gpt:primary"]);
    assert.deepEqual((await config.load()).order, { gpt: ["gpt:backup", "gpt:primary"] });

    await writer.remove("gpt:backup");
    assert.deepEqual(coordinator.resolveOrder("gpt", 1_000), ["gpt:primary"]);
    assert.deepEqual(durable.order("gpt"), ["gpt:primary"]);
    assert.deepEqual((await config.load()).profiles.map((profile) => profile.id), ["gpt:primary"]);
    assert.deepEqual((await config.load()).order, { gpt: ["gpt:primary"] });
  } finally {
    durable.close();
    await rm(directory, { recursive: true, force: true });
  }
});
