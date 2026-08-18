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
  onObservation: (() => void) | undefined;

  constructor(ctx: Context) {
    super(ctx, "homeAgent");
  }

  async requestObservation() {
    this.observations += 1;
    this.onObservation?.();
  }
}

class StubObservationAudit extends Service {
  readonly starts: { id: string; trigger: string; startedAt: string }[] = [];
  readonly completions: { id: string; completedAt: string; outcome: string }[] = [];
  failBegin = false;
  failCompletion = false;

  constructor(ctx: Context) {
    super(ctx, "homeObservationAudit");
  }

  begin(input: { trigger: string; startedAt: string }) {
    if (this.failBegin) throw new Error("audit unavailable");
    const id = `observation-${this.starts.length + 1}`;
    this.starts.push({ id, ...input });
    return id;
  }

  complete(input: { id: string; completedAt: string; outcome: string }) {
    if (this.failCompletion) throw new Error("audit completion unavailable");
    this.completions.push(input);
  }

  list() { return []; }
}

async function setup() {
  const ctx = new Context();
  await ctx.plugin(StubWorld);
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubAgent);
  await ctx.plugin(StubObservationAudit);
  const fiber = await ctx.plugin(HomeObservationSchedulerService, {
    intervalMinutes: 60,
    scheduler: { wait: (_delay: number, signal: AbortSignal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }) },
    clock: () => "2026-08-19T04:00:00.000Z",
  });
  return { ctx, fiber };
}

test("starts one explicit observation only for a ready idle home with an empty Inbox", async () => {
  const { ctx, fiber } = await setup();

  assert.equal(await ctx.homeObservationScheduler.observeNow(), "no_proposal");
  assert.equal(ctx.homeAgent.observations, 1);
  assert.equal(ctx.homeObservationScheduler.snapshot().lastAttempt?.outcome, "no_proposal");

  ctx.homeAgent.onObservation = () => { ctx.homeProposals.pending = true; };
  assert.equal(await ctx.homeObservationScheduler.observeNow(), "proposal_created");
  assert.equal(ctx.homeAgent.observations, 2);

  ctx.homeWorld.ready = false;
  assert.equal(await ctx.homeObservationScheduler.observeNow(), "world_not_ready");
  ctx.homeWorld.ready = true;
  assert.equal(await ctx.homeObservationScheduler.observeNow(), "proposal_pending");
  ctx.homeProposals.pending = false;
  ctx.homeAgent.observationStatus = "running";
  assert.equal(await ctx.homeObservationScheduler.observeNow(), "agent_busy");
  assert.equal(ctx.homeAgent.observations, 2);
  assert.deepEqual(ctx.homeObservationScheduler.snapshot(), {
    enabled: true,
    intervalMinutes: 60,
    runOnStart: false,
    state: "waiting",
    lastAttempt: { at: "2026-08-19T04:00:00.000Z", outcome: "agent_busy" },
  });
  assert.deepEqual(ctx.homeObservationAudit.starts.map((attempt) => attempt.trigger), [
    "manual",
    "manual",
    "manual",
    "manual",
    "manual",
  ]);
  assert.deepEqual(ctx.homeObservationAudit.completions.map((attempt) => attempt.outcome), [
    "no_proposal",
    "proposal_created",
    "world_not_ready",
    "proposal_pending",
    "agent_busy",
  ]);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("runs on the configured boundary and keeps scheduling after a successful turn", async () => {
  const waits: { delay: number; release: () => void }[] = [];
  const ctx = new Context();
  await ctx.plugin(StubWorld);
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubAgent);
  await ctx.plugin(StubObservationAudit);
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
    clock: () => "2026-08-19T04:00:00.000Z",
  });

  assert.equal(waits[0]?.delay, 60 * 60_000);
  waits[0]?.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.homeAgent.observations, 1);
  assert.equal(ctx.homeObservationAudit.starts[0]?.trigger, "scheduled");
  assert.equal(waits[1]?.delay, 60 * 60_000);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("fails closed before the Agent when audit start is unavailable and resets after completion failure", async () => {
  const { ctx, fiber } = await setup();
  ctx.homeObservationAudit.failBegin = true;
  await assert.rejects(ctx.homeObservationScheduler.observeNow(), /audit unavailable/);
  assert.equal(ctx.homeAgent.observations, 0);
  assert.equal(ctx.homeObservationScheduler.snapshot().state, "waiting");

  ctx.homeObservationAudit.failBegin = false;
  ctx.homeObservationAudit.failCompletion = true;
  await assert.rejects(ctx.homeObservationScheduler.observeNow(), /audit completion unavailable/);
  assert.equal(ctx.homeAgent.observations, 1);
  assert.equal(ctx.homeObservationScheduler.snapshot().state, "waiting");

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("keeps recurring scheduling alive after one audit failure without calling the Agent", async () => {
  const waits: { release: () => void }[] = [];
  const ctx = new Context();
  await ctx.plugin(StubWorld);
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubAgent);
  await ctx.plugin(StubObservationAudit);
  ctx.homeObservationAudit.failBegin = true;
  const fiber = await ctx.plugin(HomeObservationSchedulerService, {
    intervalMinutes: 60,
    scheduler: { wait: (_delay, signal) => new Promise<void>((resolve) => {
      const release = () => {
        signal.removeEventListener("abort", release);
        resolve();
      };
      waits.push({ release });
      signal.addEventListener("abort", release, { once: true });
    }) },
    clock: () => "2026-08-19T04:00:00.000Z",
  });

  waits[0]?.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.homeAgent.observations, 0);
  assert.equal(ctx.homeObservationScheduler.snapshot().lastAttempt?.outcome, "failed");
  assert.equal(waits.length, 2);

  ctx.homeObservationAudit.failBegin = false;
  waits[1]?.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.homeAgent.observations, 1);
  assert.equal(ctx.homeObservationScheduler.snapshot().lastAttempt?.outcome, "no_proposal");
  assert.equal(waits.length, 3);

  await fiber.dispose();
  await ctx.fiber.dispose();
});
