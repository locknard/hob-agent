import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

import { HomeObservationSchedulerService } from "./home-observation-scheduler.js";

class StubWorld extends Service {
  ready = true;

  constructor(ctx: Context) {
    super(ctx, "homeWorld");
  }

  snapshot() {
    return {
      bridges: { "bridge-a": {} },
      bridgeWatermarks: this.ready ? [{ bridgeId: "bridge-a", epochId: "epoch-a", lastSeq: 4 }] : [],
      diagnostics: [{ bridgeId: "bridge-a", connectionState: this.ready ? "ready" : "syncing" }],
    };
  }
}

class StubProposals extends Service {
  pending = false;

  constructor(ctx: Context) {
    super(ctx, "homeProposals");
  }

  list() {
    return this.pending ? [{ id: "proposal-1" }] : [];
  }
}

class StubAgent extends Service {
  observationStatus: "idle" | "running" = "idle";
  observations = 0;

  constructor(ctx: Context) {
    super(ctx, "homeAgent");
  }

  async requestObservation() {
    this.observations += 1;
  }
}

async function setup() {
  const ctx = new Context();
  await ctx.plugin(StubWorld);
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubAgent);
  const fiber = await ctx.plugin(HomeObservationSchedulerService, {
    intervalMinutes: 60,
    scheduler: { wait: (_delay: number, signal: AbortSignal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }) },
  });
  return { ctx, fiber };
}

test("starts one explicit observation only for a ready idle home with an empty Inbox", async () => {
  const { ctx, fiber } = await setup();

  assert.equal(await ctx.homeObservationScheduler.observeNow(), "started");
  assert.equal(ctx.homeAgent.observations, 1);

  ctx.homeWorld.ready = false;
  assert.equal(await ctx.homeObservationScheduler.observeNow(), "world_not_ready");
  ctx.homeWorld.ready = true;
  ctx.homeProposals.pending = true;
  assert.equal(await ctx.homeObservationScheduler.observeNow(), "proposal_pending");
  ctx.homeProposals.pending = false;
  ctx.homeAgent.observationStatus = "running";
  assert.equal(await ctx.homeObservationScheduler.observeNow(), "agent_busy");
  assert.equal(ctx.homeAgent.observations, 1);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("runs on the configured boundary and keeps scheduling after a successful turn", async () => {
  const waits: { delay: number; release: () => void }[] = [];
  const ctx = new Context();
  await ctx.plugin(StubWorld);
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubAgent);
  const fiber = await ctx.plugin(HomeObservationSchedulerService, {
    intervalMinutes: 60,
    scheduler: { wait: (delay, signal) => new Promise<void>((resolve) => {
      const release = () => {
        signal.removeEventListener("abort", release);
        resolve();
      };
      waits.push({ delay, release });
      signal.addEventListener("abort", release, { once: true });
    }) },
  });

  assert.equal(waits[0]?.delay, 60 * 60_000);
  waits[0]?.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.homeAgent.observations, 1);
  assert.equal(waits[1]?.delay, 60 * 60_000);

  await fiber.dispose();
  await ctx.fiber.dispose();
});
