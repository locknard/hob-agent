import assert from "node:assert/strict";
import test from "node:test";

import { OAuthRefreshCoordinator } from "./oauth-refresh-coordinator.js";

test("coalesces concurrent OAuth refreshes for the same profile", async () => {
  const coordinator = new OAuthRefreshCoordinator();
  let calls = 0;
  let release: (() => void) | undefined;
  const refresh = async () => {
    calls += 1;
    await new Promise<void>((resolve) => { release = resolve; });
    return { access: "new-access" };
  };

  const first = coordinator.run("claude:oauth", refresh);
  const second = coordinator.run("claude:oauth", refresh);
  await Promise.resolve();
  assert.equal(calls, 1);
  release?.();
  assert.deepEqual(await first, { access: "new-access" });
  assert.deepEqual(await second, { access: "new-access" });
});

test("clears a failed OAuth refresh so a later explicit retry can run", async () => {
  const coordinator = new OAuthRefreshCoordinator();
  let calls = 0;

  await assert.rejects(
    coordinator.run("claude:oauth", async () => {
      calls += 1;
      throw new Error("refresh failed");
    }),
    /refresh failed/,
  );
  assert.deepEqual(await coordinator.run("claude:oauth", async () => {
    calls += 1;
    return "refreshed";
  }), "refreshed");
  assert.equal(calls, 2);
});
