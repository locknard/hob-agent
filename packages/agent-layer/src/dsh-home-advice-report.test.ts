import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

import { HomeAdviceReportService, parseHomeAdviceReport } from "./dsh-home-advice-report.js";
import { HomeInventoryCoverageService } from "./dsh-home-inventory-tool.js";

const REPORT = {
  summary: "Try a daylight-aware curtain window before buying hardware.",
  confidence: "partial",
  findings: ["The current rule uses a fixed time."],
  unknowns: ["Indoor brightness is not currently observed."],
  trial: {
    description: "Use sunrise plus a bounded earliest and latest time.",
    durationDays: 14,
    successCriteria: ["Fewer manual reversals within 30 minutes."],
    rollback: "Restore the current fixed schedule.",
  },
  hardwareSuggestions: [{
    capability: "illuminance",
    necessity: "optional",
    reason: "It distinguishes dark mornings from bright ones.",
    placement: "Near the window but outside direct glare.",
    privacyImpact: "low",
    alternative: "Use sunrise and weather data first.",
  }],
  validationSteps: ["Review the result after two weeks."],
} as const;

test("records one bounded structured report only for the active advice turn", async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(HomeAdviceReportService);
  const activeAgent = { id: "home-main" } as unknown as Agent;
  const signal = new AbortController().signal;

  ctx.homeAdviceReport.begin(activeAgent);
  const result = await ctx.tools.execute({
    callId: "advice-report" as never,
    name: "report_home_advice",
    arguments: REPORT,
    agent: activeAgent,
    signal,
  });

  assert.equal(result.isError, false);
  assert.deepEqual(ctx.homeAdviceReport.end(), REPORT);
  const outside = await ctx.tools.execute({
    callId: "outside" as never,
    name: "report_home_advice",
    arguments: REPORT,
    agent: activeAgent,
    signal,
  });
  assert.equal(outside.isError, true);
  await ctx.fiber.dispose();
});

test("rejects unsupported hardware categories and oversized report fields", async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(HomeAdviceReportService);
  const activeAgent = { id: "home-main" } as unknown as Agent;
  ctx.homeAdviceReport.begin(activeAgent);

  const result = await ctx.tools.execute({
    callId: "invalid-advice" as never,
    name: "report_home_advice",
    arguments: {
      ...REPORT,
      summary: "x".repeat(1_001),
      hardwareSuggestions: [{ ...REPORT.hardwareSuggestions[0], capability: "camera" }],
    },
    agent: activeAgent,
    signal: new AbortController().signal,
  });

  assert.equal(result.isError, true);
  assert.equal(ctx.homeAdviceReport.end(), undefined);
  await ctx.fiber.dispose();
});

test("rejects hardware advice until the active turn has exhausted the stable inventory", async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(HomeInventoryCoverageService);
  await ctx.plugin(HomeAdviceReportService);
  const activeAgent = { id: "home-main" } as unknown as Agent;
  ctx.homeInventoryCoverage.beginObservation();
  ctx.homeAdviceReport.begin(activeAgent);

  const result = await ctx.tools.execute({
    callId: "premature-hardware-advice" as never,
    name: "report_home_advice",
    arguments: REPORT,
    agent: activeAgent,
    signal: new AbortController().signal,
  });

  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /inventory/i);
  assert.equal(ctx.homeAdviceReport.end(), undefined);
  await ctx.fiber.dispose();
});

test("keeps hardware optional and trial-first when evidence is not sufficient", () => {
  assert.throws(() => parseHomeAdviceReport({
    ...REPORT,
    hardwareSuggestions: [{ ...REPORT.hardwareSuggestions[0], necessity: "recommended" }],
  }), /sufficient evidence/i);
  assert.throws(() => parseHomeAdviceReport({
    ...REPORT,
    trial: undefined,
  }), /trial/i);
});

test("rejects internal home identifiers and diagnostic codes from household-facing prose", () => {
  assert.throws(() => parseHomeAdviceReport({
    ...REPORT,
    findings: ["Device hw-deadbeef reported journal_query_unavailable."],
  }), /internal implementation detail/i);
  assert.throws(() => parseHomeAdviceReport({
    ...REPORT,
    findings: ["The binary-sensor is stale."],
  }), /internal implementation detail/i);
});
