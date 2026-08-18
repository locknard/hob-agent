import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";

import {
  BridgeStreamError,
  type BridgeAdapter,
  type BridgeEvent,
  type BridgeInfo,
  type Envelope,
} from "../../../contracts/bridge-contract.js";
import { BridgeCatalog, type AdapterRegistration } from "./bridge-catalog.js";
import { BridgeRegistry, MemoryBridgeRegistryStore, type BridgeConfigEntry } from "./bridge-registry.js";
import { SqliteIngestJournal } from "./ingest-journal.js";
import { SyntheticBridge } from "./synthetic-bridge.js";
import {
  HomeWorldService,
  type HomeWorldDeviceSnapshot,
  type HomeWorldServiceOptions,
  type HomeWorldSnapshot,
} from "./home-world-service.js";

const schema = {
  schema: "synthetic.light",
  majorVersion: 1,
  attrsSchema: z.record(z.string(), z.unknown()),
  canonicalHash: "synthetic-light-v1",
} as never;

function registration(factory: AdapterRegistration<Record<string, never>>["factory"]): AdapterRegistration<Record<string, never>> {
  return {
    adapterType: "synthetic",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas: [schema],
    factory,
  };
}

function entry(bridgeId: string): BridgeConfigEntry<Record<string, never>> {
  return { bridgeId, adapterType: "synthetic", config: {} };
}

function eventEnvelope(epochId: string, seq: number, event: BridgeEvent): Envelope {
  return { epochId, seq, event };
}

function syncStart(epochId: string, remoteInstanceId: string): Envelope {
  return eventEnvelope(epochId, 1, {
    kind: "sync-start",
    snapshotId: `${epochId}-snapshot`,
    remoteInstanceId,
    reason: "initial",
  });
}

function snapshotFor(bridgeId: string, remoteInstanceId: string): Envelope[] {
  return [
    syncStart(`${bridgeId}-epoch`, remoteInstanceId),
    eventEnvelope(`${bridgeId}-epoch`, 2, {
      kind: "device-upserted",
      device: {
        nativeId: `${bridgeId}-lamp`,
        name: `${bridgeId} lamp`,
        capabilities: [{
          nativeInstanceId: `${bridgeId}-lamp:main`,
          schema: "synthetic.light",
          schemaVersion: "1.0.0",
          semanticKind: "light",
        }],
      },
    }),
    eventEnvelope(`${bridgeId}-epoch`, 3, {
      kind: "state",
      state: {
        nativeId: `${bridgeId}-lamp`,
        nativeInstanceId: `${bridgeId}-lamp:main`,
        attrs: { state: "on" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }),
    eventEnvelope(`${bridgeId}-epoch`, 4, {
      kind: "sync-complete",
      manifest: { snapshotId: `${bridgeId}-epoch-snapshot`, deviceEnvelopeCount: 1, stateEnvelopeCount: 1 },
    }),
  ];
}

function syntheticBridge(bridgeId: string, remoteInstanceId: string, events: readonly Envelope[]): SyntheticBridge {
  const bridge = new SyntheticBridge({ bridgeId, remoteInstanceId });
  for (const event of events) bridge.enqueue(event);
  return bridge;
}

function testRuntimeOptions(
  catalog: BridgeCatalog,
  registry: BridgeRegistry,
  bridges: readonly BridgeConfigEntry<Record<string, never>>[],
  adapters: Map<string, SyntheticBridge>,
  overrides: Partial<HomeWorldServiceOptions> = {},
): HomeWorldServiceOptions {
  return {
    catalog,
    registry,
    bridges,
    journalFactory: () => new SqliteIngestJournal(":memory:"),
    maxRestarts: 0,
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

test("mounts as homeWorld, consumes every configured bridge once, and aggregates a neutral snapshot", async () => {
  const catalog = new BridgeCatalog();
  const adapters = new Map<string, SyntheticBridge>([
    ["bridge-a", syntheticBridge("bridge-a", "remote-a", snapshotFor("bridge-a", "remote-a"))],
    ["bridge-b", syntheticBridge("bridge-b", "remote-b", snapshotFor("bridge-b", "remote-b"))],
  ]);
  catalog.register(registration((ctx) => adapters.get(ctx.bridgeId)!));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const options = testRuntimeOptions(catalog, registry, [entry("bridge-a"), entry("bridge-b")], adapters);

  const fiber = await ctx.plugin(HomeWorldService, options);
  const service = ctx.homeWorld;
  await waitFor(() => service.snapshot().bridges["bridge-a"]?.diagnostics.connectionState === "ready"
    && service.snapshot().bridges["bridge-b"]?.diagnostics.connectionState === "ready");

  const snapshot = service.snapshot();
  assert.equal(service.name, "homeWorld");
  assert.deepEqual(Object.keys(snapshot.watermarkVector).sort(), ["bridge-a", "bridge-b"]);
  assert.equal(snapshot.watermarkVector["bridge-a"]?.lastSeq, 4);
  assert.equal(snapshot.bridges["bridge-a"]?.metrics.consistency, "ready");
  assert.equal(snapshot.bridges["bridge-a"]?.metrics.eventActivity, "active");
  assert.equal(snapshot.bridges["bridge-a"]?.metrics.connection, "up");
  assert.deepEqual(snapshot.devices.map((device) => device.nativeId).sort(), ["bridge-a-lamp", "bridge-b-lamp"]);
  assert.equal(snapshot.devices[0]?.bridgeId, "bridge-a");

  await fiber.dispose();
});

test("returns only selected post-baseline live changes as bounded neutral evidence", async () => {
  const catalog = new BridgeCatalog();
  const bridge = syntheticBridge("bridge-evidence", "remote-evidence", snapshotFor("bridge-evidence", "remote-evidence"));
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  let currentTime = "2026-08-19T00:00:00.000Z";
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    [entry("bridge-evidence")],
    new Map([["bridge-evidence", bridge]]),
    { clock: () => currentTime },
  ));
  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-evidence"]?.diagnostics.connectionState === "ready");
  const capability = ctx.homeWorld.snapshot().devices[0]!.capabilities[0]!;
  ctx.homeWorld.journal("bridge-evidence")!.appendAtomic({
    bridgeId: "bridge-evidence",
    receivedAt: "2026-08-19T03:00:00.000Z",
    envelope: eventEnvelope("bridge-evidence-epoch", 5, {
      kind: "state",
      state: {
        nativeId: "bridge-evidence-lamp",
        nativeInstanceId: "bridge-evidence-lamp:main",
        attrs: { state: "off", unbounded: { ignored: true } },
        time: { sourceTs: "2026-08-19T02:59:59.000Z", sourceTsQuality: "platform" },
        origin: "observed",
      },
    }),
  });
  currentTime = "2026-08-19T04:00:00.000Z";

  const evidence = ctx.homeWorld.queryRecentEvidence({
    hwCapabilityIds: [capability.hwCapabilityId],
    lookbackHours: 2,
    limit: 20,
  });

  assert.equal(evidence.events.length, 1);
  assert.deepEqual(evidence.events[0], {
    hwId: capability.hwId,
    hwCapabilityId: capability.hwCapabilityId,
    semanticKind: "light",
    value: "off",
    observedAt: "2026-08-19T03:00:00.000Z",
    sourceTs: "2026-08-19T02:59:59.000Z",
    sourceTsQuality: "platform",
    origin: "observed",
    provenance: { bridgeId: "bridge-evidence", epochId: "bridge-evidence-epoch", seq: 5 },
  });
  assert.deepEqual(evidence.coverage, [{
    bridgeId: "bridge-evidence",
    epochId: "bridge-evidence-epoch",
    baselineSeq: 4,
    baselineAt: "2026-08-19T00:00:00.000Z",
    status: "complete",
    reasons: [],
  }]);
  assert.equal(evidence.truncated, false);

  ctx.homeWorld.journal("bridge-evidence")!.appendAtomic({
    bridgeId: "bridge-evidence",
    receivedAt: "2026-08-19T03:30:00.000Z",
    envelope: eventEnvelope("bridge-evidence-epoch", 6, {
      kind: "state",
      state: {
        nativeId: "bridge-evidence-lamp",
        nativeInstanceId: "bridge-evidence-lamp:main",
        attrs: { state: "on" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }),
  });
  const bounded = ctx.homeWorld.queryRecentEvidence({
    hwCapabilityIds: [capability.hwCapabilityId],
    lookbackHours: 2,
    limit: 1,
  });
  assert.deepEqual(bounded.events.map((item) => item.provenance.seq), [6]);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.coverage[0]?.status, "partial");
  assert.deepEqual(bounded.coverage[0]?.reasons, ["query_truncated"]);
  await fiber.dispose();
});

test("rejects unknown capability ids and unbounded evidence requests", async () => {
  const catalog = new BridgeCatalog();
  const bridge = syntheticBridge("bridge-evidence-bounds", "remote-evidence-bounds", snapshotFor("bridge-evidence-bounds", "remote-evidence-bounds"));
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    [entry("bridge-evidence-bounds")],
    new Map([["bridge-evidence-bounds", bridge]]),
  ));
  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-evidence-bounds"]?.diagnostics.connectionState === "ready");

  assert.throws(() => ctx.homeWorld.queryRecentEvidence({
    hwCapabilityIds: ["unknown-capability"],
    lookbackHours: 24,
    limit: 20,
  }));
  assert.throws(() => ctx.homeWorld.queryRecentEvidence({
    hwCapabilityIds: ctx.homeWorld.snapshot().devices[0]!.capabilities.map((item) => item.hwCapabilityId),
    lookbackHours: 24 * 30,
    limit: 20,
  }));
  await fiber.dispose();
});

test("disposes an adapter when bridge startup fails before runtime registration", async () => {
  const catalog = new BridgeCatalog();
  let disposeCalls = 0;
  const adapter: BridgeAdapter = {
    info: {
      bridgeId: "bridge-startup-failure",
      coreVersion: "6.3.0",
      ecosystem: "synthetic",
      heartbeatIntervalMs: 60_000,
      extensions: [],
    },
    events: async function* () {
      return;
    },
    control: {
      requestResync: async () => ({ status: "unsupported", reason: "unsupported" }),
      dispose: async () => {
        disposeCalls += 1;
      },
    },
    extension: () => undefined,
  };
  catalog.register(registration(() => adapter));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();

  await assert.rejects(
    Promise.resolve(ctx.plugin(HomeWorldService, {
      catalog,
      registry,
      bridges: [entry("bridge-startup-failure")],
      journalFactory: () => {
        throw new Error("journal-create");
      },
      maxRestarts: 0,
      monitorIntervalMs: 0,
    })),
    /journal-create/,
  );
  assert.equal(disposeCalls, 1);
});

test("fails closed for a declared extension without a usable handle", async () => {
  const catalog = new BridgeCatalog();
  const bridge = new SyntheticBridge({
    bridgeId: "bridge-ext",
    remoteInstanceId: "remote-ext",
    extensions: [{ id: "actions", version: "1.2.0" }],
  });
  bridge.enqueue(syncStart("epoch-ext", "remote-ext"));
  bridge.enqueue(eventEnvelope("epoch-ext", 2, { kind: "ext", ext: "actions@1", payload: { secret: "must-not-run" } }));
  bridge.enqueue(eventEnvelope("epoch-ext", 3, { kind: "sync-complete", manifest: { snapshotId: "epoch-ext-snapshot", deviceEnvelopeCount: 0, stateEnvelopeCount: 0 } }));
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(catalog, registry, [entry("bridge-ext")], new Map([["bridge-ext", bridge]])));

  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-ext"]?.diagnostics.connectionState === "ready");
  const bridgeSnapshot = ctx.homeWorld.snapshot().bridges["bridge-ext"]!;
  assert.equal(bridgeSnapshot.extensions["actions@1"], "unavailable");
  assert.equal(ctx.homeWorld.journal("bridge-ext")?.rejections()[0]?.reason, "unsupported");
  assert.equal(ctx.homeWorld.journal("bridge-ext")?.contains("must-not-run"), false);

  await fiber.dispose();
});

test("includes reduced device and bridge health in the neutral snapshot", async () => {
  const catalog = new BridgeCatalog();
  const bridge = new SyntheticBridge({ bridgeId: "bridge-health", remoteInstanceId: "remote-health" });
  bridge.enqueue(syncStart("epoch-health", "remote-health"));
  bridge.enqueue(eventEnvelope("epoch-health", 2, {
    kind: "device-upserted",
    device: {
      nativeId: "health-lamp",
      capabilities: [{ nativeInstanceId: "health-lamp:main", schema: "synthetic.light", schemaVersion: "1.0.0" }],
    },
  }));
  bridge.enqueue(eventEnvelope("epoch-health", 3, {
    kind: "state",
    state: {
      nativeId: "health-lamp",
      nativeInstanceId: "health-lamp:main",
      attrs: { state: "on" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  }));
  bridge.enqueue(eventEnvelope("epoch-health", 4, { kind: "device-health", nativeId: "health-lamp", status: "unreachable" }));
  bridge.enqueue(eventEnvelope("epoch-health", 5, { kind: "bridge-health", status: "degraded" }));
  bridge.enqueue(eventEnvelope("epoch-health", 6, {
    kind: "sync-complete",
    manifest: { snapshotId: "epoch-health-snapshot", deviceEnvelopeCount: 1, stateEnvelopeCount: 1 },
  }));
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    [entry("bridge-health")],
    new Map([["bridge-health", bridge]]),
  ));

  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-health"]?.diagnostics.connectionState === "degraded");
  const snapshot = ctx.homeWorld.snapshot();
  assert.equal(snapshot.bridges["bridge-health"]?.diagnostics.connectionState, "degraded");
  assert.equal((snapshot.devices[0] as HomeWorldDeviceSnapshot & { health?: string })?.health, "unreachable");

  await fiber.dispose();
});

test("passes catalog attrs schemas and resource/folding controls into bridge ingest", async () => {
  const catalog = new BridgeCatalog();
  const strictSchema = {
    schema: "synthetic.strict",
    majorVersion: 1,
    attrsSchema: z.object({ state: z.string() }).strict(),
    canonicalHash: "synthetic-strict-v1",
  } as never;
  const bridge = new SyntheticBridge({ bridgeId: "bridge-controls", remoteInstanceId: "remote-controls" });
  bridge.enqueue(syncStart("epoch-controls", "remote-controls"));
  bridge.enqueue(eventEnvelope("epoch-controls", 2, {
    kind: "device-upserted",
    device: {
      nativeId: "controls-lamp",
      capabilities: [{ nativeInstanceId: "controls-lamp:main", schema: "synthetic.strict", schemaVersion: "1.0.0" }],
    },
  }));
  bridge.enqueue(eventEnvelope("epoch-controls", 3, {
    kind: "state",
    state: {
      nativeId: "controls-lamp",
      nativeInstanceId: "controls-lamp:main",
      attrs: { state: "on", secret: "reject" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  }));
  bridge.enqueue(eventEnvelope("epoch-controls", 4, {
    kind: "state",
    state: {
      nativeId: "controls-lamp",
      nativeInstanceId: "controls-lamp:main",
      attrs: { state: "x".repeat(64) },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  }));
  bridge.enqueue(eventEnvelope("epoch-controls", 5, {
    kind: "sync-complete",
    manifest: { snapshotId: "epoch-controls-snapshot", deviceEnvelopeCount: 1, stateEnvelopeCount: 2 },
  }));
  catalog.register({
    adapterType: "synthetic-controls",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas: [strictSchema],
    factory: () => bridge,
  });
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, {
    catalog,
    registry,
    bridges: [{ bridgeId: "bridge-controls", adapterType: "synthetic-controls", config: {} }],
    journalFactory: () => new SqliteIngestJournal(":memory:"),
    maxRestarts: 0,
    monitorIntervalMs: 0,
    scheduler: { wait: async () => undefined },
    resourceBudget: { maxStringLength: 32 },
    stateFoldWindowMs: 100,
  });

  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-controls"]?.diagnostics.connectionState === "ready");
  const snapshot = ctx.homeWorld.snapshot();
  assert.deepEqual(ctx.homeWorld.journal("bridge-controls")?.rejections().map((rejection) => rejection.reason), [
    "invalid_payload",
    "resource_exhausted",
  ]);
  assert.deepEqual(snapshot.devices.find((device) => device.nativeId === "controls-lamp")?.states, []);

  const runtime = ctx.homeWorld.runtime("bridge-controls")!;
  const incremental = await runtime.ingest.ingest(eventEnvelope("epoch-controls", 6, {
    kind: "state",
    state: {
      nativeId: "controls-lamp",
      nativeInstanceId: "controls-lamp:main",
      attrs: { state: "off" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  }));
  assert.equal(incremental.accepted, true);
  assert.deepEqual(runtime.ingest.worldSnapshot().get("controls-lamp")?.states, new Map());
  runtime.ingest.flushStateFolding();
  assert.equal(runtime.ingest.worldSnapshot().get("controls-lamp")?.states.get("controls-lamp:main")?.attrs.state, "off");

  await fiber.dispose();
});

test("rejects a mismatched remote identity before creating an epoch or journal row", async () => {
  const catalog = new BridgeCatalog();
  let factoryCalls = 0;
  const bridge = syntheticBridge("bridge-identity", "remote-wrong", [
    syncStart("epoch-identity", "remote-wrong"),
  ]);
  catalog.register(registration(() => {
    factoryCalls += 1;
    return bridge;
  }));
  const registry = new BridgeRegistry({
    catalog,
    store: new MemoryBridgeRegistryStore([{
      bridgeId: "bridge-identity",
      adapterType: "synthetic",
      createdAt: "2026-08-18T00:00:00.000Z",
      generation: 1,
      remoteInstanceId: "remote-bound",
    }]),
  });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(catalog, registry, [entry("bridge-identity")], new Map([[
    "bridge-identity",
    bridge,
  ]]), { maxRestarts: 3 }));

  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-identity"]?.diagnostics.connectionState === "quarantined");
  assert.deepEqual(ctx.homeWorld.journal("bridge-identity")?.records(), []);
  assert.equal(registry.binding("bridge-identity")?.remoteInstanceId, "remote-bound");
  assert.equal(ctx.homeWorld.snapshot().bridges["bridge-identity"]?.diagnostics.connectionState, "quarantined");
  assert.equal(factoryCalls, 1);

  await fiber.dispose();
});

test("restarts a failed stream by aborting, disposing, scheduling backoff, and constructing a fresh adapter", async () => {
  const catalog = new BridgeCatalog();
  const lifecycle: string[] = [];
  let factoryCalls = 0;
  const recovered = syntheticBridge("bridge-restart", "remote-restart", snapshotFor("bridge-restart", "remote-restart"));
  const failed: BridgeAdapter = {
    info: { bridgeId: "bridge-restart", coreVersion: "6.3.0", ecosystem: "synthetic", heartbeatIntervalMs: 10, extensions: [] },
    events: async function* (signal) {
      lifecycle.push(`events:${signal.aborted ? "aborted" : "started"}`);
      throw new BridgeStreamError("upstream unavailable", "upstream_unavailable");
    },
    control: {
      requestResync: async () => ({ status: "completed" }),
      dispose: async () => { lifecycle.push("dispose"); },
    },
    extension: () => undefined,
  };
  catalog.register(registration(() => {
    factoryCalls += 1;
    return factoryCalls === 1 ? failed : recovered;
  }));
  const registry = new BridgeRegistry({ catalog });
  const waits: number[] = [];
  const ctx = new Context();
  const options = testRuntimeOptions(catalog, registry, [entry("bridge-restart")], new Map(), {
    maxRestarts: 1,
    restartBackoffMs: 37,
    scheduler: { wait: async (delayMs) => { waits.push(delayMs); } },
  });
  const fiber = await ctx.plugin(HomeWorldService, options);

  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-restart"]?.diagnostics.connectionState === "ready");
  assert.equal(factoryCalls, 2);
  assert.deepEqual(waits, [37]);
  assert.deepEqual(lifecycle, ["events:started", "dispose"]);
  assert.equal(ctx.homeWorld.runtime("bridge-restart")?.restartCount, 1);

  await fiber.dispose();
});

test("treats a clean stream end as a lifecycle boundary and consumes a fresh epoch", async () => {
  const catalog = new BridgeCatalog();
  let factoryCalls = 0;
  const first = syntheticBridge("bridge-complete", "remote-complete", snapshotFor("first", "remote-complete"));
  const second = syntheticBridge("bridge-complete", "remote-complete", snapshotFor("second", "remote-complete"));
  catalog.register(registration(() => {
    factoryCalls += 1;
    return factoryCalls === 1 ? first : second;
  }));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(catalog, registry, [entry("bridge-complete")], new Map(), {
    maxRestarts: 1,
    restartBackoffMs: 0,
    scheduler: { wait: async () => undefined },
  }));

  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-complete"]?.watermark?.epochId === "second-epoch");
  assert.equal(factoryCalls, 2);
  assert.equal(ctx.homeWorld.runtime("bridge-complete")?.restartCount, 1);
  assert.equal(ctx.homeWorld.snapshot().bridges["bridge-complete"]?.diagnostics.connectionState, "ready");

  await fiber.dispose();
});

test("tick drives heartbeat and sync timeout states without waiting on wall-clock timers", async () => {
  const catalog = new BridgeCatalog();
  let now = 1_000;
  const bridge = syntheticBridge("bridge-timeout", "remote-timeout", [syncStart("epoch-timeout", "remote-timeout")]);
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(catalog, registry, [entry("bridge-timeout")], new Map([["bridge-timeout", bridge]]), {
    nowMs: () => now,
    heartbeatIntervalMs: 10,
    syncTimeoutMs: 1_000,
    maxRestarts: 0,
  }));
  await waitFor(() => ctx.homeWorld.runtime("bridge-timeout")?.ingest.diagnostics().connectionState === "syncing");

  now = 1_021;
  ctx.homeWorld.tick();
  assert.equal(ctx.homeWorld.snapshot().bridges["bridge-timeout"]?.diagnostics.connectionState, "down");
  now = 2_100;
  ctx.homeWorld.tick();
  assert.equal(ctx.homeWorld.snapshot().bridges["bridge-timeout"]?.diagnostics.connectionState, "quarantined");

  await fiber.dispose();
});

test("keeps a stable serializable snapshot shape for agent consumers", async () => {
  const catalog = new BridgeCatalog();
  const bridge = syntheticBridge("bridge-shape", "remote-shape", snapshotFor("bridge-shape", "remote-shape"));
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(catalog, registry, [entry("bridge-shape")], new Map([["bridge-shape", bridge]])));
  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-shape"]?.diagnostics.connectionState === "ready");

  const json = JSON.stringify(ctx.homeWorld.snapshot());
  const parsed = JSON.parse(json) as HomeWorldSnapshot;
  assert.equal(parsed.devices[0]?.states[0]?.attrs.state, "on");
  assert.equal(parsed.devices[0]?.capabilities[0]?.semanticKind, "light");
  assert.equal(parsed.bridges["bridge-shape"]?.watermark.lastSeq, 4);
  assert.deepEqual(parsed.bridgeWatermarks, [{
    bridgeId: "bridge-shape",
    epochId: "bridge-shape-epoch",
    lastSeq: 4,
    lastSyncCompleteAt: parsed.diagnostics[0]?.lastSyncCompleteAt,
  }]);
  assert.equal(parsed.metrics.consistency[0]?.state, "ready");

  await fiber.dispose();
});

test("restarts from the durable journal fence without exposing an incomplete replacement epoch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-world-restart-"));
  const catalog = new BridgeCatalog();
  let factoryCalls = 0;
  const initial = syntheticBridge("bridge-recover", "remote-recover", snapshotFor("bridge-recover", "remote-recover"));
  catalog.register(registration(() => {
    factoryCalls += 1;
    if (factoryCalls === 1) return initial;
    if (factoryCalls === 3) {
      const stale = new SyntheticBridge({ bridgeId: "bridge-recover", remoteInstanceId: "remote-recover" });
      stale.enqueue(eventEnvelope("replacement-epoch", 3, {
        kind: "device-upserted",
        device: {
          nativeId: "stale-after-restart",
          capabilities: [{ nativeInstanceId: "stale-after-restart:main", schema: "synthetic.light", schemaVersion: "1.0.0" }],
        },
      }));
      return stale;
    }
    const failed = new SyntheticBridge({ bridgeId: "bridge-recover", remoteInstanceId: "remote-recover" });
    failed.enqueue(syncStart("bridge-recover-epoch", "remote-recover"));
    failed.enqueue(syncStart("replacement-epoch", "remote-recover"));
    failed.enqueue(eventEnvelope("replacement-epoch", 2, {
      kind: "device-upserted",
      device: {
        nativeId: "replacement-lamp",
        capabilities: [{ nativeInstanceId: "replacement-lamp:main", schema: "synthetic.light", schemaVersion: "1.0.0" }],
      },
    }));
    failed.enqueue(eventEnvelope("replacement-epoch", 4, { kind: "heartbeat" }));
    return failed;
  }));

  const firstContext = new Context();
  const firstFiber = await firstContext.plugin(HomeWorldService, {
    catalog,
    bridges: [entry("bridge-recover")],
    journalDirectory: directory,
    maxRestarts: 0,
    monitorIntervalMs: 0,
  });
  await waitFor(() => firstContext.homeWorld.snapshot().bridges["bridge-recover"]?.diagnostics.connectionState === "ready");
  await firstFiber.dispose();

  const secondContext = new Context();
  const secondFiber = await secondContext.plugin(HomeWorldService, {
    catalog,
    bridges: [entry("bridge-recover")],
    journalDirectory: directory,
    maxRestarts: 0,
    monitorIntervalMs: 0,
  });
  await waitFor(() => secondContext.homeWorld.runtime("bridge-recover")?.lastTermination === "completed");
  const snapshot = secondContext.homeWorld.snapshot();
  assert.deepEqual(snapshot.devices.map((device) => device.nativeId), ["bridge-recover-lamp"]);
  assert.equal(snapshot.bridges["bridge-recover"]?.watermark?.epochId, "bridge-recover-epoch");
  assert.equal(snapshot.bridges["bridge-recover"]?.diagnostics.connectionState, "degraded");
  assert.equal(secondContext.homeWorld.journal("bridge-recover")?.records().some((record) => (
    record.envelope.event.kind === "sync-start"
      && record.envelope.epochId === "replacement-epoch"
      && record.envelope.seq === 1
  )), true);

  await secondFiber.dispose();

  const thirdContext = new Context();
  const thirdFiber = await thirdContext.plugin(HomeWorldService, {
    catalog,
    bridges: [entry("bridge-recover")],
    journalDirectory: directory,
    maxRestarts: 0,
    monitorIntervalMs: 0,
  });
  await waitFor(() => thirdContext.homeWorld.runtime("bridge-recover")?.lastTermination === "completed");
  assert.deepEqual(thirdContext.homeWorld.snapshot().devices.map((device) => device.nativeId), ["bridge-recover-lamp"]);
  await thirdFiber.dispose();
  await rm(directory, { recursive: true, force: true });
});
