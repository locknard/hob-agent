import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeStreamError,
  type BridgeEvent,
  type Envelope,
} from "../../../contracts/bridge-contract.js";
import { BridgeCatalog } from "./bridge-catalog.js";
import { BridgeRegistry, MemoryBridgeRegistryStore } from "./bridge-registry.js";
import {
  HOME_ASSISTANT_ACCESS_TOKEN_ALIAS,
  HOME_ASSISTANT_ADAPTER_REGISTRATION,
  HomeAssistantBridgeAdapter,
  createHomeAssistantBridgeAdapter,
  deriveHomeAssistantRemoteInstanceId,
  toHomeAssistantWebSocketUrl,
  type HomeAssistantAdapterConfig,
  type WebSocketLike,
} from "./home-assistant-bridge.js";

class FakeSocket implements WebSocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  onclose: (() => void) | undefined;
  onerror: ((error: Error) => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.onclose?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  receiveRaw(data: string): void {
    this.onmessage?.({ data });
  }
}

const config: HomeAssistantAdapterConfig = {
  baseUrl: "http://ha.local:8123",
  authenticationPrincipal: "owner-a",
};

function credentials(value = "ha-secret") {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      async resolve(alias: string) {
        calls.push(alias);
        return alias === HOME_ASSISTANT_ACCESS_TOKEN_ALIAS
          ? { kind: "secret_text" as const, value }
          : undefined;
      },
      async describe() {
        return { configured: true };
      },
    },
  };
}

function createAdapter(
  socket: FakeSocket,
  configOverride: Partial<HomeAssistantAdapterConfig> = {},
  dependencyOverride: Record<string, unknown> = {},
) {
  const scoped = credentials();
  const adapter = createHomeAssistantBridgeAdapter(
    {
      bridgeId: "bridge-ha",
      config: { ...config, ...configOverride },
      credentials: scoped.provider,
    },
    { socketFactory: () => socket, snapshotIdFactory: () => "snapshot-1", ...dependencyOverride },
  );
  return { adapter, calls: scoped.calls };
}

function respondToBootstrap(
  socket: FakeSocket,
  entityId = "light.kitchen",
  deviceRegistry: readonly unknown[] = [{ id: "device-1", name: "Kitchen", identifiers: [["ha", "secret-id"]] }],
): void {
  socket.receive({ type: "auth_required", ha_version: "2026.8.0" });
  socket.receive({ type: "auth_ok", ha_version: "2026.8.0" });
  const commands = socket.sent.slice(1) as Array<{ id: number; type: string }>;
  for (const command of commands) {
    const result = command.type === "get_states"
      ? [{
          entity_id: entityId,
          state: "on",
          attributes: {
            friendly_name: "Kitchen light",
            brightness: 200,
            unit_of_measurement: "%",
            secret_attribute: "must-not-cross-contract",
          },
          last_updated: "2026-08-18T00:00:01.000Z",
        }]
        : command.type === "config/entity_registry/list"
          ? [{ id: "entity-stable-1", entity_id: entityId, device_id: "device-1", name: "Kitchen light" }]
        : command.type === "config/device_registry/list"
          ? deviceRegistry
          : [];
    socket.receive({ id: command.id, type: "result", success: true, result });
  }
}

async function readSnapshot(adapter: HomeAssistantBridgeAdapter, socket: FakeSocket): Promise<Envelope[]> {
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket);
  const events: Envelope[] = [(await first).value!];
  for (let index = 0; index < 4; index += 1) events.push((await iterator.next()).value!);
  await adapter.control.dispose();
  return events;
}

test("factory construction is synchronous and does not resolve credentials or touch the socket", () => {
  const socket = new FakeSocket();
  let socketCalls = 0;
  const scoped = credentials();
  const adapter = HOME_ASSISTANT_ADAPTER_REGISTRATION.factory({
    bridgeId: "bridge-ha",
    config,
    credentials: scoped.provider,
  });

  assert.equal(adapter instanceof HomeAssistantBridgeAdapter, true);
  assert.equal(socketCalls, 0);
  assert.deepEqual(scoped.calls, []);
  assert.deepEqual(adapter.info, {
    bridgeId: "bridge-ha",
    coreVersion: "6.3.0",
    ecosystem: "home-assistant",
    heartbeatIntervalMs: 60_000,
    extensions: [],
  });
  void socket;
  void socketCalls;
});

test("rejects userinfo in Home Assistant URLs without echoing embedded credentials", () => {
  const baseUrl = "https://alice:do-not-echo@ha.local:8123";
  const parsed = HOME_ASSISTANT_ADAPTER_REGISTRATION.configSchema.safeParse({ baseUrl });
  assert.equal(parsed.success, false);
  if (!parsed.success) assert.equal(parsed.error.message.includes("do-not-echo"), false);

  assert.throws(
    () => toHomeAssistantWebSocketUrl(baseUrl),
    (error: unknown) => error instanceof Error && !error.message.includes("do-not-echo"),
  );
});

test("catalog and registry load the HA registration without binding a remote before sync-start", () => {
  const catalog = new BridgeCatalog();
  catalog.register(HOME_ASSISTANT_ADAPTER_REGISTRATION);
  const store = new MemoryBridgeRegistryStore();
  const scoped = credentials();
  const registry = new BridgeRegistry({ catalog, store, credentialSource: scoped.provider });
  const adapter = registry.load({ bridgeId: "bridge-ha", adapterType: "home-assistant", config });

  assert.equal(adapter.info.bridgeId, "bridge-ha");
  assert.equal("remoteInstanceId" in adapter.info, false);
  assert.equal(registry.binding("bridge-ha")?.remoteInstanceId, undefined);
  const binding = registry.validateOrBindRemoteInstanceId("bridge-ha", "ha:remote-a");
  assert.equal(binding.remoteInstanceId, "ha:remote-a");
  assert.deepEqual(scoped.calls, []);
});

test("events resolve the scoped token and emit a neutral snapshot in the frozen order", async () => {
  const socket = new FakeSocket();
  const { adapter, calls } = createAdapter(socket);
  const events = await readSnapshot(adapter, socket);

  assert.deepEqual(calls, [HOME_ASSISTANT_ACCESS_TOKEN_ALIAS]);
  assert.deepEqual(events.map((envelope) => envelope.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(events.map((envelope) => envelope.event.kind), [
    "sync-start",
    "device-upserted",
    "state",
    "device-health",
    "sync-complete",
  ]);

  const start = events[0]!.event as Extract<BridgeEvent, { kind: "sync-start" }>;
  assert.equal(start.remoteInstanceId, deriveHomeAssistantRemoteInstanceId(config.baseUrl, config.authenticationPrincipal));
  assert.equal(start.snapshotId, "snapshot-1");
  const descriptor = (events[1]!.event as Extract<BridgeEvent, { kind: "device-upserted" }>).device;
  assert.equal(descriptor.nativeId, "device-1");
  assert.deepEqual(descriptor.capabilities, [{
    nativeInstanceId: "entity-stable-1",
    schema: "ha.entity",
    schemaVersion: "1.0.0",
  }]);

  const state = (events[2]!.event as Extract<BridgeEvent, { kind: "state" }>).state;
  assert.equal(state.nativeId, "device-1");
  assert.equal(state.nativeInstanceId, "entity-stable-1");
  assert.deepEqual(state.attrs, {
    state: "on",
    brightness: 200,
    unit: "%",
    unknownAttributeCount: 2,
  });
  assert.equal(JSON.stringify(state).includes("must-not-cross-contract"), false);

  assert.deepEqual(events[3]!.event, {
    kind: "device-health",
    nativeId: "device-1",
    status: "reachable",
  });
  assert.deepEqual((events[4]!.event as Extract<BridgeEvent, { kind: "sync-complete" }>).manifest, {
    snapshotId: "snapshot-1",
    deviceEnvelopeCount: 1,
    stateEnvelopeCount: 1,
  });
});

test("maps bounded Home Assistant device connections and identifiers into platform identity claims", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket, "light.kitchen", [{
    id: "device-1",
    name: "Kitchen",
    connections: [["mac", "AA:BB:CC:DD:EE:FF"], ["serial_number", "SN-123"]],
    identifiers: [["manufacturer", "ignored"], ["serial_number", "SN-123"], ["ha", "opaque"]],
  }]);
  const events: Envelope[] = [(await first).value!];
  for (let index = 0; index < 4; index += 1) events.push((await iterator.next()).value!);
  const descriptor = (events[1]!.event as Extract<BridgeEvent, { kind: "device-upserted" }>).device;

  assert.deepEqual(descriptor.identityClaims, [
    {
      type: "mac",
      value: "AA:BB:CC:DD:EE:FF",
      source: { kind: "platform_registry", platform: "home-assistant" },
      confidence: "high",
    },
    {
      type: "serial",
      value: "SN-123",
      source: { kind: "platform_registry", platform: "home-assistant" },
      confidence: "high",
    },
  ]);
  await adapter.control.dispose();
});

test("entity renames retain the entity registry id and device registry aggregation", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket, "light.kitchen_renamed");
  const events: Envelope[] = [(await first).value!];
  for (let index = 0; index < 4; index += 1) events.push((await iterator.next()).value!);
  const descriptor = (events[1]!.event as Extract<BridgeEvent, { kind: "device-upserted" }>).device;
  const state = (events[2]!.event as Extract<BridgeEvent, { kind: "state" }>).state;

  assert.equal(descriptor.nativeId, "device-1");
  assert.equal(descriptor.capabilities[0]?.nativeInstanceId, "entity-stable-1");
  assert.equal(state.nativeInstanceId, "entity-stable-1");
  await adapter.control.dispose();
});

test("incremental state events stay bound to the stable registry id and emit health changes", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const controller = new AbortController();
  const iterator = adapter.events(controller.signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket);
  await first;
  for (let index = 0; index < 4; index += 1) await iterator.next();

  const next = iterator.next();
  const subscription = socket.sent.find((message) => message.type === "subscribe_events");
  assert.notEqual(subscription, undefined);
  socket.receive({
    id: subscription!.id,
    type: "event",
    event: {
      event_type: "state_changed",
      time_fired: "2026-08-18T00:00:02.000Z",
      data: {
        entity_id: "light.kitchen",
        new_state: { state: "unavailable", attributes: { secret_attribute: "do-not-forward" } },
      },
    },
  });
  const stateEnvelope = await next;
  assert.equal(stateEnvelope.value?.seq, 6);
  assert.equal((stateEnvelope.value?.event as Extract<BridgeEvent, { kind: "state" }>).state.nativeInstanceId, "entity-stable-1");
  assert.equal(JSON.stringify(stateEnvelope.value).includes("do-not-forward"), false);
  const healthEnvelope = await iterator.next();
  assert.deepEqual(healthEnvelope.value?.event, {
    kind: "device-health",
    nativeId: "device-1",
    status: "unreachable",
  });

  await adapter.control.dispose();
  controller.abort();
  assert.equal((await iterator.next()).done, true);
});

test("the registered HA attrs schema is strict at the neutral boundary", () => {
  const attrsSchema = HOME_ASSISTANT_ADAPTER_REGISTRATION.capabilitySchemas[0]!.attrsSchema;
  assert.equal(attrsSchema.safeParse({ state: "on", secret_attribute: "must-fail" }).success, false);
  assert.equal(attrsSchema.safeParse({
    state: "on",
    unknownAttributeCount: 1,
  }).success, true);
});

test("conservatively derives remote identity without using the access token", () => {
  const first = deriveHomeAssistantRemoteInstanceId("https://ha.local:8123", "owner-a");
  const changedUrl = deriveHomeAssistantRemoteInstanceId("https://other.local:8123", "owner-a");
  const changedPrincipal = deriveHomeAssistantRemoteInstanceId("https://ha.local:8123", "owner-b");

  assert.match(first, /^ha:[0-9a-f]{64}$/);
  assert.notEqual(first, changedUrl);
  assert.notEqual(first, changedPrincipal);
  assert.equal(first.includes("ha-secret"), false);
});

test("maps authentication failure to a redacted BridgeStreamError", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  socket.receive({ type: "auth_required" });
  socket.receive({ type: "auth_invalid", message: "token ha-secret rejected" });

  await assert.rejects(first, (error: unknown) => {
    assert.equal(error instanceof BridgeStreamError, true);
    assert.equal((error as BridgeStreamError).reason, "authentication_failed");
    assert.equal(String(error).includes("ha-secret"), false);
    return true;
  });
});

test("maps a post-startup transport failure to upstream_unavailable", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket);
  await first;
  for (let index = 0; index < 4; index += 1) await iterator.next();

  const next = iterator.next();
  socket.onerror?.(new Error("ECONNRESET"));
  await assert.rejects(next, (error: unknown) => {
    assert.equal(error instanceof BridgeStreamError, true);
    assert.equal((error as BridgeStreamError).reason, "upstream_unavailable");
    return true;
  });
});

test("control accepts resync, emits a fresh replay epoch, and dispose ends the lifecycle", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket);
  const initialStart = (await first).value!;
  const initialEpochId = initialStart.epochId;
  await iterator.next();
  await iterator.next();
  await iterator.next();
  await iterator.next();

  const previousCommandCount = socket.sent.length;
  const resync = adapter.control.requestResync(new AbortController().signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(await resync, { status: "completed" });
  const resyncCommands = socket.sent.slice(previousCommandCount) as Array<{ id: number; type: string }>;
  assert.deepEqual(resyncCommands.map((command) => command.type), [
    "get_states",
    "config/entity_registry/list",
    "config/device_registry/list",
    "config/area_registry/list",
  ]);
  for (const command of resyncCommands) {
    const result = command.type === "get_states"
      ? [{ entity_id: "light.kitchen", state: "off", attributes: {}, last_updated: "2026-08-18T00:00:03.000Z" }]
      : command.type === "config/entity_registry/list"
        ? [{ id: "entity-stable-1", entity_id: "light.kitchen", device_id: "device-1", name: "Kitchen light" }]
        : command.type === "config/device_registry/list"
          ? [{ id: "device-1", name: "Kitchen" }]
          : [];
    socket.receive({ id: command.id, type: "result", success: true, result });
  }
  const replayStart = (await iterator.next()).value!;
  assert.equal(replayStart.seq, 1);
  assert.equal((replayStart.event as Extract<BridgeEvent, { kind: "sync-start" }>).reason, "resync");
  assert.notEqual(replayStart.epochId, initialEpochId);
  for (let index = 0; index < 4; index += 1) await iterator.next();
  await adapter.control.dispose();
  await assert.rejects(
    Promise.resolve().then(() => adapter.events(new AbortController().signal)),
    (error: unknown) => error instanceof BridgeStreamError && error.reason === "protocol_error",
  );
});

test("emits heartbeat envelopes during a silent incremental stream", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket, {}, { heartbeatIntervalMs: 5 });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket);
  await first;
  for (let index = 0; index < 4; index += 1) await iterator.next();

  const heartbeat = await iterator.next();
  assert.equal(heartbeat.value?.event.kind, "heartbeat");
  await adapter.control.dispose();
});

test("fails closed when the bounded native event queue overflows", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket, {}, { maxBufferedEvents: 1 });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket);
  await first;
  for (let index = 0; index < 4; index += 1) await iterator.next();

  const firstIncremental = iterator.next();
  const subscription = socket.sent.find((message) => message.type === "subscribe_events");
  const stateChanged = (entityId: string, state: string) => ({
    id: subscription!.id,
    type: "event",
    event: {
      event_type: "state_changed",
      time_fired: "2026-08-18T00:00:04.000Z",
      data: { entity_id: entityId, new_state: { state, attributes: {} } },
    },
  });
  socket.receive(stateChanged("light.kitchen", "on"));
  await firstIncremental;
  socket.receive(stateChanged("light.kitchen", "off"));
  socket.receive(stateChanged("light.kitchen", "on"));
  await assert.rejects(iterator.next(), (error: unknown) =>
    error instanceof BridgeStreamError && error.reason === "internal_error");
});

test("rejects oversized raw websocket messages before JSON parsing", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  socket.receiveRaw(`{"type":"auth_required","padding":"${"x".repeat(1_100_000)}"}`);

  await assert.rejects(first, (error: unknown) =>
    error instanceof BridgeStreamError && error.reason === "protocol_error");
});
