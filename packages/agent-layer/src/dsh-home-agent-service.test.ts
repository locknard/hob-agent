import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";
import {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";

import { DshHomeAgentService } from "./dsh-home-agent-service.js";

class StubWorldService extends Service {
  readonly snapshot = { devices: [], bridgeWatermarks: [], diagnostics: [] };

  constructor(ctx: Context) {
    super(ctx, "homeWorld");
  }
}

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "home is readable" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "home is readable" } };
    yield { type: "usage", usage: { inputTokens: 0, outputTokens: 3 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

test("declares the neutral home-world service as a required production dependency", () => {
  assert.deepEqual(DshHomeAgentService.inject, ["homeWorld"]);
});

test("mounts the sole production Agent through the DSH runtime", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorldService);
  const adapter = new RecordingAdapter();
  const fiber = await ctx.plugin(DshHomeAgentService, {
    provider: "test-provider",
    model: "test-model",
    adapter,
    sessionId: "home-main",
  });

  assert.equal(String(ctx.homeAgent.agent.id), "home-main");
  assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name), ["get_home_snapshot"]);

  ctx.homeAgent.agent.followup(createUserMessage({
    content: [{ type: "text", text: "What can you see?" }],
    source: { kind: "user" },
  }));
  await ctx.homeAgent.agent.whenIdle();

  assert.equal(adapter.requests.length, 1);
  assert.match(adapter.requests[0]?.system ?? "", /cannot control devices/i);
  assert.equal(
    ctx.homeAgent.agent.session.events.some((event) => event.type === "assistant/message"),
    true,
  );

  await fiber.dispose();
  assert.equal(ctx.homeAgent, undefined);
  assert.equal(ctx.get("agents"), undefined);
  assert.equal(ctx.get("tools"), undefined);
  assert.equal(ctx.get("llm"), undefined);
  await ctx.fiber.dispose();
});
