import assert from "node:assert/strict";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BridgeIngest,
  type BridgeEvent,
  type DeviceDescriptor,
  type Envelope,
  type StateEvent,
} from "./bridge-ingest.js";
import { HOME_ASSISTANT_ADAPTER_REGISTRATION } from "./home-assistant-bridge.js";
import { SqliteIngestJournal } from "../world/ingest-journal.js";
import { SyntheticBridge } from "./synthetic-bridge.js";

const descriptor = (nativeId: string, schema = "hob.light"): DeviceDescriptor => ({
  nativeId,
  name: nativeId,
  capabilities: [{ nativeInstanceId: `${nativeId}:main`, schema, schemaVersion: "1.0.0" }],
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

function snapshotManifest(snapshotId: string, deviceEnvelopeCount: number, stateEnvelopeCount: number) {
  return { snapshotId, deviceEnvelopeCount, stateEnvelopeCount };
}

function createIngest(journal = new SqliteIngestJournal(":memory:")) {
  return new BridgeIngest({
    bridgeId: "synthetic-bridge",
    journal,
    registeredSchemas: new Set(["hob.light@1"]),
    clock: () => "2026-08-18T00:00:00.000Z",
  });
}

function createHomeAssistantSchemaIngest(journal = new SqliteIngestJournal(":memory:")) {
  const registrations = HOME_ASSISTANT_ADAPTER_REGISTRATION.capabilitySchemas;
  const registeredSchemas = new Set(registrations.map((registration) => `${registration.schema}@${registration.majorVersion}`));
  const schemaRegistrations = new Map(
    registrations.map((registration) => [`${registration.schema}@${registration.majorVersion}`, registration] as const),
  );
  return {
    ingest: new BridgeIngest({
      bridgeId: "synthetic-bridge",
      journal,
      registeredSchemas,
      schemaRegistrations,
      clock: () => "2026-08-18T00:00:00.000Z",
    }),
    registeredSchemas,
    schemaRegistrations,
    journal,
  };
}

test("routes ha.entity and ha.cover states through their own strict registrations", async () => {
  const { ingest, registeredSchemas, schemaRegistrations, journal } = createHomeAssistantSchemaIngest();
  assert.equal(registeredSchemas.has("ha.entity@1"), true);
  assert.equal(registeredSchemas.has("ha.cover@1"), true);
  assert.equal(schemaRegistrations.get("ha.entity@1")?.attrsSchema.safeParse({ state: "on" }).success, true);
  assert.equal(schemaRegistrations.get("ha.cover@1")?.attrsSchema.safeParse({ state: "open", level: 0.5 }).success, true);

  const mixedDescriptor: DeviceDescriptor = {
    nativeId: "ha-device",
    capabilities: [
      { nativeInstanceId: "generic-instance", schema: "ha.entity", schemaVersion: "1.0.0" },
      { nativeInstanceId: "cover-instance", schema: "ha.cover", schemaVersion: "1.0.0", semanticKind: "cover" },
    ],
  };
  const genericState: StateEvent = {
    nativeId: "ha-device",
    nativeInstanceId: "generic-instance",
    attrs: { state: "on", brightness: 200 },
    time: { sourceTsQuality: "none" },
    origin: "observed",
  };
  const coverState: StateEvent = {
    nativeId: "ha-device",
    nativeInstanceId: "cover-instance",
    attrs: { state: "open", level: 0.5, setLevelSupported: true },
    time: { sourceTsQuality: "none" },
    origin: "observed",
  };

  assert.equal((await ingest.ingest(envelope("epoch-ha", 1, {
    kind: "sync-start",
    snapshotId: "snapshot-ha",
    reason: "initial",
  }))).accepted, true);
  assert.equal((await ingest.ingest(envelope("epoch-ha", 2, {
    kind: "device-upserted",
    device: mixedDescriptor,
  }))).accepted, true);
  assert.equal((await ingest.ingest(envelope("epoch-ha", 3, { kind: "state", state: genericState }))).accepted, true);
  assert.equal((await ingest.ingest(envelope("epoch-ha", 4, { kind: "state", state: coverState }))).accepted, true);
  assert.equal((await ingest.ingest(envelope("epoch-ha", 5, {
    kind: "sync-complete",
    manifest: snapshotManifest("snapshot-ha", 1, 2),
  }))).accepted, true);

  const invalidGeneric = await ingest.ingest(envelope("epoch-ha", 6, {
    kind: "state",
    state: { ...genericState, attrs: { state: "on", level: 0.5 } },
  }));
  const invalidCover = await ingest.ingest(envelope("epoch-ha", 7, {
    kind: "state",
    state: { ...coverState, attrs: { state: "open", level: "0.5" } },
  }));
  assert.equal(invalidGeneric.accepted, false);
  assert.equal(invalidGeneric.reason, "invalid_payload");
  assert.equal(invalidCover.accepted, false);
  assert.equal(invalidCover.reason, "invalid_payload");
  assert.deepEqual(ingest.world().devices.get("ha-device")?.states.get("generic-instance")?.attrs, {
    state: "on",
    brightness: 200,
  });
  assert.deepEqual(ingest.world().devices.get("ha-device")?.states.get("cover-instance")?.attrs, {
    state: "open",
    level: 0.5,
    setLevelSupported: true,
  });
  journal.close();
});

test("restores a complete legacy ha.entity epoch after ha.cover registration is added", async () => {
  const first = createHomeAssistantSchemaIngest();
  const legacyDescriptor: DeviceDescriptor = {
    nativeId: "legacy-device",
    capabilities: [{ nativeInstanceId: "legacy-instance", schema: "ha.entity", schemaVersion: "1.0.0" }],
  };
  const legacyState: StateEvent = {
    nativeId: "legacy-device",
    nativeInstanceId: "legacy-instance",
    attrs: { state: "on", brightness: 128 },
    time: { sourceTsQuality: "none" },
    origin: "observed",
  };
  await first.ingest.ingest(envelope("legacy-epoch", 1, {
    kind: "sync-start",
    snapshotId: "legacy-snapshot",
    reason: "initial",
  }));
  await first.ingest.ingest(envelope("legacy-epoch", 2, {
    kind: "device-upserted",
    device: legacyDescriptor,
  }));
  await first.ingest.ingest(envelope("legacy-epoch", 3, { kind: "state", state: legacyState }));
  const complete = await first.ingest.ingest(envelope("legacy-epoch", 4, {
    kind: "sync-complete",
    manifest: snapshotManifest("legacy-snapshot", 1, 1),
  }));
  assert.equal(complete.accepted, true);
  const watermark = first.journal.consistentWatermark?.("synthetic-bridge");
  assert.deepEqual(watermark, { epochId: "legacy-epoch", lastSeq: 4 });

  const second = createHomeAssistantSchemaIngest();
  assert.equal(await second.ingest.restoreConsistent(first.journal.records(), watermark!), true);
  const restored = second.ingest.world().devices.get("legacy-device");
  assert.equal(restored?.validity, "valid");
  assert.equal(restored?.descriptor.capabilities[0]?.schema, "ha.entity");
  assert.deepEqual(restored?.states.get("legacy-instance")?.attrs, {
    state: "on",
    brightness: 128,
  });
  first.journal.close();
  second.journal.close();
});

test("requires sync-start seq=1 and rejects an epoch that starts at another sequence", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = createIngest(journal);

  const result = await ingest.ingest(envelope("epoch-a", 2, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));

  assert.equal(result.accepted, false);
  assert.equal(ingest.diagnostics().protocolViolationCount, 1);
  assert.equal(journal.watermark("synthetic-bridge")?.lastSeq, undefined);
  journal.close();
});

test("rejects a remote identity change before journaling a new epoch", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = new BridgeIngest({ bridgeId: "synthetic-bridge", journal, remoteInstanceId: "remote-a" });
  const start = envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" });
  const mismatched = envelope("epoch-b", 1, { kind: "sync-start", snapshotId: "snap-b", reason: "resync", remoteInstanceId: "remote-b" } as BridgeEvent);

  assert.equal((await ingest.ingest(start)).accepted, true);
  const result = await ingest.ingest(mismatched);

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "remote_identity_mismatch");
  assert.equal(result.fatal, true);
  assert.equal(ingest.diagnostics().connectionState, "quarantined");
  assert.equal(journal.records().some((record) => record.envelope.epochId === "epoch-b"), false);
  journal.close();
});

test("contains a failed resync request after a sequence gap", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = new BridgeIngest({
    bridgeId: "synthetic-bridge",
    journal,
    control: {
      requestResync: async () => {
        throw new Error("resync failed");
      },
      dispose: async () => undefined,
    },
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    assert.equal((await ingest.ingest(envelope("epoch-gap", 1, {
      kind: "sync-start",
      snapshotId: "snap-gap",
      reason: "initial",
    }))).accepted, true);
    const result = await ingest.ingest(envelope("epoch-gap", 3, { kind: "heartbeat" }));
    assert.equal(result.reason, "sequence_gap");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    journal.close();
  }
});

test("rejects sync-complete and repeated sync-start lifecycle violations without throwing", async () => {
  const ingest = createIngest();
  const first = await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-complete", manifest: snapshotManifest("snap-a", 0, 0) }));
  const start = await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  const repeated = await ingest.ingest(envelope("epoch-a", 2, { kind: "sync-start", snapshotId: "snap-a", reason: "resume" }));

  assert.equal(first.reason, "protocol_error");
  assert.equal(start.accepted, true);
  assert.equal(repeated.reason, "protocol_error");
  assert.equal(ingest.diagnostics().protocolViolationCount, 2);
});

test("atomically journals legal events and advances the epoch watermark", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = createIngest(journal);

  assert.equal((await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }))).accepted, true);
  assert.equal((await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("lamp") }))).accepted, true);
  assert.equal((await ingest.ingest(envelope("epoch-a", 3, { kind: "state", state: state("lamp", "on") }))).accepted, true);

  assert.equal(journal.records().length, 3);
  assert.deepEqual(journal.watermark("synthetic-bridge"), { epochId: "epoch-a", lastSeq: 3 });
  assert.equal(ingest.diagnostics().lastSuccessfulContactAt, "2026-08-18T00:00:00.000Z");
  journal.close();
});

test("persists only verified sync-complete as the restart-consistent watermark", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = createIngest(journal);
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("lamp") }));
  await ingest.ingest(envelope("epoch-a", 3, { kind: "state", state: state("lamp", "on") }));
  const complete = await ingest.ingest(envelope("epoch-a", 4, {
    kind: "sync-complete",
    manifest: snapshotManifest("snap-a", 1, 1),
  }));

  assert.equal(complete.accepted, true);
  assert.deepEqual(journal.consistentWatermark?.("synthetic-bridge"), { epochId: "epoch-a", lastSeq: 4 });
  journal.close();
});

test("requires a fresh sync-start after restoring a persisted sequence fence", async () => {
  const ingest = createIngest();
  ingest.restoreWatermark({ epochId: "epoch-a", lastSeq: 1 });

  const staleContinuation = await ingest.ingest(envelope("epoch-a", 2, {
    kind: "device-upserted",
    device: descriptor("stale-lamp"),
  }));

  assert.equal(staleContinuation.accepted, false);
  assert.equal(staleContinuation.reason, "protocol_error");
  assert.equal(ingest.world().devices.has("stale-lamp"), false);
});

test("counts a successful control response as bridge contact for heartbeat liveness", async () => {
  let now = 100;
  const ingest = new BridgeIngest({
    bridgeId: "synthetic-bridge",
    journal: new SqliteIngestJournal(":memory:"),
    control: {
      requestResync: async () => ({ status: "completed" }),
      dispose: async () => undefined,
    },
    nowMs: () => now,
    clock: () => "2026-08-18T00:00:00.000Z",
    heartbeatIntervalMs: 10,
  });

  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.requestResync();
  now = 120;
  assert.equal(ingest.checkTimeouts().heartbeatDown, false);
  assert.equal(ingest.diagnostics().lastSuccessfulContactAt, "2026-08-18T00:00:00.000Z");
});

test("duplicate sequence numbers are dropped without changing replay manifest counts", async () => {
  const ingest = createIngest();

  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("lamp") }));
  const duplicate = await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("other") }));
  await ingest.ingest(envelope("epoch-a", 3, { kind: "state", state: state("lamp", "on") }));
  const complete = await ingest.ingest(envelope("epoch-a", 4, {
    kind: "sync-complete",
    manifest: snapshotManifest("snap-a", 1, 1),
  }));

  assert.equal(duplicate.duplicate, true);
  assert.equal(complete.accepted, true);
  assert.equal(ingest.world().devices.get("lamp")?.descriptor.nativeId, "lamp");
  assert.equal(ingest.world().devices.has("other"), false);
});

test("does not allow device-removed during replay and preserves the previous consistent view", async () => {
  const ingest = createIngest();
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("lamp") }));
  await ingest.ingest(envelope("epoch-a", 3, { kind: "state", state: state("lamp", "on") }));
  await ingest.ingest(envelope("epoch-a", 4, { kind: "sync-complete", manifest: snapshotManifest("snap-a", 1, 1) }));

  await ingest.ingest(envelope("epoch-b", 1, { kind: "sync-start", snapshotId: "snap-b", reason: "resync" }));
  const removed = await ingest.ingest(envelope("epoch-b", 2, { kind: "device-removed", nativeId: "lamp" }));
  const complete = await ingest.ingest(envelope("epoch-b", 3, { kind: "sync-complete", manifest: snapshotManifest("snap-b", 0, 0) }));

  assert.equal(removed.accepted, false);
  assert.equal(complete.accepted, true);
  assert.equal(ingest.world().devices.has("lamp"), false);
  assert.equal(ingest.diagnostics().protocolViolationCount, 1);
});

test("freezes the watermark after a sequence gap and records a bounded diagnostic sample", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = new BridgeIngest({
    bridgeId: "synthetic-bridge",
    journal,
    diagnosticSampleLimit: 2,
    registeredSchemas: new Set(["hob.light@1"]),
  });
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  const gap = await ingest.ingest(envelope("epoch-a", 3, { kind: "heartbeat" }));
  await ingest.ingest(envelope("epoch-a", 4, { kind: "heartbeat" }));
  await ingest.ingest(envelope("epoch-a", 5, { kind: "heartbeat" }));

  assert.equal(gap.broken, true);
  assert.equal(journal.watermark("synthetic-bridge")?.lastSeq, 1);
  assert.equal(ingest.diagnostics().historyGapCount, 1);
  assert.equal(ingest.diagnosticSamples().length, 2);
  journal.close();
});

test("keeps invalid descriptor presence so a resync cannot misclassify it as removed", async () => {
  const ingest = createIngest();
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("lamp") }));
  await ingest.ingest(envelope("epoch-a", 3, { kind: "state", state: state("lamp", "on") }));
  await ingest.ingest(envelope("epoch-a", 4, { kind: "sync-complete", manifest: snapshotManifest("snap-a", 1, 1) }));

  await ingest.ingest(envelope("epoch-b", 1, { kind: "sync-start", snapshotId: "snap-b", reason: "resync" }));
  await ingest.ingest(envelope("epoch-b", 2, { kind: "device-upserted", device: { nativeId: "lamp", capabilities: [] } }));
  const complete = await ingest.ingest(envelope("epoch-b", 3, { kind: "sync-complete", manifest: snapshotManifest("snap-b", 1, 0) }));

  assert.equal(complete.accepted, true);
  assert.equal(ingest.world().devices.get("lamp")?.validity, "present-but-invalid");
  assert.equal(ingest.world().devices.get("lamp")?.descriptor.nativeId, "lamp");
});

test("retains a present-but-invalid marker even when no last-known descriptor exists", async () => {
  const ingest = createIngest();
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: { nativeId: "new-lamp", capabilities: [] } }));
  const complete = await ingest.ingest(envelope("epoch-a", 3, { kind: "sync-complete", manifest: snapshotManifest("snap-a", 1, 0) }));

  assert.equal(complete.accepted, true);
  assert.equal(ingest.world().devices.get("new-lamp")?.validity, "present-but-invalid");
  assert.equal(ingest.world().devices.get("new-lamp")?.descriptor.nativeId, "new-lamp");
});

test("rejects unknown schemas through the validator seam while retaining native presence", async () => {
  const ingest = createIngest();
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  const result = await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("lamp", "vendor.unknown") }));

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "unsupported");
  assert.equal(ingest.diagnostics().unsupportedSchemaCount, 1);
  assert.equal(ingest.world().quarantinedPresence.has("lamp"), true);
});

test("compresses contiguous heartbeat records into one journal interval", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = createIngest(journal);
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.ingest(envelope("epoch-a", 2, { kind: "heartbeat" }));
  await ingest.ingest(envelope("epoch-a", 3, { kind: "heartbeat" }));
  await ingest.ingest(envelope("epoch-a", 4, { kind: "heartbeat" }));

  assert.deepEqual(journal.heartbeatIntervals(), [{
    bridgeId: "synthetic-bridge",
    epochId: "epoch-a",
    fromSeq: 2,
    toSeq: 4,
    count: 3,
  }]);
  journal.close();
});

test("heartbeat compression consumes quota once for a contiguous interval", () => {
  const journal = new SqliteIngestJournal(":memory:", { maxBytes: 100 });
  const heartbeatEnvelope = (seq: number): Envelope => envelope("epoch-a", seq, { kind: "heartbeat" });

  journal.appendAtomic({ bridgeId: "synthetic-bridge", receivedAt: "2026-08-18T00:00:00.000Z", envelope: heartbeatEnvelope(1) });
  journal.appendAtomic({ bridgeId: "synthetic-bridge", receivedAt: "2026-08-18T00:00:01.000Z", envelope: heartbeatEnvelope(2) });
  journal.appendAtomic({ bridgeId: "synthetic-bridge", receivedAt: "2026-08-18T00:00:02.000Z", envelope: heartbeatEnvelope(3) });

  assert.equal(journal.heartbeatIntervals()[0]?.count, 3);
  journal.close();
});

test("enforces a hard journal quota and transitions to paused or quarantined", async () => {
  const journal = new SqliteIngestJournal(":memory:", { maxBytes: 200 });
  const bridge = new SyntheticBridge({ bridgeId: "synthetic-bridge", remoteInstanceId: "remote-a" });
  const ingest = new BridgeIngest({
    bridgeId: "synthetic-bridge",
    journal,
    registeredSchemas: new Set(["hob.light@1"]),
    control: bridge.control,
  });
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  const result = await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("lamp") }));

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "resource_exhausted");
  assert.equal(["paused", "quarantined"].includes(ingest.diagnostics().connectionState), true);
  assert.equal(journal.records().length, 1);
  journal.close();
});

test("writes journal files with owner-only permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-ingest-"));
  const path = join(directory, "journal.sqlite");
  const journal = new SqliteIngestJournal(path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  journal.close();
  await rm(directory, { recursive: true, force: true });
});

test("reopens a SQLite journal with its legal records and watermark intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-ingest-reopen-"));
  const path = join(directory, "journal.sqlite");
  const first = new SqliteIngestJournal(path);
  first.appendAtomic({
    bridgeId: "synthetic-bridge",
    receivedAt: "2026-08-18T00:00:00.000Z",
    envelope: envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }),
  });
  first.close();

  const reopened = new SqliteIngestJournal(path);
  assert.equal(reopened.records()[0]?.envelope.seq, 1);
  assert.deepEqual(reopened.watermark("synthetic-bridge"), { epochId: "epoch-a", lastSeq: 1 });
  reopened.close();
  await rm(directory, { recursive: true, force: true });
});

test("synthetic bridge emits a single lifecycle stream and exposes accepted resync control", async () => {
  const bridge = new SyntheticBridge({ bridgeId: "synthetic-bridge", remoteInstanceId: "remote-a" });
  bridge.enqueue(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  bridge.enqueue(envelope("epoch-a", 2, { kind: "sync-complete", manifest: snapshotManifest("snap-a", 0, 0) }));

  const seen: Envelope[] = [];
  for await (const item of bridge.events(new AbortController().signal)) seen.push(item);

  assert.deepEqual(seen, [
    envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }),
    envelope("epoch-a", 2, { kind: "sync-complete", manifest: snapshotManifest("snap-a", 0, 0) }),
  ]);
  assert.deepEqual(await bridge.control.requestResync(new AbortController().signal), { status: "completed" });
});

test("consumes a synthetic bridge stream through the same ingest boundary", async () => {
  const bridge = new SyntheticBridge({ bridgeId: "synthetic-bridge" });
  bridge.enqueue(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  bridge.enqueue(envelope("epoch-a", 2, { kind: "sync-complete", manifest: snapshotManifest("snap-a", 0, 0) }));
  const ingest = createIngest();

  const results = await ingest.consume(bridge, new AbortController().signal);

  assert.deepEqual(results.map((result) => result.accepted), [true, true]);
  assert.equal(ingest.diagnostics().connectionState, "ready");
});

test("journal preserves rejection presence and history gaps without copying arbitrary secrets", () => {
  const journal = new SqliteIngestJournal(":memory:");
  journal.recordRejection({ bridgeId: "synthetic-bridge", epochId: "epoch-a", seq: 2, reason: "invalid_payload", nativeId: "lamp" });
  journal.recordHistoryGap({ bridgeId: "synthetic-bridge", epochId: "epoch-a", fromSeq: 2, toSeq: 5, reason: "sequence_gap" });

  assert.deepEqual(journal.rejections(), [{ bridgeId: "synthetic-bridge", epochId: "epoch-a", seq: 2, reason: "invalid_payload", nativeId: "lamp" }]);
  assert.deepEqual(journal.historyGaps(), [{ bridgeId: "synthetic-bridge", epochId: "epoch-a", fromSeq: 2, toSeq: 5, reason: "sequence_gap" }]);
  assert.equal(journal.contains("secret-token"), false);
  journal.close();
});

test("manifest mismatch keeps the last consistent world and freezes the bad epoch", async () => {
  const ingest = createIngest();
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("lamp") }));
  await ingest.ingest(envelope("epoch-a", 3, { kind: "state", state: state("lamp", "on") }));
  await ingest.ingest(envelope("epoch-a", 4, { kind: "sync-complete", manifest: snapshotManifest("snap-a", 1, 1) }));

  await ingest.ingest(envelope("epoch-b", 1, { kind: "sync-start", snapshotId: "snap-b", reason: "resync" }));
  await ingest.ingest(envelope("epoch-b", 2, { kind: "device-upserted", device: descriptor("other") }));
  const mismatch = await ingest.ingest(envelope("epoch-b", 3, { kind: "sync-complete", manifest: snapshotManifest("snap-b", 9, 0) }));
  const after = await ingest.ingest(envelope("epoch-b", 4, { kind: "device-upserted", device: descriptor("ignored") }));

  assert.equal(mismatch.accepted, false);
  assert.equal(mismatch.reason, "manifest_mismatch");
  assert.equal(after.broken, true);
  assert.equal(ingest.world().devices.has("lamp"), true);
  assert.equal(ingest.world().devices.has("other"), false);
  assert.equal(ingest.world().devices.has("ignored"), false);
});

test("allows heartbeat and bridge health during replay without counting them in the manifest", async () => {
  const ingest = createIngest();
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.ingest(envelope("epoch-a", 2, { kind: "heartbeat" }));
  await ingest.ingest(envelope("epoch-a", 3, { kind: "bridge-health", status: "up" }));
  await ingest.ingest(envelope("epoch-a", 4, { kind: "device-upserted", device: descriptor("lamp") }));
  await ingest.ingest(envelope("epoch-a", 5, { kind: "state", state: state("lamp", "on") }));
  const complete = await ingest.ingest(envelope("epoch-a", 6, { kind: "sync-complete", manifest: snapshotManifest("snap-a", 1, 1) }));

  assert.equal(complete.accepted, true);
  assert.equal(ingest.diagnostics().connectionState, "ready");
});

test("a later valid replay descriptor clears an earlier quarantined presence for the same device", async () => {
  const ingest = createIngest();
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: { nativeId: "lamp", capabilities: [] } }));
  await ingest.ingest(envelope("epoch-a", 3, { kind: "device-upserted", device: descriptor("lamp") }));
  const complete = await ingest.ingest(envelope("epoch-a", 4, { kind: "sync-complete", manifest: snapshotManifest("snap-a", 2, 0) }));

  assert.equal(complete.accepted, true);
  assert.equal(ingest.world().devices.get("lamp")?.validity, "valid");
  assert.equal(ingest.world().quarantinedPresence.has("lamp"), false);
});

test("drops late events from an old epoch without touching the current watermark", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = createIngest(journal);
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.ingest(envelope("epoch-a", 2, { kind: "sync-complete", manifest: snapshotManifest("snap-a", 0, 0) }));
  await ingest.ingest(envelope("epoch-b", 1, { kind: "sync-start", snapshotId: "snap-b", reason: "resync" }));
  const stale = await ingest.ingest(envelope("epoch-a", 3, { kind: "heartbeat" }));

  assert.equal(stale.accepted, false);
  assert.equal(ingest.diagnostics().staleEpochDropCount, 1);
  assert.deepEqual(journal.watermark("synthetic-bridge"), { epochId: "epoch-b", lastSeq: 1 });
  journal.close();
});

test("uses an independent sync timeout and quarantines an incomplete replay", async () => {
  const ingest = new BridgeIngest({
    bridgeId: "synthetic-bridge",
    journal: new SqliteIngestJournal(":memory:"),
    registeredSchemas: new Set(["hob.light@1"]),
    syncTimeoutMs: 1,
  });
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  const timeout = ingest.checkTimeouts(Date.now());

  assert.equal(timeout.syncTimedOut, true);
  assert.equal(ingest.diagnostics().connectionState, "quarantined");
});

test("uses the heartbeat silence clock independently from the sync timeout clock", async () => {
  let now = 1_000;
  const ingest = new BridgeIngest({
    bridgeId: "synthetic-bridge",
    journal: new SqliteIngestJournal(":memory:"),
    registeredSchemas: new Set(["hob.light@1"]),
    heartbeatIntervalMs: 10,
    syncTimeoutMs: 1_000,
    nowMs: () => now,
  });
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  now = 1_021;

  const timeout = ingest.checkTimeouts();

  assert.equal(timeout.heartbeatDown, true);
  assert.equal(timeout.syncTimedOut, false);
  assert.equal(ingest.diagnostics().connectionState, "down");
});

test("quarantines when journal backpressure cannot be paused", async () => {
  const journal = new SqliteIngestJournal(":memory:", { maxBytes: 200 });
  const bridge = new SyntheticBridge({ bridgeId: "synthetic-bridge", pauseResult: { status: "failed", reason: "internal_error" } });
  const ingest = new BridgeIngest({ bridgeId: "synthetic-bridge", journal, control: bridge.control, registeredSchemas: new Set(["hob.light@1"]) });
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  await ingest.ingest(envelope("epoch-a", 2, { kind: "device-upserted", device: descriptor("lamp") }));

  assert.equal(ingest.diagnostics().connectionState, "quarantined");
  journal.close();
});

test("custom event validation is a narrow schema admission seam", async () => {
  const ingest = new BridgeIngest({
    bridgeId: "synthetic-bridge",
    journal: new SqliteIngestJournal(":memory:"),
    registeredSchemas: new Set(["hob.light@1"]),
    validateEvent: (event) => event.kind === "state" && event.state.attrs.state === "forbidden"
      ? { ok: false, reason: "invalid_payload", nativeId: event.state.nativeId }
      : { ok: true },
  });
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  const rejected = await ingest.ingest(envelope("epoch-a", 2, { kind: "state", state: state("lamp", "forbidden") }));

  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "invalid_payload");
});

test("validates non-device event payloads at the core schema seam", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = createIngest(journal);
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  const rejected = await ingest.ingest(envelope("epoch-a", 2, { kind: "bridge-health", status: "not-a-health" } as BridgeEvent));

  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "invalid_payload");
  assert.deepEqual(journal.watermark("synthetic-bridge"), { epochId: "epoch-a", lastSeq: 2 });
  journal.close();
});

test("rejects extension events when the negotiated handle is unavailable", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = new BridgeIngest({
    bridgeId: "synthetic-bridge",
    journal,
    enabledExtensions: new Set(),
  });
  await ingest.ingest(envelope("epoch-a", 1, { kind: "sync-start", snapshotId: "snap-a", reason: "initial" }));
  const rejected = await ingest.ingest(envelope("epoch-a", 2, { kind: "ext", ext: "actions@1", payload: { token: "do-not-log" } }));

  assert.equal(rejected.reason, "unsupported");
  assert.equal(journal.rejections()[0]?.reason, "unsupported");
  assert.equal(journal.contains("do-not-log"), false);
  journal.close();
});
