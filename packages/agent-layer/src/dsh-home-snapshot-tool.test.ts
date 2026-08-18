import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { type ToolDefinition } from "@deepseek-ai/dsh-tools";

import { apply, inject, name } from "./dsh-home-snapshot-tool.js";

class StubWorldService extends Service {
  readonly snapshot = {
    devices: [],
    bridgeWatermarks: [],
    diagnostics: [],
  };

  constructor(ctx: Context) {
    super(ctx, "homeWorld");
  }
}

test("mounts and unloads through the real DSH tool registry", async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(StubWorldService);
  const fiber = await ctx.plugin({ name, inject, apply });

  assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name), ["get_home_snapshot"]);

  await fiber.dispose();
  assert.deepEqual(ctx.tools.schemas(), []);
  await ctx.fiber.dispose();
});

test("registers get_home_snapshot and returns an empty neutral projection", async () => {
  let registered: ToolDefinition | undefined;
  const ctx = {
    homeWorld: {
      snapshot: { devices: [], bridgeWatermarks: [], diagnostics: [] },
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
    devices: [],
    bridgeWatermarks: [],
    metrics: { consistency: [], eventActivity: [], connectionActivity: [] },
  });
  assert.deepEqual(registered!.output.render({}, value as never), [
    { type: "text", text: JSON.stringify(value) },
  ]);
});

test("projects homeWorld into neutral devices, bridge watermarks, and three metric summaries", async () => {
  let registered: ToolDefinition | undefined;
  const ctx = {
    homeWorld: {
      snapshot: {
        devices: [
          {
            hwId: "hw-b",
            bindings: [{ bridgeId: "bridge-b", nativeId: "native-b", nativeInstanceId: "cap-b" }],
            name: "Beta",
            validity: "stale" as const,
            capabilities: [{
              hwCapabilityId: "hc-b",
              hwId: "hw-b",
              schema: "hob.light",
              schemaVersion: "1.0.0",
              bindings: [{ bridgeId: "bridge-b", nativeId: "native-b", nativeInstanceId: "cap-b" }],
            }],
            states: [{
              nativeId: "native-b",
              nativeInstanceId: "cap-b",
              attrs: { z: "last", a: "first", ignored: () => "not-json" },
              time: { sourceTs: "2026-08-18T00:00:00.000Z", sourceTsQuality: "device" as const },
              origin: "observed" as const,
            }],
          },
          {
            hwId: "hw-a",
            bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "cap-a" }],
            validity: "valid" as const,
            capabilities: [{
              hwCapabilityId: "hc-a",
              hwId: "hw-a",
              schema: "hob.sensor",
              schemaVersion: "1.0.0",
              bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "cap-a" }],
            }],
            states: [],
          },
        ],
        bridgeWatermarks: [
          { bridgeId: "bridge-b", epochId: "epoch-b", lastSeq: 9, lastSyncCompleteAt: "2026-08-18T00:00:09.000Z" },
          { bridgeId: "bridge-a", epochId: "epoch-a", lastSeq: 3 },
        ],
        diagnostics: [
          {
            bridgeId: "bridge-b",
            connectionState: "ready" as const,
            lastSyncCompleteAt: "2026-08-18T00:00:09.000Z",
            lastEventReceivedAt: "2026-08-18T00:00:10.000Z",
            lastSuccessfulContactAt: "2026-08-18T00:00:10.000Z",
          },
          {
            bridgeId: "bridge-a",
            connectionState: "degraded" as const,
            lastEventReceivedAt: "2026-08-18T00:00:03.000Z",
            lastSuccessfulContactAt: "2026-08-18T00:00:03.000Z",
          },
        ],
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
  const value = await registered!.execute({}, {} as never);

  assert.deepEqual(value, {
    devices: [
      {
        hwId: "hw-a",
        bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "cap-a" }],
        validity: "valid",
        capabilities: [{
          hwCapabilityId: "hc-a",
          hwId: "hw-a",
          schema: "hob.sensor",
          schemaVersion: "1.0.0",
          bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "cap-a" }],
        }],
        states: [],
      },
      {
        hwId: "hw-b",
        bindings: [{ bridgeId: "bridge-b", nativeId: "native-b", nativeInstanceId: "cap-b" }],
        name: "Beta",
        validity: "stale",
        capabilities: [{
          hwCapabilityId: "hc-b",
          hwId: "hw-b",
          schema: "hob.light",
          schemaVersion: "1.0.0",
          bindings: [{ bridgeId: "bridge-b", nativeId: "native-b", nativeInstanceId: "cap-b" }],
        }],
        states: [{
          nativeId: "native-b",
          nativeInstanceId: "cap-b",
          attrs: { a: "first", z: "last" },
          time: { sourceTs: "2026-08-18T00:00:00.000Z", sourceTsQuality: "device" },
          origin: "observed",
        }],
      },
    ],
    bridgeWatermarks: [
      { bridgeId: "bridge-a", epochId: "epoch-a", lastSeq: 3 },
      { bridgeId: "bridge-b", epochId: "epoch-b", lastSeq: 9, lastSyncCompleteAt: "2026-08-18T00:00:09.000Z" },
    ],
    metrics: {
      consistency: [
        { bridgeId: "bridge-a", state: "degraded" },
        { bridgeId: "bridge-b", state: "ready", lastSyncCompleteAt: "2026-08-18T00:00:09.000Z" },
      ],
      eventActivity: [
        { bridgeId: "bridge-a", lastEventReceivedAt: "2026-08-18T00:00:03.000Z" },
        { bridgeId: "bridge-b", lastEventReceivedAt: "2026-08-18T00:00:10.000Z" },
      ],
      connectionActivity: [
        { bridgeId: "bridge-a", state: "degraded", lastSuccessfulContactAt: "2026-08-18T00:00:03.000Z" },
        { bridgeId: "bridge-b", state: "ready", lastSuccessfulContactAt: "2026-08-18T00:00:10.000Z" },
      ],
    },
  });
});

test("projects the neutral home-world service snapshot shape without ecosystem knowledge", async () => {
  let registered: ToolDefinition | undefined;
  const ctx = {
    homeWorld: {
      snapshot: {
        generatedAt: "2026-08-18T00:00:00.000Z",
        devices: [{
          bridgeId: "bridge-a",
          hwId: "hw-a",
          bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "cap-a" }],
          name: "Kitchen lamp",
          capabilities: [{
            hwCapabilityId: "hc-a",
            hwId: "hw-a",
            schema: "hob.light",
            schemaVersion: "1.0.0",
            bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "cap-a" }],
          }],
          states: {
            "cap-a": {
              nativeId: "native-a",
              nativeInstanceId: "cap-a",
              attrs: { state: "on" },
              time: { sourceTsQuality: "none" as const },
              origin: "observed" as const,
            },
          },
          validity: "valid" as const,
        }],
        bridges: {
          "bridge-a": {
            bridgeId: "bridge-a",
            adapterType: "neutral",
            diagnostics: {
              bridgeId: "bridge-a",
              connectionState: "ready" as const,
              lastSyncCompleteAt: "2026-08-18T00:00:00.000Z",
              lastEventReceivedAt: "2026-08-18T00:00:01.000Z",
              lastSuccessfulContactAt: "2026-08-18T00:00:01.000Z",
            },
            watermark: { epochId: "epoch-a", lastSeq: 4 },
            devices: [{
              bridgeId: "bridge-a",
              hwId: "hw-a",
              bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "cap-a" }],
              name: "Kitchen lamp",
              capabilities: [{
                hwCapabilityId: "hc-a",
                hwId: "hw-a",
                schema: "hob.light",
                schemaVersion: "1.0.0",
                bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "cap-a" }],
              }],
              states: {
                "cap-a": {
                  nativeId: "native-a",
                  nativeInstanceId: "cap-a",
                  attrs: { state: "on" },
                  time: { sourceTsQuality: "none" as const },
                  origin: "observed" as const,
                },
              },
              validity: "valid" as const,
            }],
            extensions: {},
            metrics: { consistency: "ready" as const, eventActivity: "active" as const, connection: "up" as const },
          },
        },
        watermarkVector: { "bridge-a": { epochId: "epoch-a", lastSeq: 4 } },
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
  const value = await registered!.execute({}, {} as never);

  assert.deepEqual(value, {
    devices: [{
      bridgeId: "bridge-a",
      hwId: "hw-a",
      bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "cap-a" }],
      name: "Kitchen lamp",
      validity: "valid",
      capabilities: [{
        hwCapabilityId: "hc-a",
        hwId: "hw-a",
        schema: "hob.light",
        schemaVersion: "1.0.0",
        bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "cap-a" }],
      }],
      states: [{
        nativeId: "native-a",
        nativeInstanceId: "cap-a",
        attrs: { state: "on" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      }],
    }],
    bridgeWatermarks: [{ bridgeId: "bridge-a", epochId: "epoch-a", lastSeq: 4 }],
    metrics: {
      consistency: [{ bridgeId: "bridge-a", state: "ready", lastSyncCompleteAt: "2026-08-18T00:00:00.000Z" }],
      eventActivity: [{ bridgeId: "bridge-a", lastEventReceivedAt: "2026-08-18T00:00:01.000Z" }],
      connectionActivity: [{ bridgeId: "bridge-a", state: "ready", lastSuccessfulContactAt: "2026-08-18T00:00:01.000Z" }],
    },
  });
});

test("keeps agent-layer source free of ecosystem-specific identity vocabulary", () => {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const forbiddenTerms = [
    ["home", "assistant"].join("").toLowerCase(),
    ["entity", "_id"].join("").toLowerCase(),
  ];
  for (const file of readdirSync(sourceDirectory).filter((entry) => entry.endsWith(".ts"))) {
    const source = readFileSync(join(sourceDirectory, file), "utf8").toLowerCase();
    for (const term of forbiddenTerms) assert.equal(source.includes(term), false, `${file} contains ${term}`);
  }
});
