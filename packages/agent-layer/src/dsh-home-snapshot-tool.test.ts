import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { type ToolDefinition } from "@deepseek-ai/dsh-tools";

import { apply, inject, name } from "./dsh-home-snapshot-tool.js";

class StubHomeAssistantService extends Service {
  readonly snapshot = {
    states: [],
    health: { bridge: "up" as const, devices: {} },
  };

  constructor(ctx: Context) {
    super(ctx, "homeAssistant");
  }
}

test("mounts and unloads through the real DSH tool registry", async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(StubHomeAssistantService);
  const fiber = await ctx.plugin({ name, inject, apply });

  assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name), ["get_home_snapshot"]);

  await fiber.dispose();
  assert.deepEqual(ctx.tools.schemas(), []);
  await ctx.fiber.dispose();
});

test("registers get_home_snapshot and returns a stable read-only projection", async () => {
  let registered: ToolDefinition | undefined;
  const ctx = {
    homeAssistant: {
      snapshot: {
        states: [
          {
            entity_id: "sensor.temperature",
            state: "21.5",
            attributes: { unit_of_measurement: "°C", friendly_name: "Room" },
          },
          {
            entity_id: "light.kitchen",
            state: "on",
            attributes: { friendly_name: "Kitchen" },
          },
        ],
        entityRegistry: [{ id: "ignored" }],
        deviceRegistry: [{ id: "ignored" }],
        areaRegistry: [{ id: "ignored" }],
        health: {
          bridge: "up" as const,
          devices: { "device-b": "unknown" as const, "device-a": "reachable" as const },
        },
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

  assert.equal(registered?.name, "get_home_snapshot");
  assert.deepEqual(registered?.parameters, { type: "object", properties: {} });
  const value = await registered!.execute({}, {} as never);

  assert.deepEqual(value, {
    states: [
      {
        entity_id: "light.kitchen",
        state: "on",
        attributes: { friendly_name: "Kitchen" },
      },
      {
        entity_id: "sensor.temperature",
        state: "21.5",
        attributes: { friendly_name: "Room", unit_of_measurement: "°C" },
      },
    ],
    health: {
      bridge: "up",
      devices: { "device-a": "reachable", "device-b": "unknown" },
    },
  });

  assert.deepEqual(registered!.output.render({}, value as never), [
    { type: "text", text: JSON.stringify(value) },
  ]);
});
