import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeEvent, Envelope } from "../../../contracts/bridge-contract.js";
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
