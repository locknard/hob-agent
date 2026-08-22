import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeStreamError,
  EnvelopeSchema,
  type Envelope,
} from "@hob/bridge-contract";
import { runBridgeAdapterConformance } from "@hob/bridge-contract";
import type { ActionsExtension, BridgeActionDescriptor } from "@hob/bridge-contract";
import {
  createXiaomiHomeAdapterRegistration,
  deriveXiaomiRemoteInstanceId,
  type XiaomiHomeTransport,
  type XiaomiHomeTransportPlugin,
} from "./xiaomi-home-bridge.js";

const snapshot = {
  installationId: "account-realm:home-42",
  devices: [{
    did: "123456789",
    name: "客厅灯",
    space: { nativeSpaceId: "room-7", name: "客厅" },
    online: true,
    properties: [
      { siid: 2, piid: 1, value: true, format: "bool", unit: "none", writable: true, semanticKind: "light" },
      { siid: 2, piid: 2, value: 37, format: "uint8", unit: "percentage", semanticKind: "light" },
    ],
  }],
} as const;

function fixturePlugin(): XiaomiHomeTransportPlugin {
  return {
    credentialRequirements: [],
    create: () => ({
      connect: async () => snapshot,
      changes: async function* () {},
      resync: async () => snapshot,
      dispose: async () => {},
    } satisfies XiaomiHomeTransport),
  };
}

test("projects a bounded MIoT snapshot through the neutral bridge contract", async () => {
  const registration = createXiaomiHomeAdapterRegistration(fixturePlugin());
  const adapter = registration.factory({
    bridgeId: "xiaomi-cn-home",
    config: { region: "cn", transport: "cloud" },
    credentials: { resolve: async () => undefined, describe: async () => ({ configured: false }) },
  });

  const events: Envelope[] = [];
  for await (const envelope of adapter.events(new AbortController().signal)) events.push(envelope);

  for (const envelope of events) assert.deepEqual(EnvelopeSchema.parse(envelope), envelope);
  assert.deepEqual(events.map((event) => event.event.kind), [
    "sync-start",
    "device-upserted",
    "state",
    "state",
    "device-health",
    "sync-complete",
  ]);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(events[1]?.event, {
    kind: "device-upserted",
    device: {
      nativeId: "123456789",
      name: "客厅灯",
      capabilities: [
        {
          nativeInstanceId: "service:2/property:1",
          schema: "miot.property",
          schemaVersion: "1.0.0",
          semanticKind: "light",
          space: { nativeSpaceId: "room-7", name: "客厅" },
        },
        {
          nativeInstanceId: "service:2/property:2",
          schema: "miot.property",
          schemaVersion: "1.0.0",
          semanticKind: "light",
          space: { nativeSpaceId: "room-7", name: "客厅" },
        },
      ],
      identityClaims: [{
        type: "miotDid",
        value: "123456789",
        source: { kind: "platform_registry", platform: "xiaomi-home" },
        confidence: "high",
      }],
    },
  });
  assert.deepEqual(events[2]?.event, {
    kind: "state",
    state: {
      nativeId: "123456789",
      nativeInstanceId: "service:2/property:1",
      attrs: { value: true, format: "bool", unit: "none", writable: true },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  });
  const syncStart = events[0]?.event;
  assert.equal(syncStart?.kind, "sync-start");
  if (syncStart?.kind === "sync-start") {
    assert.equal(syncStart.remoteInstanceId, deriveXiaomiRemoteInstanceId("cn", snapshot.installationId));
    assert.equal(syncStart.remoteInstanceId.includes(snapshot.installationId), false);
  }
});

test("translates one bound neutral boolean action through an authorized Xiaomi transport", async () => {
  const writes: unknown[] = [];
  const registration = createXiaomiHomeAdapterRegistration({
    credentialRequirements: [],
    create: () => ({
      connect: async () => snapshot,
      changes: async function* (signal) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      setProperty: async (input) => { writes.push(input); },
      resync: async () => snapshot,
      dispose: async () => {},
    }),
  });
  const adapter = registration.factory({
    bridgeId: "xiaomi-cn-home",
    config: { region: "cn", transport: "cloud" },
    credentials: { resolve: async () => undefined, describe: async () => ({ configured: false }) },
  });
  const controller = new AbortController();
  const iterator = adapter.events(controller.signal)[Symbol.asyncIterator]();
  for (let index = 0; index < 6; index += 1) await iterator.next();

  const handle = adapter.extension("actions@1") as ActionsExtension | undefined;
  const result = await handle?.execute({
    requestId: "action-xiaomi",
    action: {
      kind: "set_boolean",
      target: {
        hwCapabilityId: "cap-light",
        binding: {
          bridgeId: "xiaomi-cn-home",
          nativeId: "123456789",
          nativeInstanceId: "service:2/property:1",
        },
      },
      value: false,
    },
  }, { signal: controller.signal });
  assert.deepEqual(result, { status: "acknowledged" });
  assert.deepEqual(writes, [{ did: "123456789", siid: 2, piid: 1, value: false, signal: controller.signal }]);
  controller.abort();
  await adapter.control.dispose();
});

test("translates one bound neutral stop-media action through the transport stop seam", async () => {
  const stops: unknown[] = [];
  const controller = new AbortController();
  const mediaSnapshot = {
    ...snapshot,
    devices: snapshot.devices.map((device) => ({
      ...device,
      properties: device.properties.map((property, index) => index === 0
        ? { ...property, supportedActions: ["stop_media" as const] }
        : property),
    })),
  };
  const registration = createXiaomiHomeAdapterRegistration({
    credentialRequirements: [],
    create: () => ({
      connect: async () => mediaSnapshot,
      changes: async function* (signal) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      resync: async () => mediaSnapshot,
      stopMedia: async (input) => { stops.push(input); },
      dispose: async () => {},
    }),
  });
  const adapter = registration.factory({
    bridgeId: "xiaomi-cn-media",
    config: { region: "cn", transport: "cloud" },
    credentials: { resolve: async () => undefined, describe: async () => ({ configured: false }) },
  });
  const iterator = adapter.events(controller.signal)[Symbol.asyncIterator]();
  for (let index = 0; index < 6; index += 1) await iterator.next();

  const handle = adapter.extension("actions@1") as ActionsExtension | undefined;
  const result = await handle?.execute({
    requestId: "stop-media-xiaomi",
    action: {
      kind: "stop_media",
      target: {
        hwCapabilityId: "cap-player",
        binding: {
          bridgeId: "xiaomi-cn-media",
          nativeId: "123456789",
          nativeInstanceId: "service:2/property:1",
        },
      },
    },
  }, { signal: controller.signal });
  assert.deepEqual(result, { status: "acknowledged" });
  assert.deepEqual(stops, [{ did: "123456789", signal: controller.signal }]);

  const invalidBinding = await handle?.execute({
    requestId: "stop-media-xiaomi-invalid-binding",
    action: {
      kind: "stop_media",
      target: {
        hwCapabilityId: "cap-player",
        binding: {
          bridgeId: "xiaomi-cn-media",
          nativeId: "123456789",
          nativeInstanceId: "service:99/property:99",
        },
      },
    },
  }, { signal: controller.signal });
  assert.deepEqual(invalidBinding, { status: "rejected", reason: "invalid_target" });
  assert.equal(stops.length, 1);

  controller.abort();
  await adapter.control.dispose();
});

test("describes only explicit Xiaomi reversible controls", async () => {
  const explicitSnapshot = {
    installationId: "account-realm:home-actions",
    devices: [{
      did: "123456789",
      online: true,
      properties: [{
        siid: 2,
        piid: 1,
        value: true,
        format: "bool",
        writable: true,
      }, {
        siid: 2,
        piid: 2,
        value: 37,
        format: "uint8",
        writable: true,
        supportedActions: ["set_level" as const],
        levelRange: { min: 0, max: 100 },
      }],
    }],
  };
  const controller = new AbortController();
  const registration = createXiaomiHomeAdapterRegistration({
    credentialRequirements: [],
    create: () => ({
      connect: async () => explicitSnapshot,
      changes: async function* (signal) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      resync: async () => explicitSnapshot,
      dispose: async () => {},
      setProperty: async () => {},
    }),
  });
  const adapter = registration.factory({
    bridgeId: "xiaomi-actions",
    config: { region: "cn", transport: "cloud" },
    credentials: { resolve: async () => undefined, describe: async () => ({ configured: false }) },
  });
  const iterator = adapter.events(controller.signal)[Symbol.asyncIterator]();
  for (let index = 0; index < 6; index += 1) await iterator.next();
  const handle = adapter.extension("actions@1") as ActionsExtension | undefined;
  const booleanDescriptor = handle?.describe({
    target: {
      hwCapabilityId: "cap-boolean",
      binding: {
        bridgeId: "xiaomi-actions",
        nativeId: "123456789",
        nativeInstanceId: "service:2/property:1",
      },
    },
    current: { value: true, format: "bool", writable: true, available: true },
  }) as BridgeActionDescriptor | undefined;
  assert.deepEqual(booleanDescriptor?.action, { kind: "set_boolean", value: false });
  const levelDescriptor = handle?.describe({
    target: {
      hwCapabilityId: "cap-level",
      binding: {
        bridgeId: "xiaomi-actions",
        nativeId: "123456789",
        nativeInstanceId: "service:2/property:2",
      },
    },
    current: { value: 37, format: "uint8", writable: true, available: true },
  }) as BridgeActionDescriptor | undefined;
  assert.deepEqual(levelDescriptor?.action, { kind: "set_level", level: 0 });
  const unsupportedStop = handle?.describe({
    target: {
      hwCapabilityId: "cap-level",
      binding: {
        bridgeId: "xiaomi-actions",
        nativeId: "123456789",
        nativeInstanceId: "service:2/property:2",
      },
    },
    current: { value: 37, format: "uint8", writable: true, available: true },
  });
  assert.notEqual(unsupportedStop?.action.kind, "stop_media");
  controller.abort();
  await adapter.control.dispose();
});

test("emits ordered property and reachability changes and disposes its transport", async () => {
  let connectCalls = 0;
  let disposeCalls = 0;
  const registration = createXiaomiHomeAdapterRegistration({
    credentialRequirements: [],
    create: () => ({
      connect: async () => {
        connectCalls += 1;
        return {
          installationId: "fixture",
          devices: [{
            did: "lamp",
            online: true,
            properties: [{ siid: 2, piid: 1, value: true, format: "bool" }],
          }],
        };
      },
      changes: async function* () {
        yield { kind: "property", did: "lamp", property: { siid: 2, piid: 1, value: false, format: "bool" } } as const;
        yield { kind: "online", did: "lamp", online: false } as const;
      },
      resync: async () => ({ installationId: "fixture", devices: [] }),
      dispose: async () => { disposeCalls += 1; },
    }),
  });
  const adapter = registration.factory({
    bridgeId: "xiaomi-changes",
    config: { region: "cn", transport: "central-gateway" },
    credentials: { resolve: async () => undefined, describe: async () => ({ configured: false }) },
  });

  assert.equal(connectCalls, 0);
  const stream = adapter.events(new AbortController().signal);
  assert.equal(connectCalls, 0);
  const events: Envelope[] = [];
  for await (const event of stream) events.push(event);

  assert.equal(connectCalls, 1);
  assert.equal(disposeCalls, 1);
  assert.deepEqual(events.slice(-2).map((event) => event.event.kind), ["state", "device-health"]);
  assert.throws(
    () => adapter.events(new AbortController().signal),
    (error: unknown) => error instanceof BridgeStreamError && error.reason === "protocol_error",
  );
});

test("does not invent capabilities from unknown incremental properties", async () => {
  const registration = createXiaomiHomeAdapterRegistration({
    credentialRequirements: [],
    create: () => ({
      connect: async () => ({
        installationId: "fixture",
        devices: [{ did: "lamp", properties: [{ siid: 2, piid: 1, value: true, format: "bool" }] }],
      }),
      changes: async function* () {
        yield { kind: "property", did: "lamp", property: { siid: 9, piid: 9, value: "unregistered", format: "string" } } as const;
      },
      resync: async () => ({ installationId: "fixture", devices: [] }),
      dispose: async () => {},
    }),
  });
  const adapter = registration.factory({
    bridgeId: "xiaomi-unknown-property",
    config: { region: "cn", transport: "cloud" },
    credentials: { resolve: async () => undefined, describe: async () => ({ configured: false }) },
  });
  const events: Envelope[] = [];
  for await (const event of adapter.events(new AbortController().signal)) events.push(event);

  assert.equal(events.filter((event) => event.event.kind === "state").length, 1);
});

test("redacts unauthorized transport failures", async () => {
  const registration = createXiaomiHomeAdapterRegistration({
    credentialRequirements: [],
    create: () => ({
      connect: async () => { throw new Error("token=very-secret-value"); },
      changes: async function* () {},
      resync: async () => ({ installationId: "fixture", devices: [] }),
      dispose: async () => {},
    }),
  });
  const adapter = registration.factory({
    bridgeId: "xiaomi-redaction",
    config: { region: "cn", transport: "cloud" },
    credentials: { resolve: async () => undefined, describe: async () => ({ configured: false }) },
  });

  await assert.rejects(
    async () => { for await (const _event of adapter.events(new AbortController().signal)) { /* empty */ } },
    (error: unknown) => error instanceof BridgeStreamError
      && error.reason === "upstream_unavailable"
      && !error.message.includes("very-secret-value"),
  );
});

test("starts a fresh epoch for an explicit resync", async () => {
  const controller = new AbortController();
  let resyncCalls = 0;
  const registration = createXiaomiHomeAdapterRegistration({
    credentialRequirements: [],
    create: () => ({
      connect: async () => ({ installationId: "fixture", devices: [] }),
      changes: async function* (signal) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      resync: async () => {
        resyncCalls += 1;
        return { installationId: "fixture", devices: [] };
      },
      dispose: async () => {},
    }),
  });
  const adapter = registration.factory({
    bridgeId: "xiaomi-resync",
    config: { region: "cn", transport: "cloud" },
    credentials: { resolve: async () => undefined, describe: async () => ({ configured: false }) },
  });
  const iterator = adapter.events(controller.signal)[Symbol.asyncIterator]();
  const initialStart = await iterator.next();
  await iterator.next();

  assert.deepEqual(await adapter.control.requestResync(controller.signal), { status: "completed" });
  const resyncStart = await iterator.next();
  const resyncComplete = await iterator.next();
  assert.equal(resyncCalls, 1);
  assert.equal(initialStart.value?.event.kind, "sync-start");
  assert.equal(resyncStart.value?.event.kind, "sync-start");
  assert.equal(resyncComplete.value?.event.kind, "sync-complete");
  assert.notEqual(resyncStart.value?.epochId, initialStart.value?.epochId);
  if (resyncStart.value?.event.kind === "sync-start") assert.equal(resyncStart.value.event.reason, "resync");

  controller.abort();
  await iterator.next();
});

test("coalesces concurrent resync requests into one transport read", async () => {
  const controller = new AbortController();
  let resyncCalls = 0;
  let releaseResync!: () => void;
  const gate = new Promise<void>((resolve) => { releaseResync = resolve; });
  const registration = createXiaomiHomeAdapterRegistration({
    credentialRequirements: [],
    create: () => ({
      connect: async () => ({ installationId: "fixture", devices: [] }),
      changes: async function* (signal) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      resync: async () => {
        resyncCalls += 1;
        await gate;
        return { installationId: "fixture", devices: [] };
      },
      dispose: async () => {},
    }),
  });
  const adapter = registration.factory({
    bridgeId: "xiaomi-resync-coalesce",
    config: { region: "cn", transport: "cloud" },
    credentials: { resolve: async () => undefined, describe: async () => ({ configured: false }) },
  });
  const iterator = adapter.events(controller.signal)[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();

  const first = adapter.control.requestResync(controller.signal);
  const second = adapter.control.requestResync(controller.signal);
  await Promise.resolve();
  assert.equal(resyncCalls, 1);
  releaseResync();
  assert.deepEqual(await Promise.all([first, second]), [{ status: "completed" }, { status: "completed" }]);

  controller.abort();
  await iterator.next();
});

test("keeps Xiaomi transport pluggable and fails closed at the registration boundary", () => {
  const plugin = fixturePlugin();
  const registration = createXiaomiHomeAdapterRegistration(plugin);

  assert.equal(registration.adapterType, "xiaomi-home");
  assert.equal(registration.capabilitySchemas[0]?.schema, "miot.property");
  assert.deepEqual(registration.credentialRequirements, []);
});

test("consumes the Xiaomi registration through the neutral conformance harness", async () => {
  const registration = createXiaomiHomeAdapterRegistration(fixturePlugin());
  const report = await runBridgeAdapterConformance({
    registration,
    adapterType: registration.adapterType,
    bridgeId: "xiaomi-conformance",
    config: { region: "cn", transport: "cloud" },
    credentials: { resolve: async () => undefined, describe: async () => ({ configured: false }) },
    replay: {
      epochId: /^xiaomi-conformance:miot-[a-f0-9]{64}$/,
      snapshotId: /^miot-[a-f0-9]{64}$/,
      remoteInstanceId: deriveXiaomiRemoteInstanceId("cn", snapshot.installationId),
      deviceEnvelopeCount: 1,
      stateEnvelopeCount: 2,
    },
    extensionHandles: [],
  });

  assert.equal(report.passed, true);
});

test("rejects a transport semantic kind outside the reviewed neutral vocabulary", async () => {
  const registration = createXiaomiHomeAdapterRegistration({
    credentialRequirements: [],
    create: () => ({
      connect: async () => ({
        installationId: "fixture",
        devices: [{
          did: "device",
          properties: [{
            siid: 2,
            piid: 1,
            value: true,
            format: "bool",
            semanticKind: "vendor-magic",
          } as never],
        }],
      }),
      changes: async function* () {},
      resync: async () => ({ installationId: "fixture", devices: [] }),
      dispose: async () => {},
    }),
  });
  const adapter = registration.factory({
    bridgeId: "xiaomi-cn-home",
    config: { region: "cn", transport: "cloud" },
    credentials: { resolve: async () => undefined, describe: async () => ({ configured: false }) },
  });

  await assert.rejects(
    async () => {
      for await (const _event of adapter.events(new AbortController().signal)) void _event;
    },
    (error: unknown) => error instanceof BridgeStreamError && error.reason === "protocol_error",
  );
});

test("rejects malformed transport space metadata at the adapter boundary", async () => {
  const registration = createXiaomiHomeAdapterRegistration({
    credentialRequirements: [],
    create: () => ({
      connect: async () => ({
        installationId: "fixture",
        devices: [{
          did: "device",
          space: { nativeSpaceId: "", name: "Room" },
          properties: [{ siid: 2, piid: 1, value: true, format: "bool" }],
        }],
      }),
      changes: async function* () {},
      resync: async () => ({ installationId: "fixture", devices: [] }),
      dispose: async () => {},
    }),
  });
  const adapter = registration.factory({
    bridgeId: "xiaomi-cn-home",
    config: { region: "cn", transport: "cloud" },
    credentials: { resolve: async () => undefined, describe: async () => ({ configured: false }) },
  });

  await assert.rejects(
    async () => {
      for await (const _event of adapter.events(new AbortController().signal)) void _event;
    },
    (error: unknown) => error instanceof BridgeStreamError && error.reason === "protocol_error",
  );
});
