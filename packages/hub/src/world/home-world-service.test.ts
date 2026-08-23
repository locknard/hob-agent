import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";

import {
  BridgeStreamError,
  type BridgeAdapter,
  type BridgeEvent,
  type BridgeInfo,
  type Envelope,
  type WorldCapability,
} from "@hob/bridge-contract";
import type { ActionsExtension, BridgeActionRequest } from "@hob/bridge-contract";
import { BridgeCatalog, type AdapterRegistration } from "../bridge/bridge-catalog.js";
import { BridgeRegistry, MemoryBridgeRegistryStore, type BridgeConfigEntry } from "../bridge/bridge-registry.js";
import { AuthorityCoordinator } from "../authority/authority-coordinator.js";
import { SqliteIngestJournal } from "./ingest-journal.js";
import { SyntheticBridge } from "@hob/bridge-contract/testing";
import { WorldIdentityManager } from "./world-identity.js";
import {
  HomeWorldService,
  type HomeWorldDeviceSnapshot,
  type HomeWorldServiceOptions,
  type HomeWorldSnapshot,
} from "./home-world-service.js";

const schema = {
  schema: "synthetic.light",
  majorVersion: 1,
  attrsSchema: z.record(z.string(), z.unknown()),
  canonicalHash: "synthetic-light-v1",
} as never;

const alternateSchema = {
  schema: "synthetic.other",
  majorVersion: 1,
  attrsSchema: z.record(z.string(), z.unknown()),
  canonicalHash: "synthetic-other-v1",
} as never;

function registration(
  factory: AdapterRegistration<Record<string, never>>["factory"],
  capabilitySchemas: AdapterRegistration<Record<string, never>>["capabilitySchemas"] = [schema],
): AdapterRegistration<Record<string, never>> {
  return {
    adapterType: "synthetic",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas,
    factory,
  };
}

function entry(bridgeId: string): BridgeConfigEntry<Record<string, never>> {
  return { bridgeId, adapterType: "synthetic", config: {} };
}

function eventEnvelope(epochId: string, seq: number, event: BridgeEvent): Envelope {
  return { epochId, seq, event };
}

function syncStart(epochId: string, remoteInstanceId: string): Envelope {
  return eventEnvelope(epochId, 1, {
    kind: "sync-start",
    snapshotId: `${epochId}-snapshot`,
    remoteInstanceId,
    reason: "initial",
  });
}

function snapshotFor(
  bridgeId: string,
  remoteInstanceId: string,
  schemaVersion = "1.0.0",
  capabilitySchema = "synthetic.light",
): Envelope[] {
  return [
    syncStart(`${bridgeId}-epoch`, remoteInstanceId),
    eventEnvelope(`${bridgeId}-epoch`, 2, {
      kind: "device-upserted",
      device: {
        nativeId: `${bridgeId}-lamp`,
        name: `${bridgeId} lamp`,
        capabilities: [{
          nativeInstanceId: `${bridgeId}-lamp:main`,
          schema: capabilitySchema,
          schemaVersion,
          semanticKind: "light",
          space: { nativeSpaceId: `${bridgeId}-living`, name: "Living room" },
        }],
      },
    }),
    eventEnvelope(`${bridgeId}-epoch`, 3, {
      kind: "state",
      state: {
        nativeId: `${bridgeId}-lamp`,
        nativeInstanceId: `${bridgeId}-lamp:main`,
        attrs: { state: "on" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }),
    eventEnvelope(`${bridgeId}-epoch`, 4, {
      kind: "sync-complete",
      manifest: { snapshotId: `${bridgeId}-epoch-snapshot`, deviceEnvelopeCount: 1, stateEnvelopeCount: 1 },
    }),
  ];
}

function syntheticBridge(bridgeId: string, remoteInstanceId: string, events: readonly Envelope[]): SyntheticBridge {
  const bridge = new SyntheticBridge({ bridgeId, remoteInstanceId });
  for (const event of events) bridge.enqueue(event);
  return bridge;
}

function deterministicIdentityManager(): WorldIdentityManager {
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

function schemaChangingIdentityManager(): WorldIdentityManager {
  let capabilitySequence = 0;
  return new WorldIdentityManager({
    idFactory: (kind) => {
      if (kind === "hwCapability") {
        capabilitySequence += 1;
        return capabilitySequence === 1 ? "hwc-light" : "hwc-replacement";
      }
      return ({
        hw: "hw-device",
        hwSpace: "hws-living",
        proposal: "proposal-test",
        audit: "audit-test",
      })[kind];
    },
  });
}

function authorityCapability(bindings: WorldCapability["bindings"]): WorldCapability {
  return {
    hwCapabilityId: "hwc-light",
    hwId: "hw-device",
    schema: "synthetic.light",
    bindings,
  };
}

function idleAuthorityAdapter(bridgeId: string, counters: { requestResync: number }): BridgeAdapter {
  return {
    info: {
      bridgeId,
      coreVersion: "6.3.0",
      ecosystem: "synthetic",
      heartbeatIntervalMs: 60_000,
      extensions: [],
    },
    async *events() {
      // The authority seam must not need a live stream or control call.
    },
    control: {
      requestResync: async () => {
        counters.requestResync += 1;
        return { status: "completed" };
      },
      dispose: async () => undefined,
    },
    extension: () => undefined,
  };
}

function testRuntimeOptions(
  catalog: BridgeCatalog,
  registry: BridgeRegistry,
  bridges: readonly BridgeConfigEntry<Record<string, never>>[],
  adapters: Map<string, SyntheticBridge>,
  overrides: Partial<HomeWorldServiceOptions> = {},
): HomeWorldServiceOptions {
  return {
    catalog,
    registry,
    bridges,
    journalFactory: () => new SqliteIngestJournal(":memory:"),
    maxRestarts: 0,
    scheduler: { wait: async () => undefined },
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for homeWorld");
}

test("mounts as homeWorld, consumes every configured bridge once, and aggregates a neutral snapshot", async () => {
  const catalog = new BridgeCatalog();
  const adapters = new Map<string, SyntheticBridge>([
    ["bridge-a", syntheticBridge("bridge-a", "remote-a", snapshotFor("bridge-a", "remote-a"))],
    ["bridge-b", syntheticBridge("bridge-b", "remote-b", snapshotFor("bridge-b", "remote-b"))],
  ]);
  catalog.register(registration((ctx) => adapters.get(ctx.bridgeId)!));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const options = testRuntimeOptions(catalog, registry, [entry("bridge-a"), entry("bridge-b")], adapters);

  const fiber = await ctx.plugin(HomeWorldService, options);
  const service = ctx.homeWorld;
  await waitFor(() => service.snapshot().bridges["bridge-a"]?.diagnostics.connectionState === "ready"
    && service.snapshot().bridges["bridge-b"]?.diagnostics.connectionState === "ready");

  const snapshot = service.snapshot();
  assert.equal(service.name, "homeWorld");
  assert.deepEqual(Object.keys(snapshot.watermarkVector).sort(), ["bridge-a", "bridge-b"]);
  assert.equal(snapshot.watermarkVector["bridge-a"]?.lastSeq, 4);
  assert.equal(snapshot.bridges["bridge-a"]?.metrics.consistency, "ready");
  assert.equal(snapshot.bridges["bridge-a"]?.metrics.eventActivity, "active");
  assert.equal(snapshot.bridges["bridge-a"]?.metrics.connection, "up");
  assert.deepEqual(snapshot.devices.map((device) => device.nativeId).sort(), ["bridge-a-lamp", "bridge-b-lamp"]);
  assert.equal(snapshot.devices[0]?.bridgeId, "bridge-a");
  assert.equal(snapshot.spaces.length, 2);
  assert.equal(snapshot.diagnostics.every((item) => item.journalCapacity !== undefined), true);
  assert.equal(snapshot.diagnostics.every((item) => (item.journalCapacity?.usedBytes ?? 0) > 0), true);
  assert.equal(snapshot.spaces.every((space) => space.name === "Living room"), true);
  assert.equal(typeof snapshot.devices[0]?.capabilities[0]?.bindings[0]?.hwSpaceId, "string");
  const priorBridgeASpace = snapshot.devices.find((device) => device.bridgeId === "bridge-a")
    ?.capabilities[0]?.bindings[0]?.hwSpaceId;
  await service.runtime("bridge-a")!.ingest.ingest(eventEnvelope("bridge-a-epoch", 5, {
    kind: "device-upserted",
    device: {
      nativeId: "bridge-a-lamp",
      name: "bridge-a lamp",
      capabilities: [{
        nativeInstanceId: "bridge-a-lamp:main",
        schema: "synthetic.light",
        schemaVersion: "1.0.0",
        semanticKind: "light",
        space: { nativeSpaceId: "bridge-a-dining", name: "Dining room" },
      }],
    },
  }));
  const moved = service.snapshot();
  assert.equal(moved.spaces.length, 2);
  assert.deepEqual(moved.spaces.map((space) => space.name).sort(), ["Dining room", "Living room"]);
  assert.notEqual(
    moved.devices.find((device) => device.bridgeId === "bridge-a")?.capabilities[0]?.bindings[0]?.hwSpaceId,
    priorBridgeASpace,
  );

  await fiber.dispose();
});

test("projects a private authority candidate input with revision-bound opaque identities", async () => {
  const catalog = new BridgeCatalog();
  const bridge = syntheticBridge("bridge-authority", "remote-authority", snapshotFor("bridge-authority", "remote-authority"));
  catalog.register(registration(() => bridge));
  const registryStore = new MemoryBridgeRegistryStore([{
    bridgeId: "bridge-authority",
    adapterType: "synthetic",
    createdAt: "2026-08-20T00:00:00.000Z",
    generation: 7,
    remoteInstanceId: "remote-authority",
  }]);
  const registry = new BridgeRegistry({ catalog, store: registryStore });
  const actionConfig = {
    bridgeId: "bridge-authority",
    approved: true,
    policyClass: "direct" as const,
    configIdentity: `sha256:${"a".repeat(64)}`,
    configRevision: 4,
  };
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    [entry("bridge-authority")],
    new Map([["bridge-authority", bridge]]),
    {
      identityManager: deterministicIdentityManager(),
      actionAuthorityConfig: { "hwc-light": actionConfig },
      monitorIntervalMs: 0,
    },
  ));
  try {
    await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-authority"]?.diagnostics.connectionState === "ready");

    const input = ctx.homeWorld.resolveAuthorityCandidateInput("hwc-light");
    assert.equal(input?.hwCapabilityId, "hwc-light");
    assert.equal(input?.knownCapability, true);
    assert.equal(input?.configured, true);
    assert.equal(input?.approved, true);
    assert.equal(input?.available, true);
    assert.equal(input?.registrationGeneration, 7);
    assert.match(input?.bindingIdentity ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.match(input?.configurationIdentity ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(input), /bridge-authority|remote-authority|synthetic|native/);

    const firstBindingIdentity = input?.bindingIdentity;
    registryStore.save({
      bridgeId: "bridge-authority",
      adapterType: "synthetic",
      createdAt: "2026-08-20T00:00:00.000Z",
      generation: 7,
      remoteInstanceId: "remote-authority-rotated",
    });
    const changedRemote = ctx.homeWorld.resolveAuthorityCandidateInput("hwc-light");
    assert.notEqual(changedRemote?.bindingIdentity, firstBindingIdentity);
    assert.doesNotMatch(JSON.stringify(changedRemote), /remote-authority-rotated/);
  } finally {
    await fiber.dispose();
  }
});

test("changes the authority binding identity when the selected runtime schema version changes", async () => {
  const catalog = new BridgeCatalog();
  const adapters = new Map<string, SyntheticBridge>();
  catalog.register(registration((ctx) => adapters.get(ctx.bridgeId)!));
  const registryStore = new MemoryBridgeRegistryStore([{
    bridgeId: "bridge-authority-versioned",
    adapterType: "synthetic",
    createdAt: "2026-08-20T00:00:00.000Z",
    generation: 7,
    remoteInstanceId: "remote-authority-versioned",
  }]);
  const registry = new BridgeRegistry({ catalog, store: registryStore });
  const identityManager = deterministicIdentityManager();
  const actionAuthorityConfig = {
    "hwc-light": {
      bridgeId: "bridge-authority-versioned",
      approved: true,
      policyClass: "direct",
      configIdentity: `sha256:${"a".repeat(64)}`,
      configRevision: 4,
    },
  };
  const bridges = [entry("bridge-authority-versioned")];
  const firstContext = new Context();
  adapters.set(
    "bridge-authority-versioned",
    syntheticBridge(
      "bridge-authority-versioned",
      "remote-authority-versioned",
      snapshotFor("bridge-authority-versioned", "remote-authority-versioned", "1.0.0"),
    ),
  );
  const firstFiber = await firstContext.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    bridges,
    adapters,
    { identityManager, actionAuthorityConfig, monitorIntervalMs: 0 },
  ));
  let firstInput: ReturnType<HomeWorldService["resolveAuthorityCandidateInput"]>;
  try {
    await waitFor(() => firstContext.homeWorld.snapshot().bridges["bridge-authority-versioned"]?.diagnostics.connectionState === "ready");
    firstInput = firstContext.homeWorld.resolveAuthorityCandidateInput("hwc-light");
  } finally {
    await firstFiber.dispose();
  }

  const secondContext = new Context();
  adapters.set(
    "bridge-authority-versioned",
    syntheticBridge(
      "bridge-authority-versioned",
      "remote-authority-versioned",
      snapshotFor("bridge-authority-versioned", "remote-authority-versioned", "1.1.0"),
    ),
  );
  const secondFiber = await secondContext.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    bridges,
    adapters,
    { identityManager, actionAuthorityConfig, monitorIntervalMs: 0 },
  ));
  try {
    await waitFor(() => secondContext.homeWorld.snapshot().bridges["bridge-authority-versioned"]?.diagnostics.connectionState === "ready");
    const secondInput = secondContext.homeWorld.resolveAuthorityCandidateInput("hwc-light");
    assert.equal(secondInput?.hwCapabilityId, firstInput?.hwCapabilityId);
    assert.equal(secondInput?.registrationGeneration, firstInput?.registrationGeneration);
    assert.notEqual(secondInput?.bindingIdentity, firstInput?.bindingIdentity);
  } finally {
    await secondFiber.dispose();
  }
});

test("fails closed when the selected runtime descriptor is missing, ambiguous, or schema-mismatched", async () => {
  const catalog = new BridgeCatalog();
  const adapters = new Map<string, SyntheticBridge>();
  catalog.register(registration((ctx) => adapters.get(ctx.bridgeId)!, [schema, alternateSchema]));
  const registryStore = new MemoryBridgeRegistryStore([{
    bridgeId: "bridge-authority-descriptor-guards",
    adapterType: "synthetic",
    createdAt: "2026-08-20T00:00:00.000Z",
    generation: 7,
    remoteInstanceId: "remote-authority-descriptor-guards",
  }]);
  const registry = new BridgeRegistry({ catalog, store: registryStore });
  const bridgeId = "bridge-authority-descriptor-guards";
  const nativeId = `${bridgeId}-lamp`;
  const nativeInstanceId = `${nativeId}:main`;
  const actionAuthorityConfig = {
    "hwc-light": {
      bridgeId,
      approved: true,
      policyClass: "direct",
      configIdentity: `sha256:${"b".repeat(64)}`,
      configRevision: 4,
    },
  };
  const bridge = syntheticBridge(bridgeId, "remote-authority-descriptor-guards", snapshotFor(bridgeId, "remote-authority-descriptor-guards"));
  adapters.set(bridgeId, bridge);
  const context = new Context();
  const fiber = await context.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    [entry(bridgeId)],
    adapters,
    {
      identityManager: schemaChangingIdentityManager(),
      actionAuthorityConfig,
      monitorIntervalMs: 0,
    },
  ));
  try {
    await waitFor(() => context.homeWorld.snapshot().bridges[bridgeId]?.diagnostics.connectionState === "ready");
    assert.equal(context.homeWorld.resolveAuthorityCandidateInput("hwc-light")?.available, true);

    await context.homeWorld.runtime(bridgeId)!.ingest.ingest(eventEnvelope(`${bridgeId}-epoch`, 5, {
      kind: "device-removed",
      nativeId,
    }));
    assert.equal(context.homeWorld.resolveAuthorityCandidateInput("hwc-light"), undefined);

    await context.homeWorld.runtime(bridgeId)!.ingest.ingest(eventEnvelope(`${bridgeId}-epoch`, 6, {
      kind: "device-upserted",
      device: {
        nativeId,
        capabilities: [
          { nativeInstanceId, schema: "synthetic.light", schemaVersion: "1.0.0" },
          { nativeInstanceId, schema: "synthetic.light", schemaVersion: "1.1.0" },
        ],
      },
    }));
    assert.equal(context.homeWorld.resolveAuthorityCandidateInput("hwc-light"), undefined);

    await context.homeWorld.runtime(bridgeId)!.ingest.ingest(eventEnvelope(`${bridgeId}-epoch`, 7, {
      kind: "device-upserted",
      device: {
        nativeId,
        capabilities: [{ nativeInstanceId, schema: "synthetic.other", schemaVersion: "1.0.0" }],
      },
    }));
    assert.equal(context.homeWorld.resolveAuthorityCandidateInput("hwc-light"), undefined);
  } finally {
    await fiber.dispose();
  }
});

test("returns an explicit unavailable placeholder without configuration and fails closed for unknown or invalid capability inputs", async () => {
  const catalog = new BridgeCatalog();
  const bridge = syntheticBridge("bridge-authority-placeholder", "remote-placeholder", snapshotFor("bridge-authority-placeholder", "remote-placeholder"));
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    [entry("bridge-authority-placeholder")],
    new Map([["bridge-authority-placeholder", bridge]]),
    {
      identityManager: deterministicIdentityManager(),
      actionAuthorityConfig: {
        "hwc-light": {
          bridgeId: "bridge-authority-placeholder",
          approved: true,
          policyClass: "direct",
          configIdentity: "not-a-sha256-digest",
          configRevision: 1,
        },
      },
      monitorIntervalMs: 0,
    },
  ));
  try {
    await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-authority-placeholder"]?.diagnostics.connectionState === "ready");

    const unknown = ctx.homeWorld.resolveAuthorityCandidateInput("hwc-unknown");
    assert.equal(unknown, undefined);

    const invalid = ctx.homeWorld.resolveAuthorityCandidateInput("hwc-light");
    assert.equal(invalid, undefined);
  } finally {
    await fiber.dispose();
  }

  const placeholderCatalog = new BridgeCatalog();
  const placeholderBridge = syntheticBridge("bridge-authority-unconfigured", "remote-unconfigured", snapshotFor("bridge-authority-unconfigured", "remote-unconfigured"));
  placeholderCatalog.register(registration(() => placeholderBridge));
  const placeholderRegistry = new BridgeRegistry({ catalog: placeholderCatalog });
  const placeholderContext = new Context();
  const placeholderFiber = await placeholderContext.plugin(HomeWorldService, testRuntimeOptions(
    placeholderCatalog,
    placeholderRegistry,
    [entry("bridge-authority-unconfigured")],
    new Map([["bridge-authority-unconfigured", placeholderBridge]]),
    { identityManager: deterministicIdentityManager(), monitorIntervalMs: 0 },
  ));
  try {
    await waitFor(() => placeholderContext.homeWorld.snapshot().bridges["bridge-authority-unconfigured"]?.diagnostics.connectionState === "ready");
    assert.deepEqual(placeholderContext.homeWorld.resolveAuthorityCandidateInput("hwc-light"), {
      hwCapabilityId: "hwc-light",
      knownCapability: true,
      configured: false,
      approved: false,
      available: false,
    });
  } finally {
    await placeholderFiber.dispose();
  }
});

test("a delta save preserves persisted entries that availability cannot see", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-world-authority-delta-"));
  const configPath = join(directory, "action-authority.json");
  const catalog = new BridgeCatalog();
  const bridge = syntheticBridge("bridge-delta", "remote-delta", snapshotFor("bridge-delta", "remote-delta"));
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    [entry("bridge-delta")],
    new Map([["bridge-delta", bridge]]),
    {
      identityManager: deterministicIdentityManager(),
      actionAuthorityConfigPath: configPath,
      actionAuthorityConfig: {
        // Revoked by the household — persisted fact, invisible to availability.
        "hwc-light": {
          bridgeId: "bridge-delta",
          approved: false,
          policyClass: "confirmation",
          configIdentity: `sha256:${"b".repeat(64)}`,
          configRevision: 3,
        },
        // Active — the form will echo it back unchanged.
        "hwc-curtain": {
          bridgeId: "bridge-delta",
          approved: true,
          policyClass: "direct",
          configIdentity: `sha256:${"d".repeat(64)}`,
          configRevision: 7,
        },
        // Configured on a bridge that is not part of this runtime at all.
        "hwc-detached": {
          bridgeId: "bridge-gone",
          approved: true,
          policyClass: "administrator",
          configIdentity: `sha256:${"c".repeat(64)}`,
          configRevision: 5,
        },
      },
      monitorIntervalMs: 0,
    },
  ));
  try {
    await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-delta"]?.diagnostics.connectionState === "ready");

    const revoked = ctx.homeWorld.actionAuthorityConfigurationOf("hwc-light");
    assert.equal(revoked.status, "configured");
    assert.equal(revoked.approved, false, "the settings projection sees the revocation, not a blank");

    const curtainBefore = ctx.homeWorld.actionAuthorityConfigurationOf("hwc-curtain");

    const result = ctx.homeWorld.configureActionAuthorityDelta([
      { hwCapabilityId: "hwc-light", policyClass: "direct" },
      // The form echoes the untouched active row back — a re-statement.
      { hwCapabilityId: "hwc-curtain", policyClass: "direct" },
    ]);
    assert.equal(result.status, "configured");
    assert.equal(result.changedCount, 1, "only the row the household actually changed counts");

    const curtainAfter = ctx.homeWorld.actionAuthorityConfigurationOf("hwc-curtain");
    assert.deepEqual(curtainAfter, curtainBefore, "the echoed row keeps bridge, revision, and identity byte-for-byte");

    const changed = ctx.homeWorld.actionAuthorityConfigurationOf("hwc-light");
    assert.equal(changed.status, "configured");
    assert.equal(changed.approved, true, "an explicit selection re-approves deliberately");
    assert.equal(changed.policyClass, "direct");

    const written = JSON.parse(readFileSync(configPath, "utf8")) as {
      bindings: readonly { hwCapabilityId: string; approved: boolean; policyClass: string; revision: number }[];
    };
    const curtainWritten = written.bindings.find((binding) => binding.hwCapabilityId === "hwc-curtain");
    assert.equal(curtainWritten?.revision, 7, "the echoed row's revision never bumps");
    const detached = written.bindings.find((binding) => binding.hwCapabilityId === "hwc-detached");
    assert.equal(detached?.approved, true, "the entry no page and no bridge can see survives the write");
    assert.equal(detached?.policyClass, "administrator");
    assert.equal(detached?.revision, 5, "an untouched entry keeps its revision");
  } finally {
    await fiber.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed for an unbound remote without invoking bridge control", async () => {
  const counters = { requestResync: 0 };
  const catalog = new BridgeCatalog();
  const adapter = idleAuthorityAdapter("bridge-unbound", counters);
  catalog.register(registration(() => adapter));
  const registry = new BridgeRegistry({ catalog });
  const authority = new AuthorityCoordinator({
    capabilities: [authorityCapability([{
      bridgeId: "bridge-unbound",
      nativeId: "native-unbound",
      nativeInstanceId: "native-unbound:main",
    }])],
    actionAuthorityConfig: {
      "hwc-light": {
        bridgeId: "bridge-unbound",
        approved: true,
        policyClass: "direct",
        configIdentity: `sha256:${"e".repeat(64)}`,
        configRevision: 1,
      },
    },
  });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    [entry("bridge-unbound")],
    new Map(),
    { authorityCoordinator: authority, monitorIntervalMs: 0 },
  ));
  try {
    await waitFor(() => ctx.homeWorld.runtime("bridge-unbound") !== undefined);
    assert.equal(ctx.homeWorld.resolveAuthorityCandidateInput("hwc-light"), undefined);
    assert.equal(counters.requestResync, 0);
  } finally {
    await fiber.dispose();
  }
});

test("fails closed when one authority target has ambiguous capability bindings", async () => {
  const counters = { requestResync: 0 };
  const catalog = new BridgeCatalog();
  const adapter = idleAuthorityAdapter("bridge-ambiguous", counters);
  catalog.register(registration(() => adapter));
  const registry = new BridgeRegistry({
    catalog,
    store: new MemoryBridgeRegistryStore([{
      bridgeId: "bridge-ambiguous",
      adapterType: "synthetic",
      createdAt: "2026-08-20T00:00:00.000Z",
      generation: 2,
      remoteInstanceId: "remote-ambiguous",
    }]),
  });
  const authority = new AuthorityCoordinator({
    capabilities: [authorityCapability([
      { bridgeId: "bridge-ambiguous", nativeId: "native-one", nativeInstanceId: "native-one:main" },
      { bridgeId: "bridge-ambiguous", nativeId: "native-two", nativeInstanceId: "native-two:main" },
    ])],
    actionAuthorityConfig: {
      "hwc-light": {
        bridgeId: "bridge-ambiguous",
        approved: true,
        policyClass: "direct",
        configIdentity: `sha256:${"f".repeat(64)}`,
        configRevision: 1,
      },
    },
  });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    [entry("bridge-ambiguous")],
    new Map(),
    { authorityCoordinator: authority, monitorIntervalMs: 0 },
  ));
  try {
    await waitFor(() => ctx.homeWorld.runtime("bridge-ambiguous") !== undefined);
    assert.equal(ctx.homeWorld.resolveAuthorityCandidateInput("hwc-light"), undefined);
    assert.equal(counters.requestResync, 0);
  } finally {
    await fiber.dispose();
  }
});

test("returns only selected post-baseline live changes as bounded neutral evidence", async () => {
  const catalog = new BridgeCatalog();
  const bridge = syntheticBridge("bridge-evidence", "remote-evidence", snapshotFor("bridge-evidence", "remote-evidence"));
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  let currentTime = "2026-08-19T00:00:00.000Z";
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    [entry("bridge-evidence")],
    new Map([["bridge-evidence", bridge]]),
    { clock: () => currentTime },
  ));
  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-evidence"]?.diagnostics.connectionState === "ready");
  const capability = ctx.homeWorld.snapshot().devices[0]!.capabilities[0]!;
  ctx.homeWorld.journal("bridge-evidence")!.appendAtomic({
    bridgeId: "bridge-evidence",
    receivedAt: "2026-08-19T03:00:00.000Z",
    envelope: eventEnvelope("bridge-evidence-epoch", 5, {
      kind: "state",
      state: {
        nativeId: "bridge-evidence-lamp",
        nativeInstanceId: "bridge-evidence-lamp:main",
        attrs: { state: "off", unbounded: { ignored: true } },
        time: { sourceTs: "2026-08-19T02:59:59.000Z", sourceTsQuality: "platform" },
        origin: "observed",
      },
    }),
  });
  currentTime = "2026-08-19T04:00:00.000Z";

  const evidence = ctx.homeWorld.queryRecentEvidence({
    hwCapabilityIds: [capability.hwCapabilityId],
    lookbackHours: 2,
    limit: 20,
  });

  assert.equal(evidence.events.length, 1);
  assert.deepEqual(evidence.events[0], {
    hwId: capability.hwId,
    hwCapabilityId: capability.hwCapabilityId,
    semanticKind: "light",
    value: "off",
    observedAt: "2026-08-19T03:00:00.000Z",
    sourceTs: "2026-08-19T02:59:59.000Z",
    sourceTsQuality: "platform",
    origin: "observed",
    provenance: { bridgeId: "bridge-evidence", epochId: "bridge-evidence-epoch", seq: 5 },
  });
  assert.deepEqual(evidence.coverage, [{
    bridgeId: "bridge-evidence",
    epochId: "bridge-evidence-epoch",
    baselineSeq: 4,
    baselineAt: "2026-08-19T00:00:00.000Z",
    status: "complete",
    reasons: [],
  }]);
  assert.equal(evidence.truncated, false);

  ctx.homeWorld.journal("bridge-evidence")!.appendAtomic({
    bridgeId: "bridge-evidence",
    receivedAt: "2026-08-19T03:30:00.000Z",
    envelope: eventEnvelope("bridge-evidence-epoch", 6, {
      kind: "state",
      state: {
        nativeId: "bridge-evidence-lamp",
        nativeInstanceId: "bridge-evidence-lamp:main",
        attrs: { state: "on" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }),
  });
  const bounded = ctx.homeWorld.queryRecentEvidence({
    hwCapabilityIds: [capability.hwCapabilityId],
    lookbackHours: 2,
    limit: 1,
  });
  assert.deepEqual(bounded.events.map((item) => item.provenance.seq), [6]);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.coverage[0]?.status, "partial");
  assert.deepEqual(bounded.coverage[0]?.reasons, ["query_truncated"]);
  await fiber.dispose();
});

test("rejects unknown capability ids and unbounded evidence requests", async () => {
  const catalog = new BridgeCatalog();
  const bridge = syntheticBridge("bridge-evidence-bounds", "remote-evidence-bounds", snapshotFor("bridge-evidence-bounds", "remote-evidence-bounds"));
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    [entry("bridge-evidence-bounds")],
    new Map([["bridge-evidence-bounds", bridge]]),
  ));
  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-evidence-bounds"]?.diagnostics.connectionState === "ready");

  assert.throws(() => ctx.homeWorld.queryRecentEvidence({
    hwCapabilityIds: ["unknown-capability"],
    lookbackHours: 24,
    limit: 20,
  }));
  assert.throws(() => ctx.homeWorld.queryRecentEvidence({
    hwCapabilityIds: ctx.homeWorld.snapshot().devices[0]!.capabilities.map((item) => item.hwCapabilityId),
    lookbackHours: 24 * 30,
    limit: 20,
  }));
  await fiber.dispose();
});

test("projects bounded post-baseline activity into neutral device aggregates", async () => {
  const catalog = new BridgeCatalog();
  const bridge = syntheticBridge("bridge-activity", "remote-activity", snapshotFor("bridge-activity", "remote-activity"));
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  let currentTime = "2026-08-19T00:00:00.000Z";
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    [entry("bridge-activity")],
    new Map([["bridge-activity", bridge]]),
    { clock: () => currentTime },
  ));
  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-activity"]?.diagnostics.connectionState === "ready");
  const device = ctx.homeWorld.snapshot().devices[0]!;
  for (const [seq, receivedAt] of [[5, "2026-08-19T02:00:00.000Z"], [6, "2026-08-19T03:00:00.000Z"]] as const) {
    ctx.homeWorld.journal("bridge-activity")!.appendAtomic({
      bridgeId: "bridge-activity",
      receivedAt,
      envelope: eventEnvelope("bridge-activity-epoch", seq, {
        kind: "state",
        state: {
          nativeId: "bridge-activity-lamp",
          nativeInstanceId: "bridge-activity-lamp:main",
          attrs: { state: `private-${seq}` },
          time: { sourceTsQuality: "none" },
          origin: "observed",
        },
      }),
    });
  }
  currentTime = "2026-08-19T04:00:00.000Z";

  const activity = ctx.homeWorld.queryRecentActivity({ lookbackHours: 4, limit: 20 });
  assert.deepEqual(activity.devices, [{
    hwId: device.hwId,
    eventCount: 2,
    latestObservedAt: "2026-08-19T03:00:00.000Z",
    semanticKinds: ["light"],
  }]);
  assert.deepEqual(activity.coverage, [{
    bridgeId: "bridge-activity",
    epochId: "bridge-activity-epoch",
    baselineSeq: 4,
    baselineAt: "2026-08-19T00:00:00.000Z",
    status: "complete",
    reasons: [],
  }]);
  assert.equal(activity.truncated, false);
  assert.equal(JSON.stringify(activity).includes("private"), false);
  assert.throws(() => ctx.homeWorld.queryRecentActivity({ lookbackHours: 0, limit: 20 }));
  assert.throws(() => ctx.homeWorld.queryRecentActivity({ lookbackHours: 24, limit: 51 }));
  await fiber.dispose();
});


test("disposes an adapter when bridge startup fails before runtime registration", async () => {
  const catalog = new BridgeCatalog();
  let disposeCalls = 0;
  const adapter: BridgeAdapter = {
    info: {
      bridgeId: "bridge-startup-failure",
      coreVersion: "6.3.0",
      ecosystem: "synthetic",
      heartbeatIntervalMs: 60_000,
      extensions: [],
    },
    events: async function* () {
      return;
    },
    control: {
      requestResync: async () => ({ status: "unsupported", reason: "unsupported" }),
      dispose: async () => {
        disposeCalls += 1;
      },
    },
    extension: () => undefined,
  };
  catalog.register(registration(() => adapter));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();

  await assert.rejects(
    Promise.resolve(ctx.plugin(HomeWorldService, {
      catalog,
      registry,
      bridges: [entry("bridge-startup-failure")],
      journalFactory: () => {
        throw new Error("journal-create");
      },
      maxRestarts: 0,
      monitorIntervalMs: 0,
    })),
    /journal-create/,
  );
  assert.equal(disposeCalls, 1);
});

test("fails closed for a declared extension without a usable handle", async () => {
  const catalog = new BridgeCatalog();
  const bridge = new SyntheticBridge({
    bridgeId: "bridge-ext",
    remoteInstanceId: "remote-ext",
    extensions: [{ id: "actions", version: "1.2.0" }],
  });
  bridge.enqueue(syncStart("epoch-ext", "remote-ext"));
  bridge.enqueue(eventEnvelope("epoch-ext", 2, { kind: "ext", ext: "actions@1", payload: { secret: "must-not-run" } }));
  bridge.enqueue(eventEnvelope("epoch-ext", 3, { kind: "sync-complete", manifest: { snapshotId: "epoch-ext-snapshot", deviceEnvelopeCount: 0, stateEnvelopeCount: 0 } }));
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(catalog, registry, [entry("bridge-ext")], new Map([["bridge-ext", bridge]])));

  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-ext"]?.diagnostics.connectionState === "ready");
  const bridgeSnapshot = ctx.homeWorld.snapshot().bridges["bridge-ext"]!;
  assert.equal(bridgeSnapshot.extensions["actions@1"], "unavailable");
  assert.equal(ctx.homeWorld.journal("bridge-ext")?.rejections()[0]?.reason, "unsupported");
  assert.equal(ctx.homeWorld.journal("bridge-ext")?.contains("must-not-run"), false);

  await fiber.dispose();
});

test("routes one neutral action only through the configured authoritative bridge binding", async () => {
  const catalog = new BridgeCatalog();
  const base = new SyntheticBridge({
    bridgeId: "bridge-actions",
    remoteInstanceId: "remote-actions",
    extensions: [{ id: "actions", version: "1.0.0" }],
  });
  for (const event of snapshotFor("bridge-actions", "remote-actions")) base.enqueue(event);
  let captured: BridgeActionRequest | undefined;
  const actions: ActionsExtension = {
    describe: (request) => ({
      action: { kind: "set_boolean", value: request.current.state !== "on" },
      reversible: true,
    }),
    execute: async (request) => {
      captured = request;
      return { status: "acknowledged" };
    },
  };
  const adapter: BridgeAdapter = {
    info: base.info,
    control: base.control,
    events: (signal) => base.events(signal),
    extension: (name) => name === "actions@1" ? actions as never : undefined,
  };
  catalog.register(registration(() => adapter));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    [entry("bridge-actions")],
    new Map(),
    {
      identityManager: deterministicIdentityManager(),
      actionAuthorityConfig: {
        "hwc-light": {
          bridgeId: "bridge-actions",
          approved: true,
          policyClass: "direct",
          configIdentity: `sha256:${"a".repeat(64)}`,
          configRevision: 1,
        },
      },
      monitorIntervalMs: 0,
    },
  ));

  try {
    await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-actions"]?.diagnostics.connectionState === "ready");
    assert.deepEqual(ctx.homeWorld.actionDescriptorFor("hwc-light"), {
      action: { kind: "set_boolean", value: false },
      reversible: true,
    });
    const result = await ctx.homeWorld.executeOneShotAction({
      requestId: "action-1",
      hwCapabilityId: "hwc-light",
      action: { kind: "set_boolean", value: false },
      signal: new AbortController().signal,
    });
    assert.deepEqual(result, { status: "acknowledged" });
    assert.deepEqual(captured, {
      requestId: "action-1",
      action: {
        kind: "set_boolean",
        target: {
          hwCapabilityId: "hwc-light",
          binding: {
            bridgeId: "bridge-actions",
            nativeId: "bridge-actions-lamp",
            nativeInstanceId: "bridge-actions-lamp:main",
          },
        },
        value: false,
      },
    });

    const stopResult = await ctx.homeWorld.executeOneShotAction({
      requestId: "action-stop-media",
      hwCapabilityId: "hwc-light",
      action: { kind: "stop_media" },
      signal: new AbortController().signal,
    });
    assert.deepEqual(stopResult, { status: "rejected", reason: "invalid_target" });
    assert.equal(captured?.action.kind, "set_boolean");
  } finally {
    await fiber.dispose();
  }
});

test("keeps unknown current state read-only before asking an adapter for an intent", async () => {
  const catalog = new BridgeCatalog();
  const base = new SyntheticBridge({
    bridgeId: "bridge-unknown-action",
    remoteInstanceId: "remote-unknown-action",
    extensions: [{ id: "actions", version: "1.0.0" }],
  });
  for (const event of snapshotFor("bridge-unknown-action", "remote-unknown-action")) {
    if (event.event.kind === "state") {
      base.enqueue({
        ...event,
        event: {
          kind: "state",
          state: { ...event.event.state, attrs: { state: "unknown" } },
        },
      });
    } else {
      base.enqueue(event);
    }
  }
  let descriptorCalls = 0;
  const actions: ActionsExtension = {
    describe: () => {
      descriptorCalls += 1;
      return { action: { kind: "set_boolean", value: true }, reversible: true };
    },
    execute: async () => ({ status: "acknowledged" }),
  };
  const adapter: BridgeAdapter = {
    info: base.info,
    control: base.control,
    events: (signal) => base.events(signal),
    extension: (name) => name === "actions@1" ? actions as never : undefined,
  };
  catalog.register(registration(() => adapter));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    [entry("bridge-unknown-action")],
    new Map(),
    {
      identityManager: deterministicIdentityManager(),
      actionAuthorityConfig: {
        "hwc-light": {
          bridgeId: "bridge-unknown-action",
          approved: true,
          policyClass: "direct",
          configIdentity: `sha256:${"b".repeat(64)}`,
          configRevision: 1,
        },
      },
      monitorIntervalMs: 0,
    },
  ));

  try {
    await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-unknown-action"]?.diagnostics.connectionState === "ready");
    assert.equal(ctx.homeWorld.actionDescriptorFor("hwc-light"), undefined);
    assert.equal(descriptorCalls, 0);
  } finally {
    await fiber.dispose();
  }
});

test("includes reduced device and bridge health in the neutral snapshot", async () => {
  const catalog = new BridgeCatalog();
  const bridge = new SyntheticBridge({ bridgeId: "bridge-health", remoteInstanceId: "remote-health" });
  bridge.enqueue(syncStart("epoch-health", "remote-health"));
  bridge.enqueue(eventEnvelope("epoch-health", 2, {
    kind: "device-upserted",
    device: {
      nativeId: "health-lamp",
      capabilities: [{ nativeInstanceId: "health-lamp:main", schema: "synthetic.light", schemaVersion: "1.0.0" }],
    },
  }));
  bridge.enqueue(eventEnvelope("epoch-health", 3, {
    kind: "state",
    state: {
      nativeId: "health-lamp",
      nativeInstanceId: "health-lamp:main",
      attrs: { state: "on" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  }));
  bridge.enqueue(eventEnvelope("epoch-health", 4, { kind: "device-health", nativeId: "health-lamp", status: "unreachable" }));
  bridge.enqueue(eventEnvelope("epoch-health", 5, { kind: "bridge-health", status: "degraded" }));
  bridge.enqueue(eventEnvelope("epoch-health", 6, {
    kind: "sync-complete",
    manifest: { snapshotId: "epoch-health-snapshot", deviceEnvelopeCount: 1, stateEnvelopeCount: 1 },
  }));
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(
    catalog,
    registry,
    [entry("bridge-health")],
    new Map([["bridge-health", bridge]]),
  ));

  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-health"]?.diagnostics.connectionState === "degraded");
  const snapshot = ctx.homeWorld.snapshot();
  assert.equal(snapshot.bridges["bridge-health"]?.diagnostics.connectionState, "degraded");
  assert.equal((snapshot.devices[0] as HomeWorldDeviceSnapshot & { health?: string })?.health, "unreachable");

  await fiber.dispose();
});

test("passes catalog attrs schemas and resource/folding controls into bridge ingest", async () => {
  const catalog = new BridgeCatalog();
  const strictSchema = {
    schema: "synthetic.strict",
    majorVersion: 1,
    attrsSchema: z.object({ state: z.string() }).strict(),
    canonicalHash: "synthetic-strict-v1",
  } as never;
  const bridge = new SyntheticBridge({ bridgeId: "bridge-controls", remoteInstanceId: "remote-controls" });
  bridge.enqueue(syncStart("epoch-controls", "remote-controls"));
  bridge.enqueue(eventEnvelope("epoch-controls", 2, {
    kind: "device-upserted",
    device: {
      nativeId: "controls-lamp",
      capabilities: [{ nativeInstanceId: "controls-lamp:main", schema: "synthetic.strict", schemaVersion: "1.0.0" }],
    },
  }));
  bridge.enqueue(eventEnvelope("epoch-controls", 3, {
    kind: "state",
    state: {
      nativeId: "controls-lamp",
      nativeInstanceId: "controls-lamp:main",
      attrs: { state: "on", secret: "reject" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  }));
  bridge.enqueue(eventEnvelope("epoch-controls", 4, {
    kind: "state",
    state: {
      nativeId: "controls-lamp",
      nativeInstanceId: "controls-lamp:main",
      attrs: { state: "x".repeat(64) },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  }));
  bridge.enqueue(eventEnvelope("epoch-controls", 5, {
    kind: "sync-complete",
    manifest: { snapshotId: "epoch-controls-snapshot", deviceEnvelopeCount: 1, stateEnvelopeCount: 2 },
  }));
  catalog.register({
    adapterType: "synthetic-controls",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas: [strictSchema],
    factory: () => bridge,
  });
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, {
    catalog,
    registry,
    bridges: [{ bridgeId: "bridge-controls", adapterType: "synthetic-controls", config: {} }],
    journalFactory: () => new SqliteIngestJournal(":memory:"),
    maxRestarts: 0,
    monitorIntervalMs: 0,
    scheduler: { wait: async () => undefined },
    resourceBudget: { maxStringLength: 32 },
    stateFoldWindowMs: 100,
  });

  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-controls"]?.diagnostics.connectionState === "ready");
  const snapshot = ctx.homeWorld.snapshot();
  assert.deepEqual(ctx.homeWorld.journal("bridge-controls")?.rejections().map((rejection) => rejection.reason), [
    "invalid_payload",
    "resource_exhausted",
  ]);
  assert.deepEqual(snapshot.devices.find((device) => device.nativeId === "controls-lamp")?.states, []);

  const runtime = ctx.homeWorld.runtime("bridge-controls")!;
  const incremental = await runtime.ingest.ingest(eventEnvelope("epoch-controls", 6, {
    kind: "state",
    state: {
      nativeId: "controls-lamp",
      nativeInstanceId: "controls-lamp:main",
      attrs: { state: "off" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  }));
  assert.equal(incremental.accepted, true);
  assert.deepEqual(runtime.ingest.worldSnapshot().get("controls-lamp")?.states, new Map());
  runtime.ingest.flushStateFolding();
  assert.equal(runtime.ingest.worldSnapshot().get("controls-lamp")?.states.get("controls-lamp:main")?.attrs.state, "off");

  await fiber.dispose();
});

test("rejects a mismatched remote identity before creating an epoch or journal row", async () => {
  const catalog = new BridgeCatalog();
  let factoryCalls = 0;
  const bridge = syntheticBridge("bridge-identity", "remote-wrong", [
    syncStart("epoch-identity", "remote-wrong"),
  ]);
  catalog.register(registration(() => {
    factoryCalls += 1;
    return bridge;
  }));
  const registry = new BridgeRegistry({
    catalog,
    store: new MemoryBridgeRegistryStore([{
      bridgeId: "bridge-identity",
      adapterType: "synthetic",
      createdAt: "2026-08-18T00:00:00.000Z",
      generation: 1,
      remoteInstanceId: "remote-bound",
    }]),
  });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(catalog, registry, [entry("bridge-identity")], new Map([[
    "bridge-identity",
    bridge,
  ]]), { maxRestarts: 3 }));

  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-identity"]?.diagnostics.connectionState === "quarantined");
  assert.deepEqual(ctx.homeWorld.journal("bridge-identity")?.records(), []);
  assert.equal(registry.binding("bridge-identity")?.remoteInstanceId, "remote-bound");
  assert.equal(ctx.homeWorld.snapshot().bridges["bridge-identity"]?.diagnostics.connectionState, "quarantined");
  assert.equal(factoryCalls, 1);

  await fiber.dispose();
});

test("restarts a failed stream by aborting, disposing, scheduling backoff, and constructing a fresh adapter", async () => {
  const catalog = new BridgeCatalog();
  const lifecycle: string[] = [];
  let factoryCalls = 0;
  const recovered = syntheticBridge("bridge-restart", "remote-restart", snapshotFor("bridge-restart", "remote-restart"));
  const failed: BridgeAdapter = {
    info: { bridgeId: "bridge-restart", coreVersion: "6.3.0", ecosystem: "synthetic", heartbeatIntervalMs: 10, extensions: [] },
    events: async function* (signal) {
      lifecycle.push(`events:${signal.aborted ? "aborted" : "started"}`);
      throw new BridgeStreamError("upstream unavailable", "upstream_unavailable");
    },
    control: {
      requestResync: async () => ({ status: "completed" }),
      dispose: async () => { lifecycle.push("dispose"); },
    },
    extension: () => undefined,
  };
  catalog.register(registration(() => {
    factoryCalls += 1;
    return factoryCalls === 1 ? failed : recovered;
  }));
  const registry = new BridgeRegistry({ catalog });
  const waits: number[] = [];
  const ctx = new Context();
  const options = testRuntimeOptions(catalog, registry, [entry("bridge-restart")], new Map(), {
    maxRestarts: 1,
    restartBackoffMs: 37,
    scheduler: { wait: async (delayMs) => { waits.push(delayMs); } },
  });
  const fiber = await ctx.plugin(HomeWorldService, options);

  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-restart"]?.diagnostics.connectionState === "ready");
  assert.equal(factoryCalls, 2);
  assert.deepEqual(waits, [37]);
  assert.deepEqual(lifecycle, ["events:started", "dispose"]);
  assert.equal(ctx.homeWorld.runtime("bridge-restart")?.restartCount, 1);

  await fiber.dispose();
});

test("treats a clean stream end as a lifecycle boundary and consumes a fresh epoch", async () => {
  const catalog = new BridgeCatalog();
  let factoryCalls = 0;
  const first = syntheticBridge("bridge-complete", "remote-complete", snapshotFor("first", "remote-complete"));
  const second = syntheticBridge("bridge-complete", "remote-complete", snapshotFor("second", "remote-complete"));
  catalog.register(registration(() => {
    factoryCalls += 1;
    return factoryCalls === 1 ? first : second;
  }));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(catalog, registry, [entry("bridge-complete")], new Map(), {
    maxRestarts: 1,
    restartBackoffMs: 0,
    scheduler: { wait: async () => undefined },
  }));

  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-complete"]?.watermark?.epochId === "second-epoch");
  assert.equal(factoryCalls, 2);
  assert.equal(ctx.homeWorld.runtime("bridge-complete")?.restartCount, 1);
  assert.equal(ctx.homeWorld.snapshot().bridges["bridge-complete"]?.diagnostics.connectionState, "ready");

  await fiber.dispose();
});

test("tick drives heartbeat and sync timeout states without waiting on wall-clock timers", async () => {
  const catalog = new BridgeCatalog();
  let now = 1_000;
  const bridge = syntheticBridge("bridge-timeout", "remote-timeout", [syncStart("epoch-timeout", "remote-timeout")]);
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(catalog, registry, [entry("bridge-timeout")], new Map([["bridge-timeout", bridge]]), {
    nowMs: () => now,
    heartbeatIntervalMs: 10,
    syncTimeoutMs: 1_000,
    maxRestarts: 0,
  }));
  await waitFor(() => ctx.homeWorld.runtime("bridge-timeout")?.ingest.diagnostics().connectionState === "syncing");

  now = 1_021;
  ctx.homeWorld.tick();
  assert.equal(ctx.homeWorld.snapshot().bridges["bridge-timeout"]?.diagnostics.connectionState, "down");
  now = 2_100;
  ctx.homeWorld.tick();
  assert.equal(ctx.homeWorld.snapshot().bridges["bridge-timeout"]?.diagnostics.connectionState, "quarantined");

  await fiber.dispose();
});

test("keeps a stable serializable snapshot shape for agent consumers", async () => {
  const catalog = new BridgeCatalog();
  const bridge = syntheticBridge("bridge-shape", "remote-shape", snapshotFor("bridge-shape", "remote-shape"));
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, testRuntimeOptions(catalog, registry, [entry("bridge-shape")], new Map([["bridge-shape", bridge]])));
  await waitFor(() => ctx.homeWorld.snapshot().bridges["bridge-shape"]?.diagnostics.connectionState === "ready");

  const json = JSON.stringify(ctx.homeWorld.snapshot());
  const parsed = JSON.parse(json) as HomeWorldSnapshot;
  assert.equal(parsed.devices[0]?.states[0]?.attrs.state, "on");
  assert.equal(parsed.devices[0]?.capabilities[0]?.semanticKind, "light");
  assert.equal(parsed.bridges["bridge-shape"]?.watermark.lastSeq, 4);
  assert.deepEqual(parsed.bridgeWatermarks, [{
    bridgeId: "bridge-shape",
    epochId: "bridge-shape-epoch",
    lastSeq: 4,
    lastSyncCompleteAt: parsed.diagnostics[0]?.lastSyncCompleteAt,
  }]);
  assert.equal(parsed.metrics.consistency[0]?.state, "ready");

  await fiber.dispose();
});

test("restarts from the durable journal fence without exposing an incomplete replacement epoch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-world-restart-"));
  const catalog = new BridgeCatalog();
  let factoryCalls = 0;
  const initial = syntheticBridge("bridge-recover", "remote-recover", snapshotFor("bridge-recover", "remote-recover"));
  catalog.register(registration(() => {
    factoryCalls += 1;
    if (factoryCalls === 1) return initial;
    if (factoryCalls === 3) {
      const stale = new SyntheticBridge({ bridgeId: "bridge-recover", remoteInstanceId: "remote-recover" });
      stale.enqueue(eventEnvelope("replacement-epoch", 3, {
        kind: "device-upserted",
        device: {
          nativeId: "stale-after-restart",
          capabilities: [{ nativeInstanceId: "stale-after-restart:main", schema: "synthetic.light", schemaVersion: "1.0.0" }],
        },
      }));
      return stale;
    }
    const failed = new SyntheticBridge({ bridgeId: "bridge-recover", remoteInstanceId: "remote-recover" });
    failed.enqueue(syncStart("bridge-recover-epoch", "remote-recover"));
    failed.enqueue(syncStart("replacement-epoch", "remote-recover"));
    failed.enqueue(eventEnvelope("replacement-epoch", 2, {
      kind: "device-upserted",
      device: {
        nativeId: "replacement-lamp",
        capabilities: [{ nativeInstanceId: "replacement-lamp:main", schema: "synthetic.light", schemaVersion: "1.0.0" }],
      },
    }));
    failed.enqueue(eventEnvelope("replacement-epoch", 4, { kind: "heartbeat" }));
    return failed;
  }));

  const firstContext = new Context();
  const firstFiber = await firstContext.plugin(HomeWorldService, {
    catalog,
    bridges: [entry("bridge-recover")],
    journalDirectory: directory,
    maxRestarts: 0,
    monitorIntervalMs: 0,
  });
  await waitFor(() => firstContext.homeWorld.snapshot().bridges["bridge-recover"]?.diagnostics.connectionState === "ready");
  await firstFiber.dispose();

  const secondContext = new Context();
  const secondFiber = await secondContext.plugin(HomeWorldService, {
    catalog,
    bridges: [entry("bridge-recover")],
    journalDirectory: directory,
    maxRestarts: 0,
    monitorIntervalMs: 0,
  });
  await waitFor(() => secondContext.homeWorld.runtime("bridge-recover")?.lastTermination === "completed");
  const snapshot = secondContext.homeWorld.snapshot();
  assert.deepEqual(snapshot.devices.map((device) => device.nativeId), ["bridge-recover-lamp"]);
  assert.equal(snapshot.bridges["bridge-recover"]?.watermark?.epochId, "bridge-recover-epoch");
  assert.equal(snapshot.bridges["bridge-recover"]?.diagnostics.connectionState, "degraded");
  assert.equal(secondContext.homeWorld.journal("bridge-recover")?.records().some((record) => (
    record.envelope.event.kind === "sync-start"
      && record.envelope.epochId === "replacement-epoch"
      && record.envelope.seq === 1
  )), true);

  await secondFiber.dispose();

  const thirdContext = new Context();
  const thirdFiber = await thirdContext.plugin(HomeWorldService, {
    catalog,
    bridges: [entry("bridge-recover")],
    journalDirectory: directory,
    maxRestarts: 0,
    monitorIntervalMs: 0,
  });
  await waitFor(() => thirdContext.homeWorld.runtime("bridge-recover")?.lastTermination === "completed");
  assert.deepEqual(thirdContext.homeWorld.snapshot().devices.map((device) => device.nativeId), ["bridge-recover-lamp"]);
  await thirdFiber.dispose();
  await rm(directory, { recursive: true, force: true });
});
