import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  causalityPayloadSchema,
  type CauseRef,
} from "@hob/bridge-contract";

import {
  BridgeIngest,
  type BridgeEvent,
  type DeviceDescriptor,
  type Envelope,
  type StateEvent,
} from "./bridge-ingest.js";
import { SqliteIngestJournal } from "./ingest-journal.js";

const descriptor: DeviceDescriptor = {
  nativeId: "device-1",
  name: "Living light",
  capabilities: [{
    nativeInstanceId: "device-1:main",
    schema: "hob.light",
    schemaVersion: "1.0.0",
  }],
};

const state: StateEvent = {
  nativeId: "device-1",
  nativeInstanceId: "device-1:main",
  attrs: { state: "on" },
  time: { sourceTsQuality: "none" },
  origin: "observed",
};

function envelope(epochId: string, seq: number, event: BridgeEvent): Envelope {
  return {
    epochId,
    seq,
    event: event.kind === "sync-start" && !("remoteInstanceId" in event)
      ? { ...event, remoteInstanceId: "remote-1" } as BridgeEvent
      : event,
  };
}

function causality(refSeq: number, cause: CauseRef = { kind: "physical" }): BridgeEvent {
  return {
    kind: "ext",
    ext: "causality@1",
    payload: causalityPayloadSchema.parse({ refSeq, cause }),
  };
}

function createIngest(journal = new SqliteIngestJournal(":memory:") ): BridgeIngest {
  return new BridgeIngest({
    bridgeId: "synthetic-bridge",
    journal,
    registeredSchemas: new Set(["hob.light@1"]),
    enabledExtensions: new Set(["causality@1"]),
    extensionSchemas: new Map([["causality@1", causalityPayloadSchema]]),
    clock: () => "2026-08-25T00:00:00.000Z",
  });
}

async function seedState(ingest: BridgeIngest): Promise<void> {
  assert.equal((await ingest.ingest(envelope("epoch-1", 1, {
    kind: "sync-start",
    snapshotId: "snapshot-1",
    reason: "initial",
  }))).accepted, true);
  assert.equal((await ingest.ingest(envelope("epoch-1", 2, {
    kind: "device-upserted",
    device: descriptor,
  }))).accepted, true);
  assert.equal((await ingest.ingest(envelope("epoch-1", 3, {
    kind: "state",
    state,
  }))).accepted, true);
}

test("accepts causality only after an accepted same-epoch state and journals its cause", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = createIngest(journal);
  await seedState(ingest);

  const result = await ingest.ingest(envelope("epoch-1", 4, causality(3, {
    kind: "user",
    principalRef: "principal:abc123",
  })));

  assert.equal(result.accepted, true);
  assert.deepEqual(journal.records().at(-1)?.envelope.event, {
    kind: "ext",
    ext: "causality@1",
    payload: {
      refSeq: 3,
      cause: { kind: "user", principalRef: "principal:abc123" },
    },
  });
  assert.deepEqual(journal.watermark("synthetic-bridge"), { epochId: "epoch-1", lastSeq: 4 });
  assert.equal(journal.rejections().length, 0);
  journal.close();
});

test("rejects a non-state, distant, or cross-sync-complete reference without state or watermark pollution", async (t) => {
  await t.test("non-state reference", async () => {
    const journal = new SqliteIngestJournal(":memory:");
    const ingest = createIngest(journal);
    await seedState(ingest);

    const result = await ingest.ingest(envelope("epoch-1", 4, causality(2)));

    assert.equal(result.accepted, false);
    assert.equal(result.reason, "extension_rejected");
    assert.deepEqual(journal.watermark("synthetic-bridge"), { epochId: "epoch-1", lastSeq: 3 });
    assert.equal(journal.records().length, 3);
    assert.deepEqual(journal.rejections().at(-1), {
      bridgeId: "synthetic-bridge",
      epochId: "epoch-1",
      seq: 4,
      reason: "extension_rejected",
    });
    assert.equal((await ingest.ingest(envelope("epoch-1", 5, { kind: "heartbeat" }))).accepted, true);
    assert.deepEqual(journal.watermark("synthetic-bridge"), { epochId: "epoch-1", lastSeq: 5 });
    journal.close();
  });

  await t.test("distance beyond the bounded reference window", async () => {
    const journal = new SqliteIngestJournal(":memory:");
    const ingest = createIngest(journal);
    await seedState(ingest);
    for (let seq = 4; seq <= 35; seq += 1) {
      assert.equal((await ingest.ingest(envelope("epoch-1", seq, { kind: "heartbeat" }))).accepted, true);
    }

    const result = await ingest.ingest(envelope("epoch-1", 36, causality(3)));

    assert.equal(result.accepted, false);
    assert.equal(result.reason, "extension_rejected");
    assert.deepEqual(journal.watermark("synthetic-bridge"), { epochId: "epoch-1", lastSeq: 35 });
    assert.equal(journal.records().some((record) => record.envelope.seq === 36), false);
    journal.close();
  });

  await t.test("reference across a verified sync-complete", async () => {
    const journal = new SqliteIngestJournal(":memory:");
    const ingest = createIngest(journal);
    await seedState(ingest);
    assert.equal((await ingest.ingest(envelope("epoch-1", 4, {
      kind: "sync-complete",
      manifest: { snapshotId: "snapshot-1", deviceEnvelopeCount: 1, stateEnvelopeCount: 1 },
    }))).accepted, true);

    const result = await ingest.ingest(envelope("epoch-1", 5, causality(3)));

    assert.equal(result.accepted, false);
    assert.equal(result.reason, "extension_rejected");
    assert.deepEqual(journal.watermark("synthetic-bridge"), { epochId: "epoch-1", lastSeq: 4 });
    assert.equal(ingest.diagnostics().connectionState, "ready");
    journal.close();
  });
});

test("restores a rejected sequence fence without manufacturing a restart gap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-causality-"));
  const path = join(directory, "journal.sqlite");
  const firstJournal = new SqliteIngestJournal(path);
  const firstIngest = createIngest(firstJournal);
  await seedState(firstIngest);
  assert.equal((await firstIngest.ingest(envelope("epoch-1", 4, causality(2)))).reason, "extension_rejected");
  assert.deepEqual(firstJournal.watermark("synthetic-bridge"), { epochId: "epoch-1", lastSeq: 3 });
  firstJournal.close();

  const reopenedJournal = new SqliteIngestJournal(path);
  const reopenedIngest = createIngest(reopenedJournal);
  const persisted = reopenedJournal.watermark("synthetic-bridge");
  assert.ok(persisted);
  reopenedIngest.restoreWatermark(persisted);
  const nextEpoch = await reopenedIngest.ingest(envelope("epoch-2", 1, {
    kind: "sync-start",
    snapshotId: "snapshot-2",
    reason: "resync",
  }));
  assert.equal(nextEpoch.accepted, true);
  assert.equal(reopenedIngest.diagnostics().historyGapCount, 0);
  reopenedJournal.close();
  await rm(directory, { recursive: true, force: true });
});
