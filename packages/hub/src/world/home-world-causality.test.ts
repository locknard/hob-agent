import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
import {
  CAUSALITY_EXTENSION,
  type BridgeEvent,
  type Envelope,
} from "@hob/bridge-contract";
import { SyntheticBridge } from "@hob/bridge-contract/testing";

import { BridgeCatalog, type AdapterRegistration } from "../bridge/bridge-catalog.js";
import { BridgeRegistry, type BridgeConfigEntry } from "../bridge/bridge-registry.js";
import { SqliteIngestJournal } from "./ingest-journal.js";
import { HomeWorldService, type HomeWorldServiceOptions } from "./home-world-service.js";
import { WorldIdentityManager } from "./world-identity.js";

const capabilitySchema = {
  schema: "synthetic.light",
  majorVersion: 1,
  attrsSchema: z.record(z.string(), z.unknown()),
  canonicalHash: "synthetic-light-v1",
} as never;

function eventEnvelope(epochId: string, seq: number, event: BridgeEvent): Envelope {
  return { epochId, seq, event };
}

function registration(factory: AdapterRegistration<Record<string, never>>["factory"]): AdapterRegistration<Record<string, never>> {
  return {
    adapterType: "synthetic",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas: [capabilitySchema],
    factory,
  };
}

function entry(bridgeId: string): BridgeConfigEntry<Record<string, never>> {
  return { bridgeId, adapterType: "synthetic", config: {} };
}

function identityManager(): WorldIdentityManager {
  return new WorldIdentityManager({
    idFactory: (kind) => ({
      hw: "hw-device",
      hwCapability: "hwc-light",
      hwSpace: "hws-living",
      proposal: "proposal-test",
      audit: "audit-test",
    })[kind],
  });
}

function options(catalog: BridgeCatalog, registry: BridgeRegistry): HomeWorldServiceOptions {
  return {
    catalog,
    registry,
    bridges: [entry("bridge-causality")],
    journalFactory: () => new SqliteIngestJournal(":memory:"),
    maxRestarts: 0,
    scheduler: { wait: async () => undefined },
    identityManager: identityManager(),
    clock: () => "2026-08-25T00:00:00.000Z",
  };
}

async function waitForReady(service: HomeWorldService): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.snapshot().bridges["bridge-causality"]?.diagnostics.connectionState === "ready") return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for homeWorld causality bridge");
}

function createService(bridge: SyntheticBridge): Promise<{
  readonly service: HomeWorldService;
  readonly fiber: { dispose(): Promise<void> };
}> {
  const catalog = new BridgeCatalog();
  const adapters = new Map([["bridge-causality", bridge]]);
  catalog.register(registration((ctx) => adapters.get(ctx.bridgeId)!));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  return ctx.plugin(HomeWorldService, options(catalog, registry)).then((fiber) => ({
    service: ctx.homeWorld,
    fiber,
  }));
}

function stream(cause: "foreign_rule" | "unknown" | false): Envelope[] {
  const epochId = "causality-epoch";
  const events: Envelope[] = [
    eventEnvelope(epochId, 1, {
      kind: "sync-start",
      snapshotId: "causality-snapshot",
      remoteInstanceId: "remote-causality",
      reason: "initial",
    }),
    eventEnvelope(epochId, 2, {
      kind: "device-upserted",
      device: {
        nativeId: "native-light",
        name: "Living light",
        capabilities: [{
          nativeInstanceId: "native-light:main",
          schema: "synthetic.light",
          schemaVersion: "1.0.0",
          semanticKind: "light",
        }],
      },
    }),
    eventEnvelope(epochId, 3, {
      kind: "state",
      state: {
        nativeId: "native-light",
        nativeInstanceId: "native-light:main",
        attrs: { state: "off" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }),
    eventEnvelope(epochId, 4, {
      kind: "sync-complete",
      manifest: { snapshotId: "causality-snapshot", deviceEnvelopeCount: 1, stateEnvelopeCount: 1 },
    }),
    // This state is after sync-complete and remains a legal causality target.
    eventEnvelope(epochId, 5, {
      kind: "state",
      state: {
        nativeId: "native-light",
        nativeInstanceId: "native-light:main",
        attrs: { state: "on" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }),
  ];
  if (cause) events.push(eventEnvelope(epochId, 6, {
    kind: "ext",
    ext: "causality@1",
    payload: {
      refSeq: 5,
      cause: cause === "foreign_rule"
        ? { kind: "foreign_rule", ruleRef: "ha-rule:example" }
        : { kind: "unknown" },
    },
  }));
  return events;
}

function query() {
  return {
    hwCapabilityId: "hwc-light",
    provenance: { bridgeId: "bridge-causality", epochId: "causality-epoch", seq: 5 },
  } as const;
}

test("returns one neutral complete causality projection for a live post-sync state", async () => {
  const bridge = new SyntheticBridge({
    bridgeId: "bridge-causality",
    remoteInstanceId: "remote-causality",
    extensions: [CAUSALITY_EXTENSION],
  });
  for (const event of stream("foreign_rule")) bridge.enqueue(event);
  const { service, fiber } = await createService(bridge);
  await waitForReady(service);

  const result = service.queryCausality(query());
  assert.deepEqual(result, {
    status: "complete",
    hwCapabilityId: "hwc-light",
    provenance: query().provenance,
    attribution: "foreign_rule",
    hwId: "hw-device",
    semanticKind: "light",
    value: "on",
    observedAt: "2026-08-25T00:00:00.000Z",
    sourceTsQuality: "none",
    origin: "observed",
    reasons: [],
  });
  assert.equal("cause" in result, false);
  assert.equal("ruleRef" in result, false);
  assert.equal("nativeId" in result, false);
  await fiber.dispose();
});

test("returns explicit unknown when the state has no retained causality envelope", async () => {
  const bridge = new SyntheticBridge({
    bridgeId: "bridge-causality",
    remoteInstanceId: "remote-causality",
    extensions: [CAUSALITY_EXTENSION],
  });
  for (const event of stream(false)) bridge.enqueue(event);
  const { service, fiber } = await createService(bridge);
  await waitForReady(service);

  assert.deepEqual(service.queryCausality(query()), {
    status: "unknown",
    hwCapabilityId: "hwc-light",
    provenance: query().provenance,
    hwId: "hw-device",
    semanticKind: "light",
    observedAt: "2026-08-25T00:00:00.000Z",
    sourceTsQuality: "none",
    origin: "observed",
    reasons: ["cause_not_retained"],
  });
  await fiber.dispose();
});

test("keeps an explicit unknown attribution unknown", async () => {
  const bridge = new SyntheticBridge({
    bridgeId: "bridge-causality",
    remoteInstanceId: "remote-causality",
    extensions: [CAUSALITY_EXTENSION],
  });
  for (const event of stream("unknown")) bridge.enqueue(event);
  const { service, fiber } = await createService(bridge);
  await waitForReady(service);

  const result = service.queryCausality(query());
  assert.equal(result.status, "unknown");
  assert.equal(result.attribution, "unknown");
  assert.deepEqual(result.reasons, ["causality_unknown"]);
  assert.equal("ruleRef" in result, false);
  await fiber.dispose();
});

test("fails closed when causality is not negotiated", async () => {
  const bridge = new SyntheticBridge({
    bridgeId: "bridge-causality",
    remoteInstanceId: "remote-causality",
    extensions: [],
  });
  for (const event of stream("foreign_rule")) bridge.enqueue(event);
  const { service, fiber } = await createService(bridge);
  await waitForReady(service);

  assert.deepEqual(service.queryCausality(query()), {
    status: "unavailable",
    hwCapabilityId: "hwc-light",
    provenance: query().provenance,
    reasons: ["causality_unavailable"],
  });
  await fiber.dispose();
});

test("does not present bootstrap state as current causality evidence", async () => {
  const bridge = new SyntheticBridge({
    bridgeId: "bridge-causality",
    remoteInstanceId: "remote-causality",
    extensions: [CAUSALITY_EXTENSION],
  });
  for (const event of stream("foreign_rule")) bridge.enqueue(event);
  const { service, fiber } = await createService(bridge);
  await waitForReady(service);

  assert.deepEqual(service.queryCausality({
    hwCapabilityId: "hwc-light",
    provenance: { bridgeId: "bridge-causality", epochId: "causality-epoch", seq: 3 },
  }), {
    status: "unknown",
    hwCapabilityId: "hwc-light",
    provenance: { bridgeId: "bridge-causality", epochId: "causality-epoch", seq: 3 },
    reasons: ["target_stale"],
  });
  await fiber.dispose();
});
