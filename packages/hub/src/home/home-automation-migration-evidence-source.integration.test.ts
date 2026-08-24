import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";

import type {
  BridgeAdapter,
  BridgeEvent,
  Envelope,
  ForeignRuleMigrationResult,
  WorldCapability,
} from "@hob/bridge-contract";
import { BridgeCatalog, type AdapterRegistration } from "../bridge/bridge-catalog.js";
import { BridgeRegistry } from "../bridge/bridge-registry.js";
import { AuthorityCoordinator } from "../authority/authority-coordinator.js";
import { createForeignRuleArtifactCandidate } from "../artifact/foreign-rule-artifact-candidate.js";
import { HomeAutomationMigrationSimulationEvidenceSource } from "./home-automation-migration-evidence-source.js";
import type { HomeAutomationMigrationSimulationSourceCut } from "./home-automation-migration-simulation.js";
import { HomeWorldService } from "../world/home-world-service.js";
import { SqliteIngestJournal } from "../world/ingest-journal.js";
import { WorldIdentityManager } from "../world/world-identity.js";

const BRIDGE_ID = "bridge-synthetic-migration";
const EPOCH_ID = "synthetic-migration-epoch";
const BASELINE_SEQ = 5;
const BASELINE_TIME = "2026-08-16T12:00:00.000Z";
const CLOCK = "2026-08-24T12:00:00.000Z";
const TRIGGER_BINDING = {
  bridgeId: BRIDGE_ID,
  nativeId: "light.living-room",
  nativeInstanceId: "light.living-room:main",
} as const;
const CONDITION_BINDING = {
  bridgeId: BRIDGE_ID,
  nativeId: "sensor.living-room",
  nativeInstanceId: "sensor.living-room:main",
} as const;
const SOURCE_FINGERPRINT = `sha256:${"a".repeat(64)}`;

const schema = {
  schema: "synthetic.state",
  majorVersion: 1,
  attrsSchema: z.object({ state: z.string() }).strict(),
  canonicalHash: "synthetic-state-v1",
} as never;

function envelope(seq: number, event: BridgeEvent): Envelope {
  return { epochId: EPOCH_ID, seq, event };
}

function capability(
  hwCapabilityId: string,
  binding: typeof TRIGGER_BINDING | typeof CONDITION_BINDING,
): WorldCapability {
  return {
    hwCapabilityId,
    hwId: "hw-living-room",
    schema: "synthetic.state",
    bindings: [binding],
  };
}

function translatedRule(): ForeignRuleMigrationResult {
  return {
    status: "translated",
    ruleRef: "rule-living-room",
    sourceFingerprint: SOURCE_FINGERPRINT,
    title: "Living room light",
    plan: {
      trigger: { kind: "capability_changed", source: TRIGGER_BINDING },
      conditions: [{
        kind: "capability_value",
        source: CONDITION_BINDING,
        operator: "equals",
        value: "off",
      }],
      actions: [{ kind: "set_boolean", target: TRIGGER_BINDING, value: true }],
    },
  };
}

function registration(
  factory: AdapterRegistration<Record<string, never>>["factory"],
): AdapterRegistration<Record<string, never>> {
  return {
    adapterType: "synthetic-migration",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas: [schema],
    factory,
  };
}

function bridgeAdapter(): BridgeAdapter {
  const initialEvents: readonly Envelope[] = [
    envelope(1, {
      kind: "sync-start",
      snapshotId: "synthetic-migration-snapshot",
      remoteInstanceId: "synthetic-migration-remote",
      reason: "initial",
    }),
    envelope(2, {
      kind: "device-upserted",
      device: {
        nativeId: "light.living-room",
        name: "Living room",
        capabilities: [{
          nativeInstanceId: "light.living-room:main",
          schema: "synthetic.state",
          schemaVersion: "1.0.0",
          semanticKind: "light",
        }],
      },
    }),
    envelope(3, {
      kind: "device-upserted",
      device: {
        nativeId: "sensor.living-room",
        name: "Living room sensor",
        capabilities: [{
          nativeInstanceId: "sensor.living-room:main",
          schema: "synthetic.state",
          schemaVersion: "1.0.0",
          semanticKind: "sensor",
        }],
      },
    }),
    envelope(4, {
      kind: "state",
      state: {
        nativeId: "light.living-room",
        nativeInstanceId: "light.living-room:main",
        attrs: { state: "off" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }),
    envelope(5, {
      kind: "sync-complete",
      manifest: { snapshotId: "synthetic-migration-snapshot", deviceEnvelopeCount: 2, stateEnvelopeCount: 1 },
    }),
  ];

  return {
    info: {
      bridgeId: BRIDGE_ID,
      coreVersion: "6.3.0",
      ecosystem: "synthetic",
      heartbeatIntervalMs: 60_000,
      extensions: [
        { id: "foreignRules", version: "2.0.0" },
        { id: "foreignRuleMigration", version: "1.0.0" },
      ],
    },
    async *events(signal) {
      for (const item of initialEvents) {
        if (signal.aborted) return;
        yield item;
      }
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    control: {
      requestResync: async () => ({ status: "completed" as const }),
      dispose: async () => undefined,
    },
    extension(name) {
      if (name === "foreignRules@2") {
        return {
          catalog: async () => ({
            epochId: EPOCH_ID,
            lastSeq: BASELINE_SEQ,
            complete: true,
            rules: [{ ruleRef: "rule-living-room", name: "Living room light", enabled: true }],
          }),
        } as never;
      }
      if (name === "foreignRuleMigration@1") {
        return {
          translate: async () => translatedRule(),
        } as never;
      }
      return undefined;
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for HomeWorld");
}

test("reads a real HomeWorld post-baseline trigger and condition into neutral migration evidence", async () => {
  const bridge = bridgeAdapter();
  const catalog = new BridgeCatalog();
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const authority = new AuthorityCoordinator({
    capabilities: [
      capability("hwc-trigger", TRIGGER_BINDING),
      capability("hwc-condition", CONDITION_BINDING),
    ],
  });
  let capabilityIndex = 0;
  const identity = new WorldIdentityManager({
    idFactory: (kind) => {
      if (kind === "hw") return "hw-living-room";
      if (kind === "hwCapability") return ["hwc-trigger", "hwc-condition"][capabilityIndex++] ?? `hwc-extra-${capabilityIndex}`;
      return `${kind}-synthetic-migration`;
    },
  });
  const context = new Context();
  let currentTime = BASELINE_TIME;
  const fiber = await context.plugin(HomeWorldService, {
    catalog,
    registry,
    bridges: [{ bridgeId: BRIDGE_ID, adapterType: "synthetic-migration", config: {} }],
    journalFactory: () => new SqliteIngestJournal(":memory:"),
    authorityCoordinator: authority,
    identityManager: identity,
    clock: () => currentTime,
    monitorIntervalMs: 0,
    maxRestarts: 0,
    scheduler: { wait: async () => undefined },
  });

  try {
    await waitFor(() => context.homeWorld.snapshot().bridges[BRIDGE_ID]?.diagnostics.connectionState === "ready");
    const world = context.homeWorld;
    assert.deepEqual(world.snapshot().bridgeWatermarks, [{
      bridgeId: BRIDGE_ID,
      epochId: EPOCH_ID,
      lastSeq: BASELINE_SEQ,
      lastSyncCompleteAt: BASELINE_TIME,
    }]);
    assert.deepEqual(await world.foreignRuleCatalog(), [{
      bridgeId: BRIDGE_ID,
      status: "available",
      epochId: EPOCH_ID,
      lastSeq: BASELINE_SEQ,
      rules: [{ ruleRef: "rule-living-room", name: "Living room light", enabled: true }],
    }]);

    const translated = await world.translateForeignRule({
      bridgeId: BRIDGE_ID,
      epochId: EPOCH_ID,
      lastSeq: BASELINE_SEQ,
      ruleRef: "rule-living-room",
      signal: new AbortController().signal,
    });
    const candidate = createForeignRuleArtifactCandidate(
      translated,
      (binding) => world.resolveBridgeActionTargetForBinding(binding),
    );
    assert.equal(candidate.status, "candidate");
    if (candidate.status !== "candidate") assert.fail("expected neutral candidate");

    const runtime = world.runtime(BRIDGE_ID);
    assert.ok(runtime);
    currentTime = CLOCK;
    assert.equal((await runtime.ingest.ingest(envelope(6, {
      kind: "state",
      state: {
        nativeId: "sensor.living-room",
        nativeInstanceId: "sensor.living-room:main",
        attrs: { state: "off" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }))).accepted, true);
    assert.equal((await runtime.ingest.ingest(envelope(7, {
      kind: "state",
      state: {
        nativeId: "light.living-room",
        nativeInstanceId: "light.living-room:main",
        attrs: { state: "on" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }))).accepted, true);
    const sourceCut: HomeAutomationMigrationSimulationSourceCut = {
      bridgeId: BRIDGE_ID,
      epochId: EPOCH_ID,
      lastSeq: BASELINE_SEQ,
      configFingerprint: SOURCE_FINGERPRINT,
    };
    const evidence = await new HomeAutomationMigrationSimulationEvidenceSource(world).read({
      sourceCut,
      candidate,
      signal: new AbortController().signal,
    });

    assert.ok(evidence);
    assert.deepEqual(evidence.sourceCut, sourceCut);
    assert.deepEqual(evidence.eventSamples, [{
      eventId: `capability_changed:${BRIDGE_ID}:${EPOCH_ID}:7:hwc-trigger`,
      kind: "capability_changed",
      occurredAt: CLOCK,
      capabilityId: "hwc-trigger",
      values: [
        { capabilityId: "hwc-trigger", value: "on" },
        { capabilityId: "hwc-condition", value: "off" },
      ],
    }]);
    assert.deepEqual(evidence.existingRuleSummaries, []);
    assert.equal(JSON.stringify(evidence).includes("nativeId"), false);
    assert.equal(JSON.stringify(evidence).includes("nativeInstanceId"), false);
    assert.equal(JSON.stringify(evidence).includes("provider"), false);
  } finally {
    await fiber.dispose();
  }
});
