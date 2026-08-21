import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

import { HomeAdviceService } from "./home-advice-service.js";

const report = {
  summary: "Try a bounded schedule.",
  confidence: "partial" as const,
  findings: ["Timing varies with daylight."],
  unknowns: ["Indoor brightness is unavailable."],
  hardwareSuggestions: [],
  validationSteps: ["Review manual reversals."],
};

function emptyTrace(tools: readonly { readonly id: string; readonly name: string }[] = []) {
  return {
    sessionId: "home-main",
    asOfSeq: tools.length,
    turns: [],
    steps: [],
    tools: tools.map((tool, index) => ({
      ...tool,
      turn: 1,
      step: index + 1,
      status: "running" as const,
      startedAt: index + 1,
    })),
    compactions: [],
    prunes: [],
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  };
}

class ReadyWorld extends Service {
  constructor(ctx: Context) { super(ctx, "homeWorld"); }
  snapshot() {
    return {
      bridges: { ha: {} },
      bridgeWatermarks: [{ bridgeId: "ha" }],
      diagnostics: [{ bridgeId: "ha", connectionState: "ready", currentProcessReadyAt: "2026-08-20T10:00:00.000Z" }],
    };
  }
}

class AdviceAgent extends Service {
  readonly observationStatus = "idle";
  constructor(ctx: Context) { super(ctx, "homeAgent"); }
  async requestAdvice(question: string) {
    assert.equal(question, "Why is the curtain timing uncomfortable?");
    return report;
  }
}

class UnreadyWorld extends ReadyWorld {
  override snapshot() {
    return {
      bridges: { ha: {} },
      bridgeWatermarks: [{ bridgeId: "ha" }],
      diagnostics: [{ bridgeId: "ha", connectionState: "connecting", currentProcessReadyAt: undefined }],
    };
  }
}

class BusyAdviceAgent extends Service {
  readonly observationStatus = "running";
  constructor(ctx: Context) { super(ctx, "homeAgent"); }
  async requestAdvice() { return report; }
}

class DeferredAdviceAgent extends Service {
  readonly observationStatus = "idle" as const;
  calls = 0;
  trace = emptyTrace();
  private releaseRequest: (() => void) | undefined;

  constructor(ctx: Context) { super(ctx, "homeAgent"); }

  async requestAdvice(_question: string, signal?: AbortSignal) {
    this.calls += 1;
    return new Promise<typeof report>((resolve, reject) => {
      this.releaseRequest = () => resolve(report);
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }

  traceSnapshot() {
    return this.trace;
  }

  release() {
    this.releaseRequest?.();
    this.releaseRequest = undefined;
  }
}

test("coordinates one ready Agent turn and persists its structured report", async () => {
  const ctx = new Context();
  await ctx.plugin(ReadyWorld);
  await ctx.plugin(AdviceAgent);
  await ctx.plugin(HomeAdviceService, {
    path: ":memory:",
    idFactory: () => "advice-1",
    clock: (() => {
      const times = ["2026-08-20T10:00:00.000Z", "2026-08-20T10:00:02.000Z"];
      return () => times.shift()!;
    })(),
  });

  assert.equal(ctx.homeAdvice.canAsk(), true);
  const running = await ctx.homeAdvice.ask("Why is the curtain timing uncomfortable?");
  assert.equal(running.status, "running");
  assert.equal(running.id, "advice-1");
  await eventually(() => ctx.homeAdvice.get("advice-1")?.status === "completed");
  const completed = ctx.homeAdvice.get("advice-1");
  assert.ok(completed && completed.status === "completed");
  assert.deepEqual(ctx.homeAdvice.list({ limit: 5 }), [completed]);
  await ctx.fiber.dispose();
});

test("standalone storage remains readable but cannot start an Agent turn", async () => {
  const ctx = new Context();
  await ctx.plugin(HomeAdviceService, { path: ":memory:" });

  assert.equal(ctx.homeAdvice.canAsk(), false);
  await assert.rejects(ctx.homeAdvice.ask("Should I add a sensor?"), /unavailable/i);
  assert.deepEqual(ctx.homeAdvice.list(), []);
  await ctx.fiber.dispose();
});

test("does not advertise a question form while the home is unready or the Agent is busy", async () => {
  const unready = new Context();
  await unready.plugin(UnreadyWorld);
  await unready.plugin(AdviceAgent);
  await unready.plugin(HomeAdviceService, { path: ":memory:" });
  assert.equal(unready.homeAdvice.canAsk(), false);
  await unready.fiber.dispose();

  const busy = new Context();
  await busy.plugin(ReadyWorld);
  await busy.plugin(BusyAdviceAgent);
  await busy.plugin(HomeAdviceService, { path: ":memory:" });
  assert.equal(busy.homeAdvice.canAsk(), false);
  await busy.fiber.dispose();
});

test("reports a closed availability state instead of only a boolean", async () => {
  const ctx = new Context();
  await ctx.plugin(HomeAdviceService, { path: ":memory:" });

  assert.deepEqual(ctx.homeAdvice.availability(), { status: "setup_required" });
  assert.equal(ctx.homeAdvice.canAsk(), false);
  await ctx.fiber.dispose();
});

test("accepts a request and returns its running record before the Agent finishes", async () => {
  const ctx = new Context();
  await ctx.plugin(ReadyWorld);
  await ctx.plugin(DeferredAdviceAgent);
  await ctx.plugin(HomeAdviceService, {
    path: ":memory:",
    idFactory: () => "advice-running",
    clock: () => "2026-08-20T10:00:00.000Z",
    progressPollIntervalMs: 1,
  });

  const request = ctx.homeAdvice.ask("Why does the curtain timing feel wrong?");
  const result = await Promise.race([
    request.then(() => "returned" as const),
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 25)),
  ]);
  if (result === "timed-out") ctx.homeAgent.release();
  assert.equal(result, "returned");
  const running = await request;
  assert.equal(running.status, "running");
  assert.equal(ctx.homeAdvice.activeRequestId(), "advice-running");
  assert.deepEqual(ctx.homeAdvice.get("advice-running"), running);

  ctx.homeAgent.release();
  await eventually(() => ctx.homeAdvice.get("advice-running")?.status === "completed");
  assert.equal(ctx.homeAdvice.activeRequestId(), undefined);
  await ctx.fiber.dispose();
});

test("rejects a duplicate request while exposing the active request id", async () => {
  const ctx = new Context();
  await ctx.plugin(ReadyWorld);
  await ctx.plugin(DeferredAdviceAgent);
  await ctx.plugin(HomeAdviceService, {
    path: ":memory:",
    idFactory: () => "advice-active",
    clock: () => "2026-08-20T10:00:00.000Z",
  });

  await ctx.homeAdvice.ask("What should I inspect?");
  assert.deepEqual(ctx.homeAdvice.availability(), {
    status: "active_request",
    activeAdviceId: "advice-active",
  });
  await assert.rejects(
    ctx.homeAdvice.ask("Please start another inspection."),
    (error: unknown) => error instanceof Error && /active_request/.test(error.message),
  );
  assert.equal(ctx.homeAgent.calls, 1);
  ctx.homeAgent.release();
  await eventually(() => ctx.homeAdvice.get("advice-active")?.status === "completed");
  await ctx.fiber.dispose();
});

test("replays only safe semantic progress derived from DSH tool metadata", async () => {
  const ctx = new Context();
  await ctx.plugin(ReadyWorld);
  await ctx.plugin(DeferredAdviceAgent);
  await ctx.plugin(HomeAdviceService, {
    path: ":memory:",
    idFactory: () => "advice-progress",
    clock: () => "2026-08-20T10:00:00.000Z",
    progressPollIntervalMs: 1,
  });

  const running = await ctx.homeAdvice.ask("Why does the curtain timing feel wrong?");
  try {
    const events: string[] = [];
    const unsubscribe = ctx.homeAdvice.subscribe(running.id, (event) => events.push(event.type));
    ctx.homeAgent.trace = emptyTrace([{ id: "tool-1", name: "get_home_inventory" }]);
    await eventually(() => events.includes("reading_inventory"));
    ctx.homeAgent.trace = emptyTrace([
      { id: "tool-1", name: "get_home_inventory" },
      { id: "tool-2", name: "get_home_rules" },
      { id: "tool-3", name: "report_home_advice" },
    ]);
    await eventually(() => events.includes("composing_answer"));
    assert.deepEqual(events.slice(0, 4), ["accepted", "reading_inventory", "checking_rules", "composing_answer"]);
    const replayed = ctx.homeAdvice.events(running.id);
    assert.deepEqual(replayed.map((event) => event.type), events);
    assert.equal(JSON.stringify(replayed).includes("tool-1"), false);
    assert.equal(JSON.stringify(replayed).includes("get_home_inventory"), false);

    ctx.homeAgent.release();
    await eventually(() => ctx.homeAdvice.get(running.id)?.status === "completed");
    unsubscribe();
  } finally {
    ctx.homeAgent.release();
    await ctx.fiber.dispose();
  }
});

test("cancels an active request without creating a second store lifecycle", async () => {
  const ctx = new Context();
  await ctx.plugin(ReadyWorld);
  await ctx.plugin(DeferredAdviceAgent);
  await ctx.plugin(HomeAdviceService, {
    path: ":memory:",
    idFactory: () => "advice-cancelled",
    clock: () => "2026-08-20T10:00:00.000Z",
  });

  const running = await ctx.homeAdvice.ask("Should I add a light sensor?");
  assert.equal(ctx.homeAdvice.cancel(running.id), true);
  await eventually(() => ctx.homeAdvice.get(running.id)?.status === "failed");
  assert.equal(ctx.homeAdvice.cancel(running.id), false);
  assert.equal(ctx.homeAdvice.events(running.id).at(-1)?.type, "cancelled");
  await ctx.fiber.dispose();
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true in time");
}
