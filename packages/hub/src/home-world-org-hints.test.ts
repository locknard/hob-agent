import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";

import type { BridgeAdapter } from "@hob/bridge-contract";
import { ORG_HINTS_EXTENSION } from "@hob/bridge-contract";
import { BridgeCatalog } from "./bridge/bridge-catalog.js";
import { BridgeRegistry, MemoryBridgeRegistryStore } from "./bridge/bridge-registry.js";
import { HomeWorldService } from "./home-world-service.js";

test("projects a committed neutral non-spatial hint onto its Hub device", async () => {
  const adapter: BridgeAdapter = {
    info: {
      bridgeId: "bridge-a",
      coreVersion: "6.5.0",
      ecosystem: "test",
      heartbeatIntervalMs: 1_000,
      extensions: [ORG_HINTS_EXTENSION],
    },
    events: async function* (signal) {
      yield { epochId: "epoch-a", seq: 1, event: { kind: "sync-start", snapshotId: "snapshot-a", remoteInstanceId: "remote-a", reason: "initial" } };
      yield { epochId: "epoch-a", seq: 2, event: { kind: "device-upserted", device: { nativeId: "service-a", name: "Service", capabilities: [] } } };
      yield { epochId: "epoch-a", seq: 3, event: { kind: "ext", ext: "orgHints@1", payload: { nativeId: "service-a", spatialDisposition: "non_spatial" } } };
      yield { epochId: "epoch-a", seq: 4, event: { kind: "sync-complete", manifest: { snapshotId: "snapshot-a", deviceEnvelopeCount: 1, stateEnvelopeCount: 0 } } };
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    control: { requestResync: async () => ({ status: "completed" }), dispose: async () => undefined },
    extension: () => undefined,
  };
  const catalog = new BridgeCatalog();
  catalog.register({
    adapterType: "test",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas: [],
    factory: () => adapter,
  });
  const registry = new BridgeRegistry({ catalog, store: new MemoryBridgeRegistryStore() });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, {
    catalog,
    registry,
    bridges: [{ bridgeId: "bridge-a", adapterType: "test", config: {} }],
    monitorIntervalMs: 0,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(ctx.homeWorld.snapshot().devices[0]?.spatialDisposition, "non_spatial");

  await fiber.dispose();
});

test("drops a non-spatial hint when one merged bridge does not agree", async () => {
  const catalog = new BridgeCatalog();
  catalog.register({
    adapterType: "test",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas: [{
      schema: "test.sensor",
      majorVersion: 1,
      attrsSchema: z.object({}).strict(),
      canonicalHash: "test-sensor-v1",
    }],
    factory: ({ bridgeId }) => ({
      info: {
        bridgeId,
        coreVersion: "6.5.0",
        ecosystem: "test",
        heartbeatIntervalMs: 1_000,
        extensions: bridgeId === "bridge-a" ? [ORG_HINTS_EXTENSION] : [],
      },
      events: async function* (signal) {
        const epochId = `${bridgeId}-epoch`;
        yield { epochId, seq: 1, event: { kind: "sync-start" as const, snapshotId: `${bridgeId}-snapshot`, remoteInstanceId: `${bridgeId}-remote`, reason: "initial" as const } };
        yield { epochId, seq: 2, event: { kind: "device-upserted" as const, device: {
          nativeId: `${bridgeId}-device`,
          capabilities: [{
            nativeInstanceId: `${bridgeId}-sensor`,
            schema: "test.sensor",
            schemaVersion: "1.0.0",
            semanticKind: "sensor" as const,
          }],
          identityClaims: [{
            type: "serial" as const,
            value: "shared-serial",
            source: { kind: "independent_registry" as const, registry: "shared-test-registry" },
            confidence: "high" as const,
          }],
        } } };
        let seq = 3;
        if (bridgeId === "bridge-a") {
          yield { epochId, seq: seq++, event: { kind: "ext" as const, ext: "orgHints@1", payload: { nativeId: `${bridgeId}-device`, spatialDisposition: "non_spatial" } } };
        }
        yield { epochId, seq, event: { kind: "sync-complete" as const, manifest: { snapshotId: `${bridgeId}-snapshot`, deviceEnvelopeCount: 1, stateEnvelopeCount: 0 } } };
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      control: { requestResync: async () => ({ status: "completed" as const }), dispose: async () => undefined },
      extension: () => undefined,
    }),
  });
  const registry = new BridgeRegistry({ catalog, store: new MemoryBridgeRegistryStore() });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, {
    catalog,
    registry,
    bridges: [
      { bridgeId: "bridge-a", adapterType: "test", config: {} },
      { bridgeId: "bridge-b", adapterType: "test", config: {} },
    ],
    monitorIntervalMs: 0,
  });
  for (let attempt = 0; attempt < 50
    && ctx.homeWorld.snapshot().diagnostics.filter((item) => item.currentProcessReadyAt !== undefined).length !== 2;
    attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const snapshot = ctx.homeWorld.snapshot();
  assert.equal(snapshot.devices.length, 1);
  assert.equal(snapshot.devices[0]?.spatialDisposition, undefined);

  await fiber.dispose();
});
