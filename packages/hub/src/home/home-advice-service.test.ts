import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

import { HomeAdviceService } from "./home-advice-service.js";
import type { OneShotActionActor } from "../authority/one-shot-action-plane.js";

const report = {
  summary: "Try a bounded schedule.",
  confidence: "partial" as const,
  findings: ["Timing varies with daylight."],
  unknowns: ["Indoor brightness is unavailable."],
  hardwareSuggestions: [],
  validationSteps: ["Review manual reversals."],
};

const authenticatedActor: OneShotActionActor = {
  principalId: "adult-1",
  role: "adult_member",
  present: true,
  device: { kind: "private", boundPrincipalId: "adult-1" },
};

function emptyTrace(tools: readonly {
  readonly id: string;
  readonly name: string;
  readonly status?: "running" | "completed" | "failed";
}[] = []) {
  return {
    sessionId: "home-main",
    asOfSeq: tools.length,
    turns: [],
    steps: [],
    tools: tools.map((tool, index) => ({
      ...tool,
      turn: 1,
      step: index + 1,
      status: tool.status ?? "running",
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

class RecoveringWorld extends ReadyWorld {
  ready = false;

  override snapshot() {
    return {
      bridges: { ha: {} },
      bridgeWatermarks: [{ bridgeId: "ha" }],
      diagnostics: [{
        bridgeId: "ha",
        connectionState: this.ready ? "ready" : "connecting",
        currentProcessReadyAt: this.ready ? "2026-08-20T10:00:00.000Z" : undefined,
      }],
    };
  }
}

class BusyAdviceAgent extends Service {
  readonly observationStatus = "running";
  constructor(ctx: Context) { super(ctx, "homeAgent"); }
  async requestAdvice() { return report; }
}

class DegradedAdviceAgent extends AdviceAgent {
  readonly modelStatus = { state: "degraded" as const };
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

class DegradedDeferredAdviceAgent extends DeferredAdviceAgent {
  modelStatus: { state: "active" | "degraded" } = { state: "degraded" };
}

class RecordingActorScope extends Service {
  readonly calls: OneShotActionActor[] = [];
  private current: OneShotActionActor | undefined;

  constructor(ctx: Context) { super(ctx, "homeMediaConversation"); }

  runWithActor<T>(actor: OneShotActionActor, callback: () => T): T {
    this.calls.push(actor);
    this.current = actor;
    return callback();
  }

  currentActor(): OneShotActionActor | undefined {
    return this.current;
  }
}

class ActorAwareAdviceAgent extends Service {
  readonly observationStatus = "idle" as const;
  readonly observedActors: Array<OneShotActionActor | undefined> = [];
  private releaseRequest: (() => void) | undefined;

  constructor(ctx: Context) { super(ctx, "homeAgent"); }

  async requestAdvice() {
    await Promise.resolve();
    const scope = this.ctx.get("homeMediaConversation") as unknown as RecordingActorScope | undefined;
    this.observedActors.push(scope?.currentActor());
    return new Promise<typeof report>((resolve) => {
      this.releaseRequest = () => resolve(report);
    });
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

test("keeps an authenticated actor out of the media scope for an advice turn", async () => {
  const ctx = new Context();
  await ctx.plugin(ReadyWorld);
  await ctx.plugin(ActorAwareAdviceAgent);
  await ctx.plugin(RecordingActorScope);
  await ctx.plugin(HomeAdviceService, {
    path: ":memory:",
    idFactory: () => "advice-actor-scope",
    clock: () => "2026-08-20T10:00:00.000Z",
  });

  const running = await ctx.homeAdvice.ask("Can I play music in the media room?", undefined, authenticatedActor);
  assert.equal(ctx.homeAdvice.background(running.id), true);
  ctx.homeAgent.release();
  await eventually(() => ctx.homeAdvice.get(running.id)?.status === "completed");
  assert.deepEqual(ctx.homeMediaConversation.calls, []);
  assert.deepEqual(ctx.homeAgent.observedActors, [undefined]);
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

test("reports model_unavailable before creating an advice request while the mounted Agent is degraded", async () => {
  const ctx = new Context();
  await ctx.plugin(ReadyWorld);
  await ctx.plugin(DegradedAdviceAgent);
  await ctx.plugin(HomeAdviceService, { path: ":memory:" });

  assert.deepEqual(ctx.homeAdvice.availability(), { status: "model_unavailable" });
  await assert.rejects(ctx.homeAdvice.ask("Can I ask again later?"), /model_unavailable/i);
  assert.deepEqual(ctx.homeAdvice.list(), []);
  await ctx.fiber.dispose();
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

test("persists a causality stage only when the redacted trace contains get_home_causality", async () => {
  const ctx = new Context();
  await ctx.plugin(ReadyWorld);
  await ctx.plugin(DeferredAdviceAgent);
  await ctx.plugin(HomeAdviceService, {
    path: ":memory:",
    idFactory: () => "advice-causality-progress",
    clock: () => "2026-08-20T10:00:00.000Z",
    progressPollIntervalMs: 1,
  });

  const running = await ctx.homeAdvice.ask("Why did the curtain move?");
  try {
    const events: string[] = [];
    const unsubscribe = ctx.homeAdvice.subscribe(running.id, (event) => events.push(event.type));
    ctx.homeAgent.trace = emptyTrace([
      { id: "tool-evidence", name: "get_home_evidence", status: "completed" },
      { id: "tool-causality", name: "get_home_causality", status: "running" },
    ]);
    await eventually(() => events.includes("evaluating_evidence"));
    assert.equal(events.includes("causality"), false);

    ctx.homeAgent.trace = emptyTrace([
      { id: "tool-evidence", name: "get_home_evidence", status: "completed" },
      { id: "tool-causality", name: "get_home_causality", status: "failed" },
    ]);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(events.includes("causality"), false);

    ctx.homeAgent.trace = emptyTrace([
      { id: "tool-evidence", name: "get_home_evidence", status: "completed" },
      { id: "tool-causality", name: "get_home_causality", status: "completed" },
      { id: "tool-report", name: "report_home_advice", status: "completed" },
    ]);
    await eventually(() => events.includes("causality"));
    assert.deepEqual(events.slice(0, 4), ["accepted", "evaluating_evidence", "causality", "composing_answer"]);
    assert.equal(JSON.stringify(ctx.homeAdvice.events(running.id)).includes("get_home_causality"), false);

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

test("background preserves the advice id and turn, then exposes one durable completion notification", async () => {
  const ctx = new Context();
  await ctx.plugin(ReadyWorld);
  await ctx.plugin(DeferredAdviceAgent);
  await ctx.plugin(HomeAdviceService, {
    path: ":memory:",
    idFactory: () => "advice-background-service",
    clock: () => "2026-08-20T10:00:00.000Z",
  });

  const running = await ctx.homeAdvice.ask("Why does the curtain timing feel wrong?");
  assert.equal(ctx.homeAdvice.background(running.id), true);
  assert.equal(ctx.homeAdvice.background(running.id), false);
  assert.equal(ctx.homeAdvice.activeRequestId(), running.id);
  assert.equal(ctx.homeAdvice.get(running.id)?.status, "background");
  await assert.rejects(ctx.homeAdvice.ask("Start another inspection."), /active_request/i);

  ctx.homeAgent.release();
  await eventually(() => ctx.homeAdvice.get(running.id)?.status === "completed");
  assert.equal(ctx.homeAdvice.events(running.id).some((event) => event.type === "background"), true);
  assert.equal(ctx.homeAdvice.events(running.id).at(-1)?.type, "completed");
  assert.deepEqual(ctx.homeAdvice.peekNextCompletionNotification(), {
    adviceId: running.id,
    status: "completed",
    completedAt: "2026-08-20T10:00:00.000Z",
    eventId: 3,
  });
  assert.equal(ctx.homeAdvice.acknowledgeCompletionNotification(running.id), true);
  assert.equal(ctx.homeAdvice.peekNextCompletionNotification(), undefined);
  await ctx.fiber.dispose();
});

test("guards background cancellation and keeps the cancelled terminal notification one-shot", async () => {
  const ctx = new Context();
  await ctx.plugin(ReadyWorld);
  await ctx.plugin(DeferredAdviceAgent);
  await ctx.plugin(HomeAdviceService, {
    path: ":memory:",
    idFactory: () => "advice-background-cancelled",
    clock: () => "2026-08-20T10:00:00.000Z",
  });

  const running = await ctx.homeAdvice.ask("Should I add a light sensor?");
  assert.equal(ctx.homeAdvice.background(running.id), true);
  assert.equal(ctx.homeAdvice.cancel("unknown-advice"), false);
  assert.equal(ctx.homeAdvice.cancel(running.id), true);
  await eventually(() => ctx.homeAdvice.get(running.id)?.status === "failed");
  assert.equal(ctx.homeAdvice.cancel(running.id), false);
  assert.equal(ctx.homeAdvice.background(running.id), false);
  assert.equal(ctx.homeAdvice.events(running.id).at(-1)?.type, "cancelled");
  assert.deepEqual(ctx.homeAdvice.peekNextCompletionNotification()?.status, "cancelled");
  assert.equal(ctx.homeAdvice.acknowledgeCompletionNotification(running.id), true);
  assert.equal(ctx.homeAdvice.peekNextCompletionNotification(), undefined);
  await ctx.fiber.dispose();
});

test("recovers a persisted background advice after service restart with the same id and event cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-advice-service-reopen-"));
  const path = join(directory, "advice.sqlite");

  const first = new Context();
  await first.plugin(ReadyWorld);
  await first.plugin(DeferredAdviceAgent);
  await first.plugin(HomeAdviceService, {
    path,
    idFactory: () => "advice-recovered",
    clock: () => "2026-08-20T10:00:00.000Z",
  });
  const running = await first.homeAdvice.ask("Why did the window open?");
  assert.equal(first.homeAdvice.background(running.id), true);
  assert.equal(first.homeAdvice.activeRequestId(), running.id);
  await first.fiber.dispose();

  const second = new Context();
  await second.plugin(ReadyWorld);
  await second.plugin(DeferredAdviceAgent);
  await second.plugin(HomeAdviceService, { path, clock: () => "2026-08-20T10:00:00.000Z" });
  await eventually(() => second.homeAdvice.activeRequestId() === running.id);
  assert.equal(second.homeAdvice.get(running.id)?.status, "background");
  assert.deepEqual(second.homeAdvice.events(running.id).map((event) => event.type), ["accepted", "background"]);

  second.homeAgent.release();
  await eventually(() => second.homeAdvice.get(running.id)?.status === "completed");
  assert.equal(second.homeAdvice.peekNextCompletionNotification()?.adviceId, running.id);
  assert.equal(second.homeAdvice.acknowledgeCompletionNotification(running.id), true);
  await second.fiber.dispose();
});

test("does not restore an actor when a background advice recovers after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-advice-service-actor-recovery-"));
  const path = join(directory, "advice.sqlite");

  const first = new Context();
  await first.plugin(ReadyWorld);
  await first.plugin(DeferredAdviceAgent);
  await first.plugin(HomeAdviceService, {
    path,
    idFactory: () => "advice-actor-recovery",
    clock: () => "2026-08-20T10:00:00.000Z",
  });
  const original = await first.homeAdvice.ask("Why did the window open?", undefined, authenticatedActor);
  assert.equal(first.homeAdvice.background(original.id), true);
  await first.fiber.dispose();

  const second = new Context();
  await second.plugin(ReadyWorld);
  await second.plugin(ActorAwareAdviceAgent);
  await second.plugin(RecordingActorScope);
  await second.plugin(HomeAdviceService, { path, clock: () => "2026-08-20T10:00:00.000Z" });
  await eventually(() => second.homeAdvice.activeRequestId() === original.id);
  assert.deepEqual(second.homeAgent.observedActors, [undefined]);
  assert.deepEqual(second.homeMediaConversation.calls, []);
  second.homeAgent.release();
  await eventually(() => second.homeAdvice.get(original.id)?.status === "completed");
  await second.fiber.dispose();
});

test("keeps a background recovery coordinator waiting through startup connection and reuses the same advice id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-advice-service-delayed-recovery-"));
  const path = join(directory, "advice.sqlite");

  const first = new Context();
  await first.plugin(ReadyWorld);
  await first.plugin(DeferredAdviceAgent);
  await first.plugin(HomeAdviceService, {
    path,
    idFactory: () => "advice-delayed-recovery",
    clock: () => "2026-08-20T10:00:00.000Z",
  });
  const original = await first.homeAdvice.ask("Why did the window open?");
  assert.equal(first.homeAdvice.background(original.id), true);
  await first.fiber.dispose();

  const second = new Context();
  await second.plugin(RecoveringWorld);
  await second.plugin(DeferredAdviceAgent);
  await second.plugin(HomeAdviceService, {
    path,
    backgroundRecoveryIntervalMs: 5,
    clock: () => "2026-08-20T10:00:00.000Z",
  });
  const secondWorld = second.get("homeWorld") as unknown as RecoveringWorld;
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(second.homeAdvice.activeRequestId(), undefined);
  assert.equal(second.homeAgent.calls, 0);

  secondWorld.ready = true;
  await eventually(() => second.homeAdvice.activeRequestId() === original.id);
  assert.equal(second.homeAgent.calls, 1);
  assert.equal(second.homeAdvice.get(original.id)?.status, "background");
  second.homeAgent.release();
  await eventually(() => second.homeAdvice.get(original.id)?.status === "completed");
  await second.fiber.dispose();
});

test("keeps a durable background advice untouched until the mounted Agent model recovers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-advice-service-model-recovery-"));
  const path = join(directory, "advice.sqlite");
  const first = new Context();
  await first.plugin(ReadyWorld);
  await first.plugin(DeferredAdviceAgent);
  await first.plugin(HomeAdviceService, { path, idFactory: () => "advice-model-recovery" });
  const original = await first.homeAdvice.ask("Why did the window open?");
  assert.equal(first.homeAdvice.background(original.id), true);
  await first.fiber.dispose();

  const second = new Context();
  await second.plugin(ReadyWorld);
  await second.plugin(DegradedDeferredAdviceAgent);
  await second.plugin(HomeAdviceService, { path, backgroundRecoveryIntervalMs: 5 });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(second.homeAdvice.activeRequestId(), undefined);
  assert.equal(second.homeAdvice.get(original.id)?.status, "background");
  assert.equal(second.homeAgent.calls, 0);

  second.homeAgent.modelStatus = { state: "active" };
  await eventually(() => second.homeAdvice.activeRequestId() === original.id);
  second.homeAgent.release();
  await eventually(() => second.homeAdvice.get(original.id)?.status === "completed");
  await second.fiber.dispose();
});

test("cancels pending background recovery on service disposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-advice-service-cancel-recovery-"));
  const path = join(directory, "advice.sqlite");

  const first = new Context();
  await first.plugin(ReadyWorld);
  await first.plugin(DeferredAdviceAgent);
  await first.plugin(HomeAdviceService, {
    path,
    idFactory: () => "advice-cancel-recovery",
    clock: () => "2026-08-20T10:00:00.000Z",
  });
  const original = await first.homeAdvice.ask("Why did the window open?");
  assert.equal(first.homeAdvice.background(original.id), true);
  await first.fiber.dispose();

  const second = new Context();
  await second.plugin(RecoveringWorld);
  await second.plugin(DeferredAdviceAgent);
  await second.plugin(HomeAdviceService, {
    path,
    backgroundRecoveryIntervalMs: 5,
    clock: () => "2026-08-20T10:00:00.000Z",
  });
  const secondAgent = second.get("homeAgent") as unknown as DeferredAdviceAgent;
  const secondWorld = second.get("homeWorld") as unknown as RecoveringWorld;
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  await second.fiber.dispose();
  secondWorld.ready = true;
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal(secondAgent.calls, 0);
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true in time");
}
