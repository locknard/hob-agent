import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

import { HomeObservationReportService } from "./home-observation-report.js";

test("records one bounded disposition only for the active autonomous observation", async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(HomeObservationReportService);
  const activeAgent = { id: "home-main" } as unknown as Agent;
  const otherAgent = { id: "other" } as unknown as Agent;
  const signal = new AbortController().signal;

  ctx.homeObservationReport.begin(activeAgent);
  const reported = await ctx.tools.execute({
    callId: "report-1" as never,
    name: "report_home_observation",
    arguments: { disposition: "insufficient_evidence" },
    agent: activeAgent,
    signal,
  });
  assert.equal(reported.isError, false);
  assert.deepEqual(ctx.homeObservationReport.end(), "insufficient_evidence");

  const outsideObservation = await ctx.tools.execute({
    callId: "report-2" as never,
    name: "report_home_observation",
    arguments: { disposition: "no_material_value" },
    agent: activeAgent,
    signal,
  });
  assert.equal(outsideObservation.isError, true);

  ctx.homeObservationReport.begin(activeAgent);
  const wrongAgent = await ctx.tools.execute({
    callId: "report-3" as never,
    name: "report_home_observation",
    arguments: { disposition: "mapping_uncertain" },
    agent: otherAgent,
    signal,
  });
  assert.equal(wrongAgent.isError, true);
  const first = await ctx.tools.execute({
    callId: "report-4" as never,
    name: "report_home_observation",
    arguments: { disposition: "existing_rule_overlap" },
    agent: activeAgent,
    signal,
  });
  const duplicate = await ctx.tools.execute({
    callId: "report-5" as never,
    name: "report_home_observation",
    arguments: { disposition: "other_uncertainty" },
    agent: activeAgent,
    signal,
  });
  assert.equal(first.isError, false);
  assert.equal(duplicate.isError, true);
  assert.deepEqual(ctx.homeObservationReport.end(), "existing_rule_overlap");

  await ctx.fiber.dispose();
});

