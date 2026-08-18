import assert from "node:assert/strict";
import test from "node:test";

import { loginProvider } from "./provider-login.js";

test("delegates supported OAuth login to the mapped pi provider", async () => {
  const calls: unknown[] = [];
  const models = { login: async (...args: unknown[]) => { calls.push(args); return { type: "oauth", access: "a", refresh: "r", expires: 10 }; } };
  const interaction = { prompt: async () => "", notify: () => {} };

  await loginProvider(models, "claude", "oauth", interaction as never);
  assert.deepEqual(calls, [["anthropic", "oauth", interaction]]);
});

test("refuses OAuth that the pi provider does not implement", async () => {
  await assert.rejects(() => loginProvider({ login: async () => ({}) }, "gpt", "oauth", {} as never), /does not support oauth/);
});

test("refuses an auth method not declared by the provider adapter", async () => {
  await assert.rejects(() => loginProvider({ login: async () => ({}) }, "deepseek", "oauth", {} as never), /does not support oauth/);
});
