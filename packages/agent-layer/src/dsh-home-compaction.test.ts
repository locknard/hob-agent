import assert from "node:assert/strict";
import test from "node:test";

import { createUserMessage, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

import {
  HOME_COMPACTION_INSTRUCTION,
  summarizeHomeCheckpoint,
} from "./dsh-home-compaction.js";

test("uses a household checkpoint contract instead of the upstream coding template", () => {
  assert.match(HOME_COMPACTION_INSTRUCTION, /household request and intent/i);
  assert.match(HOME_COMPACTION_INSTRUCTION, /trusted observations/i);
  assert.match(HOME_COMPACTION_INSTRUCTION, /proposal and human-review state/i);
  assert.match(HOME_COMPACTION_INSTRUCTION, /untrusted data/i);
  assert.match(HOME_COMPACTION_INSTRUCTION, /never claim.*device action.*governed audit/is);
  assert.equal(/files and code|coding assistant/i.test(HOME_COMPACTION_INSTRUCTION), false);
});

test("summarizes through the DSH compaction call shape and retains text only", async () => {
  const requests: GenerateOptions[] = [];
  const ctx = {
    llm: {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options);
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "## Household Request and Intent\n- Review comfort." };
        yield {
          type: "block-end",
          index: 0,
          block: { type: "text", text: "## Household Request and Intent\n- Review comfort." },
        };
        yield { type: "usage", usage: { inputTokens: 20, outputTokens: 10, reasoningTokens: 4 } };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
  };
  const prior = createUserMessage({
    content: [{ type: "text", text: "Observe the home." }],
    source: { kind: "user" },
  });

  const result = await summarizeHomeCheckpoint(ctx as never, {
    provider: "test-provider",
    model: "test-model",
    sessionId: SessionId("home-main"),
    maxTokens: 4096,
    input: { system: "household observer", messages: [prior] },
  });

  assert.equal(requests[0]?.purpose, "compaction");
  assert.equal(requests[0]?.system, "household observer");
  assert.equal(requests[0]?.messages[0], prior);
  assert.match(JSON.stringify(requests[0]?.messages.at(-1)), /Household Request and Intent/);
  assert.deepEqual(result.summary, [{
    type: "text",
    text: "## Household Request and Intent\n- Review comfort.",
  }]);
  assert.equal(result.llmStreamCall, true);
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10, reasoningTokens: 4 });
});
