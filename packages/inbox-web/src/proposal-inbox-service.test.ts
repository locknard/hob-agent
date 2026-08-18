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
    }];
  }
}

test("mounts a local review facade when the optional DSH trace is absent", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.deepEqual(ctx.homeInbox.list(), []);
  assert.match(ctx.homeInbox.renderList(), /Proposal inbox/);
  assert.match(ctx.homeInbox.renderList(), /Observation schedule is disabled/);
  assert.equal("apply" in ctx.homeInbox, false);

  await fiber.dispose();
  assert.equal(ctx.homeInbox, undefined);
  await ctx.fiber.dispose();
});

test("renders bounded persisted observation history without DSH trace content", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubObservationAudit);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.match(ctx.homeInbox.renderList(), /one shot · no useful proposal/i);
  assert.equal(ctx.homeInbox.renderList().includes("observation-1"), false);

  await fiber.dispose();
  await ctx.fiber.dispose();
});
