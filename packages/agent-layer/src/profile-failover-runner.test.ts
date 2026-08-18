import assert from "node:assert/strict";
import test from "node:test";

import { AuthProfileStateStore } from "./auth-profile-state-store.js";
import { PersistedAuthProfileCoordinator } from "./persisted-auth-profile-coordinator.js";
import { ProfileFailoverError, runWithProfileFailover } from "./profile-failover-runner.js";

function coordinator(): { coordinator: PersistedAuthProfileCoordinator; durable: AuthProfileStateStore } {
  const durable = new AuthProfileStateStore(":memory:");
  return {
    durable,
    coordinator: new PersistedAuthProfileCoordinator([
      { id: "gpt:primary", provider: "gpt", kind: "api_key", secretRef: "env:PRIMARY" },
      { id: "gpt:backup", provider: "gpt", kind: "api_key", secretRef: "env:BACKUP" },
    ], durable),
  };
}

test("rotates only after a retryable profile failure and persists its cooldown", async () => {
  const { coordinator: profiles, durable } = coordinator();
  const attempts: string[] = [];

  const result = await runWithProfileFailover(profiles, "gpt", async (profileId) => {
    attempts.push(profileId);
    if (profileId === "gpt:primary") throw new Error("HTTP 429 rate limit");
    return "answered";
  }, { now: 1_000 });

  assert.deepEqual(attempts, ["gpt:primary", "gpt:backup"]);
  assert.deepEqual(result, { profileId: "gpt:backup", value: "answered" });
  assert.equal(durable.list("gpt").find((profile) => profile.id === "gpt:primary")?.cooldownReason, "rate_limit");
  assert.equal(durable.list("gpt").find((profile) => profile.id === "gpt:backup")?.lastSuccessAt, 1_000);
  assert.deepEqual(profiles.resolveOrder("gpt", 2_000), ["gpt:backup", "gpt:primary"]);
  durable.close();
});

test("does not silently switch profiles after an authentication failure", async () => {
  const { coordinator: profiles, durable } = coordinator();
  const attempts: string[] = [];

  await assert.rejects(
    runWithProfileFailover(profiles, "gpt", async (profileId) => {
      attempts.push(profileId);
      throw new Error("HTTP 401 invalid API key");
    }, { now: 1_000 }),
    (error: Error) => error instanceof ProfileFailoverError &&
      error.reason === "auth" &&
      error.provider === "gpt" &&
      error.profileId === "gpt:primary" &&
      !error.message.includes("401") &&
      !error.message.includes("invalid API key"),
  );
  assert.deepEqual(attempts, ["gpt:primary"]);
  durable.close();
});

test("rotates on provider overload without polluting credential health", async () => {
  const { coordinator: profiles, durable } = coordinator();
  const result = await runWithProfileFailover(profiles, "gpt", async (profileId) => {
    if (profileId === "gpt:primary") throw new Error("provider overloaded with raw details");
    return "answered";
  }, { now: 1_000 });

  assert.equal(result.profileId, "gpt:backup");
  const primary = durable.list("gpt").find((profile) => profile.id === "gpt:primary");
  assert.equal(primary?.failureCount, 0);
  assert.equal(primary?.cooldownReason, undefined);
  durable.close();
});

test("redacts the final provider error after retry candidates are exhausted", async () => {
  const { coordinator: profiles, durable } = coordinator();
  await assert.rejects(
    runWithProfileFailover(profiles, "gpt", async () => {
      throw new Error("429 rate limit raw-provider-request-id-secret");
    }, { now: 1_000 }),
    (error: Error) => error instanceof ProfileFailoverError &&
      error.reason === "rate_limit" &&
      !error.message.includes("raw-provider-request-id-secret"),
  );
  durable.close();
});
