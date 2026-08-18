import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { type WebSocketLike } from "./home-assistant-bridge.js";
import { HomeAssistantService } from "./home-assistant-service.js";

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

test("mounts the Home Assistant bridge as a Cordis service and closes it on disposal", async () => {
  const socket = new FakeSocket();
  const ctx = new Context();
  const loading = ctx.plugin(HomeAssistantService, {
    baseUrl: "http://ha.local:8123",
    accessToken: "not-logged",
    socketFactory: () => socket,
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  socket.receive({ type: "auth_required" });
  socket.receive({ type: "auth_ok" });
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

  const fiber = await loading;
  assert.equal(ctx.homeAssistant.snapshot.states[0]?.entity_id, "light.kitchen");

  await fiber.dispose();
  assert.equal(socket.closeCount, 1);
  assert.equal(ctx.homeAssistant, undefined);
});
