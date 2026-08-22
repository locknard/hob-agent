import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

import type { OneShotActionActor, OneShotActionResult } from "../authority/one-shot-action-plane.js";

interface ConversationModule {
  readonly HomeMediaConversationService: new (ctx: Context, options?: Record<string, unknown>) => Service;
  readonly MEDIA_QUEUE_MODES: readonly string[];
  readonly MEDIA_CLARIFICATION_SLOTS: readonly string[];
}

async function loadModule(): Promise<ConversationModule> {
  try {
    const loaded = await import("./home-media-conversation-service.js") as unknown as Partial<ConversationModule>;
    if (typeof loaded.HomeMediaConversationService !== "function"
      || !Array.isArray(loaded.MEDIA_QUEUE_MODES)
      || !Array.isArray(loaded.MEDIA_CLARIFICATION_SLOTS)) {
      throw new Error("home media conversation exports are incomplete");
    }
    return loaded as ConversationModule;
  } catch (error) {
    assert.fail(`home media conversation implementation is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const actor: OneShotActionActor = {
  principalId: "adult-1",
  role: "adult_member",
  present: true,
  device: { kind: "private", boundPrincipalId: "adult-1" },
};

class StubCatalog extends Service {
  readonly calls: unknown[] = [];

  constructor(ctx: Context) { super(ctx, "homeMediaCatalog"); }

  async search(input: unknown) {
    this.calls.push(input);
    return {
      coverage: "complete" as const,
      candidates: [
        {
          mediaRef: "opaqueMediaRef0001",
          title: "晚间爵士",
          kind: "playlist",
          sourceLabel: "家庭音乐库",
          playable: true,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        {
          mediaRef: "opaqueMediaRef0002",
          title: "清晨爵士",
          kind: "playlist",
          sourceLabel: "家庭音乐库",
          playable: true,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      ],
    };
  }
}

class EmptyCatalog extends Service {
  constructor(ctx: Context) { super(ctx, "homeMediaCatalog"); }
  async search() {
    return { coverage: "complete" as const, candidates: [] };
  }
}

class UnplayableCatalog extends Service {
  constructor(ctx: Context) { super(ctx, "homeMediaCatalog"); }
  async search() {
    return {
      coverage: "complete" as const,
      candidates: [{
        mediaRef: "opaqueMediaRef0001",
        title: "不可直接播放的爵士",
        kind: "genre",
        sourceLabel: "家庭音乐库",
        playable: false,
      }],
    };
  }
}

class StubPreparation extends Service {
  readonly calls: unknown[] = [];
  result: unknown;

  constructor(ctx: Context) {
    super(ctx, "homeMediaPlaybackPreparation");
    this.result = undefined;
  }

  prepare(input: unknown) {
    this.calls.push(input);
    const intent = input as {
      readonly playerHwCapabilityId: string;
      readonly mediaRef: string;
      readonly queueMode: string;
    };
    const prepared = {
      status: "requires_confirmation" as const,
      intent: { kind: "play_media" as const, ...intent },
      player: {
        hwCapabilityId: intent.playerHwCapabilityId,
        displayLabel: "多媒体室音响",
        spaces: [{ hwSpaceId: "space-media", name: "多媒体室" }],
        playbackState: "idle" as const,
        volume: { reported: true as const, level: 0.2 },
      },
      media: {
        title: "晚间爵士",
        kind: "playlist" as const,
        sourceLabel: "家庭音乐库",
        playable: true as const,
      },
    };
    return this.result ?? prepared;
  }
}

class StubReviewCenter extends Service {
  readonly requests: unknown[] = [];
  readonly approvals: unknown[] = [];
  policyClass: "direct" | "confirmation" | "administrator" = "confirmation";
  private readonly tickets: Record<string, unknown>[] = [];

  constructor(ctx: Context) { super(ctx, "homeReviewCenter"); }

  async requestAction(input: Record<string, unknown>): Promise<OneShotActionResult> {
    this.requests.push(input);
    const ticket = {
      id: "media-ticket-1",
      requestId: input.requestId,
      capabilityId: input.capabilityId,
      summary: input.summary,
      action: input.action,
      policyClass: this.policyClass,
      reversible: true,
      status: this.policyClass === "direct" ? "verified" : "pending_confirmation",
      requestedAt: "2026-08-22T00:00:00.000Z",
      initiator: input.actor,
    } as Record<string, unknown>;
    this.tickets.push(ticket);
    return { status: ticket.status as OneShotActionResult["status"], ticket: ticket as never };
  }

  listActionTickets() { return this.tickets; }

  async approveRuntimeConfirmation(input: Record<string, unknown>) {
    this.approvals.push(input);
    const ticket = this.tickets.find((item) => item.id === input.confirmationId)!;
    ticket.status = "verified";
    return { status: "approved" as const, confirmation: { id: ticket.id } };
  }
}

test("returns a closed clarification state for every missing media slot", async () => {
  const { HomeMediaConversationService, MEDIA_CLARIFICATION_SLOTS } = await loadModule();
  assert.deepEqual(MEDIA_CLARIFICATION_SLOTS, ["query", "mediaRef", "playerCapabilityId", "queueMode"]);
  const ctx = new Context();
  await ctx.plugin(StubCatalog);
  await ctx.plugin(StubPreparation);
  await ctx.plugin(StubReviewCenter);
  const fiber = await ctx.plugin(HomeMediaConversationService);
  try {
    const service = ctx.homeMediaConversation as unknown as {
      request(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    const queryMissing = await service.request({ requestId: "media-request-query" });
    assert.deepEqual(queryMissing, {
      status: "clarification",
      slot: "query",
      reason: "missing",
      options: [],
    });
    const mediaMissing = await service.request({ requestId: "media-request-media", query: "爵士" });
    assert.equal(mediaMissing.status, "clarification");
    assert.equal(mediaMissing.slot, "mediaRef");
    assert.equal(mediaMissing.reason, "ambiguous");
    assert.deepEqual(
      (mediaMissing.options as Array<Record<string, unknown>>).map((option) => option.mediaRef),
      ["opaqueMediaRef0001", "opaqueMediaRef0002"],
    );
    const playerMissing = await service.request({
      requestId: "media-request-player",
      query: "爵士",
      mediaRef: "opaqueMediaRef0001",
    });
    assert.deepEqual(playerMissing, {
      status: "clarification",
      slot: "playerCapabilityId",
      reason: "missing",
      options: [],
    });
    const queueMissing = await service.request({
      requestId: "media-request-queue",
      query: "爵士",
      mediaRef: "opaqueMediaRef0001",
      playerCapabilityId: "hwc-media-room",
    });
    assert.equal(queueMissing.status, "clarification");
    assert.equal(queueMissing.slot, "queueMode");
    assert.deepEqual(
      (queueMissing.options as Array<Record<string, unknown>>).map((option) => option.queueMode),
      ["replace_and_play", "play_next", "add_to_queue"],
    );
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("passes the exact opaque mediaRef, player capability and queueMode through preparation into one action ticket", async () => {
  const { HomeMediaConversationService } = await loadModule();
  const ctx = new Context();
  await ctx.plugin(StubCatalog);
  await ctx.plugin(StubPreparation);
  await ctx.plugin(StubReviewCenter);
  const fiber = await ctx.plugin(HomeMediaConversationService);
  try {
    const service = ctx.homeMediaConversation as unknown as {
      requestAction(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    const result = await service.requestAction({
      requestId: "media-request-exact",
      mediaRef: "opaqueMediaRef0001",
      playerCapabilityId: "hwc-media-room",
      queueMode: "play_next",
      actor,
    });
    assert.equal(result.status, "pending_confirmation");
    assert.equal(result.ticketId, "media-ticket-1");
    assert.deepEqual((ctx.homeMediaPlaybackPreparation as unknown as StubPreparation).calls, [{
      kind: "play_media",
      playerHwCapabilityId: "hwc-media-room",
      mediaRef: "opaqueMediaRef0001",
      queueMode: "play_next",
    }]);
    const action = ((ctx.homeReviewCenter as unknown as StubReviewCenter).requests[0] as { action: Record<string, unknown> }).action;
    assert.deepEqual(action, {
      kind: "play_media",
      mediaRef: "opaqueMediaRef0001",
      queueMode: "play_next",
    });
    assert.equal((ctx.homeReviewCenter as unknown as StubReviewCenter).requests[0]?.capabilityId, "hwc-media-room");
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("returns no-match and not-playable as closed media clarification reasons", async () => {
  const { HomeMediaConversationService } = await loadModule();
  for (const Catalog of [EmptyCatalog, UnplayableCatalog]) {
    const ctx = new Context();
    await ctx.plugin(Catalog);
    await ctx.plugin(StubPreparation);
    await ctx.plugin(StubReviewCenter);
    const fiber = await ctx.plugin(HomeMediaConversationService);
    try {
      const service = ctx.homeMediaConversation as unknown as {
        request(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      };
      const result = await service.request({ requestId: `media-request-${Catalog.name}`, query: "爵士" });
      assert.equal(result.status, "clarification");
      assert.equal(result.slot, "mediaRef");
      assert.equal(result.reason, Catalog === EmptyCatalog ? "no_match" : "not_playable");
      assert.deepEqual(result.options, []);
    } finally {
      await fiber.dispose();
      await ctx.fiber.dispose();
    }
  }
});

test("fails closed when preparation changes the exact intent or omits its player projection", async () => {
  const { HomeMediaConversationService } = await loadModule();
  const ctx = new Context();
  await ctx.plugin(StubCatalog);
  await ctx.plugin(StubPreparation);
  await ctx.plugin(StubReviewCenter);
  (ctx.homeMediaPlaybackPreparation as unknown as StubPreparation).result = {
    status: "requires_confirmation",
    intent: {
      kind: "play_media",
      playerHwCapabilityId: "hwc-other-room",
      mediaRef: "opaqueMediaRef0001",
      queueMode: "play_next",
    },
    media: { playable: true },
  };
  const fiber = await ctx.plugin(HomeMediaConversationService);
  try {
    const service = ctx.homeMediaConversation as unknown as {
      request(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    const result = await service.request({
      requestId: "media-request-malformed-preparation",
      mediaRef: "opaqueMediaRef0001",
      playerCapabilityId: "hwc-media-room",
      queueMode: "play_next",
      actor,
    });
    assert.deepEqual(result, { status: "blocked", reason: "invalid_preparation" });
    assert.deepEqual((ctx.homeReviewCenter as unknown as StubReviewCenter).requests, []);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("uses the existing action-ticket owner for click and spoken confirmation without creating a second state machine", async () => {
  const { HomeMediaConversationService } = await loadModule();
  const ctx = new Context();
  await ctx.plugin(StubCatalog);
  await ctx.plugin(StubPreparation);
  await ctx.plugin(StubReviewCenter);
  const fiber = await ctx.plugin(HomeMediaConversationService);
  try {
    const service = ctx.homeMediaConversation as unknown as {
      request(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      confirm(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    await service.request({
      requestId: "media-request-confirm",
      mediaRef: "opaqueMediaRef0001",
      playerCapabilityId: "hwc-media-room",
      queueMode: "replace_and_play",
      actor,
    });
    const click = await service.confirm({
      ticketId: "media-ticket-1",
      channel: "click",
      actor,
    });
    assert.equal(click.status, "verified");
    const spoken = await service.confirm({
      ticketId: "media-ticket-1",
      channel: "spoken",
      actor: { ...actor, authenticated: true },
    });
    assert.equal(spoken.status, "blocked");
    assert.equal(spoken.reason, "ticket_not_pending");
    const ordinaryText = await service.confirm({
      ticketId: "media-ticket-1",
      channel: "spoken",
    });
    assert.equal(ordinaryText.status, "blocked");
    assert.equal(ordinaryText.reason, "authenticated_private_actor_required");
    const sharedVoice = await service.confirm({
      ticketId: "media-ticket-1",
      channel: "spoken",
      actor: { ...actor, authenticated: true, device: { kind: "shared" } },
    });
    assert.equal(sharedVoice.status, "blocked");
    assert.equal(sharedVoice.reason, "authenticated_private_actor_required");
    assert.deepEqual((ctx.homeReviewCenter as unknown as StubReviewCenter).approvals, [{
      confirmationId: "media-ticket-1",
      actor,
    }]);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("accepts spoken confirmation only with the exact ticket and authenticated private actor", async () => {
  const { HomeMediaConversationService } = await loadModule();
  const ctx = new Context();
  await ctx.plugin(StubCatalog);
  await ctx.plugin(StubPreparation);
  await ctx.plugin(StubReviewCenter);
  const fiber = await ctx.plugin(HomeMediaConversationService);
  try {
    const service = ctx.homeMediaConversation as unknown as {
      request(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      confirm(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    await service.request({
      requestId: "media-request-spoken",
      mediaRef: "opaqueMediaRef0001",
      playerCapabilityId: "hwc-media-room",
      queueMode: "play_next",
      actor,
    });
    const approved = await service.confirm({
      ticketId: "media-ticket-1",
      channel: "spoken",
      actor: { ...actor, authenticated: true },
    });
    assert.equal(approved.status, "verified");
    const wrongTicket = await service.confirm({
      ticketId: "media-ticket-2",
      channel: "spoken",
      actor: { ...actor, authenticated: true },
    });
    assert.deepEqual(wrongTicket, { status: "blocked", reason: "ticket_not_found" });
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("direct policy returns the verified owner result and does not create a local confirmation state", async () => {
  const { HomeMediaConversationService } = await loadModule();
  const ctx = new Context();
  await ctx.plugin(StubCatalog);
  await ctx.plugin(StubPreparation);
  await ctx.plugin(StubReviewCenter);
  (ctx.homeReviewCenter as unknown as StubReviewCenter).policyClass = "direct";
  const fiber = await ctx.plugin(HomeMediaConversationService);
  try {
    const service = ctx.homeMediaConversation as unknown as {
      request(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    const result = await service.request({
      requestId: "media-request-direct",
      mediaRef: "opaqueMediaRef0001",
      playerCapabilityId: "hwc-media-room",
      queueMode: "replace_and_play",
      actor,
    });
    assert.equal(result.status, "verified");
    assert.equal("confirmations" in service, false);
    assert.equal("pending" in service, false);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("blocks a scheduled request action when no request actor scope exists", async () => {
  const { HomeMediaConversationService } = await loadModule();
  const ctx = new Context();
  await ctx.plugin(StubCatalog);
  await ctx.plugin(StubPreparation);
  await ctx.plugin(StubReviewCenter);
  const fiber = await ctx.plugin(HomeMediaConversationService);
  try {
    const service = ctx.homeMediaConversation as unknown as {
      requestAction(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    const result = await service.requestAction({
      requestId: "media-request-scheduled",
      mediaRef: "opaqueMediaRef0001",
      playerCapabilityId: "hwc-media-room",
      queueMode: "play_next",
    });
    assert.deepEqual(result, { status: "blocked", reason: "authenticated_actor_required" });
    assert.deepEqual((ctx.homeReviewCenter as unknown as StubReviewCenter).requests, []);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("keeps concurrent request actor scopes isolated", async () => {
  const { HomeMediaConversationService } = await loadModule();
  const ctx = new Context();
  await ctx.plugin(StubCatalog);
  await ctx.plugin(StubPreparation);
  await ctx.plugin(StubReviewCenter);
  const fiber = await ctx.plugin(HomeMediaConversationService);
  try {
    const service = ctx.homeMediaConversation as unknown as {
      requestAction(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      runWithActor<T>(actor: OneShotActionActor, callback: () => T | PromiseLike<T>): T | PromiseLike<T>;
    };
    const actorA: OneShotActionActor = {
      principalId: "adult-a",
      role: "adult_member",
      present: true,
      device: { kind: "private", boundPrincipalId: "adult-a" },
    };
    const actorB: OneShotActionActor = {
      principalId: "adult-b",
      role: "adult_member",
      present: true,
      device: { kind: "private", boundPrincipalId: "adult-b" },
    };
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const request = (requestId: string) => service.requestAction({
      requestId,
      mediaRef: "opaqueMediaRef0001",
      playerCapabilityId: "hwc-media-room",
      queueMode: "play_next",
    });
    const first = service.runWithActor(actorA, async () => {
      await firstGate;
      return request("media-request-a");
    });
    const second = service.runWithActor(actorB, () => request("media-request-b"));
    releaseFirst();
    await Promise.all([first, second]);
    const byRequest = new Map(
      (ctx.homeReviewCenter as unknown as StubReviewCenter).requests.map((item) => [
        String((item as { requestId: unknown }).requestId),
        (item as { actor: OneShotActionActor }).actor.principalId,
      ]),
    );
    assert.deepEqual(Object.fromEntries(byRequest), {
      "media-request-a": "adult-a",
      "media-request-b": "adult-b",
    });
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});
