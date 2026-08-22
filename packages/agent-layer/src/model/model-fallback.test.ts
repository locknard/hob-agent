import assert from "node:assert/strict";
import test from "node:test";

import { runWithModelFallback } from "./model-fallback.js";

test("uses an explicit fallback after a retryable provider failure without changing selection", async () => {
  const attempts: string[] = [];
  const result = await runWithModelFallback(["gpt/gpt-5.4", "claude/claude-sonnet-4-6"], async (model) => {
    attempts.push(model);
    if (model.startsWith("gpt")) throw new Error("429 rate limit");
    return "answer";
  });
  assert.deepEqual(attempts, ["gpt/gpt-5.4", "claude/claude-sonnet-4-6"]);
  assert.deepEqual(result, { selectedModel: "gpt/gpt-5.4", respondingModel: "claude/claude-sonnet-4-6", value: "answer" });
});

test("does not fallback on an authentication failure", async () => {
  await assert.rejects(
    () => runWithModelFallback(["gpt/gpt-5.4", "claude/claude-sonnet-4-6"], async () => { throw new Error("401 invalid api key"); }),
    /401 invalid api key/,
  );
});
