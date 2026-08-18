import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

class StubProposalService extends Service {
  constructor(ctx: Context) {
    super(ctx, "homeProposals");
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
  assert.deepEqual(DshHomeAgentService.inject, ["homeWorld", "homeProposals"]);
});

test("mounts the sole production Agent through the DSH runtime", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorldService);
  await ctx.plugin(StubProposalService);
  const adapter = new RecordingAdapter();
  const fiber = await ctx.plugin(DshHomeAgentService, {
    provider: "test-provider",
    model: "test-model",
    adapter,
    sessionId: "home-main",
    householdContext: {
      soul: "Prefer calm, reversible household suggestions.",
      home: "The household observes quiet hours after 22:00.",
      memory: "A prior lighting proposal was rejected.",
    },
  });

  assert.equal(String(ctx.homeAgent.agent.id), "home-main");
  assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name), [
    "get_home_inventory",
    "get_home_snapshot",
    "get_home_evidence",
    "get_home_rules",
    "create_home_proposal",
  ]);

  ctx.homeAgent.agent.followup(createUserMessage({
    content: [{ type: "text", text: "What can you see?" }],
    source: { kind: "user" },
  }));
  await ctx.homeAgent.agent.whenIdle();

  assert.equal(adapter.requests.length, 1);
  assert.match(adapter.requests[0]?.system ?? "", /cannot control devices/i);
  assert.match(adapter.requests[0]?.system ?? "", /calm, reversible household suggestions/i);
  assert.equal(
    adapter.requests[0]?.messages.some((message) =>
      JSON.stringify(message).includes("quiet hours after 22:00")),
    true,
  );
  assert.equal(
    adapter.requests[0]?.messages.some((message) =>
      JSON.stringify(message).includes("prior lighting proposal was rejected")),
    true,
  );
  assert.equal(
    ctx.homeAgent.agent.session.events.some((event) => event.type === "assistant/message"),
    true,
  );
  const trace = ctx.homeAgent.traceSnapshot();
  assert.equal(trace?.sessionId, "home-main");
  assert.equal(trace?.turns[0]?.status, "completed");
  assert.deepEqual(trace?.usage, { inputTokens: 0, outputTokens: 3, reasoningTokens: 0 });
  assert.equal(JSON.stringify(trace).includes("home is readable"), false);

  await ctx.homeAgent.requestObservation();
  assert.equal(adapter.requests.length, 2);
  assert.equal(
    adapter.requests[1]?.messages.some((message) =>
      JSON.stringify(message).includes("at most one materially useful proposal")),
    true,
  );
  assert.equal(
    adapter.requests[1]?.messages.some((message) =>
      JSON.stringify(message).includes("rapidly flapping software or integration status")),
    true,
  );
  assert.equal(
    adapter.requests[1]?.messages.some((message) =>
      JSON.stringify(message).includes("inventory cursor until it is exhausted")),
    true,
  );

  await fiber.dispose();
  assert.equal(ctx.homeAgent, undefined);
  assert.equal(ctx.get("agentLoopTrace"), undefined);
  assert.equal(ctx.get("agents"), undefined);
  assert.equal(ctx.get("tools"), undefined);
  assert.equal(ctx.get("llm"), undefined);
  await ctx.fiber.dispose();
});

test("resumes the stable Home Agent session from the official private SQLite store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-dsh-session-"));
  const path = join(directory, "sessions.sqlite");
  try {
    const first = new Context();
    await first.plugin(StubWorldService);
    await first.plugin(StubProposalService);
    const firstAdapter = new RecordingAdapter();
    const firstFiber = await first.plugin(DshHomeAgentService, {
      provider: "test-provider",
      model: "test-model",
      adapter: firstAdapter,
      sessionId: "home-persisted",
      sessionPersistencePath: path,
    });
    first.homeAgent.agent.followup(createUserMessage({
      content: [{ type: "text", text: "Remember the downstairs context" }],
      source: { kind: "user" },
    }));
    await first.homeAgent.agent.whenIdle();
    const firstAsOfSeq = first.homeAgent.traceSnapshot()?.asOfSeq ?? -1;
    await firstFiber.dispose();
    await first.fiber.dispose();

    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);

    const resumed = new Context();
    await resumed.plugin(StubWorldService);
    await resumed.plugin(StubProposalService);
    const resumedAdapter = new RecordingAdapter();
    const resumedFiber = await resumed.plugin(DshHomeAgentService, {
      provider: "test-provider",
      model: "test-model",
      adapter: resumedAdapter,
      sessionId: "home-persisted",
      sessionPersistencePath: path,
    });

    assert.equal(
      resumed.homeAgent.agent.session.events.some((event) =>
        event.type === "user/message"
        && JSON.stringify(event.data).includes("Remember the downstairs context")),
      true,
    );
    assert.equal((resumed.homeAgent.traceSnapshot()?.asOfSeq ?? -1) >= firstAsOfSeq, true);

    resumed.homeAgent.agent.followup(createUserMessage({
      content: [{ type: "text", text: "Continue" }],
      source: { kind: "user" },
    }));
    await resumed.homeAgent.agent.whenIdle();
    assert.equal(
      resumedAdapter.requests[0]?.messages.some((message) =>
        JSON.stringify(message).includes("Remember the downstairs context")),
      true,
    );

    await resumedFiber.dispose();
    await resumed.fiber.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
