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

class StubMediaCatalogService extends Service {
  constructor(ctx: Context) {
    super(ctx, "homeMediaCatalog");
  }

  async search(): Promise<{ readonly candidates: readonly unknown[] }> {
    return { candidates: [] };
  }
}

class StubMediaPlayerService extends Service {
  constructor(ctx: Context) {
    super(ctx, "homeMediaPlayers");
  }

  list() {
    return { players: [] };
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

class RepeatingToolAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const id = `inventory-${this.requests.length}`;
    const args = JSON.stringify({ limit: 50 });
    yield { type: "block-start", index: 0, blockType: "tool-call" };
    yield { type: "tool-call-delta", index: 0, id, name: "get_home_inventory", argumentsDelta: args };
    yield {
      type: "block-end",
      index: 0,
      block: { type: "tool-call", id, name: "get_home_inventory", arguments: args },
    };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: "finish", reason: { kind: "tool-calls" } };
  }
}

class ObservationReportingAdapter extends LlmAdapter {
  requests = 0;

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1;
    if (this.requests === 1) {
      const args = JSON.stringify({ disposition: "insufficient_evidence" });
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "observation-report-1",
        name: "report_home_observation",
        argumentsDelta: args,
      };
      yield {
        type: "block-end",
        index: 0,
        block: {
          type: "tool-call",
          id: "observation-report-1",
          name: "report_home_observation",
          arguments: args,
        },
      };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "No proposal created." };
    yield { type: "block-end", index: 0, block: { type: "text", text: "No proposal created." } };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

class AdviceReportingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    if (this.requests.length === 1) {
      const args = JSON.stringify({ limit: 50 });
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id: "advice-inventory-1", name: "get_home_inventory", argumentsDelta: args };
      yield { type: "block-end", index: 0, block: { type: "tool-call", id: "advice-inventory-1", name: "get_home_inventory", arguments: args } };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    if (this.requests.length === 2) {
      const args = JSON.stringify({
        summary: "Try a bounded daylight-aware curtain schedule.",
        confidence: "partial",
        findings: ["The current behavior may rely on a fixed time."],
        unknowns: ["Indoor illuminance is not available."],
        trial: {
          description: "Use sunrise with earliest and latest bounds.",
          durationDays: 14,
          successCriteria: ["Fewer manual reversals."],
          rollback: "Restore the prior schedule.",
        },
        hardwareSuggestions: [{
          capability: "illuminance",
          necessity: "optional",
          reason: "It can distinguish bright and dark mornings.",
          placement: "Near the window outside direct glare.",
          privacyImpact: "low",
          alternative: "Use sunrise and weather data first.",
        }],
        validationSteps: ["Review after two weeks."],
      });
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id: "advice-report-1", name: "report_home_advice", argumentsDelta: args };
      yield { type: "block-end", index: 0, block: { type: "tool-call", id: "advice-report-1", name: "report_home_advice", arguments: args } };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "Advice recorded." };
    yield { type: "block-end", index: 0, block: { type: "text", text: "Advice recorded." } };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

class HangingAdapter extends LlmAdapter {
  requests = 0;

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1;
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) return resolve();
      options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    if (false) yield { type: "finish", reason: { kind: "stop" } };
  }
}

test("declares the neutral home-world service as a required production dependency", () => {
  assert.deepEqual(DshHomeAgentService.inject, ["homeWorld", "homeProposals"]);
});

test("mounts media search only when a neutral media catalog is explicitly available", async () => {
  const withoutCatalog = new Context();
  await withoutCatalog.plugin(StubWorldService);
  await withoutCatalog.plugin(StubProposalService);
  const withoutFiber = await withoutCatalog.plugin(DshHomeAgentService, {
    provider: "test-provider",
    model: "test-model",
    adapter: new RecordingAdapter(),
  });
  assert.equal(withoutCatalog.tools.schemas().some((schema) => schema.name === "search_home_media"), false);
  await withoutFiber.dispose();
  await withoutCatalog.fiber.dispose();

  const withCatalog = new Context();
  await withCatalog.plugin(StubWorldService);
  await withCatalog.plugin(StubProposalService);
  await withCatalog.plugin(StubMediaCatalogService);
  const withFiber = await withCatalog.plugin(DshHomeAgentService, {
    provider: "test-provider",
    model: "test-model",
    adapter: new RecordingAdapter(),
  });
  assert.equal(withCatalog.tools.schemas().some((schema) => schema.name === "search_home_media"), true);
  await withFiber.dispose();
  await withCatalog.fiber.dispose();
});

test("mounts player discovery only when a neutral player inventory is available", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorldService);
  await ctx.plugin(StubProposalService);
  await ctx.plugin(StubMediaPlayerService);
  const fiber = await ctx.plugin(DshHomeAgentService, {
    provider: "test-provider",
    model: "test-model",
    adapter: new RecordingAdapter(),
  });
  assert.equal(ctx.tools.schemas().some((schema) => schema.name === "get_home_media_players"), true);
  await fiber.dispose();
  await ctx.fiber.dispose();
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
  assert.notEqual(ctx.get("tokenMeter"), undefined);
  assert.notEqual(ctx.get("toolResultPruner"), undefined);
  assert.deepEqual((ctx.get("toolResultPruner") as unknown as { config: unknown }).config, {
    thresholdChars: 8_192,
    headChars: 4_096,
    tailChars: 1_024,
  });
  assert.equal(ctx.get("compaction")?.constructor.name, "HomeCompactionEngine");
  const invariants = ctx.get("invariants") as unknown as { registrations: Map<string, unknown> };
  assert.deepEqual([...invariants.registrations.keys()].sort(), [
    "@deepseek-ai/dsh-agent",
    "@deepseek-ai/dsh-agent-loop",
    "@deepseek-ai/dsh-compaction",
    "@deepseek-ai/dsh-llm",
    "@deepseek-ai/dsh-scope",
    "@deepseek-ai/dsh-session",
    "@deepseek-ai/dsh-system-prompt",
    "@deepseek-ai/dsh-tools",
  ]);
  assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name), [
    "get_home_calibration",
    "get_home_inventory",
    "get_home_activity",
    "get_home_snapshot",
    "get_home_evidence",
    "get_home_rules",
    "create_home_proposal",
    "report_home_advice",
    "report_home_observation",
    "skill",
  ]);
  const skills = ctx.get("skills") as unknown as { list(): Promise<readonly { name: string }[]> };
  assert.deepEqual((await skills.list()).map((skill) => skill.name), ["answer-home-question", "review-home-observation"]);
  const loadedSkill = await ctx.tools.execute({
    callId: "load-home-skill" as never,
    name: "skill",
    arguments: { name: "review-home-observation" },
    agent: ctx.homeAgent.agent,
    signal: new AbortController().signal,
  });
  assert.equal(loadedSkill.isError, false);
  assert.match(
    loadedSkill.content.map((item) => "text" in item ? item.text : "").join(" "),
    /inventory.*evidence.*rule metadata/is,
  );
  assert.match(
    loadedSkill.content.map((item) => "text" in item ? item.text : "").join(" "),
    /window_before_baseline.*missing interval.*not quiet/is,
  );
  assert.match(
    loadedSkill.content.map((item) => "text" in item ? item.text : "").join(" "),
    /one exact device.*relevant semantic kinds/is,
  );

  ctx.homeAgent.agent.followup(createUserMessage({
    content: [{ type: "text", text: "What can you see?" }],
    source: { kind: "user" },
  }));
  await ctx.homeAgent.agent.whenIdle();

  assert.equal(adapter.requests.length, 1);
  assert.match(adapter.requests[0]?.system ?? "", /cannot control devices/i);
  assert.match(adapter.requests[0]?.system ?? "", /same.*media.*label.*not.*same.*endpoint/is);
  assert.match(adapter.requests[0]?.system ?? "", /mediaRef.*does not grant.*authority/is);
  assert.match(adapter.requests[0]?.system ?? "", /window_before_baseline.*not observed/is);
  assert.match(adapter.requests[0]?.system ?? "", /prefer one exact hub device.*semantic kinds/is);
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
    adapter.requests[0]?.messages.some((message) =>
      JSON.stringify(message).includes("review-home-observation")),
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
  assert.equal(
    adapter.requests[1]?.messages.some((message) =>
      JSON.stringify(message).includes("activity for candidate triage")),
    true,
  );
  assert.equal(
    adapter.requests[1]?.messages.some((message) =>
      JSON.stringify(message).includes("load the review-home-observation skill")),
    true,
  );

  await fiber.dispose();
  assert.equal(ctx.get("compaction"), undefined);
  assert.equal(ctx.get("toolResultPruner"), undefined);
  assert.equal(ctx.get("tokenMeter"), undefined);
  assert.equal(ctx.get("invariants"), undefined);
  assert.equal(ctx.homeAgent, undefined);
  assert.equal(ctx.get("agentLoopTrace"), undefined);
  assert.equal(ctx.get("agents"), undefined);
  assert.equal(ctx.get("tools"), undefined);
  assert.equal(ctx.get("homeObservationBudget"), undefined);
  assert.equal(ctx.get("homeObservationReport"), undefined);
  assert.equal(ctx.get("skills"), undefined);
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

test("cancels an autonomous observation that exceeds its product tool budget", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorldService);
  await ctx.plugin(StubProposalService);
  const adapter = new RepeatingToolAdapter();
  await ctx.plugin(DshHomeAgentService, {
    provider: "test-provider",
    model: "test-model",
    adapter,
    sessionId: "bounded-home",
  });

  await assert.rejects(
    ctx.homeAgent.requestObservation(),
    /tool budget exhausted/i,
  );
  assert.equal(adapter.requests.length, 13);
  assert.equal(
    adapter.requests.some((request) => request.messages.some((message) =>
      JSON.stringify(message).includes("repeating the exact same tool call"))),
    true,
  );
  assert.equal(ctx.homeAgent.observationStatus, "idle");

  await ctx.fiber.dispose();
});

test("returns the bounded disposition reported by one canonical DSH observation turn", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorldService);
  await ctx.plugin(StubProposalService);
  const adapter = new ObservationReportingAdapter();
  await ctx.plugin(DshHomeAgentService, {
    provider: "test-provider",
    model: "test-model",
    adapter,
    sessionId: "reported-home",
  });

  assert.equal(await ctx.homeAgent.requestObservation(), "insufficient_evidence");
  assert.equal(adapter.requests, 2);
  assert.equal(ctx.homeAgent.observationStatus, "idle");
  assert.deepEqual(ctx.homeAgent.observationMetrics(), {
    durationMs: ctx.homeAgent.observationMetrics()?.durationMs,
    inputTokens: 2,
    outputTokens: 2,
    reasoningTokens: 0,
    toolCalls: 1,
    failedToolCalls: 0,
  });
  assert.equal((ctx.homeAgent.observationMetrics()?.durationMs ?? -1) >= 0, true);

  await ctx.fiber.dispose();
});

test("returns one structured advice report for a bounded untrusted household question", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorldService);
  await ctx.plugin(StubProposalService);
  const adapter = new AdviceReportingAdapter();
  await ctx.plugin(DshHomeAgentService, {
    provider: "test-provider",
    model: "test-model",
    adapter,
    sessionId: "advice-home",
  });

  const report = await ctx.homeAgent.requestAdvice("Why does the curtain open too early or too late?");

  assert.equal(report.confidence, "partial");
  assert.equal(report.hardwareSuggestions[0]?.capability, "illuminance");
  assert.equal(adapter.requests.length, 3);
  assert.equal(
    adapter.requests[0]?.messages.some((message) => JSON.stringify(message).includes("load the answer-home-question skill")),
    true,
  );
  assert.equal(
    adapter.requests[0]?.messages.some((message) => JSON.stringify(message).includes("untrusted household question")),
    true,
  );
  assert.equal(
    adapter.requests[0]?.messages.some((message) => JSON.stringify(message).includes("same language as the household question")),
    true,
  );
  await assert.rejects(ctx.homeAgent.requestAdvice("x".repeat(1_001)), /question/i);
  assert.equal(ctx.homeAgent.observationStatus, "idle");

  await ctx.fiber.dispose();
});

test("cancels a model request that exceeds the autonomous observation deadline", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorldService);
  await ctx.plugin(StubProposalService);
  const adapter = new HangingAdapter();
  await ctx.plugin(DshHomeAgentService, {
    provider: "test-provider",
    model: "test-model",
    adapter,
    sessionId: "timed-home",
    observationTimeoutMs: 20,
  });

  await assert.rejects(
    ctx.homeAgent.requestObservation(),
    /timed out/i,
  );
  assert.equal(adapter.requests, 1);
  assert.equal(ctx.homeAgent.observationStatus, "idle");

  await ctx.fiber.dispose();
});
