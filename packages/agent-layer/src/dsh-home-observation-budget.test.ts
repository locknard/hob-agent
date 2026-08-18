import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";

import { HomeObservationBudgetService } from "./dsh-home-observation-budget.js";

test("denies and cancels only the active observation after its tool-call allowance", async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(HomeObservationBudgetService);
  let executions = 0;
  ctx.tools.register(defineTool({
    name: "bounded_test_tool",
    description: "A local bounded test tool.",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true } } },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    execute: async () => {
      executions += 1;
      return { ok: true };
    },
  }));
  const cancellations: unknown[] = [];
  const activeAgent = {
    cancel: (cause: unknown, options: unknown) => cancellations.push({ cause, options }),
  } as unknown as Agent;
  const otherAgent = { cancel: () => undefined } as unknown as Agent;
  const signal = new AbortController().signal;

  ctx.homeObservationBudget.begin(activeAgent, 2);
  const first = await ctx.tools.execute({ callId: "first" as never, name: "bounded_test_tool", arguments: {}, agent: activeAgent, signal });
  const unrelated = await ctx.tools.execute({ callId: "other" as never, name: "bounded_test_tool", arguments: {}, agent: otherAgent, signal });
  const second = await ctx.tools.execute({ callId: "second" as never, name: "bounded_test_tool", arguments: {}, agent: activeAgent, signal });
  const denied = await ctx.tools.execute({ callId: "third" as never, name: "bounded_test_tool", arguments: {}, agent: activeAgent, signal });

  assert.equal(first.isError, false);
  assert.equal(unrelated.isError, false);
  assert.equal(second.isError, false);
  assert.equal(denied.isError, true);
  assert.match(denied.content.map((item) => "text" in item ? item.text : "").join(" "), /budget exhausted/i);
  assert.equal(executions, 3);
  assert.deepEqual(cancellations, [{ cause: { kind: "parent" }, options: { keepInbox: true } }]);
  assert.equal(ctx.homeObservationBudget.end(), "tool_budget_exhausted");

  const after = await ctx.tools.execute({ callId: "after" as never, name: "bounded_test_tool", arguments: {}, agent: activeAgent, signal });
  assert.equal(after.isError, false);
  assert.equal(executions, 4);

  await ctx.fiber.dispose();
});

test("rejects overlapping or invalid observation budgets", async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(HomeObservationBudgetService);
  const agent = { cancel: () => undefined } as unknown as Agent;

  assert.throws(() => ctx.homeObservationBudget.begin(agent, 0), /positive safe integer/i);
  ctx.homeObservationBudget.begin(agent, 1);
  assert.throws(() => ctx.homeObservationBudget.begin(agent, 1), /already active/i);
  assert.equal(ctx.homeObservationBudget.end(), undefined);

  await ctx.fiber.dispose();
});
