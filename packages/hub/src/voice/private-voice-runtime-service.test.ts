import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { PrivateVoiceRuntimeService } from "./private-voice-runtime-service.js";

test("mounts one provider-neutral turn owner and isolates capture surfaces", async () => {
  const context = new Context();
  const fiber = await context.plugin(PrivateVoiceRuntimeService);
  try {
    const kitchen = context.privateVoiceRuntime.dispatch("kitchen-satellite", {
      type: "begin",
      turnId: "turn-kitchen",
    });
    const wall = context.privateVoiceRuntime.dispatch("wall-panel", {
      type: "begin",
      turnId: "turn-wall",
    });

    assert.equal(kitchen.state.activeTurnId, "turn-kitchen");
    assert.equal(wall.state.activeTurnId, "turn-wall");
    assert.equal(context.privateVoiceRuntime.snapshot("kitchen-satellite").turns["turn-wall"], undefined);
    assert.equal(context.privateVoiceRuntime.snapshot("wall-panel").turns["turn-kitchen"], undefined);
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});

test("releases an idle surface but retains one whose action is owned by Hub", async () => {
  const context = new Context();
  const fiber = await context.plugin(PrivateVoiceRuntimeService);
  try {
    const runtime = context.privateVoiceRuntime;
    runtime.dispatch("idle-surface", { type: "begin", turnId: "idle-turn" });
    assert.equal(runtime.closeSurface("idle-surface"), true);

    runtime.dispatch("busy-surface", { type: "begin", turnId: "busy-turn" });
    runtime.dispatch("busy-surface", { type: "microphone_granted", turnId: "busy-turn" });
    runtime.dispatch("busy-surface", { type: "endpoint", turnId: "busy-turn" });
    runtime.dispatch("busy-surface", { type: "final", turnId: "busy-turn", text: "关灯" });
    runtime.dispatch("busy-surface", { type: "agent_confirmation", turnId: "busy-turn", ticketId: "ticket-a" });
    runtime.dispatch("busy-surface", {
      type: "confirm",
      turnId: "busy-turn",
      ticketId: "ticket-a",
      ticketActive: true,
      privateDeviceBound: true,
    });
    runtime.dispatch("busy-surface", { type: "hub_claimed", turnId: "busy-turn", ticketId: "ticket-a" });

    assert.equal(runtime.closeSurface("busy-surface"), false);
    assert.equal(runtime.snapshot("busy-surface").turns["busy-turn"]?.hubClaimed, true);
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});
