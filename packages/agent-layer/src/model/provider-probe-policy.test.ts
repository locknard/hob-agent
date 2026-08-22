import assert from "node:assert/strict";
import test from "node:test";

import { ProviderProbePolicy, ProviderProbePolicyError } from "./provider-probe-policy.js";

test("coalesces concurrent probes for the same provider profile", async () => {
  const policy = new ProviderProbePolicy({ clock: () => 1_000 });
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const probe = async () => {
    calls += 1;
    await gate;
    return { status: "ok" as const };
  };

  const first = policy.run("claude/household", probe);
  const second = policy.run("claude/household", probe);
  release();

  assert.equal(first, second);
  assert.deepEqual(await first, { status: "ok" });
  assert.equal(calls, 1);
});

test("throttles a repeated paid probe for thirty seconds", async () => {
  let now = 1_000;
  const policy = new ProviderProbePolicy({ clock: () => now });
  await policy.run("gpt/primary", async () => "ok");
  now = 20_000;

  await assert.rejects(
    policy.run("gpt/primary", async () => "unexpected"),
    (error: Error) => error instanceof ProviderProbePolicyError && error.reason === "throttled",
  );
});

test("allows a recovery probe only near cooldown expiry", async () => {
  const policy = new ProviderProbePolicy({ clock: () => 1_000, cooldownMarginMs: 5_000 });
  let calls = 0;

  await assert.rejects(
    policy.run("gpt/primary", async () => { calls += 1; }, { cooldownUntil: 20_000 }),
    (error: Error) => error instanceof ProviderProbePolicyError && error.reason === "cooldown",
  );
  await policy.run("gpt/backup", async () => { calls += 1; }, { cooldownUntil: 5_000 });
  assert.equal(calls, 1);
});

test("aborts a probe at the hard timeout and exposes no raw error", async () => {
  const policy = new ProviderProbePolicy({ timeoutMs: 5 });
  let aborted = false;

  await assert.rejects(
    policy.run("claude/household", async (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("raw timeout provider token"));
      }, { once: true });
    })),
    (error: Error) => error instanceof ProviderProbePolicyError &&
      error.reason === "timeout" &&
      !error.message.includes("raw timeout provider token"),
  );
  assert.equal(aborted, true);
});

test("classifies and redacts a provider probe failure", async () => {
  const policy = new ProviderProbePolicy();
  await assert.rejects(
    policy.run("gpt/primary", async () => { throw new Error("HTTP 401 raw-secret-request-id"); }),
    (error: Error) => error instanceof ProviderProbePolicyError &&
      error.reason === "auth" &&
      !error.message.includes("raw-secret-request-id"),
  );
});
