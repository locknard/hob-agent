import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import SessionStore, { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";

import { AgentLoopTraceService, projectAgentLoopTrace } from "./dsh-agent-loop-trace.js";

const events = [
  { type: "turn/start", seq: 0, time: 1_000, data: { turn: 1 } },
  { type: "step/start", seq: 1, time: 1_010, data: { turn: 1, step: 1 } },
  {
    type: "tool/call",
    seq: 2,
    time: 1_020,
    data: { turn: 1, step: 1, callId: "call-1", name: "get_home_snapshot", arguments: "{\"secret\":true}" },
  },
  {
    type: "tool/result",
    seq: 3,
    time: 1_050,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: "message-1",
        role: "user",
        source: { kind: "tool", callId: "call-1" },
        content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "private result" }] }],
      },
    },
    surfaceOp: "append",
  },
  {
    type: "assistant/message",
    seq: 4,
    time: 1_060,
    data: {
      turn: 1,
      step: 1,
      message: { id: "message-2", role: "assistant", source: { kind: "model", provider: "fixture", model: "fixture" }, content: [] },
      usage: { inputTokens: 12, outputTokens: 4, reasoningTokens: 3 },
    },
    surfaceOp: "append",
  },
  { type: "step/end", seq: 5, time: 1_070, data: { turn: 1, step: 1 } },
  { type: "turn/end", seq: 6, time: 1_080, data: { turn: 1, reason: { kind: "completed" } } },
  { type: "compaction/start", seq: 7, time: 1_090, data: { compactionId: "compact-1", turn: null } },
  {
    type: "compaction/summary",
    seq: 8,
    time: 1_100,
    data: {
      compactionId: "compact-1",
      summary: [{ type: "text", text: "private household checkpoint" }],
      rawOutput: [{ type: "text", text: "private raw model output" }],
      llmStreamCall: true,
      shadowedRange: { start: 0, end: 6 },
      shadowedSeqs: [0, 1, 2, 3, 4, 5, 6],
      shadowedTokenCount: 420,
      provider: "fixture",
      model: "fixture",
      usage: { inputTokens: 80, outputTokens: 20, reasoningTokens: 10 },
    },
  },
  { type: "compaction/end", seq: 9, time: 1_120, data: { compactionId: "compact-1", turn: null } },
  { type: "compaction/start", seq: 10, time: 1_130, data: { compactionId: "compact-2", turn: null } },
  {
    type: "compaction/end",
    seq: 11,
    time: 1_140,
    data: { compactionId: "compact-2", turn: null, error: "private provider failure" },
  },
] as unknown as readonly SessionEvent[];

test("projects stable DSH turn, step, tool, timing and token metadata", () => {
  const trace = projectAgentLoopTrace("home-main", events);

  assert.equal(trace.sessionId, "home-main");
  assert.equal(trace.asOfSeq, 11);
  assert.deepEqual(trace.turns, [{ turn: 1, status: "completed", startedAt: 1_000, endedAt: 1_080, durationMs: 80 }]);
  assert.deepEqual(trace.steps, [{ turn: 1, step: 1, status: "completed", startedAt: 1_010, endedAt: 1_070, durationMs: 60 }]);
  assert.deepEqual(trace.tools, [{
    id: "call-1",
    turn: 1,
    step: 1,
    name: "get_home_snapshot",
    status: "completed",
    startedAt: 1_020,
    endedAt: 1_050,
    durationMs: 30,
  }]);
  assert.deepEqual(trace.usage, { inputTokens: 12, outputTokens: 4, reasoningTokens: 3 });
  assert.deepEqual(trace.compactions, [{
    status: "completed",
    ownerTurn: null,
    startedAt: 1_090,
    endedAt: 1_120,
    durationMs: 30,
    shadowedEventCount: 7,
    shadowedTokenCount: 420,
    usage: { inputTokens: 80, outputTokens: 20, reasoningTokens: 10 },
  }, {
    status: "failed",
    ownerTurn: null,
    startedAt: 1_130,
    endedAt: 1_140,
    durationMs: 10,
  }]);
});

test("never projects prompts, reasoning text, tool arguments, or tool results", () => {
  const serialized = JSON.stringify(projectAgentLoopTrace("home-main", events));

  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("private result"), false);
  assert.equal(serialized.includes("arguments"), false);
  assert.equal(serialized.includes("message"), false);
  assert.equal(serialized.includes("private household checkpoint"), false);
  assert.equal(serialized.includes("private raw model output"), false);
  assert.equal(serialized.includes("private provider failure"), false);
  assert.equal(serialized.includes("compact-1"), false);
});

test("subscribes to DSH session events and exposes an explicit bounded tail", async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(AgentLoopTraceService, { maxEventsPerSession: 64 });
  const session = ctx.sessions.create(SessionId("bounded-trace"));
  for (let index = 0; index < 70; index += 1) {
    session.append("todo/write", { todos: [{ content: `todo-${index}`, status: "pending" }] });
  }
  await new Promise<void>((resolve) => setImmediate(resolve));

  const trace = ctx.agentLoopTrace.snapshot("bounded-trace");
  assert.equal(trace?.asOfSeq, 69);
  assert.equal(trace?.truncatedBeforeSeq, 6);
  assert.equal(JSON.stringify(trace).includes("todo-69"), false);
  const retained = [...(ctx.agentLoopTrace as unknown as {
    logs: Map<string, unknown>;
  }).logs.values()];
  assert.equal(JSON.stringify(retained).includes("todo-69"), false);

  await ctx.fiber.dispose();
});
