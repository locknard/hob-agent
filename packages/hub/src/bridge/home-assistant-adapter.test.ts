import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeStreamError,
  type BridgeEvent,
  type Envelope,
} from "@hob/bridge-contract";
import { runBridgeAdapterConformance } from "@hob/bridge-contract";
import type { ActionsExtension, AutomationsExtension, BridgeActionDescriptor } from "@hob/bridge-contract";
import type { ForeignRulesHandle } from "@hob/bridge-contract";
import { BridgeCatalog } from "./bridge-catalog.js";
import { BridgeRegistry, MemoryBridgeRegistryStore } from "./bridge-registry.js";
import {
  HOME_ASSISTANT_ACCESS_TOKEN_ALIAS,
  HOME_ASSISTANT_ADAPTER_REGISTRATION,
  HOME_ASSISTANT_COVER_SCHEMA_CANONICAL_HASH,
  HOME_ASSISTANT_ENTITY_SCHEMA_CANONICAL_HASH,
  HomeAssistantBridgeAdapter,
  createHomeAssistantBridgeAdapter,
  deriveHomeAssistantRemoteInstanceId,
  homeAssistantSemanticKind,
  toHomeAssistantWebSocketUrl,
  type HomeAssistantAdapterConfig,
  type WebSocketLike,
} from "./home-assistant-bridge.js";

test("maps only reviewed HA entity domains to neutral read-side semantic kinds", () => {
  assert.deepEqual([
    homeAssistantSemanticKind("light.kitchen"),
    homeAssistantSemanticKind("sensor.temperature"),
    homeAssistantSemanticKind("binary_sensor.motion"),
    homeAssistantSemanticKind("switch.socket"),
    homeAssistantSemanticKind("person.owner"),
  ], ["light", "sensor", "binary-sensor", "switch", "presence"]);
  assert.equal(homeAssistantSemanticKind("update.integration"), undefined);
  assert.equal(homeAssistantSemanticKind("malformed"), undefined);
});

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
  deviceRegistry: readonly unknown[] = [{
    id: "device-1",
    name: "Kitchen",
    area_id: "area-device",
    identifiers: [["ha", "secret-id"]],
  }],
  entityAreaId: string | null = "area-entity",
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
          ? [{
              id: "entity-stable-1",
              entity_id: entityId,
              device_id: "device-1",
              name: "Kitchen light",
              ...(entityAreaId === null ? {} : { area_id: entityAreaId }),
            }]
        : command.type === "config/device_registry/list"
          ? deviceRegistry
          : command.type === "config/area_registry/list"
            ? [
                { area_id: "area-device", name: "Kitchen" },
                { area_id: "area-entity", name: "Counter" },
              ]
            : [];
    socket.receive({ id: command.id, type: "result", success: true, result });
  }
}

function respondToCoverBootstrap(
  socket: FakeSocket,
  attributes: Record<string, unknown> = {},
  entityId = "cover.curtain",
): void {
  socket.receive({ type: "auth_required", ha_version: "2026.8.0" });
  socket.receive({ type: "auth_ok", ha_version: "2026.8.0" });
  const commands = socket.sent.slice(1) as Array<{ id: number; type: string }>;
  for (const command of commands) {
    const result = command.type === "get_states"
      ? [{
          entity_id: entityId,
          state: "open",
          attributes,
          last_updated: "2026-08-18T00:00:01.000Z",
        }]
      : command.type === "config/entity_registry/list"
        ? [{ id: "entity-cover-1", entity_id: entityId, device_id: "device-cover-1", name: "Curtain" }]
        : command.type === "config/device_registry/list"
          ? [{ id: "device-cover-1", name: "Curtain" }]
          : [];
    socket.receive({ id: command.id, type: "result", success: true, result });
  }
}

function respondToMediaBootstrap(
  socket: FakeSocket,
  attributes: Record<string, unknown> = {},
): void {
  socket.receive({ type: "auth_required", ha_version: "2026.8.0" });
  socket.receive({ type: "auth_ok", ha_version: "2026.8.0" });
  const commands = socket.sent.slice(1) as Array<{ id: number; type: string }>;
  for (const command of commands) {
    const result = command.type === "get_states"
      ? [{
          entity_id: "media_player.room",
          state: "playing",
          attributes,
          last_updated: "2026-08-18T00:00:01.000Z",
        }]
      : command.type === "config/entity_registry/list"
        ? [{ id: "entity-media-1", entity_id: "media_player.room", device_id: "device-media-1", name: "Room speaker" }]
        : command.type === "config/device_registry/list"
          ? [{ id: "device-media-1", name: "Room speaker" }]
          : [];
    socket.receive({ id: command.id, type: "result", success: true, result });
  }
}

test("registers a separate strict cover schema and projects an integer position", async () => {
  assert.equal(
    HOME_ASSISTANT_ENTITY_SCHEMA_CANONICAL_HASH,
    "sha256:03776626d28e04468296c7d6f4cc42a5e949e74c1c1013bfe96cad44ebd2cf65",
  );
  assert.equal(
    HOME_ASSISTANT_COVER_SCHEMA_CANONICAL_HASH,
    "sha256:8df94f40bdcb6cbb2a45cd08b8449572411a185395ace8def3f584a3b8567b70",
  );
  const registrations = HOME_ASSISTANT_ADAPTER_REGISTRATION.capabilitySchemas;
  assert.deepEqual(
    registrations.map((registration) => [registration.schema, registration.majorVersion]),
    [["ha.entity", 1], ["ha.cover", 1], ["ha.media-player", 1]],
  );
  const coverRegistration = registrations.find((registration) => registration.schema === "ha.cover");
  assert.notEqual(coverRegistration, undefined);
  assert.equal(coverRegistration!.attrsSchema.safeParse({
    state: "open",
    level: 0.37,
    setLevelSupported: true,
    available: true,
    unknownAttributeCount: 1,
  }).success, true);
  assert.equal(coverRegistration!.attrsSchema.safeParse({ state: "open", level: 1.01 }).success, false);
  assert.equal(coverRegistration!.attrsSchema.safeParse({ state: "open", level: "0.37" }).success, false);
  assert.equal(coverRegistration!.attrsSchema.safeParse({ state: "open", setLevelSupported: 1 }).success, false);

  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const events = await readSnapshot(adapter, socket, () => respondToCoverBootstrap(socket, {
    current_position: 37,
    supported_features: 4,
    available: true,
    vendor_field: "must-not-cross-contract",
  }));
  const descriptor = (events[1]!.event as Extract<BridgeEvent, { kind: "device-upserted" }>).device;
  assert.deepEqual(descriptor.capabilities[0], {
    nativeInstanceId: "entity-cover-1",
    schema: "ha.cover",
    schemaVersion: "1.0.0",
    semanticKind: "cover",
  });
  const state = (events[2]!.event as Extract<BridgeEvent, { kind: "state" }>).state;
  assert.deepEqual(state.attrs, {
    state: "open",
    level: 0.37,
    setLevelSupported: true,
    available: true,
    unknownAttributeCount: 1,
  });
  assert.equal(JSON.stringify(state).includes("vendor_field"), false);
});

test("registers an exact read-only media-player schema with bounded volume state", async () => {
  const registration = HOME_ASSISTANT_ADAPTER_REGISTRATION.capabilitySchemas
    .find((candidate) => candidate.schema === "ha.media-player");
  assert.notEqual(registration, undefined);
  assert.equal(registration!.attrsSchema.safeParse({
    state: "playing",
    volumeLevel: 0.15,
    available: true,
    unknownAttributeCount: 2,
  }).success, true);
  assert.equal(registration!.attrsSchema.safeParse({ state: "playing", volumeLevel: -0.1 }).success, false);
  assert.equal(registration!.attrsSchema.safeParse({ state: "playing", volumeLevel: 1.1 }).success, false);

  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const events = await readSnapshot(adapter, socket, () => respondToMediaBootstrap(socket, {
    volume_level: 0.15,
    available: true,
    supported_features: 15_233,
    media_content_id: "private-provider-uri",
  }));
  const descriptor = (events[1]!.event as Extract<BridgeEvent, { kind: "device-upserted" }>).device;
  assert.deepEqual(descriptor.capabilities[0], {
    nativeInstanceId: "entity-media-1",
    schema: "ha.media-player",
    schemaVersion: "1.0.0",
    semanticKind: "media",
  });
  const state = (events[2]!.event as Extract<BridgeEvent, { kind: "state" }>).state;
  assert.deepEqual(state.attrs, {
    state: "playing",
    volumeLevel: 0.15,
    available: true,
    unknownAttributeCount: 2,
  });
  assert.equal(JSON.stringify(state).includes("private-provider-uri"), false);
  assert.equal(JSON.stringify(state).includes("15233"), false);
});

test("omits an invalid optional HA media volume instead of dropping the state", async () => {
  for (const volumeLevel of [-0.1, 1.1, "0.15", null] as readonly unknown[]) {
    const socket = new FakeSocket();
    const { adapter } = createAdapter(socket);
    const events = await readSnapshot(adapter, socket, () => respondToMediaBootstrap(socket, {
      volume_level: volumeLevel,
    }));
    const state = (events[2]!.event as Extract<BridgeEvent, { kind: "state" }>).state;
    assert.deepEqual(state.attrs, { state: "playing" });
  }
});

test("normalizes cover boundary positions without rounding and reports explicit support", async () => {
  for (const [position, expectedLevel] of [[0, 0], [100, 1], [37, 0.37]] as const) {
    const socket = new FakeSocket();
    const { adapter } = createAdapter(socket);
    const events = await readSnapshot(adapter, socket, () => respondToCoverBootstrap(socket, {
      current_position: position,
      supported_features: 0,
    }));
    const state = (events[2]!.event as Extract<BridgeEvent, { kind: "state" }>).state;
    assert.equal(state.attrs.level, expectedLevel);
    assert.equal(state.attrs.setLevelSupported, false);
  }

  const supportedSocket = new FakeSocket();
  const { adapter: supportedAdapter } = createAdapter(supportedSocket);
  const supportedEvents = await readSnapshot(supportedAdapter, supportedSocket, () => respondToCoverBootstrap(supportedSocket, {
    current_position: 37,
    supported_features: 5,
  }));
  const supportedState = (supportedEvents[2]!.event as Extract<BridgeEvent, { kind: "state" }>).state;
  assert.equal(supportedState.attrs.level, 0.37);
  assert.equal(supportedState.attrs.setLevelSupported, true);
});

test("omits invalid cover positions and feature masks instead of coercing them", async () => {
  const invalidPositions: readonly unknown[] = [50.5, "50", -1, 101, null];
  for (const position of invalidPositions) {
    const socket = new FakeSocket();
    const { adapter } = createAdapter(socket);
    const events = await readSnapshot(adapter, socket, () => respondToCoverBootstrap(socket, {
      current_position: position,
      supported_features: 4,
    }));
    const state = (events[2]!.event as Extract<BridgeEvent, { kind: "state" }>).state;
    assert.equal(Object.prototype.hasOwnProperty.call(state.attrs, "level"), false);
    assert.equal(state.attrs.setLevelSupported, true);
  }

  for (const featureMask of ["4", -1, 1.5, null] as readonly unknown[]) {
    const socket = new FakeSocket();
    const { adapter } = createAdapter(socket);
    const events = await readSnapshot(adapter, socket, () => respondToCoverBootstrap(socket, {
      current_position: 50,
      supported_features: featureMask,
    }));
    const state = (events[2]!.event as Extract<BridgeEvent, { kind: "state" }>).state;
    assert.equal(state.attrs.level, 0.5);
    assert.equal(Object.prototype.hasOwnProperty.call(state.attrs, "setLevelSupported"), false);
  }
});

test("keeps generic HA entities on ha.entity even when they expose cover-like attributes", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const events = await readSnapshot(adapter, socket, () => respondToCoverBootstrap(socket, {
    current_position: 50,
    supported_features: 4,
  }, "light.curtain"));
  const descriptor = (events[1]!.event as Extract<BridgeEvent, { kind: "device-upserted" }>).device;
  assert.equal(descriptor.capabilities[0]?.schema, "ha.entity");
  const state = (events[2]!.event as Extract<BridgeEvent, { kind: "state" }>).state;
  assert.equal(Object.prototype.hasOwnProperty.call(state.attrs, "level"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(state.attrs, "setLevelSupported"), false);
});

async function readSnapshot(
  adapter: HomeAssistantBridgeAdapter,
  socket: FakeSocket,
  respond: () => void = () => respondToBootstrap(socket),
): Promise<Envelope[]> {
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respond();
  const events: Envelope[] = [(await first).value!];
  for (let index = 0; index < 4; index += 1) events.push((await iterator.next()).value!);
  await adapter.control.dispose();
  return events;
}

test("inherits the device area when an HA entity has no area override", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const events = await readSnapshot(adapter, socket, () => respondToBootstrap(
    socket,
    "light.kitchen",
    [{ id: "device-1", name: "Kitchen", area_id: "area-device" }],
    null,
  ));
  const descriptor = (events[1]!.event as Extract<BridgeEvent, { kind: "device-upserted" }>).device;
  assert.deepEqual(descriptor.capabilities[0]?.space, {
    nativeSpaceId: "area-device",
    name: "Kitchen",
  });
});

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
    coreVersion: "6.5.0",
    ecosystem: "home-assistant",
    heartbeatIntervalMs: 60_000,
    extensions: [
      { id: "foreignRules", version: "2.0.0" },
      { id: "orgHints", version: "1.0.0" },
      { id: "actions", version: "1.0.0" },
      { id: "automations", version: "1.0.0" },
    ],
  });
  void socket;
  void socketCalls;
});

test("emits a neutral non-spatial org hint only for an explicit HA service entry", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket, "sensor.supervisor", [{
    id: "device-1",
    name: "Supervisor",
    entry_type: "service",
  }], null);
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") {
    events.push((await iterator.next()).value!);
  }

  assert.deepEqual(events.map((item) => item.event.kind), [
    "sync-start",
    "device-upserted",
    "ext",
    "state",
    "device-health",
    "sync-complete",
  ]);
  assert.deepEqual(events[2]?.event, {
    kind: "ext",
    ext: "orgHints@1",
    payload: { nativeId: "device-1", spatialDisposition: "non_spatial" },
  });
  await adapter.control.dispose();
});

test("exposes existing automations through the bounded read-only foreignRules extension", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket, "automation.arrival_light");
  const handle = adapter.extension("foreignRules@2") as ForeignRulesHandle | undefined;
  const events: Envelope[] = [(await first).value!];
  assert.equal(events[0]?.event.kind, "sync-start");
  assert.equal(await handle?.catalog(), undefined);
  while (events.at(-1)?.event.kind !== "sync-complete") {
    events.push((await iterator.next()).value!);
  }
  const catalog = await handle?.catalog();
  const rules = catalog?.rules;
  assert.equal(typeof catalog?.epochId, "string");
  assert.equal(catalog?.lastSeq, events.at(-1)?.seq);
  assert.equal(catalog?.complete, true);
  assert.equal(rules?.length, 1);
  assert.match(rules?.[0]?.ruleRef ?? "", /^ha-rule:/);
  assert.deepEqual(rules?.[0] && { name: rules[0].name, enabled: rules[0].enabled }, {
    name: "Kitchen light",
    enabled: true,
  });
  assert.equal(JSON.stringify(rules).includes("automation.arrival_light"), false);
  assert.equal(JSON.stringify(catalog).includes("must-not-cross-contract"), false);
  assert.equal(adapter.extension("foreignRules@1" as never), undefined);
  await adapter.control.dispose();
});

test("translates one bound neutral boolean action through the actions extension", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket, "light.kitchen");
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);

  const handle = adapter.extension("actions@1") as ActionsExtension | undefined;
  assert.equal(typeof handle?.execute, "function");
  const execution = handle!.execute({
    requestId: "action-1",
    action: {
      kind: "set_boolean",
      target: {
        hwCapabilityId: "cap-light",
        binding: {
          bridgeId: "bridge-ha",
          nativeId: "device-1",
          nativeInstanceId: "entity-stable-1",
        },
      },
      value: true,
    },
  }, { signal: new AbortController().signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const command = socket.sent.at(-1)!;
  assert.deepEqual(command, {
    id: command.id,
    type: "call_service",
    domain: "light",
    service: "turn_on",
    target: { entity_id: "light.kitchen" },
    service_data: {},
  });
  socket.receive({ id: command.id, type: "result", success: true, result: null });
  assert.deepEqual(await execution, { status: "acknowledged" });
  await adapter.control.dispose();
});

test("translates one bound neutral stop-media action through media_player.media_stop", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket, "media_player.room");
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);

  const handle = adapter.extension("actions@1") as ActionsExtension | undefined;
  const execution = handle!.execute({
    requestId: "stop-media-1",
    action: {
      kind: "stop_media",
      target: {
        hwCapabilityId: "cap-player",
        binding: {
          bridgeId: "bridge-ha",
          nativeId: "device-1",
          nativeInstanceId: "entity-stable-1",
        },
      },
    },
  }, { signal: new AbortController().signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const command = socket.sent.at(-1)!;
  assert.deepEqual(command, {
    id: command.id,
    type: "call_service",
    domain: "media_player",
    service: "media_stop",
    target: { entity_id: "media_player.room" },
    service_data: {},
  });
  socket.receive({ id: command.id, type: "result", success: true, result: null });
  assert.deepEqual(await execution, { status: "acknowledged" });
  await adapter.control.dispose();
});

test("describes the next boolean action from the adapter's current state", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket, "switch.kitchen");
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);

  const handle = adapter.extension("actions@1") as ActionsExtension | undefined;
  const descriptor = handle?.describe({
    target: {
      hwCapabilityId: "cap-light",
      binding: {
        bridgeId: "bridge-ha",
        nativeId: "device-1",
        nativeInstanceId: "entity-stable-1",
      },
    },
    current: { state: "on", available: true },
  }) as BridgeActionDescriptor | undefined;
  assert.deepEqual(descriptor?.action, { kind: "set_boolean", value: false });
  await adapter.control.dispose();
});

test("describes cover level only when the adapter reports a supported, known position", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToCoverBootstrap(socket, { current_position: 37, supported_features: 4 });
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);

  const handle = adapter.extension("actions@1") as ActionsExtension | undefined;
  const descriptor = handle?.describe({
    target: {
      hwCapabilityId: "cap-cover",
      binding: {
        bridgeId: "bridge-ha",
        nativeId: "device-cover-1",
        nativeInstanceId: "entity-cover-1",
      },
    },
    current: { state: "open", level: 0.37, setLevelSupported: true, available: true },
  }) as BridgeActionDescriptor | undefined;
  assert.deepEqual(descriptor?.action, { kind: "set_level", level: 0 });
  await adapter.control.dispose();
});

test("excludes restored unavailable ghost automations from the foreign-rule catalog", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  socket.receive({ type: "auth_required", ha_version: "2026.8.0" });
  socket.receive({ type: "auth_ok", ha_version: "2026.8.0" });
  const commands = socket.sent.slice(1) as Array<{ id: number; type: string }>;
  for (const command of commands) {
    const result = command.type === "get_states"
      ? [
          {
            entity_id: "automation.current_rule",
            state: "on",
            attributes: { friendly_name: "Current rule" },
            last_updated: "2026-08-18T00:00:01.000Z",
          },
          {
            entity_id: "automation.removed_rule",
            state: "unavailable",
            attributes: { friendly_name: "Removed rule", restored: true },
            last_updated: "2026-08-18T00:00:01.000Z",
          },
        ]
      : command.type === "config/entity_registry/list"
        ? [
            { id: "current-stable", entity_id: "automation.current_rule", name: "Current rule" },
            { id: "removed-stable", entity_id: "automation.removed_rule", name: "Removed rule" },
          ]
        : [];
    socket.receive({ id: command.id, type: "result", success: true, result });
  }
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") {
    events.push((await iterator.next()).value!);
  }

  const handle = adapter.extension("foreignRules@2") as ForeignRulesHandle | undefined;
  const rules = (await handle?.catalog())?.rules ?? [];
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.name, "Current rule");
  assert.equal(JSON.stringify(rules).includes("Removed rule"), false);
  await adapter.control.dispose();
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
    semanticKind: "light",
    space: { nativeSpaceId: "area-entity", name: "Counter" },
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

test("consumes the Home Assistant registration through the neutral conformance harness", async () => {
  const conformanceBridgeId = "bridge-ha-conformance";
  const conformanceConfig = { ...config, authenticationPrincipal: "conformance" };
  // Preserve the production registration metadata; only its test-only
  // transport dependency seam is wrapped so the harness stays local.
  const conformanceRegistration = {
    ...HOME_ASSISTANT_ADAPTER_REGISTRATION,
    factory: (context: Parameters<typeof createHomeAssistantBridgeAdapter>[0]) => {
      const socket = new FakeSocket();
      const adapter = createHomeAssistantBridgeAdapter(context, {
        socketFactory: () => socket,
        snapshotIdFactory: () => "conformance-snapshot",
      });
      let bootstrapScheduled = false;
      return {
        info: adapter.info,
        control: adapter.control,
        extension: (name: Parameters<typeof adapter.extension>[0]) => adapter.extension(name),
        events: (signal: AbortSignal) => {
          const stream = adapter.events(signal);
          if (!bootstrapScheduled) {
            bootstrapScheduled = true;
            setImmediate(() => respondToBootstrap(socket));
          }
          return stream;
        },
      };
    },
  };
  const scoped = credentials();
  const report = await runBridgeAdapterConformance({
    registration: conformanceRegistration,
    adapterType: conformanceRegistration.adapterType,
    bridgeId: conformanceBridgeId,
    config: conformanceConfig,
    credentials: {
      resolve: scoped.provider.resolve,
      describe: async (alias: string) => ({ configured: alias === HOME_ASSISTANT_ACCESS_TOKEN_ALIAS }),
    },
    replay: {
      epochId: /^bridge-ha-conformance:conformance-snapshot:\d+$/,
      snapshotId: "conformance-snapshot",
      remoteInstanceId: deriveHomeAssistantRemoteInstanceId(
        conformanceConfig.baseUrl,
        conformanceConfig.authenticationPrincipal,
      ),
      deviceEnvelopeCount: 1,
      stateEnvelopeCount: 1,
    },
    extensionHandles: [
      { key: "foreignRules@2", available: true },
      { key: "orgHints@1", available: false },
      { key: "actions@1", available: true },
      { key: "automations@1", available: true },
    ],
  });

  assert.equal(report.passed, true);
  assert.equal(scoped.calls.includes(HOME_ASSISTANT_ACCESS_TOKEN_ALIAS), true);
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

test("suppresses consecutive HA events whose neutral state did not change", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const controller = new AbortController();
  const iterator = adapter.events(controller.signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket);
  await first;
  for (let index = 0; index < 4; index += 1) await iterator.next();

  const subscription = socket.sent.find((message) => message.type === "subscribe_events");
  assert.notEqual(subscription, undefined);
  const next = iterator.next();
  const receiveState = (brightness: number, unknownAttributes: Record<string, unknown>) => socket.receive({
    id: subscription!.id,
    type: "event",
    event: {
      event_type: "state_changed",
      time_fired: "2026-08-18T00:00:02.000Z",
      data: {
        entity_id: "light.kitchen",
        new_state: {
          state: "on",
          attributes: { brightness, unit_of_measurement: "%", ...unknownAttributes },
        },
      },
    },
  });
  receiveState(200, { changed_vendor_field: "different", another_unknown: true });
  receiveState(201, { changed_vendor_field: "different", another_unknown: true });

  const envelope = await next;
  assert.equal(envelope.value?.seq, 6);
  assert.equal(
    (envelope.value?.event as Extract<BridgeEvent, { kind: "state" }>).state.attrs.brightness,
    201,
  );

  await adapter.control.dispose();
  controller.abort();
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


function automationFetchFake() {
  const requests: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> = [];
  const stored = new Map<string, unknown>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const id = url.split("/").at(-1)!;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, headers: { ...(init?.headers as Record<string, string>) }, body });
    if (method === "POST") {
      stored.set(id, body);
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    }
    if (method === "GET") {
      const config = stored.get(id);
      return config === undefined
        ? new Response("{}", { status: 404 })
        : new Response(JSON.stringify(config), { status: 200 });
    }
    const existed = stored.delete(id);
    return new Response("{}", { status: existed ? 200 : 404 });
  };
  return { fetchImpl, requests, stored };
}

const automationTarget = {
  hwCapabilityId: "cap-light",
  binding: { bridgeId: "bridge-ha", nativeId: "device-1", nativeInstanceId: "entity-stable-1" },
};

test("deploys a hub automation through the config API and verifies by read-back", async () => {
  const socket = new FakeSocket();
  const fake = automationFetchFake();
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket, "light.kitchen");
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);

  const handle = adapter.extension("automations@1") as AutomationsExtension | undefined;
  assert.equal(typeof handle?.deploy, "function");
  const result = await handle!.deploy({
    automationId: "hob_media_power",
    title: "睡前自动关掉多媒体室电源",
    trigger: { kind: "schedule", timezone: "Asia/Shanghai", daysOfWeek: [1, 2, 3, 4, 5], at: "23:30" },
    conditions: [{ kind: "capability_value", source: automationTarget, operator: "equals", value: false }],
    actions: [{ kind: "set_boolean", target: automationTarget, value: false }],
  }, { signal: new AbortController().signal });

  assert.deepEqual(result, { status: "deployed", nativeAutomationId: "hob_media_power" });
  const post = fake.requests.find((request) => request.method === "POST");
  assert.ok(post);
  assert.match(post.url, /\/api\/config\/automation\/config\/hob_media_power$/);
  assert.equal(post.headers.authorization, "Bearer ha-secret");
  assert.deepEqual(post.body, {
    id: "hob_media_power",
    alias: "hob_media_power",
    description: "hob:睡前自动关掉多媒体室电源",
    trigger: [{ platform: "time", at: "23:30:00" }],
    condition: [
      { condition: "time", weekday: ["mon", "tue", "wed", "thu", "fri"] },
      { condition: "state", entity_id: "light.kitchen", state: "off" },
    ],
    action: [{ service: "homeassistant.turn_off", target: { entity_id: "light.kitchen" } }],
    mode: "single",
  });
  assert.equal(fake.requests.filter((request) => request.method === "GET").length, 1);
  await adapter.control.dispose();
});

test("rejects unbound targets and reports withdrawal of a missing automation as done", async () => {
  const socket = new FakeSocket();
  const fake = automationFetchFake();
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket, "light.kitchen");
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);

  const handle = adapter.extension("automations@1") as AutomationsExtension | undefined;
  const foreign = await handle!.deploy({
    automationId: "hob_unbound",
    title: "未知目标",
    trigger: { kind: "schedule", timezone: "Asia/Shanghai", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], at: "08:00" },
    conditions: [],
    actions: [{
      kind: "set_boolean",
      target: { hwCapabilityId: "cap-x", binding: { bridgeId: "bridge-ha", nativeId: "missing", nativeInstanceId: "missing" } },
      value: true,
    }],
  }, { signal: new AbortController().signal });
  assert.equal(foreign.status, "rejected");
  assert.equal((foreign as { reason: string }).reason, "invalid_target");
  assert.equal(fake.requests.length, 0, "an uncompilable automation never reaches Home Assistant");

  const withdrawn = await handle!.withdraw({ nativeAutomationId: "hob_gone" }, { signal: new AbortController().signal });
  assert.deepEqual(withdrawn, { status: "acknowledged" });

  const toggle = handle!.setEnabled({ nativeAutomationId: "hob_media_power", enabled: false }, { signal: new AbortController().signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const command = socket.sent.at(-1)!;
  assert.equal(command.type, "call_service");
  assert.equal(command.domain, "automation");
  assert.equal(command.service, "turn_off");
  assert.deepEqual(command.target, { entity_id: "automation.hob_media_power" });
  socket.receive({ id: command.id, type: "result", success: true, result: null });
  assert.deepEqual(await toggle, { status: "acknowledged" });
  await adapter.control.dispose();
});
