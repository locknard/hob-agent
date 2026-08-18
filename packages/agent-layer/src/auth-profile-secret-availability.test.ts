import assert from "node:assert/strict";
import test from "node:test";

import { AuthProfileStateStore } from "./auth-profile-state-store.js";
import { observeAuthProfileSecretAvailability } from "./auth-profile-secret-availability.js";
import { PersistedAuthProfileCoordinator } from "./persisted-auth-profile-coordinator.js";

test("applies allowlisted env availability to selection without returning the locator", () => {
  const durable = new AuthProfileStateStore(":memory:");
  const profile = { id: "gpt:primary", provider: "gpt", kind: "api_key" as const, secretRef: "env:OPENAI_API_KEY" };
  const profiles = new PersistedAuthProfileCoordinator([profile], durable);

  const observation = observeAuthProfileSecretAvailability(profile, profiles, {
    env: {},
    envAllowlist: ["OPENAI_API_KEY"],
  });

  assert.deepEqual(observation, { profileId: "gpt:primary", availability: "missing" });
  assert.equal("ref" in observation, false);
  assert.deepEqual(profiles.resolveOrder("gpt", 1_000), []);
  durable.close();
});

test("keeps a passively observed Keychain profile selectable without invoking a reader", () => {
  const durable = new AuthProfileStateStore(":memory:");
  const profile = {
    id: "gpt:keychain",
    provider: "gpt",
    kind: "api_key" as const,
    secretRef: "keychain:hob-agent/gpt:keychain",
  };
  const profiles = new PersistedAuthProfileCoordinator([profile], durable);
  let reads = 0;

  const observation = observeAuthProfileSecretAvailability(profile, profiles, {
    env: {},
    envAllowlist: [],
    readKeychain: () => { reads += 1; },
  });

  assert.deepEqual(observation, { profileId: "gpt:keychain", availability: "unknown" });
  assert.equal(reads, 0);
  assert.deepEqual(profiles.resolveOrder("gpt", 1_000), ["gpt:keychain"]);
  durable.close();
});
