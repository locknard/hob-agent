import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  HomeBatchActionError,
  HomeBatchActionRunner,
  InMemoryHomeBatchActionStore,
  SqliteHomeBatchActionStore,
  type HomeBatchActionDescriptor,
  type HomeBatchActionReviewCenterPort,
} from "./home-batch-action-service.js";
import type {
  OneShotActionActor,
  OneShotActionResult,
} from "../authority/one-shot-action-plane.js";

const actor: OneShotActionActor = {
  principalId: "member-1",
  role: "adult_member",
  present: true,
  device: { kind: "private", boundPrincipalId: "member-1" },
};

function descriptor(
  policyClass: HomeBatchActionDescriptor["policyClass"],
  value: boolean,
): HomeBatchActionDescriptor {
  return {
    action: { kind: "set_boolean", value },
    reversible: true,
    label: "客厅灯",
    actionLabel: value ? "打开" : "关闭",
    summary: value ? "打开客厅灯" : "关闭客厅灯",
    policyClass,
  };
}

function result(
  requestId: string,
  capabilityId: string,
  action: HomeBatchActionDescriptor["action"],
  policyClass: HomeBatchActionDescriptor["policyClass"],
  status: OneShotActionResult["status"],
  reason?: string,
): OneShotActionResult {
  return {
    status,
    ...(reason === undefined ? {} : { reason }),
    ticket: {
      id: `ticket-${capabilityId}`,
      requestId,
      capabilityId,
      action,
      policyClass: policyClass ?? "direct",
      reversible: true,
      status,
      requestedAt: "2026-08-22T00:00:00.000Z",
      initiator: actor,
      ...(reason === undefined ? {} : { resultReason: reason }),
    },
  };
}

function fixture(): {
  readonly runner: HomeBatchActionRunner;
  readonly calls: string[];
  readonly descriptors: Record<string, HomeBatchActionDescriptor>;
} {
  const descriptors = {
    "cap-direct": descriptor("direct", true),
    "cap-confirm": descriptor("confirmation", false),
    "cap-admin": descriptor("administrator", true),
  } satisfies Record<string, HomeBatchActionDescriptor>;
  const calls: string[] = [];
  const reviewCenter: HomeBatchActionReviewCenterPort = {
    actionDescriptorFor: (capabilityId) => descriptors[capabilityId],
    requestAction: async (input) => {
      calls.push(`${input.capabilityId}:${input.requestId}`);
      const configured = descriptors[input.capabilityId];
      if (configured?.policyClass === "direct") {
        return result(input.requestId, input.capabilityId, input.action, configured.policyClass, "verified", "verified");
      }
      return result(input.requestId, input.capabilityId, input.action, configured.policyClass, "pending_confirmation", "confirmation_required");
    },
  };
  return {
    runner: new HomeBatchActionRunner({
      reviewCenter,
      store: new InMemoryHomeBatchActionStore(),
    }),
    calls,
    descriptors,
  };
}

function command(
  descriptors: Record<string, HomeBatchActionDescriptor>,
  capabilityIds: readonly string[] = ["cap-admin", "cap-direct", "cap-confirm"],
  requestId = "batch-1",
) {
  return {
    requestId,
    capabilityIds,
    actor,
    targets: capabilityIds.map((capabilityId) => ({
      capabilityId,
      descriptor: descriptors[capabilityId]!,
    })),
  };
}

test("submits each exact target through the review center and preserves stable per-policy results", async () => {
  const fixtureValue = fixture();
  const first = await fixtureValue.runner.submit(command(fixtureValue.descriptors));

  assert.deepEqual(first.items.map((item) => item.capabilityId), ["cap-admin", "cap-direct", "cap-confirm"]);
  assert.deepEqual(first.items.map((item) => item.status), ["pending_confirmation", "verified", "pending_confirmation"]);
  assert.deepEqual(first.items.map((item) => item.policyClass), ["administrator", "direct", "confirmation"]);
  assert.deepEqual(first.counts, {
    total: 3,
    verified: 1,
    pending_confirmation: 2,
    failed: 0,
    unknown: 0,
  });
  assert.equal("status" in first, false);
  for (const item of first.items) {
    assert.equal(typeof item.requestId, "string");
    assert.equal(typeof item.ticketId, "string");
    assert.equal(typeof item.reason, "string");
    assert.equal(item.verification, item.status);
  }
  assert.deepEqual(fixtureValue.calls.map((call) => call.split(":", 1)[0]), [
    "cap-admin",
    "cap-direct",
    "cap-confirm",
  ]);
});

test("keeps a partial batch as counts and never reports a batch success", async () => {
  const fixtureValue = fixture();
  const original = fixtureValue.runner;
  const reviewCenter: HomeBatchActionReviewCenterPort = {
    actionDescriptorFor: (capabilityId) => fixtureValue.descriptors[capabilityId],
    requestAction: async (input) => {
      if (input.capabilityId === "cap-direct") {
        return result(input.requestId, input.capabilityId, input.action, "direct", "failed", "bridge_rejected");
      }
      return result(input.requestId, input.capabilityId, input.action, "administrator", "verified", "verified");
    },
  };
  const runner = new HomeBatchActionRunner({
    reviewCenter,
    store: new InMemoryHomeBatchActionStore(),
  });
  const batch = await runner.submit(command(fixtureValue.descriptors, ["cap-direct", "cap-admin"], "partial-1"));

  assert.deepEqual(batch.items.map((item) => item.status), ["failed", "unknown"]);
  assert.deepEqual(batch.counts, {
    total: 2,
    verified: 0,
    pending_confirmation: 0,
    failed: 1,
    unknown: 1,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(batch, "success"), false);
  assert.equal(original !== runner, true);
});

test("replays the whole batch and each target request without executing twice", async () => {
  const fixtureValue = fixture();
  const input = command(fixtureValue.descriptors, ["cap-direct", "cap-admin"], "replay-1");
  const first = await fixtureValue.runner.submit(input);
  const second = await fixtureValue.runner.submit(input);

  assert.deepEqual(second, first);
  assert.deepEqual(fixtureValue.calls, [
    "cap-direct:batch:replay-1:cap-direct",
    "cap-admin:batch:replay-1:cap-admin",
  ]);

  await assert.rejects(
    () => fixtureValue.runner.submit({
      ...input,
      targets: input.targets.map((target) => target.capabilityId === "cap-direct"
        ? { ...target, descriptor: fixtureValue.descriptors["cap-confirm"]! }
        : target),
    }),
    (error: unknown) => error instanceof HomeBatchActionError && error.code === "idempotency_conflict",
  );
  assert.equal(fixtureValue.calls.length, 2);
});

test("rejects duplicate, unauthenticated, stale, and unsupported targets before any owner request", async () => {
  const fixtureValue = fixture();
  const duplicate = command(fixtureValue.descriptors, ["cap-direct", "cap-direct"], "duplicate-1");
  await assert.rejects(
    () => fixtureValue.runner.submit(duplicate),
    (error: unknown) => error instanceof HomeBatchActionError && error.code === "duplicate_target",
  );

  await assert.rejects(
    () => fixtureValue.runner.submit({ ...command(fixtureValue.descriptors, ["cap-direct"], "actor-1"), actor: { ...actor, present: false } }),
    (error: unknown) => error instanceof HomeBatchActionError && error.code === "unauthorized_actor",
  );

  await assert.rejects(
    () => fixtureValue.runner.submit({
      ...command(fixtureValue.descriptors, ["cap-direct"], "stale-1"),
      targets: [{ capabilityId: "cap-direct", descriptor: descriptor("direct", false) }],
    }),
    (error: unknown) => error instanceof HomeBatchActionError && error.code === "descriptor_unavailable",
  );

  await assert.rejects(
    () => fixtureValue.runner.submit({
      ...command(fixtureValue.descriptors, ["cap-direct"], "unsupported-1"),
      targets: [{
        capabilityId: "cap-direct",
        descriptor: {
          ...fixtureValue.descriptors["cap-direct"]!,
          action: { kind: "set_level", level: 0.5 },
        },
      }],
    }),
    (error: unknown) => error instanceof HomeBatchActionError && error.code === "descriptor_unavailable",
  );

  assert.deepEqual(fixtureValue.calls, []);
});

test("accepts a present member on a shared display and delegates each target policy to the action owner", async () => {
  const fixtureValue = fixture();
  const sharedActor: OneShotActionActor = {
    principalId: "member-wall",
    role: "member",
    present: true,
    device: { kind: "shared" },
  };

  const batch = await fixtureValue.runner.submit({
    ...command(fixtureValue.descriptors, ["cap-direct", "cap-confirm"], "shared-display-1"),
    actor: sharedActor,
  });

  assert.deepEqual(batch.items.map((item) => item.status), ["verified", "pending_confirmation"]);
  assert.deepEqual(fixtureValue.calls, [
    "cap-direct:batch:shared-display-1:cap-direct",
    "cap-confirm:batch:shared-display-1:cap-confirm",
  ]);
});

test("coalesces concurrent retries and replays from the shared store after a new runner is created", async () => {
  const fixtureValue = fixture();
  const store = new InMemoryHomeBatchActionStore();
  const firstRunner = new HomeBatchActionRunner({
    reviewCenter: {
      actionDescriptorFor: (capabilityId) => fixtureValue.descriptors[capabilityId],
      requestAction: async (input) => {
        fixtureValue.calls.push(`${input.capabilityId}:${input.requestId}`);
        await Promise.resolve();
        return result(
          input.requestId,
          input.capabilityId,
          input.action,
          fixtureValue.descriptors[input.capabilityId]?.policyClass,
          "verified",
          "verified",
        );
      },
    },
    store,
  });
  const input = command(fixtureValue.descriptors, ["cap-direct", "cap-admin"], "concurrent-1");
  const [first, second] = await Promise.all([firstRunner.submit(input), firstRunner.submit(input)]);
  assert.deepEqual(second, first);
  assert.equal(fixtureValue.calls.length, 2);

  const replayRunner = new HomeBatchActionRunner({
    reviewCenter: {
      actionDescriptorFor: () => { throw new Error("replay does not resolve live state"); },
      requestAction: async () => { throw new Error("replay does not request an action"); },
    },
    store,
  });
  assert.deepEqual(await replayRunner.submit(input), first);
  assert.equal(fixtureValue.calls.length, 2);
});

test("records an owner exception as an unknown target without inventing a ticket", async () => {
  const fixtureValue = fixture();
  const runner = new HomeBatchActionRunner({
    reviewCenter: {
      actionDescriptorFor: (capabilityId) => fixtureValue.descriptors[capabilityId],
      requestAction: async () => { throw new Error("owner unavailable"); },
    },
  });
  const batch = await runner.submit(command(fixtureValue.descriptors, ["cap-direct"], "owner-error-1"));
  assert.deepEqual(batch.items, [{
    capabilityId: "cap-direct",
    requestId: "batch:owner-error-1:cap-direct",
    policyClass: "direct",
    status: "unknown",
    reason: "action_owner_unavailable",
    verification: "unknown",
  }]);
  assert.deepEqual(batch.counts, {
    total: 1,
    verified: 0,
    pending_confirmation: 0,
    failed: 0,
    unknown: 1,
  });
});

test("replays a completed batch from the private SQLite store after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-batch-actions-"));
  const path = join(directory, "batch-actions.sqlite");
  const fixtureValue = fixture();
  const input = command(fixtureValue.descriptors, ["cap-direct"], "sqlite-1");
  const firstStore = new SqliteHomeBatchActionStore({ path });
  try {
    const first = await new HomeBatchActionRunner({
      reviewCenter: {
        actionDescriptorFor: (capabilityId) => fixtureValue.descriptors[capabilityId],
        requestAction: async (request) => result(
          request.requestId,
          request.capabilityId,
          request.action,
          "direct",
          "verified",
          "verified",
        ),
      },
      store: firstStore,
    }).submit(input);
    firstStore.close();
    const secondStore = new SqliteHomeBatchActionStore({ path });
    try {
      const replay = await new HomeBatchActionRunner({
        reviewCenter: {
          actionDescriptorFor: () => { throw new Error("replay uses persisted result"); },
          requestAction: async () => { throw new Error("replay uses persisted result"); },
        },
        store: secondStore,
      }).submit(input);
      assert.deepEqual(replay, first);
    } finally {
      secondStore.close();
    }
  } finally {
    firstStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
