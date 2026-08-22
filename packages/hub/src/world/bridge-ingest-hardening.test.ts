import assert from "node:assert/strict";
import test from "node:test";

import { BridgeIngest, type BridgeEvent, type DeviceDescriptor, type Envelope, type StateEvent } from "./bridge-ingest.js";
import { SqliteIngestJournal } from "./ingest-journal.js";

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

function createIngest(options: Record<string, unknown> = {}) {
  return new BridgeIngest({
    bridgeId: "hardening-bridge",
    journal: new SqliteIngestJournal(":memory:"),
    registeredSchemas: new Set(["hob.light@1"]),
    clock: () => "2026-08-18T00:00:00.000Z",
    ...options,
  } as never);
}

test("rejects resource-exhausting payloads before deep schema admission and journals a bounded rejection", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  let deepValidationCalled = false;
  const ingest = new BridgeIngest({
    bridgeId: "hardening-bridge",
    journal,
    registeredSchemas: new Set(["hob.light@1"]),
    resourceBudget: {
      maxFields: 20,
      maxDepth: 8,
      maxStringLength: 32,
      maxSerializedBytes: 512,
    },
    validateEvent: () => {
      deepValidationCalled = true;
      return { ok: true };
    },
  } as never);

  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  const result = await ingest.ingest(envelope("epoch-a", 2, {
    kind: "state",
    state: { ...state("lamp", "on"), attrs: { oversized: "x".repeat(1_000) } },
  }));

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "resource_exhausted");
  assert.equal(deepValidationCalled, false);
  assert.deepEqual(journal.watermark("hardening-bridge"), { epochId: "epoch-a", lastSeq: 2 });
  assert.equal(journal.rejections()[0]?.reason, "resource_exhausted");
  assert.equal(ingest.diagnostics().droppedInvalidCount, 1);
  journal.close();
});

test("resource rejection remains bounded when the over-budget state has no native identity", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = createIngest({
    journal,
    resourceBudget: { maxFields: 8, maxDepth: 8, maxStringLength: 64, maxSerializedBytes: 512 },
  });
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  const oversized = {
    epochId: "epoch-a",
    seq: 2,
    event: { kind: "state", state: null, extra: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, index])) },
  } as never;

  const result = await ingest.ingest(oversized);

  assert.equal(result.reason, "resource_exhausted");
  assert.equal(journal.rejections()[0]?.reason, "resource_exhausted");
  journal.close();
});

test("applies structural resource limits for fields, depth, strings, and bytes", async (t) => {
  const cases = [
    {
      name: "fields",
      budget: { maxFields: 8, maxDepth: 20, maxStringLength: 1_000, maxSerializedBytes: 10_000 },
      attrs: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 },
    },
    {
      name: "depth",
      budget: { maxFields: 100, maxDepth: 3, maxStringLength: 1_000, maxSerializedBytes: 10_000 },
      attrs: { nested: { one: { two: { three: "too-deep" } } } },
    },
    {
      name: "string length",
      budget: { maxFields: 100, maxDepth: 20, maxStringLength: 12, maxSerializedBytes: 10_000 },
      attrs: { state: "01234567890123456789" },
    },
    {
      name: "serialized bytes",
      budget: { maxFields: 100, maxDepth: 20, maxStringLength: 1_000, maxSerializedBytes: 160 },
      attrs: { state: "x".repeat(100) },
    },
  ] as const;

  for (const item of cases) {
    await t.test(item.name, async () => {
      const journal = new SqliteIngestJournal(":memory:");
      const ingest = createIngest({ journal, resourceBudget: item.budget });
      await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
      const result = await ingest.ingest(envelope("epoch-a", 2, {
        kind: "state",
        state: { ...state("lamp", "on"), attrs: item.attrs },
      }));
      assert.equal(result.reason, "resource_exhausted");
      assert.equal(journal.rejections()[0]?.reason, "resource_exhausted");
      journal.close();
    });
  }
});

test("folds latest state by native identity only after sequencing and journaling, with explicit flush", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = createIngest({ journal, stateFoldWindowMs: 60_000 });
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("lamp") }));
  await ingest.ingest(envelope("epoch-a", 3, { kind: "state", state: state("lamp", "off") }));
  await ingest.ingest(envelope("epoch-a", 4, { kind: "state", state: state("lamp", "on") }));

  assert.deepEqual(journal.watermark("hardening-bridge"), { epochId: "epoch-a", lastSeq: 4 });
  assert.equal(journal.records().length, 4);
  assert.equal(ingest.world().devices.size, 0);

  (ingest as unknown as { flushStates(): void }).flushStates();
  await ingest.ingest(envelope("epoch-a", 5, {
    kind: "sync-complete",
    manifest: manifest("snap-a", 1, 2),
  }));

  assert.equal(ingest.world().devices.get("lamp")?.states.get("lamp:main")?.attrs.state, "on");
  assert.equal(ingest.diagnostics().foldedStateCount, 1);
  assert.equal(journal.historyGaps().length, 0);
  journal.close();
});

test("counts latest-wins state replacement even when the reducer is immediate", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = createIngest({ journal });
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("lamp") }));
  await ingest.ingest(envelope("epoch-a", 3, { kind: "state", state: state("lamp", "off") }));
  await ingest.ingest(envelope("epoch-a", 4, { kind: "state", state: state("lamp", "on") }));
  const complete = await ingest.ingest(envelope("epoch-a", 5, {
    kind: "sync-complete",
    manifest: manifest("snap-a", 1, 2),
  }));

  assert.equal(complete.accepted, true);
  assert.equal(ingest.diagnostics().foldedStateCount, 1);
  assert.equal(ingest.world().devices.get("lamp")?.states.get("lamp:main")?.attrs.state, "on");
  journal.close();
});

test("fold buffering snapshots the journaled state before adapter-owned objects can mutate", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = createIngest({ journal, stateFoldWindowMs: 60_000 });
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("lamp") }));
  const observed = state("lamp", "off");
  await ingest.ingest(envelope("epoch-a", 3, { kind: "state", state: observed }));
  observed.attrs.state = "mutated-after-ingest";
  await ingest.ingest(envelope("epoch-a", 4, {
    kind: "sync-complete",
    manifest: manifest("snap-a", 1, 1),
  }));

  assert.equal(ingest.world().devices.get("lamp")?.states.get("lamp:main")?.attrs.state, "off");
  journal.close();
});

test("journal quota conflicts with minimum retention fail closed and leave a bounded gap diagnostic", async () => {
  const journal = new SqliteIngestJournal(":memory:", {
    maxBytes: 200,
    minimumRetainedRecords: 1,
  } as never);
  const ingest = createIngest({ journal });
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  const result = await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("lamp") }));

  assert.equal(result.reason, "resource_exhausted");
  assert.equal(["paused", "quarantined"].includes(ingest.diagnostics().connectionState), true);
  assert.equal(ingest.diagnostics().historyGapCount, 1);
  assert.equal(journal.historyGaps()[0]?.reason, "journal_quota_retention_conflict");
  journal.close();
});

test("a paused bridge does not create or validate a replacement epoch until capacity is restored", async () => {
  const journal = new SqliteIngestJournal(":memory:", {
    maxBytes: 200,
    minimumRetainedRecords: 1,
  } as never);
  let identityChecks = 0;
  const ingest = createIngest({
    journal,
    validateRemoteInstanceId: () => {
      identityChecks += 1;
      return true;
    },
  });
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("lamp") }));
  const checksBefore = identityChecks;
  const replacement = await ingest.ingest(envelope("epoch-b", 1, { kind: "sync-start", snapshotId: "snap-b", reason: "resync" }));

  assert.equal(replacement.reason, "resource_exhausted");
  assert.equal(identityChecks, checksBefore);
  assert.equal(journal.records().some((record) => record.envelope.epochId === "epoch-b"), false);
  journal.close();
});
