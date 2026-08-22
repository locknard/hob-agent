import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";

import type { BridgeAdapter } from "@hob/bridge-contract";
import "@hob/bridge-contract";
import { BridgeCatalog } from "./bridge-catalog.js";
import { BridgeRegistry, MemoryBridgeRegistryStore } from "./bridge-registry.js";
import { HomeWorldService } from "./home-world-service.js";

test("queries a bounded foreign-rule catalog through the neutral optional extension", async () => {
  const adapter: BridgeAdapter = {
    info: {
      bridgeId: "bridge-a",
      coreVersion: "6.3.0",
      ecosystem: "test",
      heartbeatIntervalMs: 1_000,
      extensions: [{ id: "foreignRules", version: "2.0.0" }],
    },
    events: async function* (signal) {
      yield {
        epochId: "epoch-a",
        seq: 1,
        event: { kind: "sync-start", snapshotId: "snapshot-a", remoteInstanceId: "remote-a", reason: "initial" },
      };
      yield {
        epochId: "epoch-a",
        seq: 2,
        event: { kind: "sync-complete", manifest: { snapshotId: "snapshot-a", deviceEnvelopeCount: 0, stateEnvelopeCount: 0 } },
      };
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    control: { requestResync: async () => ({ status: "completed" }), dispose: async () => undefined },
    extension: (name) => name === "foreignRules@2"
      ? { catalog: async () => ({ epochId: "epoch-a", lastSeq: 2, complete: true, rules: [{ ruleRef: "opaque-rule-1", name: "Arrival light", enabled: true }] }) } as never
      : undefined,
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

  assert.deepEqual(await ctx.homeWorld.foreignRuleCatalog(), [{
    bridgeId: "bridge-a",
    status: "available",
    epochId: "epoch-a",
    lastSeq: 2,
    rules: [{ ruleRef: "opaque-rule-1", name: "Arrival light", enabled: true }],
  }]);

  adapter.extension = ((name: string) => name === "foreignRules@2"
    ? { catalog: async () => ({ epochId: "uncommitted-epoch", lastSeq: 2, complete: true, rules: [] }) }
    : undefined) as BridgeAdapter["extension"];
  assert.deepEqual(await ctx.homeWorld.foreignRuleCatalog(), [{
    bridgeId: "bridge-a",
    status: "unavailable",
    rules: [],
  }]);

  adapter.extension = ((name: string) => name === "foreignRules@2"
    ? { catalog: async () => ({ epochId: "epoch-a", lastSeq: 2, complete: false, rules: [] }) }
    : undefined) as BridgeAdapter["extension"];
  assert.equal((await ctx.homeWorld.foreignRuleCatalog())[0]?.status, "unavailable");

  adapter.extension = ((name: string) => name === "foreignRules@2"
    ? { catalog: async () => ({ epochId: "epoch-a", lastSeq: 3, complete: true, rules: [] }) }
    : undefined) as BridgeAdapter["extension"];
  assert.equal((await ctx.homeWorld.foreignRuleCatalog())[0]?.status, "unavailable");

  adapter.extension = ((name: string) => name === "foreignRules@1"
    ? { catalog: async () => ({ epochId: "epoch-a", complete: true, rules: [] }) }
    : undefined) as BridgeAdapter["extension"];
  assert.deepEqual(await ctx.homeWorld.foreignRuleCatalog(), [{
    bridgeId: "bridge-a",
    status: "unavailable",
    rules: [],
  }]);

  await fiber.dispose();
});
