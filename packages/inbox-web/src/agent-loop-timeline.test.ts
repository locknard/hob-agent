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
    usage: { inputTokens: 12, outputTokens: 4, reasoningTokens: 3 },
  });

  assert.match(html, /aria-label="Agent loop timeline"/);
  assert.match(html, /Turn 1/);
  assert.match(html, /get_home_snapshot/);
  assert.match(html, /80 ms/);
  assert.match(html, /12 input · 4 output · 3 reasoning/);
});
