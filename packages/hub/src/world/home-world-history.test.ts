import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";

import {
  HISTORY_EXTENSION,
  type BridgeAdapter,
  type BridgeEvent,
  type Envelope,
  type HistoryHandle,
  type HistoryPage,
} from "@hob/bridge-contract";

import { BridgeCatalog, type AdapterRegistration } from "../bridge/bridge-catalog.js";
import { BridgeRegistry, type BridgeConfigEntry } from "../bridge/bridge-registry.js";
import { ImportedHistoryJournal } from "./imported-history-journal.js";
import { SqliteIngestJournal } from "./ingest-journal.js";
import {
  HomeWorldService,
  type HomeWorldServiceOptions,
} from "./home-world-service.js";
import { WorldIdentityManager } from "./world-identity.js";

const BRIDGE_ID = "bridge-history";
const REMOTE_ID = "remote-history";
const EPOCH_ID = "history-epoch";
const CAPABILITY_ID = "hwc-light";
const SECOND_BRIDGE_ID = "bridge-history-second";
const SECOND_REMOTE_ID = "remote-history-second";
const SECOND_CAPABILITY_ID = "hwc-second-light";

const capabilitySchema = {
  schema: "synthetic.light",
  majorVersion: 1,
  attrsSchema: z.record(z.string(), z.unknown()),
  canonicalHash: "synthetic-light-v1",
} as never;

function envelope(epochId: string, seq: number, event: BridgeEvent): Envelope {
  return { epochId, seq, event };
}

function liveStream(control: Pick<HistoryAdapterControl, "remoteId" | "nativeId" | "nativeInstanceId"> = {}): readonly Envelope[] {
  const remoteId = control.remoteId ?? REMOTE_ID;
  const nativeId = control.nativeId ?? "native-light";
  const nativeInstanceId = control.nativeInstanceId ?? "native-light:main";
  return [
    envelope(EPOCH_ID, 1, {
      kind: "sync-start",
      snapshotId: "history-snapshot",
      remoteInstanceId: remoteId,
      reason: "initial",
    }),
    envelope(EPOCH_ID, 2, {
      kind: "device-upserted",
      device: {
        nativeId,
        name: "Living light",
        capabilities: [{
          nativeInstanceId,
          schema: "synthetic.light",
          schemaVersion: "1.0.0",
          semanticKind: "light",
        }],
      },
    }),
    envelope(EPOCH_ID, 3, {
      kind: "state",
      state: {
        nativeId,
        nativeInstanceId,
        attrs: { state: "off" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }),
    envelope(EPOCH_ID, 4, {
      kind: "sync-complete",
      manifest: { snapshotId: "history-snapshot", deviceEnvelopeCount: 1, stateEnvelopeCount: 1 },
    }),
  ];
}

interface HistoryAdapterControl {
  readonly onFetch: (request: Parameters<HistoryHandle["fetchHistory"]>[0]) => Promise<HistoryPage>;
  readonly calls: Array<Parameters<HistoryHandle["fetchHistory"]>[0]>;
  readonly historyAvailable?: boolean;
  readonly liveEvents?: readonly Envelope[];
  readonly bridgeId?: string;
  readonly remoteId?: string;
  readonly nativeId?: string;
  readonly nativeInstanceId?: string;
  readonly capabilityId?: string;
}

function historyAdapter(control: HistoryAdapterControl): BridgeAdapter {
  const bridgeId = control.bridgeId ?? BRIDGE_ID;
  const remoteId = control.remoteId ?? REMOTE_ID;
  let subscribed = false;
  let open = true;
  const handle: HistoryHandle = {
    fetchHistory: async (request) => {
      control.calls.push(request);
      return control.onFetch(request);
    },
  };
  return {
    info: {
      bridgeId,
      coreVersion: "6.3.0",
      ecosystem: "synthetic",
      heartbeatIntervalMs: 60_000,
      extensions: [HISTORY_EXTENSION],
    },
    async *events(signal) {
      if (subscribed) throw new Error("history test adapter supports one subscription");
      subscribed = true;
      for (const item of control.liveEvents ?? liveStream(control)) {
        if (signal.aborted || !open) return;
        yield item;
      }
    },
    control: {
      requestResync: async () => ({ status: "completed" }),
      dispose: async () => { open = false; },
    },
    extension(name) {
      return name === "history@1" && control.historyAvailable !== false ? handle : undefined;
    },
  };
}

function entry(bridgeId = BRIDGE_ID): BridgeConfigEntry<Record<string, never>> {
  return { bridgeId, adapterType: "synthetic-history", config: {} };
}

function registration(factory: AdapterRegistration<Record<string, never>>["factory"]): AdapterRegistration<Record<string, never>> {
  return {
    adapterType: "synthetic-history",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas: [capabilitySchema],
    factory,
  };
}

function identityManager(): WorldIdentityManager {
  return new WorldIdentityManager({
    idFactory: (kind) => ({
      hw: "hw-device",
      hwCapability: CAPABILITY_ID,
      hwSpace: "hws-living",
      proposal: "proposal-history",
      audit: "audit-history",
    })[kind],
  });
}

function multiIdentityManager(): WorldIdentityManager {
  const values = {
    hw: ["hw-device", "hw-device-second"],
    hwCapability: [CAPABILITY_ID, SECOND_CAPABILITY_ID],
    hwSpace: ["hws-living", "hws-second"],
    proposal: ["proposal-history", "proposal-history-second"],
    audit: ["audit-history", "audit-history-second"],
  } as const;
  const offsets = new Map<keyof typeof values, number>();
  return new WorldIdentityManager({
    idFactory: (kind) => {
      const offset = offsets.get(kind) ?? 0;
      offsets.set(kind, offset + 1);
      return values[kind][offset] ?? `${kind}-history-${offset + 1}`;
    },
  });
}

async function waitForReady(service: HomeWorldService, bridgeId = BRIDGE_ID): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.snapshot().bridges[bridgeId]?.diagnostics.connectionState === "ready") return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for history bridge");
}

async function createService(
  control: HistoryAdapterControl,
  lifecycleOptions: {
    readonly waitForReady?: boolean;
    readonly useDefaultStores?: boolean;
    readonly journalPath?: HomeWorldServiceOptions["journalPath"];
  } = {},
  additionalBridges: readonly { readonly bridgeId: string; readonly control: HistoryAdapterControl }[] = [],
): Promise<{
  readonly service: HomeWorldService;
  readonly fiber: { dispose(): Promise<void> };
}> {
  const catalog = new BridgeCatalog();
  const fixtures = [
    { bridgeId: control.bridgeId ?? BRIDGE_ID, control },
    ...additionalBridges,
  ];
  const adapters = new Map(fixtures.map(({ bridgeId, control: fixtureControl }) => [bridgeId, historyAdapter(fixtureControl)]));
  catalog.register(registration(({ bridgeId }) => {
    const adapter = adapters.get(bridgeId);
    if (adapter === undefined) throw new Error(`missing fixture for ${bridgeId}`);
    return adapter;
  }));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const options: HomeWorldServiceOptions = {
    catalog,
    registry,
    bridges: fixtures.map(({ bridgeId }) => entry(bridgeId)),
    ...(lifecycleOptions.useDefaultStores ? {} : {
      journalFactory: () => new SqliteIngestJournal(":memory:"),
      importedHistoryJournalFactory: () => new ImportedHistoryJournal(":memory:", {
        clock: () => "2026-08-25T00:00:00.000Z",
      }),
    }),
    journalPath: lifecycleOptions.journalPath,
    maxRestarts: 0,
    scheduler: { wait: async () => undefined },
    identityManager: fixtures.length === 1 ? identityManager() : multiIdentityManager(),
    clock: () => "2026-08-25T00:00:00.000Z",
  };
  const fiber = await ctx.plugin(HomeWorldService, options);
  if (lifecycleOptions.waitForReady !== false) {
    for (const fixture of fixtures) await waitForReady(ctx.homeWorld, fixture.bridgeId);
  }
  return { service: ctx.homeWorld, fiber };
}

function page(
  request: Parameters<HistoryHandle["fetchHistory"]>[0],
  overrides: Partial<Pick<HistoryPage, "sourceRange" | "liveCut" | "records" | "coverage" | "reasons">> = {},
  control: Pick<HistoryAdapterControl, "nativeId" | "nativeInstanceId"> = {},
): HistoryPage {
  const nativeId = control.nativeId ?? "native-light";
  const nativeInstanceId = control.nativeInstanceId ?? "native-light:main";
  return {
    importId: "import-history-1",
    source: "home-assistant-recorder",
    sourceRange: { since: request.since, until: request.until },
    liveCut: request.liveCut,
    coverage: "partial",
    reasons: ["retention_floor_unknown"],
    records: [{
      historySeq: 1,
      state: {
        nativeId,
        nativeInstanceId,
        attrs: { state: "on", provider_payload: "must-not-cross" },
        time: { sourceTs: "2026-08-24T23:00:00.000Z", sourceTsQuality: "platform" },
        origin: "imported",
      },
    }],
    ...overrides,
  };
}

async function waitForCapability(service: HomeWorldService, capabilityId = CAPABILITY_ID): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.snapshot().devices.some((device) => device.capabilities.some((capability) => (
      capability.hwCapabilityId === capabilityId
    )))) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for history capability");
}

test("explicit imported query captures a verified cut and returns only household-safe scalar history", async () => {
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => page(request),
  };
  const { service, fiber } = await createService(control);
  try {
    const before = service.snapshot();
    const beforeWorldModelWatermark = service.worldModelWatermark(BRIDGE_ID);
    const beforeWorldModelStates = service.worldModelLatestStates({ bridgeId: BRIDGE_ID });
    const result = await service.queryImportedHistory({
      hwCapabilityIds: [CAPABILITY_ID],
      lookbackHours: 24,
      limit: 20,
    });

    assert.equal(control.calls.length, 1);
    assert.deepEqual(control.calls[0]?.bindings, [{
      nativeId: "native-light",
      nativeInstanceId: "native-light:main",
    }]);
    assert.deepEqual(control.calls[0]?.liveCut, { epochId: EPOCH_ID, lastSeq: 4 });
    assert.equal(result.events.length, 1);
    assert.deepEqual(result.events[0], {
      hwId: "hw-device",
      hwCapabilityId: CAPABILITY_ID,
      semanticKind: "light",
      value: "on",
      observedAt: "2026-08-24T23:00:00.000Z",
      sourceTs: "2026-08-24T23:00:00.000Z",
      sourceTsQuality: "platform",
      origin: "imported",
    });
    assert.deepEqual(result.coverage, {
      status: "partial",
      reasons: ["retention_floor_unknown"],
    });
    const encoded = JSON.stringify(result);
    assert.equal(encoded.includes("provider_payload"), false);
    assert.equal(encoded.includes("nativeId"), false);
    assert.equal(encoded.includes("bridge-history"), false);
    assert.equal(encoded.includes("import-history-1"), false);
    assert.equal(encoded.includes("historySeq"), false);
    assert.equal(encoded.includes("liveCut"), false);
    assert.deepEqual(service.snapshot().devices, before.devices);
    assert.deepEqual(service.worldModelWatermark(BRIDGE_ID), beforeWorldModelWatermark);
    assert.deepEqual(service.worldModelLatestStates({ bridgeId: BRIDGE_ID }), beforeWorldModelStates);
    assert.deepEqual(service.runtime(BRIDGE_ID)?.journal.consistentWatermark?.(BRIDGE_ID), {
      epochId: EPOCH_ID,
      lastSeq: 4,
    });
  } finally {
    await fiber.dispose();
  }
});

test("does not fetch imported history during bridge startup or readiness", async () => {
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => page(request),
  };
  const { fiber } = await createService(control);
  try {
    assert.equal(control.calls.length, 0);
  } finally {
    await fiber.dispose();
  }
});

test("opens the default live and imported stores from one resolved journal path", async () => {
  const paths: string[] = [];
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => page(request),
  };
  const { service, fiber } = await createService(control, {
    useDefaultStores: true,
    journalPath: () => {
      paths.push(BRIDGE_ID);
      return ":memory:";
    },
  });
  try {
    assert.deepEqual(paths, [BRIDGE_ID]);
    assert.ok(service.runtime(BRIDGE_ID)?.importedHistoryJournal);
  } finally {
    await fiber.dispose();
  }
});

test("accepts same-epoch live sequence advancement without importing history into live state", async () => {
  let service: HomeWorldService | undefined;
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => {
      const runtime = service?.runtime(BRIDGE_ID);
      runtime?.journal.appendAtomic({
        bridgeId: BRIDGE_ID,
        receivedAt: "2026-08-25T00:00:00.000Z",
        envelope: envelope(EPOCH_ID, 5, { kind: "heartbeat" }),
      });
      return page(request);
    },
  };
  const created = await createService(control);
  service = created.service;
  try {
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.equal(result.events.length, 1);
    assert.deepEqual(service.runtime(BRIDGE_ID)?.journal.watermark(BRIDGE_ID), { epochId: EPOCH_ID, lastSeq: 5 });
    assert.deepEqual(service.runtime(BRIDGE_ID)?.journal.consistentWatermark?.(BRIDGE_ID), {
      epochId: EPOCH_ID,
      lastSeq: 4,
    });
    assert.equal(service.runtime(BRIDGE_ID)?.ingest.worldSnapshot().get("native-light")?.states.get("native-light:main")?.origin, "observed");
  } finally {
    await created.fiber.dispose();
  }
});

test("rejects a resync epoch observed during the read and commits no imported rows", async () => {
  let service: HomeWorldService | undefined;
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => {
      service?.runtime(BRIDGE_ID)?.journal.appendAtomic({
        bridgeId: BRIDGE_ID,
        receivedAt: "2026-08-25T00:00:00.000Z",
        envelope: envelope("resync-epoch", 1, {
          kind: "sync-start",
          snapshotId: "resync-snapshot",
          remoteInstanceId: REMOTE_ID,
          reason: "resync",
        }),
      });
      return page(request);
    },
  };
  const created = await createService(control);
  service = created.service;
  try {
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "unavailable", reasons: ["resync_stale"] });
    assert.deepEqual(service.runtime(BRIDGE_ID)?.journal.watermark(BRIDGE_ID), {
      epochId: "resync-epoch",
      lastSeq: 1,
    });
    assert.deepEqual(service.runtime(BRIDGE_ID)?.journal.consistentWatermark?.(BRIDGE_ID), {
      epochId: EPOCH_ID,
      lastSeq: 4,
    });
    assert.equal(service.runtime(BRIDGE_ID)?.importedHistoryJournal.queryImportedEvidence({
      bridgeId: BRIDGE_ID,
      since: "2026-08-24T00:00:00.000Z",
      until: "2026-08-25T00:00:00.000Z",
      bindings: [{ nativeId: "native-light", nativeInstanceId: "native-light:main" }],
      limit: 20,
    }).records.length, 0);
  } finally {
    await created.fiber.dispose();
  }
});

test("rejects unbounded imported history queries before calling the adapter", async () => {
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => page(request),
  };
  const { service, fiber } = await createService(control);
  try {
    await assert.rejects(
      service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 169 }),
      /history query is invalid or unbounded/,
    );
    await assert.rejects(
      service.queryImportedHistory({ hwCapabilityIds: Array.from({ length: 21 }, () => CAPABILITY_ID), lookbackHours: 1 }),
      /history query is invalid or unbounded/,
    );
    await assert.rejects(
      service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1, limit: null as never }),
      /history query is invalid or unbounded/,
    );
    assert.equal(control.calls.length, 0);
  } finally {
    await fiber.dispose();
  }
});

test("rejects a history page with an inexact source range without committing it", async () => {
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => page(request, {
      sourceRange: { since: request.since, until: "2026-08-25T00:00:01.000Z" },
    }),
  };
  const { service, fiber } = await createService(control);
  try {
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "unavailable", reasons: ["invalid_response"] });
    assert.equal(service.runtime(BRIDGE_ID)?.importedHistoryJournal.queryImportedEvidence({
      bridgeId: BRIDGE_ID,
      since: "2026-08-24T23:00:00.000Z",
      until: "2026-08-25T00:00:00.000Z",
      bindings: [{ nativeId: "native-light", nativeInstanceId: "native-light:main" }],
      limit: 20,
    }).records.length, 0);
  } finally {
    await fiber.dispose();
  }
});

test("rejects a history page with an inexact live cut without committing it", async () => {
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => page(request, {
      liveCut: { epochId: request.liveCut.epochId, lastSeq: request.liveCut.lastSeq - 1 },
    }),
  };
  const { service, fiber } = await createService(control);
  try {
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "unavailable", reasons: ["invalid_response"] });
  } finally {
    await fiber.dispose();
  }
});

test("rejects a history row outside the Hub-resolved binding selection before persistence", async () => {
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => page(request, {
      records: [{
        historySeq: 1,
        state: {
          nativeId: "native-injected",
          nativeInstanceId: "native-injected:main",
          attrs: { state: "on", provider_payload: "must-not-persist" },
          time: { sourceTs: "2026-08-24T23:00:00.000Z", sourceTsQuality: "platform" },
          origin: "imported",
        },
      }],
    }),
  };
  const { service, fiber } = await createService(control);
  try {
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "unavailable", reasons: ["invalid_response"] });
    assert.equal(service.runtime(BRIDGE_ID)?.importedHistoryJournal.queryImportedEvidence({
      bridgeId: BRIDGE_ID,
      since: "2026-08-24T23:00:00.000Z",
      until: "2026-08-25T00:00:00.000Z",
      bindings: [{ nativeId: "native-injected", nativeInstanceId: "native-injected:main" }],
      limit: 20,
    }).records.length, 0);
  } finally {
    await fiber.dispose();
  }
});

test("maps a durable imported row outside the requested source range to invalid_row", async () => {
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => page(request, {
      records: [{
        historySeq: 1,
        state: {
          nativeId: "native-light",
          nativeInstanceId: "native-light:main",
          attrs: { state: "on" },
          time: { sourceTs: "2026-08-24T22:59:59.000Z", sourceTsQuality: "platform" },
          origin: "imported",
        },
      }],
    }),
  };
  const { service, fiber } = await createService(control);
  try {
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "unavailable", reasons: ["invalid_row"] });
  } finally {
    await fiber.dispose();
  }
});

test("rejects an adapter instance replacement observed after the history read", async () => {
  let service: HomeWorldService | undefined;
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => {
      const runtime = service?.runtime(BRIDGE_ID);
      if (runtime !== undefined) runtime.adapter = historyAdapter(control);
      return page(request);
    },
  };
  const created = await createService(control);
  service = created.service;
  try {
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "unavailable", reasons: ["resync_stale"] });
  } finally {
    await created.fiber.dispose();
  }
});

test("rejects a live watermark that falls behind the captured consistent cut before the read", async () => {
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => page(request),
  };
  const { service, fiber } = await createService(control);
  try {
    const journal = service.runtime(BRIDGE_ID)?.journal;
    assert.ok(journal);
    journal.watermark = () => ({ epochId: EPOCH_ID, lastSeq: 3 });
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "unavailable", reasons: ["resync_stale"] });
    assert.equal(control.calls.length, 0);
  } finally {
    await fiber.dispose();
  }
});

test("rejects a live watermark that falls behind the captured consistent cut after the read", async () => {
  let service: HomeWorldService | undefined;
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => {
      const journal = service?.runtime(BRIDGE_ID)?.journal;
      if (journal !== undefined) journal.watermark = () => ({ epochId: EPOCH_ID, lastSeq: 3 });
      return page(request);
    },
  };
  const created = await createService(control);
  service = created.service;
  try {
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "unavailable", reasons: ["resync_stale"] });
  } finally {
    await created.fiber.dispose();
  }
});

test("rejects a consistent epoch change observed after the history read", async () => {
  let service: HomeWorldService | undefined;
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => {
      const journal = service?.runtime(BRIDGE_ID)?.journal;
      journal?.appendAtomic({
        bridgeId: BRIDGE_ID,
        receivedAt: "2026-08-25T00:00:00.000Z",
        envelope: envelope("new-consistent-epoch", 1, {
          kind: "sync-start",
          snapshotId: "new-snapshot",
          remoteInstanceId: REMOTE_ID,
          reason: "resync",
        }),
      });
      journal?.appendAtomic({
        bridgeId: BRIDGE_ID,
        receivedAt: "2026-08-25T00:00:00.000Z",
        envelope: envelope("new-consistent-epoch", 2, {
          kind: "sync-complete",
          manifest: { snapshotId: "new-snapshot", deviceEnvelopeCount: 0, stateEnvelopeCount: 0 },
        }),
      });
      journal?.markConsistent?.(BRIDGE_ID, { epochId: "new-consistent-epoch", lastSeq: 2 });
      return page(request);
    },
  };
  const created = await createService(control);
  service = created.service;
  try {
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "unavailable", reasons: ["resync_stale"] });
  } finally {
    await created.fiber.dispose();
  }
});

test("rejects a bridge that becomes non-ready after the read even when its watermark is unchanged", async () => {
  let service: HomeWorldService | undefined;
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => {
      service?.runtime(BRIDGE_ID)?.ingest.recordStreamError("upstream_unavailable");
      return page(request);
    },
  };
  const created = await createService(control);
  service = created.service;
  try {
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "unavailable", reasons: ["bridge_not_ready"] });
    assert.deepEqual(service.runtime(BRIDGE_ID)?.journal.watermark(BRIDGE_ID), {
      epochId: EPOCH_ID,
      lastSeq: 4,
    });
  } finally {
    await created.fiber.dispose();
  }
});

test("rejects a resync request that starts before the live watermark advances", async () => {
  let service: HomeWorldService | undefined;
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => {
      void service?.runtime(BRIDGE_ID)?.ingest.requestResync();
      return page(request);
    },
  };
  const created = await createService(control);
  service = created.service;
  try {
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "unavailable", reasons: ["resync_stale"] });
    assert.deepEqual(service.runtime(BRIDGE_ID)?.journal.watermark(BRIDGE_ID), {
      epochId: EPOCH_ID,
      lastSeq: 4,
    });
  } finally {
    await created.fiber.dispose();
  }
});

test("reports an unavailable handle without attempting a history commit", async () => {
  const control: HistoryAdapterControl = {
    calls: [],
    historyAvailable: false,
    onFetch: async (request) => page(request),
  };
  const { service, fiber } = await createService(control);
  try {
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "unavailable", reasons: ["history_unavailable"] });
    assert.equal(control.calls.length, 0);
  } finally {
    await fiber.dispose();
  }
});

test("requires negotiated history availability even when an adapter exposes a handle", async () => {
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => page(request),
  };
  const { service, fiber } = await createService(control);
  try {
    const runtime = service.runtime(BRIDGE_ID);
    assert.ok(runtime);
    runtime.extensionAvailability = { ...runtime.extensionAvailability, "history@1": "unavailable" };
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "unavailable", reasons: ["history_unavailable"] });
    assert.equal(control.calls.length, 0);
  } finally {
    await fiber.dispose();
  }
});

test("reports a missing consistent baseline without fetching history", async () => {
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => page(request),
  };
  const { service, fiber } = await createService(control);
  try {
    const journal = service.runtime(BRIDGE_ID)?.journal;
    assert.ok(journal);
    journal.consistentWatermark = () => undefined;
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "unavailable", reasons: ["missing_consistent_baseline"] });
    assert.equal(control.calls.length, 0);
  } finally {
    await fiber.dispose();
  }
});

test("returns partial empty coverage while keeping imported state out of world models", async () => {
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => page(request, { records: [] }),
  };
  const { service, fiber } = await createService(control);
  try {
    const before = service.snapshot();
    const beforeWorldModelWatermark = service.worldModelWatermark(BRIDGE_ID);
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "partial", reasons: ["retention_floor_unknown"] });
    assert.deepEqual(service.snapshot().devices, before.devices);
    assert.deepEqual(service.worldModelWatermark(BRIDGE_ID), beforeWorldModelWatermark);
    assert.equal(service.worldModelLatestStates({ bridgeId: BRIDGE_ID })[0]?.origin, "observed");
  } finally {
    await fiber.dispose();
  }
});

test("rejects a resolved binding set above the per-bridge history bound before adapter access", async () => {
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => page(request),
  };
  const { service, fiber } = await createService(control);
  try {
    const originalSnapshot = service.snapshot.bind(service);
    service.snapshot = () => {
      const snapshot = originalSnapshot();
      return {
        ...snapshot,
        devices: snapshot.devices.map((device) => ({
          ...device,
          capabilities: device.capabilities.map((capability) => capability.hwCapabilityId !== CAPABILITY_ID
            ? capability
            : {
              ...capability,
              bindings: Array.from({ length: 21 }, (_, index) => ({
                ...capability.bindings[0]!,
                nativeId: `native-history-${index}`,
                nativeInstanceId: `native-history-${index}:main`,
              })),
            }),
        })),
      };
    };
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "unavailable", reasons: ["history_unavailable"] });
    assert.equal(control.calls.length, 0);
  } finally {
    await fiber.dispose();
  }
});

test("keeps cached imported rows partial when a later unavailable page is read", async () => {
  let unavailable = false;
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => unavailable
      ? page(request, { coverage: "unavailable", reasons: ["history_unavailable"], records: [] })
      : page(request),
  };
  const { service, fiber } = await createService(control);
  try {
    const first = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.equal(first.events.length, 1);
    unavailable = true;
    const second = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.equal(second.events.length, 1);
    assert.deepEqual(second.coverage, {
      status: "partial",
      reasons: ["history_unavailable", "retention_floor_unknown"],
    });
  } finally {
    await fiber.dispose();
  }
});

test("does not use import receipt time when a stored imported row lacks source time", async () => {
  let service: HomeWorldService | undefined;
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => {
      const imported = service?.runtime(BRIDGE_ID)?.importedHistoryJournal;
      if (imported !== undefined) {
        imported.queryImportedEvidence = () => ({
          records: [{
            bridgeId: BRIDGE_ID,
            importId: "import-history-1",
            historySeq: 1,
            receivedAt: "2026-08-25T00:00:00.000Z",
            liveCut: request.liveCut,
            state: {
              nativeId: "native-light",
              nativeInstanceId: "native-light:main",
              attrs: { state: "on" },
              time: { sourceTsQuality: "none" },
              origin: "imported",
            },
          }],
          gaps: [],
          truncated: false,
        });
      }
      return page(request);
    },
  };
  const created = await createService(control);
  service = created.service;
  try {
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, {
      status: "partial",
      reasons: ["retention_floor_unknown", "invalid_row"],
    });
  } finally {
    await created.fiber.dispose();
  }
});

test("settles a provider read at the bounded deadline when the adapter ignores abort", { timeout: 7_000 }, async () => {
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async () => new Promise<HistoryPage>(() => undefined),
  };
  const { service, fiber } = await createService(control);
  try {
    const result = await service.queryImportedHistory({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.coverage, { status: "unavailable", reasons: ["timeout"] });
  } finally {
    await fiber.dispose();
  }
});

test("aggregates a multi-bridge selection without exposing bridge identities", async () => {
  const control: HistoryAdapterControl = {
    calls: [],
    onFetch: async (request) => page(request),
  };
  const secondControl: HistoryAdapterControl = {
    calls: [],
    bridgeId: SECOND_BRIDGE_ID,
    remoteId: SECOND_REMOTE_ID,
    nativeId: "native-second-light",
    nativeInstanceId: "native-second-light:main",
    historyAvailable: false,
    onFetch: async (request) => page(request, {}, secondControl),
  };
  const created = await createService(control, {}, [{ bridgeId: SECOND_BRIDGE_ID, control: secondControl }]);
  try {
    const result = await created.service.queryImportedHistory({
      hwCapabilityIds: [CAPABILITY_ID, SECOND_CAPABILITY_ID],
      lookbackHours: 1,
    });
    assert.equal(result.events.length, 1);
    assert.deepEqual(result.coverage, {
      status: "partial",
      reasons: ["retention_floor_unknown", "history_unavailable"],
    });
    const encoded = JSON.stringify(result);
    assert.equal(encoded.includes(BRIDGE_ID), false);
    assert.equal(encoded.includes(SECOND_BRIDGE_ID), false);
    assert.equal(encoded.includes("native-second-light"), false);
    assert.equal(control.calls.length, 1);
    assert.equal(secondControl.calls.length, 0);
  } finally {
    await created.fiber.dispose();
  }
});
