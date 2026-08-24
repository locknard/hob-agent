import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { HomeMediaActionTurnService, HomeMediaActionTurnUnavailableError } from "./home-media-action-turn-service.js";
import { SqliteHomeMediaActionTurnStore } from "./home-media-action-turn-store.js";
import type { HomeMediaConversationState } from "./home-media-conversation-service.js";
import type { OneShotActionActor, OneShotActionTicket } from "../authority/one-shot-action-plane.js";

const NOW = "2026-08-24T01:00:00.000Z";
const ACTOR: OneShotActionActor = {
  principalId: "member-1",
  role: "adult_member",
  present: true,
  device: { kind: "private", boundPrincipalId: "member-1" },
};
const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => { this.resolve = resolve; });
  }
}

class StubAgent {
  observationStatus: "idle" | "running" = "idle";
  modelStatus: { readonly state: "active" | "degraded" } = { state: "active" };
  readonly calls: Array<{ readonly question: string; readonly signal: AbortSignal }> = [];
  gate: Deferred<void> | undefined;

  async requestMediaActionTurn(question: string, signal?: AbortSignal): Promise<void> {
    assert.ok(signal !== undefined);
    this.calls.push({ question, signal });
    await this.gate?.promise;
  }
}

class StubConversation {
  result: HomeMediaConversationState = { status: "clarification", slot: "query", reason: "missing", options: [] };
  readonly calls: Array<{ readonly actor: OneShotActionActor; readonly requestId: string }> = [];
  afterResult: ((requestId: string, result: HomeMediaConversationState) => void) | undefined;

  async runActionTurn(
    actor: OneShotActionActor,
    requestId: string,
    callback: () => unknown | PromiseLike<unknown>,
    signal?: AbortSignal,
  ): Promise<HomeMediaConversationState> {
    this.calls.push({ actor, requestId });
    const task = Promise.resolve(callback());
    if (signal === undefined) await task;
    else await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      task.then(() => resolve(), reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
    this.afterResult?.(requestId, this.result);
    return this.result;
  }
}

class StubReviewCenter {
  readonly byId = new Map<string, OneShotActionTicket>();
  readonly byRequest = new Map<string, OneShotActionTicket>();

  getActionTicket(ticketId: string): OneShotActionTicket | undefined { return this.byId.get(ticketId); }
  getActionTicketForRequest(requestId: string): OneShotActionTicket | undefined { return this.byRequest.get(requestId); }

  put(ticket: OneShotActionTicket): void {
    this.byId.set(ticket.id, ticket);
    this.byRequest.set(ticket.requestId, ticket);
  }
}

function ticket(requestId: string, status: OneShotActionTicket["status"] = "pending_confirmation"): OneShotActionTicket {
  return {
    id: "ticket-1",
    requestId,
    capabilityId: "media-player-1",
    action: {
      kind: "play_media",
      mediaRef: "0123456789abcdef",
      queueMode: "replace_and_play",
    },
    policyClass: "confirmation",
    status,
    createdAt: NOW,
    expiresAt: "2026-08-24T01:05:00.000Z",
  };
}

function fixture(input: { readonly gate?: Deferred<void> } = {}) {
  const context = new Context();
  const store = new SqliteHomeMediaActionTurnStore({
    path: ":memory:",
    idFactory: (() => { let count = 0; return () => `turn-${++count}`; })(),
  });
  const agent = new StubAgent();
  agent.gate = input.gate;
  const conversation = new StubConversation();
  const reviewCenter = new StubReviewCenter();
  conversation.afterResult = (requestId, result) => {
    if ("ticketId" in result && result.ticketId !== undefined) reviewCenter.put(ticket(requestId));
  };
  return { context, store, agent, conversation, reviewCenter };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("forwards durable media completion notifications without expanding their payload", async () => {
  const fx = fixture();
  const turn = fx.store.begin({
    createdAt: NOW,
    idempotencyKey: KEY_A,
    question: "播放爵士",
  }).turn;
  fx.store.clarify({
    id: turn.id,
    clarification: { status: "clarification", slot: "query", reason: "missing", options: [] },
    transitionedAt: "2026-08-24T01:00:01.000Z",
  });
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store,
    agent: fx.agent,
    conversation: fx.conversation,
    reviewCenter: fx.reviewCenter,
    clock: () => NOW,
  });
  try {
    assert.deepEqual(fx.context.homeMediaActionTurns.peekNextCompletionNotification(), {
      turnId: turn.id,
      status: "clarification",
      completedAt: "2026-08-24T01:00:01.000Z",
    });
    assert.equal(fx.context.homeMediaActionTurns.acknowledgeCompletionNotification(turn.id), true);
    assert.equal(fx.context.homeMediaActionTurns.peekNextCompletionNotification(), undefined);
  } finally {
    await fx.context.fiber.dispose();
  }
});

test("accepts an explicit media action immediately and persists only its durable turn state", async () => {
  const fx = fixture({ gate: new Deferred<void>() });
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store,
    agent: fx.agent,
    conversation: fx.conversation,
    reviewCenter: fx.reviewCenter,
    clock: () => NOW,
  });
  try {
    const accepted = await fx.context.homeMediaActionTurns.start({
      question: "播放晚间爵士",
      actor: ACTOR,
      idempotencyKey: KEY_A,
    });
    assert.equal(accepted.status, "running");
    assert.equal(accepted.question, "播放晚间爵士");
    assert.equal(fx.agent.calls.length, 1, "model work continues outside the caller");
    assert.equal(fx.store.get(accepted.id)?.status, "running");
    assert.equal("actor" in (fx.store.get(accepted.id) ?? {}), false);
    fx.agent.gate!.resolve();
    await settle();
    assert.equal(fx.context.homeMediaActionTurns.get(accepted.id)?.status, "clarification");
  } finally {
    await fx.context.fiber.dispose();
  }
});

test("projects a ticket from the review owner live without a second confirmation owner", async () => {
  const fx = fixture();
  fx.conversation.result = {
    status: "pending_confirmation",
    ticketId: "ticket-1",
    policyClass: "confirmation",
    intent: {
      kind: "play_media",
      playerHwCapabilityId: "media-player-1",
      mediaRef: "0123456789abcdef",
      queueMode: "replace_and_play",
    },
  };
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store, agent: fx.agent, conversation: fx.conversation, reviewCenter: fx.reviewCenter, clock: () => NOW,
  });
  try {
    const accepted = await fx.context.homeMediaActionTurns.start({ question: "播放爵士", actor: ACTOR, idempotencyKey: KEY_A });
    await settle();
    const pending = fx.context.homeMediaActionTurns.get(accepted.id);
    assert.equal(pending?.status, "ticket");
    assert.equal(pending?.status === "ticket" ? pending.ticket.status : undefined, "pending_confirmation");
    fx.reviewCenter.put(ticket(`media-action:${KEY_A}`, "verified"));
    const verified = fx.context.homeMediaActionTurns.get(accepted.id);
    assert.equal(verified?.status === "ticket" ? verified.ticket.status : undefined, "verified");
  } finally {
    await fx.context.fiber.dispose();
  }
});

test("replays one idempotency key without starting another Agent turn and excludes a second key while active", async () => {
  const fx = fixture({ gate: new Deferred<void>() });
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store, agent: fx.agent, conversation: fx.conversation, reviewCenter: fx.reviewCenter, clock: () => NOW,
  });
  try {
    const first = await fx.context.homeMediaActionTurns.start({ question: "播放爵士", actor: ACTOR, idempotencyKey: KEY_A });
    assert.deepEqual(fx.context.homeMediaActionTurns.availability(), {
      status: "active_turn",
      activeTurnId: first.id,
    });
    const retry = await fx.context.homeMediaActionTurns.start({ question: "播放爵士", actor: ACTOR, idempotencyKey: KEY_A });
    assert.equal(retry.id, first.id);
    assert.equal(fx.agent.calls.length, 1);
    await assert.rejects(
      fx.context.homeMediaActionTurns.start({ question: "播放另一首歌", actor: ACTOR, idempotencyKey: KEY_A }),
      /conflict/i,
    );
    assert.equal(fx.agent.calls.length, 1);
    await assert.rejects(
      fx.context.homeMediaActionTurns.start({ question: "播放古典乐", actor: ACTOR, idempotencyKey: KEY_B }),
      (error: unknown) => error instanceof HomeMediaActionTurnUnavailableError && error.code === "active_turn",
    );
    fx.agent.gate!.resolve();
    await settle();
  } finally {
    await fx.context.fiber.dispose();
  }
});

test("returns the durable begin projection without a second read after actor scope starts", async () => {
  const fx = fixture({ gate: new Deferred<void>() });
  const originalGet = fx.store.get.bind(fx.store);
  let getCalls = 0;
  let rejectAdditionalReads = true;
  Object.assign(fx.store, {
    get: (id: string) => {
      getCalls += 1;
      if (rejectAdditionalReads && getCalls > 1) throw new Error("projection read failed");
      return originalGet(id);
    },
  });
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store,
    agent: fx.agent,
    conversation: fx.conversation,
    reviewCenter: fx.reviewCenter,
    clock: () => NOW,
  });
  try {
    const accepted = await fx.context.homeMediaActionTurns.start({
      question: "播放爵士",
      actor: ACTOR,
      idempotencyKey: KEY_A,
    });
    assert.equal(accepted.status, "running");
    assert.equal(getCalls, 1, "acceptance must use the record returned by the durable begin transaction");
    assert.equal(fx.agent.calls[0]?.signal.aborted, false);
    rejectAdditionalReads = false;
    fx.agent.gate!.resolve();
    await settle();
    assert.equal(originalGet(accepted.id)?.status, "clarification");
  } finally {
    rejectAdditionalReads = false;
    await fx.context.fiber.dispose();
  }
});

test("replays a terminal idempotency record while the model is unavailable", async () => {
  const fx = fixture();
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store, agent: fx.agent, conversation: fx.conversation, reviewCenter: fx.reviewCenter, clock: () => NOW,
  });
  try {
    const first = await fx.context.homeMediaActionTurns.start({ question: "播放爵士", actor: ACTOR, idempotencyKey: KEY_A });
    await settle();
    assert.equal(fx.context.homeMediaActionTurns.get(first.id)?.status, "clarification");
    fx.agent.modelStatus = { state: "degraded" };
    const replayed = await fx.context.homeMediaActionTurns.start({ question: "播放爵士", actor: ACTOR, idempotencyKey: KEY_A });
    assert.equal(replayed.id, first.id);
    assert.equal(fx.agent.calls.length, 1);
  } finally {
    await fx.context.fiber.dispose();
  }
});

test("binds a ticket discovered during cancellation instead of cancelling the durable action", async () => {
  const fx = fixture({ gate: new Deferred<void>() });
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store, agent: fx.agent, conversation: fx.conversation, reviewCenter: fx.reviewCenter, clock: () => NOW,
  });
  try {
    const accepted = await fx.context.homeMediaActionTurns.start({ question: "播放爵士", actor: ACTOR, idempotencyKey: KEY_A });
    fx.reviewCenter.put(ticket(`media-action:${KEY_A}`));
    assert.equal(fx.context.homeMediaActionTurns.cancel(accepted.id), false);
    assert.equal(fx.store.get(accepted.id)?.status, "ticket");
    fx.agent.gate!.resolve();
    await settle();
  } finally {
    await fx.context.fiber.dispose();
  }
});

test("revokes the actor scope when cancellation cannot verify ticket ownership", async () => {
  const fx = fixture({ gate: new Deferred<void>() });
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store,
    agent: fx.agent,
    conversation: fx.conversation,
    reviewCenter: fx.reviewCenter,
    clock: () => NOW,
  });
  try {
    const accepted = await fx.context.homeMediaActionTurns.start({
      question: "播放爵士",
      actor: ACTOR,
      idempotencyKey: KEY_A,
    });
    Object.assign(fx.reviewCenter, {
      getActionTicketForRequest: () => { throw new Error("ticket store unavailable"); },
    });

    assert.equal(fx.context.homeMediaActionTurns.cancel(accepted.id), false);
    assert.equal(fx.agent.calls[0]?.signal.aborted, true);
    assert.deepEqual(fx.context.homeMediaActionTurns.availability(), { status: "unavailable" });
    fx.agent.gate!.resolve();
    await settle();
    assert.equal(fx.reviewCenter.byRequest.size, 0);
  } finally {
    await fx.context.fiber.dispose();
  }
});

test("closes a model timeout as a failure rather than a user cancellation", async () => {
  const fx = fixture({ gate: new Deferred<void>() });
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store,
    agent: fx.agent,
    conversation: fx.conversation,
    reviewCenter: fx.reviewCenter,
    clock: () => NOW,
    actionTimeoutMs: 1,
  });
  try {
    const accepted = await fx.context.homeMediaActionTurns.start({ question: "播放爵士", actor: ACTOR, idempotencyKey: KEY_A });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const closed = fx.context.homeMediaActionTurns.get(accepted.id);
    assert.equal(closed?.status, "failed");
    assert.equal(closed?.status === "failed" ? closed.reason : undefined, "timed_out");
    assert.equal(fx.context.homeMediaActionTurns.availability().status, "ready");
  } finally {
    await fx.context.fiber.dispose();
  }
});

test("recovers a persisted ticket without rerunning an old actor and closes a pre-ticket interruption", async () => {
  const context = new Context();
  const store = new SqliteHomeMediaActionTurnStore({ path: ":memory:", idFactory: (() => { let index = 0; return () => `recovery-${++index}`; })() });
  const ticketed = store.begin({ createdAt: NOW, idempotencyKey: KEY_A, question: "播放爵士" }).turn;
  const interrupted = store.begin({ createdAt: NOW, idempotencyKey: KEY_B, question: "播放古典乐" }).turn;
  const agent = new StubAgent();
  const conversation = new StubConversation();
  const reviewCenter = new StubReviewCenter();
  reviewCenter.put(ticket(ticketed.requestId));
  await context.plugin(HomeMediaActionTurnService, {
    store, agent, conversation, reviewCenter, clock: () => NOW,
  });
  try {
    await settle();
    assert.equal(store.get(ticketed.id)?.status, "ticket");
    const failed = store.get(interrupted.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.status === "failed" ? failed.reason : undefined, "interrupted_before_action");
    assert.equal(agent.calls.length, 0, "recovery never recreates actor presence or re-runs the model");
  } finally {
    await context.fiber.dispose();
  }
});

test("projects missing and request-mismatched ticket records as explicit integrity states", async () => {
  const fx = fixture();
  const missing = fx.store.begin({ createdAt: NOW, idempotencyKey: KEY_A, question: "播放爵士" }).turn;
  assert.equal(fx.store.ticket({ id: missing.id, ticketId: "ticket-missing", transitionedAt: NOW }), true);
  const mismatch = fx.store.begin({ createdAt: NOW, idempotencyKey: KEY_B, question: "播放古典乐" }).turn;
  assert.equal(fx.store.ticket({ id: mismatch.id, ticketId: "ticket-mismatch", transitionedAt: NOW }), true);
  fx.reviewCenter.put({ ...ticket("another-request"), id: "ticket-mismatch" });
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store, agent: fx.agent, conversation: fx.conversation, reviewCenter: fx.reviewCenter, clock: () => NOW,
  });
  try {
    assert.equal(fx.context.homeMediaActionTurns.get(missing.id)?.status, "unavailable");
    assert.equal(fx.context.homeMediaActionTurns.get(mismatch.id)?.status, "corrupted");
  } finally {
    await fx.context.fiber.dispose();
  }
});

test("replays durable events and closes after revoking a signal-ignoring action scope", async () => {
  const fx = fixture({ gate: new Deferred<void>() });
  let storeClosed = false;
  const originalClose = fx.store.close.bind(fx.store);
  Object.assign(fx.store, { close: () => { storeClosed = true; originalClose(); } });
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store, agent: fx.agent, conversation: fx.conversation, reviewCenter: fx.reviewCenter, clock: () => NOW,
  });
  try {
    const accepted = await fx.context.homeMediaActionTurns.start({ question: "播放爵士", actor: ACTOR, idempotencyKey: KEY_A });
    const events: string[] = [];
    fx.context.homeMediaActionTurns.subscribe(accepted.id, (event) => events.push(event.type));
    const closing = fx.context.homeMediaActionTurns.close();
    await closing;
    assert.equal(storeClosed, true, "the revoked actor scope does not wait for a signal-ignoring child");
    assert.deepEqual(events, ["accepted", "cancelled"]);
    fx.agent.gate!.resolve();
    await settle();
  } finally {
    await fx.context.fiber.dispose();
  }
});

test("bounds total live media action subscriptions and releases capacity on disconnect", async () => {
  const fx = fixture({ gate: new Deferred<void>() });
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store,
    agent: fx.agent,
    conversation: fx.conversation,
    reviewCenter: fx.reviewCenter,
    clock: () => NOW,
    maxSubscriptions: 1,
  });
  try {
    const accepted = await fx.context.homeMediaActionTurns.start({
      question: "播放爵士",
      actor: ACTOR,
      idempotencyKey: KEY_A,
    });
    const first = fx.context.homeMediaActionTurns.subscribe(accepted.id, () => undefined);
    assert.throws(
      () => fx.context.homeMediaActionTurns.subscribe(accepted.id, () => undefined),
      /subscription limit/i,
    );
    first();
    const terminalEvents: string[] = [];
    const second = fx.context.homeMediaActionTurns.subscribe(accepted.id, (event) => terminalEvents.push(event.type));
    fx.agent.gate!.resolve();
    await settle();
    assert.deepEqual(terminalEvents, ["accepted", "clarification"]);
    second();
  } finally {
    await fx.context.fiber.dispose();
  }
});

test("waits for the media action owner to revoke and close during Cordis disposal", async () => {
  const fx = fixture({ gate: new Deferred<void>() });
  let storeClosed = false;
  const originalClose = fx.store.close.bind(fx.store);
  Object.assign(fx.store, { close: () => { storeClosed = true; originalClose(); } });
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store,
    agent: fx.agent,
    conversation: fx.conversation,
    reviewCenter: fx.reviewCenter,
    clock: () => NOW,
  });
  const accepted = await fx.context.homeMediaActionTurns.start({
    question: "播放爵士",
    actor: ACTOR,
    idempotencyKey: KEY_A,
  });
  const events: string[] = [];
  fx.context.homeMediaActionTurns.subscribe(accepted.id, (event) => events.push(event.type));

  await fx.context.fiber.dispose();

  assert.equal(storeClosed, true, "root disposal must not return before the action store closes");
  assert.deepEqual(events, ["accepted", "cancelled"]);
  fx.agent.gate!.resolve();
  await settle();
});

test("rejects degraded models and busy agents before durable acceptance", async () => {
  const fx = fixture();
  fx.agent.modelStatus = { state: "degraded" };
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store, agent: fx.agent, conversation: fx.conversation, reviewCenter: fx.reviewCenter, clock: () => NOW,
  });
  try {
    await assert.rejects(
      fx.context.homeMediaActionTurns.start({ question: "播放爵士", actor: ACTOR, idempotencyKey: KEY_A }),
      (error: unknown) => error instanceof HomeMediaActionTurnUnavailableError && error.code === "model_unavailable",
    );
    fx.agent.modelStatus = { state: "active" };
    fx.agent.observationStatus = "running";
    await assert.rejects(
      fx.context.homeMediaActionTurns.start({ question: "播放古典乐", actor: ACTOR, idempotencyKey: KEY_B }),
      (error: unknown) => error instanceof HomeMediaActionTurnUnavailableError && error.code === "agent_busy",
    );
    assert.equal(fx.store.recoverable().length, 0);
  } finally {
    await fx.context.fiber.dispose();
  }
});

test("opens the durable-store circuit when a new turn cannot be accepted atomically", async () => {
  const fx = fixture();
  Object.assign(fx.store, {
    begin: () => { throw new Error("sqlite disk full"); },
  });
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store,
    agent: fx.agent,
    conversation: fx.conversation,
    reviewCenter: fx.reviewCenter,
    clock: () => NOW,
  });
  try {
    await assert.rejects(
      fx.context.homeMediaActionTurns.start({ question: "播放爵士", actor: ACTOR, idempotencyKey: KEY_A }),
      (error: unknown) => error instanceof HomeMediaActionTurnUnavailableError && error.code === "unavailable",
    );
    assert.deepEqual(fx.context.homeMediaActionTurns.availability(), { status: "unavailable" });
    assert.equal(fx.agent.calls.length, 0);
  } finally {
    await fx.context.fiber.dispose();
  }
});

test("treats malformed external turn ids as absent without tripping the durable-store circuit", async () => {
  const fx = fixture();
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store,
    agent: fx.agent,
    conversation: fx.conversation,
    reviewCenter: fx.reviewCenter,
    clock: () => NOW,
  });
  try {
    let notified = false;
    assert.equal(fx.context.homeMediaActionTurns.get("!"), undefined);
    assert.deepEqual(fx.context.homeMediaActionTurns.events("!"), []);
    const unsubscribe = fx.context.homeMediaActionTurns.subscribe("!", () => { notified = true; });
    unsubscribe();
    assert.equal(notified, false);
    assert.equal(fx.context.homeMediaActionTurns.cancel("!"), false);
    assert.deepEqual(fx.context.homeMediaActionTurns.availability(), { status: "ready" });

    const accepted = await fx.context.homeMediaActionTurns.start({
      question: "播放爵士",
      actor: ACTOR,
      idempotencyKey: KEY_A,
    });
    assert.equal(accepted.status, "running");
    await settle();
  } finally {
    await fx.context.fiber.dispose();
  }
});

test("revokes an active actor scope when a valid turn read trips the durable-store circuit", async () => {
  const fx = fixture({ gate: new Deferred<void>() });
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store,
    agent: fx.agent,
    conversation: fx.conversation,
    reviewCenter: fx.reviewCenter,
    clock: () => NOW,
  });
  try {
    const accepted = await fx.context.homeMediaActionTurns.start({
      question: "播放爵士",
      actor: ACTOR,
      idempotencyKey: KEY_A,
    });
    const originalGet = fx.store.get.bind(fx.store);
    let breakNextRead = true;
    Object.assign(fx.store, {
      get: (id: string) => {
        if (breakNextRead) {
          breakNextRead = false;
          throw new Error("runtime sqlite corruption");
        }
        return originalGet(id);
      },
    });

    assert.equal(fx.context.homeMediaActionTurns.get(accepted.id), undefined);
    assert.equal(fx.agent.calls[0]?.signal.aborted, true, "the mutable actor scope must be revoked immediately");
    assert.deepEqual(fx.context.homeMediaActionTurns.availability(), { status: "unavailable" });
    fx.agent.gate!.resolve();
    await settle();
    assert.equal(fx.reviewCenter.byRequest.size, 0);
    assert.equal(originalGet(accepted.id)?.status, "failed");
  } finally {
    await fx.context.fiber.dispose();
  }
});

test("keeps the product owner alive but unavailable when durable recovery is corrupt", async () => {
  const fx = fixture();
  Object.assign(fx.store, {
    recoverable: () => { throw new Error("corrupt media action row"); },
  });
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store,
    agent: fx.agent,
    conversation: fx.conversation,
    reviewCenter: fx.reviewCenter,
    clock: () => NOW,
  });
  try {
    await settle();
    assert.deepEqual(fx.context.homeMediaActionTurns.availability(), { status: "unavailable" });
    await assert.rejects(
      fx.context.homeMediaActionTurns.start({ question: "播放爵士", actor: ACTOR, idempotencyKey: KEY_A }),
      (error: unknown) => error instanceof HomeMediaActionTurnUnavailableError && error.code === "unavailable",
    );
  } finally {
    await fx.context.fiber.dispose();
  }
});

test("fails closed without an unhandled rejection when persistence breaks during background completion", async () => {
  const fx = fixture({ gate: new Deferred<void>() });
  await fx.context.plugin(HomeMediaActionTurnService, {
    store: fx.store,
    agent: fx.agent,
    conversation: fx.conversation,
    reviewCenter: fx.reviewCenter,
    clock: () => NOW,
  });
  const accepted = await fx.context.homeMediaActionTurns.start({
    question: "播放爵士",
    actor: ACTOR,
    idempotencyKey: KEY_A,
  });
  const originalGet = fx.store.get.bind(fx.store);
  let breakReads = true;
  Object.assign(fx.store, {
    get: (id: string) => {
      if (breakReads) throw new Error("runtime sqlite corruption");
      return originalGet(id);
    },
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    fx.agent.gate!.resolve();
    await settle();
    assert.deepEqual(unhandled, []);
    assert.deepEqual(fx.context.homeMediaActionTurns.availability(), { status: "unavailable" });
    await assert.rejects(
      fx.context.homeMediaActionTurns.start({ question: "播放古典乐", actor: ACTOR, idempotencyKey: KEY_B }),
      (error: unknown) => error instanceof HomeMediaActionTurnUnavailableError && error.code === "unavailable",
    );
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    breakReads = false;
    assert.equal(originalGet(accepted.id)?.status, "clarification");
    await fx.context.fiber.dispose();
  }
});
