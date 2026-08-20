import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

import { ProposalInboxService } from "./proposal-inbox-service.js";

class StubProposals extends Service {
  constructor(ctx: Context) {
    super(ctx, "homeProposals");
  }

  list() { return []; }
  get() { return undefined; }
  review() { throw new Error("not used"); }
  qualitySummary() {
    return {
      total: 2,
      statuses: { pending_review: 0, approved: 1, rejected: 1, expired: 0 },
      feedback: {
        useful_as_is: 1,
        already_covered: 0,
        not_useful: 0,
        incorrect_assumption: 1,
        insufficient_evidence: 0,
        household_preference: 0,
        too_risky: 0,
        other: 0,
      },
      reviewedWithoutFeedback: 0,
    };
  }
}

class StubObservationAudit extends Service {
  constructor(ctx: Context) {
    super(ctx, "homeObservationAudit");
  }

  list() {
    return [{
      id: "observation-1",
      trigger: "one_shot",
      startedAt: "2026-08-19T04:00:00.000Z",
      completedAt: "2026-08-19T04:00:01.000Z",
      status: "completed",
      outcome: "no_proposal",
      disposition: "existing_rule_overlap",
    }];
  }

  summary() {
    return {
      totalAttempts: 3,
      completedAttempts: 3,
      interruptedAttempts: 0,
      runningAttempts: 0,
      outcomes: {
        proposal_created: 1,
        no_proposal: 2,
        world_not_ready: 0,
        proposal_pending: 0,
        agent_busy: 0,
        failed: 0,
      },
      dispositions: {
        no_material_value: 1,
        insufficient_evidence: 0,
        existing_rule_overlap: 1,
        mapping_uncertain: 0,
        other_uncertainty: 0,
      },
      noProposalWithoutDisposition: 0,
      measuredAttempts: 2,
      metrics: {
        durationMs: 5_000,
        inputTokens: 240,
        outputTokens: 36,
        reasoningTokens: 14,
        toolCalls: 12,
        failedToolCalls: 1,
      },
    };
  }
}

class StubObservation extends Service {
  runs = 0;

  constructor(ctx: Context) {
    super(ctx, "homeObservationScheduler");
  }

  snapshot() {
    return { enabled: false, runOnStart: false, state: "waiting" as const };
  }

  async observeNow() {
    this.runs += 1;
    return "no_proposal" as const;
  }
}

class StubAdvice extends Service {
  questions: string[] = [];
  constructor(ctx: Context) { super(ctx, "homeAdvice"); }
  canAsk() { return true; }
  async ask(question: string) {
    this.questions.push(question);
    return this.get("advice-1")!;
  }
  list() { return [this.get("advice-1")!]; }
  get(id: string) {
    return id === "advice-1" ? {
      id,
      status: "completed" as const,
      question: "Why is the curtain timing uncomfortable?",
      createdAt: "2026-08-20T10:00:00.000Z",
      completedAt: "2026-08-20T10:00:02.000Z",
      report: {
        summary: "Try a bounded daylight-aware schedule.",
        confidence: "partial" as const,
        findings: [],
        unknowns: ["Indoor brightness is unavailable."],
        hardwareSuggestions: [],
        validationSteps: ["Review after two weeks."],
      },
    } : undefined;
  }
}

test("mounts a local review facade when the optional DSH trace is absent", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.deepEqual(ctx.homeInbox.list(), []);
  assert.match(ctx.homeInbox.renderList(), /Review ideas for your home/);
  assert.match(ctx.homeInbox.renderList(), /Observation schedule is disabled/);
  assert.equal(ctx.homeInbox.renderList().includes("Observe now"), false);
  assert.match(ctx.homeInbox.renderList(), /full home runtime/i);
  assert.equal("apply" in ctx.homeInbox, false);

  await fiber.dispose();
  assert.equal(ctx.homeInbox, undefined);
  await ctx.fiber.dispose();
});

test("exposes explicit observation only when the full runtime supplies the Hub controller", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubObservation);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.equal(ctx.homeInbox.canObserveNow(), true);
  assert.match(ctx.homeInbox.renderList(), /Observe now/i);
  assert.equal(await ctx.homeInbox.observeNow(), "no_proposal");
  assert.equal(ctx.homeObservationScheduler.runs, 1);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("renders bounded persisted observation history without DSH trace content", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubObservationAudit);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.match(ctx.homeInbox.renderList(), /one shot · no proposal · Agent reported: existing rule overlap/i);
  assert.match(ctx.homeInbox.renderList(), /Household calibration/i);
  assert.match(ctx.homeInbox.renderList(), /Useful as-is.*1/i);
  assert.match(ctx.homeInbox.renderList(), /Incorrect assumption.*1/i);
  assert.match(ctx.homeInbox.renderList(), /No material household value.*1/i);
  assert.match(ctx.homeInbox.renderList(), /Existing rule overlap.*1/i);
  assert.match(ctx.homeInbox.renderList(), /Measured attempts.*2/i);
  assert.match(ctx.homeInbox.renderList(), /240 input \/ 36 output \/ 14 reasoning tokens/i);
  assert.match(ctx.homeInbox.renderList(), /12 tool calls \/ 1 failed/i);
  assert.equal(ctx.homeInbox.renderList().includes("observation-1"), false);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("exposes bounded household advice without turning the Inbox into a chat runtime", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubAdvice);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.equal(ctx.homeInbox.canAskAdvice(), true);
  const result = await ctx.homeInbox.askAdvice("Why is the curtain timing uncomfortable?");
  assert.equal(result.id, "advice-1");
  assert.equal((ctx.homeAdvice as unknown as StubAdvice).questions.length, 1);
  assert.match(ctx.homeInbox.renderList(), /Ask about your home/i);
  assert.match(ctx.homeInbox.renderAdvice("advice-1") ?? "", /Try a bounded daylight-aware schedule/i);
  assert.equal(ctx.homeInbox.renderAdvice("missing"), undefined);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("exposes a read-only control center alongside the proposal Inbox", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.equal("renderControlCenter" in ctx.homeInbox, true);
  assert.match((ctx.homeInbox as unknown as { renderControlCenter(): string }).renderControlCenter(), /Control center/i);
  assert.equal("apply" in ctx.homeInbox, false);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("composes live neutral services into the control center without reading raw bridge data", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  ctx.provide("homeWorld", {
    snapshot: () => ({
      bridges: {
        "bridge-main": {
          adapterType: "home-assistant",
          diagnostics: { connectionState: "ready", currentProcessReadyAt: "2026-08-20T09:00:00.000Z" },
          watermark: { epochId: "epoch-main", lastSeq: 7 },
          metrics: { consistency: "ready" },
        },
      },
      bridgeWatermarks: [{ bridgeId: "bridge-main" }],
      diagnostics: [{ bridgeId: "bridge-main", connectionState: "ready", currentProcessReadyAt: "2026-08-20T09:00:00.000Z" }],
      spaces: [{ hwSpaceId: "space-main" }],
      devices: [{ bindings: [{ hwSpaceId: "space-main" }], capabilities: [{}], states: [{ raw: "must-not-render" }] }],
    }),
  });
  ctx.provide("homeAgent", {
    agent: { options: { provider: "openai", model: "gpt-5.6" }, status: "idle" },
    observationStatus: "idle",
  });
  ctx.provide("homeObservationScheduler", {
    snapshot: () => ({ enabled: true, intervalMinutes: 360, runOnStart: false, state: "waiting" as const }),
    observeNow: async () => "no_proposal" as const,
  });
  const fiber = await ctx.plugin(ProposalInboxService);

  const html = ctx.homeInbox.renderControlCenter();
  assert.match(html, /home-assistant/);
  assert.match(html, /gpt-5\.6/);
  assert.match(html, /Home map/);
  assert.equal(html.includes("must-not-render"), false);
  assert.equal(html.includes("epoch-main"), false);

  await fiber.dispose();
  await ctx.fiber.dispose();
});
