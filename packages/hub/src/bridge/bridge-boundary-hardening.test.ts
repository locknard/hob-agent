import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { BridgeIngest, type BridgeEvent, type Envelope } from "./bridge-ingest.js";
import { SqliteIngestJournal } from "../ingest-journal.js";

const attrsSchema = z.object({ state: z.string() }).strict();

function envelope(epochId: string, seq: number, event: BridgeEvent): Envelope {
  return { epochId, seq, event };
}

test("binds state validation to the descriptor schema and rejects orphan or invalid attrs", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = new BridgeIngest({
    bridgeId: "bridge-schema",
    journal,
    registeredSchemas: new Set(["test.light@1"]),
    schemaRegistrations: new Map([[
      "test.light@1",
      {
        schema: "test.light",
        majorVersion: 1,
        attrsSchema,
        canonicalHash: "test-light-v1",
      },
    ]]),
  });

  await ingest.ingest(envelope("epoch-a", 1, {
    kind: "sync-start",
    snapshotId: "snapshot-a",
    remoteInstanceId: "remote-a",
    reason: "initial",
  }));

  const orphan = await ingest.ingest(envelope("epoch-a", 2, {
    kind: "state",
    state: {
      nativeId: "lamp",
      nativeInstanceId: "lamp:main",
      attrs: { state: "on" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  }));
  assert.equal(orphan.accepted, false);
  assert.equal(orphan.reason, "invalid_payload");

  const descriptor = await ingest.ingest(envelope("epoch-a", 3, {
    kind: "device-upserted",
    device: {
      nativeId: "lamp",
      capabilities: [{ nativeInstanceId: "lamp:main", schema: "test.light", schemaVersion: "1.0.0" }],
    },
  }));
  assert.equal(descriptor.accepted, true);

  const invalidAttrs = await ingest.ingest(envelope("epoch-a", 4, {
    kind: "state",
    state: {
      nativeId: "lamp",
      nativeInstanceId: "lamp:main",
      attrs: { state: "on", secret: "must-not-cross" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  }));
  assert.equal(invalidAttrs.accepted, false);
  assert.equal(invalidAttrs.reason, "invalid_payload");

  const valid = await ingest.ingest(envelope("epoch-a", 5, {
    kind: "state",
    state: {
      nativeId: "lamp",
      nativeInstanceId: "lamp:main",
      attrs: { state: "off" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  }));
  assert.equal(valid.accepted, true);
  const complete = await ingest.ingest(envelope("epoch-a", 6, {
    kind: "sync-complete",
    manifest: { snapshotId: "snapshot-a", deviceEnvelopeCount: 1, stateEnvelopeCount: 3 },
  }));
  assert.equal(complete.accepted, true);
  assert.deepEqual(journal.records().map((record) => record.envelope.seq), [1, 3, 5, 6]);
  assert.deepEqual(journal.rejections().map((rejection) => [rejection.seq, rejection.reason]), [
    [2, "invalid_payload"],
    [4, "invalid_payload"],
  ]);
  assert.equal(ingest.worldSnapshot().get("lamp")?.states.get("lamp:main")?.attrs.state, "off");
  assert.equal(journal.contains("must-not-cross"), false);
  journal.close();
});

test("fails closed for an extension that was not negotiated", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = new BridgeIngest({ bridgeId: "bridge-extension", journal });

  await ingest.ingest(envelope("epoch-ext", 1, {
    kind: "sync-start",
    snapshotId: "snapshot-ext",
    remoteInstanceId: "remote-ext",
    reason: "initial",
  }));
  const result = await ingest.ingest(envelope("epoch-ext", 2, {
    kind: "ext",
    ext: "unregistered@1",
    payload: { secret: "must-not-cross" },
  }));

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "unsupported");
  assert.equal(journal.records().some((record) => record.envelope.seq === 2), false);
  assert.equal(journal.contains("must-not-cross"), false);
  journal.close();
});

test("reduces device and bridge health into the diagnostics snapshot", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const ingest = new BridgeIngest({
    bridgeId: "bridge-health",
    journal,
    registeredSchemas: new Set(["test.light@1"]),
    schemaRegistrations: new Map([[
      "test.light@1",
      { schema: "test.light", majorVersion: 1, attrsSchema, canonicalHash: "test-light-v1" },
    ]]),
  });

  await ingest.ingest(envelope("epoch-health", 1, {
    kind: "sync-start",
    snapshotId: "snapshot-health",
    remoteInstanceId: "remote-health",
    reason: "initial",
  }));
  await ingest.ingest(envelope("epoch-health", 2, {
    kind: "device-upserted",
    device: {
      nativeId: "lamp",
      capabilities: [{ nativeInstanceId: "lamp:main", schema: "test.light", schemaVersion: "1.0.0" }],
    },
  }));
  await ingest.ingest(envelope("epoch-health", 3, {
    kind: "state",
    state: {
      nativeId: "lamp",
      nativeInstanceId: "lamp:main",
      attrs: { state: "on" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  }));
  await ingest.ingest(envelope("epoch-health", 4, {
    kind: "device-health",
    nativeId: "lamp",
    status: "unreachable",
  }));
  await ingest.ingest(envelope("epoch-health", 5, {
    kind: "bridge-health",
    status: "degraded",
  }));
  const complete = await ingest.ingest(envelope("epoch-health", 6, {
    kind: "sync-complete",
    manifest: { snapshotId: "snapshot-health", deviceEnvelopeCount: 1, stateEnvelopeCount: 1 },
  }));

  assert.equal(complete.accepted, true);
  assert.equal(ingest.deviceHealth("lamp"), "unreachable");
  assert.equal(ingest.bridgeHealth(), "degraded");
  assert.equal(ingest.diagnostics().connectionState, "degraded");
  journal.close();
});

test("accepts an extension only when both negotiation and its payload schema are present", async () => {
  const journal = new SqliteIngestJournal(":memory:");
  const extension = "test.extension@1";
  const ingest = new BridgeIngest({
    bridgeId: "bridge-extension-schema",
    journal,
    enabledExtensions: new Set([extension]),
    extensionSchemas: new Map([[extension, z.object({ value: z.string() }).strict()]]),
  });

  await ingest.ingest(envelope("epoch-extension-schema", 1, {
    kind: "sync-start",
    snapshotId: "snapshot-extension-schema",
    remoteInstanceId: "remote-extension-schema",
    reason: "initial",
  }));
  const accepted = await ingest.ingest(envelope("epoch-extension-schema", 2, {
    kind: "ext",
    ext: extension,
    payload: { value: "ok" },
  }));
  const rejected = await ingest.ingest(envelope("epoch-extension-schema", 3, {
    kind: "ext",
    ext: extension,
    payload: { secret: "must-not-cross" },
  }));
  const complete = await ingest.ingest(envelope("epoch-extension-schema", 4, {
    kind: "sync-complete",
    manifest: { snapshotId: "snapshot-extension-schema", deviceEnvelopeCount: 0, stateEnvelopeCount: 0 },
  }));

  assert.equal(accepted.accepted, true);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "invalid_payload");
  assert.equal(complete.accepted, true);
  assert.deepEqual(journal.records().map((record) => record.envelope.seq), [1, 2, 4]);
  assert.equal(journal.contains("must-not-cross"), false);
  journal.close();
});
