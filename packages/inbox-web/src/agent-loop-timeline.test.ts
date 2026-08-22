import assert from "node:assert/strict";
import test from "node:test";

import { renderAgentLoopTimeline } from "./agent-loop-timeline.js";

test("renders an accessible metadata-only DSH loop timeline", () => {
  const html = renderAgentLoopTimeline({
    sessionId: "home-main",
    asOfSeq: 9,
    turns: [{ turn: 1, status: "completed", startedAt: 10, endedAt: 90, durationMs: 80 }],
    steps: [{ turn: 1, step: 1, status: "completed", startedAt: 20, endedAt: 80, durationMs: 60 }],
    tools: [{ id: "call-1", turn: 1, step: 1, name: "get_home_snapshot", status: "completed", startedAt: 30, endedAt: 50, durationMs: 20 }],
    compactions: [{
      status: "completed",
      ownerTurn: null,
      startedAt: 100,
      endedAt: 130,
      durationMs: 30,
      shadowedEventCount: 7,
      shadowedTokenCount: 420,
      usage: { inputTokens: 80, outputTokens: 20, reasoningTokens: 10 },
    }],
    prunes: [{ at: 95, shadowedEventCount: 1, shadowedTokenCount: 512 }],
    usage: { inputTokens: 12, outputTokens: 4, reasoningTokens: 3 },
  });

  assert.match(html, /aria-label="建议形成过程"/);
  assert.match(html, /1 轮分析 · 1 个步骤 · 1 项检查/);
  assert.match(html, /第 1 轮分析/);
  assert.match(html, /查看家庭概况/);
  assert.match(html, /80 毫秒/);
  assert.match(html, /运行信息/);
  assert.match(html, /输入 12 · 输出 4 · 推理 3/);
  assert.match(html, /整理过 420 个上下文单位/);
  assert.match(html, /移除过 512 个过期上下文单位/);
  assert.doesNotMatch(html, /home-main|get_home_snapshot|call-1/);
});
