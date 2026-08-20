import assert from "node:assert/strict";
import test from "node:test";

import { WorldIdentityManager } from "./world-identity.js";

const capability = (nativeInstanceId: string, schema = "hob.sensor") => ({
  nativeInstanceId,
  schema,
  schemaVersion: "1.0.0",
});

test("allocates stable hub identities and capability bindings for one observed device", () => {
  const manager = new WorldIdentityManager({ now: () => "2026-08-18T00:00:00.000Z" });
  const descriptor = {
    nativeId: "native-a",
    name: "Sensor A",
    capabilities: [capability("sensor-a")],
    identityClaims: [{
      type: "serial" as const,
      value: "serial-a",
      source: { kind: "device_reported" as const },
      confidence: "high" as const,
    }],
  };

  const first = manager.observe("bridge-a", descriptor);
  const repeated = manager.observe("bridge-a", descriptor);

  assert.match(first.identity.hwId, /^hw-[0-9a-f]{64}$/);
  assert.match(first.capabilities[0]?.hwCapabilityId ?? "", /^hwc-[0-9a-f]{64}$/);
  assert.equal(first.capabilities.length, 1);
  assert.equal(first.capabilities[0]?.bindings[0]?.bridgeId, "bridge-a");
  assert.equal(repeated.identity.hwId, first.identity.hwId);
  assert.equal(repeated.capabilities[0]?.hwCapabilityId, first.capabilities[0]?.hwCapabilityId);
  assert.deepEqual(repeated.proposals, []);
});

test("does not inherit a capability identity across an adapter schema change", () => {
  const manager = new WorldIdentityManager();
  const descriptor = (schema: string) => ({
    nativeId: "native-cover",
    capabilities: [capability("cover-main", schema)],
  });

  const generic = manager.observe("bridge-ha", descriptor("ha.entity"));
  const reviewedCover = manager.observe("bridge-ha", descriptor("ha.cover"));

  assert.equal(reviewedCover.identity.hwId, generic.identity.hwId);
  assert.notEqual(
    reviewedCover.capabilities[0]?.hwCapabilityId,
    generic.capabilities[0]?.hwCapabilityId,
  );
});

test("explicit idFactory remains the test seam for hub ids", () => {
  const manager = new WorldIdentityManager({
    idFactory: (kind) => `injected-${kind}`,
  });
  const result = manager.observe("bridge-a", {
    nativeId: "native-a",
    capabilities: [capability("sensor-a")],
  });

  assert.equal(result.identity.hwId, "injected-hw");
  assert.equal(result.capabilities[0]?.hwCapabilityId, "injected-hwCapability");
});

test("default hub ids stay stable across fresh managers despite observation order", () => {
  const descriptorA = {
    nativeId: "native-a",
    capabilities: [capability("sensor-a")],
  };
  const descriptorB = {
    nativeId: "native-b",
    capabilities: [capability("sensor-b")],
  };

  const firstManager = new WorldIdentityManager();
  const firstA = firstManager.observe("bridge-a", descriptorA);
  const firstB = firstManager.observe("bridge-b", descriptorB);

  const secondManager = new WorldIdentityManager();
  const secondB = secondManager.observe("bridge-b", descriptorB);
  const secondA = secondManager.observe("bridge-a", descriptorA);

  assert.equal(firstA.identity.hwId, secondA.identity.hwId);
  assert.equal(firstB.identity.hwId, secondB.identity.hwId);
  assert.equal(firstA.capabilities[0]?.hwCapabilityId, secondA.capabilities[0]?.hwCapabilityId);
  assert.equal(firstB.capabilities[0]?.hwCapabilityId, secondB.capabilities[0]?.hwCapabilityId);
  assert.doesNotMatch(firstA.identity.hwId, /bridge-a|native-a/);
  assert.doesNotMatch(firstA.capabilities[0]?.hwCapabilityId ?? "", /bridge-a|native-a|sensor-a/);
});

test("allocates stable bridge-scoped spaces without merging equal names", () => {
  const descriptor = (nativeId: string, nativeSpaceId: string) => ({
    nativeId,
    capabilities: [{
      ...capability(`${nativeId}:power`, "hob.light"),
      space: { nativeSpaceId, name: "Living room" },
    }],
  });
  const first = new WorldIdentityManager();
  const firstA = first.observe("bridge-a", descriptor("lamp-a", "area-a"));
  const firstB = first.observe("bridge-b", descriptor("lamp-b", "room-b"));
  const second = new WorldIdentityManager();
  const secondB = second.observe("bridge-b", descriptor("lamp-b", "room-b"));
  const secondA = second.observe("bridge-a", descriptor("lamp-a", "area-a"));

  const firstSpaces = first.listWorldSpaces();
  assert.equal(firstSpaces.length, 2);
  assert.notEqual(firstSpaces[0]?.hwSpaceId, firstSpaces[1]?.hwSpaceId);
  assert.equal(firstSpaces.every((space) => space.name === "Living room"), true);
  assert.match(firstA.capabilities[0]?.bindings[0]?.hwSpaceId ?? "", /^hws-[0-9a-f]{64}$/);
  assert.notEqual(
    firstA.capabilities[0]?.bindings[0]?.hwSpaceId,
    firstB.capabilities[0]?.bindings[0]?.hwSpaceId,
  );
  assert.equal(
    firstA.capabilities[0]?.bindings[0]?.hwSpaceId,
    secondA.capabilities[0]?.bindings[0]?.hwSpaceId,
  );
  assert.equal(
    firstB.capabilities[0]?.bindings[0]?.hwSpaceId,
    secondB.capabilities[0]?.bindings[0]?.hwSpaceId,
  );
});

test("updates a capability space without changing its capability identity", () => {
  const manager = new WorldIdentityManager();
  const descriptor = (nativeSpaceId: string) => ({
    nativeId: "lamp",
    capabilities: [{
      ...capability("lamp:power", "hob.light"),
      space: { nativeSpaceId, name: nativeSpaceId },
    }],
  });
  const before = manager.observe("bridge-a", descriptor("room-a"));
  const after = manager.observe("bridge-a", descriptor("room-b"));

  assert.equal(after.capabilities[0]?.hwCapabilityId, before.capabilities[0]?.hwCapabilityId);
  assert.notEqual(
    after.capabilities[0]?.bindings[0]?.hwSpaceId,
    before.capabilities[0]?.bindings[0]?.hwSpaceId,
  );
  assert.equal(manager.listWorldSpaces().length, 2);
});

test("device identities do not allocate a principal", () => {
  const manager = new WorldIdentityManager();
  const result = manager.observe("bridge-a", {
    nativeId: "native-a",
    capabilities: [capability("sensor-a")],
  });

  assert.equal(Object.prototype.hasOwnProperty.call(result.identity, "principal"), false);
});

test("auto-merges only deterministic device or independent claims and keeps cross-bridge capabilities separate", () => {
  const manager = new WorldIdentityManager();
  const first = manager.observe("bridge-a", {
    nativeId: "native-a",
    capabilities: [capability("sensor-a")],
    identityClaims: [{
      type: "serial" as const,
      value: "serial-a",
      source: { kind: "independent_registry" as const, registry: "registry-a" },
      confidence: "high" as const,
    }],
  });
  const second = manager.observe("bridge-b", {
    nativeId: "native-b",
    capabilities: [capability("sensor-b")],
    identityClaims: [{
      type: "serial" as const,
      value: "serial-a",
      source: { kind: "independent_registry" as const, registry: "registry-a" },
      confidence: "high" as const,
    }],
  });

  assert.equal(second.identity.hwId, first.identity.hwId);
  assert.equal(second.autoMerged, true);
  assert.notEqual(second.capabilities[0]?.hwCapabilityId, first.capabilities[0]?.hwCapabilityId);
  assert.equal(second.capabilities[0]?.bindings.length, 1);
  assert.equal(second.proposals.some((proposal) => proposal.kind === "capability-binding"), true);
});

test("qualified claims produce the same opaque identity and binding ids across managers and bridge order", () => {
  const claims = [
    {
      type: "serial" as const,
      value: "serial-cross-bridge",
      source: { kind: "independent_registry" as const, registry: "registry-a" },
      confidence: "high" as const,
    },
    {
      type: "mac" as const,
      value: "AA:BB:CC:DD:EE:FF",
      source: { kind: "device_reported" as const },
      confidence: "high" as const,
    },
  ];
  const descriptorA = {
    nativeId: "native-a",
    capabilities: [capability("sensor-a")],
    identityClaims: claims,
  };
  const descriptorB = {
    nativeId: "native-b",
    capabilities: [capability("sensor-b")],
    identityClaims: [...claims].reverse(),
  };

  const firstManager = new WorldIdentityManager();
  const firstA = firstManager.observe("bridge-a", descriptorA);
  const firstB = firstManager.observe("bridge-b", descriptorB);

  const secondManager = new WorldIdentityManager();
  const secondB = secondManager.observe("bridge-b", descriptorB);
  const secondA = secondManager.observe("bridge-a", descriptorA);

  assert.equal(firstA.identity.hwId, firstB.identity.hwId);
  assert.equal(firstA.identity.hwId, secondA.identity.hwId);
  assert.equal(firstB.identity.hwId, secondB.identity.hwId);
  assert.equal(firstA.capabilities[0]?.hwCapabilityId, secondA.capabilities[0]?.hwCapabilityId);
  assert.equal(firstB.capabilities[0]?.hwCapabilityId, secondB.capabilities[0]?.hwCapabilityId);
  assert.doesNotMatch(firstA.identity.hwId, /serial-cross-bridge|registry-a|bridge-a|native-a/);
  assert.doesNotMatch(firstA.capabilities[0]?.hwCapabilityId ?? "", /sensor-a|bridge-a|native-a/);
});

test("platform and inferred claims never merge devices automatically and emit review proposals", () => {
  const manager = new WorldIdentityManager();
  const first = manager.observe("bridge-a", {
    nativeId: "native-a",
    capabilities: [capability("sensor-a")],
    identityClaims: [{
      type: "other" as const,
      value: "platform-device-a",
      source: { kind: "platform_registry" as const, platform: "platform-a" },
      confidence: "high" as const,
    }],
  });
  const second = manager.observe("bridge-b", {
    nativeId: "native-b",
    capabilities: [capability("sensor-b")],
    identityClaims: [{
      type: "other" as const,
      value: "platform-device-a",
      source: { kind: "platform_registry" as const, platform: "platform-a" },
      confidence: "high" as const,
    }],
  });

  assert.equal(first.proposals.some((proposal) => proposal.kind === "identity-link"), false);
  assert.notEqual(second.identity.hwId, first.identity.hwId);
  assert.equal(second.autoMerged, false);
  assert.equal(second.proposals.some((proposal) =>
    proposal.kind === "identity-link" && proposal.targetHwId === first.identity.hwId), true);
  assert.equal(second.proposals.every((proposal) => proposal.requiresHumanApproval), true);
});

test("same-schema capability candidates produce proposals rather than implicit cross-bridge binding", () => {
  const manager = new WorldIdentityManager();
  manager.observe("bridge-a", { nativeId: "native-a", capabilities: [capability("sensor-a")] });
  const second = manager.observe("bridge-b", { nativeId: "native-b", capabilities: [capability("sensor-b")] });

  assert.equal(second.capabilities[0]?.bindings[0]?.bridgeId, "bridge-b");
  assert.equal(second.proposals.some((proposal) => proposal.kind === "capability-binding"), true);
  assert.equal(manager.listWorldCapabilities().length, 2);
});

test("identity and governance records expose only hub-assigned ids and source qualification", () => {
  const manager = new WorldIdentityManager();
  const first = manager.observe("bridge-a", {
    nativeId: "native-a",
    capabilities: [],
    identityClaims: [{
      type: "serial" as const,
      value: "serial-a",
      source: { kind: "inferred" as const, method: "same-room" },
      confidence: "low" as const,
    }],
  });
  const result = manager.observe("bridge-b", {
    nativeId: "native-b",
    capabilities: [],
    identityClaims: [{
      type: "serial" as const,
      value: "serial-a",
      source: { kind: "inferred" as const, method: "same-room" },
      confidence: "low" as const,
    }],
  });

  assert.equal(first.proposals.length, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(result.identity, "principal"), false);
  assert.equal(result.audit.some((record) => record.kind === "identity-observed"), true);
  assert.equal(result.proposals[0]?.sourceKind, "inferred");
  assert.equal(result.proposals[0]?.targetHwId, first.identity.hwId);
});
