import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import {
  type BridgeAdapter,
  type BridgeEvent,
  type Envelope,
  type ForeignRuleControlHandle,
} from "@hob/bridge-contract";
import { z } from "zod";

import { BridgeCatalog } from "../bridge/bridge-catalog.js";
import { BridgeRegistry, MemoryBridgeRegistryStore } from "../bridge/bridge-registry.js";
import { SqliteIngestJournal } from "./ingest-journal.js";
import { HomeWorldService } from "./home-world-service.js";

const BRIDGE_ID = "bridge-control";
const EPOCH_ID = "epoch-control";

function envelope(event: BridgeEvent, seq: number): Envelope {
  return { epochId: EPOCH_ID, seq, event };
}

type SetupOptions = {
  readonly declareExtension?: boolean;
  readonly provideHandle?: boolean;
  readonly malformedHandle?: boolean;
  readonly completeSync?: boolean;
  readonly syncTimeoutMs?: number;
  readonly journalMaxBytes?: number;
};

async function setup(options: SetupOptions = {}): Promise<{
  readonly service: HomeWorldService;
  readonly fiber: { dispose(): Promise<void> };
  readonly control: ForeignRuleControlHandle;
  readonly advanceNow: (value: number) => void;
}> {
  let now = 1_000;
  const control: ForeignRuleControlHandle = {
    status: async () => ({ status: "running", sourceFingerprint: `sha256:${"a".repeat(64)}` }),
    setEnabled: async () => ({ status: "paused", sourceFingerprint: `sha256:${"a".repeat(64)}` }),
  };
  const adapter: BridgeAdapter = {
    info: {
      bridgeId: BRIDGE_ID,
      coreVersion: "6.3.0",
      ecosystem: "test",
      heartbeatIntervalMs: 60_000,
      extensions: options.declareExtension === false ? [] : [{ id: "foreignRuleControl", version: "1.0.0" }],
    },
    async *events(signal) {
      yield envelope({
        kind: "sync-start",
        snapshotId: "control-snapshot",
        remoteInstanceId: "control-remote",
        reason: "initial",
      }, 1);
      if (options.completeSync !== false) {
        yield envelope({
          kind: "sync-complete",
          manifest: { snapshotId: "control-snapshot", deviceEnvelopeCount: 0, stateEnvelopeCount: 0 },
        }, 2);
      }
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    control: {
      requestResync: async () => ({ status: "completed" }),
      pause: async () => ({ status: "completed" }),
      dispose: async () => undefined,
    },
    extension(name) {
      if (name !== "foreignRuleControl@1" || options.provideHandle === false) return undefined;
      if (options.malformedHandle) return { status: control.status } as never;
      return control as never;
    },
  };
  const catalog = new BridgeCatalog();
  catalog.register({
    adapterType: "foreign-rule-control-test",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas: [],
    factory: () => adapter,
  });
  const registry = new BridgeRegistry({ catalog, store: new MemoryBridgeRegistryStore() });
  const context = new Context();
  const fiber = await context.plugin(HomeWorldService, {
    catalog,
    registry,
    bridges: [{ bridgeId: BRIDGE_ID, adapterType: "foreign-rule-control-test", config: {} }],
    journalFactory: () => new SqliteIngestJournal(":memory:", options.journalMaxBytes === undefined
      ? {}
      : { maxBytes: options.journalMaxBytes }),
    maxRestarts: 0,
    syncTimeoutMs: options.syncTimeoutMs,
    nowMs: () => now,
    monitorIntervalMs: 0,
    scheduler: { wait: async () => undefined },
  });
  const initialState = options.completeSync === false ? "syncing" : "ready";
  await waitFor(() => context.homeWorld.snapshot().bridges[BRIDGE_ID]?.diagnostics.connectionState === initialState);
  return { service: context.homeWorld, fiber, control, advanceNow: (value) => { now = value; } };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for homeWorld");
}

test("returns only the declared live foreign-rule-control handle for a bounded ready bridge", async () => {
  const { service, fiber, control } = await setup();
  try {
    assert.equal(service.foreignRuleControlFor(BRIDGE_ID), control);
    assert.equal(service.foreignRuleControlFor(""), undefined);
    assert.equal(service.foreignRuleControlFor(" "), undefined);
    assert.equal(service.foreignRuleControlFor("x".repeat(257)), undefined);
    assert.equal(service.foreignRuleControlFor("missing-bridge"), undefined);
  } finally {
    await fiber.dispose();
  }
});

test("fails closed when the extension is not declared, handle is missing, or handle shape is incomplete", async (t) => {
  for (const [name, options] of [
    ["not declared", { declareExtension: false }],
    ["not provided", { provideHandle: false }],
    ["malformed", { malformedHandle: true }],
  ] as const) {
    await t.test(name, async () => {
      const { service, fiber } = await setup(options);
      try {
        assert.equal(service.foreignRuleControlFor(BRIDGE_ID), undefined);
      } finally {
        await fiber.dispose();
      }
    });
  }
});

test("returns no control handle once a ready bridge becomes down", async () => {
  const { service, fiber, control } = await setup();
  try {
    assert.equal(service.foreignRuleControlFor(BRIDGE_ID), control);
    service.runtime(BRIDGE_ID)?.ingest.markDown();
    assert.equal(service.snapshot().bridges[BRIDGE_ID]?.diagnostics.connectionState, "down");
    assert.equal(service.foreignRuleControlFor(BRIDGE_ID), undefined);
  } finally {
    await fiber.dispose();
  }
});

test("returns no control handle when an incomplete sync quarantines the bridge", async () => {
  const { service, fiber, advanceNow } = await setup({ completeSync: false, syncTimeoutMs: 1 });
  try {
    await waitFor(() => service.snapshot().bridges[BRIDGE_ID]?.diagnostics.connectionState === "syncing");
    advanceNow(1_002);
    service.tick();
    assert.equal(service.snapshot().bridges[BRIDGE_ID]?.diagnostics.connectionState, "quarantined");
    assert.equal(service.foreignRuleControlFor(BRIDGE_ID), undefined);
  } finally {
    await fiber.dispose();
  }
});

test("returns no control handle while journal backpressure pauses the bridge", async () => {
  const { service, fiber, control } = await setup({ journalMaxBytes: 500 });
  try {
    assert.equal(service.foreignRuleControlFor(BRIDGE_ID), control);
    const runtime = service.runtime(BRIDGE_ID);
    assert.ok(runtime);
    const result = await runtime.ingest.ingest(envelope({
      kind: "state",
      state: {
        nativeId: "overflow-device",
        nativeInstanceId: "overflow-device:main",
        attrs: { value: "x".repeat(512) },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }, 3));
    assert.equal(result.accepted, false);
    assert.equal(runtime.ingest.diagnostics().connectionState, "paused");
    assert.equal(service.foreignRuleControlFor(BRIDGE_ID), undefined);
  } finally {
    await fiber.dispose();
  }
});
