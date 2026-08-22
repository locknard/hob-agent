import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

import { HouseholdReviewCenterService } from "./household-review-center-service.js";
import type { OneShotActionGateway, OneShotActionPolicy } from "./authority/one-shot-action-plane.js";

const NOW = "2026-08-21T00:00:00.000Z";

class StubHomeWorld extends Service {
  mediaExecutionCalls = 0;
  policyClass: "direct" | "confirmation" | "administrator" = "direct";
  lastSuccessfulContactAt = NOW;

  constructor(ctx: Context) {
    super(ctx, "homeWorld");
  }

  snapshot() {
    return {
      generatedAt: NOW,
      bridges: { "bridge-a": {
        diagnostics: { lastSuccessfulContactAt: this.lastSuccessfulContactAt },
        metrics: { connection: "up", consistency: "ready", eventActivity: "active" },
      } },
      watermarkVector: {},
      bridgeWatermarks: [],
      watermarks: [],
      diagnostics: [],
      metrics: { consistency: [], eventActivity: [], connectionActivity: [] },
      spaces: [],
      devices: [{
        bridgeId: "bridge-a",
        hwId: "hw-media",
        nativeId: "native-media",
        bindings: [],
        capabilities: [{
          hwCapabilityId: "media-capability",
          hwId: "hw-media",
          schema: "media@1",
          schemaVersion: "1.0.0",
          semanticKind: "media",
          bindings: [{ bridgeId: "bridge-a", nativeId: "native-media", nativeInstanceId: "media-instance" }],
        }],
        descriptor: {} as never,
        states: [{
          nativeId: "native-media",
          nativeInstanceId: "media-instance",
          attrs: { state: "on" },
          time: { sourceTsQuality: "none" },
          origin: "observed",
        }],
        validity: "valid",
      }],
    };
  }

  resolveActionAuthority() { return { status: "available" as const, policyClass: this.policyClass }; }

  actionDescriptorFor(capabilityId: string) {
    return capabilityId === "media-capability"
      ? {
          action: { kind: "set_boolean" as const, value: false },
          reversible: true,
          label: "媒体设备",
        }
      : undefined;
  }

  async executeOneShotAction() {
    this.mediaExecutionCalls += 1;
    return { status: "rejected" as const, reason: "unsupported" as const };
  }
}

class StubMediaPlayback extends Service {
  current: string | null = null;
  readonly gateway = {
    readState: async () => ({
      status: "available" as const,
      value: this.current,
      observedAt: NOW,
      fresh: true as const,
    }),
    execute: async (input: { readonly action: { readonly kind: string; readonly mediaRef?: string } }) => {
      this.current = input.action.kind === "play_media" ? input.action.mediaRef ?? null : null;
      return { status: "acknowledged" as const };
    },
  };

  constructor(ctx: Context) {
    super(ctx, "homeMediaPlayback");
  }
}

const actor = {
  principalId: "member-1",
  role: "adult_member" as const,
  present: true,
  device: { kind: "private" as const, boundPrincipalId: "member-1" },
};

function confirmationFixture() {
  let current = false;
  const gateway: OneShotActionGateway = {
    readState: async () => ({ status: "available", value: current, observedAt: NOW, fresh: true }),
    execute: async ({ action }) => {
      if (action.kind === "set_boolean") current = action.value;
      return { status: "acknowledged" };
    },
  };
  const policy: OneShotActionPolicy = {
    evaluate: () => ({ status: "allowed", policyClass: "confirmation", reversible: true, ttlMs: 10_000 }),
  };
  return { gateway, policy };
}

test("uses one action ticket as the runtime confirmation card", async () => {
  const context = new Context();
  const fixture = confirmationFixture();
  await context.plugin(StubHomeWorld);
  await context.plugin(HouseholdReviewCenterService, {
    path: ":memory:",
    gateway: fixture.gateway,
    policy: fixture.policy,
    now: () => NOW,
    idFactory: (() => {
      let next = 0;
      return () => `review-${++next}`;
    })(),
    verificationWindowMs: 1,
    sleep: async () => undefined,
  });

  try {
    const service = context.homeReviewCenter;
    const requested = await service.requestAction({
      requestId: "front-door:unlock",
      capabilityId: "front-door-lock",
      summary: "打开前门锁",
      action: { kind: "set_boolean", value: false },
      actor,
    });
    assert.equal(requested.status, "pending_confirmation");
    assert.deepEqual(service.counts(), { runtimeConfirmations: 1 });
    const confirmation = service.listRuntimeConfirmations()[0];
    assert.equal(confirmation?.id, requested.ticket.id);
    assert.equal(service.getRuntimeConfirmation(requested.ticket.id)?.actionSummary, "打开前门锁");

    const decision = service.rejectRuntimeConfirmation({
      confirmationId: requested.ticket.id,
      actor,
    });
    assert.equal(decision.status, "rejected");
    assert.deepEqual(service.counts(), { runtimeConfirmations: 0 });
    assert.equal(service.actionActivities().some((item) => item.kind === "confirmation_rejected"), true);
    const activity = service.activities();
    assert.equal(activity.length >= 3, true);
    assert.deepEqual(activity[0], {
      id: "review-4",
      at: NOW,
      title: "打开前门锁 · 已拒绝",
      actor: "家庭成员",
      attribution: "member",
      cause: ["家庭成员拒绝了本次动作", "动作已结束"],
      verification: "未执行",
    });
  } finally {
    await context.fiber.dispose();
  }
});

test("keeps an action unknown when the authoritative bridge contact is stale", async () => {
  const context = new Context();
  await context.plugin(StubHomeWorld);
  const world = context.get("homeWorld") as unknown as StubHomeWorld;
  world.lastSuccessfulContactAt = "2026-08-20T23:58:00.000Z";
  await context.plugin(HouseholdReviewCenterService, {
    path: ":memory:",
    now: () => NOW,
    stateFreshnessMaxAgeMs: 60_000,
  });
  try {
    const result = await context.homeReviewCenter.requestAction({
      requestId: "stale-contact",
      capabilityId: "media-capability",
      summary: "关闭媒体设备",
      action: { kind: "set_boolean", value: false },
      actor,
    });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "initial_state_unavailable");
    assert.equal(world.mediaExecutionCalls, 0);
  } finally {
    await context.fiber.dispose();
  }
});

test("closes the action-plane persistence port during Cordis disposal", async () => {
  let closed = false;
  const context = new Context();
  const fixture = confirmationFixture();
  await context.plugin(StubHomeWorld);
  await context.plugin(HouseholdReviewCenterService, {
    store: {
      load: () => undefined,
      save: () => undefined,
      close: () => { closed = true; },
    },
    gateway: fixture.gateway,
    policy: fixture.policy,
    now: () => NOW,
  });

  await context.fiber.dispose();
  assert.equal(closed, true);
  assert.equal(context.homeReviewCenter, undefined);
});

test("routes media execution and opaque read-back through the Music Assistant owner", async () => {
  const context = new Context();
  await context.plugin(StubHomeWorld);
  await context.plugin(StubMediaPlayback);
  await context.plugin(HouseholdReviewCenterService, {
    path: ":memory:",
    now: () => NOW,
    idFactory: (() => {
      let next = 0;
      return () => `media-review-${++next}`;
    })(),
    verificationWindowMs: 1,
    sleep: async () => undefined,
  });

  try {
    const requested = await context.homeReviewCenter.requestAction({
      requestId: "media-request-1",
      capabilityId: "media-capability",
      summary: "播放晚间爵士",
      action: { kind: "play_media", mediaRef: "opaqueMediaRef0001", queueMode: "replace_and_play" },
      actor: { ...actor, present: true },
    });
    assert.equal(requested.status, "verified");
    assert.equal((context.get("homeWorld") as unknown as StubHomeWorld).mediaExecutionCalls, 0);
    assert.equal((context.get("homeMediaPlayback") as unknown as StubMediaPlayback).current, "opaqueMediaRef0001");

    const stopped = await context.homeReviewCenter.requestAction({
      requestId: "media-request-2",
      capabilityId: "media-capability",
      summary: "停止播放",
      action: { kind: "stop_media" },
      actor: { ...actor, present: true },
    });
    assert.equal(stopped.status, "verified");
    assert.equal((context.get("homeMediaPlayback") as unknown as StubMediaPlayback).current, null);
  } finally {
    await context.fiber.dispose();
  }
});

test("uses the reviewed action policy class when semantic hints disagree", async () => {
  const context = new Context();
  await context.plugin(StubHomeWorld);
  const world = context.get("homeWorld") as unknown as StubHomeWorld;
  world.policyClass = "administrator";
  await context.plugin(HouseholdReviewCenterService, {
    path: ":memory:",
    now: () => NOW,
    gateway: {
      readState: async () => ({ status: "available", value: false, observedAt: NOW, fresh: true }),
      execute: async () => ({ status: "acknowledged" }),
    },
    verificationWindowMs: 1,
    sleep: async () => undefined,
  });

  try {
    const result = await context.homeReviewCenter.requestAction({
      requestId: "policy-class-over-semantic-kind",
      capabilityId: "media-capability",
      summary: "切换媒体设备",
      action: { kind: "set_boolean", value: true },
      actor,
    });
    assert.equal(result.status, "pending_confirmation");
    assert.equal(result.ticket.policyClass, "administrator");
  } finally {
    await context.fiber.dispose();
  }
});

test("exposes only explicit adapter action descriptors after authority resolution", async () => {
  const context = new Context();
  await context.plugin(StubHomeWorld);
  await context.plugin(HouseholdReviewCenterService, {
    path: ":memory:",
    actionDescriptorSource: {
      actionDescriptorFor: (capabilityId: string) => capabilityId === "media-capability"
        ? {
            action: { kind: "set_boolean", value: false },
            label: "媒体设备",
            actionLabel: "停止",
            summary: "停止媒体设备",
            value: "播放中",
          }
        : undefined,
    },
    gateway: {
      readState: async () => ({ status: "available", value: true, observedAt: NOW, fresh: true }),
      execute: async () => ({ status: "acknowledged" }),
    },
    now: () => NOW,
  });

  try {
    assert.deepEqual(context.homeReviewCenter.actionDescriptorFor("media-capability"), {
      action: { kind: "set_boolean", value: false },
      label: "媒体设备",
      actionLabel: "停止",
      summary: "停止媒体设备",
      value: "播放中",
      policyClass: "direct",
    });
    assert.equal(context.homeReviewCenter.actionDescriptorFor("unknown-capability"), undefined);
  } finally {
    await context.fiber.dispose();
  }
});

test("accepts the HomeWorld descriptor port as its explicit source", async () => {
  const context = new Context();
  await context.plugin(StubHomeWorld);
  await context.plugin(HouseholdReviewCenterService, {
    path: ":memory:",
    actionDescriptorSource: {
      actionDescriptorFor: (capabilityId: string) =>
        context.homeWorld.actionDescriptorFor(capabilityId),
    },
    gateway: {
      readState: async () => ({ status: "available", value: true, observedAt: NOW, fresh: true }),
      execute: async () => ({ status: "acknowledged" }),
    },
    now: () => NOW,
  });

  try {
    assert.deepEqual(context.homeReviewCenter.actionDescriptorFor("media-capability"), {
      action: { kind: "set_boolean", value: false },
      reversible: true,
      label: "媒体设备",
      policyClass: "direct",
    });
  } finally {
    await context.fiber.dispose();
  }
});
