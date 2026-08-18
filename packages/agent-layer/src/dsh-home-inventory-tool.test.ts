import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

import {
  apply,
  HomeInventoryCoverageService,
  inject,
  name,
  pageHomeInventory,
} from "./dsh-home-inventory-tool.js";
import type { HomeSnapshotToolValue } from "./dsh-home-snapshot-tool.js";

function fixture(): HomeSnapshotToolValue {
  const binding = {
    bridgeId: "bridge-a",
    nativeId: "must-not-leak-device",
    nativeInstanceId: "must-not-leak-entity",
    hwSpaceId: "hws-a",
  };
  const device = (hwId: string, semanticKind: "light" | "sensor"): HomeSnapshotToolValue["devices"][number] => ({
    hwId,
    name: `${semanticKind} device`,
    validity: "valid",
    bindings: [binding],
    capabilities: [{
      hwCapabilityId: `${hwId}-capability-secret`,
      hwId,
      schema: "ha.entity-secret",
      schemaVersion: "1.0.0",
      semanticKind,
      bindings: [binding],
    }],
    states: [{
      nativeId: binding.nativeId,
      nativeInstanceId: binding.nativeInstanceId,
      attrs: { state: "private-current-value" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    }],
  });
  return {
    spaces: [{
      hwSpaceId: "hws-a",
      name: "Kitchen",
      bindings: [{ bridgeId: "bridge-a", nativeSpaceId: "must-not-leak-space" }],
    }],
    devices: [device("hw-a", "light"), device("hw-b", "sensor"), device("hw-c", "light")],
    bridgeWatermarks: [],
    metrics: { consistency: [], eventActivity: [], connectionActivity: [] },
    topology: { spaces: 1, totalDevices: 3, devicesWithSingleSpace: 3, devicesWithoutSpace: 0, devicesWithMultipleSpaces: 0 },
  };
}

test("pages compact inventory before detailed state inspection", () => {
  const first = pageHomeInventory(fixture(), { limit: 2 });
  assert.deepEqual(first.devices, [
    {
      hwId: "hw-a",
      name: "light device",
      validity: "valid",
      bridgeIds: ["bridge-a"],
      hwSpaceIds: ["hws-a"],
      semanticKinds: ["light"],
      capabilityCount: 1,
      stateCount: 1,
    },
    {
      hwId: "hw-b",
      name: "sensor device",
      validity: "valid",
      bridgeIds: ["bridge-a"],
      hwSpaceIds: ["hws-a"],
      semanticKinds: ["sensor"],
      capabilityCount: 1,
      stateCount: 1,
    },
  ]);
  assert.deepEqual(first.page, {
    limit: 2,
    returnedDevices: 2,
    totalDevices: 3,
    nextAfterHwId: "hw-b",
  });
  assert.match(first.inventoryVersion, /^[a-f0-9]{64}$/);
  const second = pageHomeInventory(fixture(), { limit: 2, afterHwId: "hw-b" });
  assert.equal(second.inventoryVersion, first.inventoryVersion);
  assert.deepEqual(second.devices.map((device) => device.hwId), ["hw-c"]);
});

test("inventory omits current values, capability identities, schemas, and native identities", () => {
  const serialized = JSON.stringify(pageHomeInventory(fixture(), {}));
  for (const secret of [
    "private-current-value",
    "capability-secret",
    "ha.entity-secret",
    "must-not-leak-device",
    "must-not-leak-entity",
    "must-not-leak-space",
  ]) assert.equal(serialized.includes(secret), false);
});

test("adapts page length so every compact inventory result remains model-visible", () => {
  const snapshot = structuredClone(fixture());
  const template = snapshot.devices[0]!;
  snapshot.devices = Array.from({ length: 25 }, (_, index) => ({
    ...structuredClone(template),
    hwId: `hw-${String(index).padStart(3, "0")}`,
    name: `device-${String(index).padStart(3, "0")}-${"x".repeat(500)}`,
  }));
  snapshot.topology = {
    spaces: 1,
    totalDevices: 25,
    devicesWithSingleSpace: 25,
    devicesWithoutSpace: 0,
    devicesWithMultipleSpaces: 0,
  };

  const seen: string[] = [];
  const versions = new Set<string>();
  let afterHwId: string | undefined;
  let pages = 0;
  do {
    const page = pageHomeInventory(snapshot, { limit: 25, ...(afterHwId === undefined ? {} : { afterHwId }) });
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 7_500);
    assert.ok(page.page.returnedDevices > 0);
    seen.push(...page.devices.map((device) => device.hwId));
    versions.add(page.inventoryVersion);
    afterHwId = page.page.nextAfterHwId;
    pages += 1;
    assert.ok(pages < 10);
  } while (afterHwId !== undefined);

  assert.deepEqual(seen, snapshot.devices.map((device) => device.hwId));
  assert.equal(versions.size, 1);
  assert.ok(pages > 1);
});

test("fails closed when one compact device cannot fit the model-visible budget", () => {
  const snapshot = structuredClone(fixture());
  snapshot.devices = [{
    ...snapshot.devices[0]!,
    bindings: Array.from({ length: 40 }, (_, index) => ({
      bridgeId: `bridge-${String(index).padStart(2, "0")}-${"x".repeat(220)}`,
      nativeId: `private-${index}`,
      nativeInstanceId: `private-instance-${index}`,
      hwSpaceId: "hws-a",
    })),
  }];
  snapshot.topology = {
    spaces: 1,
    totalDevices: 1,
    devicesWithSingleSpace: 1,
    devicesWithoutSpace: 0,
    devicesWithMultipleSpaces: 0,
  };

  assert.throws(() => pageHomeInventory(snapshot, { limit: 1 }), /model-visible page budget/);
});

test("retains the neutral non-spatial disposition in compact discovery", () => {
  const snapshot = structuredClone(fixture());
  (snapshot.devices[1] as typeof snapshot.devices[number] & { spatialDisposition?: "non_spatial" }).spatialDisposition = "non_spatial";

  assert.equal(pageHomeInventory(snapshot, {}).devices.find((device) => device.hwId === "hw-b")?.spatialDisposition, "non_spatial");
});

test("autonomous proposal coverage opens only after a stable ordered inventory is exhausted", async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeInventoryCoverageService);
  ctx.homeInventoryCoverage.beginObservation();
  assert.throws(() => ctx.homeInventoryCoverage.assertProposalAllowed(), /exhaust/);

  const first = pageHomeInventory(fixture(), { limit: 2 });
  ctx.homeInventoryCoverage.record({ limit: 2 }, first);
  assert.throws(() => ctx.homeInventoryCoverage.assertProposalAllowed(), /exhaust/);

  const secondQuery = { limit: 2, afterHwId: first.page.nextAfterHwId };
  const second = pageHomeInventory(fixture(), secondQuery);
  ctx.homeInventoryCoverage.record(secondQuery, second);
  assert.doesNotThrow(() => ctx.homeInventoryCoverage.assertProposalAllowed());

  ctx.homeInventoryCoverage.endObservation();
  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("a changing inventory version remains closed until discovery restarts", async () => {
  const ctx = new Context();
  await ctx.plugin(HomeInventoryCoverageService);
  ctx.homeInventoryCoverage.beginObservation();
  const first = pageHomeInventory(fixture(), { limit: 1 });
  ctx.homeInventoryCoverage.record({ limit: 1 }, first);
  const cursor = first.page.nextAfterHwId!;
  const changed = pageHomeInventory(fixture(), { limit: 50, afterHwId: cursor });
  ctx.homeInventoryCoverage.record({ limit: 50, afterHwId: cursor }, {
    ...changed,
    inventoryVersion: "0".repeat(64),
  });
  assert.throws(() => ctx.homeInventoryCoverage.assertProposalAllowed(), /exhaust/);

  const restarted = pageHomeInventory(fixture(), { limit: 50 });
  ctx.homeInventoryCoverage.record({ limit: 50 }, restarted);
  assert.doesNotThrow(() => ctx.homeInventoryCoverage.assertProposalAllowed());
  await ctx.fiber.dispose();
});

class StubWorldService extends Service {
  readonly snapshot = { devices: [], bridgeWatermarks: [], diagnostics: [] };
  constructor(ctx: Context) { super(ctx, "homeWorld"); }
}

test("mounts one bounded inventory tool through the DSH registry", async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(StubWorldService);
  const fiber = await ctx.plugin({ name, inject, apply });
  assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name), ["get_home_inventory"]);
  await fiber.dispose();
  await ctx.fiber.dispose();
});
