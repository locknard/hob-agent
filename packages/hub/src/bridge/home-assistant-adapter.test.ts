import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeStreamError,
  type BridgeEvent,
  type Envelope,
} from "@hob/bridge-contract";
import { runBridgeAdapterConformance } from "@hob/bridge-contract";
import type { ActionsExtension, AutomationsExtension, AutomationsExtensionV2, BridgeActionDescriptor } from "@hob/bridge-contract";
import type { ForeignRuleMigrationHandle, ForeignRulesHandle } from "@hob/bridge-contract";
import type { ForeignRuleControlHandle } from "@hob/bridge-contract";
import { HISTORY_EXTENSION, type HistoryHandle } from "@hob/bridge-contract";
import type { AutomationTraceHandle } from "@hob/bridge-contract";
import { BridgeCatalog } from "./bridge-catalog.js";
import { BridgeRegistry, MemoryBridgeRegistryStore } from "./bridge-registry.js";
import {
  HOME_ASSISTANT_ACCESS_TOKEN_ALIAS,
  HOME_ASSISTANT_ADAPTER_REGISTRATION,
  HOME_ASSISTANT_BOOLEAN_ACTUATOR_SCHEMA_CANONICAL_HASH,
  HOME_ASSISTANT_COVER_SCHEMA_CANONICAL_HASH,
  HOME_ASSISTANT_ENTITY_SCHEMA_CANONICAL_HASH,
  MAX_HOME_ASSISTANT_FOREIGN_RULE_CONFIG_BYTES,
  MAX_HOME_ASSISTANT_FOREIGN_RULE_CONTROL_OPERATIONS,
  HomeAssistantBridgeAdapter,
  createHomeAssistantBridgeAdapter,
  deriveHomeAssistantPrincipalRef,
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

function respondToStateBootstrap(
  socket: FakeSocket,
  entityId: string,
  state: string,
  attributes: Record<string, unknown> = {},
): void {
  socket.receive({ type: "auth_required", ha_version: "2026.8.0" });
  socket.receive({ type: "auth_ok", ha_version: "2026.8.0" });
  const commands = socket.sent.slice(1) as Array<{ id: number; type: string }>;
  for (const command of commands) {
    const result = command.type === "get_states"
      ? [{ entity_id: entityId, state, attributes, last_updated: "2026-08-18T00:00:01.000Z" }]
      : command.type === "config/entity_registry/list"
        ? [{ id: "entity-stable-1", entity_id: entityId, device_id: "device-1", name: "Kitchen actuator" }]
        : command.type === "config/device_registry/list"
          ? [{ id: "device-1", name: "Kitchen" }]
          : [];
    socket.receive({ id: command.id, type: "result", success: true, result });
  }
}

test("registers and projects the strict boolean-actuator schema for the four exact HA domains", async () => {
  assert.equal(
    HOME_ASSISTANT_BOOLEAN_ACTUATOR_SCHEMA_CANONICAL_HASH,
    "sha256:a70336d95346998c133d5381a3bc4b88a0a519c9c4724db8933717e0104d1878",
  );
  const registrations = HOME_ASSISTANT_ADAPTER_REGISTRATION.capabilitySchemas;
  assert.deepEqual(
    registrations.map((registration) => [registration.schema, registration.majorVersion]),
    [["ha.entity", 1], ["ha.boolean-actuator", 1], ["ha.cover", 1], ["ha.media-player", 1]],
  );
  const booleanRegistration = registrations.find((registration) => registration.schema === "ha.boolean-actuator");
  assert.notEqual(booleanRegistration, undefined);
  assert.equal(booleanRegistration!.attrsSchema.safeParse({}).success, false);
  assert.equal(booleanRegistration!.attrsSchema.safeParse({ state: "on", value: true, available: false, unknownAttributeCount: 2 }).success, true);
  assert.equal(booleanRegistration!.attrsSchema.safeParse({ state: true }).success, false);
  assert.equal(booleanRegistration!.attrsSchema.safeParse({ state: "on", setBooleanSupported: true }).success, false);

  for (const entityId of ["light.kitchen", "switch.socket", "fan.ceiling", "input_boolean.away"] as const) {
    const socket = new FakeSocket();
    const { adapter } = createAdapter(socket);
    const events = await readSnapshot(adapter, socket, () => respondToStateBootstrap(socket, entityId, "on", {
      available: true,
      vendor_field: "must-not-cross-contract",
    }));
    const descriptor = (events[1]!.event as Extract<BridgeEvent, { kind: "device-upserted" }>).device;
    assert.equal(descriptor.capabilities[0]?.schema, "ha.boolean-actuator");
    assert.equal(descriptor.capabilities[0]?.schemaVersion, "1.0.0");
    const state = (events[2]!.event as Extract<BridgeEvent, { kind: "state" }>).state;
    assert.deepEqual(state.attrs, { state: "on", value: true, available: true, unknownAttributeCount: 1 });
    assert.equal(JSON.stringify(state).includes("vendor_field"), false);
  }

  const genericSocket = new FakeSocket();
  const { adapter: genericAdapter } = createAdapter(genericSocket);
  const genericEvents = await readSnapshot(genericAdapter, genericSocket, () => respondToStateBootstrap(genericSocket, "sensor.temperature", "on"));
  const genericDescriptor = (genericEvents[1]!.event as Extract<BridgeEvent, { kind: "device-upserted" }>).device;
  assert.equal(genericDescriptor.capabilities[0]?.schema, "ha.entity");

  const unavailableSocket = new FakeSocket();
  const { adapter: unavailableAdapter } = createAdapter(unavailableSocket);
  const iterator = unavailableAdapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToStateBootstrap(unavailableSocket, "light.kitchen", "unknown", { available: true });
  const unavailableEvents: Envelope[] = [(await first).value!];
  while (unavailableEvents.at(-1)?.event.kind !== "sync-complete") {
    unavailableEvents.push((await iterator.next()).value!);
  }
  const unavailableState = unavailableEvents.find((event) => event.event.kind === "state");
  assert.notEqual(unavailableState, undefined);
  if (unavailableState?.event.kind === "state") {
    assert.equal(unavailableState.event.state.attrs.state, "unknown");
    assert.equal("value" in unavailableState.event.state.attrs, false);
  }
  await unavailableAdapter.control.dispose();
});

function respondToForeignRuleBootstrap(
  socket: FakeSocket,
  automationSubscriptionSuccess = true,
  automationUniqueId: string | null = "arrival_light",
  automationEntityId = "automation.arrival_light",
): void {
  socket.receive({ type: "auth_required", ha_version: "2026.8.0" });
  socket.receive({ type: "auth_ok", ha_version: "2026.8.0" });
  const commands = socket.sent.slice(1) as Array<{ id: number; type: string }>;
  for (const command of commands) {
    const result = command.type === "get_states"
      ? [
          { entity_id: automationEntityId, state: "on", attributes: { friendly_name: "Arrival light" } },
          { entity_id: "light.kitchen", state: "off", attributes: { friendly_name: "Kitchen light" } },
        ]
        : command.type === "config/entity_registry/list"
          ? [
              {
                id: "automation-stable-1",
                entity_id: automationEntityId,
                device_id: "device-automation",
                name: "Arrival light",
                ...(automationUniqueId === null ? {} : { unique_id: automationUniqueId }),
              },
              { id: "entity-light-1", entity_id: "light.kitchen", device_id: "device-light", name: "Kitchen light" },
            ]
          : command.type === "config/device_registry/list"
            ? [{ id: "device-automation", name: "Automations" }, { id: "device-light", name: "Kitchen" }]
            : command.type === "config/area_registry/list"
              ? []
              : [];
    const optionalAutomationSubscription = command.type === "subscribe_events"
      && command.event_type === "automation_triggered";
    socket.receive(optionalAutomationSubscription && !automationSubscriptionSuccess
      ? { id: command.id, type: "result", success: false, error: { message: "Unauthorized" } }
      : { id: command.id, type: "result", success: true, result });
  }
}

function respondToForeignActuatorBootstrap(socket: FakeSocket, entityId: string): void {
  socket.receive({ type: "auth_required", ha_version: "2026.8.0" });
  socket.receive({ type: "auth_ok", ha_version: "2026.8.0" });
  const commands = socket.sent.slice(1) as Array<{ id: number; type: string }>;
  for (const command of commands) {
    const result = command.type === "get_states"
      ? [
          { entity_id: "automation.arrival_actuator", state: "on", attributes: { friendly_name: "Arrival actuator" } },
          { entity_id: entityId, state: "off", attributes: { friendly_name: "Actuator" } },
        ]
        : command.type === "config/entity_registry/list"
          ? [
              { id: "automation-stable-1", entity_id: "automation.arrival_actuator", device_id: "device-automation", name: "Arrival actuator" },
              { id: "entity-actuator-1", entity_id: entityId, device_id: "device-actuator", name: "Actuator" },
            ]
          : command.type === "config/device_registry/list"
            ? [{ id: "device-automation", name: "Automations" }, { id: "device-actuator", name: "Actuator" }]
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
    [["ha.entity", 1], ["ha.boolean-actuator", 1], ["ha.cover", 1], ["ha.media-player", 1]],
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

test("keeps the boolean actuator schema for light entities even when they expose cover-like attributes", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const events = await readSnapshot(adapter, socket, () => respondToCoverBootstrap(socket, {
    current_position: 50,
    supported_features: 4,
  }, "light.curtain"));
  const descriptor = (events[1]!.event as Extract<BridgeEvent, { kind: "device-upserted" }>).device;
  assert.equal(descriptor.capabilities[0]?.schema, "ha.boolean-actuator");
  const state = (events[2]!.event as Extract<BridgeEvent, { kind: "state" }>).state;
  assert.equal(state.attrs.state, "open");
  assert.equal("value" in state.attrs, false);
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

async function startAndSync(
  adapter: HomeAssistantBridgeAdapter,
  socket: FakeSocket,
  respond: () => void = () => respondToBootstrap(socket),
): Promise<Envelope[]> {
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respond();
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);
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
      { id: "foreignRuleMigration", version: "1.0.0" },
      { id: "foreignRuleControl", version: "1.0.0" },
      { id: "causality", version: "1.0.0" },
      { id: "automationTrace", version: "1.0.0" },
      { id: "orgHints", version: "1.0.0" },
      { id: "actions", version: "1.0.0" },
      { id: "automations", version: "1.0.0" },
      { id: "automations", version: "2.0.0" },
      { id: "history", version: "1.0.0" },
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

test("keeps history unavailable before running and reads one bound imported state after sync", async () => {
  const socket = new FakeSocket();
  const requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
    });
    return new Response(JSON.stringify([[
      {
        entity_id: "light.kitchen",
        state: "on",
        attributes: { brightness: 200, vendor_secret: "do-not-cross" },
        last_updated: "2026-08-20T00:10:00.000Z",
      },
    ]]), { status: 200 });
  };
  const { adapter, calls } = createAdapter(socket, {}, { fetchImpl });
  assert.equal(adapter.info.extensions.some((extension) => extension.id === HISTORY_EXTENSION.id), true);
  const preRunHandle = adapter.extension("history@1") as HistoryHandle | undefined;
  assert.notEqual(preRunHandle, undefined);
  const preRunPage = await preRunHandle!.fetchHistory({
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "entity-stable-1" }],
    liveCut: { epochId: "pre-run", lastSeq: 1 },
  }, { signal: new AbortController().signal });
  assert.deepEqual(preRunPage.coverage, "unavailable");
  assert.deepEqual(preRunPage.reasons, ["history_unavailable"]);
  assert.deepEqual(requests, []);
  assert.deepEqual(calls, []);
  const restarted = createAdapter(new FakeSocket(), {}, { fetchImpl });
  const restartedPage = await (restarted.adapter.extension("history@1") as HistoryHandle)!.fetchHistory({
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "entity-stable-1" }],
    liveCut: { epochId: "pre-run", lastSeq: 1 },
  }, { signal: new AbortController().signal });
  assert.notEqual(restartedPage.importId, preRunPage.importId);

  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket);
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);
  assert.equal(adapter.info.extensions.some((extension) => extension.id === HISTORY_EXTENSION.id), true);

  const handle = adapter.extension("history@1") as HistoryHandle | undefined;
  assert.notEqual(handle, undefined);
  const page = await handle!.fetchHistory({
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "entity-stable-1" }],
    liveCut: { epochId: events.at(-1)!.epochId, lastSeq: events.at(-1)!.seq },
  }, { signal: new AbortController().signal });
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0]?.state.origin, "imported");
  assert.equal(JSON.stringify(page).includes("vendor_secret"), false);
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.headers.authorization, "Bearer ha-secret");
  assert.match(requests[0]?.url ?? "", /\/api\/history\/period\//);
  await adapter.control.dispose();
});

test("uses the exact HA history query and projects timestamps without native fields", async () => {
  const socket = new FakeSocket();
  const requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
    });
    return new Response(JSON.stringify([[
      {
        entity_id: "light.kitchen",
        state: "off",
        attributes: {},
        last_changed: "2026-08-20T00:20:00.000Z",
      },
      {
        entity_id: "light.kitchen",
        state: "on",
        attributes: { brightness: 200, context: "must-not-cross" },
        last_updated: "2026-08-20T00:10:00.000Z",
      },
      {
        entity_id: "light.kitchen",
        state: "on",
        attributes: {},
        last_updated: "not-a-timestamp",
        last_changed: "2026-08-20T00:30:00.000Z",
      },
      {
        entity_id: "light.unknown",
        state: "on",
        attributes: {},
        last_updated: "2026-08-20T00:40:00.000Z",
      },
    ]]), { status: 200 });
  };
  const { adapter } = createAdapter(socket, {}, { fetchImpl });
  const events = await startAndSync(adapter, socket);
  const page = await (adapter.extension("history@1") as HistoryHandle)!.fetchHistory({
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "entity-stable-1" }],
    liveCut: { epochId: events.at(-1)!.epochId, lastSeq: events.at(-1)!.seq },
  }, { signal: new AbortController().signal });

  assert.equal(page.records.length, 3);
  assert.deepEqual(page.records.map((record) => record.state.time), [
    { sourceTs: "2026-08-20T00:10:00.000Z", sourceTsQuality: "platform" },
    { sourceTs: "2026-08-20T00:20:00.000Z", sourceTsQuality: "platform" },
    { sourceTsQuality: "none" },
  ]);
  assert.equal(page.records.every((record) => record.state.origin === "imported"), true);
  assert.equal(page.records.every((record) => !("context" in record.state.attrs)), true);
  assert.equal(page.reasons.includes("invalid_row"), true);
  assert.deepEqual(page.liveCut, { epochId: events.at(-1)!.epochId, lastSeq: events.at(-1)!.seq });

  const requestUrl = new URL(requests[0]!.url);
  assert.equal(requests[0]!.method, "GET");
  assert.equal(requests[0]!.headers.authorization, "Bearer ha-secret");
  assert.equal(requestUrl.pathname, "/api/history/period/2026-08-20T00%3A00%3A00.000Z");
  assert.equal(requestUrl.searchParams.get("end_time"), "2026-08-20T01:00:00.000Z");
  assert.equal(requestUrl.searchParams.get("filter_entity_id"), "light.kitchen");
  assert.equal(requestUrl.searchParams.has("skip_initial_state"), true);
  assert.equal(requestUrl.searchParams.get("significant_changes_only"), "1");
  assert.equal(requestUrl.searchParams.get("minimal_response"), "0");
  assert.equal(requestUrl.searchParams.get("no_attributes"), "0");
  await adapter.control.dispose();
});

test("omits invalid nested rows and commits no prefix when the record limit is exceeded", async () => {
  const socket = new FakeSocket();
  let responseRows: unknown[] = [[
    {
      entity_id: "light.kitchen",
      state: "on",
      attributes: {},
      last_updated: "2026-08-20T00:10:00.000Z",
    },
    { entity_id: "light.kitchen", state: "on", attributes: "invalid" },
  ]];
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(responseRows), { status: 200 });
  const { adapter } = createAdapter(socket, {}, { fetchImpl });
  const events = await startAndSync(adapter, socket);
  const handle = adapter.extension("history@1") as HistoryHandle;
  const request = {
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "entity-stable-1" }],
    liveCut: { epochId: events.at(-1)!.epochId, lastSeq: events.at(-1)!.seq },
  };
  const partial = await handle.fetchHistory(request, { signal: new AbortController().signal });
  assert.equal(partial.records.length, 1);
  assert.equal(partial.reasons.includes("invalid_row"), true);
  assert.deepEqual(partial.records.map((record) => record.historySeq), [1]);

  responseRows = [[...Array.from({ length: 201 }, (_, index) => ({
    entity_id: "light.kitchen",
    state: index % 2 === 0 ? "on" : "off",
    attributes: {},
    last_updated: `2026-08-20T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
  }))]];
  const limited = await handle.fetchHistory(request, { signal: new AbortController().signal });
  assert.equal(limited.coverage, "partial");
  assert.deepEqual(limited.reasons, ["record_limit"]);
  assert.deepEqual(limited.records, []);
  await adapter.control.dispose();
});

test("omits a normalized history row over 64 KiB and bounds the raw response before parsing", async () => {
  const socket = new FakeSocket();
  let responseBody = JSON.stringify([[
    {
      entity_id: "sensor.temperature",
      state: "x".repeat(70_000),
      attributes: {},
      last_updated: "2026-08-20T00:10:00.000Z",
    },
  ]]);
  const fetchImpl: typeof fetch = async () => new Response(responseBody, { status: 200 });
  const { adapter } = createAdapter(socket, {}, { fetchImpl });
  const events = await startAndSync(adapter, socket, () => respondToBootstrap(socket, "sensor.temperature"));
  const handle = adapter.extension("history@1") as HistoryHandle;
  const request = {
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "entity-stable-1" }],
    liveCut: { epochId: events.at(-1)!.epochId, lastSeq: events.at(-1)!.seq },
  };
  const oversizedRecord = await handle.fetchHistory(request, { signal: new AbortController().signal });
  assert.deepEqual(oversizedRecord.records, []);
  assert.deepEqual(oversizedRecord.reasons, ["retention_floor_unknown", "record_too_large"]);

  responseBody = JSON.stringify([[
    {
      entity_id: "sensor.temperature",
      state: "x".repeat(1_100_000),
      attributes: {},
      last_updated: "2026-08-20T00:10:00.000Z",
    },
  ]]);
  const oversizedResponse = await handle.fetchHistory(request, { signal: new AbortController().signal });
  assert.equal(oversizedResponse.coverage, "partial");
  assert.deepEqual(oversizedResponse.reasons, ["response_too_large"]);
  assert.deepEqual(oversizedResponse.records, []);
  await adapter.control.dispose();
});

test("rejects a successful history response with no stream without an unbounded arrayBuffer read", async () => {
  const socket = new FakeSocket();
  let arrayBufferCalls = 0;
  const response = {
    ok: true,
    status: 200,
    body: null,
    async arrayBuffer() {
      arrayBufferCalls += 1;
      return new ArrayBuffer(2 * 1024 * 1024);
    },
  } as Response;
  const { adapter } = createAdapter(socket, {}, { fetchImpl: async () => response });
  const events = await startAndSync(adapter, socket);
  const page = await (adapter.extension("history@1") as HistoryHandle).fetchHistory({
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "entity-stable-1" }],
    liveCut: { epochId: events.at(-1)!.epochId, lastSeq: events.at(-1)!.seq },
  }, { signal: new AbortController().signal });
  assert.deepEqual(page.reasons, ["invalid_response"]);
  assert.equal(arrayBufferCalls, 0);
  await adapter.control.dispose();
});

test("returns unavailable for an unknown exact binding without issuing a history request", async () => {
  const socket = new FakeSocket();
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    return new Response("[]", { status: 200 });
  };
  const { adapter } = createAdapter(socket, {}, { fetchImpl });
  const events = await startAndSync(adapter, socket);
  const page = await (adapter.extension("history@1") as HistoryHandle)!.fetchHistory({
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "wrong-entity" }],
    liveCut: { epochId: events.at(-1)!.epochId, lastSeq: events.at(-1)!.seq },
  }, { signal: new AbortController().signal });
  assert.equal(page.coverage, "unavailable");
  assert.deepEqual(page.reasons, ["history_unavailable"]);
  assert.equal(fetchCalls, 0);
  await adapter.control.dispose();
});

test("keeps one history read in flight and reports caller cancellation without rows", async () => {
  const socket = new FakeSocket();
  let fetchStarted!: () => void;
  const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
  const fetchImpl: typeof fetch = async (_input, init) => {
    fetchStarted();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  };
  const { adapter } = createAdapter(socket, {}, { fetchImpl });
  const events = await startAndSync(adapter, socket);
  const handle = adapter.extension("history@1") as HistoryHandle;
  const request = {
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "entity-stable-1" }],
    liveCut: { epochId: events.at(-1)!.epochId, lastSeq: events.at(-1)!.seq },
  };
  const caller = new AbortController();
  const first = handle.fetchHistory(request, { signal: caller.signal });
  await started;
  const busy = await handle.fetchHistory(request, { signal: new AbortController().signal });
  assert.equal(busy.coverage, "unavailable");
  assert.deepEqual(busy.reasons, ["busy"]);
  caller.abort();
  const cancelled = await first;
  assert.equal(cancelled.coverage, "unavailable");
  assert.deepEqual(cancelled.reasons, ["cancelled"]);
  await adapter.control.dispose();
});

test("returns deterministic coverage for empty, invalid, recorder-disabled, and non-UTF-8 responses", async () => {
  const socket = new FakeSocket();
  let response: Response = new Response("[]", { status: 200 });
  const fetchImpl: typeof fetch = async () => response;
  const { adapter } = createAdapter(socket, {}, { fetchImpl });
  const events = await startAndSync(adapter, socket);
  const handle = adapter.extension("history@1") as HistoryHandle;
  const request = {
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "entity-stable-1" }],
    liveCut: { epochId: events.at(-1)!.epochId, lastSeq: events.at(-1)!.seq },
  };
  const empty = await handle.fetchHistory(request, { signal: new AbortController().signal });
  assert.equal(empty.coverage, "partial");
  assert.deepEqual(empty.reasons, ["retention_floor_unknown", "empty_or_purged"]);
  assert.deepEqual(empty.records, []);

  response = new Response(JSON.stringify({ unexpected: true }), { status: 200 });
  const invalid = await handle.fetchHistory(request, { signal: new AbortController().signal });
  assert.equal(invalid.coverage, "unavailable");
  assert.deepEqual(invalid.reasons, ["invalid_response"]);
  assert.deepEqual(invalid.records, []);

  response = new Response("recorder is disabled", { status: 404 });
  const disabled = await handle.fetchHistory(request, { signal: new AbortController().signal });
  assert.equal(disabled.coverage, "unavailable");
  assert.deepEqual(disabled.reasons, ["recorder_disabled"]);

  response = new Response(new Uint8Array([0xc3, 0x28]), { status: 200 });
  const invalidUtf8 = await handle.fetchHistory(request, { signal: new AbortController().signal });
  assert.equal(invalidUtf8.coverage, "unavailable");
  assert.deepEqual(invalidUtf8.reasons, ["invalid_response"]);
  await adapter.control.dispose();
});

test("uses the five-second history deadline by default through a testable bounded timeout seam", async () => {
  const socket = new FakeSocket();
  const fetchImpl: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
  });
  const { adapter } = createAdapter(socket, {}, { fetchImpl, historyTimeoutMs: 5 });
  const events = await startAndSync(adapter, socket);
  const caller = new AbortController();
  const pending = (adapter.extension("history@1") as HistoryHandle)!.fetchHistory({
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "entity-stable-1" }],
    liveCut: { epochId: events.at(-1)!.epochId, lastSeq: events.at(-1)!.seq },
  }, { signal: caller.signal });
  const abortCallerAfterDefaultWouldHaveExpired = setTimeout(() => caller.abort(), 100);
  const page = await pending;
  clearTimeout(abortCallerAfterDefaultWouldHaveExpired);
  assert.equal(page.coverage, "unavailable");
  assert.deepEqual(page.reasons, ["timeout"]);
  await adapter.control.dispose();
});

test("settles an ignored history abort at the adapter deadline and releases the in-flight slot", async () => {
  const socket = new FakeSocket();
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) return new Promise<Response>(() => undefined);
    return new Response("[]", { status: 200 });
  };
  const { adapter } = createAdapter(socket, {}, { fetchImpl, historyTimeoutMs: 5 });
  const events = await startAndSync(adapter, socket);
  const handle = adapter.extension("history@1") as HistoryHandle;
  const request = {
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "entity-stable-1" }],
    liveCut: { epochId: events.at(-1)!.epochId, lastSeq: events.at(-1)!.seq },
  };

  const timedOut = await handle.fetchHistory(request, { signal: new AbortController().signal });
  assert.deepEqual(timedOut.reasons, ["timeout"]);
  const retry = await handle.fetchHistory(request, { signal: new AbortController().signal });
  assert.deepEqual(retry.reasons, ["retention_floor_unknown", "empty_or_purged"]);
  assert.equal(fetchCalls, 2);
  await adapter.control.dispose();
});

test("bounds a credential provider that stops responding during a history read", async () => {
  const socket = new FakeSocket();
  let resolveCalls = 0;
  const adapter = createHomeAssistantBridgeAdapter({
    bridgeId: "bridge-ha",
    config,
    credentials: {
      async resolve() {
        resolveCalls += 1;
        if (resolveCalls === 2) return new Promise<never>(() => undefined);
        return { kind: "secret_text" as const, value: "ha-secret" };
      },
      async describe() {
        return { configured: true };
      },
    },
  }, {
    socketFactory: () => socket,
    snapshotIdFactory: () => "snapshot-1",
    historyTimeoutMs: 5,
    fetchImpl: async () => new Response("[]", { status: 200 }),
  });
  const events = await startAndSync(adapter, socket);
  const handle = adapter.extension("history@1") as HistoryHandle;
  const request = {
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "entity-stable-1" }],
    liveCut: { epochId: events.at(-1)!.epochId, lastSeq: events.at(-1)!.seq },
  };

  assert.deepEqual(
    (await handle.fetchHistory(request, { signal: new AbortController().signal })).reasons,
    ["timeout"],
  );
  assert.deepEqual(
    (await handle.fetchHistory(request, { signal: new AbortController().signal })).reasons,
    ["retention_floor_unknown", "empty_or_purged"],
  );
  assert.equal(resolveCalls, 3);
  await adapter.control.dispose();
});

test("invalidates an in-flight history page as soon as resync starts", async () => {
  const socket = new FakeSocket();
  let release!: (response: Response) => void;
  const pendingResponse = new Promise<Response>((resolve) => { release = resolve; });
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    return pendingResponse;
  };
  const { adapter } = createAdapter(socket, {}, { fetchImpl });
  const events = await startAndSync(adapter, socket);
  const handle = adapter.extension("history@1") as HistoryHandle;
  const pending = handle.fetchHistory({
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "entity-stable-1" }],
    liveCut: { epochId: events.at(-1)!.epochId, lastSeq: events.at(-1)!.seq },
  }, { signal: new AbortController().signal });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(
    await adapter.control.requestResync(new AbortController().signal),
    { status: "completed" },
  );
  release(new Response("[]", { status: 200 }));
  const page = await pending;
  assert.equal(page.coverage, "unavailable");
  assert.deepEqual(page.reasons, ["resync_stale"]);
  const duringResync = await handle.fetchHistory({
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "entity-stable-1" }],
    liveCut: { epochId: events.at(-1)!.epochId, lastSeq: events.at(-1)!.seq },
  }, { signal: new AbortController().signal });
  assert.deepEqual(duringResync.reasons, ["resync_stale"]);
  assert.equal(fetchCalls, 1);
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

test("settles an aborted service command, clears pending state, and ignores a late ack", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const stream = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = stream.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket, "light.kitchen");
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await stream.next()).value!);

  const handle = adapter.extension("actions@1") as ActionsExtension | undefined;
  const controller = new AbortController();
  const execution = handle!.execute({
    requestId: "action-abort-1",
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
  }, { signal: controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const command = socket.sent.at(-1)!;
  assert.equal(command.type, "call_service");

  const bridge = (adapter as unknown as {
    bridge: { pending: Map<number, unknown> };
  }).bridge;
  assert.equal(bridge.pending.size, 1);

  try {
    controller.abort(new Error("cancelled by test"));
    const result = await Promise.race([
      execution,
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 50)),
    ]);
    assert.deepEqual(result, { status: "unknown", reason: "cancelled" });
    assert.equal(bridge.pending.size, 0);

    socket.receive({ id: command.id, type: "result", success: true, result: null });
    assert.equal(bridge.pending.size, 0);
  } finally {
    await adapter.control.dispose();
    void first;
  }
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
  const descriptor = handle?.describe(({
    target: {
      hwCapabilityId: "cap-light",
      binding: {
        bridgeId: "bridge-ha",
        nativeId: "device-1",
        nativeInstanceId: "entity-stable-1",
      },
    },
    current: { state: "on", value: true, available: true },
  } as Parameters<ActionsExtension["describe"]>[0]));
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
    schema: "ha.boolean-actuator",
    schemaVersion: "1.0.0",
    semanticKind: "light",
    space: { nativeSpaceId: "area-entity", name: "Counter" },
  }]);

  const state = (events[2]!.event as Extract<BridgeEvent, { kind: "state" }>).state;
  assert.equal(state.nativeId, "device-1");
  assert.equal(state.nativeInstanceId, "entity-stable-1");
  assert.deepEqual(state.attrs, {
    state: "on",
    value: true,
    unknownAttributeCount: 4,
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
      { key: "foreignRuleMigration@1", available: true },
      { key: "foreignRuleControl@1", available: true },
      { key: "causality@1", available: false },
      { key: "automationTrace@1", available: true },
      { key: "orgHints@1", available: false },
      { key: "actions@1", available: true },
      { key: "automations@1", available: true },
      { key: "automations@2", available: true },
      { key: "history@1", available: true },
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
  const causalityEnvelope = await iterator.next();
  assert.deepEqual(causalityEnvelope.value?.event, {
    kind: "ext",
    ext: "causality@1",
    payload: { refSeq: stateEnvelope.value!.seq, cause: { kind: "unknown" } },
  });
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

test("emits a hashed user causality extension immediately after a live state envelope", async () => {
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
  socket.receive({
    id: subscription!.id,
    type: "event",
    event: {
      event_type: "state_changed",
      time_fired: "2026-08-18T00:00:02.000Z",
      context: { user_id: "native-user-id", id: "native-context-id", parent_id: "native-parent-id" },
      data: {
        entity_id: "light.kitchen",
        new_state: { state: "off", attributes: {} },
      },
    },
  });
  const stateEnvelope = await next;
  assert.equal(stateEnvelope.value?.event.kind, "state");
  const causalityEnvelope = await iterator.next();
  assert.deepEqual(causalityEnvelope.value?.event, {
    kind: "ext",
    ext: "causality@1",
    payload: {
      refSeq: stateEnvelope.value!.seq,
      cause: { kind: "user", principalRef: deriveHomeAssistantPrincipalRef("bridge-ha", "native-user-id") },
    },
  });
  assert.equal(JSON.stringify(causalityEnvelope.value).includes("native-user-id"), false);
  assert.equal(JSON.stringify(causalityEnvelope.value).includes("native-context-id"), false);
  assert.equal(causalityEnvelope.value!.seq, stateEnvelope.value!.seq + 1);

  await adapter.control.dispose();
  controller.abort();
});

test("emits limited unknown causality without guessing physical or foreign-rule causes", async () => {
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
  socket.receive({
    id: subscription!.id,
    type: "event",
    event: {
      event_type: "state_changed",
      time_fired: "2026-08-18T00:00:03.000Z",
      data: {
        entity_id: "light.kitchen",
        new_state: { state: "off", attributes: {} },
      },
    },
  });
  const stateEnvelope = await next;
  const causalityEnvelope = await iterator.next();
  assert.deepEqual(causalityEnvelope.value?.event, {
    kind: "ext",
    ext: "causality@1",
    payload: {
      refSeq: stateEnvelope.value!.seq,
      cause: { kind: "unknown" },
    },
  });

  await adapter.control.dispose();
  controller.abort();
});

test("attributes an observed automation action to the existing opaque foreign rule", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const controller = new AbortController();
  const iterator = adapter.events(controller.signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") {
    events.push((await iterator.next()).value!);
  }

  const subscriptions = socket.sent.filter((message) => message.type === "subscribe_events");
  assert.deepEqual(subscriptions.map((message) => message.event_type), ["state_changed", "automation_triggered"]);
  const stateSubscription = subscriptions.find((message) => message.event_type === "state_changed");
  const automationSubscription = subscriptions.find((message) => message.event_type === "automation_triggered");
  assert.notEqual(stateSubscription, undefined);
  assert.notEqual(automationSubscription, undefined);
  const ruleRef = ((await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())?.rules[0])?.ruleRef;
  assert.match(ruleRef ?? "", /^ha-rule:/);

  const stateNext = iterator.next();
  socket.receive({
    id: automationSubscription!.id,
    type: "event",
    event: {
      event_type: "automation_triggered",
      time_fired: "2026-08-18T00:00:02.000Z",
      context: { id: "automation-context-id", parent_id: "source-context-id" },
      data: { entity_id: "automation.arrival_light" },
    },
  });
  socket.receive({
    id: stateSubscription!.id,
    type: "event",
    event: {
      event_type: "state_changed",
      time_fired: "2026-08-18T00:00:03.000Z",
      context: { id: "automation-context-id", parent_id: "source-context-id" },
      data: {
        entity_id: "light.kitchen",
        new_state: { state: "on", attributes: {} },
      },
    },
  });
  const stateEnvelope = await stateNext;
  assert.equal(stateEnvelope.value?.event.kind, "state");
  const causalityEnvelope = await iterator.next();
  assert.deepEqual(causalityEnvelope.value?.event, {
    kind: "ext",
    ext: "causality@1",
    payload: {
      refSeq: stateEnvelope.value!.seq,
      cause: { kind: "foreign_rule", ruleRef },
    },
  });
  assert.equal(JSON.stringify(causalityEnvelope.value).includes("automation-context-id"), false);
  assert.equal(JSON.stringify(causalityEnvelope.value).includes("automation.arrival_light"), false);

  await adapter.control.dispose();
  controller.abort();
});

test("reads one exact automation trace for the causality state target", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const controller = new AbortController();
  const iterator = adapter.events(controller.signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") {
    events.push((await iterator.next()).value!);
  }

  const stateSubscription = socket.sent.find((message) => (
    message.type === "subscribe_events" && message.event_type === "state_changed"
  ));
  const automationSubscription = socket.sent.find((message) => (
    message.type === "subscribe_events" && message.event_type === "automation_triggered"
  ));
  assert.notEqual(stateSubscription, undefined);
  assert.notEqual(automationSubscription, undefined);
  const ruleRef = ((await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())?.rules[0])?.ruleRef;
  assert.match(ruleRef ?? "", /^ha-rule:/);

  const stateNext = iterator.next();
  socket.receive({
    id: automationSubscription!.id,
    type: "event",
    event: {
      event_type: "automation_triggered",
      context: { id: "automation-context-id" },
      data: { entity_id: "automation.arrival_light" },
    },
  });
  socket.receive({
    id: stateSubscription!.id,
    type: "event",
    event: {
      event_type: "state_changed",
      time_fired: "2026-08-25T10:00:01.000Z",
      context: { id: "automation-context-id" },
      data: {
        entity_id: "light.kitchen",
        new_state: { state: "on", attributes: {} },
      },
    },
  });
  const stateEnvelope = await stateNext;
  assert.equal(stateEnvelope.value?.event.kind, "state");
  const causalityEnvelope = await iterator.next();
  assert.equal(causalityEnvelope.value?.event.kind, "ext");

  const target = { epochId: stateEnvelope.value!.epochId, seq: stateEnvelope.value!.seq };
  const traceHandle = adapter.extension("automationTrace@1") as AutomationTraceHandle;
  assert.notEqual(traceHandle, undefined);
  const read = traceHandle.readTrace({ ruleRef: ruleRef!, target }, { signal: controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const contextsCommand = socket.sent.at(-1);
  assert.deepEqual(contextsCommand && {
    type: contextsCommand.type,
    domain: contextsCommand.domain,
    item_id: contextsCommand.item_id,
  }, {
    type: "trace/contexts",
    domain: "automation",
    item_id: "arrival_light",
  });
  socket.receive({
    id: contextsCommand!.id,
    type: "result",
    success: true,
    result: {
      "automation-context-id": {
        run_id: "native-run-id",
        domain: "automation",
        item_id: "arrival_light",
      },
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const getCommand = socket.sent.at(-1);
  assert.deepEqual(getCommand && {
    type: getCommand.type,
    domain: getCommand.domain,
    item_id: getCommand.item_id,
    run_id: getCommand.run_id,
  }, {
    type: "trace/get",
    domain: "automation",
    item_id: "arrival_light",
    run_id: "native-run-id",
  });
  socket.receive({
    id: getCommand!.id,
    type: "result",
    success: true,
    result: {
      last_step: "action/0",
      run_id: "native-run-id",
      state: "stopped",
      script_execution: "finished",
      timestamp: {
        start: "2026-08-25T10:00:00.000+00:00",
        finish: "2026-08-25T10:00:01.250+00:00",
      },
      domain: "automation",
      item_id: "arrival_light",
      config: { secret: "must-not-cross-contract" },
      context: { id: "automation-context-id", user_id: "native-user-id" },
      trace: [{ changed_variables: { secret: "must-not-cross-contract" } }],
    },
  });
  const result = await read;
  assert.deepEqual(result, {
    status: "complete",
    ruleRef,
    target,
    run: {
      automationLabel: "Arrival light",
      state: "completed",
      outcome: "completed",
      startedAt: "2026-08-25T10:00:00.000+00:00",
      finishedAt: "2026-08-25T10:00:01.250+00:00",
      steps: [],
      truncated: false,
    },
  });
  assert.equal(JSON.stringify(result).includes("native-run-id"), false);
  assert.equal(JSON.stringify(result).includes("automation-context-id"), false);
  assert.equal(JSON.stringify(result).includes("must-not-cross-contract"), false);

  await adapter.control.dispose();
  controller.abort();
});

async function prepareAutomationTraceFixture(
  dependencyOverride: Record<string, unknown> = {},
  automationUniqueId: string | null = "arrival_light",
  automationEntityId = "automation.arrival_light",
): Promise<{
  readonly adapter: HomeAssistantBridgeAdapter;
  readonly socket: FakeSocket;
  readonly controller: AbortController;
  readonly iterator: AsyncIterator<Envelope>;
  readonly stateSubscription: Record<string, unknown>;
  readonly automationSubscription: Record<string, unknown>;
  readonly ruleRef: string;
  readonly target: { readonly epochId: string; readonly seq: number };
  readonly causality: Envelope;
  readonly traceHandle: AutomationTraceHandle;
}> {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket, {}, dependencyOverride);
  const controller = new AbortController();
  const iterator = adapter.events(controller.signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket, true, automationUniqueId, automationEntityId);
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);
  const stateSubscription = socket.sent.find((message) => (
    message.type === "subscribe_events" && message.event_type === "state_changed"
  ));
  const automationSubscription = socket.sent.find((message) => (
    message.type === "subscribe_events" && message.event_type === "automation_triggered"
  ));
  assert.notEqual(stateSubscription, undefined);
  assert.notEqual(automationSubscription, undefined);
  const ruleRef = ((await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())?.rules[0])?.ruleRef;
  assert.match(ruleRef ?? "", /^ha-rule:/);
  const stateNext = iterator.next();
  socket.receive({
    id: automationSubscription!.id,
    type: "event",
    event: {
      event_type: "automation_triggered",
      context: { id: "automation-context-id" },
      data: { entity_id: automationEntityId },
    },
  });
  socket.receive({
    id: stateSubscription!.id,
    type: "event",
    event: {
      event_type: "state_changed",
      time_fired: "2026-08-25T10:00:01.000Z",
      context: { id: "automation-context-id" },
      data: {
        entity_id: "light.kitchen",
        new_state: { state: "on", attributes: {} },
      },
    },
  });
  const stateEnvelope = await stateNext;
  assert.equal(stateEnvelope.value?.event.kind, "state");
  const causality = (await iterator.next()).value!;
  assert.equal(causality.event.kind, "ext");
  return {
    adapter,
    socket,
    controller,
    iterator,
    stateSubscription: stateSubscription!,
    automationSubscription: automationSubscription!,
    ruleRef: ruleRef!,
    target: { epochId: stateEnvelope.value!.epochId, seq: stateEnvelope.value!.seq },
    causality,
    traceHandle: adapter.extension("automationTrace@1") as AutomationTraceHandle,
  };
}

test("keeps foreign-rule causality but refuses trace lookup without a unique_id", async () => {
  const fixture = await prepareAutomationTraceFixture({}, null);
  assert.equal(fixture.causality.event.kind, "ext");
  if (fixture.causality.event.kind === "ext") {
    assert.deepEqual(fixture.causality.event.payload.cause, {
      kind: "foreign_rule",
      ruleRef: fixture.ruleRef,
    });
  }
  const commandCount = fixture.socket.sent.length;
  const result = await fixture.traceHandle.readTrace({ ruleRef: fixture.ruleRef, target: fixture.target }, { signal: fixture.controller.signal });
  assert.deepEqual(result.status, "unknown");
  assert.deepEqual(result.status === "unknown" ? result.reasons : [], ["rule_not_found"]);
  assert.equal(fixture.socket.sent.length, commandCount);
  assert.equal(fixture.socket.sent.some((command) => command.type === "trace/contexts"), false);
  await fixture.adapter.control.dispose();
  fixture.controller.abort();
});

test("uses a stable unique_id as the trace item across an automation entity rename", async () => {
  const fixture = await prepareAutomationTraceFixture({}, "arrival_light", "automation.renamed_arrival_light");
  const read = fixture.traceHandle.readTrace({ ruleRef: fixture.ruleRef, target: fixture.target }, { signal: fixture.controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const contextsCommand = fixture.socket.sent.at(-1)!;
  assert.deepEqual({
    type: contextsCommand.type,
    domain: contextsCommand.domain,
    item_id: contextsCommand.item_id,
  }, {
    type: "trace/contexts",
    domain: "automation",
    item_id: "arrival_light",
  });
  fixture.socket.receive({ id: contextsCommand.id, type: "result", success: true, result: {} });
  const result = await read;
  assert.deepEqual(result.status, "unknown");
  assert.deepEqual(result.status === "unknown" ? result.reasons : [], ["trace_not_retained"]);
  await fixture.adapter.control.dispose();
  fixture.controller.abort();
});

test("returns unavailable cancellation without issuing an automation trace command", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const controller = new AbortController();
  controller.abort();
  const result = await (adapter.extension("automationTrace@1") as AutomationTraceHandle).readTrace({
    ruleRef: "ha-rule:known",
    target: { epochId: "epoch-known", seq: 1 },
  }, { signal: controller.signal });
  assert.deepEqual(result, {
    status: "unavailable",
    ruleRef: "ha-rule:known",
    target: { epochId: "epoch-known", seq: 1 },
    reasons: ["cancelled"],
  });
  assert.deepEqual(socket.sent, []);
});

test("keeps a running automation trace partial and never reports completed", async () => {
  const fixture = await prepareAutomationTraceFixture();
  const read = fixture.traceHandle.readTrace({ ruleRef: fixture.ruleRef, target: fixture.target }, { signal: fixture.controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const contextsCommand = fixture.socket.sent.at(-1)!;
  fixture.socket.receive({
    id: contextsCommand.id,
    type: "result",
    success: true,
    result: {
      "automation-context-id": { run_id: "native-run-id", domain: "automation", item_id: "arrival_light" },
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const getCommand = fixture.socket.sent.at(-1)!;
  fixture.socket.receive({
    id: getCommand.id,
    type: "result",
    success: true,
    result: {
      run_id: "native-run-id",
      state: "running",
      script_execution: "running",
      timestamp: { start: "2026-08-25T10:00:00.000+00:00", finish: null },
      domain: "automation",
      item_id: "arrival_light",
    },
  });
  const result = await read;
  assert.equal(result.status, "partial");
  if (result.status === "partial") {
    assert.equal(result.run.state, "running");
    assert.notEqual(result.run.state, "completed");
    assert.equal(result.run.outcome, "unknown");
  }
  await fixture.adapter.control.dispose();
  fixture.controller.abort();
});

test("maps trace permission denial without exposing provider error text", async () => {
  const fixture = await prepareAutomationTraceFixture();
  const read = fixture.traceHandle.readTrace({ ruleRef: fixture.ruleRef, target: fixture.target }, { signal: fixture.controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const contextsCommand = fixture.socket.sent.at(-1)!;
  fixture.socket.receive({
    id: contextsCommand.id,
    type: "result",
    success: false,
    error: { code: "unauthorized", message: "secret provider denial" },
  });
  const result = await read;
  assert.deepEqual(result, {
    status: "unavailable",
    ruleRef: fixture.ruleRef,
    target: fixture.target,
    reasons: ["permission_denied"],
  });
  assert.equal(JSON.stringify(result).includes("secret provider denial"), false);
  await fixture.adapter.control.dispose();
  fixture.controller.abort();
});

test("maps an automation trace deadline to unavailable timeout", async () => {
  const fixture = await prepareAutomationTraceFixture({ automationTraceTimeoutMs: 1 });
  const read = fixture.traceHandle.readTrace({ ruleRef: fixture.ruleRef, target: fixture.target }, { signal: fixture.controller.signal });
  const result = await read;
  assert.deepEqual(result, {
    status: "unavailable",
    ruleRef: fixture.ruleRef,
    target: fixture.target,
    reasons: ["timeout"],
  });
  await fixture.adapter.control.dispose();
  fixture.controller.abort();
});

test("reports an absent exact trace context as not retained", async () => {
  const fixture = await prepareAutomationTraceFixture();
  const read = fixture.traceHandle.readTrace({ ruleRef: fixture.ruleRef, target: fixture.target }, { signal: fixture.controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const contextsCommand = fixture.socket.sent.at(-1)!;
  fixture.socket.receive({ id: contextsCommand.id, type: "result", success: true, result: {} });
  const result = await read;
  assert.deepEqual(result, {
    status: "unknown",
    ruleRef: fixture.ruleRef,
    target: fixture.target,
    reasons: ["trace_not_retained"],
  });
  await fixture.adapter.control.dispose();
  fixture.controller.abort();
});

test("invalidates an in-flight automation trace when resync starts", async () => {
  const fixture = await prepareAutomationTraceFixture();
  const read = fixture.traceHandle.readTrace({ ruleRef: fixture.ruleRef, target: fixture.target }, { signal: fixture.controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const previousCommandCount = fixture.socket.sent.length;
  const resync = fixture.adapter.control.requestResync(new AbortController().signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const result = await read;
  assert.deepEqual(result, {
    status: "unknown",
    ruleRef: fixture.ruleRef,
    target: fixture.target,
    reasons: ["resync_stale"],
  });
  const resyncCommands = fixture.socket.sent.slice(previousCommandCount);
  assert.deepEqual(resyncCommands.map((command) => command.type), [
    "get_states",
    "config/entity_registry/list",
    "config/device_registry/list",
    "config/area_registry/list",
  ]);
  for (const command of resyncCommands) {
    const response = command.type === "get_states"
      ? [
          { entity_id: "automation.arrival_light", state: "on", attributes: { friendly_name: "Arrival light" } },
          { entity_id: "light.kitchen", state: "off", attributes: { friendly_name: "Kitchen light" } },
        ]
      : command.type === "config/entity_registry/list"
        ? [
            { id: "automation-stable-1", entity_id: "automation.arrival_light", device_id: "device-automation", name: "Arrival light" },
            { id: "entity-light-1", entity_id: "light.kitchen", device_id: "device-light", name: "Kitchen light" },
          ]
        : command.type === "config/device_registry/list"
          ? [{ id: "device-automation", name: "Automations" }, { id: "device-light", name: "Kitchen" }]
          : [];
    fixture.socket.receive({ id: command.id, type: "result", success: true, result: response });
  }
  assert.deepEqual(await resync, { status: "completed" });
  await fixture.adapter.control.dispose();
  fixture.controller.abort();
});

test("rejects oversized automation trace contexts and raw trace payloads", async () => {
  const contextsFixture = await prepareAutomationTraceFixture();
  const contextsRead = contextsFixture.traceHandle.readTrace({ ruleRef: contextsFixture.ruleRef, target: contextsFixture.target }, { signal: contextsFixture.controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const contextsCommand = contextsFixture.socket.sent.at(-1)!;
  const oversizedContexts: Record<string, unknown> = {};
  for (let index = 0; index < 257; index += 1) {
    oversizedContexts[`context-${index}`] = { run_id: `run-${index}`, domain: "automation", item_id: "arrival_light" };
  }
  contextsFixture.socket.receive({ id: contextsCommand.id, type: "result", success: true, result: oversizedContexts });
  const contextsResult = await contextsRead;
  assert.deepEqual(contextsResult.status, "unknown");
  assert.deepEqual(contextsResult.status === "unknown" ? contextsResult.reasons : [], ["invalid_response"]);
  await contextsFixture.adapter.control.dispose();
  contextsFixture.controller.abort();

  const traceFixture = await prepareAutomationTraceFixture();
  const traceRead = traceFixture.traceHandle.readTrace({ ruleRef: traceFixture.ruleRef, target: traceFixture.target }, { signal: traceFixture.controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const traceContextsCommand = traceFixture.socket.sent.at(-1)!;
  traceFixture.socket.receive({
    id: traceContextsCommand.id,
    type: "result",
    success: true,
    result: {
      "automation-context-id": { run_id: "native-run-id", domain: "automation", item_id: "arrival_light" },
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const traceGetCommand = traceFixture.socket.sent.at(-1)!;
  traceFixture.socket.receive({
    id: traceGetCommand.id,
    type: "result",
    success: true,
    result: {
      run_id: "native-run-id",
      state: "stopped",
      script_execution: "finished",
      timestamp: { start: "2026-08-25T10:00:00.000+00:00", finish: "2026-08-25T10:00:01.000+00:00" },
      domain: "automation",
      item_id: "arrival_light",
      trace: { oversized: "x".repeat(300_000) },
    },
  });
  const traceResult = await traceRead;
  assert.deepEqual(traceResult.status, "unknown");
  assert.deepEqual(traceResult.status === "unknown" ? traceResult.reasons : [], ["invalid_response"]);
  await traceFixture.adapter.control.dispose();
  traceFixture.controller.abort();
});

test("keeps the required state stream when automation event subscription is rejected", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const controller = new AbortController();
  const iterator = adapter.events(controller.signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket, false);
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") {
    events.push((await iterator.next()).value!);
  }

  const stateSubscription = socket.sent.find((message) => (
    message.type === "subscribe_events" && message.event_type === "state_changed"
  ));
  const automationSubscription = socket.sent.find((message) => (
    message.type === "subscribe_events" && message.event_type === "automation_triggered"
  ));
  assert.notEqual(stateSubscription, undefined);
  assert.notEqual(automationSubscription, undefined);

  const next = iterator.next();
  socket.receive({
    id: stateSubscription!.id,
    type: "event",
    event: {
      event_type: "state_changed",
      time_fired: "2026-08-18T00:00:04.000Z",
      data: {
        entity_id: "light.kitchen",
        new_state: { state: "on", attributes: {} },
      },
    },
  });
  const stateEnvelope = await next;
  const causalityEnvelope = await iterator.next();
  assert.deepEqual(causalityEnvelope.value?.event, {
    kind: "ext",
    ext: "causality@1",
    payload: { refSeq: stateEnvelope.value!.seq, cause: { kind: "unknown" } },
  });

  await adapter.control.dispose();
  controller.abort();
});

test("does not infer a foreign rule from parent-only, unknown-entity, or invalid trigger evidence", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const controller = new AbortController();
  const iterator = adapter.events(controller.signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") {
    events.push((await iterator.next()).value!);
  }
  const stateSubscription = socket.sent.find((message) => (
    message.type === "subscribe_events" && message.event_type === "state_changed"
  ));
  const automationSubscription = socket.sent.find((message) => (
    message.type === "subscribe_events" && message.event_type === "automation_triggered"
  ));
  assert.notEqual(stateSubscription, undefined);
  assert.notEqual(automationSubscription, undefined);

  const receiveStateCause = async (
    state: "on" | "off",
    context: Record<string, unknown>,
    time: string,
  ): Promise<unknown> => {
    const next = iterator.next();
    socket.receive({
      id: stateSubscription!.id,
      type: "event",
      event: {
        event_type: "state_changed",
        time_fired: time,
        context,
        data: {
          entity_id: "light.kitchen",
          new_state: { state, attributes: {}, context },
        },
      },
    });
    await next;
    const causeEnvelope = await iterator.next();
    return causeEnvelope.value?.event.kind === "ext"
      ? causeEnvelope.value.event.payload.cause
      : undefined;
  };

  socket.receive({
    id: automationSubscription!.id,
    type: "event",
    event: {
      event_type: "automation_triggered",
      context: { id: "valid-auto-context", parent_id: "source-context" },
      data: { entity_id: "automation.arrival_light" },
    },
  });
  assert.deepEqual(await receiveStateCause(
    "on",
    { id: "target-context", parent_id: "valid-auto-context" },
    "2026-08-18T00:00:05.000Z",
  ), { kind: "unknown" });

  socket.receive({
    id: automationSubscription!.id,
    type: "event",
    event: {
      event_type: "automation_triggered",
      context: { id: "unknown-auto-context" },
      data: { entity_id: "automation.not_in_registry" },
    },
  });
  assert.deepEqual(await receiveStateCause(
    "off",
    { id: "unknown-auto-context" },
    "2026-08-18T00:00:06.000Z",
  ), { kind: "unknown" });

  socket.receive({
    id: automationSubscription!.id,
    type: "event",
    event: {
      event_type: "automation_triggered",
      context: { parent_id: "invalid-auto-context" },
      data: { entity_id: "automation.arrival_light" },
    },
  });
  assert.deepEqual(await receiveStateCause(
    "on",
    { id: "invalid-auto-context" },
    "2026-08-18T00:00:07.000Z",
  ), { kind: "unknown" });

  await adapter.control.dispose();
  controller.abort();
});

test("preserves receive order and never rewrites a cause after a late automation event", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const controller = new AbortController();
  const iterator = adapter.events(controller.signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") {
    events.push((await iterator.next()).value!);
  }
  const stateSubscription = socket.sent.find((message) => (
    message.type === "subscribe_events" && message.event_type === "state_changed"
  ));
  const automationSubscription = socket.sent.find((message) => (
    message.type === "subscribe_events" && message.event_type === "automation_triggered"
  ));
  assert.notEqual(stateSubscription, undefined);
  assert.notEqual(automationSubscription, undefined);
  const ruleRef = ((await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())?.rules[0])?.ruleRef;

  const receiveState = async (state: "on" | "off", time: string): Promise<unknown> => {
    const next = iterator.next();
    socket.receive({
      id: stateSubscription!.id,
      type: "event",
      event: {
        event_type: "state_changed",
        time_fired: time,
        context: { id: "late-context" },
        data: {
          entity_id: "light.kitchen",
          new_state: { state, attributes: {}, context: { id: "late-context" } },
        },
      },
    });
    await next;
    const causeEnvelope = await iterator.next();
    return causeEnvelope.value?.event.kind === "ext"
      ? causeEnvelope.value.event.payload.cause
      : undefined;
  };

  assert.deepEqual(await receiveState("on", "2026-08-18T00:00:08.000Z"), { kind: "unknown" });
  socket.receive({
    id: automationSubscription!.id,
    type: "event",
    event: {
      event_type: "automation_triggered",
      context: { id: "late-context" },
      data: { entity_id: "automation.arrival_light" },
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(await receiveState("off", "2026-08-18T00:00:09.000Z"), {
    kind: "foreign_rule",
    ruleRef,
  });

  await adapter.control.dispose();
  controller.abort();
});

test("clears observed automation contexts when a resync starts a new epoch", async () => {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket);
  const controller = new AbortController();
  const iterator = adapter.events(controller.signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") {
    events.push((await iterator.next()).value!);
  }
  const stateSubscription = socket.sent.find((message) => (
    message.type === "subscribe_events" && message.event_type === "state_changed"
  ));
  const automationSubscription = socket.sent.find((message) => (
    message.type === "subscribe_events" && message.event_type === "automation_triggered"
  ));
  assert.notEqual(stateSubscription, undefined);
  assert.notEqual(automationSubscription, undefined);

  const sendState = async (state: "on" | "off", time: string): Promise<unknown> => {
    const next = iterator.next();
    socket.receive({
      id: stateSubscription!.id,
      type: "event",
      event: {
        event_type: "state_changed",
        time_fired: time,
        context: { id: "resync-context" },
        data: {
          entity_id: "light.kitchen",
          new_state: { state, attributes: {}, context: { id: "resync-context" } },
        },
      },
    });
    const stateEnvelope = await next;
    const causeEnvelope = await iterator.next();
    return causeEnvelope.value?.event.kind === "ext"
      ? causeEnvelope.value.event.payload.cause
      : undefined;
  };

  socket.receive({
    id: automationSubscription!.id,
    type: "event",
    event: {
      event_type: "automation_triggered",
      context: { id: "resync-context" },
      data: { entity_id: "automation.arrival_light" },
    },
  });
  assert.deepEqual(await sendState("on", "2026-08-18T00:00:10.000Z"), {
    kind: "foreign_rule",
    ruleRef: ((await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())?.rules[0])?.ruleRef,
  });

  const previousCommandCount = socket.sent.length;
  const resync = adapter.control.requestResync(new AbortController().signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(await sendState("off", "2026-08-18T00:00:10.500Z"), { kind: "unknown" });
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
      ? [
          { entity_id: "automation.arrival_light", state: "on", attributes: { friendly_name: "Arrival light" } },
          { entity_id: "light.kitchen", state: "off", attributes: { friendly_name: "Kitchen light" } },
        ]
      : command.type === "config/entity_registry/list"
        ? [
            { id: "automation-stable-1", entity_id: "automation.arrival_light", device_id: "device-automation", name: "Arrival light" },
            { id: "entity-light-1", entity_id: "light.kitchen", device_id: "device-light", name: "Kitchen light" },
          ]
        : command.type === "config/device_registry/list"
          ? [{ id: "device-automation", name: "Automations" }, { id: "device-light", name: "Kitchen" }]
          : [];
    socket.receive({ id: command.id, type: "result", success: true, result });
  }
  const replayEvents: Envelope[] = [];
  while (replayEvents.at(-1)?.event.kind !== "sync-complete") {
    replayEvents.push((await iterator.next()).value!);
  }
  assert.deepEqual(await sendState("on", "2026-08-18T00:00:11.000Z"), { kind: "unknown" });

  await adapter.control.dispose();
  controller.abort();
});

test("expires observed automation contexts before reusing an old context id", async () => {
  const socket = new FakeSocket();
  let now = 1_000_000;
  const { adapter } = createAdapter(socket, {}, { clock: () => new Date(now).toISOString() });
  const controller = new AbortController();
  const iterator = adapter.events(controller.signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") {
    events.push((await iterator.next()).value!);
  }
  const stateSubscription = socket.sent.find((message) => (
    message.type === "subscribe_events" && message.event_type === "state_changed"
  ));
  const automationSubscription = socket.sent.find((message) => (
    message.type === "subscribe_events" && message.event_type === "automation_triggered"
  ));
  assert.notEqual(stateSubscription, undefined);
  assert.notEqual(automationSubscription, undefined);
  const ruleRef = ((await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())?.rules[0])?.ruleRef;

  const sendState = async (state: "on" | "off", time: string): Promise<unknown> => {
    const next = iterator.next();
    const context = { id: "expiring-context" };
    socket.receive({
      id: stateSubscription!.id,
      type: "event",
      event: {
        event_type: "state_changed",
        time_fired: time,
        context,
        data: {
          entity_id: "light.kitchen",
          new_state: { state, attributes: {}, context },
        },
      },
    });
    await next;
    const causeEnvelope = await iterator.next();
    return causeEnvelope.value?.event.kind === "ext"
      ? causeEnvelope.value.event.payload.cause
      : undefined;
  };

  socket.receive({
    id: automationSubscription!.id,
    type: "event",
    event: {
      event_type: "automation_triggered",
      context: { id: "expiring-context" },
      data: { entity_id: "automation.arrival_light" },
    },
  });
  assert.deepEqual(await sendState("on", "2026-08-18T00:00:12.000Z"), {
    kind: "foreign_rule",
    ruleRef,
  });

  now += 60_001;
  assert.deepEqual(await sendState("off", "2026-08-18T00:01:13.000Z"), { kind: "unknown" });

  await adapter.control.dispose();
  controller.abort();
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
  const receiveState = (state: "on" | "off", brightness: number, unknownAttributes: Record<string, unknown>) => socket.receive({
    id: subscription!.id,
    type: "event",
    event: {
      event_type: "state_changed",
      time_fired: "2026-08-18T00:00:02.000Z",
      data: {
        entity_id: "light.kitchen",
        new_state: {
          state,
          attributes: { brightness, unit_of_measurement: "%", ...unknownAttributes },
        },
      },
    },
  });
  receiveState("off", 200, { changed_vendor_field: "different", another_unknown: true });
  receiveState("off", 201, { changed_vendor_field: "different", another_unknown: true });

  const envelope = await next;
  assert.equal(envelope.value?.seq, 6);
  assert.equal(
    (envelope.value?.event as Extract<BridgeEvent, { kind: "state" }>).state.attrs.value,
    false,
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
  const firstCausality = await iterator.next();
  assert.equal(firstCausality.value?.event.kind, "ext");
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
    if (url.endsWith("/api/config")) {
      return new Response(JSON.stringify({ time_zone: "Asia/Shanghai" }), { status: 200 });
    }
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

function foreignRuleMigrationFetchFake(
  response: unknown,
  status = 200,
  options: { readonly invalidJson?: boolean; readonly responseFactory?: () => unknown } = {},
) {
  const requests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      method: init?.method ?? "GET",
      url,
      headers: { ...(init?.headers as Record<string, string>) },
    });
    const responseBody = url.endsWith("/api/config")
      ? { time_zone: "Asia/Shanghai" }
      : options.responseFactory?.() ?? response;
    return options.invalidJson
      ? new Response("not-json", { status })
      : new Response(JSON.stringify(responseBody), { status });
  };
  return { fetchImpl, requests };
}

function foreignRuleControlFetchFake(config: unknown, initialState: "on" | "off" = "on") {
  const requests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  const configReads: unknown[] = [];
  let configBody = config;
  let state = initialState;
  let invalidConfigJson = false;
  let configStatus = 200;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({
      method,
      url,
      headers: { ...(init?.headers as Record<string, string>) },
    });
    if (url.endsWith("/api/config")) return new Response(JSON.stringify({ time_zone: "Asia/Shanghai" }), { status: 200 });
    if (url.endsWith("/api/states/automation.arrival_light")) {
      return new Response(JSON.stringify({ state }), { status: 200 });
    }
    if (url.endsWith("/api/config/automation/config/arrival_light")) {
      if (method === "GET") configReads.push(configBody);
      return invalidConfigJson
        ? new Response("not-json", { status: configStatus })
        : new Response(JSON.stringify(configBody), { status: configStatus });
    }
    return new Response("{}", { status: 404 });
  };
  return {
    fetchImpl,
    requests,
    configReads,
    setState(next: "on" | "off") { state = next; },
    setConfig(next: unknown) { configBody = next; },
    setInvalidConfig(next: boolean) { invalidConfigJson = next; },
    setConfigStatus(next: number) { configStatus = next; },
  };
}

async function waitForForeignRuleServiceCommands(socket: FakeSocket, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (socket.sent.filter((message) => message.type === "call_service").length >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const automationTarget = {
  hwCapabilityId: "cap-light",
  binding: { bridgeId: "bridge-ha", nativeId: "device-1", nativeInstanceId: "entity-stable-1" },
};

const hubAutomationSpec = (automationId: string) => ({
  automationId,
  title: "睡前自动关掉多媒体室电源",
  trigger: { kind: "schedule" as const, timezone: "Asia/Shanghai", daysOfWeek: [1, 2, 3, 4, 5], at: "23:30" },
  conditions: [{ kind: "capability_value" as const, source: automationTarget, operator: "equals" as const, value: false }],
  actions: [{ kind: "set_boolean" as const, target: automationTarget, value: false }],
});

async function readyAutomationAdapter(fake: ReturnType<typeof automationFetchFake>) {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket, "light.kitchen");
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);
  return { adapter, handle: adapter.extension("automations@1") as AutomationsExtension };
}

async function readyAutomationV2Adapter(fake: ReturnType<typeof automationFetchFake>) {
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket, "light.kitchen");
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);
  return { adapter, socket, handle: adapter.extension("automations@2") as AutomationsExtensionV2 };
}

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

  assert.equal(result.status, "deployed");
  assert.equal((result as { nativeAutomationId: string }).nativeAutomationId, "hob_media_power");
  assert.match((result as { configFingerprint?: string }).configFingerprint ?? "", /^sha256:/);
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
  assert.equal(fake.requests.filter((request) => request.method === "GET" && !request.url.endsWith("/api/config")).length, 2);
  await adapter.control.dispose();
});

test("does not overwrite an external automation that reuses the Hub id", async () => {
  const fake = automationFetchFake();
  fake.stored.set("hob_external", {
    alias: "hob_external",
    description: "A household rule",
    trigger: [],
    condition: [],
    action: [{ service: "light.turn_on" }],
    mode: "single",
  });
  const { adapter, handle } = await readyAutomationAdapter(fake);

  const result = await handle.deploy(hubAutomationSpec("hob_external"), { signal: new AbortController().signal });

  assert.equal(result.status, "rejected");
  assert.equal(fake.requests.some((request) => request.method === "POST"), false);
  await adapter.control.dispose();
});

test("does not post when the deterministic config preflight returns an HTTP failure", async () => {
  const fake = automationFetchFake();
  const delegate = fake.fetchImpl;
  fake.fetchImpl = async (input, init) => {
    if (String(input).endsWith("/api/config/automation/config/hob_preflight_500") && (init?.method ?? "GET") === "GET") {
      return new Response("{}", { status: 500 });
    }
    return delegate(input, init);
  };
  const { adapter, handle } = await readyAutomationAdapter(fake);

  const result = await handle.deploy(hubAutomationSpec("hob_preflight_500"), { signal: new AbortController().signal });

  assert.equal(result.status, "rejected");
  assert.equal((result as { reason?: string }).reason, "unavailable");
  assert.equal(fake.requests.some((request) => request.method === "POST"), false);
  await adapter.control.dispose();
});

test("does not post when the deterministic config preflight throws", async () => {
  const fake = automationFetchFake();
  const delegate = fake.fetchImpl;
  fake.fetchImpl = async (input, init) => {
    if (String(input).endsWith("/api/config/automation/config/hob_preflight_throw") && (init?.method ?? "GET") === "GET") {
      throw new Error("configuration request timed out");
    }
    return delegate(input, init);
  };
  const { adapter, handle } = await readyAutomationAdapter(fake);

  const result = await handle.deploy(hubAutomationSpec("hob_preflight_throw"), { signal: new AbortController().signal });

  assert.equal(result.status, "rejected");
  assert.equal((result as { reason?: string }).reason, "unavailable");
  assert.equal(fake.requests.some((request) => request.method === "POST"), false);
  await adapter.control.dispose();
});

test("does not post when the deterministic config preflight body is invalid", async () => {
  const fake = automationFetchFake();
  const delegate = fake.fetchImpl;
  fake.fetchImpl = async (input, init) => {
    if (String(input).endsWith("/api/config/automation/config/hob_preflight_invalid") && (init?.method ?? "GET") === "GET") {
      return new Response("not-json", { status: 200 });
    }
    return delegate(input, init);
  };
  const { adapter, handle } = await readyAutomationAdapter(fake);

  const result = await handle.deploy(hubAutomationSpec("hob_preflight_invalid"), { signal: new AbortController().signal });

  assert.equal(result.status, "rejected");
  assert.equal((result as { reason?: string }).reason, "failed");
  assert.equal(fake.requests.some((request) => request.method === "POST"), false);
  await adapter.control.dispose();
});

test("treats an owned unchanged automation as an idempotent deployment", async () => {
  const fake = automationFetchFake();
  const { adapter, handle } = await readyAutomationAdapter(fake);
  const spec = hubAutomationSpec("hob_idempotent");

  const first = await handle.deploy(spec, { signal: new AbortController().signal });
  const second = await handle.deploy(spec, { signal: new AbortController().signal });

  assert.equal(first.status, "deployed");
  assert.equal(second.status, "deployed");
  assert.equal(fake.requests.filter((request) => request.method === "POST").length, 1);
  await adapter.control.dispose();
});

test("automations v2 replays an uncertain deploy by operation id after read-back", async () => {
  const fake = automationFetchFake();
  const delegate = fake.fetchImpl;
  let losePostResponse = true;
  fake.fetchImpl = async (input, init) => {
    const result = await delegate(input, init);
    if (losePostResponse && (init?.method ?? "GET") === "POST") {
      losePostResponse = false;
      throw new Error("deployment response lost after Home Assistant accepted it");
    }
    return result;
  };
  const { adapter, socket, handle } = await readyAutomationV2Adapter(fake);
  const request = { operationId: "0123456789abcdef0123456789abcdef", spec: hubAutomationSpec("hob_v2_replay") };

  const uncertain = await handle.deploy(request, { signal: new AbortController().signal });
  assert.deepEqual(uncertain, {
    status: "unknown",
    operationId: request.operationId,
    reason: "unavailable",
  });
  const replay = await handle.deploy(request, { signal: new AbortController().signal });
  assert.equal(replay.status, "deployed");
  assert.equal((replay as { operationId: string }).operationId, request.operationId);
  assert.equal(fake.requests.filter((item) => item.method === "POST").length, 1);

  const collision = await handle.deploy({
    operationId: request.operationId,
    spec: { ...request.spec, title: "不同方案" },
  }, { signal: new AbortController().signal });
  assert.deepEqual(collision, {
    status: "rejected",
    operationId: request.operationId,
    reason: "failed",
  });
  assert.equal(fake.requests.filter((item) => item.method === "POST").length, 1);
  await adapter.control.dispose();
});

test("automations v2 resolves an uncertain toggle from desired state without replaying the service write", async () => {
  const fake = automationFetchFake();
  const delegate = fake.fetchImpl;
  let state: "on" | "off" = "on";
  fake.fetchImpl = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/states/automation.hob_v2_toggle")) {
      return new Response(JSON.stringify({ state }), { status: 200 });
    }
    return delegate(input, init);
  };
  const { adapter, socket, handle } = await readyAutomationV2Adapter(fake);
  const spec = hubAutomationSpec("hob_v2_toggle");
  const deployed = await handle.deploy({
    operationId: "11111111111111111111111111111111",
    spec,
  }, { signal: new AbortController().signal });
  assert.equal(deployed.status, "deployed");

  const request = {
    operationId: "22222222222222222222222222222222",
    nativeAutomationId: spec.automationId,
    enabled: false,
  } as const;
  const pending = handle.setEnabled(request, { signal: new AbortController().signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const command = socket.sent.filter((item) => item.type === "call_service").at(-1)!;
  state = "off";
  socket.receive({ id: command.id, type: "result", success: false, error: { message: "response lost" } });
  assert.deepEqual(await pending, { status: "unknown", operationId: request.operationId, reason: "unavailable" });

  const writesBeforeReplay = socket.sent.filter((item) => item.type === "call_service").length;
  assert.deepEqual(await handle.setEnabled(request, { signal: new AbortController().signal }), {
    status: "acknowledged",
    operationId: request.operationId,
  });
  assert.equal(socket.sent.filter((item) => item.type === "call_service").length, writesBeforeReplay);
  await adapter.control.dispose();
});

test("automations v2 replays an uncertain withdrawal from missing read-back", async () => {
  const fake = automationFetchFake();
  const delegate = fake.fetchImpl;
  let loseDeleteResponse = true;
  fake.fetchImpl = async (input, init) => {
    const result = await delegate(input, init);
    if (loseDeleteResponse && (init?.method ?? "GET") === "DELETE") {
      loseDeleteResponse = false;
      throw new Error("withdrawal response lost after Home Assistant removed it");
    }
    return result;
  };
  const { adapter, handle } = await readyAutomationV2Adapter(fake);
  const spec = hubAutomationSpec("hob_v2_withdraw");
  await handle.deploy({ operationId: "33333333333333333333333333333333", spec }, { signal: new AbortController().signal });
  const request = {
    operationId: "44444444444444444444444444444444",
    nativeAutomationId: spec.automationId,
  } as const;

  assert.deepEqual(await handle.withdraw(request, { signal: new AbortController().signal }), {
    status: "unknown",
    operationId: request.operationId,
    reason: "unavailable",
  });
  assert.deepEqual(await handle.withdraw(request, { signal: new AbortController().signal }), {
    status: "acknowledged",
    operationId: request.operationId,
  });
  assert.equal(fake.requests.filter((item) => item.method === "DELETE").length, 1);
  await adapter.control.dispose();
});

test("rejects a Hub-owned automation whose compiled behavior drifted without posting", async () => {
  const fake = automationFetchFake();
  fake.stored.set("hob_drifted", {
    id: "hob_drifted",
    alias: "hob_drifted",
    description: "hob:previous title",
    trigger: [{ platform: "time", at: "22:30:00" }],
    condition: [],
    action: [{ service: "homeassistant.turn_off", target: { entity_id: "light.kitchen" } }],
    mode: "single",
  });
  const { adapter, handle } = await readyAutomationAdapter(fake);

  const result = await handle.deploy(hubAutomationSpec("hob_drifted"), { signal: new AbortController().signal });

  assert.equal(result.status, "rejected");
  assert.equal(fake.requests.some((request) => request.method === "POST"), false);
  await adapter.control.dispose();
});

test("reports unknown when an automation config disappears after a successful state read", async () => {
  const base = automationFetchFake();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/states/automation.hob_status_404")) {
      return new Response(JSON.stringify({ state: "on" }), { status: 200 });
    }
    if (url.endsWith("/api/config/automation/config/hob_status_404")) {
      return new Response("{}", { status: 404 });
    }
    return base.fetchImpl(input, init);
  };
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket, {}, { fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket, "light.kitchen");
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);

  const handle = adapter.extension("automations@1") as AutomationsExtension;
  assert.deepEqual(await handle.status(
    { nativeAutomationId: "hob_status_404" },
    { signal: new AbortController().signal },
  ), { status: "unknown" });
  await adapter.control.dispose();
});

test("reports unknown when an automation config read times out after a successful state read", async () => {
  const base = automationFetchFake();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/states/automation.hob_status_timeout")) {
      return new Response(JSON.stringify({ state: "off" }), { status: 200 });
    }
    if (url.endsWith("/api/config/automation/config/hob_status_timeout")) {
      throw new Error("configuration request timed out");
    }
    return base.fetchImpl(input, init);
  };
  const socket = new FakeSocket();
  const { adapter } = createAdapter(socket, {}, { fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToBootstrap(socket, "light.kitchen");
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);

  const handle = adapter.extension("automations@1") as AutomationsExtension;
  assert.deepEqual(await handle.status(
    { nativeAutomationId: "hob_status_timeout" },
    { signal: new AbortController().signal },
  ), { status: "unknown" });
  await adapter.control.dispose();
});

test("withdrawal refuses an automation without the Hub ownership marker", async () => {
  const fake = automationFetchFake();
  fake.stored.set("hob_foreign_withdraw", {
    id: "hob_foreign_withdraw",
    alias: "hob_foreign_withdraw",
    description: "manual rule",
    trigger: [],
    condition: [],
    action: [],
    mode: "single",
  });
  const { adapter, handle } = await readyAutomationAdapter(fake);

  const result = await handle.withdraw(
    { nativeAutomationId: "hob_foreign_withdraw" },
    { signal: new AbortController().signal },
  );

  assert.equal(result.status, "rejected");
  assert.equal(fake.requests.some((request) => request.method === "DELETE"), false);
  await adapter.control.dispose();
});

test("withdrawal deletes an automation only after confirming its Hub ownership marker", async () => {
  const fake = automationFetchFake();
  fake.stored.set("hob_owned_withdraw", {
    id: "hob_owned_withdraw",
    alias: "hob_owned_withdraw",
    description: "hob:owned rule",
    trigger: [],
    condition: [],
    action: [],
    mode: "single",
  });
  const { adapter, handle } = await readyAutomationAdapter(fake);

  const result = await handle.withdraw(
    { nativeAutomationId: "hob_owned_withdraw" },
    { signal: new AbortController().signal },
  );

  assert.deepEqual(result, { status: "acknowledged" });
  assert.equal(fake.requests.filter((request) => request.method === "GET").length, 1);
  assert.equal(fake.requests.filter((request) => request.method === "DELETE").length, 1);
  assert.equal(fake.stored.has("hob_owned_withdraw"), false);
  await adapter.control.dispose();
});

test("withdrawal does not delete when its config preflight returns an HTTP failure", async () => {
  const fake = automationFetchFake();
  const delegate = fake.fetchImpl;
  fake.fetchImpl = async (input, init) => {
    if (String(input).endsWith("/api/config/automation/config/hob_withdraw_500") && (init?.method ?? "GET") === "GET") {
      return new Response("{}", { status: 500 });
    }
    return delegate(input, init);
  };
  const { adapter, handle } = await readyAutomationAdapter(fake);

  const result = await handle.withdraw(
    { nativeAutomationId: "hob_withdraw_500" },
    { signal: new AbortController().signal },
  );

  assert.equal(result.status, "rejected");
  assert.equal((result as { reason?: string }).reason, "unavailable");
  assert.equal(fake.requests.some((request) => request.method === "DELETE"), false);
  await adapter.control.dispose();
});

test("withdrawal does not delete when its config preflight throws", async () => {
  const fake = automationFetchFake();
  const delegate = fake.fetchImpl;
  fake.fetchImpl = async (input, init) => {
    if (String(input).endsWith("/api/config/automation/config/hob_withdraw_throw") && (init?.method ?? "GET") === "GET") {
      throw new Error("configuration request timed out");
    }
    return delegate(input, init);
  };
  const { adapter, handle } = await readyAutomationAdapter(fake);

  const result = await handle.withdraw(
    { nativeAutomationId: "hob_withdraw_throw" },
    { signal: new AbortController().signal },
  );

  assert.equal(result.status, "rejected");
  assert.equal((result as { reason?: string }).reason, "unavailable");
  assert.equal(fake.requests.some((request) => request.method === "DELETE"), false);
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
  assert.equal(fake.requests.some((request) => request.method === "DELETE"), false);

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


test("rejects a schedule whose timezone differs from the Home Assistant instance", async () => {
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
  const result = await handle!.deploy({
    automationId: "hob_shifted",
    title: "错时区方案",
    trigger: { kind: "schedule", timezone: "Europe/Berlin", daysOfWeek: [1], at: "07:00" },
    conditions: [],
    actions: [{ kind: "set_boolean", target: automationTarget, value: true }],
  }, { signal: new AbortController().signal });
  assert.equal(result.status, "rejected");
  assert.equal((result as { reason: string }).reason, "unsupported");
  assert.equal(fake.requests.some((request) => request.method === "POST"), false, "a shifted schedule never reaches the config API");
  await adapter.control.dispose();
});

test("reads one foreign rule through an opaque ruleRef with a neutral fingerprint", async () => {
  const socket = new FakeSocket();
  const nativeConfig = {
    alias: "到家灯光",
    mode: "single",
    trigger: [{ platform: "state", entity_id: "light.kitchen" }],
    condition: [],
    action: [{ service: "homeassistant.turn_on", target: { entity_id: "light.kitchen" } }],
  };
  const fake = foreignRuleControlFetchFake(nativeConfig);
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  while ((await iterator.next()).value?.event.kind !== "sync-complete") continue;

  const catalog = await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog();
  const ruleRef = catalog?.rules[0]?.ruleRef;
  assert.equal(typeof ruleRef, "string");
  const handle = adapter.extension("foreignRuleControl@1") as ForeignRuleControlHandle;
  const result = await handle.status({ ruleRef: ruleRef! }, { signal: new AbortController().signal });

  assert.equal(result.status, "running");
  if (result.status !== "running") assert.fail("expected a running foreign rule");
  assert.match(result.sourceFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result).includes("arrival_light"), false);
  assert.deepEqual(fake.requests.map((request) => request.url), [
    "http://ha.local:8123/api/states/automation.arrival_light",
    "http://ha.local:8123/api/config/automation/config/arrival_light",
  ]);
  await adapter.control.dispose();
  void first;
});

test("rejects a stale foreign source before sending a service command", async () => {
  const socket = new FakeSocket();
  const nativeConfig = {
    alias: "到家灯光",
    description: "hob:到家灯光",
    mode: "single",
    trigger: [{ platform: "state", entity_id: "light.kitchen" }],
    condition: [],
    action: [{ service: "homeassistant.turn_on", target: { entity_id: "light.kitchen" } }],
  };
  const fake = foreignRuleControlFetchFake(nativeConfig);
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  while ((await iterator.next()).value?.event.kind !== "sync-complete") continue;
  const ruleRef = (await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())!.rules[0]!.ruleRef;
  const handle = adapter.extension("foreignRuleControl@1") as ForeignRuleControlHandle;
  const observed = await handle.status({ ruleRef }, { signal: new AbortController().signal });
  if (observed.status !== "running") assert.fail("expected a running source rule");
  fake.setConfig({ ...nativeConfig, alias: "preflight 已漂移", description: "hob:preflight 已漂移" });
  const result = await handle.setEnabled({
    ruleRef,
    expectedSourceFingerprint: observed.sourceFingerprint,
    enabled: false,
    operationId: "0123456789abcdef0123456789abcdef",
  }, { signal: new AbortController().signal });

  assert.deepEqual(result, { status: "rejected", reason: "stale_source" });
  assert.equal(socket.sent.filter((message) => message.type === "call_service").length, 0);
  await adapter.control.dispose();
  void first;
});

test("reports a foreign rule missing from the bound opaque catalog without writing", async () => {
  const socket = new FakeSocket();
  const fake = foreignRuleControlFetchFake({
    alias: "到家灯光",
    mode: "single",
    trigger: [{ platform: "state", entity_id: "light.kitchen" }],
    condition: [],
    action: [{ service: "homeassistant.turn_on", target: { entity_id: "light.kitchen" } }],
  });
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  while ((await iterator.next()).value?.event.kind !== "sync-complete") continue;
  const handle = adapter.extension("foreignRuleControl@1") as ForeignRuleControlHandle;

  assert.deepEqual(await handle.status({ ruleRef: "ha-rule:missing" }, { signal: new AbortController().signal }), {
    status: "missing",
  });
  assert.deepEqual(await handle.setEnabled({
    ruleRef: "ha-rule:missing",
    expectedSourceFingerprint: `sha256:${"a".repeat(64)}`,
    enabled: false,
    operationId: "0123456789abcdef0123456789abcdef",
  }, { signal: new AbortController().signal }), { status: "rejected", reason: "not_found" });
  assert.equal(socket.sent.some((message) => message.type === "call_service"), false);
  await adapter.control.dispose();
  void first;
});

test("sets a foreign rule and verifies target state and source fingerprint after the service ack", async () => {
  const socket = new FakeSocket();
  const fake = foreignRuleControlFetchFake({
    alias: "到家灯光",
    mode: "single",
    trigger: [{ platform: "state", entity_id: "light.kitchen" }],
    condition: [],
    action: [{ service: "homeassistant.turn_on", target: { entity_id: "light.kitchen" } }],
  });
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  while ((await iterator.next()).value?.event.kind !== "sync-complete") continue;
  const ruleRef = (await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())!.rules[0]!.ruleRef;
  const handle = adapter.extension("foreignRuleControl@1") as ForeignRuleControlHandle;
  const observed = await handle.status({ ruleRef }, { signal: new AbortController().signal });
  if (observed.status !== "running") assert.fail("expected a running source rule");

  const pending = handle.setEnabled({
    ruleRef,
    expectedSourceFingerprint: observed.sourceFingerprint,
    enabled: false,
    operationId: "fedcba9876543210fedcba9876543210",
  }, { signal: new AbortController().signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const command = socket.sent.at(-1)!;
  assert.equal(command.type, "call_service");
  assert.equal(command.domain, "automation");
  assert.equal(command.service, "turn_off");
  assert.deepEqual(command.target, { entity_id: "automation.arrival_light" });
  fake.setState("off");
  socket.receive({ id: command.id, type: "result", success: true, result: null });

  const result = await pending;
  assert.deepEqual(result, { status: "paused", sourceFingerprint: observed.sourceFingerprint });
  assert.equal(JSON.stringify(result).includes("arrival_light"), false);
  await adapter.control.dispose();
  void first;
});

test("shares one foreign rule toggle result for concurrent and sequential operation replays", async () => {
  const socket = new FakeSocket();
  const fake = foreignRuleControlFetchFake({
    alias: "到家灯光",
    mode: "single",
    trigger: [{ platform: "state", entity_id: "light.kitchen" }],
    condition: [],
    action: [{ service: "homeassistant.turn_on", target: { entity_id: "light.kitchen" } }],
  });
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  while ((await iterator.next()).value?.event.kind !== "sync-complete") continue;
  const ruleRef = (await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())!.rules[0]!.ruleRef;
  const handle = adapter.extension("foreignRuleControl@1") as ForeignRuleControlHandle;
  const observed = await handle.status({ ruleRef }, { signal: new AbortController().signal });
  if (observed.status !== "running") assert.fail("expected a running foreign rule");
  const request = {
    ruleRef,
    expectedSourceFingerprint: observed.sourceFingerprint,
    enabled: false,
    operationId: "abcdefabcdefabcdefabcdefabcdefab",
  } as const;

  const concurrent = [
    handle.setEnabled(request, { signal: new AbortController().signal }),
    handle.setEnabled(request, { signal: new AbortController().signal }),
  ];
  await waitForForeignRuleServiceCommands(socket, 1);
  const serviceCommands = socket.sent.filter((message) => message.type === "call_service");
  fake.setState("off");
  for (const command of serviceCommands) {
    socket.receive({ id: command.id, type: "result", success: true, result: null });
  }

  const concurrentResults = await Promise.all(concurrent);
  assert.deepEqual(concurrentResults[0], { status: "paused", sourceFingerprint: observed.sourceFingerprint });
  assert.deepEqual(concurrentResults[1], concurrentResults[0]);
  const replay = handle.setEnabled(request, { signal: new AbortController().signal });
  await waitForForeignRuleServiceCommands(socket, serviceCommands.length + 1);
  const replayCommands = socket.sent.filter((message) => message.type === "call_service");
  fake.setState("off");
  for (const command of replayCommands.slice(serviceCommands.length)) {
    socket.receive({ id: command.id, type: "result", success: true, result: null });
  }
  assert.deepEqual(await replay, concurrentResults[0]);
  await adapter.control.dispose();
  assert.equal(serviceCommands.length, 1, "one operation id has one remote write");
  assert.equal(replayCommands.length, 1, "a sequential replay has no additional remote write");
  void first;
});

test("rejects an operation id collision before any remote read or write", async () => {
  const socket = new FakeSocket();
  const fake = foreignRuleControlFetchFake({
    alias: "到家灯光",
    mode: "single",
    trigger: [{ platform: "state", entity_id: "light.kitchen" }],
    condition: [],
    action: [{ service: "homeassistant.turn_on", target: { entity_id: "light.kitchen" } }],
  });
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  while ((await iterator.next()).value?.event.kind !== "sync-complete") continue;
  const ruleRef = (await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())!.rules[0]!.ruleRef;
  const handle = adapter.extension("foreignRuleControl@1") as ForeignRuleControlHandle;
  const observed = await handle.status({ ruleRef }, { signal: new AbortController().signal });
  if (observed.status !== "running") assert.fail("expected a running foreign rule");
  const operationId = "0123456789abcdef0123456789abcdef";
  const request = {
    ruleRef,
    expectedSourceFingerprint: observed.sourceFingerprint,
    enabled: false,
    operationId,
  } as const;
  const pending = handle.setEnabled(request, { signal: new AbortController().signal });
  await waitForForeignRuleServiceCommands(socket, 1);
  const command = socket.sent.filter((message) => message.type === "call_service").at(-1);
  assert.notEqual(command, undefined);
  fake.setState("off");
  socket.receive({ id: command!.id, type: "result", success: true, result: null });
  const result = await pending;
  assert.deepEqual(result, { status: "paused", sourceFingerprint: observed.sourceFingerprint });
  const requestsBeforeCollision = fake.requests.length;
  const writesBeforeCollision = socket.sent.filter((message) => message.type === "call_service").length;

  const collision = await handle.setEnabled({
    ...request,
    enabled: true,
  }, { signal: new AbortController().signal });
  assert.deepEqual(collision, { status: "rejected", reason: "failed" });
  assert.equal(fake.requests.length, requestsBeforeCollision, "a collision performs no remote read");
  assert.equal(socket.sent.filter((message) => message.type === "call_service").length, writesBeforeCollision, "a collision performs no remote write");
  await adapter.control.dispose();
  void first;
});

test("bounds concurrent foreign rule operations at the fixed ledger capacity", async () => {
  const socket = new FakeSocket();
  const fake = foreignRuleControlFetchFake({
    alias: "到家灯光",
    mode: "single",
    trigger: [{ platform: "state", entity_id: "light.kitchen" }],
    condition: [],
    action: [{ service: "homeassistant.turn_on", target: { entity_id: "light.kitchen" } }],
  });
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  while ((await iterator.next()).value?.event.kind !== "sync-complete") continue;
  const ruleRef = (await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())!.rules[0]!.ruleRef;
  const handle = adapter.extension("foreignRuleControl@1") as ForeignRuleControlHandle;
  const observed = await handle.status({ ruleRef }, { signal: new AbortController().signal });
  if (observed.status !== "running") assert.fail("expected a running foreign rule");
  const ledgerLimit = MAX_HOME_ASSISTANT_FOREIGN_RULE_CONTROL_OPERATIONS;
  const operations = Array.from({ length: ledgerLimit + 1 }, (_, index) => handle.setEnabled({
    ruleRef,
    expectedSourceFingerprint: observed.sourceFingerprint,
    enabled: false,
    operationId: index.toString(16).padStart(32, "0"),
  }, { signal: new AbortController().signal }));
  await waitForForeignRuleServiceCommands(socket, ledgerLimit + 1);
  fake.setState("off");
  for (const command of socket.sent.filter((message) => message.type === "call_service")) {
    socket.receive({ id: command.id, type: "result", success: true, result: null });
  }
  const overflowResult = await operations[ledgerLimit]!;
  const remoteWrites = socket.sent.filter((message) => message.type === "call_service").length;
  await adapter.control.dispose();
  await Promise.all(operations);
  assert.equal(remoteWrites, ledgerLimit, "the adapter retains at most the fixed number of in-flight operations");
  assert.deepEqual(overflowResult, { status: "rejected", reason: "unavailable" });
  void first;
});

test("returns effect-uncertain when Home Assistant does not acknowledge a foreign rule toggle", async () => {
  const socket = new FakeSocket();
  const fake = foreignRuleControlFetchFake({
    alias: "到家灯光",
    mode: "single",
    trigger: [{ platform: "state", entity_id: "light.kitchen" }],
    condition: [],
    action: [{ service: "homeassistant.turn_on", target: { entity_id: "light.kitchen" } }],
  });
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  while ((await iterator.next()).value?.event.kind !== "sync-complete") continue;
  const ruleRef = (await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())!.rules[0]!.ruleRef;
  const handle = adapter.extension("foreignRuleControl@1") as ForeignRuleControlHandle;
  const observed = await handle.status({ ruleRef }, { signal: new AbortController().signal });
  if (observed.status !== "running") assert.fail("expected a running source rule");

  const pending = handle.setEnabled({
    ruleRef,
    expectedSourceFingerprint: observed.sourceFingerprint,
    enabled: false,
    operationId: "00112233445566778899aabbccddeeff",
  }, { signal: new AbortController().signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const command = socket.sent.at(-1)!;
  socket.receive({ id: command.id, type: "result", success: false, error: { message: "upstream unavailable" } });

  assert.deepEqual(await pending, { status: "unknown", reason: "upstream_unavailable" });
  await adapter.control.dispose();
  void first;
});

test("returns unknown when a foreign rule config drifts between preflight and final read-back", async () => {
  const socket = new FakeSocket();
  const nativeConfig = {
    alias: "到家灯光",
    description: "hob:到家灯光",
    mode: "single",
    trigger: [{ platform: "state", entity_id: "light.kitchen" }],
    condition: [],
    action: [{ service: "homeassistant.turn_on", target: { entity_id: "light.kitchen" } }],
  };
  const fake = foreignRuleControlFetchFake(nativeConfig);
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  while ((await iterator.next()).value?.event.kind !== "sync-complete") continue;
  const ruleRef = (await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())!.rules[0]!.ruleRef;
  const handle = adapter.extension("foreignRuleControl@1") as ForeignRuleControlHandle;
  const observed = await handle.status({ ruleRef }, { signal: new AbortController().signal });
  if (observed.status !== "running") assert.fail("expected a running source rule");
  const configReadsBeforeSetEnabled = fake.configReads.length;

  const pending = handle.setEnabled({
    ruleRef,
    expectedSourceFingerprint: observed.sourceFingerprint,
    enabled: false,
    operationId: "fedcba9876543210fedcba9876543210",
  }, { signal: new AbortController().signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const command = socket.sent.at(-1)!;
  assert.equal(command.type, "call_service");
  assert.equal(socket.sent.filter((message) => message.type === "call_service").length, 1);
  fake.setConfig({ ...nativeConfig, alias: "被改写的规则", description: "外部修改后的描述" });
  fake.setState("off");
  socket.receive({ id: command.id, type: "result", success: true, result: null });

  const result = await pending;
  assert.deepEqual(result, { status: "unknown", reason: "upstream_unavailable" });
  assert.notEqual(result.status, "running");
  assert.notEqual(result.status, "paused");
  const configReads = fake.configReads.slice(configReadsBeforeSetEnabled);
  assert.equal(configReads.length, 2, "setEnabled reads config once before and once after the service command");
  assert.deepEqual(configReads[0], nativeConfig);
  assert.equal((configReads[0] as { alias: string }).alias, "到家灯光");
  assert.equal((configReads[0] as { description: string }).description, "hob:到家灯光");
  assert.equal((configReads[1] as { alias: string }).alias, "被改写的规则");
  assert.equal((configReads[1] as { description: string }).description, "外部修改后的描述");
  assert.notDeepEqual(configReads[0], configReads[1], "the final config has a different source fingerprint");
  assert.equal(socket.sent.filter((message) => message.type === "call_service").length, 1);
  await adapter.control.dispose();
  void first;
});

test("fails closed when foreign rule configuration read-back is invalid", async () => {
  const socket = new FakeSocket();
  const fake = foreignRuleControlFetchFake({
    alias: "到家灯光",
    mode: "single",
    trigger: [{ platform: "state", entity_id: "light.kitchen" }],
    condition: [],
    action: [{ service: "homeassistant.turn_on", target: { entity_id: "light.kitchen" } }],
  });
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  while ((await iterator.next()).value?.event.kind !== "sync-complete") continue;
  const ruleRef = (await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())!.rules[0]!.ruleRef;
  fake.setInvalidConfig(true);
  const handle = adapter.extension("foreignRuleControl@1") as ForeignRuleControlHandle;

  assert.deepEqual(await handle.status({ ruleRef }, { signal: new AbortController().signal }), {
    status: "unknown",
    reason: "invalid_response",
  });
  await adapter.control.dispose();
  void first;
});

test("translates one opaque foreign rule through a read-only versioned migration extension", async () => {
  const socket = new FakeSocket();
  const nativeConfig = {
    alias: "晚间灯光",
    mode: "single",
    trigger: [{ platform: "state", entity_id: "light.kitchen" }],
    condition: [{ condition: "state", entity_id: "light.kitchen", state: "off" }],
    action: [{
      service: "light.turn_on",
      target: { entity_id: "light.kitchen" },
      data: { brightness_pct: 50 },
    }],
  };
  const fake = foreignRuleMigrationFetchFake(nativeConfig);
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);

  const catalog = await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog();
  const ruleRef = catalog?.rules[0]?.ruleRef;
  assert.equal(typeof ruleRef, "string");
  const handle = adapter.extension("foreignRuleMigration@1") as ForeignRuleMigrationHandle | undefined;
  assert.equal(typeof handle?.translate, "function");

  const firstResult = await handle!.translate({ ruleRef: ruleRef! }, { signal: new AbortController().signal });
  assert.equal(firstResult.status, "translated");
  if (firstResult.status !== "translated") assert.fail("expected a translated result");
  assert.equal(firstResult.ruleRef, ruleRef);
  assert.match(firstResult.sourceFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(firstResult.title, "晚间灯光");
  assert.deepEqual(firstResult.plan, {
    trigger: {
      kind: "capability_changed",
      source: { bridgeId: "bridge-ha", nativeId: "device-light", nativeInstanceId: "entity-light-1" },
    },
    conditions: [{
      kind: "capability_value",
      source: { bridgeId: "bridge-ha", nativeId: "device-light", nativeInstanceId: "entity-light-1" },
      operator: "equals",
      value: false,
    }],
    actions: [{
      kind: "set_level",
      target: { bridgeId: "bridge-ha", nativeId: "device-light", nativeInstanceId: "entity-light-1" },
      level: 0.5,
    }],
  });
  assert.equal(JSON.stringify(firstResult).includes("entity_id"), false);
  assert.equal(JSON.stringify(firstResult).includes("light.turn_on"), false);
  assert.equal(JSON.stringify(firstResult).includes("automation.arrival_light"), false);
  assert.deepEqual(fake.requests.map((request) => ({ method: request.method, url: request.url })), [{
    method: "GET",
    url: "http://ha.local:8123/api/config/automation/config/arrival_light",
  }]);

  await adapter.control.dispose();
});

test("translates exact boolean-actuator domain actions and rejects non-empty action data", async () => {
  const cases = [
    ...(["light", "switch", "fan", "input_boolean"] as const).map((domain) => ({
      entityId: `${domain}.actuator`,
      action: { service: `${domain}.turn_off`, target: { entity_id: `${domain}.actuator` }, data: {} },
      respond: (socket: FakeSocket) => respondToForeignActuatorBootstrap(socket, `${domain}.actuator`),
      expected: "translated" as const,
    })),
    {
      entityId: "light.kitchen",
      action: { service: "light.turn_off", target: { entity_id: "light.kitchen" }, data: { transition: 1 } },
      respond: respondToForeignRuleBootstrap,
      expected: "unsupported" as const,
    },
    {
      entityId: "light.kitchen",
      action: { service: "switch.turn_off", target: { entity_id: "light.kitchen" }, data: {} },
      respond: respondToForeignRuleBootstrap,
      expected: "unsupported" as const,
    },
  ];

  for (const candidate of cases) {
    const socket = new FakeSocket();
    const fake = foreignRuleMigrationFetchFake({
      alias: "执行器开关",
      mode: "single",
      trigger: [{ platform: "state", entity_id: candidate.entityId }],
      condition: [{ condition: "state", entity_id: candidate.entityId, state: "on" }],
      action: [candidate.action],
    });
    const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
    const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    candidate.respond(socket);
    const events: Envelope[] = [(await first).value!];
    while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);
    const ruleRef = (await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())!.rules[0]!.ruleRef;
    const result = await (adapter.extension("foreignRuleMigration@1") as ForeignRuleMigrationHandle).translate(
      { ruleRef },
      { signal: new AbortController().signal },
    );

    if (candidate.expected === "translated") {
      assert.equal(result.status, "translated");
      if (result.status === "translated") {
        assert.deepEqual(result.plan.conditions[0]?.value, true);
        assert.deepEqual(result.plan.actions, [{
          kind: "set_boolean",
          target: candidate.entityId.endsWith(".actuator")
            ? { bridgeId: "bridge-ha", nativeId: "device-actuator", nativeInstanceId: "entity-actuator-1" }
            : { bridgeId: "bridge-ha", nativeId: "device-light", nativeInstanceId: "entity-light-1" },
          value: false,
        }]);
      }
    } else {
      assert.deepEqual(result, { status: "unsupported", reason: "unsupported_action" });
    }
    await adapter.control.dispose();
  }
});

test("keeps schedule weekday semantics and rejects non-zero seconds", async () => {
  const translate = async (at: string, condition: unknown) => {
    const socket = new FakeSocket();
    const fake = foreignRuleMigrationFetchFake({
      alias: "工作日灯光",
      mode: "single",
      trigger: [{ platform: "time", at }],
      condition,
      action: [{ service: "homeassistant.turn_off", target: { entity_id: "light.kitchen" } }],
    });
    const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
    const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    respondToForeignRuleBootstrap(socket);
    const events: Envelope[] = [(await first).value!];
    while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);
    const ruleRef = (await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())!.rules[0]!.ruleRef;
    const result = await (adapter.extension("foreignRuleMigration@1") as ForeignRuleMigrationHandle).translate(
      { ruleRef },
      { signal: new AbortController().signal },
    );
    await adapter.control.dispose();
    return result;
  };

  const weekday = await translate("08:00:00", [{ condition: "time", weekday: ["mon", "wed", "fri"] }]);
  assert.equal(weekday.status, "translated");
  if (weekday.status !== "translated") assert.fail("expected translated schedule");
  assert.deepEqual(weekday.plan.trigger, {
    kind: "schedule",
    timezone: "Asia/Shanghai",
    daysOfWeek: [1, 3, 5],
    at: "08:00",
  });

  assert.deepEqual(await translate("08:00:99", []), {
    status: "unsupported",
    reason: "unsupported_trigger",
  });
});

test("accepts the compiler-symmetric schedule with one weekday condition and eight neutral conditions", async () => {
  const socket = new FakeSocket();
  const fake = foreignRuleMigrationFetchFake({
    alias: "完整工作日规则",
    mode: "single",
    trigger: [{ platform: "time", at: "08:00" }],
    condition: [
      { condition: "time", weekday: ["mon", "tue", "wed", "thu", "fri"] },
      ...Array.from({ length: 8 }, (_, index) => ({
        condition: "state",
        entity_id: "light.kitchen",
        state: `state-${index}`,
      })),
    ],
    action: [{ service: "homeassistant.turn_off", target: { entity_id: "light.kitchen" } }],
  });
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);
  const ruleRef = (await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())!.rules[0]!.ruleRef;
  const result = await (adapter.extension("foreignRuleMigration@1") as ForeignRuleMigrationHandle).translate(
    { ruleRef },
    { signal: new AbortController().signal },
  );

  assert.equal(result.status, "translated");
  if (result.status !== "translated") assert.fail("expected translated schedule");
  assert.deepEqual(result.plan.trigger, {
    kind: "schedule",
    timezone: "Asia/Shanghai",
    daysOfWeek: [1, 2, 3, 4, 5],
    at: "08:00",
  });
  assert.equal(result.plan.conditions.length, 8);
  assert.equal(result.plan.conditions.every((condition) => condition.kind === "capability_value"), true);
  await adapter.control.dispose();
});

test("keeps the source fingerprint stable when native config object keys are reordered", async () => {
  const socket = new FakeSocket();
  const firstConfig = {
    alias: "稳定指纹",
    mode: "single",
    trigger: [{ platform: "state", entity_id: "light.kitchen" }],
    condition: [],
    action: [{ service: "homeassistant.turn_on", target: { entity_id: "light.kitchen" } }],
  };
  const secondConfig = {
    action: [{ target: { entity_id: "light.kitchen" }, service: "homeassistant.turn_on" }],
    condition: [],
    trigger: [{ entity_id: "light.kitchen", platform: "state" }],
    mode: "single",
    alias: "稳定指纹",
  };
  let responseIndex = 0;
  const fake = foreignRuleMigrationFetchFake(firstConfig, 200, {
    responseFactory: () => responseIndex++ === 0 ? firstConfig : secondConfig,
  });
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);
  const ruleRef = (await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())!.rules[0]!.ruleRef;
  const handle = adapter.extension("foreignRuleMigration@1") as ForeignRuleMigrationHandle;
  const firstResult = await handle.translate({ ruleRef }, { signal: new AbortController().signal });
  const secondResult = await handle.translate({ ruleRef }, { signal: new AbortController().signal });
  assert.equal(firstResult.status, "translated");
  assert.equal(secondResult.status, "translated");
  if (firstResult.status === "translated" && secondResult.status === "translated") {
    assert.equal(firstResult.sourceFingerprint, secondResult.sourceFingerprint);
  }
  await adapter.control.dispose();
});

test("rejects a foreign config body over the byte budget before translation", async () => {
  const socket = new FakeSocket();
  const fake = foreignRuleMigrationFetchFake("x".repeat(MAX_HOME_ASSISTANT_FOREIGN_RULE_CONFIG_BYTES));
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);
  const ruleRef = (await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())!.rules[0]!.ruleRef;
  assert.deepEqual(
    await (adapter.extension("foreignRuleMigration@1") as ForeignRuleMigrationHandle).translate(
      { ruleRef },
      { signal: new AbortController().signal },
    ),
    { status: "unavailable", reason: "invalid_response" },
  );
  await adapter.control.dispose();
});

test("does not read an arbitrary native config for an unknown opaque rule reference", async () => {
  const socket = new FakeSocket();
  const fake = foreignRuleMigrationFetchFake({});
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);

  const handle = adapter.extension("foreignRuleMigration@1") as ForeignRuleMigrationHandle;
  assert.deepEqual(
    await handle.translate({ ruleRef: "ha-rule:unknown" }, { signal: new AbortController().signal }),
    { status: "unsupported", reason: "unknown_rule" },
  );
  assert.deepEqual(fake.requests, []);
  await adapter.control.dispose();
});

test("closes unsupported native rule shapes without exposing provider details", async () => {
  const socket = new FakeSocket();
  const fake = foreignRuleMigrationFetchFake({
    alias: "多分支规则",
    mode: "restart",
    trigger: [{ platform: "state", entity_id: "light.kitchen" }],
    condition: [],
    action: [{ service: "light.turn_on", target: { entity_id: "light.kitchen" }, data: { brightness_pct: 50 } }],
  });
  const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  respondToForeignRuleBootstrap(socket);
  const events: Envelope[] = [(await first).value!];
  while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);
  const ruleRef = (await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())!.rules[0]!.ruleRef;
  const result = await (adapter.extension("foreignRuleMigration@1") as ForeignRuleMigrationHandle).translate(
    { ruleRef },
    { signal: new AbortController().signal },
  );
  assert.deepEqual(result, { status: "unsupported", reason: "mode_not_single" });
  assert.equal(JSON.stringify(result).includes("restart"), false);
  await adapter.control.dispose();
});

test("maps HTTP and parse failures to redacted unavailable results", async () => {
  for (const fake of [
    foreignRuleMigrationFetchFake({ error: "secret native detail" }, 500),
    foreignRuleMigrationFetchFake({}, 200, { invalidJson: true }),
  ]) {
    const socket = new FakeSocket();
    const { adapter } = createAdapter(socket, {}, { fetchImpl: fake.fetchImpl });
    const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    respondToForeignRuleBootstrap(socket);
    const events: Envelope[] = [(await first).value!];
    while (events.at(-1)?.event.kind !== "sync-complete") events.push((await iterator.next()).value!);
    const ruleRef = (await (adapter.extension("foreignRules@2") as ForeignRulesHandle).catalog())!.rules[0]!.ruleRef;
    const result = await (adapter.extension("foreignRuleMigration@1") as ForeignRuleMigrationHandle).translate(
      { ruleRef },
      { signal: new AbortController().signal },
    );
    assert.equal(result.status, "unavailable");
    assert.equal(JSON.stringify(result).includes("secret native detail"), false);
    await adapter.control.dispose();
  }
});
