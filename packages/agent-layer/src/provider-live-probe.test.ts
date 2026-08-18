import assert from "node:assert/strict";
import test from "node:test";

import { createUserMessage, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";

import { probeLiveProvider } from "./provider-live-probe.js";

async function* stop(): AsyncIterable<StreamChunk> {
  yield { type: "finish", reason: { kind: "stop" } };
}

test("runs an explicit minimal DSH request and retains only probe metadata", async () => {
  const calls: unknown[] = [];
  const result = await probeLiveProvider("gpt", "gpt-5.4", async () => ({
    resolveModelInfo: async (provider, model, signal) => {
      calls.push(["resolveModelInfo", provider, model, signal]);
      return { provider, id: model, name: model };
    },
    stream: (options: GenerateOptions) => {
      calls.push(["stream", options]);
      return stop();
    },
  }), () => calls.length * 10);

  assert.deepEqual(result, { model: "gpt/gpt-5.4", status: "ok", latencyMs: 20 });
  assert.deepEqual(calls[0], ["resolveModelInfo", "openai", "gpt-5.4", undefined]);
  const [, request] = calls[1] as [string, GenerateOptions];
  assert.deepEqual({ provider: request.provider, model: request.model, maxTokens: request.maxTokens }, {
    provider: "openai",
    model: "gpt-5.4",
    maxTokens: 1,
  });
  const [message] = request.messages;
  assert.deepEqual({ role: message.role, content: message.content, source: message.source }, {
    role: "user",
    content: [{ type: "text", text: "Reply with exactly: OK" }],
    source: { kind: "user" },
  });
  assert.equal(typeof message.id, "string");
  assert.notEqual(message.id, "");
  assert.deepEqual(createUserMessage({
    content: [{ type: "text", text: "Reply with exactly: OK" }],
    source: { kind: "user" },
  }).content, message.content);
});

test("classifies a DSH terminal failure without retaining provider details", async () => {
  const result = await probeLiveProvider("claude", "claude-sonnet-4-6", async () => ({
    resolveModelInfo: async () => ({ provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude" }),
    stream: () => (async function* (): AsyncIterable<StreamChunk> {
      yield {
        type: "finish",
        reason: { kind: "error", failure: { code: "AUTH", message: "token=should-not-retain", status: 401 } },
      };
    })(),
  }), () => 20);
  assert.deepEqual(result, { model: "claude/claude-sonnet-4-6", status: "auth", latencyMs: 0 });
});

test("accepts max-tokens as a successful provider connection", async () => {
  const result = await probeLiveProvider("deepseek", "deepseek-v4-flash", async () => ({
    resolveModelInfo: async () => ({ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek" }),
    stream: () => (async function* (): AsyncIterable<StreamChunk> {
      yield { type: "finish", reason: { kind: "max-tokens" } };
    })(),
  }), () => 20);

  assert.deepEqual(result, { model: "deepseek/deepseek-v4-flash", status: "ok", latencyMs: 0 });
});

test("forwards cancellation to DSH model resolution and request", async () => {
  const controller = new AbortController();
  const receivedSignals: (AbortSignal | undefined)[] = [];
  await probeLiveProvider("deepseek", "deepseek-v4-flash", async () => ({
    resolveModelInfo: async (_provider, _model, signal) => {
      receivedSignals.push(signal);
      return { provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek" };
    },
    stream: (options) => {
      receivedSignals.push(options.signal);
      return stop();
    },
  }), Date.now, controller.signal);

  assert.deepEqual(receivedSignals, [controller.signal, controller.signal]);
});
