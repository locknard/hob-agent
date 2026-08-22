import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_HOME_ASSISTANT_CONNECT_TIMEOUT_MS,
  HomeAssistantBridge,
  probeHomeAssistantEndpoint,
  type SocketFactory,
  type WebSocketLike,
  toHomeAssistantWebSocketUrl,
} from "./home-assistant-bridge.js";

class FakeSocket implements WebSocketLike {
  readonly sent: unknown[] = [];
  onclose: (() => void) | undefined;
  onerror: ((error: Error) => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.onclose?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

test("converts HTTP Home Assistant URLs to the WebSocket endpoint", () => {
  assert.equal(
    toHomeAssistantWebSocketUrl("http://ha.local:8123/"),
    "ws://ha.local:8123/api/websocket",
  );
  assert.equal(
    toHomeAssistantWebSocketUrl("https://ha.example.test"),
    "wss://ha.example.test/api/websocket",
  );
});

test("preflights the WebSocket endpoint without sending credentials or commands", async () => {
  const socket = new FakeSocket();
  let now = 1_000;
  const preflight = probeHomeAssistantEndpoint({
    baseUrl: "http://ha.local:8123",
    socketFactory: () => socket,
    clock: () => now,
  });

  now = 1_123;
  socket.receive({ type: "auth_required", ha_version: "2026.6.4" });

  assert.deepEqual(await preflight, {
    status: "auth_required",
    version: "2026.6.4",
    latencyMs: 123,
  });
  assert.deepEqual(socket.sent, []);
});

test("rejects a formal connection that closes before authentication", async () => {
  const socket = new FakeSocket();
  const bridge = new HomeAssistantBridge({
    baseUrl: "http://ha.local:8123",
    accessToken: "not-logged",
    socketFactory: () => socket,
  });

  const connecting = bridge.connect();
  socket.close();

  await assert.rejects(
    Promise.race([
      connecting,
      new Promise<never>((_, reject) => {
        setImmediate(() => reject(new Error("connect did not settle before test deadline")));
      }),
    ]),
    /Home Assistant connection closed before authentication/,
  );
});

test("bounds formal connection startup with a configurable timeout", async () => {
  const socket = new FakeSocket();
  const bridge = new HomeAssistantBridge({
    baseUrl: "http://ha.local:8123",
    accessToken: "not-logged",
    socketFactory: () => socket,
    connectTimeoutMs: 1,
  });

  await assert.rejects(
    Promise.race([
      bridge.connect(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("connect did not time out before test deadline")), 50);
      }),
    ]),
    /Home Assistant connection timed out during startup/,
  );
  assert.deepEqual(socket.sent, []);
});

test("keeps formal connection startup bounded by a five-second default", () => {
  assert.equal(DEFAULT_HOME_ASSISTANT_CONNECT_TIMEOUT_MS, 5_000);
});

test("bounds an unresponsive Home Assistant preflight", async () => {
  const socket = new FakeSocket();
  await assert.rejects(
    probeHomeAssistantEndpoint({
      baseUrl: "http://ha.local:8123",
      socketFactory: () => socket,
      timeoutMs: 1,
    }),
    /preflight timed out/,
  );
  assert.deepEqual(socket.sent, []);
});

test("authenticates, reads a bootstrap snapshot, and forwards native state changes to the adapter seam", async () => {
  const socket = new FakeSocket();
  const socketFactory: SocketFactory = () => socket;
  const stateEvents: unknown[] = [];
  const bridge = new HomeAssistantBridge({
    baseUrl: "http://ha.local:8123",
    accessToken: "not-logged",
    socketFactory,
    onNativeStateEvent: (event) => stateEvents.push(event),
  });

  const bootstrapPromise = bridge.connect();
  socket.receive({ type: "auth_required", ha_version: "2026.8.0" });
  assert.deepEqual(socket.sent, [{ type: "auth", access_token: "not-logged" }]);

  socket.receive({ type: "auth_ok", ha_version: "2026.8.0" });
  const commands = socket.sent.slice(1) as Array<{ id: number; type: string; event_type?: string }>;
  assert.deepEqual(
    commands.map(({ type, event_type }) => ({ type, event_type })),
    [
      { type: "get_states", event_type: undefined },
      { type: "config/entity_registry/list", event_type: undefined },
      { type: "config/device_registry/list", event_type: undefined },
      { type: "config/area_registry/list", event_type: undefined },
      { type: "subscribe_events", event_type: "state_changed" },
    ],
  );

  for (const command of commands) {
    socket.receive({
      id: command.id,
      type: "result",
      success: true,
      result: command.type === "get_states" ? [{ entity_id: "light.kitchen", state: "on", attributes: {} }] : [],
    });
  }

  const snapshot = await bootstrapPromise;
  assert.equal(snapshot.states[0]?.entity_id, "light.kitchen");
  assert.equal(snapshot.entityRegistry.length, 0);
  assert.equal(snapshot.health.bridge, "up");

  const subscription = commands.at(-1)!;
  socket.receive({
    id: subscription.id,
    type: "event",
    event: {
      event_type: "state_changed",
      time_fired: "2026-08-18T00:00:00.000Z",
      data: {
        entity_id: "light.kitchen",
        new_state: { entity_id: "light.kitchen", state: "off", attributes: {} },
      },
    },
  });

  assert.deepEqual(stateEvents, [{
    entityId: "light.kitchen",
    state: "off",
    attrs: {},
    ts: "2026-08-18T00:00:00.000Z",
  }]);
});

test("does not expose a raw onStateEvent bypass at the Home Assistant boundary", () => {
  let seen: unknown;
  const bridge = new HomeAssistantBridge({
    baseUrl: "http://ha.local:8123",
    accessToken: "not-logged",
    onStateEvent: (event) => { seen = event; },
  } as never);

  (bridge as unknown as { forwardStateEvent(message: Record<string, unknown>): void }).forwardStateEvent({
    event: {
      event_type: "state_changed",
      time_fired: "2026-08-18T00:00:00.000Z",
      data: {
        entity_id: "light.kitchen",
        new_state: { state: "off", attributes: { secret: "raw" } },
      },
    },
  });

  assert.equal(seen, undefined);
});

test("rejects a bootstrap snapshot that exceeds the structural item budget", async () => {
  const socket = new FakeSocket();
  const bridge = new HomeAssistantBridge({
    baseUrl: "http://ha.local:8123",
    accessToken: "not-logged",
    socketFactory: () => socket,
    maxBootstrapItems: 1,
  } as never);

  const connecting = bridge.connect();
  socket.receive({ type: "auth_required", ha_version: "2026.8.0" });
  socket.receive({ type: "auth_ok", ha_version: "2026.8.0" });
  const commands = socket.sent.slice(1) as Array<{ id: number; type: string }>;
  for (const command of commands) {
    socket.receive({
      id: command.id,
      type: "result",
      success: true,
      result: command.type === "get_states"
        ? [
          { entity_id: "light.one", state: "on", attributes: {} },
          { entity_id: "light.two", state: "off", attributes: {} },
        ]
        : [],
    });
  }

  await assert.rejects(connecting, /bootstrap snapshot budget/);
});
