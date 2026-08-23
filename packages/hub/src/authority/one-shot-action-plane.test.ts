import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryOneShotActionStore,
  OneShotActionPlane,
  SqliteOneShotActionStore,
  type OneShotActionActor,
  type OneShotActionGateway,
  type OneShotActionPolicy,
} from "./one-shot-action-plane.js";

const member: OneShotActionActor = {
  principalId: "member-1",
  role: "adult_member",
  present: true,
  device: { kind: "private", boundPrincipalId: "member-1" },
};
const admin: OneShotActionActor = {
  principalId: "admin-1",
  role: "admin",
  present: true,
  device: { kind: "private", boundPrincipalId: "admin-1" },
};
const sharedAdult: OneShotActionActor = {
  principalId: "member-1",
  role: "adult_member",
  present: true,
  device: { kind: "shared" },
};
const child: OneShotActionActor = {
  principalId: "child-1",
  role: "child",
  present: true,
  device: { kind: "private", boundPrincipalId: "child-1" },
};
const unboundAdult: OneShotActionActor = {
  principalId: "member-1",
  role: "adult_member",
  present: true,
  device: { kind: "private" },
};
const guest: OneShotActionActor = {
  principalId: "guest-1",
  role: "guest",
  present: true,
  device: { kind: "private", boundPrincipalId: "guest-1" },
};

function action(value: boolean) {
  return {
    kind: "set_boolean" as const,
    value,
  };
}

function fixture(options: {
  policyClass?: "direct" | "confirmation" | "administrator";
  ttlMs?: number;
  readStatus?: "available" | "unavailable";
  acknowledge?: "acknowledged" | "rejected" | "unknown";
  current?: boolean;
} = {}) {
  let current = options.current ?? false;
  let nowMs = 1_700_000_000_000;
  const executed: string[] = [];
  const gateway: OneShotActionGateway = {
    readState: async () => options.readStatus === "unavailable"
      ? { status: "unavailable", reason: "bridge_unavailable" }
      : { status: "available", value: current, observedAt: new Date(nowMs).toISOString(), fresh: true },
    execute: async ({ action: requested }) => {
      executed.push(requested.kind);
      if (options.acknowledge === "rejected") return { status: "rejected", reason: "failed" };
      if (options.acknowledge === "unknown") return { status: "unknown", reason: "timeout" };
      current = requested.kind === "set_boolean" ? requested.value : current;
      return { status: "acknowledged" };
    },
  };
  const policy: OneShotActionPolicy = {
    evaluate: ({ action: requested }) => ({
      status: "allowed",
      policyClass: options.policyClass ?? "direct",
      ttlMs: options.ttlMs ?? 10_000,
      reversible: requested.kind === "set_boolean",
    }),
  };
  const plane = new OneShotActionPlane({
    gateway,
    policy,
    store: new InMemoryOneShotActionStore(),
    now: () => new Date(nowMs).toISOString(),
    idFactory: (() => {
      let count = 0;
      return () => `ticket-${++count}`;
    })(),
    verificationWindowMs: 1,
    sleep: async () => undefined,
  });
  return {
    plane,
    gateway,
    executed,
    advance(ms: number) { nowMs += ms; },
    current: () => current,
  };
}

test("direct action is verified and offers a ten-second undo", async () => {
  const fixtureValue = fixture();
  const result = await fixtureValue.plane.request({
    requestId: "request-direct",
    capabilityId: "cap-light",
    action: action(true),
    actor: member,
  });

  assert.equal(result.status, "verified");
  assert.equal(result.ticket.status, "verified");
  assert.equal(result.undo?.status, "available");
  assert.equal(fixtureValue.current(), true);

  const undo = await fixtureValue.plane.undo({
    ticketId: result.ticket.id,
    actor: member,
  });
  assert.equal(undo.status, "verified");
  assert.equal(fixtureValue.current(), false);
  assert.deepEqual(fixtureValue.executed, ["set_boolean", "set_boolean"]);
  assert.equal(fixtureValue.plane.activities().some((item) => item.kind === "undo_requested"), true);
});

test("marks a persisted in-flight action unknown after restart and never executes it again", async () => {
  const store = new InMemoryOneShotActionStore();
  let releaseExecution: (() => void) | undefined;
  let executeCalls = 0;
  const first = new OneShotActionPlane({
    gateway: {
      readState: async () => ({ status: "available", value: false, observedAt: "2026-08-22T00:00:00.000Z", fresh: true }),
      execute: async () => {
        executeCalls += 1;
        await new Promise<void>((resolve) => { releaseExecution = resolve; });
        return { status: "acknowledged" };
      },
    },
    policy: { evaluate: () => ({ status: "allowed", policyClass: "direct", reversible: true }) },
    store,
    now: () => "2026-08-22T00:00:00.000Z",
    idFactory: (() => { let next = 0; return () => `restart-${++next}`; })(),
  });
  const pending = first.request({
    requestId: "restart-request",
    capabilityId: "restart-capability",
    action: action(true),
    actor: member,
  });
  while (executeCalls === 0) await new Promise<void>((resolve) => setImmediate(resolve));

  const restarted = new OneShotActionPlane({
    gateway: {
      readState: async () => ({ status: "available", value: false, observedAt: "2026-08-22T00:00:00.000Z", fresh: true }),
      execute: async () => { executeCalls += 1; return { status: "acknowledged" }; },
    },
    policy: { evaluate: () => ({ status: "allowed", policyClass: "direct", reversible: true }) },
    store,
    now: () => "2026-08-22T00:00:01.000Z",
    idFactory: (() => { let next = 100; return () => `restart-${++next}`; })(),
  });
  const replay = await restarted.request({
    requestId: "restart-request",
    capabilityId: "restart-capability",
    action: action(true),
    actor: member,
  });
  assert.equal(replay.status, "unknown");
  assert.equal(replay.reason, "interrupted_before_verification");
  assert.equal(executeCalls, 1);
  assert.equal(restarted.activities().at(-1)?.kind, "action_unknown");

  releaseExecution?.();
  await pending;
});

test("gives the gateway the neutral action while reading state", async () => {
  const reads: string[] = [];
  let current = false;
  const plane = new OneShotActionPlane({
    gateway: {
      readState: async ({ action }) => {
        reads.push(action?.kind ?? "missing");
        return { status: "available", value: current, observedAt: new Date().toISOString(), fresh: true };
      },
      execute: async ({ action: requested }) => {
        if (requested.kind === "set_boolean") current = requested.value;
        return { status: "acknowledged" };
      },
    },
    policy: { evaluate: () => ({ status: "allowed", policyClass: "direct", reversible: true }) },
    verificationWindowMs: 1,
    sleep: async () => undefined,
  });

  await plane.request({
    requestId: "action-context",
    capabilityId: "cap-light",
    action: action(true),
    actor: member,
  });
  assert.deepEqual(reads, ["set_boolean", "set_boolean", "set_boolean"]);
});

test("concurrent duplicate request ids coalesce into one durable execution", async () => {
  let releaseRead!: () => void;
  const readBlocked = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let readCalls = 0;
  let policyCalls = 0;
  let executeCalls = 0;
  let current = false;
  const plane = new OneShotActionPlane({
    gateway: {
      readState: async () => {
        readCalls += 1;
        if (readCalls === 1) await readBlocked;
        return { status: "available", value: current, observedAt: new Date().toISOString(), fresh: true };
      },
      execute: async ({ action: requested }) => {
        executeCalls += 1;
        if (requested.kind === "set_boolean") current = requested.value;
        return { status: "acknowledged" };
      },
    },
    policy: {
      evaluate: () => {
        policyCalls += 1;
        return { status: "allowed", policyClass: "direct", reversible: true };
      },
    },
    idFactory: (() => {
      let count = 0;
      return () => `coalesced-${++count}`;
    })(),
    verificationWindowMs: 1,
    sleep: async () => undefined,
  });
  const request = {
    requestId: "same-request-id",
    capabilityId: "cap-light",
    action: action(true),
    actor: member,
  } as const;
  const first = plane.request(request);
  await Promise.resolve();
  const second = plane.request(request);
  releaseRead();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, "verified");
  assert.equal(secondResult.status, "verified");
  assert.equal(firstResult.ticket.id, secondResult.ticket.id);
  assert.equal(policyCalls, 1);
  assert.equal(executeCalls, 1);
  assert.equal(plane.listTickets().length, 1);
});

test("confirmation waits for an eligible present member and expires fail-closed", async () => {
  const fixtureValue = fixture({ policyClass: "confirmation", ttlMs: 10 });
  const pending = await fixtureValue.plane.request({
    requestId: "request-confirmation",
    capabilityId: "cap-light",
    action: action(true),
    actor: member,
  });
  assert.equal(pending.status, "pending_confirmation");
  assert.equal(fixtureValue.executed.length, 0);
  assert.equal(fixtureValue.plane.canApprove(pending.ticket.id, member), true);
  assert.equal(fixtureValue.plane.canApprove(pending.ticket.id, child), true, "a child on their own bound phone confirms");
  assert.equal(fixtureValue.plane.canApprove(pending.ticket.id, sharedAdult), false, "a shared screen never confirms");

  const sharedRejectFixture = fixture({ policyClass: "confirmation", ttlMs: 10_000 });
  const sharedRejectPending = await sharedRejectFixture.plane.request({
    requestId: "request-shared-reject",
    capabilityId: "cap-light",
    action: action(true),
    actor: member,
  });
  assert.equal(sharedRejectPending.status, "pending_confirmation");
  const sharedRejected = sharedRejectFixture.plane.reject({ ticketId: sharedRejectPending.ticket.id, actor: sharedAdult });
  assert.equal(sharedRejected.status, "rejected", "any present entry may say no; rejection executes nothing");
  assert.equal(sharedRejected.ticket?.rejectedBy, sharedAdult.principalId);
  assert.equal(sharedRejected.ticket?.decidedVia, "shared", "the source device enters the record");
  const notPresentReject = fixture({ policyClass: "confirmation", ttlMs: 10_000 });
  const notPresentPending = await notPresentReject.plane.request({
    requestId: "request-absent-reject",
    capabilityId: "cap-light",
    action: action(true),
    actor: member,
  });
  assert.equal(notPresentReject.plane.reject({
    ticketId: notPresentPending.ticket.id,
    actor: { ...member, present: false },
  }).status, "denied", "absence still cannot decide anything");

  fixtureValue.advance(11);
  assert.equal(fixtureValue.plane.canApprove(pending.ticket.id, member), false);
  const expired = fixtureValue.plane.expireDue();
  assert.equal(expired.length, 1);
  assert.equal(expired[0]?.status, "expired");
  const approval = await fixtureValue.plane.approve({ ticketId: pending.ticket.id, actor: member });
  assert.deepEqual(approval, { status: "denied", reason: "expired", ticket: expired[0] });
  assert.equal(fixtureValue.executed.length, 0);
  assert.equal(fixtureValue.plane.activities().some((item) => item.kind === "confirmation_expired"), true);
  assert.deepEqual(fixtureValue.plane.consumeExpiredSummary(), {
    count: 1,
    ticketIds: [pending.ticket.id],
  });
  assert.equal(fixtureValue.plane.consumeExpiredSummary(), undefined);
});

test("runtime rejection closes one request without creating a persistent latch", async () => {
  const fixtureValue = fixture({ policyClass: "confirmation", ttlMs: 10_000 });
  const pending = await fixtureValue.plane.request({
    requestId: "request-rejected",
    capabilityId: "cap-light",
    action: action(true),
    actor: member,
  });
  assert.equal(pending.status, "pending_confirmation");
  const rejected = fixtureValue.plane.reject({ ticketId: pending.ticket.id, actor: member });
  assert.equal(rejected.status, "rejected");
  assert.equal(fixtureValue.executed.length, 0);
  const repeat = await fixtureValue.plane.approve({ ticketId: pending.ticket.id, actor: member });
  assert.equal(repeat.status, "denied");
  assert.equal(repeat.reason, "already_decided");
  assert.equal(fixtureValue.plane.activities().some((item) => item.kind === "confirmation_rejected"), true);
});

test("protected actions require a bound private device from any present member", async () => {
  const fixtureValue = fixture({ policyClass: "administrator", ttlMs: 10_000 });
  const pending = await fixtureValue.plane.request({
    requestId: "request-admin",
    capabilityId: "cap-water",
    action: action(true),
    actor: sharedAdult,
  });
  assert.equal(pending.status, "pending_confirmation");

  const denied = await fixtureValue.plane.approve({ ticketId: pending.ticket.id, actor: sharedAdult });
  assert.equal(denied.status, "denied");
  assert.equal(denied.reason, "unauthorized");
  assert.equal(fixtureValue.executed.length, 0);

  const approved = await fixtureValue.plane.approve({ ticketId: pending.ticket.id, actor: admin });
  assert.equal(approved.status, "verified");
  assert.equal(fixtureValue.executed.length, 1);

  const notPresent: OneShotActionActor = { ...member, present: false };
  const boundToOther: OneShotActionActor = { ...member, device: { kind: "private", boundPrincipalId: "someone-else" } };
  for (const [index, unauthorizedActor] of [sharedAdult, unboundAdult, notPresent, boundToOther].entries()) {
    const next = fixture({ policyClass: "administrator", ttlMs: 10_000 });
    const nextPending = await next.plane.request({
      requestId: `request-admin-${index + 2}`,
      capabilityId: "cap-water",
      action: action(true),
      actor: member,
    });
    assert.equal(nextPending.status, "pending_confirmation");
    const nextDenied = await next.plane.approve({ ticketId: nextPending.ticket.id, actor: unauthorizedActor });
    assert.equal(nextDenied.status, "denied");
    assert.equal(nextDenied.reason, "unauthorized");
    assert.equal(next.executed.length, 0);
  }

  const adultBoundFixture = fixture({ policyClass: "administrator", ttlMs: 10_000 });
  const adultPending = await adultBoundFixture.plane.request({
    requestId: "request-admin-adult",
    capabilityId: "cap-water",
    action: action(true),
    actor: member,
  });
  assert.equal(adultPending.status, "pending_confirmation");
  const adultApproved = await adultBoundFixture.plane.approve({ ticketId: adultPending.ticket.id, actor: member });
  assert.equal(adultApproved.status, "verified");

  for (const [index, eligibleActor] of [child, guest].entries()) {
    const next = fixture({ policyClass: "administrator", ttlMs: 10_000 });
    const nextPending = await next.plane.request({
      requestId: `request-admin-eligible-${index + 1}`,
      capabilityId: "cap-water",
      action: action(true),
      actor: member,
    });
    assert.equal(nextPending.status, "pending_confirmation");
    const nextApproved = await next.plane.approve({ ticketId: nextPending.ticket.id, actor: eligibleActor });
    assert.equal(nextApproved.status, "verified", "any present member on their own bound phone confirms a protected action");
  }
});

test("failed and unknown outcomes never expose undo", async () => {
  const failed = await fixture({ acknowledge: "rejected" }).plane.request({
    requestId: "request-failed",
    capabilityId: "cap-light",
    action: action(true),
    actor: member,
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.undo, undefined);

  const unknown = await fixture({ acknowledge: "unknown" }).plane.request({
    requestId: "request-unknown",
    capabilityId: "cap-light",
    action: action(true),
    actor: member,
  });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.undo, undefined);

  const unreadable = await fixture({ readStatus: "unavailable" }).plane.request({
    requestId: "request-unreadable",
    capabilityId: "cap-light",
    action: action(true),
    actor: member,
  });
  assert.equal(unreadable.status, "unknown");
  assert.equal(unreadable.undo, undefined);
});

test("the ten-second undo window fails closed after it expires", async () => {
  const fixtureValue = fixture();
  const result = await fixtureValue.plane.request({
    requestId: "request-undo-expiry",
    capabilityId: "cap-light",
    action: action(true),
    actor: member,
  });
  assert.equal(result.status, "verified");
  fixtureValue.advance(10_001);
  const expired = await fixtureValue.plane.undo({ ticketId: result.ticket.id, actor: member });
  assert.equal(expired.status, "failed");
  assert.equal(expired.reason, "undo_expired");
  assert.equal(fixtureValue.executed.length, 1);
  assert.equal(expired.ticket.undoStatus, "expired");
});

test("level read-back uses a bounded tolerance and restores the captured level", async () => {
  let current = 0.2;
  const executed: number[] = [];
  const plane = new OneShotActionPlane({
    gateway: {
      readState: async () => ({ status: "available", value: current, observedAt: new Date().toISOString(), fresh: true }),
      execute: async ({ action: requested }) => {
        if (requested.kind === "set_level") {
          current = requested.level;
          executed.push(current);
        }
        return { status: "acknowledged" };
      },
    },
    policy: { evaluate: () => ({ status: "allowed", policyClass: "direct", reversible: true }) },
    idFactory: (() => {
      let count = 0;
      return () => `level-${++count}`;
    })(),
    verificationWindowMs: 1,
    sleep: async () => undefined,
  });
  const result = await plane.request({
    requestId: "request-level",
    capabilityId: "cap-cover",
    action: { kind: "set_level", level: 0.75 },
    actor: member,
  });
  assert.equal(result.status, "verified");
  assert.equal(result.undo?.inverseAction.kind, "set_level");
  const undo = await plane.undo({ ticketId: result.ticket.id, actor: member });
  assert.equal(undo.status, "verified");
  assert.deepEqual(executed, [0.75, 0.2]);
  assert.equal(current, 0.2);
});

test("prepared media playback verifies and exposes a stop-media undo", async () => {
  let current: string | null = "old-media-reference";
  const plane = new OneShotActionPlane({
    gateway: {
      readState: async () => ({ status: "available", value: current, observedAt: new Date().toISOString(), fresh: true }),
      execute: async ({ action: requested }) => {
        if (requested.kind === "play_media") current = requested.mediaRef;
        if (requested.kind === "stop_media") current = null;
        return { status: "acknowledged" };
      },
    },
    policy: { evaluate: () => ({ status: "allowed", policyClass: "direct", reversible: true }) },
    idFactory: (() => {
      let count = 0;
      return () => `media-${++count}`;
    })(),
    verificationWindowMs: 1,
    sleep: async () => undefined,
  });
  const result = await plane.request({
    requestId: "request-media",
    capabilityId: "cap-player",
    action: {
      kind: "play_media",
      mediaRef: "prepared-media-0001",
      queueMode: "replace_and_play",
    },
    actor: member,
  });
  assert.equal(result.status, "verified");
  assert.equal(result.undo?.inverseAction.kind, "stop_media");
  assert.equal(current, "prepared-media-0001");
  const undo = await plane.undo({ ticketId: result.ticket.id, actor: member });
  assert.equal(undo.status, "verified");
  assert.equal(undo.ticket.action.kind, "stop_media");
  assert.equal(current, null);
});

test("read-back stops at the verification deadline even when the bridge stays unavailable", async () => {
  let nowMs = 1_700_000_000_000;
  let readCalls = 0;
  let slept = 0;
  const plane = new OneShotActionPlane({
    gateway: {
      readState: async () => {
        readCalls += 1;
        return readCalls <= 2
          ? { status: "available", value: false, observedAt: new Date(nowMs).toISOString(), fresh: true }
          : { status: "unavailable", reason: "bridge_unavailable" };
      },
      execute: async () => ({ status: "acknowledged" }),
    },
    policy: { evaluate: () => ({ status: "allowed", policyClass: "direct", reversible: true }) },
    now: () => nowMs,
    verificationWindowMs: 10,
    verificationPollMs: 5,
    maxVerificationReads: 100,
    sleep: async (delayMs) => {
      slept += 1;
      nowMs += delayMs;
    },
    idFactory: (() => {
      let count = 0;
      return () => `deadline-${++count}`;
    })(),
  });
  const result = await plane.request({
    requestId: "request-deadline",
    capabilityId: "cap-light",
    action: action(true),
    actor: member,
  });
  assert.equal(result.status, "unknown");
  assert.equal(readCalls, 4);
  assert.equal(slept, 2);
});

test("undo re-enters policy and refuses when the latest state changed", async () => {
  let evaluations = 0;
  const fixtureValue = fixture();
  const policy: OneShotActionPolicy = {
    evaluate: ({ action: requested }) => {
      evaluations += 1;
      return {
        status: evaluations === 2 ? "denied" : "allowed",
        policyClass: "direct",
        reversible: requested.kind === "set_boolean",
        ...(evaluations === 2 ? { reason: "undo_requires_fresh_authority" } : {}),
      };
    },
  };
  const plane = new OneShotActionPlane({
    gateway: fixtureValue.gateway,
    policy,
    store: new InMemoryOneShotActionStore(),
    now: () => new Date(1_700_000_000_000).toISOString(),
    idFactory: (() => {
      let count = 0;
      return () => `policy-ticket-${++count}`;
    })(),
    verificationWindowMs: 1,
    sleep: async () => undefined,
  });
  const result = await plane.request({
    requestId: "request-policy",
    capabilityId: "cap-light",
    action: action(true),
    actor: member,
  });
  assert.equal(result.status, "verified");
  const undo = await plane.undo({ ticketId: result.ticket.id, actor: member });
  assert.equal(undo.status, "failed");
  assert.equal(evaluations, 2);
});

test("execution tickets and activities survive a SQLite reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-one-shot-action-"));
  const path = join(directory, "actions.sqlite");
  try {
    const store = new SqliteOneShotActionStore({ path });
    const fixtureValue = fixture({ policyClass: "confirmation", ttlMs: 10_000 });
    const plane = new OneShotActionPlane({
      gateway: fixtureValue.gateway,
      policy: {
        evaluate: () => ({ status: "allowed", policyClass: "confirmation", reversible: true, ttlMs: 10_000 }),
      },
      store,
      now: () => new Date(1_700_000_000_000).toISOString(),
      idFactory: (() => {
        let count = 0;
        return () => `sqlite-${++count}`;
      })(),
      verificationWindowMs: 1,
      sleep: async () => undefined,
    });
    const pending = await plane.request({
      requestId: "sqlite-request",
      capabilityId: "cap-light",
      action: action(true),
      actor: member,
    });
    assert.equal(pending.status, "pending_confirmation");
    assert.equal(plane.activities().length > 0, true);
    store.close();

    const reopened = new SqliteOneShotActionStore({ path });
    const saved = reopened.load();
    assert.equal(saved?.tickets.length, 1);
    assert.equal(saved?.tickets[0]?.requestId, "sqlite-request");
    assert.equal(saved?.tickets[0]?.status, "pending_confirmation");
    assert.equal(saved?.activities.length, 2);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
