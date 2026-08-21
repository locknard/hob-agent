import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

import {
  HomeSafetyService,
  parseHomeSafetyBindings,
  type HomeSafetyBinding,
  type HomeSafetyWorldSource,
} from "./home-safety-service.js";
import { InMemoryHomeSafetyStore } from "./home-safety-store.js";

class StubWorld extends Service implements HomeSafetyWorldSource {
  private value: HomeSafetyWorldSource["snapshot"] extends () => infer T ? T : never;

  constructor(ctx: Context, snapshot: HomeSafetyWorldSource["snapshot"] extends () => infer T ? T : never) {
    super(ctx, "homeWorld");
    this.value = snapshot;
  }

  snapshot() {
    return this.value;
  }

  setSnapshot(value: typeof this.value): void {
    this.value = value;
  }
}

const binding: HomeSafetyBinding = {
  id: "kitchen-leak",
  hwCapabilityId: "hwc-kitchen-leak",
  kind: "water_leak",
  title: "厨房漏水",
  body: "先关闭厨房总水阀，再确认现场。",
  sourceLabel: "厨房漏水传感器",
  stateAttribute: "state",
  activeValues: ["on"],
  clearValues: ["off"],
};

function worldSnapshot(value: string, options: {
  connection?: "up" | "down";
  validity?: "valid" | "stale";
  contactAt?: string;
} = {}) {
  return {
    generatedAt: "2026-08-22T08:00:00.000Z",
    bridges: {
      ha: {
        bridgeId: "ha",
        adapterType: "home-assistant",
        diagnostics: { lastSuccessfulContactAt: options.contactAt ?? "2026-08-22T08:00:00.000Z" },
        watermark: { bridgeId: "ha", epochId: "epoch-1", lastSeq: 2 },
        devices: [],
        extensions: {},
        metrics: {
          consistency: "ready" as const,
          eventActivity: "active" as const,
          connection: options.connection ?? "up",
        },
      },
    },
    watermarkVector: {},
    bridgeWatermarks: [],
    watermarks: [],
    diagnostics: [],
    metrics: { consistency: [], eventActivity: [], connectionActivity: [] },
    spaces: [],
    devices: [{
      bridgeId: "ha",
      hwId: "hw-device-leak",
      nativeId: "binary_sensor.kitchen_leak",
      bindings: [{ bridgeId: "ha", nativeId: "binary_sensor.kitchen_leak", nativeInstanceId: "state", hwSpaceId: "kitchen" }],
      name: "厨房漏水传感器的任意名称",
      capabilities: [{
        hwCapabilityId: binding.hwCapabilityId,
        hwId: "hw-device-leak",
        schema: "ha.entity@1.0.0",
        schemaVersion: "1.0.0",
        semanticKind: "binary-sensor",
        bindings: [{ bridgeId: "ha", nativeId: "binary_sensor.kitchen_leak", nativeInstanceId: "state", hwSpaceId: "kitchen" }],
      }],
      states: [{
        nativeId: "binary_sensor.kitchen_leak",
        nativeInstanceId: "state",
        attrs: { state: value },
        time: { sourceTsQuality: "platform" as const },
        origin: "observed" as const,
      }],
      validity: options.validity ?? "valid",
    }],
  };
}

async function setup(initial = worldSnapshot("on")) {
  const context = new Context();
  await context.plugin(StubWorld, initial);
  const store = new InMemoryHomeSafetyStore();
  const fiber = await context.plugin(HomeSafetyService, {
    bindings: [binding],
    store,
    now: () => "2026-08-22T08:00:00.000Z",
  });
  return { context, world: context.get("homeWorld") as unknown as StubWorld, safety: context.homeSafety, fiber };
}

test("creates a Hub-owned alert from the configured capability and keeps it across layouts", async () => {
  const { safety, fiber } = await setup();
  try {
    const snapshot = safety.snapshot();
    assert.equal(snapshot.alerts.length, 1);
    assert.equal(snapshot.alerts[0]?.id, "kitchen-leak:1");
    assert.equal(snapshot.alerts[0]?.kind, "water_leak");
    assert.equal(snapshot.alerts[0]?.status, "active");
    assert.equal(snapshot.alerts[0]?.snoozeAllowed, false);
  } finally {
    await fiber.dispose();
  }
});

test("acknowledgement changes attention while the physical fact remains active", async () => {
  const { safety, fiber } = await setup();
  try {
    const acknowledged = safety.acknowledge("kitchen-leak:1", "adult-1");
    assert.equal(acknowledged.status, "acknowledged");
    assert.equal(safety.snapshot().alerts[0]?.status, "acknowledged");
    assert.equal(safety.snapshot().alerts.length, 1);
  } finally {
    await fiber.dispose();
  }
});

test("only a trusted current state from the exact binding resolves an alert", async () => {
  const { safety, world, fiber } = await setup();
  try {
    assert.equal(safety.snapshot().alerts[0]?.status, "active");
    world.setSnapshot(worldSnapshot("off", { connection: "down" }));
    assert.equal(safety.snapshot().alerts[0]?.status, "active");

    world.setSnapshot(worldSnapshot("off", { contactAt: "2026-08-22T07:58:00.000Z" }));
    assert.equal(safety.snapshot().alerts[0]?.status, "active");

    world.setSnapshot(worldSnapshot("off"));
    assert.equal(safety.snapshot().alerts.length, 0);

    world.setSnapshot(worldSnapshot("on"));
    assert.equal(safety.snapshot().alerts.length, 1);
    world.setSnapshot(worldSnapshot("off", { validity: "stale" }));
    assert.equal(safety.snapshot().alerts.length, 1);
  } finally {
    await fiber.dispose();
  }
});

test("rejects duplicate safety bindings before the service starts", async () => {
  const context = new Context();
  await context.plugin(StubWorld, worldSnapshot("off"));
  await assert.rejects(
    async () => { await context.plugin(HomeSafetyService, { bindings: [binding, { ...binding, id: "kitchen-leak-copy" }] }); },
    /same hwCapabilityId/,
  );
});

test("parses a closed safety binding document without retaining unknown fields", () => {
  const parsed = parseHomeSafetyBindings([{ ...binding }]);
  assert.deepEqual(parsed, [binding]);
  assert.equal(Object.isFrozen(parsed), true);

  assert.throws(
    () => parseHomeSafetyBindings([{ ...binding, deviceName: "厨房传感器" }]),
    /unknown field/,
  );
});
