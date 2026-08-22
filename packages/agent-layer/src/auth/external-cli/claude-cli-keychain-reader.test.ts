import assert from "node:assert/strict";
import test from "node:test";

import { MacOSClaudeCliKeychainReader } from "./claude-cli-keychain-reader.js";

test("reads a Claude Code Keychain credential only when an explicit import allows prompts", async () => {
  const calls: string[][] = [];
  const reader = new MacOSClaudeCliKeychainReader(async (args) => {
    calls.push([...args]);
    return {
      ok: true,
      stdout: JSON.stringify({
        claudeAiOauth: { accessToken: "access", refreshToken: "refresh", expiresAt: 10_000 },
      }),
    };
  }, true);

  assert.deepEqual(await reader.read(), { access: "access", refresh: "refresh", expires: 10_000 });
  assert.deepEqual(calls, [["find-generic-password", "-s", "Claude Code-credentials", "-w"]]);
});

test("does not invoke Keychain for passive or no-prompt reads", async () => {
  let calls = 0;
  const reader = new MacOSClaudeCliKeychainReader(async () => {
    calls += 1;
    return { ok: true, stdout: "" };
  }, false);

  assert.equal(await reader.read(), undefined);
  assert.equal(calls, 0);
});
