import assert from "node:assert/strict";
import test from "node:test";

import { AuthProfileStateStore } from "./auth-profile-state-store.js";

test("persists profile metadata and runtime state without persisting secret references", () => {
  const store = new AuthProfileStateStore(":memory:");
  store.upsert({
    id: "gpt:primary",
    provider: "gpt",
    kind: "api_key",
    secretRef: "env:DO_NOT_PERSIST",
  });
  store.setOrder("gpt", ["gpt:primary"]);
  store.recordFailure("gpt:primary", "rate_limit", 1_000, 60_000);

  assert.deepEqual(store.list("gpt"), [{
    id: "gpt:primary",
    provider: "gpt",
    kind: "api_key",
    expiresAt: undefined,
    cooldownUntil: 61_000,
    cooldownReason: "rate_limit",
    lastSuccessAt: undefined,
    failureCount: 1,
    disabledReason: undefined,
  }]);
  assert.deepEqual(store.order("gpt"), ["gpt:primary"]);
  assert.equal(store.contains("DO_NOT_PERSIST"), false);
  store.close();
});

test("records non-secret profile health and clears cooldown after success", () => {
  const store = new AuthProfileStateStore(":memory:");
  store.upsert({ id: "gpt:primary", provider: "gpt", kind: "api_key" });
  store.recordFailure("gpt:primary", "timeout", 1_000, 60_000);
  store.recordSuccess("gpt:primary", 2_000);

  assert.deepEqual(store.list("gpt"), [{
    id: "gpt:primary",
    provider: "gpt",
    kind: "api_key",
    expiresAt: undefined,
    cooldownUntil: undefined,
    cooldownReason: undefined,
    lastSuccessAt: 2_000,
    failureCount: 0,
    disabledReason: undefined,
  }]);
  store.close();
});

test("persists stable failure disablement until a later successful reauthorization", () => {
  const store = new AuthProfileStateStore(":memory:");
  store.upsert({ id: "gpt:primary", provider: "gpt", kind: "api_key" });
  store.recordFailure("gpt:primary", "billing", 1_000, 0);

  assert.equal(store.list("gpt")[0]?.disabledReason, "billing");
  store.recordSuccess("gpt:primary", 2_000);
  assert.equal(store.list("gpt")[0]?.disabledReason, undefined);
  store.close();
});

test("removes profile metadata, health, and order references together", () => {
  const store = new AuthProfileStateStore(":memory:");
  store.upsert({ id: "gpt:primary", provider: "gpt", kind: "api_key" });
  store.upsert({ id: "gpt:backup", provider: "gpt", kind: "api_key" });
  store.setOrder("gpt", ["gpt:primary", "gpt:backup"]);
  store.recordFailure("gpt:primary", "rate_limit", 1_000, 60_000);

  store.remove("gpt:primary");

  assert.deepEqual(store.list("gpt").map((profile) => profile.id), ["gpt:backup"]);
  assert.deepEqual(store.order("gpt"), ["gpt:backup"]);
  store.close();
});
