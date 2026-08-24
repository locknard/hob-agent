import assert from "node:assert/strict";
import test from "node:test";

import {
  HISTORY_EXTENSION,
  HISTORY_EXTENSION_KEY,
  HistoryCoverageReasonSchema,
  HistoryPageSchema,
  HistoryRecordSchema,
  HistoryRequestSchema,
  type HistoryHandle,
} from "./bridge-history.js";
import type { ExtensionHandleRegistry } from "./bridge-contract.js";

const liveCut = { epochId: "epoch-1", lastSeq: 17 } as const;
const validRequest = {
  since: "2026-08-20T00:00:00.000Z",
  until: "2026-08-20T01:00:00.000Z",
  bindings: [{ nativeId: "device-1", nativeInstanceId: "entity-1" }],
  liveCut,
};

test("declares the versioned history handle and closed coverage reasons", () => {
  assert.deepEqual(HISTORY_EXTENSION, { id: "history", version: "1.0.0" });
  assert.equal(HISTORY_EXTENSION_KEY, "history@1");
  const typed: ExtensionHandleRegistry["history@1"] = {
    fetchHistory: async () => {
      throw new Error("test handle");
    },
  } satisfies HistoryHandle;
  assert.equal(typeof typed.fetchHistory, "function");
  assert.equal(HistoryCoverageReasonSchema.safeParse("retention_floor_unknown").success, true);
  assert.equal(HistoryCoverageReasonSchema.safeParse("provider_guess").success, false);
});

test("accepts a bounded UTC request and preserves the exact live cut", () => {
  const parsed = HistoryRequestSchema.parse(validRequest);
  assert.deepEqual(parsed.liveCut, liveCut);
  assert.equal(HistoryRequestSchema.safeParse({ ...validRequest, extra: true }).success, false);
  assert.equal(HistoryRequestSchema.safeParse({
    ...validRequest,
    until: "2026-08-27T01:00:01.000Z",
  }).success, false);
  assert.equal(HistoryRequestSchema.safeParse({
    ...validRequest,
    since: "2026-08-20T00:00:00.000+08:00",
  }).success, false);
  assert.equal(HistoryRequestSchema.safeParse({
    ...validRequest,
    bindings: Array.from({ length: 21 }, (_, index) => ({
      nativeId: `device-${index}`,
      nativeInstanceId: `entity-${index}`,
    })),
  }).success, false);
  assert.equal(HistoryRequestSchema.safeParse({
    ...validRequest,
    bindings: [
      validRequest.bindings[0],
      { ...validRequest.bindings[0] },
    ],
  }).success, false);
  assert.equal(HistoryRequestSchema.safeParse({
    ...validRequest,
    bindings: [{ nativeId: " device-1", nativeInstanceId: "entity-1" }],
  }).success, false);
  assert.equal(HistoryRequestSchema.safeParse({
    ...validRequest,
    liveCut: { ...liveCut, epochId: " epoch-1" },
  }).success, false);
});

test("accepts imported-only history records and rejects observed records or vendor fields", () => {
  const basePage = {
    importId: "import-1",
    source: "home-assistant-recorder",
    sourceRange: { since: validRequest.since, until: validRequest.until },
    liveCut,
    coverage: "partial",
    reasons: ["retention_floor_unknown"],
    records: [{
      historySeq: 1,
      state: {
        nativeId: "device-1",
        nativeInstanceId: "entity-1",
        attrs: { state: "on" },
        time: { sourceTs: "2026-08-20T00:10:00.000Z", sourceTsQuality: "platform" },
        origin: "imported",
      },
    }],
  };
  assert.equal(HistoryPageSchema.safeParse(basePage).success, true);
  assert.equal(HistoryPageSchema.safeParse({
    ...basePage,
    liveCut: { epochId: "other", lastSeq: 17 },
  }).success, true);
  assert.equal(HistoryPageSchema.safeParse({
    ...basePage,
    records: [{ ...basePage.records[0], state: { ...basePage.records[0].state, origin: "observed" } }],
  }).success, false);
  assert.equal(HistoryPageSchema.safeParse({ ...basePage, vendorPayload: {} }).success, false);
  assert.equal(HistoryPageSchema.safeParse({ ...basePage, importId: " import-1" }).success, false);
  assert.equal(HistoryPageSchema.safeParse({
    ...basePage,
    coverage: "unavailable",
    records: basePage.records,
  }).success, false);
  assert.equal(HistoryPageSchema.safeParse({
    ...basePage,
    records: [{ ...basePage.records[0], historySeq: 2 }],
  }).success, false);
  assert.equal(HistoryPageSchema.safeParse({
    ...basePage,
    records: [basePage.records[0], { ...basePage.records[0] }],
  }).success, false);
  assert.equal(HistoryPageSchema.safeParse({
    ...basePage,
    reasons: ["retention_floor_unknown", "retention_floor_unknown"],
  }).success, false);
});

test("history records enforce imported time provenance and the normalized byte budget", () => {
  const state = {
    nativeId: "device-1",
    nativeInstanceId: "entity-1",
    attrs: { state: "on" },
    time: { sourceTs: "2026-08-20T00:10:00.000Z", sourceTsQuality: "platform" as const },
    origin: "imported" as const,
  };
  assert.equal(HistoryRecordSchema.safeParse({ historySeq: 1, state }).success, true);
  assert.equal(HistoryRecordSchema.safeParse({
    historySeq: 1,
    state: { ...state, time: { sourceTsQuality: "none" } },
  }).success, true);
  assert.equal(HistoryRecordSchema.safeParse({
    historySeq: 1,
    state: { ...state, time: { sourceTs: "2026-08-20T00:10:00.000Z", sourceTsQuality: "none" } },
  }).success, false);
  assert.equal(HistoryRecordSchema.safeParse({
    historySeq: 1,
    state: { ...state, time: { sourceTsQuality: "platform" } },
  }).success, false);
  assert.equal(HistoryRecordSchema.safeParse({
    historySeq: 1,
    state: { ...state, time: { sourceTs: "2026-08-20T00:10:00.000+08:00", sourceTsQuality: "platform" } },
  }).success, false);
  assert.equal(HistoryRecordSchema.safeParse({
    historySeq: 1,
    state: { ...state, time: { sourceTs: "2026-08-20T00:10:00.000Z", sourceTsQuality: "device" } },
  }).success, false);
  assert.equal(HistoryRecordSchema.safeParse({
    historySeq: 1,
    state: { ...state, attrs: { payload: "x".repeat(64 * 1024) } },
  }).success, false);
});
