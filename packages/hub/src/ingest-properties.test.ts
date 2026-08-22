import assert from "node:assert/strict";
import test from "node:test";

import { BridgeIngest, type BridgeEvent, type DeviceDescriptor, type Envelope, type StateEvent } from "./bridge/bridge-ingest.js";
import { JournalCapacityError, SqliteIngestJournal } from "./ingest-journal.js";

const descriptor = (nativeId: string): DeviceDescriptor => ({
  nativeId,
  name: nativeId,
  capabilities: [{ nativeInstanceId: `${nativeId}:main`, schema: "hob.light", schemaVersion: "1.0.0" }],
});

const state = (nativeId: string, value: string): StateEvent => ({
  nativeId,
  nativeInstanceId: `${nativeId}:main`,
  attrs: { state: value },
  time: { sourceTsQuality: "none" },
  origin: "observed",
});

const envelope = (epochId: string, seq: number, event: BridgeEvent): Envelope => ({
  epochId,
  seq,
  event: event.kind === "sync-start" && !("remoteInstanceId" in event)
    ? { ...event, remoteInstanceId: "remote-a" } as BridgeEvent
    : event,
});

const manifest = (snapshotId: string, deviceEnvelopeCount: number, stateEnvelopeCount: number) => ({
  snapshotId,
  deviceEnvelopeCount,
  stateEnvelopeCount,
});

function makeIngest(journal: SqliteIngestJournal) {
  return new BridgeIngest({
    bridgeId: "property-bridge",
    journal,
    registeredSchemas: new Set(["hob.light@1"]),
    clock: () => "2026-08-18T00:00:00.000Z",
  });
}

function worldDigest(ingest: BridgeIngest): unknown {
  return [...ingest.world().snapshot()].map(([nativeId, device]) => ({
    nativeId,
    validity: device.validity,
    descriptor: device.descriptor,
    states: [...device.states].map(([instanceId, current]) => ({ instanceId, attrs: current.attrs })),
  }));
}

function nextRandom(seed: { value: number }): number {
  seed.value = (seed.value * 1_103_515_245 + 12_345) & 0x7fffffff;
  return seed.value / 0x80000000;
}

test("at-least-once duplicate delivery is observationally invariant", async () => {
  const uniqueJournal = new SqliteIngestJournal(":memory:");
  const duplicateJournal = new SqliteIngestJournal(":memory:");
  const unique = makeIngest(uniqueJournal);
  const duplicate = makeIngest(duplicateJournal);
  const events = [
    envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }),
    envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("lamp") }),
    envelope("epoch-a", 3, { kind: "state", state: state("lamp", "off") }),
    envelope("epoch-a", 4, { kind: "state", state: state("lamp", "on") }),
    envelope("epoch-a", 5, { kind: "sync-complete", manifest: manifest("snap-a", 1, 2) }),
  ];
  const seed = { value: 7 };
  for (const event of events) {
    await unique.ingest(event);
    await duplicate.ingest(event);
    if (nextRandom(seed) > 0.25) await duplicate.ingest(event);
  }

  assert.deepEqual(worldDigest(duplicate), worldDigest(unique));
  assert.equal(duplicateJournal.records().length, uniqueJournal.records().length);
  assert.deepEqual(duplicateJournal.watermark("property-bridge"), { epochId: "epoch-a", lastSeq: 5 });
  uniqueJournal.close();
  duplicateJournal.close();
});

test("alternating epochs keep only the newest consistent shadow and drop old events", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = makeIngest(journal);
  const complete = async (epochId: string, snapshotId: string, value: string) => {
    await ingest.ingest(envelope(epochId, 1, { kind: "sync-start", snapshotId, reason: "resync" }));
    await ingest.ingest(envelope(epochId, 2, { kind: "device-upserted", device: descriptor("lamp") }));
    await ingest.ingest(envelope(epochId, 3, { kind: "state", state: state("lamp", value) }));
    return ingest.ingest(envelope(epochId, 4, { kind: "sync-complete", manifest: manifest(snapshotId, 1, 1) }));
  };

  assert.equal((await complete("epoch-a", "snap-a", "a")).accepted, true);
  assert.equal((await complete("epoch-b", "snap-b", "b")).accepted, true);
  const stale = await ingest.ingest(envelope("epoch-a", 5, { kind: "state", state: state("lamp", "stale") }));

  assert.equal(stale.accepted, false);
  assert.equal(ingest.world().devices.get("lamp")?.states.get("lamp:main")?.attrs.state, "b");
  assert.deepEqual(journal.watermark("property-bridge"), { epochId: "epoch-b", lastSeq: 4 });
  journal.close();
});

test("manifest failure never exchanges the shadow into the last consistent world", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = makeIngest(journal);
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("lamp") }));
  await ingest.ingest(envelope("epoch-a", 3, { kind: "state", state: state("lamp", "stable") }));
  await ingest.ingest(envelope("epoch-a", 4, { kind: "sync-complete", manifest: manifest("snap-a", 1, 1) }));

  await ingest.ingest(envelope("epoch-b", 1, { kind: "sync-start", snapshotId: "snap-b", reason: "resync" }));
  await ingest.ingest(envelope("epoch-b", 2, { kind: "device-upserted", device: descriptor("new-lamp") }));
  const mismatch = await ingest.ingest(envelope("epoch-b", 3, { kind: "sync-complete", manifest: manifest("snap-b", 9, 0) }));

  assert.equal(mismatch.reason, "manifest_mismatch");
  assert.equal(ingest.world().devices.has("new-lamp"), false);
  assert.equal(ingest.world().devices.get("lamp")?.states.get("lamp:main")?.attrs.state, "stable");
  journal.close();
});

test("quota rejection keeps the journal and watermark atomic", () => {
  const journal = new SqliteIngestJournal(":memory:", { maxBytes: 200 });
  const start = envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" });
  journal.appendAtomic({ bridgeId: "property-bridge", receivedAt: "2026-08-18T00:00:00.000Z", envelope: start });
  const oversized = envelope("epoch-a", 2, { kind: "state", state: { ...state("lamp", "on"), attrs: { value: "x".repeat(1_000) } } });

  assert.throws(
    () => journal.appendAtomic({ bridgeId: "property-bridge", receivedAt: "2026-08-18T00:00:00.000Z", envelope: oversized }),
    JournalCapacityError,
  );
  assert.equal(journal.records().length, 1);
  assert.deepEqual(journal.watermark("property-bridge"), { epochId: "epoch-a", lastSeq: 1 });
  journal.close();
});

test("an injected watermark failure rolls back the event and watermark as one SQLite transaction", () => {
  const journal = new SqliteIngestJournal(":memory:", { maxBytes: 188 });
  const start = envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" });
  journal.appendAtomic({ bridgeId: "property-bridge", receivedAt: "2026-08-18T00:00:00.000Z", envelope: start });
  const database = (journal as unknown as { db: { exec(sql: string): void } }).db;
  database.exec("CREATE TRIGGER injected_watermark_failure BEFORE UPDATE ON ingest_watermarks BEGIN SELECT RAISE(ABORT, 'injected crash'); END;");

  assert.throws(() => journal.appendAtomic({
    bridgeId: "property-bridge",
    receivedAt: "2026-08-18T00:00:00.000Z",
    envelope: envelope("epoch-a", 2, { kind: "heartbeat" }),
  }));
  assert.equal(journal.records().length, 1);
  assert.deepEqual(journal.watermark("property-bridge"), { epochId: "epoch-a", lastSeq: 1 });
  assert.doesNotThrow(() => journal.assertWithinQuota());
  journal.close();
});

test("legal unique events under normal capacity are all durable", async () => {
  const journal = new SqliteIngestJournal(":memory:", { maxBytes: 1_000_000 });
  const ingest = makeIngest(journal);
  const count = 12;
  const seed = { value: 17 };
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  for (let index = 0; index < count; index += 1) {
    const id = `lamp-${index}`;
    await ingest.ingest(envelope("epoch-a", index * 2 + 2, { kind: "device-upserted", device: descriptor(id) }));
    const value = nextRandom(seed) > 0.5 ? "on" : "off";
    await ingest.ingest(envelope("epoch-a", index * 2 + 3, { kind: "state", state: state(id, value) }));
  }
  const complete = await ingest.ingest(envelope("epoch-a", count * 2 + 2, {
    kind: "sync-complete",
    manifest: manifest("snap-a", count, count),
  }));

  assert.equal(complete.accepted, true);
  assert.equal(journal.records().length, count * 2 + 2);
  assert.deepEqual(journal.watermark("property-bridge"), { epochId: "epoch-a", lastSeq: count * 2 + 2 });
  assert.equal(ingest.world().devices.size, count);
  journal.close();
});
