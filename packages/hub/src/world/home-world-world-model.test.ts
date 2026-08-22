import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";

import type { BridgeEvent, Envelope } from "@hob/bridge-contract";
import { BridgeCatalog } from "../bridge/bridge-catalog.js";
import { BridgeRegistry, type BridgeConfigEntry } from "../bridge/bridge-registry.js";
import { SqliteIngestJournal } from "./ingest-journal.js";
import {
  HomeWorldService,
  type HomeWorldServiceOptions,
} from "./home-world-service.js";
import { SyntheticBridge } from "../bridge/synthetic-bridge.js";
import { WorldModelIndex } from "./world-model-index.js";

const schema = {
  schema: "synthetic.light",
  majorVersion: 1,
  attrsSchema: z.record(z.string(), z.unknown()),
  canonicalHash: "synthetic-light-v1",
} as never;

type TestEntry = BridgeConfigEntry<Record<string, never>>;

function entry(bridgeId: string): TestEntry {
  return { bridgeId, adapterType: "synthetic-world", config: {} };
}

function frame(epochId: string, seq: number, event: BridgeEvent): Envelope {
  return { epochId, seq, event };
}

function snapshot(bridgeId: string, epochId: string, remoteInstanceId: string, temperature = 21): Envelope[] {
  const nativeId = `${bridgeId}-lamp`;
  const instanceId = `${nativeId}:main`;
  return [
    frame(epochId, 1, {
      kind: "sync-start",
      snapshotId: `${epochId}-snapshot`,
      remoteInstanceId,
      reason: "initial",
    }),
    frame(epochId, 2, {
      kind: "device-upserted",
      device: {
        nativeId,
        name: `${bridgeId} lamp`,
        capabilities: [{ nativeInstanceId: instanceId, schema: "synthetic.light", schemaVersion: "1.0.0" }],
      },
    }),
    frame(epochId, 3, {
      kind: "state",
      state: {
        nativeId,
        nativeInstanceId: instanceId,
        attrs: { state: "on", temperature },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }),
    frame(epochId, 4, {
      kind: "sync-complete",
      manifest: { snapshotId: `${epochId}-snapshot`, deviceEnvelopeCount: 1, stateEnvelopeCount: 1 },
    }),
  ];
}

function worldCatalog(factory: (bridgeId: string) => SyntheticBridge): BridgeCatalog {
  const catalog = new BridgeCatalog();
  catalog.register({
    adapterType: "synthetic-world",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas: [schema],
    factory: (ctx) => factory(ctx.bridgeId),
  });
  return catalog;
}

function options(
  catalog: BridgeCatalog,
  registry: BridgeRegistry,
  bridges: readonly TestEntry[],
  overrides: Partial<HomeWorldServiceOptions> = {},
): HomeWorldServiceOptions {
  return {
    catalog,
    registry,
    bridges,
    journalFactory: () => new SqliteIngestJournal(":memory:"),
    maxRestarts: 0,
    monitorIntervalMs: 0,
    scheduler: { wait: async () => undefined },
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for homeWorld");
}

test("materializes only completed journal cuts and exposes neutral world-model queries", async () => {
  const bridge = new SyntheticBridge({ bridgeId: "bridge-model", remoteInstanceId: "remote-model" });
  for (const event of snapshot("bridge-model", "epoch-a", "remote-model", 21)) bridge.enqueue(event);
  bridge.enqueue(frame("epoch-b", 1, {
    kind: "sync-start",
    snapshotId: "epoch-b-snapshot",
    remoteInstanceId: "remote-model",
    reason: "resync",
  }));
  bridge.enqueue(frame("epoch-b", 2, {
    kind: "device-upserted",
    device: {
      nativeId: "bridge-model-new-lamp",
      capabilities: [{ nativeInstanceId: "bridge-model-new-lamp:main", schema: "synthetic.light", schemaVersion: "1.0.0" }],
    },
  }));
  const catalog = worldCatalog(() => bridge);
  const registry = new BridgeRegistry({ catalog });
  const index = new WorldModelIndex({ path: ":memory:", minimumRawRecords: 1 });
  const context = new Context();
  const fiber = await context.plugin(HomeWorldService, options(catalog, registry, [entry("bridge-model")], {
    worldModelIndex: index,
  }));

  try {
    await waitFor(() => context.homeWorld.runtime("bridge-model")?.lastTermination === "completed");
    assert.deepEqual(index.consistentWatermark("bridge-model"), { epochId: "epoch-a", lastSeq: 4 });
    assert.equal(index.rawJournalRecords("bridge-model").length, 4);
    assert.equal(index.latestState("bridge-model", "bridge-model-lamp", "bridge-model-lamp:main")?.attrs.temperature, 21);
    assert.equal(index.latestStates({ bridgeId: "bridge-model" }).length, 1);
    assert.equal(context.homeWorld.worldModelWatermark("bridge-model")?.lastSeq, 4);
    assert.equal(context.homeWorld.worldModelLatestStates({ bridgeId: "bridge-model" })[0]?.attrs.temperature, 21);
    assert.equal(context.homeWorld.worldModelNumericAggregates({ bridgeId: "bridge-model" })[0]?.last, 21);

    const audit = context.homeWorld.applyWorldModelRetention({
      policyId: "model-retention-1",
      mode: "compress",
      beforeReceivedAt: "2099-01-01T00:00:00.000Z",
      requestedBy: "test",
      reason: "bounded test retention",
    });
    assert.equal(audit.compressedCount, 3);
    assert.equal(context.homeWorld.worldModelRetentionAudits()[0]?.policyId, "model-retention-1");
  } finally {
    await fiber.dispose();
    assert.deepEqual(index.consistentWatermark("bridge-model"), { epochId: "epoch-a", lastSeq: 4 });
    index.close();
  }
});

test("reopens world-model state without promoting a partial epoch and keeps its SQLite file private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-world-model-reopen-"));
  let factoryCalls = 0;
  const catalog = worldCatalog(() => {
    factoryCalls += 1;
    const bridge = new SyntheticBridge({ bridgeId: "bridge-reopen", remoteInstanceId: "remote-reopen" });
    if (factoryCalls === 1) {
      for (const event of snapshot("bridge-reopen", "epoch-a", "remote-reopen", 18)) bridge.enqueue(event);
    } else {
      bridge.enqueue(frame("epoch-b", 1, {
        kind: "sync-start",
        snapshotId: "epoch-b-snapshot",
        remoteInstanceId: "remote-reopen",
        reason: "resync",
      }));
      bridge.enqueue(frame("epoch-b", 2, {
        kind: "device-upserted",
        device: {
          nativeId: "partial-lamp",
          capabilities: [{ nativeInstanceId: "partial-lamp:main", schema: "synthetic.light", schemaVersion: "1.0.0" }],
        },
      }));
    }
    return bridge;
  });

  try {
    const firstContext = new Context();
    const firstFiber = await firstContext.plugin(HomeWorldService, {
      catalog,
      bridges: [entry("bridge-reopen")],
      journalDirectory: directory,
      maxRestarts: 0,
      monitorIntervalMs: 0,
    });
    await waitFor(() => firstContext.homeWorld.worldModelWatermark("bridge-reopen")?.epochId === "epoch-a");
    await firstFiber.dispose();

    assert.equal((await stat(join(directory, "world-model.sqlite"))).mode & 0o777, 0o600);

    const secondContext = new Context();
    const secondFiber = await secondContext.plugin(HomeWorldService, {
      catalog,
      bridges: [entry("bridge-reopen")],
      journalDirectory: directory,
      maxRestarts: 0,
      monitorIntervalMs: 0,
    });
    try {
      await waitFor(() => secondContext.homeWorld.runtime("bridge-reopen")?.lastTermination === "completed");
      assert.deepEqual(secondContext.homeWorld.worldModelWatermark("bridge-reopen"), { epochId: "epoch-a", lastSeq: 4 });
      assert.equal(secondContext.homeWorld.worldModelLatestStates({ bridgeId: "bridge-reopen" })[0]?.attrs.temperature, 18);
      assert.equal(secondContext.homeWorld.worldModelLatestStates({ bridgeId: "bridge-reopen" }).some((state) => state.nativeId === "partial-lamp"), false);
    } finally {
      await secondFiber.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("propagates journal history gaps as stale-gap freshness at the next consistent cut", async () => {
  const bridge = new SyntheticBridge({ bridgeId: "bridge-gap-model", remoteInstanceId: "remote-gap-model" });
  for (const event of snapshot("bridge-gap-model", "epoch-a", "remote-gap-model", 20)) bridge.enqueue(event);
  bridge.enqueue(frame("epoch-b", 1, {
    kind: "sync-start",
    snapshotId: "epoch-b-snapshot",
    remoteInstanceId: "remote-gap-model",
    reason: "resync",
  }));
  bridge.enqueue(frame("epoch-b", 3, { kind: "heartbeat" }));
  for (const event of snapshot("bridge-gap-model", "epoch-c", "remote-gap-model", 22)) bridge.enqueue(event);
  const catalog = worldCatalog(() => bridge);
  const registry = new BridgeRegistry({ catalog });
  const index = new WorldModelIndex({ path: ":memory:" });
  const context = new Context();
  const fiber = await context.plugin(HomeWorldService, options(catalog, registry, [entry("bridge-gap-model")], {
    worldModelIndex: index,
  }));

  try {
    await waitFor(() => context.homeWorld.worldModelWatermark("bridge-gap-model")?.epochId === "epoch-c");
    const journalGaps = context.homeWorld.journal("bridge-gap-model")?.historyGaps("bridge-gap-model") ?? [];
    assert.equal(journalGaps.length, 1);
    assert.equal(journalGaps[0]?.bridgeId, "bridge-gap-model");
    assert.equal(journalGaps[0]?.epochId, "epoch-b");
    assert.equal(index.freshness("bridge-gap-model"), "stale-gap");
    assert.equal(context.homeWorld.worldModelLatestStates({ bridgeId: "bridge-gap-model" })[0]?.freshness, "stale-gap");
    assert.equal(context.homeWorld.worldModelNumericAggregates({ bridgeId: "bridge-gap-model" })[0]?.freshness, "stale-gap");
  } finally {
    await fiber.dispose();
    index.close();
  }
});
