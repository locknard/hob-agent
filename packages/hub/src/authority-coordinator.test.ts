import assert from "node:assert/strict";
import test from "node:test";

import { AuthorityCoordinator, type AuthorityResyncSnapshot } from "./authority-coordinator.js";

const capability = (hwCapabilityId: string) => ({
  hwCapabilityId,
  hwId: `hw-${hwCapabilityId}`,
  schema: "hob.sensor",
  bindings: [
    { bridgeId: "bridge-a", nativeId: `${hwCapabilityId}-a`, nativeInstanceId: `${hwCapabilityId}:a` },
    { bridgeId: "bridge-b", nativeId: `${hwCapabilityId}-b`, nativeInstanceId: `${hwCapabilityId}:b` },
  ],
});

class ManualResyncPort {
  calls: string[] = [];
  private readonly pending = new Map<string, (snapshot: AuthorityResyncSnapshot) => void>();

  readonly port = {
    requestResync: async (bridgeId: string) => {
      this.calls.push(bridgeId);
      return { status: "completed" as const };
    },
    waitForSyncComplete: (bridgeId: string, _generation: number) => new Promise<AuthorityResyncSnapshot>((resolve) => {
      this.pending.set(bridgeId, resolve);
    }),
  };

  complete(snapshot: AuthorityResyncSnapshot): void {
    this.pending.get(snapshot.bridgeId)?.(snapshot);
  }
}

function snapshot(bridgeId: string, hwCapabilityIds: readonly string[], validity: "valid" | "invalid-source" = "valid"): AuthorityResyncSnapshot {
  return {
    bridgeId,
    epochId: `${bridgeId}-epoch-2`,
    bindings: hwCapabilityIds.map((hwCapabilityId) => ({
      hwCapabilityId,
      nativeId: `${hwCapabilityId}-b`,
      nativeInstanceId: `${hwCapabilityId}:b`,
      validity,
    })),
  };
}

test("chooses configured state authority before availability and deterministic read-side fallback", () => {
  const coordinator = new AuthorityCoordinator({
    capabilities: [capability("hc-1")],
    stateAuthorityConfig: { "hc-1": "bridge-b" },
  });

  assert.equal(coordinator.chooseStateAuthority("hc-1", [
    { bridgeId: "bridge-a", available: true, validity: "valid" },
    { bridgeId: "bridge-b", available: true, validity: "valid" },
  ]).bridgeId, "bridge-b");
  assert.equal(coordinator.chooseStateAuthority("hc-1", [
    { bridgeId: "bridge-z", available: true, validity: "valid" },
    { bridgeId: "bridge-a", available: true, validity: "valid" },
  ]).bridgeId, "bridge-a");
});

test("switches state authority only after candidate resync contains a valid binding", async () => {
  const resync = new ManualResyncPort();
  const coordinator = new AuthorityCoordinator({
    capabilities: [capability("hc-1")],
    initialStateAuthorities: { "hc-1": "bridge-a" },
    resyncPort: resync.port,
  });

  const pending = coordinator.reconcileStateAuthority("hc-1", [
    { bridgeId: "bridge-a", available: true, validity: "valid" },
    { bridgeId: "bridge-b", available: true, validity: "valid" },
  ], "bridge-b");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(resync.calls, ["bridge-b"]);
  resync.complete(snapshot("bridge-b", ["hc-1"]));

  const result = await pending;
  assert.equal(result.status, "switched");
  assert.equal(coordinator.currentStateAuthority("hc-1"), "bridge-b");
  assert.equal(coordinator.auditTrail().some((record) => record.kind === "state-authority-switched"), true);
});

test("candidate absence or invalid presence fails once and keeps the prior state authority", async () => {
  const resync = new ManualResyncPort();
  const coordinator = new AuthorityCoordinator({
    capabilities: [capability("hc-1")],
    initialStateAuthorities: { "hc-1": "bridge-a" },
    resyncPort: resync.port,
  });

  const pending = coordinator.reconcileStateAuthority("hc-1", [
    { bridgeId: "bridge-a", available: true, validity: "valid" },
    { bridgeId: "bridge-b", available: true, validity: "valid" },
  ], "bridge-b");
  await new Promise<void>((resolve) => setImmediate(resolve));
  resync.complete(snapshot("bridge-b", [], "valid"));
  const result = await pending;

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "candidate_missing");
  assert.equal(coordinator.currentStateAuthority("hc-1"), "bridge-a");
  assert.deepEqual(resync.calls, ["bridge-b"]);
});

test("rejects a present-but-invalid candidate without retrying the bridge", async () => {
  const resync = new ManualResyncPort();
  const coordinator = new AuthorityCoordinator({
    capabilities: [capability("hc-1")],
    initialStateAuthorities: { "hc-1": "bridge-a" },
    resyncPort: resync.port,
  });

  const pending = coordinator.reconcileStateAuthority("hc-1", [
    { bridgeId: "bridge-a", available: true, validity: "valid" },
    { bridgeId: "bridge-b", available: true, validity: "valid" },
  ], "bridge-b");
  await new Promise<void>((resolve) => setImmediate(resolve));
  resync.complete(snapshot("bridge-b", ["hc-1"], "invalid-source"));

  const result = await pending;
  assert.equal(result.reason, "candidate_invalid");
  assert.deepEqual(resync.calls, ["bridge-b"]);
  assert.equal(coordinator.currentStateAuthority("hc-1"), "bridge-a");
});

test("coalesces concurrent resync requests per bridge and commits a batch atomically", async () => {
  const resync = new ManualResyncPort();
  const coordinator = new AuthorityCoordinator({
    capabilities: [capability("hc-1"), capability("hc-2")],
    initialStateAuthorities: { "hc-1": "bridge-a", "hc-2": "bridge-a" },
    resyncPort: resync.port,
  });

  const pending = coordinator.reconcileStateAuthorities([
    {
      hwCapabilityId: "hc-1",
      availability: [{ bridgeId: "bridge-a", available: true, validity: "valid" }, { bridgeId: "bridge-b", available: true, validity: "valid" }],
      preferredBridgeId: "bridge-b",
    },
    {
      hwCapabilityId: "hc-2",
      availability: [{ bridgeId: "bridge-a", available: true, validity: "valid" }, { bridgeId: "bridge-b", available: true, validity: "valid" }],
      preferredBridgeId: "bridge-b",
    },
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(resync.calls, ["bridge-b"]);
  resync.complete(snapshot("bridge-b", ["hc-1", "hc-2"]));

  const results = await pending;
  assert.deepEqual(results.map((result) => result.status), ["switched", "switched"]);
  assert.equal(coordinator.currentStateAuthority("hc-1"), "bridge-b");
  assert.equal(coordinator.currentStateAuthority("hc-2"), "bridge-b");
});

test("does not partially commit a batch when one candidate is invalid", async () => {
  const resync = new ManualResyncPort();
  const coordinator = new AuthorityCoordinator({
    capabilities: [capability("hc-1"), capability("hc-2")],
    initialStateAuthorities: { "hc-1": "bridge-a", "hc-2": "bridge-a" },
    resyncPort: resync.port,
  });

  const pending = coordinator.reconcileStateAuthorities([
    {
      hwCapabilityId: "hc-1",
      availability: [{ bridgeId: "bridge-a", available: true, validity: "valid" }, { bridgeId: "bridge-b", available: true, validity: "valid" }],
      preferredBridgeId: "bridge-b",
    },
    {
      hwCapabilityId: "hc-2",
      availability: [{ bridgeId: "bridge-a", available: true, validity: "valid" }, { bridgeId: "bridge-b", available: true, validity: "valid" }],
      preferredBridgeId: "bridge-b",
    },
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  resync.complete(snapshot("bridge-b", ["hc-1"], "valid"));

  const results = await pending;
  assert.equal(results[0]?.reason, "batch_not_committed");
  assert.equal(results[1]?.reason, "candidate_missing");
  assert.equal(coordinator.currentStateAuthority("hc-1"), "bridge-a");
  assert.equal(coordinator.currentStateAuthority("hc-2"), "bridge-a");
});

test("coalesces separate concurrent authority reconciliations for one bridge", async () => {
  const resync = new ManualResyncPort();
  const coordinator = new AuthorityCoordinator({
    capabilities: [capability("hc-1"), capability("hc-2")],
    initialStateAuthorities: { "hc-1": "bridge-a", "hc-2": "bridge-a" },
    resyncPort: resync.port,
  });
  const availability = [
    { bridgeId: "bridge-a", available: true, validity: "valid" as const },
    { bridgeId: "bridge-b", available: true, validity: "valid" as const },
  ];

  const first = coordinator.reconcileStateAuthority("hc-1", availability, "bridge-b");
  const second = coordinator.reconcileStateAuthority("hc-2", availability, "bridge-b");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(resync.calls, ["bridge-b"]);
  resync.complete(snapshot("bridge-b", ["hc-1", "hc-2"]));

  assert.deepEqual((await Promise.all([first, second])).map((result) => result.status), ["switched", "switched"]);
});

test("bounds a candidate resync wait instead of retrying indefinitely", async () => {
  const resync = new ManualResyncPort();
  const coordinator = new AuthorityCoordinator({
    capabilities: [capability("hc-1")],
    initialStateAuthorities: { "hc-1": "bridge-a" },
    resyncPort: resync.port,
    resyncTimeoutMs: 5,
  });

  const result = await coordinator.reconcileStateAuthority("hc-1", [
    { bridgeId: "bridge-a", available: true, validity: "valid" },
    { bridgeId: "bridge-b", available: true, validity: "valid" },
  ], "bridge-b");

  assert.equal(result.reason, "resync_failed");
  assert.deepEqual(resync.calls, ["bridge-b"]);
  assert.equal(coordinator.currentStateAuthority("hc-1"), "bridge-a");
});

test("bounds a hanging requestResync control call", async () => {
  let calls = 0;
  const coordinator = new AuthorityCoordinator({
    capabilities: [capability("hc-1")],
    initialStateAuthorities: { "hc-1": "bridge-a" },
    resyncTimeoutMs: 5,
    resyncPort: {
      requestResync: async () => {
        calls += 1;
        return await new Promise<never>(() => undefined);
      },
      waitForSyncComplete: async () => snapshot("bridge-b", ["hc-1"]),
    },
  });

  const result = await coordinator.reconcileStateAuthority("hc-1", [
    { bridgeId: "bridge-a", available: true, validity: "valid" },
    { bridgeId: "bridge-b", available: true, validity: "valid" },
  ], "bridge-b");

  assert.equal(result.reason, "resync_failed");
  assert.equal(calls, 1);
  assert.equal(coordinator.currentStateAuthority("hc-1"), "bridge-a");
});

test("action authority fails closed without explicit configuration and never falls back", () => {
  const coordinator = new AuthorityCoordinator({
    capabilities: [capability("hc-1")],
    actionAuthorityConfig: { "hc-1": { bridgeId: "bridge-a", approved: true } },
  });

  assert.deepEqual(coordinator.resolveActionAuthority("hc-1", [
    { bridgeId: "bridge-a", available: false, validity: "valid" },
    { bridgeId: "bridge-b", available: true, validity: "valid" },
  ]), { status: "unavailable", reason: "configured_binding_unavailable" });
  assert.deepEqual(new AuthorityCoordinator({ capabilities: [capability("hc-1")] }).resolveActionAuthority("hc-1", [
    { bridgeId: "bridge-a", available: true, validity: "valid" },
  ]), { status: "unavailable", reason: "not_configured" });
});

test("action authority binding is always an explicit human-governed proposal", () => {
  const coordinator = new AuthorityCoordinator({ capabilities: [capability("hc-1")] });
  const proposal = coordinator.proposeActionAuthority("hc-1", "bridge-b");

  assert.equal(proposal.kind, "action-authority-binding");
  assert.equal(proposal.requiresHumanApproval, true);
  assert.equal(coordinator.resolveActionAuthority("hc-1", [{ bridgeId: "bridge-b", available: true, validity: "valid" }]).status, "unavailable");
});
