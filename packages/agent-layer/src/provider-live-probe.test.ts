import assert from "node:assert/strict";
import test from "node:test";

import { probeLiveProvider } from "./provider-live-probe.js";

test("runs an explicit minimal pi request and retains only probe metadata", async () => {
  const calls: unknown[] = [];
  const result = await probeLiveProvider("gpt", "gpt-5.4", async () => ({
    getModel: (provider, model) => {
      calls.push(["getModel", provider, model]);
      return { provider, id: model };
    },
    completeSimple: async (_model, context, options) => {
      calls.push(["completeSimple", context, options]);
      return { content: [{ type: "text", text: "discard this response" }] };
    },
  }), () => calls.length * 10);

  assert.deepEqual(result, { model: "gpt/gpt-5.4", status: "ok", latencyMs: 20 });
  assert.deepEqual(calls[0], ["getModel", "openai", "gpt-5.4"]);
  assert.deepEqual(calls[1], ["completeSimple", {
    messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: 0 }],
  }, { maxTokens: 1 }]);
});

test("returns a safe classified result when a live provider request fails", async () => {
  const result = await probeLiveProvider("claude", "claude-sonnet-4-6", async () => ({
    getModel: () => ({ provider: "anthropic", id: "claude-sonnet-4-6" }),
    completeSimple: async () => { throw new Error("HTTP 401 token=should-not-retain"); },
  }), () => 20);
  assert.deepEqual(result, { model: "claude/claude-sonnet-4-6", status: "auth", latencyMs: 0 });
});

test("forwards cancellation to the pi provider request", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  await probeLiveProvider("deepseek", "deepseek-v4-flash", async () => ({
    getModel: () => ({ provider: "deepseek", id: "deepseek-v4-flash" }),
    completeSimple: async (_model, _context, options) => {
      receivedSignal = options?.signal;
      return {};
    },
  }), Date.now, controller.signal);

  assert.equal(receivedSignal, controller.signal);
});
