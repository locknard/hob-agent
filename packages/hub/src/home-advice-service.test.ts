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
  const completed = await ctx.homeAdvice.ask("Why is the curtain timing uncomfortable?");
  assert.equal(completed.status, "completed");
  assert.equal(completed.id, "advice-1");
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
