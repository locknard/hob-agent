import assert from "node:assert/strict";
import test from "node:test";

import { parseModelReference } from "./model-reference.js";

test("parses a supported provider/model reference into a stable route", () => {
  assert.deepEqual(parseModelReference("claude/claude-sonnet-4-6"), {
    provider: "claude",
    modelId: "claude-sonnet-4-6",
  });
  assert.deepEqual(parseModelReference("custom/deepseek-v4-flash-0731"), {
    provider: "custom",
    modelId: "deepseek-v4-flash-0731",
  });
});

test("rejects ambiguous, blank, and unsupported model references", () => {
  for (const value of ["gpt", "gpt/", "/gpt-5", "gpt/a/b", "openai/gpt-5", " gpt/gpt-5"]) {
    assert.throws(() => parseModelReference(value), /Invalid model reference|Unsupported model provider/);
  }
});
