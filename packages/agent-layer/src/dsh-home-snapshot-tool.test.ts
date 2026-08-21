import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { type ToolDefinition } from "@deepseek-ai/dsh-tools";

import {
  apply,
  inject,
  name,
  pageHomeSnapshot,
  projectHomeSnapshot,
  type HomeSnapshotToolValue,
} from "./dsh-home-snapshot-tool.js";

class StubWorldService extends Service {
  readonly snapshot = {
    devices: [],
    bridgeWatermarks: [],
    diagnostics: [],
  };

  constructor(ctx: Context) {
    super(ctx, "homeWorld");
  }
}

function queryFixture(): HomeSnapshotToolValue {
  const binding = (nativeId: string, hwSpaceId: string) => ({
    bridgeId: "bridge-a",
    nativeId,
    nativeInstanceId: `${nativeId}-instance`,
    hwSpaceId,
  });
  const device = (
    hwId: string,
    nativeId: string,
    hwSpaceId: string,
    semanticKind: "light" | "sensor",
  ): HomeSnapshotToolValue["devices"][number] => ({
    hwId,
    bindings: [binding(nativeId, hwSpaceId)],
    validity: "valid",
    capabilities: [{
      hwCapabilityId: `${hwId}-capability`,
      hwId,
      schema: `hob.${semanticKind}`,
      schemaVersion: "1.0.0",
      semanticKind,
      bindings: [binding(nativeId, hwSpaceId)],
    }],
    states: [{
      nativeId,
      nativeInstanceId: `${nativeId}-instance`,
      attrs: { state: semanticKind === "light" ? "on" : 21 },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    }],
  });
  return {
    spaces: [
      { hwSpaceId: "hws-a", name: "A", bindings: [{ bridgeId: "bridge-a", nativeSpaceId: "space-a" }] },
      { hwSpaceId: "hws-b", name: "B", bindings: [{ bridgeId: "bridge-a", nativeSpaceId: "space-b" }] },
    ],
    devices: [
      device("hw-a", "native-a", "hws-a", "light"),
      device("hw-b", "native-b", "hws-b", "sensor"),
      device("hw-c", "native-c", "hws-a", "light"),
    ],
    bridgeWatermarks: [{ bridgeId: "bridge-a", epochId: "epoch-a", lastSeq: 3 }],
    metrics: {
      consistency: [{ bridgeId: "bridge-a", state: "ready" }],
      eventActivity: [{ bridgeId: "bridge-a" }],
      connectionActivity: [{ bridgeId: "bridge-a", state: "ready" }],
    },
    topology: { spaces: 2, totalDevices: 3, devicesWithSingleSpace: 3, devicesWithoutSpace: 0, devicesWithMultipleSpaces: 0 },
  };
}

test("pages a normalized snapshot deterministically with an exclusive cursor", () => {
  const first = pageHomeSnapshot(queryFixture(), { limit: 2 });
  assert.deepEqual(first.devices.map((device) => device.hwId), ["hw-a", "hw-b"]);
  assert.deepEqual(first.page, {
    limit: 2,
    returnedDevices: 2,
    totalMatchedDevices: 3,
    nextAfterHwId: "hw-b",
  });

  const second = pageHomeSnapshot(queryFixture(), { limit: 2, afterHwId: "hw-b" });
  assert.deepEqual(second.devices.map((device) => device.hwId), ["hw-c"]);
  assert.deepEqual(second.page, {
    limit: 2,
    returnedDevices: 1,
    totalMatchedDevices: 3,
  });
});

test("removes adapter-native identities from the model-facing snapshot page", () => {
  const page = pageHomeSnapshot(queryFixture(), { limit: 1 });
  const serialized = JSON.stringify(page);
  assert.equal(serialized.includes("native-a"), false);
  assert.equal(serialized.includes("nativeInstanceId"), false);
  assert.equal(serialized.includes("nativeSpaceId"), false);
  assert.deepEqual(page.devices[0]?.states, [{
    hwCapabilityId: "hw-a-capability",
    bridgeId: "bridge-a",
    attrs: { state: "on" },
    time: { sourceTsQuality: "none" },
    origin: "observed",
  }]);
});

test("filters capability bindings and removes unrelated states and spaces", () => {
  const value = pageHomeSnapshot(queryFixture(), {
    hwSpaceIds: ["hws-a"],
    semanticKinds: ["light"],
    limit: 10,
  });

  assert.deepEqual(value.devices.map((device) => device.hwId), ["hw-a", "hw-c"]);
  assert.deepEqual(value.spaces.map((space) => space.hwSpaceId), ["hws-a"]);
  assert.equal(value.devices.every((device) => device.hwSpaceIds.every((item) => item === "hws-a")), true);
  assert.equal(value.devices.every((device) => device.capabilities.every((item) => item.semanticKind === "light")), true);
  assert.equal(value.devices.every((device) => device.states.length === 1), true);
  assert.equal(value.page.totalMatchedDevices, 2);
  assert.deepEqual(value.topology, { spaces: 2, totalDevices: 3, devicesWithSingleSpace: 3, devicesWithoutSpace: 0, devicesWithMultipleSpaces: 0 });
});

test("reports single, missing, and multiple accepted spaces as exclusive topology counts", () => {
  const snapshot = structuredClone(queryFixture());
  const secondSpaceBinding = {
    ...snapshot.devices[0]!.bindings[0]!,
    nativeId: "native-a-secondary",
    nativeInstanceId: "native-a-secondary-instance",
    hwSpaceId: "hws-b",
  };
  snapshot.devices[0]!.bindings.push(secondSpaceBinding);
  snapshot.devices[0]!.capabilities[0]!.bindings.push(secondSpaceBinding);

  assert.deepEqual(projectHomeSnapshot(snapshot).topology, {
    spaces: 2,
    totalDevices: 3,
    devicesWithSingleSpace: 2,
    devicesWithoutSpace: 0,
    devicesWithMultipleSpaces: 1,
  });
});

test("projects only the closed neutral non-spatial disposition", () => {
  const snapshot = structuredClone(queryFixture()) as typeof queryFixture extends () => infer T ? T : never;
  (snapshot.devices[1] as typeof snapshot.devices[number] & { spatialDisposition?: string }).spatialDisposition = "non_spatial";
  (snapshot.devices[2] as typeof snapshot.devices[number] & { spatialDisposition?: string }).spatialDisposition = "untrusted-value";

  const projected = projectHomeSnapshot(snapshot);
  assert.equal(projected.devices.find((device) => device.hwId === "hw-b")?.spatialDisposition, "non_spatial");
  assert.equal(projected.devices.find((device) => device.hwId === "hw-c")?.spatialDisposition, undefined);
  const page = pageHomeSnapshot(snapshot, { hwIds: ["hw-b"], limit: 1 });
  assert.equal(page.devices[0]?.spatialDisposition, "non_spatial");
  assert.equal(JSON.stringify(page).includes("untrusted-value"), false);
});

test("fails closed for invalid or oversized snapshot query arguments", () => {
  assert.throws(() => pageHomeSnapshot(queryFixture(), { limit: 21 }), /limit/);
  assert.throws(() => pageHomeSnapshot(queryFixture(), { hwIds: Array.from({ length: 21 }, (_, index) => `hw-${index}`) }), /hwIds/);
  assert.throws(() => pageHomeSnapshot(queryFixture(), { hwSpaceIds: ["hws-a", "hws-a"] }), /hwSpaceIds/);
  assert.throws(() => pageHomeSnapshot(queryFixture(), { semanticKinds: ["not-a-kind" as "light"] }), /semanticKinds/);
});

test("shrinks snapshot pages deterministically to the model-visible budget", () => {
  const snapshot = structuredClone(queryFixture());
  const template = snapshot.devices[0]!;
  snapshot.devices = Array.from({ length: 3 }, (_, index) => ({
    ...structuredClone(template),
    hwId: `hw-large-${String(index).padStart(2, "0")}`,
    name: `large-device-${String(index).padStart(2, "0")}-${"x".repeat(2_500)}`,
  }));

  const page = pageHomeSnapshot(snapshot, { limit: 3 });
  assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 7_500);
  assert.deepEqual(page.devices.map((device) => device.hwId), ["hw-large-00", "hw-large-01"]);
  assert.deepEqual(page.page, {
    limit: 3,
    returnedDevices: 2,
    totalMatchedDevices: 3,
    nextAfterHwId: "hw-large-01",
  });

  const next = pageHomeSnapshot(snapshot, { limit: 3, afterHwId: page.page.nextAfterHwId });
  assert.ok(Buffer.byteLength(JSON.stringify(next), "utf8") <= 7_500);
  assert.deepEqual(next.devices.map((device) => device.hwId), ["hw-large-02"]);
});

test("fails closed with a bounded narrowing guide when one snapshot device cannot fit", () => {
  const snapshot = structuredClone(queryFixture());
  snapshot.devices = [{
    ...snapshot.devices[0]!,
    name: `too-large-${"x".repeat(8_000)}`,
  }];

  assert.throws(
    () => pageHomeSnapshot(snapshot, { limit: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /model-visible page budget/);
      assert.match(error.message, /narrow hwIds or semanticKinds/);
      assert.equal(error.message.includes("x".repeat(100)), false);
      return true;
    },
  );
});

test("mounts and unloads through the real DSH tool registry", async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(StubWorldService);
  const fiber = await ctx.plugin({ name, inject, apply });

  assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name), ["get_home_snapshot"]);

  await fiber.dispose();
  assert.deepEqual(ctx.tools.schemas(), []);
  await ctx.fiber.dispose();
});

test("registers get_home_snapshot and returns an empty neutral projection", async () => {
  let registered: ToolDefinition | undefined;
  const ctx = {
    homeWorld: {
      snapshot: { devices: [], bridgeWatermarks: [], diagnostics: [] },
    },
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => {};
      },
    },
  } as unknown as Context;

  apply(ctx);

  assert.equal(registered?.name, "get_home_snapshot");
  assert.deepEqual(Object.keys(registered?.parameters.properties ?? {}), [
    "afterHwId", "limit", "hwIds", "hwSpaceIds", "semanticKinds",
  ]);
  const value = await registered!.execute({}, {} as never);

  assert.deepEqual(value, {
    spaces: [],
    devices: [],
    bridgeWatermarks: [],
    metrics: { consistency: [], eventActivity: [], connectionActivity: [] },
    topology: { spaces: 0, totalDevices: 0, devicesWithSingleSpace: 0, devicesWithoutSpace: 0, devicesWithMultipleSpaces: 0 },
    page: { limit: 10, returnedDevices: 0, totalMatchedDevices: 0 },
  });
  assert.deepEqual(registered!.output.render({}, value as never), [
    { type: "text", text: JSON.stringify(value) },
  ]);
});

test("invokes a method-backed HomeWorld snapshot with its service receiver", async () => {
  let registered: ToolDefinition | undefined;
  const homeWorld = {
    marker: "bound-home-world",
    snapshot() {
      assert.equal(this.marker, "bound-home-world");
      return { devices: [], bridgeWatermarks: [], diagnostics: [] };
    },
  };
  const ctx = {
    homeWorld,
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => {};
      },
    },
  } as unknown as Context;

  apply(ctx);
  const value = await registered!.execute({}, {} as never);

  assert.deepEqual(value, {
    spaces: [],
    devices: [],
    bridgeWatermarks: [],
    metrics: { consistency: [], eventActivity: [], connectionActivity: [] },
    topology: { spaces: 0, totalDevices: 0, devicesWithSingleSpace: 0, devicesWithoutSpace: 0, devicesWithMultipleSpaces: 0 },
    page: { limit: 10, returnedDevices: 0, totalMatchedDevices: 0 },
  });
});

test("projects homeWorld into neutral devices, bridge watermarks, and three metric summaries", async () => {
  let registered: ToolDefinition | undefined;
  const ctx = {
    homeWorld: {
      snapshot: {
        devices: [
          {
            hwId: "hw-b",
            bindings: [{ bridgeId: "bridge-b", nativeId: "native-b", nativeInstanceId: "cap-b" }],
            name: "Beta",
            validity: "stale" as const,
            capabilities: [{
              hwCapabilityId: "hc-b",
              hwId: "hw-b",
              schema: "hob.light",
              schemaVersion: "1.0.0",
              bindings: [{ bridgeId: "bridge-b", nativeId: "native-b", nativeInstanceId: "cap-b" }],
            }],
            states: [{
              nativeId: "native-b",
              nativeInstanceId: "cap-b",
              attrs: { z: "last", a: "first", ignored: () => "not-json" },
              time: { sourceTs: "2026-08-18T00:00:00.000Z", sourceTsQuality: "device" as const },
              origin: "observed" as const,
            }],
          },
          {
            hwId: "hw-a",
            bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "cap-a" }],
            validity: "valid" as const,
            capabilities: [{
              hwCapabilityId: "hc-a",
              hwId: "hw-a",
              schema: "hob.sensor",
              schemaVersion: "1.0.0",
              bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "cap-a" }],
            }],
            states: [],
          },
        ],
        bridgeWatermarks: [
          { bridgeId: "bridge-b", epochId: "epoch-b", lastSeq: 9, lastSyncCompleteAt: "2026-08-18T00:00:09.000Z" },
          { bridgeId: "bridge-a", epochId: "epoch-a", lastSeq: 3 },
        ],
        diagnostics: [
          {
            bridgeId: "bridge-b",
            connectionState: "ready" as const,
            lastSyncCompleteAt: "2026-08-18T00:00:09.000Z",
            lastEventReceivedAt: "2026-08-18T00:00:10.000Z",
            lastSuccessfulContactAt: "2026-08-18T00:00:10.000Z",
          },
          {
            bridgeId: "bridge-a",
            connectionState: "degraded" as const,
            lastEventReceivedAt: "2026-08-18T00:00:03.000Z",
            lastSuccessfulContactAt: "2026-08-18T00:00:03.000Z",
          },
        ],
      },
    },
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => {};
      },
    },
  } as unknown as Context;

  apply(ctx);
  const value = await registered!.execute({}, {} as never);

  assert.deepEqual(value, {
    spaces: [],
    devices: [
      {
        hwId: "hw-a",
        validity: "valid",
        bridgeIds: ["bridge-a"],
        hwSpaceIds: [],
        capabilities: [{
          hwCapabilityId: "hc-a",
          hwId: "hw-a",
          bridgeIds: ["bridge-a"],
          hwSpaceIds: [],
        }],
        states: [],
      },
      {
        hwId: "hw-b",
        name: "Beta",
        validity: "stale",
        bridgeIds: ["bridge-b"],
        hwSpaceIds: [],
        capabilities: [{
          hwCapabilityId: "hc-b",
          hwId: "hw-b",
          bridgeIds: ["bridge-b"],
          hwSpaceIds: [],
        }],
        states: [{
          hwCapabilityId: "hc-b",
          bridgeId: "bridge-b",
          attrs: { a: "first", z: "last" },
          time: { sourceTs: "2026-08-18T00:00:00.000Z", sourceTsQuality: "device" },
          origin: "observed",
        }],
      },
    ],
    bridgeWatermarks: [
      { bridgeId: "bridge-a", epochId: "epoch-a", lastSeq: 3 },
      { bridgeId: "bridge-b", epochId: "epoch-b", lastSeq: 9, lastSyncCompleteAt: "2026-08-18T00:00:09.000Z" },
    ],
    metrics: {
      consistency: [
        { bridgeId: "bridge-a", state: "degraded" },
        { bridgeId: "bridge-b", state: "ready", lastSyncCompleteAt: "2026-08-18T00:00:09.000Z" },
      ],
      eventActivity: [
        { bridgeId: "bridge-a", lastEventReceivedAt: "2026-08-18T00:00:03.000Z" },
        { bridgeId: "bridge-b", lastEventReceivedAt: "2026-08-18T00:00:10.000Z" },
      ],
      connectionActivity: [
        { bridgeId: "bridge-a", state: "degraded", lastSuccessfulContactAt: "2026-08-18T00:00:03.000Z" },
        { bridgeId: "bridge-b", state: "ready", lastSuccessfulContactAt: "2026-08-18T00:00:10.000Z" },
      ],
    },
    topology: { spaces: 0, totalDevices: 2, devicesWithSingleSpace: 0, devicesWithoutSpace: 2, devicesWithMultipleSpaces: 0 },
    page: { limit: 10, returnedDevices: 2, totalMatchedDevices: 2 },
  });
});

test("projects the neutral home-world service snapshot shape without ecosystem knowledge", async () => {
  let registered: ToolDefinition | undefined;
  const ctx = {
    homeWorld: {
      snapshot: {
        generatedAt: "2026-08-18T00:00:00.000Z",
        devices: [{
          bridgeId: "bridge-a",
          hwId: "hw-a",
          bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "cap-a" }],
          name: "Kitchen lamp",
          capabilities: [{
            hwCapabilityId: "hc-a",
            hwId: "hw-a",
            schema: "hob.light",
            schemaVersion: "1.0.0",
            bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "cap-a" }],
          }],
          states: {
            "cap-a": {
              nativeId: "native-a",
              nativeInstanceId: "cap-a",
              attrs: { state: "on" },
              time: { sourceTsQuality: "none" as const },
              origin: "observed" as const,
            },
          },
          validity: "valid" as const,
        }],
        bridges: {
          "bridge-a": {
            bridgeId: "bridge-a",
            adapterType: "neutral",
            diagnostics: {
              bridgeId: "bridge-a",
              connectionState: "ready" as const,
              lastSyncCompleteAt: "2026-08-18T00:00:00.000Z",
              lastEventReceivedAt: "2026-08-18T00:00:01.000Z",
              lastSuccessfulContactAt: "2026-08-18T00:00:01.000Z",
            },
            watermark: { epochId: "epoch-a", lastSeq: 4 },
            devices: [{
              bridgeId: "bridge-a",
              hwId: "hw-a",
              bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "cap-a" }],
              name: "Kitchen lamp",
              capabilities: [{
                hwCapabilityId: "hc-a",
                hwId: "hw-a",
                schema: "hob.light",
                schemaVersion: "1.0.0",
                bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "cap-a" }],
              }],
              states: {
                "cap-a": {
                  nativeId: "native-a",
                  nativeInstanceId: "cap-a",
                  attrs: { state: "on" },
                  time: { sourceTsQuality: "none" as const },
                  origin: "observed" as const,
                },
              },
              validity: "valid" as const,
            }],
            extensions: {},
            metrics: { consistency: "ready" as const, eventActivity: "active" as const, connection: "up" as const },
          },
        },
        watermarkVector: { "bridge-a": { epochId: "epoch-a", lastSeq: 4 } },
      },
    },
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => {};
      },
    },
  } as unknown as Context;

  apply(ctx);
  const value = await registered!.execute({}, {} as never);

  assert.deepEqual(value, {
    spaces: [],
    devices: [{
      hwId: "hw-a",
      name: "Kitchen lamp",
      validity: "valid",
      bridgeIds: ["bridge-a"],
      hwSpaceIds: [],
      capabilities: [{
        hwCapabilityId: "hc-a",
        hwId: "hw-a",
        bridgeIds: ["bridge-a"],
        hwSpaceIds: [],
      }],
      states: [{
        hwCapabilityId: "hc-a",
        bridgeId: "bridge-a",
        attrs: { state: "on" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      }],
    }],
    bridgeWatermarks: [{ bridgeId: "bridge-a", epochId: "epoch-a", lastSeq: 4 }],
    metrics: {
      consistency: [{ bridgeId: "bridge-a", state: "ready", lastSyncCompleteAt: "2026-08-18T00:00:00.000Z" }],
      eventActivity: [{ bridgeId: "bridge-a", lastEventReceivedAt: "2026-08-18T00:00:01.000Z" }],
      connectionActivity: [{ bridgeId: "bridge-a", state: "ready", lastSuccessfulContactAt: "2026-08-18T00:00:01.000Z" }],
    },
    topology: { spaces: 0, totalDevices: 1, devicesWithSingleSpace: 0, devicesWithoutSpace: 1, devicesWithMultipleSpaces: 0 },
    page: { limit: 10, returnedDevices: 1, totalMatchedDevices: 1 },
  });
});

test("keeps agent-layer source free of ecosystem-specific identity vocabulary", () => {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const forbiddenTerms = [
    ["home", "assistant"].join("").toLowerCase(),
    ["entity", "_id"].join("").toLowerCase(),
  ];
  for (const file of readdirSync(sourceDirectory).filter((entry) => entry.endsWith(".ts"))) {
    const source = readFileSync(join(sourceDirectory, file), "utf8").toLowerCase();
    for (const term of forbiddenTerms) assert.equal(source.includes(term), false, `${file} contains ${term}`);
  }
});
