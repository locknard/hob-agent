import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";

import {
  AuthorityCoordinator,
  type AuthorityAvailability,
  type AuthorityResyncSnapshot,
  type StateAuthorityChoice,
} from "./authority-coordinator.js";
import { BridgeCatalog, type AdapterRegistration } from "./bridge/bridge-catalog.js";
import { BridgeRegistry, type BridgeConfigEntry } from "./bridge/bridge-registry.js";
import { SqliteIngestJournal } from "./ingest-journal.js";
import {
  HomeWorldService,
  type HomeWorldServiceOptions,
} from "./home-world-service.js";
import { SyntheticBridge } from "./bridge/synthetic-bridge.js";
import { WorldIdentityManager } from "./world-identity.js";
import type { JournalWatermark } from "./bridge/bridge-ingest-types.js";

const schema = {
  schema: "synthetic.light",
  majorVersion: 1,
  attrsSchema: z.record(z.string(), z.unknown()),
  canonicalHash: "synthetic-light-v1",
} as never;

function registration(factory: AdapterRegistration<Record<string, never>>["factory"]): AdapterRegistration<Record<string, never>> {
  return {
    adapterType: "synthetic",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas: [schema],
    factory,
  };
}

function entry(bridgeId: string): BridgeConfigEntry<Record<string, never>> {
  return { bridgeId, adapterType: "synthetic", config: {} };
}

function event(epochId: string, seq: number, value: Record<string, unknown>) {
  return { epochId, seq, event: value } as never;
}

function snapshotEvents(
  bridgeId: string,
  remoteInstanceId: string,
  nativeId: string,
  identityClaims: readonly Record<string, unknown>[] = [],
  stateValue = "on",
): readonly ReturnType<typeof event>[] {
  const epochId = `${bridgeId}-epoch`;
  return [
    event(epochId, 1, {
      kind: "sync-start",
      snapshotId: `${epochId}-snapshot`,
      remoteInstanceId,
      reason: "initial",
    }),
    event(epochId, 2, {
      kind: "device-upserted",
      device: {
        nativeId,
        name: `${bridgeId} lamp`,
        capabilities: [{ nativeInstanceId: `${nativeId}:main`, schema: "synthetic.light", schemaVersion: "1.0.0" }],
        ...(identityClaims.length === 0 ? {} : { identityClaims }),
      },
    }),
    event(epochId, 3, {
      kind: "state",
      state: {
        nativeId,
        nativeInstanceId: `${nativeId}:main`,
        attrs: { state: stateValue },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }),
    event(epochId, 4, {
      kind: "sync-complete",
      manifest: { snapshotId: `${epochId}-snapshot`, deviceEnvelopeCount: 1, stateEnvelopeCount: 1 },
    }),
  ];
}

function bridge(bridgeId: string, remoteInstanceId: string, events: readonly ReturnType<typeof event>[]): SyntheticBridge {
  const value = new SyntheticBridge({ bridgeId, remoteInstanceId });
  for (const item of events) value.enqueue(item);
  return value;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for homeWorld identity integration");
}

function options(
  catalog: BridgeCatalog,
  registry: BridgeRegistry,
  bridges: readonly BridgeConfigEntry<Record<string, never>>[],
  overrides: Record<string, unknown> = {},
): HomeWorldServiceOptions {
  return {
    catalog,
    registry,
    bridges,
    maxRestarts: 0,
    monitorIntervalMs: 0,
    scheduler: { wait: async () => undefined },
    ...overrides,
  } as never;
}

test("aggregates an accepted physical device by hwId while retaining both controlled bindings", async () => {
  const catalog = new BridgeCatalog();
  const physicalClaim = {
    type: "serial",
    value: "physical-serial-a",
    source: { kind: "independent_registry", registry: "test-registry" },
    confidence: "high",
  };
  const adapters = new Map([
    ["bridge-a", bridge("bridge-a", "remote-a", snapshotEvents("bridge-a", "remote-a", "native-a", [physicalClaim]))],
    ["bridge-b", bridge("bridge-b", "remote-b", snapshotEvents("bridge-b", "remote-b", "native-b", [physicalClaim]))],
  ]);
  catalog.register(registration((ctx) => adapters.get(ctx.bridgeId)!));
  const registry = new BridgeRegistry({ catalog });
  const context = new Context();
  const fiber = await context.plugin(HomeWorldService, options(catalog, registry, [entry("bridge-a"), entry("bridge-b")]));

  await waitFor(() => context.homeWorld.snapshot().bridges["bridge-a"]?.diagnostics.connectionState === "ready"
    && context.homeWorld.snapshot().bridges["bridge-b"]?.diagnostics.connectionState === "ready");
  const device = context.homeWorld.snapshot().devices[0] as unknown as {
    hwId?: string;
    bindings?: readonly { bridgeId: string; nativeId: string; nativeInstanceId: string }[];
    capabilities?: readonly { hwCapabilityId?: string; bindings?: readonly unknown[] }[];
  } | undefined;

  assert.ok(device?.hwId);
  assert.deepEqual(device?.bindings?.map((binding) => binding.bridgeId).sort(), ["bridge-a", "bridge-b"]);
  assert.equal(new Set(device?.capabilities?.map((capability) => capability.hwCapabilityId)).size, 2);
  assert.equal(device?.capabilities?.every((capability) => capability.bindings?.length === 1), true);

  await fiber.dispose();
});

test("keeps same-schema capabilities separate and exposes low-qualification identity as proposals", async () => {
  const catalog = new BridgeCatalog();
  const lowClaim = {
    type: "other",
    value: "platform-device-a",
    source: { kind: "platform_registry", platform: "test-platform" },
    confidence: "high",
  };
  const adapters = new Map([
    ["bridge-a", bridge("bridge-a", "remote-a", snapshotEvents("bridge-a", "remote-a", "native-a", [lowClaim]))],
    ["bridge-b", bridge("bridge-b", "remote-b", snapshotEvents("bridge-b", "remote-b", "native-b", [lowClaim]))],
  ]);
  catalog.register(registration((ctx) => adapters.get(ctx.bridgeId)!));
  const registry = new BridgeRegistry({ catalog });
  const context = new Context();
  const fiber = await context.plugin(HomeWorldService, options(catalog, registry, [entry("bridge-a"), entry("bridge-b")]));

  await waitFor(() => context.homeWorld.snapshot().bridges["bridge-a"]?.diagnostics.connectionState === "ready"
    && context.homeWorld.snapshot().bridges["bridge-b"]?.diagnostics.connectionState === "ready");
  const service = context.homeWorld as unknown as {
    identity?: { proposals(): readonly { kind: string; requiresHumanApproval: boolean }[] };
  };
  const devices = context.homeWorld.snapshot().devices as unknown as readonly { hwId?: string; capabilities?: readonly { hwCapabilityId?: string }[] }[];

  assert.ok(service.identity);
  assert.equal(new Set(devices.map((device) => device.hwId)).size, 2);
  assert.equal(new Set(devices.flatMap((device) => device.capabilities?.map((capability) => capability.hwCapabilityId) ?? [])).size, 2);
  assert.equal(service.identity?.proposals().some((proposal) => proposal.kind === "identity-link" && proposal.requiresHumanApproval), true);

  await fiber.dispose();
});

class ManualAuthorityResyncPort {
  calls: string[] = [];
  snapshot: AuthorityResyncSnapshot | undefined;

  readonly port = {
    requestResync: async (bridgeId: string) => {
      this.calls.push(bridgeId);
      return { status: "completed" as const };
    },
    waitForSyncComplete: async () => {
      if (this.snapshot === undefined) throw new Error("test snapshot not configured");
      return this.snapshot;
    },
  };
}

class UncommittedChoiceAuthority extends AuthorityCoordinator {
  override chooseStateAuthority(
    _hwCapabilityId: string,
    _availability: readonly AuthorityAvailability[],
    _preferredBridgeId?: string,
  ): StateAuthorityChoice {
    return { status: "available", bridgeId: "bridge-b" };
  }
}

class ControlledWatermarkJournal extends SqliteIngestJournal {
  resyncRequested = false;
  nextWatermark: JournalWatermark | undefined;
  nextConsistentWatermark: JournalWatermark | undefined;
  private resyncWatermarkReads = 0;

  override watermark(bridgeId: string): JournalWatermark | undefined {
    if (bridgeId === "bridge-a" && this.resyncRequested && this.nextWatermark !== undefined) {
      if (this.resyncWatermarkReads++ === 0) return super.watermark(bridgeId);
      return { ...this.nextWatermark };
    }
    return super.watermark(bridgeId);
  }

  override consistentWatermark(bridgeId: string): JournalWatermark | undefined {
    if (bridgeId === "bridge-a" && this.nextConsistentWatermark !== undefined) {
      return { ...this.nextConsistentWatermark };
    }
    return super.consistentWatermark(bridgeId);
  }
}

function fixedIdentityManager(): WorldIdentityManager {
  let sequence = 0;
  return new WorldIdentityManager({
    idFactory: (kind) => {
      if (kind === "hw") return "hw-shared";
      if (kind === "hwCapability") return "hc-shared";
      return `${kind}-${++sequence}`;
    },
  });
}

function authorityCapability() {
  return {
    hwCapabilityId: "hc-shared",
    hwId: "hw-shared",
    schema: "synthetic.light",
    bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "native-a:main" }],
  };
}

test("snapshot reads only the committed state authority and never chooser fallback", async () => {
  const catalog = new BridgeCatalog();
  const adapter = bridge("bridge-a", "remote-a", snapshotEvents("bridge-a", "remote-a", "native-a", [], "on"));
  catalog.register(registration(() => adapter));
  const registry = new BridgeRegistry({ catalog });
  const authority = new UncommittedChoiceAuthority({
    capabilities: [authorityCapability()],
    initialStateAuthorities: { "hc-shared": "bridge-a" },
  });
  const context = new Context();
  const fiber = await context.plugin(HomeWorldService, options(catalog, registry, [entry("bridge-a")], {
    authorityCoordinator: authority,
    identityManager: fixedIdentityManager(),
  }));

  try {
    await waitFor(() => context.homeWorld.snapshot().bridges["bridge-a"]?.diagnostics.connectionState === "ready");
    const device = context.homeWorld.snapshot().devices[0];
    assert.equal(device?.states[0]?.attrs.state, "on");
    assert.equal(authority.currentStateAuthority("hc-shared"), "bridge-a");
  } finally {
    await fiber.dispose();
  }
});

test("homeWorld authority resync waits for a new consistent watermark epoch", async () => {
  const catalog = new BridgeCatalog();
  const adapter = bridge("bridge-a", "remote-a", snapshotEvents("bridge-a", "remote-a", "native-a"));
  catalog.register(registration(() => adapter));
  const registry = new BridgeRegistry({ catalog });
  const journal = new ControlledWatermarkJournal(":memory:");
  const context = new Context();
  const fiber = await context.plugin(HomeWorldService, options(catalog, registry, [entry("bridge-a")], {
    identityManager: fixedIdentityManager(),
    journalFactory: () => journal,
    scheduler: { wait: async () => new Promise<void>((resolve) => setTimeout(resolve, 1)) },
  }));

  try {
    await waitFor(() => context.homeWorld.snapshot().bridges["bridge-a"]?.diagnostics.connectionState === "ready");
    journal.resyncRequested = true;
    journal.nextWatermark = { epochId: "epoch-b", lastSeq: 4 };
    const port = (context.homeWorld as unknown as {
      createAuthorityResyncPort(): {
        requestResync(bridgeId: string, signal?: AbortSignal): Promise<{ status: string }>;
        waitForSyncComplete(bridgeId: string, generation: number, signal?: AbortSignal): Promise<AuthorityResyncSnapshot>;
      };
    }).createAuthorityResyncPort();

    assert.deepEqual(await port.requestResync("bridge-a"), { status: "completed" });
    let settled = false;
    const pending = port.waitForSyncComplete("bridge-a", 1).then((snapshot) => {
      settled = true;
      return snapshot;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(settled, false);

    journal.nextConsistentWatermark = { epochId: "epoch-b", lastSeq: 4 };
    const result = await pending;
    assert.equal(result.epochId, "epoch-b");
  } finally {
    await fiber.dispose();
  }
});

test("delegates candidate authority changes through one bridge resync and keeps action authority fail-closed", async () => {
  const catalog = new BridgeCatalog();
  const adapters = new Map([
    ["bridge-a", bridge("bridge-a", "remote-a", snapshotEvents("bridge-a", "remote-a", "native-a", [], "a"))],
    ["bridge-b", bridge("bridge-b", "remote-b", snapshotEvents("bridge-b", "remote-b", "native-b", [], "b"))],
  ]);
  catalog.register(registration((ctx) => adapters.get(ctx.bridgeId)!));
  const resync = new ManualAuthorityResyncPort();
  const authority = new AuthorityCoordinator({
    capabilities: [{
      hwCapabilityId: "hc-shared",
      hwId: "hw-shared",
      schema: "synthetic.light",
      bindings: [
        { bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "native-a:main" },
        { bridgeId: "bridge-b", nativeId: "native-b", nativeInstanceId: "native-b:main" },
      ],
    }],
    initialStateAuthorities: { "hc-shared": "bridge-a" },
    resyncPort: resync.port,
  });
  const registry = new BridgeRegistry({ catalog });
  const context = new Context();
  const fiber = await context.plugin(HomeWorldService, options(catalog, registry, [entry("bridge-a"), entry("bridge-b")], {
    authorityCoordinator: authority,
    authorityResyncPort: resync.port,
  }));

  await waitFor(() => context.homeWorld.snapshot().bridges["bridge-a"]?.diagnostics.connectionState === "ready"
    && context.homeWorld.snapshot().bridges["bridge-b"]?.diagnostics.connectionState === "ready");
  resync.snapshot = {
    bridgeId: "bridge-b",
    epochId: "bridge-b-authority-epoch",
    bindings: [{
      hwCapabilityId: "hc-shared",
      nativeId: "native-b",
      nativeInstanceId: "native-b:main",
      validity: "valid",
    }],
  };
  const service = context.homeWorld as unknown as {
    authority?: AuthorityCoordinator;
    reconcileStateAuthority?: (hwCapabilityId: string, preferredBridgeId?: string) => Promise<{ status: string; authority?: string }>;
    resolveActionAuthority?: (hwCapabilityId: string) => { status: string; reason?: string };
  };

  assert.ok(service.authority);
  assert.equal(typeof service.reconcileStateAuthority, "function");
  const switched = await service.reconcileStateAuthority?.("hc-shared", "bridge-b");
  assert.deepEqual(switched, { hwCapabilityId: "hc-shared", status: "switched", authority: "bridge-b" });
  assert.deepEqual(resync.calls, ["bridge-b"]);
  assert.deepEqual(service.resolveActionAuthority?.("hc-shared"), { status: "unavailable", reason: "not_configured" });

  await fiber.dispose();
});
