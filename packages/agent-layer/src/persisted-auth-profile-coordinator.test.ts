import assert from "node:assert/strict";
import test from "node:test";

import { AuthProfileStateStore } from "./auth-profile-state-store.js";
import { PersistedAuthProfileCoordinator } from "./persisted-auth-profile-coordinator.js";

test("hydrates persisted cooldowns into profile selection and records subsequent failures", () => {
  const durable = new AuthProfileStateStore(":memory:");
  durable.upsert({ id: "gpt:primary", provider: "gpt", kind: "api_key", secretRef: "env:PRIMARY" });
  durable.upsert({ id: "gpt:backup", provider: "gpt", kind: "api_key", secretRef: "env:BACKUP" });
  durable.setOrder("gpt", ["gpt:primary", "gpt:backup"]);
  durable.recordFailure("gpt:primary", "rate_limit", 1_000, 60_000);

  const coordinator = new PersistedAuthProfileCoordinator([
    { id: "gpt:primary", provider: "gpt", kind: "api_key", secretRef: "env:PRIMARY" },
    { id: "gpt:backup", provider: "gpt", kind: "api_key", secretRef: "env:BACKUP" },
  ], durable);

  assert.deepEqual(coordinator.resolveOrder("gpt", 2_000), ["gpt:backup", "gpt:primary"]);
  coordinator.recordFailure("gpt:backup", "timeout", 2_000, 30_000);
  assert.deepEqual(durable.list("gpt").map((profile) => [profile.id, profile.cooldownUntil, profile.cooldownReason]), [
    ["gpt:backup", 32_000, "timeout"],
    ["gpt:primary", 61_000, "rate_limit"],
  ]);
  assert.equal(durable.contains("PRIMARY"), false);
  durable.close();
});

test("persists an explicit profile order without persisting its secret reference", () => {
  const durable = new AuthProfileStateStore(":memory:");
  const coordinator = new PersistedAuthProfileCoordinator([
    { id: "gpt:first", provider: "gpt", kind: "api_key", secretRef: "env:FIRST_SECRET" },
    { id: "gpt:second", provider: "gpt", kind: "api_key", secretRef: "env:SECOND_SECRET" },
  ], durable);

  coordinator.setOrder("gpt", ["gpt:second"]);

  assert.deepEqual(coordinator.resolveOrder("gpt", 1_000), ["gpt:second"]);
  assert.deepEqual(durable.order("gpt"), ["gpt:second"]);
  assert.equal(durable.contains("SECOND_SECRET"), false);
  durable.close();
});

test("rehydrates stable profile disablement after restart", () => {
  const durable = new AuthProfileStateStore(":memory:");
  durable.upsert({ id: "gpt:primary", provider: "gpt", kind: "api_key" });
  durable.upsert({ id: "gpt:backup", provider: "gpt", kind: "api_key" });
  durable.recordFailure("gpt:primary", "billing", 1_000, 0);
  const coordinator = new PersistedAuthProfileCoordinator([
    { id: "gpt:primary", provider: "gpt", kind: "api_key", secretRef: "env:PRIMARY" },
    { id: "gpt:backup", provider: "gpt", kind: "api_key", secretRef: "env:BACKUP" },
  ], durable);

  assert.deepEqual(coordinator.resolveOrder("gpt", 2_000), ["gpt:backup"]);
  assert.equal(coordinator.status("gpt", 2_000)[0]?.availability, "disabled");
  durable.close();
});

test("updates the running selector when OAuth lifecycle metadata changes", () => {
  const durable = new AuthProfileStateStore(":memory:");
  const profile = { id: "claude:household", provider: "claude", kind: "oauth" as const, secretRef: "keychain:hob-agent/claude:household" };
  const coordinator = new PersistedAuthProfileCoordinator([profile], durable);

  assert.equal(coordinator.status("claude", 1_000)[0]?.availability, "needs_auth");
  coordinator.upsert({ ...profile, expiresAt: 10_000 });

  assert.equal(coordinator.status("claude", 1_000)[0]?.availability, "ready");
  assert.equal(durable.list("claude")[0]?.expiresAt, 10_000);
  durable.close();
});

test("removes a profile from the running selector and durable state", () => {
  const durable = new AuthProfileStateStore(":memory:");
  const coordinator = new PersistedAuthProfileCoordinator([
    { id: "gpt:primary", provider: "gpt", kind: "api_key", secretRef: "env:PRIMARY" },
    { id: "gpt:backup", provider: "gpt", kind: "api_key", secretRef: "env:BACKUP" },
  ], durable);
  coordinator.setOrder("gpt", ["gpt:primary", "gpt:backup"]);

  coordinator.remove("gpt:primary");

  assert.deepEqual(coordinator.resolveOrder("gpt", 1_000), ["gpt:backup"]);
  assert.deepEqual(durable.order("gpt"), ["gpt:backup"]);
  durable.close();
});

test("updates runtime eligibility from a passive secret availability observation", () => {
  const durable = new AuthProfileStateStore(":memory:");
  const coordinator = new PersistedAuthProfileCoordinator([
    { id: "gpt:primary", provider: "gpt", kind: "api_key", secretRef: "env:PRIMARY" },
  ], durable);

  coordinator.setSecretAvailability("gpt:primary", "missing");

  assert.deepEqual(coordinator.resolveOrder("gpt", 1_000), []);
  assert.equal(coordinator.status("gpt", 1_000)[0]?.availability, "needs_auth");
  durable.close();
});
