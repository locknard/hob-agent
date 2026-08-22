import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeEvent, Envelope } from "@hob/bridge-contract";
import { SqliteIngestJournal } from "./ingest-journal.js";

function append(
  journal: SqliteIngestJournal,
  seq: number,
  receivedAt: string,
  event: BridgeEvent,
): void {
  const envelope: Envelope = { epochId: "epoch-a", seq, event };
  journal.appendAtomic({ bridgeId: "bridge-a", receivedAt, envelope });
}

test("queries only bounded selected live state records after a consistent watermark", () => {
  const journal = new SqliteIngestJournal(":memory:");
  append(journal, 1, "2026-08-19T00:00:00.000Z", {
    kind: "state",
    state: {
      nativeId: "lamp",
      nativeInstanceId: "power",
      attrs: { state: "off" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  });
  journal.markConsistent("bridge-a", { epochId: "epoch-a", lastSeq: 1 });
  append(journal, 2, "2026-08-19T01:00:00.000Z", {
    kind: "state",
    state: {
      nativeId: "other",
      nativeInstanceId: "power",
      attrs: { state: "on" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  });
  append(journal, 3, "2026-08-19T02:00:00.000Z", {
    kind: "state",
    state: {
      nativeId: "lamp",
      nativeInstanceId: "power",
      attrs: { state: "on" },
      time: { sourceTs: "2026-08-19T01:59:59.000Z", sourceTsQuality: "platform" },
      origin: "observed",
    },
  });
  append(journal, 4, "2026-08-19T03:00:00.000Z", {
    kind: "state",
    state: {
      nativeId: "lamp",
      nativeInstanceId: "power",
      attrs: { state: "off" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  });

  const page = journal.queryLiveStateRecords({
    bridgeId: "bridge-a",
    epochId: "epoch-a",
    afterSeq: 1,
    since: "2026-08-19T00:30:00.000Z",
    until: "2026-08-19T04:00:00.000Z",
    bindings: [{ nativeId: "lamp", nativeInstanceId: "power" }],
    limit: 1,
  });

  assert.equal(page.truncated, true);
  assert.deepEqual(page.records.map((record) => record.envelope.seq), [4]);
  assert.equal(page.records[0]?.envelope.event.kind, "state");
  journal.close();
});

test("rejects an unbounded or malformed live-state query", () => {
  const journal = new SqliteIngestJournal(":memory:");
  assert.throws(() => journal.queryLiveStateRecords({
    bridgeId: "bridge-a",
    epochId: "epoch-a",
    afterSeq: 0,
    since: "not-a-time",
    until: "2026-08-19T04:00:00.000Z",
    bindings: [],
    limit: 10_000,
  }));
  journal.close();
});

test("reports aggregate logical capacity without exposing journal contents", () => {
  const journal = new SqliteIngestJournal(":memory:", { maxBytes: 4_096 });
  append(journal, 1, "2026-08-19T00:00:00.000Z", {
    kind: "state",
    state: {
      nativeId: "private-device",
      nativeInstanceId: "private-capability",
      attrs: { state: "private-value" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  });

  const capacity = journal.capacity();

  assert.equal(capacity.maxBytes, 4_096);
  assert.equal(capacity.usedBytes > 0, true);
  assert.equal(capacity.remainingBytes, capacity.maxBytes - capacity.usedBytes);
  assert.deepEqual(Object.keys(capacity).sort(), ["maxBytes", "remainingBytes", "usedBytes"]);
  assert.equal(JSON.stringify(capacity).includes("private"), false);
  journal.close();
});

test("default quota covers the measured seven-day household evidence rate", () => {
  const journal = new SqliteIngestJournal(":memory:");
  assert.equal(journal.capacity().maxBytes, 256 * 1024 * 1024);
  journal.close();
});

test("aggregates bounded post-baseline state activity without returning values", () => {
  const journal = new SqliteIngestJournal(":memory:");
  append(journal, 1, "2026-08-19T00:00:00.000Z", {
    kind: "state",
    state: {
      nativeId: "baseline-lamp",
      nativeInstanceId: "power",
      attrs: { state: "secret-baseline" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  });
  journal.markConsistent("bridge-a", { epochId: "epoch-a", lastSeq: 1 });
  for (const [seq, nativeId, receivedAt] of [
    [2, "lamp", "2026-08-19T01:00:00.000Z"],
    [3, "sensor", "2026-08-19T02:00:00.000Z"],
    [4, "lamp", "2026-08-19T03:00:00.000Z"],
  ] as const) {
    append(journal, seq, receivedAt, {
      kind: "state",
      state: {
        nativeId,
        nativeInstanceId: "main",
        attrs: { state: `secret-${seq}` },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    });
  }

  const page = journal.queryLiveStateActivity({
    bridgeId: "bridge-a",
    epochId: "epoch-a",
    afterSeq: 1,
    since: "2026-08-19T00:30:00.000Z",
    until: "2026-08-19T04:00:00.000Z",
    limit: 1,
  });

  assert.deepEqual(page.activity, [{
    nativeId: "lamp",
    nativeInstanceIds: ["main"],
    eventCount: 2,
    latestObservedAt: "2026-08-19T03:00:00.000Z",
  }]);
  assert.equal(page.truncated, true);
  assert.equal(JSON.stringify(page).includes("secret"), false);
  assert.throws(() => journal.queryLiveStateActivity({
    bridgeId: "bridge-a",
    epochId: "epoch-a",
    afterSeq: 1,
    since: "not-a-time",
    until: "2026-08-19T04:00:00.000Z",
    limit: 51,
  }));
  journal.close();
});

test("activity limits native devices rather than truncating their active capabilities", () => {
  const journal = new SqliteIngestJournal(":memory:");
  append(journal, 1, "2026-08-19T00:00:00.000Z", {
    kind: "state",
    state: {
      nativeId: "device",
      nativeInstanceId: "baseline",
      attrs: { state: "baseline" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  });
  journal.markConsistent("bridge-a", { epochId: "epoch-a", lastSeq: 1 });
  for (const [seq, nativeInstanceId] of [[2, "power"], [3, "brightness"]] as const) {
    append(journal, seq, `2026-08-19T0${seq}:00:00.000Z`, {
      kind: "state",
      state: {
        nativeId: "device",
        nativeInstanceId,
        attrs: { state: `private-${seq}` },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    });
  }

  const page = journal.queryLiveStateActivity({
    bridgeId: "bridge-a",
    epochId: "epoch-a",
    afterSeq: 1,
    since: "2026-08-19T00:30:00.000Z",
    until: "2026-08-19T04:00:00.000Z",
    limit: 1,
  });

  assert.deepEqual(page.activity, [{
    nativeId: "device",
    nativeInstanceIds: ["brightness", "power"],
    eventCount: 2,
    latestObservedAt: "2026-08-19T03:00:00.000Z",
  }]);
  assert.equal(page.truncated, false);
  assert.equal(JSON.stringify(page).includes("private"), false);
  journal.close();
});
