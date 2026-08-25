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
  type StateEvent,
} from "@hob/bridge-contract";

import { BridgeCatalog, type AdapterRegistration } from "../bridge/bridge-catalog.js";
import { BridgeRegistry, type BridgeConfigEntry } from "../bridge/bridge-registry.js";
import { ImportedHistoryJournal } from "./imported-history-journal.js";
import { SqliteIngestJournal } from "./ingest-journal.js";
import { HomeWorldService, type HomeWorldServiceOptions } from "./home-world-service.js";
import { WorldIdentityManager } from "./world-identity.js";

const BRIDGE_ID = "bridge-proposal-history";
const REMOTE_ID = "remote-proposal-history";
const EPOCH_ID = "proposal-history-epoch";
const CAPABILITY_ID = "hwc-proposal-light";
const CLOCK = "2026-08-25T00:00:00.000Z";

const capabilitySchema = {
  schema: "synthetic.light",
  majorVersion: 1,
  attrsSchema: z.record(z.string(), z.unknown()),
  canonicalHash: "synthetic-light-v1",
} as never;

function envelope(epochId: string, seq: number, event: BridgeEvent): Envelope {
  return { epochId, seq, event };
}

function liveStream(): readonly Envelope[] {
  return [
    envelope(EPOCH_ID, 1, {
      kind: "sync-start",
      snapshotId: "proposal-history-snapshot",
      remoteInstanceId: REMOTE_ID,
      reason: "initial",
    }),
    envelope(EPOCH_ID, 2, {
      kind: "device-upserted",
      device: {
        nativeId: "native-proposal-light",
        name: "Living light",
        capabilities: [{
          nativeInstanceId: "native-proposal-light:main",
          schema: "synthetic.light",
          schemaVersion: "1.0.0",
          semanticKind: "light",
        }],
      },
    }),
    envelope(EPOCH_ID, 3, {
      kind: "state",
      state: {
        nativeId: "native-proposal-light",
        nativeInstanceId: "native-proposal-light:main",
        attrs: { state: "off" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }),
    envelope(EPOCH_ID, 4, {
      kind: "sync-complete",
      manifest: { snapshotId: "proposal-history-snapshot", deviceEnvelopeCount: 1, stateEnvelopeCount: 1 },
    }),
  ];
}

function historyPage(): HistoryPage {
  return {
    importId: "import-proposal-history",
    source: "home-assistant-recorder",
    sourceRange: {
      since: "2026-08-24T23:00:00.000Z",
      until: CLOCK,
    },
    liveCut: { epochId: EPOCH_ID, lastSeq: 4 },
    coverage: "partial",
    reasons: ["retention_floor_unknown"],
    records: [
      {
        historySeq: 1,
        state: {
          nativeId: "native-proposal-light",
          nativeInstanceId: "native-proposal-light:main",
          attrs: { state: "off" },
          time: { sourceTs: "2026-08-24T23:10:00.000Z", sourceTsQuality: "platform" },
          origin: "imported",
        },
      },
      {
        historySeq: 2,
        state: {
          nativeId: "native-proposal-light",
          nativeInstanceId: "native-proposal-light:main",
          attrs: { state: "on", provider_payload: "must-stay-private" },
          time: { sourceTs: "2026-08-24T23:30:00.000Z", sourceTsQuality: "platform" },
          origin: "imported",
        },
      },
    ],
  };
}

interface AdapterControl {
  readonly onFetch?: (request: Parameters<HistoryHandle["fetchHistory"]>[0]) => Promise<HistoryPage>;
}

function adapter(control: AdapterControl = {}): BridgeAdapter {
  let subscribed = false;
  let open = true;
  const handle: HistoryHandle = {
    fetchHistory: async (request) => control.onFetch?.(request) ?? historyPage(),
  };
  return {
    info: {
      bridgeId: BRIDGE_ID,
      coreVersion: "6.3.0",
      ecosystem: "synthetic",
      heartbeatIntervalMs: 60_000,
      extensions: [HISTORY_EXTENSION],
    },
    async *events(signal) {
      if (subscribed) throw new Error("proposal history adapter supports one subscription");
      subscribed = true;
      for (const item of liveStream()) {
        if (signal.aborted || !open) return;
        yield item;
      }
    },
    control: {
      requestResync: async () => ({ status: "completed" }),
      dispose: async () => { open = false; },
    },
    extension(name) {
      return name === "history@1" ? handle : undefined;
    },
  };
}

function identityManager(): WorldIdentityManager {
  return new WorldIdentityManager({
    idFactory: (kind) => ({
      hw: "hw-proposal-device",
      hwCapability: CAPABILITY_ID,
      hwSpace: "hws-proposal-living",
      proposal: "proposal-history",
      audit: "audit-history",
    })[kind],
  });
}

function registration(factory: AdapterRegistration<Record<string, never>>["factory"]): AdapterRegistration<Record<string, never>> {
  return {
    adapterType: "synthetic-proposal-history",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas: [capabilitySchema],
    factory,
  };
}

function entry(): BridgeConfigEntry<Record<string, never>> {
  return { bridgeId: BRIDGE_ID, adapterType: "synthetic-proposal-history", config: {} };
}

async function waitForReady(service: HomeWorldService): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.snapshot().bridges[BRIDGE_ID]?.diagnostics.connectionState === "ready") return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for proposal history bridge");
}

async function createService(): Promise<{
  readonly service: HomeWorldService;
  readonly fiber: { dispose(): Promise<void> };
}> {
  const catalog = new BridgeCatalog();
  catalog.register(registration(() => adapter()));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const options: HomeWorldServiceOptions = {
    catalog,
    registry,
    bridges: [entry()],
    journalFactory: () => new SqliteIngestJournal(":memory:"),
    importedHistoryJournalFactory: () => new ImportedHistoryJournal(":memory:", { clock: () => CLOCK }),
    maxRestarts: 0,
    scheduler: { wait: async () => undefined },
    identityManager: identityManager(),
    clock: () => CLOCK,
  };
  const fiber = await ctx.plugin(HomeWorldService, options);
  await waitForReady(ctx.homeWorld);
  return { service: ctx.homeWorld, fiber };
}

function importedRecord(overrides: Partial<{
  readonly bridgeId: string;
  readonly importId: string;
  readonly historySeq: number;
  readonly sourceRange: { readonly since: string; readonly until: string };
  readonly state: StateEvent;
}> & { readonly omitSourceRange?: boolean } = {}) {
  return {
    bridgeId: overrides.bridgeId ?? BRIDGE_ID,
    importId: overrides.importId ?? "import-proposal-history",
    historySeq: overrides.historySeq ?? 1,
    ...(overrides.omitSourceRange ? {} : {
      sourceRange: overrides.sourceRange ?? {
        since: "2026-08-24T23:00:00.0000000000000000000000000000000000000000000Z",
        until: "2026-08-25T00:00:00.0000000000000000000000000000000000000000000Z",
      },
    }),
    receivedAt: CLOCK,
    liveCut: { epochId: EPOCH_ID, lastSeq: 4 },
    state: overrides.state ?? historyPage().records[0]!.state,
  };
}

test("projects exact imported refs for proposal evidence without live or native provenance", async () => {
  const { service, fiber } = await createService();
  try {
    const runtime = service.runtime(BRIDGE_ID);
    assert.ok(runtime);
    runtime.importedHistoryJournal.commitPage({
      bridgeId: BRIDGE_ID,
      page: historyPage(),
      expectedLiveCut: { epochId: EPOCH_ID, lastSeq: 4 },
    });

    const result = await service.queryImportedHistoryForProposal({
      hwCapabilityIds: [CAPABILITY_ID],
      lookbackHours: 24,
      limit: 10,
    });

    assert.deepEqual(result.references, [
      {
        bridgeId: BRIDGE_ID,
        hwId: "hw-proposal-device",
        capabilityId: CAPABILITY_ID,
        observedAt: "2026-08-24T23:10:00.000Z",
        source: "imported-history",
        origin: "imported",
        importId: "import-proposal-history",
        historySeq: 1,
        sourceRange: {
          since: "2026-08-24T23:00:00.0000000000000000000000000000000000000000000Z",
          until: "2026-08-25T00:00:00.0000000000000000000000000000000000000000000Z",
        },
      },
      {
        bridgeId: BRIDGE_ID,
        hwId: "hw-proposal-device",
        capabilityId: CAPABILITY_ID,
        observedAt: "2026-08-24T23:30:00.000Z",
        source: "imported-history",
        origin: "imported",
        importId: "import-proposal-history",
        historySeq: 2,
        sourceRange: {
          since: "2026-08-24T23:00:00.0000000000000000000000000000000000000000000Z",
          until: "2026-08-25T00:00:00.0000000000000000000000000000000000000000000Z",
        },
      },
    ]);
    assert.deepEqual(result.coverage, [{
      bridgeId: BRIDGE_ID,
      status: "partial",
      reasons: ["retention_floor_unknown"],
    }]);
    assert.equal(result.truncated, false);
    const encoded = JSON.stringify(result);
    for (const forbidden of [
      "nativeId",
      "nativeInstanceId",
      "provider_payload",
      "liveCut",
      "epochId",
      "seq",
      "cause",
      "receivedAt",
    ]) assert.equal(encoded.includes(forbidden), false, forbidden);

    const publicResult = await service.queryImportedHistory({
      hwCapabilityIds: [CAPABILITY_ID],
      lookbackHours: 24,
      limit: 10,
    });
    assert.equal("references" in publicResult, false);
    assert.equal("sourceRange" in (publicResult.events[0] ?? {}), false);
    assert.equal("importId" in (publicResult.events[0] ?? {}), false);
  } finally {
    await fiber.dispose();
  }
});

test("uses the explicit import window without taking a second projection clock read", async () => {
  const { service, fiber } = await createService();
  try {
    const runtime = service.runtime(BRIDGE_ID);
    assert.ok(runtime);
    runtime.importedHistoryJournal.commitPage({
      bridgeId: BRIDGE_ID,
      page: historyPage(),
      expectedLiveCut: { epochId: EPOCH_ID, lastSeq: 4 },
    });
    let query: { readonly since: string; readonly until: string } | undefined;
    const originalQuery = runtime.importedHistoryJournal.queryImportedEvidence.bind(runtime.importedHistoryJournal);
    runtime.importedHistoryJournal.queryImportedEvidence = (input) => {
      query = input;
      return originalQuery(input);
    };
    const originalClock = (service as unknown as { clock: () => string }).clock.bind(service);
    let clockReads = 0;
    (service as unknown as { clock: () => string }).clock = () => {
      clockReads += 1;
      return originalClock();
    };
    const requestedSince = "2026-08-24T23:00:00.000Z";
    const requestedUntil = CLOCK;
    const result = service.queryImportedHistoryForProposal(
      { hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1, limit: 10 },
      { requestedSince, requestedUntil },
    );
    assert.equal(result.requestedSince, requestedSince);
    assert.equal(result.requestedUntil, requestedUntil);
    assert.deepEqual(query, {
      bridgeId: BRIDGE_ID,
      since: requestedSince,
      until: requestedUntil,
      bindings: [{ nativeId: "native-proposal-light", nativeInstanceId: "native-proposal-light:main" }],
      limit: 10,
    });
    assert.equal(clockReads, 1);
  } finally {
    await fiber.dispose();
  }
});

test("keeps legacy rows out of proposal refs and reports range-unavailable partial coverage", async () => {
  const { service, fiber } = await createService();
  try {
    const runtime = service.runtime(BRIDGE_ID);
    assert.ok(runtime);
    runtime.importedHistoryJournal.queryImportedEvidence = () => ({
      records: [importedRecord({ omitSourceRange: true })],
      gaps: [],
      truncated: false,
    });

    const result = await service.queryImportedHistoryForProposal({
      hwCapabilityIds: [CAPABILITY_ID],
      lookbackHours: 1,
      limit: 10,
    });

    assert.deepEqual(result.references, []);
    assert.deepEqual(result.coverage, [{
      bridgeId: BRIDGE_ID,
      status: "partial",
      reasons: ["history_range_unavailable"],
    }]);
  } finally {
    await fiber.dispose();
  }
});

test("accepts canonical millisecond UTC ranges and rejects offset or noncanonical fractions", async () => {
  const { service, fiber } = await createService();
  try {
    const runtime = service.runtime(BRIDGE_ID);
    assert.ok(runtime);
    runtime.importedHistoryJournal.queryImportedEvidence = () => ({
      records: [
        importedRecord({
          sourceRange: {
            since: "2026-08-24T23:00:00.000Z",
            until: "2026-08-25T00:00:00.000Z",
          },
        }),
        importedRecord({
          historySeq: 2,
          sourceRange: {
            since: "2026-08-24T23:00:00+00:00",
            until: "2026-08-25T00:00:00.00Z",
          },
        }),
      ],
      gaps: [],
      truncated: false,
    });

    const result = service.queryImportedHistoryForProposal({
      hwCapabilityIds: [CAPABILITY_ID],
      lookbackHours: 1,
      limit: 50,
    });
    assert.equal(result.references.length, 1);
    assert.deepEqual(result.references[0]?.sourceRange, {
      since: "2026-08-24T23:00:00.000Z",
      until: "2026-08-25T00:00:00.000Z",
    });
    assert.deepEqual(result.coverage, [{
      bridgeId: BRIDGE_ID,
      status: "partial",
      reasons: ["history_range_unavailable"],
    }]);
  } finally {
    await fiber.dispose();
  }
});

test("preserves a journal-canonical long fraction without lossy millisecond conversion", async () => {
  const { service, fiber } = await createService();
  try {
    const runtime = service.runtime(BRIDGE_ID);
    assert.ok(runtime);
    const since = `2026-08-24T23:00:00.${"0".repeat(42)}1Z`;
    const until = `2026-08-25T00:00:00.${"0".repeat(42)}2Z`;
    runtime.importedHistoryJournal.queryImportedEvidence = () => ({
      records: [importedRecord({ sourceRange: { since, until } })],
      gaps: [],
      truncated: false,
    });

    const result = service.queryImportedHistoryForProposal({
      hwCapabilityIds: [CAPABILITY_ID],
      lookbackHours: 1,
      limit: 50,
    });
    assert.deepEqual(result.references[0]?.sourceRange, { since, until });
  } finally {
    await fiber.dispose();
  }
});

test("validates current bindings and bounded input before reading imported history", async () => {
  const { service, fiber } = await createService();
  try {
    const runtime = service.runtime(BRIDGE_ID);
    assert.ok(runtime);
    let calls = 0;
    runtime.importedHistoryJournal.queryImportedEvidence = (query) => {
      calls += 1;
      assert.deepEqual(query.bindings, [{
        nativeId: "native-proposal-light",
        nativeInstanceId: "native-proposal-light:main",
      }]);
      return {
        records: [
          importedRecord(),
          importedRecord({
            historySeq: 3,
            state: {
              ...historyPage().records[0]!.state,
              nativeId: "native-not-selected",
              nativeInstanceId: "native-not-selected:main",
            },
          }),
        ],
        gaps: [],
        truncated: false,
      };
    };

    assert.throws(
      () => service.queryImportedHistoryForProposal({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 169 }),
      /history query is invalid or unbounded/,
    );
    assert.throws(
      () => service.queryImportedHistoryForProposal({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1, limit: 51 }),
      /history query is invalid or unbounded/,
    );
    assert.equal(calls, 0);

    const result = await service.queryImportedHistoryForProposal({
      hwCapabilityIds: [CAPABILITY_ID],
      lookbackHours: 1,
      limit: 10,
    });
    assert.equal(calls, 1);
    assert.equal(result.references.length, 1);
    assert.deepEqual(result.coverage, [{
      bridgeId: BRIDGE_ID,
      status: "partial",
      reasons: ["invalid_row"],
    }]);

    const originalSnapshot = service.snapshot.bind(service);
    service.snapshot = () => ({
      ...originalSnapshot(),
      devices: originalSnapshot().devices.map((device) => ({
        ...device,
        capabilities: device.capabilities.map((capability) => capability.hwCapabilityId === CAPABILITY_ID
          ? { ...capability, bindings: [] }
          : capability),
      })),
    });
    assert.throws(
      () => service.queryImportedHistoryForProposal({ hwCapabilityIds: [CAPABILITY_ID], lookbackHours: 1 }),
      /home history selection contains no current binding/,
    );
  } finally {
    await fiber.dispose();
  }
});

test("keeps an empty imported journal partial and a failed journal unavailable for the related bridge", async () => {
  const { service, fiber } = await createService();
  try {
    const runtime = service.runtime(BRIDGE_ID);
    assert.ok(runtime);
    let observedLimit = 0;
    runtime.importedHistoryJournal.queryImportedEvidence = () => ({
      records: [],
      gaps: [],
      truncated: false,
    });
    const originalQuery = runtime.importedHistoryJournal.queryImportedEvidence;
    runtime.importedHistoryJournal.queryImportedEvidence = (query) => {
      observedLimit = query.limit;
      return originalQuery(query);
    };
    const empty = service.queryImportedHistoryForProposal({
      hwCapabilityIds: [CAPABILITY_ID],
      lookbackHours: 1,
    });
    assert.equal(observedLimit, 50);
    assert.deepEqual(empty.references, []);
    assert.deepEqual(empty.coverage, [{
      bridgeId: BRIDGE_ID,
      status: "partial",
      reasons: ["retention_floor_unknown"],
    }]);
    assert.equal(empty.requestedSince, "2026-08-24T23:00:00.000Z");
    assert.equal(empty.requestedUntil, CLOCK);

    runtime.importedHistoryJournal.queryImportedEvidence = () => {
      throw new Error("journal unavailable");
    };
    const unavailable = service.queryImportedHistoryForProposal({
      hwCapabilityIds: [CAPABILITY_ID],
      lookbackHours: 1,
      limit: 50,
    });
    assert.deepEqual(unavailable.references, []);
    assert.deepEqual(unavailable.coverage, [{
      bridgeId: BRIDGE_ID,
      status: "unavailable",
      reasons: ["journal_query_unavailable"],
    }]);
  } finally {
    await fiber.dispose();
  }
});

test("marks deterministic cross-bridge merge truncation without expanding selected authority", async () => {
  const { service, fiber } = await createService();
  try {
    const runtime = service.runtime(BRIDGE_ID);
    assert.ok(runtime);
    runtime.importedHistoryJournal.queryImportedEvidence = () => ({
      records: [importedRecord()],
      gaps: [],
      truncated: true,
    });

    const result = await service.queryImportedHistoryForProposal({
      hwCapabilityIds: [CAPABILITY_ID],
      lookbackHours: 1,
      limit: 1,
    });
    assert.equal(result.references.length, 1);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.coverage, [{
      bridgeId: BRIDGE_ID,
      status: "partial",
      reasons: ["query_truncated"],
    }]);
  } finally {
    await fiber.dispose();
  }
});
