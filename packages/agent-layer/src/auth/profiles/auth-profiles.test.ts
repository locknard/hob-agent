import assert from "node:assert/strict";
import test from "node:test";

import { AuthProfileStore, type AuthProfile } from "./auth-profiles.js";

const profiles: AuthProfile[] = [
  { id: "gpt:primary", provider: "gpt", kind: "api_key", secretRef: "env:OPENAI_API_KEY" },
  { id: "gpt:backup", provider: "gpt", kind: "api_key", secretRef: "env:OPENAI_API_KEY_2" },
  { id: "claude:oauth", provider: "claude", kind: "oauth", expiresAt: 1_900_000_000_000 },
];

test("uses explicit profile order and does not expose credential references in status", () => {
  const store = new AuthProfileStore(profiles, { gpt: ["gpt:backup"] });

  assert.deepEqual(store.resolveOrder("gpt", 1_800_000_000_000), ["gpt:backup"]);
  assert.deepEqual(store.status("gpt"), [{
    id: "gpt:backup",
    provider: "gpt",
    kind: "api_key",
    availability: "ready",
  }]);
});

test("moves active cooldowns to the end and clears expired cooldowns", () => {
  const store = new AuthProfileStore(profiles);
  store.recordFailure("gpt:primary", "rate_limit", 1_000, 60_000);
  store.recordFailure("gpt:backup", "timeout", 1_000, 10_000);

  assert.deepEqual(store.resolveOrder("gpt", 2_000), ["gpt:backup", "gpt:primary"]);
  assert.deepEqual(store.resolveOrder("gpt", 62_000), ["gpt:primary", "gpt:backup"]);
  assert.equal(store.status("gpt", 62_000)[0]?.availability, "ready");
});

test("marks expired OAuth profiles unavailable without attempting fallback credentials", () => {
  const store = new AuthProfileStore(profiles);

  assert.deepEqual(store.resolveOrder("claude", 2_000_000_000_000), []);
  assert.deepEqual(store.status("claude", 2_000_000_000_000), [{
    id: "claude:oauth",
    provider: "claude",
    kind: "oauth",
    availability: "expired",
  }]);
});

test("disables a profile after stable authentication or billing failure instead of retrying it", () => {
  const store = new AuthProfileStore(profiles);
  store.recordFailure("gpt:primary", "auth", 1_000);

  assert.deepEqual(store.resolveOrder("gpt", 2_000), ["gpt:backup"]);
  assert.equal(store.status("gpt", 2_000)[0]?.availability, "disabled");
});

test("keeps an uninitialized OAuth profile out of selection and marks it needs_auth", () => {
  const store = new AuthProfileStore([{ id: "claude:new", provider: "claude", kind: "oauth" }]);

  assert.deepEqual(store.resolveOrder("claude", 1_000), []);
  assert.deepEqual(store.status("claude", 1_000), [{
    id: "claude:new",
    provider: "claude",
    kind: "oauth",
    availability: "needs_auth",
  }]);
});

test("keeps API-key profiles without a secret locator out of selection", () => {
  const store = new AuthProfileStore([
    { id: "gpt:missing", provider: "gpt", kind: "api_key" },
  ]);

  assert.deepEqual(store.resolveOrder("gpt", 1_000), []);
  assert.equal(store.status("gpt", 1_000)[0]?.availability, "needs_auth");
});

test("excludes missing or blocked refs while keeping passive keychain unknown selectable", () => {
  const store = new AuthProfileStore(profiles);

  store.setSecretAvailability("gpt:primary", "missing");
  store.setSecretAvailability("gpt:backup", "unknown");

  assert.deepEqual(store.resolveOrder("gpt", 1_000), ["gpt:backup"]);
  assert.equal(store.status("gpt", 1_000)[0]?.availability, "needs_auth");
  assert.equal(store.status("gpt", 1_000)[1]?.availability, "ready");

  store.setSecretAvailability("gpt:backup", "blocked");
  assert.deepEqual(store.resolveOrder("gpt", 1_000), []);
});
