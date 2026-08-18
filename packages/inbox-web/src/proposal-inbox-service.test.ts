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

test("mounts a local review facade when the optional DSH trace is absent", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.deepEqual(ctx.homeInbox.list(), []);
  assert.match(ctx.homeInbox.renderList(), /Proposal inbox/);
  assert.match(ctx.homeInbox.renderList(), /Observation schedule is disabled/);
  assert.equal(ctx.homeInbox.renderList().includes("Observe now"), false);
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
