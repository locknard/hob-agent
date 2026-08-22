import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { IngestRecord } from "@hob/bridge-contract";
import {
  WorldModelIndex,
  WorldModelIndexError,
  type WorldModelConsistentBatch,
} from "./world-model-index.js";

const bridgeId = "bridge-world";

function record(
  seq: number,
  event: IngestRecord["envelope"]["event"],
  receivedAt: string,
  epochId = "epoch-a",
): IngestRecord {
  return {
    bridgeId,
    receivedAt,
    envelope: { epochId, seq, event },
  };
}

function completeBatch(overrides: Partial<WorldModelConsistentBatch> = {}): WorldModelConsistentBatch {
  const records: IngestRecord[] = [
    record(1, {
      kind: "sync-start",
      snapshotId: "snapshot-a",
      remoteInstanceId: "remote-a",
      reason: "initial",
    }, "2026-08-18T00:00:00.000Z"),
    record(2, {
      kind: "device-upserted",
      device: {
        nativeId: "lamp",
        name: "Living lamp",
        capabilities: [{ nativeInstanceId: "entity-1", schema: "hob.light", schemaVersion: "1.0.0" }],
      },
    }, "2026-08-18T00:01:00.000Z"),
    record(3, {
      kind: "state",
      state: {
        nativeId: "lamp",
        nativeInstanceId: "entity-1",
        attrs: { state: "on", temperature: 18 },
        time: { sourceTs: "2026-08-18T00:01:00.000Z", sourceTsQuality: "device" },
        origin: "observed",
      },
    }, "2026-08-18T00:01:00.000Z"),
    record(4, {
      kind: "state",
      state: {
        nativeId: "lamp",
        nativeInstanceId: "entity-1",
        attrs: { state: "off", temperature: 20 },
        time: { sourceTs: "2026-08-18T00:02:00.000Z", sourceTsQuality: "device" },
        origin: "observed",
      },
    }, "2026-08-18T00:02:00.000Z"),
    record(5, {
      kind: "sync-complete",
      manifest: { snapshotId: "snapshot-a", deviceEnvelopeCount: 1, stateEnvelopeCount: 2 },
    }, "2026-08-18T00:02:00.000Z"),
  ];
  return {
    bridgeId,
    records,
    consistentWatermark: { epochId: "epoch-a", lastSeq: 5 },
    ...overrides,
  };
}

test("indexes only a manifest-verified canonical sync-complete batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-world-index-"));
  const index = new WorldModelIndex({ path: join(directory, "world.sqlite") });

  assert.throws(
    () => index.applyConsistentBatch({
      ...completeBatch(),
      records: completeBatch().records.slice(0, -1),
    }),
    (error: unknown) => error instanceof WorldModelIndexError && error.code === "inconsistent_snapshot",
  );
  assert.equal(index.rawJournalRecords().length, 0);

  index.applyConsistentBatch(completeBatch());
  assert.deepEqual(index.consistentWatermark(bridgeId), { epochId: "epoch-a", lastSeq: 5 });
  assert.equal(index.devices(bridgeId).length, 1);
  index.close();
  await rm(directory, { recursive: true, force: true });
});

test("materializes a trusted ingest cut when rejected envelopes are absent from canonical records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-world-index-"));
  const index = new WorldModelIndex({ path: join(directory, "world.sqlite") });
  const batch = completeBatch();

  index.applyConsistentBatch({
    ...batch,
    records: batch.records.filter((item) => item.envelope.event.kind !== "state"),
    allowRejectedEvents: true,
  });

  assert.deepEqual(index.consistentWatermark(bridgeId), { epochId: "epoch-a", lastSeq: 5 });
  assert.equal(index.latestStates({ bridgeId }).length, 0);
  assert.equal(index.rawJournalRecords(bridgeId).length, 3);
  index.close();
  await rm(directory, { recursive: true, force: true });
});

test("retains a prior device as present-but-invalid when the consistent cut has rejected presence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-world-index-"));
  const index = new WorldModelIndex({ path: join(directory, "world.sqlite") });
  const prior = completeBatch();
  index.applyConsistentBatch(prior);

  index.applyConsistentBatch({
    bridgeId,
    records: [
      record(1, {
        kind: "sync-start",
        snapshotId: "snapshot-b",
        remoteInstanceId: "remote-a",
        reason: "resync",
      }, "2026-08-18T00:03:00.000Z", "epoch-b"),
      record(2, {
        kind: "sync-complete",
        manifest: { snapshotId: "snapshot-b", deviceEnvelopeCount: 1, stateEnvelopeCount: 0 },
      }, "2026-08-18T00:03:01.000Z", "epoch-b"),
    ],
    consistentWatermark: { epochId: "epoch-b", lastSeq: 2 },
    allowRejectedEvents: true,
    rejectedNativeIds: ["lamp"],
  } as WorldModelConsistentBatch);

  const device = index.devices(bridgeId)[0];
  assert.equal(device?.nativeId, "lamp");
  assert.equal(device?.validity, "present-but-invalid");
  index.close();
  await rm(directory, { recursive: true, force: true });
});

test("stores canonical descriptors and latest state with numeric time-bucket aggregates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-world-index-"));
  const index = new WorldModelIndex({ path: join(directory, "world.sqlite"), bucketMs: 60 * 60 * 1_000 });

  index.applyConsistentBatch(completeBatch());

  assert.deepEqual(index.latestState(bridgeId, "lamp", "entity-1"), {
    bridgeId,
    nativeId: "lamp",
    nativeInstanceId: "entity-1",
    attrs: { state: "off", temperature: 20 },
    sourceTs: "2026-08-18T00:02:00.000Z",
    sourceTsQuality: "device",
    origin: "observed",
    receivedAt: "2026-08-18T00:02:00.000Z",
    epochId: "epoch-a",
    seq: 4,
    freshness: "fresh",
  });
  assert.deepEqual(index.numericAggregates({ bridgeId, nativeId: "lamp", nativeInstanceId: "entity-1" }), [{
    bridgeId,
    nativeId: "lamp",
    nativeInstanceId: "entity-1",
    attribute: "temperature",
    bucketStart: "2026-08-18T00:00:00.000Z",
    count: 2,
    last: 20,
    min: 18,
    max: 20,
    freshness: "fresh",
  }]);

  index.close();
  await rm(directory, { recursive: true, force: true });
});

test("marks indexed values stale across a supplied history gap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-world-index-"));
  const index = new WorldModelIndex({ path: join(directory, "world.sqlite") });

  index.applyConsistentBatch(completeBatch({
    gaps: [{ bridgeId, epochId: "epoch-a", fromSeq: 3, toSeq: 3, reason: "sequence_gap" }],
  }));

  assert.equal(index.freshness(bridgeId), "stale-gap");
  assert.equal(index.latestState(bridgeId, "lamp", "entity-1")?.freshness, "stale-gap");
  assert.equal(index.numericAggregates({ bridgeId })[0]?.freshness, "stale-gap");

  index.close();
  await rm(directory, { recursive: true, force: true });
});

test("rejects native Home Assistant-shaped data before it can enter the index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-world-index-"));
  const path = join(directory, "world.sqlite");
  const index = new WorldModelIndex({ path });
  const batch = completeBatch();
  const rawState = batch.records[2]!;
  const rawAttrs = (rawState.envelope.event.kind === "state" ? rawState.envelope.event.state.attrs : {}) as Record<string, unknown>;
  rawAttrs.attributes = { friendly_name: "Living room" };

  assert.throws(
    () => index.applyConsistentBatch(batch),
    (error: unknown) => error instanceof WorldModelIndexError && error.code === "native_payload_rejected",
  );
  assert.equal(index.rawJournalRecords().length, 0);
  index.close();
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await rm(directory, { recursive: true, force: true });
});

test("retention requires an explicit policy, preserves the minimum raw journal window, and audits it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-world-index-"));
  const index = new WorldModelIndex({ path: join(directory, "world.sqlite"), minimumRawRecords: 2 });
  index.applyConsistentBatch(completeBatch());

  const audit = index.applyRetention({
    policyId: "retention-1",
    mode: "delete",
    beforeReceivedAt: "2026-08-19T00:00:00.000Z",
    requestedBy: "operator",
    reason: "test retention",
  });

  assert.equal(audit.mode, "delete");
  assert.equal(audit.deletedCount, 3);
  assert.equal(audit.skippedMinimumCount, 2);
  assert.equal(index.rawJournalRecords().length, 2);
  assert.equal(index.retentionAudits().length, 1);

  index.close();
  await rm(directory, { recursive: true, force: true });
});

test("explicit retention may delete all eligible raw rows when no minimum is configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-world-index-"));
  const index = new WorldModelIndex({ path: join(directory, "world.sqlite") });
  index.applyConsistentBatch(completeBatch());

  const audit = index.applyRetention({
    policyId: "retention-all",
    mode: "delete",
    beforeReceivedAt: "2026-08-19T00:00:00.000Z",
    requestedBy: "operator",
    reason: "explicit test retention",
  });

  assert.equal(audit.deletedCount, 5);
  assert.equal(index.rawJournalRecords().length, 0);
  index.close();
  await rm(directory, { recursive: true, force: true });
});

test("explicit compression preserves rows while marking only eligible journal data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-world-index-"));
  const index = new WorldModelIndex({ path: join(directory, "world.sqlite"), minimumRawRecords: 2 });
  index.applyConsistentBatch(completeBatch());

  const audit = index.applyRetention({
    policyId: "retention-compress",
    mode: "compress",
    beforeReceivedAt: "2026-08-19T00:00:00.000Z",
    requestedBy: "operator",
    reason: "explicit test compression",
  });

  assert.equal(audit.compressedCount, 3);
  assert.deepEqual(index.rawJournalRecords().map((item) => item.compressed), [true, true, true, false, false]);
  assert.equal(index.retentionAudits()[0]?.policyId, "retention-compress");
  index.close();
  await rm(directory, { recursive: true, force: true });
});

test("reopens persisted index state without requiring the bridge runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-world-index-"));
  const path = join(directory, "world.sqlite");
  const first = new WorldModelIndex({ path });
  first.applyConsistentBatch(completeBatch());
  first.close();

  const reopened = new WorldModelIndex({ path });
  assert.equal(reopened.devices(bridgeId)[0]?.descriptor.nativeId, "lamp");
  assert.equal(reopened.latestState(bridgeId, "lamp", "entity-1")?.attrs.state, "off");
  assert.deepEqual(reopened.consistentWatermark(bridgeId), { epochId: "epoch-a", lastSeq: 5 });
  reopened.close();
  await rm(directory, { recursive: true, force: true });
});

test("rejects duplicate sync-complete markers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-world-index-"));
  const base = completeBatch().records;
  const duplicateComplete = completeBatch({
    records: [
      base[0]!,
      base[1]!,
      base[2]!,
      record(4, {
        kind: "sync-complete",
        manifest: { snapshotId: "snapshot-a", deviceEnvelopeCount: 1, stateEnvelopeCount: 2 },
      }, base[3]!.receivedAt),
      record(5, base[3]!.envelope.event, base[3]!.receivedAt),
      record(6, {
        kind: "sync-complete",
        manifest: { snapshotId: "snapshot-a", deviceEnvelopeCount: 1, stateEnvelopeCount: 2 },
      }, base[4]!.receivedAt),
    ],
    consistentWatermark: { epochId: "epoch-a", lastSeq: 6 },
  });
  const duplicateIndex = new WorldModelIndex({ path: join(directory, "duplicate.sqlite") });
  assert.throws(
    () => duplicateIndex.applyConsistentBatch(duplicateComplete),
    (error: unknown) => error instanceof WorldModelIndexError && error.code === "inconsistent_snapshot",
  );
  duplicateIndex.close();
  await rm(directory, { recursive: true, force: true });
});

test("fails closed when a committed journal sequence is replayed with a different envelope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-world-index-"));
  const index = new WorldModelIndex({ path: join(directory, "world.sqlite") });
  index.applyConsistentBatch(completeBatch());
  const base = completeBatch();
  const state = base.records[3]!.envelope.event;
  assert.equal(state.kind, "state");
  const conflicting = completeBatch({
    records: base.records.map((item) => item.envelope.seq === 4
      ? record(4, {
        kind: "state",
        state: {
          ...state.state,
          attrs: { ...state.state.attrs, temperature: 21 },
        },
      }, item.receivedAt)
      : item),
  });

  assert.throws(
    () => index.applyConsistentBatch(conflicting),
    (error: unknown) => error instanceof WorldModelIndexError && error.code === "invalid_record",
  );
  assert.deepEqual(index.consistentWatermark(bridgeId), { epochId: "epoch-a", lastSeq: 5 });
  assert.equal(index.latestState(bridgeId, "lamp", "entity-1")?.attrs.temperature, 20);
  index.close();
  await rm(directory, { recursive: true, force: true });
});
