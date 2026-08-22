import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  BridgeIngest,
  type BridgeEvent,
  type BridgeInfo,
  type ControlResult,
  type DeviceDescriptor,
  type Envelope,
  type StateEvent,
} from "./bridge-ingest.js";
import { runBridgeAdapterConformance } from "@hob/bridge-contract";
import {
  BridgeCatalog,
  type AdapterRegistration,
  type BridgeAdapter,
} from "./bridge-catalog.js";
import { BridgeRegistry, BridgeRegistryError } from "./bridge-registry.js";
import { SqliteIngestJournal } from "./ingest-journal.js";
import { SyntheticBridge } from "./synthetic-bridge.js";

const bridgeId = "synthetic-matrix";

function frame(epochId: string, seq: number, event: BridgeEvent): Envelope {
  return { epochId, seq, event };
}

function syncStart(
  epochId: string,
  seq: number,
  remoteInstanceId = "remote-a",
  reason: "initial" | "resync" = "initial",
): Envelope {
  return frame(epochId, seq, {
    kind: "sync-start",
    snapshotId: `snapshot-${epochId}`,
    remoteInstanceId,
    reason,
  });
}

function descriptor(nativeId: string, schema = "hob.light", capabilities = true): DeviceDescriptor {
  return {
    nativeId,
    name: nativeId,
    capabilities: capabilities
      ? [{ nativeInstanceId: `${nativeId}:main`, schema, schemaVersion: "1.0.0" }]
      : [],
  };
}

function state(nativeId: string, value: string): StateEvent {
  return {
    nativeId,
    nativeInstanceId: `${nativeId}:main`,
    attrs: { state: value },
    time: { sourceTsQuality: "none" },
    origin: "observed",
  };
}

function complete(epochId: string, seq: number, snapshotId: string, deviceEnvelopeCount: number, stateEnvelopeCount: number): Envelope {
  return frame(epochId, seq, {
    kind: "sync-complete",
    manifest: { snapshotId, deviceEnvelopeCount, stateEnvelopeCount },
  });
}

function ingest(options: ConstructorParameters<typeof BridgeIngest>[0] = {}) {
  return new BridgeIngest({
    bridgeId,
    journal: new SqliteIngestJournal(":memory:"),
    registeredSchemas: new Set(["hob.light@1"]),
    clock: () => "2026-08-18T00:00:00.000Z",
    ...options,
  });
}

function syntheticRegistration(factory: () => BridgeAdapter): AdapterRegistration<Record<string, never>> {
  return {
    adapterType: "synthetic",
    configSchema: z.object({}),
    credentialRequirements: [],
    capabilitySchemas: [],
    factory: () => factory(),
  };
}

function loadSynthetic(bridge: SyntheticBridge, configuredBridgeId = bridge.info.bridgeId): BridgeAdapter {
  const catalog = new BridgeCatalog();
  catalog.register(syntheticRegistration(() => bridge));
  return new BridgeRegistry({ catalog }).load({
    bridgeId: configuredBridgeId,
    adapterType: "synthetic",
    config: {},
  });
}

test("consumes the synthetic reference registration through the neutral conformance harness", async () => {
  const conformanceBridgeId = "synthetic-conformance";
  const registration = syntheticRegistration(() => {
    const bridge = new SyntheticBridge({ bridgeId: conformanceBridgeId });
    bridge.enqueue(frame("conformance-epoch", 1, {
      kind: "sync-start",
      snapshotId: "conformance-snapshot",
      remoteInstanceId: "synthetic-remote",
      reason: "initial",
    }));
    bridge.enqueue(frame("conformance-epoch", 2, {
      kind: "device-upserted",
      device: descriptor("conformance-device"),
    }));
    bridge.enqueue(frame("conformance-epoch", 3, {
      kind: "state",
      state: state("conformance-device", "ready"),
    }));
    bridge.enqueue(complete("conformance-epoch", 4, "conformance-snapshot", 1, 1));
    return bridge;
  });
  const report = await runBridgeAdapterConformance({
    registration,
    adapterType: registration.adapterType,
    bridgeId: conformanceBridgeId,
    config: {},
    credentials: { resolve: async () => undefined, describe: async () => ({ configured: false }) },
    replay: {
      epochId: "conformance-epoch",
      snapshotId: "conformance-snapshot",
      remoteInstanceId: "synthetic-remote",
      deviceEnvelopeCount: 1,
      stateEnvelopeCount: 1,
    },
    extensionHandles: [],
  });

  assert.equal(report.passed, true);
});

test("synthetic reference bridge frozen protocol matrix", async (t) => {
  await t.test("composes declarations and degrades an unavailable extension", () => {
    const extensions: BridgeInfo["extensions"] = [
      { id: "telemetry", version: "1.0.0" },
      { id: "future", version: "99.0.0" },
    ];
    const bridge = new SyntheticBridge({ bridgeId, ecosystem: "synthetic", extensions });
    const loaded = loadSynthetic(bridge);

    assert.equal(loaded.info.bridgeId, bridgeId);
    assert.equal(loaded.info.coreVersion, "6.3.0");
    assert.deepEqual(loaded.info.extensions, extensions);
    assert.equal(loaded.extension("future@99" as never), undefined);
  });

  await t.test("rejects bridgeId echo and unsupported core version before events", () => {
    const wrongBridgeId = new SyntheticBridge({ bridgeId: "other-bridge" });
    assert.throws(
      () => loadSynthetic(wrongBridgeId, bridgeId),
      (error: unknown) => error instanceof BridgeRegistryError && error.code === "bridge_id_echo_mismatch",
    );

    const unsupported = new SyntheticBridge({ bridgeId });
    (unsupported.info as { coreVersion: string }).coreVersion = "5.3.0";
    assert.throws(
      () => loadSynthetic(unsupported),
      (error: unknown) => error instanceof BridgeRegistryError && error.code === "unsupported_core_version",
    );
  });

  await t.test("binds sync-start epochs and drops stale or mismatched epochs", async () => {
    const instance = ingest({ remoteInstanceId: "remote-a" });
    assert.equal((await instance.ingest(syncStart("epoch-a", 1))).accepted, true);
    assert.equal((await instance.ingest(frame("epoch-a", 2, { kind: "heartbeat" }))).accepted, true);
    assert.equal((await instance.ingest(syncStart("epoch-b", 1, "remote-a", "resync"))).accepted, true);

    const stale = await instance.ingest(frame("epoch-a", 3, { kind: "heartbeat" }));
    assert.equal(stale.accepted, false);
    assert.equal(stale.reason, "protocol_error");
    assert.equal(instance.diagnostics().staleEpochDropCount, 1);

    const mismatched = await instance.ingest(syncStart("epoch-c", 1, "remote-b", "resync"));
    assert.equal(mismatched.accepted, false);
    assert.equal(mismatched.fatal, true);
    assert.equal(mismatched.reason, "remote_identity_mismatch");
  });

  await t.test("quarantines an incomplete replay after the independent sync timeout", async () => {
    let now = 0;
    const instance = ingest({
      nowMs: () => now,
      syncTimeoutMs: 5,
    });
    assert.equal((await instance.ingest(syncStart("epoch-timeout", 1))).accepted, true);
    now = 6;

    assert.deepEqual(instance.checkTimeouts(), { heartbeatDown: false, syncTimedOut: true });
    assert.equal(instance.diagnostics().connectionState, "quarantined");
  });

  await t.test("does not exchange a malformed manifest into the world", async () => {
    const instance = ingest();
    assert.equal((await instance.ingest(syncStart("epoch-manifest", 1))).accepted, true);
    assert.equal((await instance.ingest(frame("epoch-manifest", 2, {
      kind: "device-upserted",
      device: descriptor("lamp"),
    }))).accepted, true);
    assert.equal((await instance.ingest(frame("epoch-manifest", 3, {
      kind: "state",
      state: state("lamp", "on"),
    }))).accepted, true);

    const result = await instance.ingest(complete("epoch-manifest", 4, "snapshot-epoch-manifest", 1, 0));
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "manifest_mismatch");
    assert.equal(instance.worldSnapshot().has("lamp"), false);
    assert.equal(instance.diagnostics().connectionState, "degraded");
  });

  await t.test("retains bad device presence instead of inferring removal", async () => {
    const instance = ingest();
    assert.equal((await instance.ingest(syncStart("epoch-presence", 1))).accepted, true);
    const rejected = await instance.ingest(frame("epoch-presence", 2, {
      kind: "device-upserted",
      device: descriptor("bad-lamp", "hob.light", false),
    }));
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, "invalid_payload");

    const result = await instance.ingest(complete("epoch-presence", 3, "snapshot-epoch-presence", 1, 0));
    assert.equal(result.accepted, true);
    assert.equal(instance.worldSnapshot().get("bad-lamp")?.validity, "present-but-invalid");
  });

  await t.test("fails closed on journal backpressure after attempting pause", async () => {
    const journal = new SqliteIngestJournal(":memory:", { maxBytes: 200 });
    const bridge = new SyntheticBridge({ bridgeId, pauseResult: { status: "completed" } });
    const instance = ingest({ journal, control: bridge.control });
    assert.equal((await instance.ingest(syncStart("epoch-pressure", 1))).accepted, true);

    const result = await instance.ingest(frame("epoch-pressure", 2, {
      kind: "device-upserted",
      device: descriptor("lamp"),
    }));
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "resource_exhausted");
    assert.equal(instance.diagnostics().connectionState, "paused");
    journal.close();
  });

  await t.test("keeps heartbeats out of manifest counts while tracking liveness", async () => {
    let now = 0;
    const bridge = new SyntheticBridge({ bridgeId });
    bridge.enqueue(syncStart("epoch-heartbeat", 1));
    bridge.enqueue(frame("epoch-heartbeat", 2, { kind: "heartbeat" }));
    bridge.enqueue(complete("epoch-heartbeat", 3, "snapshot-epoch-heartbeat", 0, 0));
    const instance = ingest({
      control: bridge.control,
      nowMs: () => now,
      clock: () => new Date(now).toISOString(),
      heartbeatIntervalMs: 10,
    });

    const results = await instance.consume(bridge, new AbortController().signal);
    assert.deepEqual(results.map((result) => result.accepted), [true, true, true]);
    assert.equal(instance.diagnostics().connectionState, "ready");
    now = 15;
    assert.equal(instance.checkTimeouts().heartbeatDown, false);
    now = 25;
    assert.equal(instance.checkTimeouts().heartbeatDown, true);
  });

  await t.test("records a bounded history gap and freezes the high watermark", async () => {
    const journal = new SqliteIngestJournal(":memory:");
    const bridge = new SyntheticBridge({ bridgeId });
    const instance = ingest({ journal, control: bridge.control, diagnosticSampleLimit: 1 });
    assert.equal((await instance.ingest(syncStart("epoch-gap", 1))).accepted, true);
    const broken = await instance.ingest(frame("epoch-gap", 3, { kind: "heartbeat" }));

    assert.equal(broken.accepted, false);
    assert.equal(broken.broken, true);
    assert.deepEqual(journal.watermark(bridgeId), { epochId: "epoch-gap", lastSeq: 1 });
    assert.equal(journal.historyGaps()[0]?.reason, "sequence_gap");
    assert.equal(instance.diagnostics().historyGapCount, 1);
    assert.equal(instance.diagnosticSamples().length, 1);
    journal.close();
  });

  await t.test("admits registered schemas and quarantines unknown schema presence", async () => {
    const instance = ingest();
    assert.equal((await instance.ingest(syncStart("epoch-schema", 1))).accepted, true);
    const result = await instance.ingest(frame("epoch-schema", 2, {
      kind: "device-upserted",
      device: descriptor("unknown", "vendor.unknown"),
    }));

    assert.equal(result.accepted, false);
    assert.equal(result.reason, "unsupported");
    assert.equal(instance.diagnostics().unsupportedSchemaCount, 1);
    assert.equal(instance.world().quarantinedPresence.has("unknown"), true);
  });

  await t.test("preserves the closed control result codes", async () => {
    const results: ControlResult[] = [
      { status: "completed" },
      { status: "unsupported", reason: "unsupported" },
      { status: "failed", reason: "upstream_unavailable", adapterCode: "synthetic:timeout" },
    ];
    for (const expected of results) {
      const bridge = new SyntheticBridge({ bridgeId, requestResyncResult: expected });
      const instance = ingest({ control: bridge.control });
      assert.deepEqual(await instance.requestResync(), expected);
    }
  });
});
