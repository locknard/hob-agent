import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  BridgeEvent,
  Envelope,
  HistoryCoverageReason,
  HistoryPage,
  StateEvent,
} from "@hob/bridge-contract";

import { SqliteIngestJournal } from "./ingest-journal.js";
import { ImportedHistoryJournal } from "./imported-history-journal.js";

const BRIDGE_ID = "bridge-ha";
const LIVE_CUT = { epochId: "epoch-1", lastSeq: 42 } as const;

function state(
  sourceTs: string,
  value: string,
  overrides: Partial<StateEvent> = {},
): StateEvent {
  return {
    nativeId: "device-1",
    nativeInstanceId: "device-1:main",
    attrs: { state: value },
    time: { sourceTs, sourceTsQuality: "platform" },
    origin: "imported",
    ...overrides,
  };
}

function page(
  importId: string,
  records: readonly { readonly historySeq: number; readonly state: StateEvent }[],
  reasons: readonly HistoryCoverageReason[] = ["retention_floor_unknown"],
  sourceRange: HistoryPage["sourceRange"] = {
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
  },
): HistoryPage {
  return {
    importId,
    source: "home-assistant-recorder",
    sourceRange,
    liveCut: LIVE_CUT,
    coverage: "partial",
    reasons,
    records,
  };
}

function query(journal: ImportedHistoryJournal, limit = 200) {
  return queryRange(journal, {
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
  }, limit);
}

function queryRange(
  journal: ImportedHistoryJournal,
  range: { readonly since: string; readonly until: string },
  limit = 200,
) {
  return journal.queryImportedEvidence({
    bridgeId: BRIDGE_ID,
    since: range.since,
    until: range.until,
    bindings: [{ nativeId: "device-1", nativeInstanceId: "device-1:main" }],
    limit,
  });
}

test("atomically stores bounded imported history and restores it without creating live watermark tables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-imported-history-"));
  const path = join(directory, "journal.sqlite");
  const receivedAt = "2026-08-25T00:00:00.000Z";
  const first = new ImportedHistoryJournal(path, { clock: () => receivedAt });
  first.commitPage({ bridgeId: BRIDGE_ID, page: page("import-1", [
    { historySeq: 1, state: state("2026-08-20T00:00:10.000Z", "off") },
    { historySeq: 2, state: state("2026-08-20T00:00:20.000Z", "on") },
  ]), expectedLiveCut: LIVE_CUT });

  const firstResult = query(first);
  const sourceRange = firstResult.gaps[0]?.sourceRange;
  assert.notEqual(sourceRange, undefined);
  assert.deepEqual(query(first).records.map((record) => ({
    importId: record.importId,
    historySeq: record.historySeq,
    receivedAt: record.receivedAt,
    sourceRange: record.sourceRange,
    value: record.state.attrs.state,
  })), [
    { importId: "import-1", historySeq: 1, receivedAt, sourceRange, value: "off" },
    { importId: "import-1", historySeq: 2, receivedAt, sourceRange, value: "on" },
  ]);
  assert.deepEqual(firstResult.gaps.map((gap) => gap.reason), ["retention_floor_unknown"]);
  first.close();

  assert.equal(statSync(path).mode & 0o777, 0o600);
  const tableDatabase = new DatabaseSync(path);
  const tables = tableDatabase.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ingest_%' ORDER BY name",
  ).all() as Array<{ name: string }>;
  assert.deepEqual(tables, []);
  tableDatabase.close();

  const reopened = new ImportedHistoryJournal(path, { clock: () => receivedAt });
  assert.equal(query(reopened).records.length, 2);
  assert.deepEqual(query(reopened).records[0]?.sourceRange, sourceRange);
  assert.deepEqual(query(reopened).records[0]?.liveCut, LIVE_CUT);
  reopened.close();
  await rm(directory, { recursive: true, force: true });
});

test("retains the exact source range for each distinct overlapping import", () => {
  const journal = new ImportedHistoryJournal(":memory:", { clock: () => "2026-08-25T00:00:00.000Z" });
  const firstRange = {
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
  } as const;
  const secondRange = {
    since: "2026-08-20T00:30:00.000Z",
    until: "2026-08-20T01:30:00.000Z",
  } as const;
  journal.commitPage({
    bridgeId: BRIDGE_ID,
    page: page("import-a", [
      { historySeq: 1, state: state("2026-08-20T00:10:00.000Z", "off") },
    ], ["retention_floor_unknown"], firstRange),
    expectedLiveCut: LIVE_CUT,
  });
  journal.commitPage({
    bridgeId: BRIDGE_ID,
    page: page("import-b", [
      { historySeq: 1, state: state("2026-08-20T01:10:00.000Z", "on") },
    ], ["retention_floor_unknown"], secondRange),
    expectedLiveCut: LIVE_CUT,
  });

  const result = queryRange(journal, {
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T02:00:00.000Z",
  });
  const rangesByImport = new Map(result.gaps.map((gap) => [gap.importId, gap.sourceRange]));
  assert.deepEqual(result.records.map((record) => [record.importId, record.sourceRange]), [
    ["import-a", rangesByImport.get("import-a")],
    ["import-b", rangesByImport.get("import-b")],
  ]);
  journal.close();
});

test("migrates a legacy event table atomically and keeps missing source range unavailable across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-imported-history-legacy-range-"));
  const path = join(directory, "journal.sqlite");
  const legacyState = state("2026-08-20T00:00:10.000Z", "on");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE imported_history_events (
      bridge_id TEXT NOT NULL,
      import_id TEXT NOT NULL,
      history_seq INTEGER NOT NULL,
      live_epoch_id TEXT NOT NULL,
      live_last_seq INTEGER NOT NULL,
      received_at TEXT NOT NULL,
      source_ts TEXT,
      source_ts_quality TEXT NOT NULL,
      native_id TEXT NOT NULL,
      native_instance_id TEXT NOT NULL,
      state_json TEXT NOT NULL,
      canonical_key TEXT NOT NULL,
      conflict_key TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (bridge_id, import_id, history_seq)
    ) STRICT;
    CREATE UNIQUE INDEX imported_history_events_canonical_key
      ON imported_history_events (bridge_id, canonical_key);
    CREATE INDEX imported_history_events_query
      ON imported_history_events (bridge_id, source_ts, native_id, native_instance_id);
  `);
  legacy.prepare(`INSERT INTO imported_history_events
    (bridge_id, import_id, history_seq, live_epoch_id, live_last_seq,
     received_at, source_ts, source_ts_quality, native_id, native_instance_id,
     state_json, canonical_key, conflict_key, bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    BRIDGE_ID,
    "legacy-import",
    1,
    LIVE_CUT.epochId,
    LIVE_CUT.lastSeq,
    "2026-08-25T00:00:00.000Z",
    legacyState.time.sourceTs,
    legacyState.time.sourceTsQuality,
    legacyState.nativeId,
    legacyState.nativeInstanceId,
    JSON.stringify(legacyState),
    "legacy-canonical",
    "legacy-conflict",
    1,
  );
  legacy.close();

  const first = new ImportedHistoryJournal(path, { clock: () => "2026-08-25T00:00:00.000Z" });
  const firstResult = query(first);
  assert.equal(firstResult.records.length, 1);
  assert.equal(firstResult.records[0]?.sourceRange, undefined);
  const inspected = new DatabaseSync(path);
  const columns = inspected.prepare("PRAGMA table_info(imported_history_events)").all() as Array<{ name: string }>;
  inspected.close();
  assert.deepEqual(columns.filter((column) => column.name === "source_since" || column.name === "source_until").map((column) => column.name), [
    "source_since",
    "source_until",
  ]);
  first.close();

  const reopened = new ImportedHistoryJournal(path, { clock: () => "2026-08-25T00:00:00.000Z" });
  assert.equal(query(reopened).records[0]?.sourceRange, undefined);
  reopened.close();
  await rm(directory, { recursive: true, force: true });
});

test("deduplicates exact rows across overlapping imports and retains deterministic same-time conflicts", () => {
  const journal = new ImportedHistoryJournal(":memory:", { clock: () => "2026-08-25T00:00:00.000Z" });
  journal.commitPage({ bridgeId: BRIDGE_ID, page: page("import-a", [
    { historySeq: 1, state: state("2026-08-20T00:00:10.000Z", "off", {
      attrs: { state: "off", detail: { b: 2, a: 1 } },
    }) },
  ]), expectedLiveCut: LIVE_CUT });
  journal.commitPage({ bridgeId: BRIDGE_ID, page: page("import-b", [
    { historySeq: 1, state: state("2026-08-20T00:00:10.000Z", "off", {
      attrs: { detail: { a: 1, b: 2 }, state: "off" },
    }) },
    { historySeq: 2, state: state("2026-08-20T00:00:10.000Z", "on") },
  ]), expectedLiveCut: LIVE_CUT });

  const result = query(journal);
  assert.deepEqual(result.records.map((record) => [record.importId, record.state.attrs.state]), [
    ["import-a", "off"],
    ["import-b", "on"],
  ]);
  assert.deepEqual(result.gaps.map((gap) => gap.reason), [
    "retention_floor_unknown",
    "retention_floor_unknown",
    "source_conflict",
  ]);
  journal.close();
});

test("stores an unavailable page as one bounded coverage gap without rows", () => {
  const journal = new ImportedHistoryJournal(":memory:", { clock: () => "2026-08-25T00:00:00.000Z" });
  const unavailable = page("unavailable", [], ["history_unavailable"]);
  assert.deepEqual(journal.commitPage({
    bridgeId: BRIDGE_ID,
    page: { ...unavailable, coverage: "unavailable" },
    expectedLiveCut: LIVE_CUT,
  }), {
    committed: true,
    storedRecordCount: 0,
    deduplicatedRecordCount: 0,
    reasons: ["history_unavailable"],
  });
  assert.deepEqual(query(journal).records, []);
  assert.deepEqual(query(journal).gaps.map((gap) => gap.reason), ["history_unavailable"]);

  const otherBridge = journal.queryImportedEvidence({
    bridgeId: "bridge-other",
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "device-1:main" }],
    limit: 20,
  });
  assert.deepEqual(otherBridge.gaps, []);
  const nonOverlapping = journal.queryImportedEvidence({
    bridgeId: BRIDGE_ID,
    since: "2026-08-20T01:00:00.000Z",
    until: "2026-08-20T02:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "device-1:main" }],
    limit: 20,
  });
  assert.deepEqual(nonOverlapping.gaps, []);
  journal.close();
});

test("rejects malformed pages and live-cut mismatches before committing rows or gaps", () => {
  const journal = new ImportedHistoryJournal(":memory:", { clock: () => "2026-08-25T00:00:00.000Z" });
  const malformed = page("bad-origin", [{
    historySeq: 1,
    state: state("2026-08-20T00:00:10.000Z", "on", { origin: "observed" }),
  }]);
  assert.throws(() => journal.commitPage({
    bridgeId: BRIDGE_ID,
    page: malformed,
    expectedLiveCut: LIVE_CUT,
  }), /imported/);
  assert.equal(query(journal).records.length, 0);
  assert.equal(query(journal).gaps.length, 0);

  assert.throws(() => journal.commitPage({
    bridgeId: BRIDGE_ID,
    page: {
      ...page("noncanonical-time", [{ historySeq: 1, state: state("2026-08-20T00:00:10.000Z", "on") }]),
      sourceRange: {
        since: "2026-08-20T00:00:00.000+00:00",
        until: "2026-08-20T01:00:00.000Z",
      },
    },
    expectedLiveCut: LIVE_CUT,
  }), /history page is invalid|timestamp/iu);

  assert.throws(() => journal.commitPage({
    bridgeId: BRIDGE_ID,
    page: page("out-of-range", [{ historySeq: 1, state: state("2026-08-20T01:00:00.000Z", "on") }]),
    expectedLiveCut: LIVE_CUT,
  }), /source timestamp|range/iu);

  assert.throws(() => journal.commitPage({
    bridgeId: BRIDGE_ID,
    page: page("stale", [{ historySeq: 1, state: state("2026-08-20T00:00:10.000Z", "on") }]),
    expectedLiveCut: { epochId: "epoch-2", lastSeq: 1 },
  }), /live cut/);
  assert.equal(query(journal).records.length, 0);
  assert.equal(query(journal).gaps.length, 0);
  journal.close();
});

test("reports imported quota without exceeding a too-small partition", () => {
  const journal = new ImportedHistoryJournal(":memory:", {
    clock: () => "2026-08-25T00:00:00.000Z",
    maxBytes: 1,
  });
  const result = journal.commitPage({
    bridgeId: BRIDGE_ID,
    page: page("quota", [{ historySeq: 1, state: state("2026-08-20T00:00:10.000Z", "on") }]),
    expectedLiveCut: LIVE_CUT,
  });
  assert.deepEqual(result, {
    committed: false,
    storedRecordCount: 0,
    deduplicatedRecordCount: 0,
    reasons: ["imported_quota"],
  });
  assert.equal(query(journal).records.length, 0);
  assert.deepEqual(query(journal).gaps, []);
  assert.deepEqual(journal.capacity(), { usedBytes: 0, maxBytes: 1, remainingBytes: 1 });
  journal.close();
});

test("canonicalizes mixed fractional precision for range order and exact deduplication", () => {
  const journal = new ImportedHistoryJournal(":memory:", { clock: () => "2026-08-25T00:00:00.000Z" });
  journal.commitPage({ bridgeId: BRIDGE_ID, page: page("precision-a", [
    { historySeq: 1, state: state("2026-08-20T00:00:00Z", "off") },
    { historySeq: 2, state: state("2026-08-20T00:00:00.100Z", "on") },
    { historySeq: 3, state: state("2026-08-20T00:00:00.010Z", "idle") },
  ]), expectedLiveCut: LIVE_CUT });

  const replay = journal.commitPage({ bridgeId: BRIDGE_ID, page: page("precision-b", [
    { historySeq: 1, state: state("2026-08-20T00:00:00.000Z", "off") },
    { historySeq: 2, state: state("2026-08-20T00:00:00.1000Z", "on") },
  ]), expectedLiveCut: LIVE_CUT });
  assert.equal(replay.storedRecordCount, 0);
  assert.equal(replay.deduplicatedRecordCount, 2);

  const all = journal.queryImportedEvidence({
    bridgeId: BRIDGE_ID,
    since: "2026-08-20T00:00:00Z",
    until: "2026-08-20T00:01:00Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "device-1:main" }],
    limit: 20,
  });
  assert.deepEqual(all.records.map((record) => [record.state.time.sourceTs, record.state.attrs.state]), [
    ["2026-08-20T00:00:00Z", "off"],
    ["2026-08-20T00:00:00.010Z", "idle"],
    ["2026-08-20T00:00:00.100Z", "on"],
  ]);

  const halfOpen = journal.queryImportedEvidence({
    bridgeId: BRIDGE_ID,
    since: "2026-08-20T00:00:00Z",
    until: "2026-08-20T00:00:00.010Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "device-1:main" }],
    limit: 20,
  });
  assert.deepEqual(halfOpen.records.map((record) => record.state.attrs.state), ["off"]);
  journal.close();
});

test("bounds repeated quota gaps for unique import ids by accounted bytes", () => {
  const journal = new ImportedHistoryJournal(":memory:", {
    clock: () => "2026-08-25T00:00:00.000Z",
    maxBytes: 1024,
  });
  const oversized = "x".repeat(2_000);
  for (const importId of ["quota-a", "quota-b", "quota-c"]) {
    const result = journal.commitPage({
      bridgeId: BRIDGE_ID,
      page: page(importId, [{
        historySeq: 1,
        state: state("2026-08-20T00:00:00.010Z", "on", { attrs: { state: "on", oversized } }),
      }]),
      expectedLiveCut: LIVE_CUT,
    });
    assert.deepEqual(result.reasons, ["imported_quota"]);
    assert.equal(result.committed, false);
  }
  const gaps = query(journal).gaps;
  assert.equal(gaps.filter((gap) => gap.reason === "imported_quota").length, 1);
  assert.equal(journal.capacity().usedBytes <= journal.capacity().maxBytes, true);
  assert.equal(journal.capacity().usedBytes > 0, true);
  journal.close();
});

test("enforces exact bounded range, binding, and result limits and blocks raw vendor payload", () => {
  const journal = new ImportedHistoryJournal(":memory:");
  assert.throws(() => journal.queryImportedEvidence({
    bridgeId: BRIDGE_ID,
    since: "2026-08-01T00:00:00.000Z",
    until: "2026-08-20T00:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "device-1:main" }],
    limit: 20,
  }), /range/);
  assert.throws(() => journal.queryImportedEvidence({
    bridgeId: BRIDGE_ID,
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: Array.from({ length: 21 }, (_, index) => ({ nativeId: `device-${index}`, nativeInstanceId: "main" })),
    limit: 20,
  }), /bindings/);
  assert.throws(() => journal.queryImportedEvidence({
    bridgeId: BRIDGE_ID,
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "device-1:main" }],
    limit: 201,
  }), /limit/);

  assert.throws(() => journal.commitPage({
    bridgeId: BRIDGE_ID,
    page: page("vendor", [{
      historySeq: 1,
      state: state("2026-08-20T00:00:10.000Z", "on", { attrs: { providerPayload: { secret: "must-not-cross" } } }),
    }]),
    expectedLiveCut: LIVE_CUT,
  }), /canonical|resource|vendor|payload/iu);
  assert.equal(query(journal).records.length, 0);
  journal.close();
});

test("fails closed when durable receivedAt is malformed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-imported-history-received-at-"));
  const path = join(directory, "journal.sqlite");
  const journal = new ImportedHistoryJournal(path, { clock: () => "2026-08-25T00:00:00.000Z" });
  journal.commitPage({
    bridgeId: BRIDGE_ID,
    page: page("received-at", [{ historySeq: 1, state: state("2026-08-20T00:00:10.000Z", "on") }]),
    expectedLiveCut: LIVE_CUT,
  });
  journal.close();
  const database = new DatabaseSync(path);
  database.prepare("UPDATE imported_history_events SET received_at = ?").run("not-a-timestamp");
  database.close();

  const reopened = new ImportedHistoryJournal(path, { clock: () => "2026-08-25T00:00:00.000Z" });
  assert.throws(() => query(reopened), /receivedAt/iu);
  reopened.close();
  await rm(directory, { recursive: true, force: true });
});

test("keeps live ingest tables unchanged when both journals share one SQLite file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-imported-history-shared-"));
  const path = join(directory, "journal.sqlite");
  const live = new SqliteIngestJournal(path);
  const imported = new ImportedHistoryJournal(path, { clock: () => "2026-08-25T00:00:00.000Z" });
  const liveEvent: BridgeEvent = {
    kind: "state",
    state: {
      nativeId: "live-device",
      nativeInstanceId: "live-device:main",
      attrs: { state: "on" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  };
  const liveEnvelope: Envelope = { epochId: "epoch-live", seq: 1, event: liveEvent };
  live.appendAtomic({
    bridgeId: BRIDGE_ID,
    receivedAt: "2026-08-25T00:00:00.000Z",
    envelope: liveEnvelope,
  });
  live.markConsistent(BRIDGE_ID, { epochId: "epoch-live", lastSeq: 1 });
  live.recordHistoryGap({
    bridgeId: BRIDGE_ID,
    epochId: "epoch-live",
    fromSeq: 2,
    toSeq: 3,
    reason: "bridge_disconnect",
  });
  const before = {
    watermark: live.watermark(BRIDGE_ID),
    consistent: live.consistentWatermark(BRIDGE_ID),
    records: live.records(BRIDGE_ID),
    gaps: live.historyGaps(BRIDGE_ID),
  };

  imported.commitPage({
    bridgeId: BRIDGE_ID,
    page: {
      ...page("shared", [{ historySeq: 1, state: state("2026-08-20T00:00:10.000Z", "off") }]),
      liveCut: { epochId: "epoch-live", lastSeq: 1 },
    },
    expectedLiveCut: { epochId: "epoch-live", lastSeq: 1 },
  });

  assert.deepEqual({
    watermark: live.watermark(BRIDGE_ID),
    consistent: live.consistentWatermark(BRIDGE_ID),
    records: live.records(BRIDGE_ID),
    gaps: live.historyGaps(BRIDGE_ID),
  }, before);
  assert.equal(imported.queryImportedEvidence({
    bridgeId: BRIDGE_ID,
    since: "2026-08-20T00:00:00.000Z",
    until: "2026-08-20T01:00:00.000Z",
    bindings: [{ nativeId: "device-1", nativeInstanceId: "device-1:main" }],
    limit: 20,
  }).records.length, 1);
  imported.close();
  live.close();
  await rm(directory, { recursive: true, force: true });
});
