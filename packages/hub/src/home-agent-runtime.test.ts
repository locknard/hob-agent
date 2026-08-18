import assert from "node:assert/strict";
import test from "node:test";

import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from "@deepseek-ai/dsh-launch-environment";

import { type HomeAssistantBridgeOptions, type WebSocketLike } from "./home-assistant-bridge.js";
import {
  createHomeAgentRuntime,
} from "./home-agent-runtime.js";

class FakeSocket implements WebSocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  closeCount = 0;
  onclose: (() => void) | undefined;
  onerror: ((error: Error) => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closeCount += 1;
    this.onclose?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function respondToBootstrap(socket: FakeSocket): void {
  for (const command of socket.sent.slice(1)) {
    socket.receive({
      id: command.id,
      type: "result",
      success: true,
      result: command.type === "get_states"
        ? [{ entity_id: "light.kitchen", state: "on", attributes: {} }]
        : [],
    });
  }
}

function homeAssistantOptions(socket: FakeSocket): HomeAssistantBridgeOptions {
  return {
    baseUrl: "http://ha.local:8123",
    accessToken: "not-logged",
    socketFactory: () => socket,
  };
}

function launchEnvironment() {
  return createLaunchEnvironmentSnapshot([{
    source: "process" as const,
    values: { DEEPSEEK_API_KEY: "test-provider-key" },
  }]);
}

test("starts HA before the DSH Home Agent and stops both from one owned runtime", async () => {
  const socket = new FakeSocket();
  const runtime = createHomeAgentRuntime({
    homeAssistant: homeAssistantOptions(socket),
    launchEnvironment: launchEnvironment(),
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "home-runtime-test",
    },
  });
  const pluginOrder: string[] = [];
  runtime.context.on("internal/plugin", (fiber) => {
    if (fiber.uid !== null) pluginOrder.push(fiber.runtime?.callback.name ?? fiber.name);
  });

  assert.equal(runtime.status, "created");
  const starting = runtime.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  socket.receive({ type: "auth_required" });
  socket.receive({ type: "auth_ok" });
  respondToBootstrap(socket);
  await starting;

  assert.equal(runtime.status, "running");
  assert.deepEqual(pluginOrder.slice(0, 2), ["HomeAssistantService", "DshHomeAgentComposition"]);
  assert.equal(runtime.context.root, runtime.context);
  assert.equal(runtime.context.homeAssistant.snapshot.states[0]?.entity_id, "light.kitchen");
  assert.equal(String(runtime.context.homeAgent.agent.id), "home-runtime-test");

  await runtime.stop();

  assert.equal(runtime.status, "stopped");
  assert.equal(socket.closeCount, 1);
  assert.equal(runtime.context.homeAssistant, undefined);
  assert.equal(runtime.context.homeAgent, undefined);
  await runtime.stop();
  assert.equal(socket.closeCount, 1);
});

test("stops the already-mounted HA bridge when DSH startup fails", async () => {
  const socket = new FakeSocket();
  const runtime = createHomeAgentRuntime({
    homeAssistant: homeAssistantOptions(socket),
    launchEnvironment: launchEnvironment(),
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      profile: {
        id: "deepseek:primary",
        provider: "deepseek",
        kind: "api_key",
        secretRef: "keychain:hob-agent/deepseek:primary",
      },
    },
  });

  const starting = runtime.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  socket.receive({ type: "auth_required" });
  socket.receive({ type: "auth_ok" });
  respondToBootstrap(socket);

  await assert.rejects(starting, /Selected profile and SecretVault must be provided together/);
  assert.equal(runtime.status, "stopped");
  assert.equal(socket.closeCount, 1);
  assert.equal(runtime.context.homeAssistant, undefined);
  assert.equal(runtime.context.homeAgent, undefined);
});

test("provides the immutable DSH launch environment before any runtime plugin mounts", () => {
  const snapshot = launchEnvironment();
  const runtime = createHomeAgentRuntime({
    homeAssistant: homeAssistantOptions(new FakeSocket()),
    launchEnvironment: snapshot,
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "launch-environment-test",
    },
  });

  assert.equal(runtime.context.get(DSH_LAUNCH_ENVIRONMENT_KEY), snapshot);
});
