import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";

import {
  type BridgeEvent,
  type Envelope,
  type WorldCapability,
} from "@hob/bridge-contract";
import { BridgeCatalog, type AdapterRegistration } from "../bridge/bridge-catalog.js";
import { BridgeRegistry, type BridgeConfigEntry } from "../bridge/bridge-registry.js";
import { AuthorityCoordinator } from "../authority/authority-coordinator.js";
import { SqliteIngestJournal } from "./ingest-journal.js";
import { SyntheticBridge } from "@hob/bridge-contract/testing";
import { HomeWorldService } from "./home-world-service.js";
import { WorldIdentityManager } from "./world-identity.js";

const schema = {
  schema: "synthetic.light",
  majorVersion: 1,
  attrsSchema: z.object({ state: z.string() }).strict(),
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

function frame(epochId: string, seq: number, event: BridgeEvent): Envelope {
  return { epochId, seq, event };
}

function readyEvents(bridgeId: string): readonly Envelope[] {
  const epochId = `${bridgeId}-epoch`;
  return [
    frame(epochId, 1, {
      kind: "sync-start",
      snapshotId: `${epochId}-snapshot`,
      remoteInstanceId: `${bridgeId}-remote`,
      reason: "initial",
    }),
    frame(epochId, 2, {
      kind: "device-upserted",
      device: {
        nativeId: "light.living_room",
        name: "Living room light",
        capabilities: [{
          nativeInstanceId: "light.living_room:main",
          schema: "synthetic.light",
          schemaVersion: "1.0.0",
        }],
      },
    }),
    frame(epochId, 3, {
      kind: "state",
      state: {
        nativeId: "light.living_room",
        nativeInstanceId: "light.living_room:main",
        attrs: { state: "on" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }),
    frame(epochId, 4, {
      kind: "sync-complete",
      manifest: { snapshotId: `${epochId}-snapshot`, deviceEnvelopeCount: 1, stateEnvelopeCount: 1 },
    }),
  ];
}

function capability(hwCapabilityId: string, bridgeId = "bridge-bindings"): WorldCapability {
  return {
    hwCapabilityId,
    hwId: "hw-living-room",
    schema: "synthetic.light",
    bindings: [{
      bridgeId,
      nativeId: "light.living_room",
      nativeInstanceId: "light.living_room:main",
    }],
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for homeWorld");
}

async function setup(options: {
  readonly capabilities?: readonly WorldCapability[];
  readonly bridgeId?: string;
} = {}): Promise<{ readonly service: HomeWorldService; readonly fiber: { dispose(): Promise<void> } }> {
  const bridgeId = options.bridgeId ?? "bridge-bindings";
  const bridge = new SyntheticBridge({
    bridgeId,
    remoteInstanceId: `${bridgeId}-remote`,
  });
  for (const event of readyEvents(bridgeId)) bridge.enqueue(event);

  const catalog = new BridgeCatalog();
  catalog.register(registration(() => bridge));
  const registry = new BridgeRegistry({ catalog });
  const context = new Context();
  const primaryCapabilityId = options.capabilities?.[0]?.hwCapabilityId ?? "hwc-runtime";
  const fiber = await context.plugin(HomeWorldService, {
    catalog,
    registry,
    bridges: [entry(bridgeId)],
    journalFactory: () => new SqliteIngestJournal(":memory:"),
    maxRestarts: 0,
    monitorIntervalMs: 0,
    scheduler: { wait: async () => undefined },
    authorityCoordinator: new AuthorityCoordinator({ capabilities: options.capabilities ?? [] }),
    identityManager: new WorldIdentityManager({
      idFactory: (kind) => kind === "hwCapability" ? primaryCapabilityId
        : kind === "hw" ? "hw-living-room"
          : `${kind}-migration-test`,
    }),
  });
  await waitFor(() => context.homeWorld.snapshot().bridges[bridgeId]?.diagnostics.connectionState === "ready");
  return { service: context.homeWorld, fiber };
}

test("resolves one current valid bridge binding to a fresh BridgeActionTarget", async () => {
  const { service, fiber } = await setup({ capabilities: [capability("hwc-living-room")] });
  try {
    const result = service.resolveBridgeActionTargetForBinding({
      bridgeId: "bridge-bindings",
      nativeId: "light.living_room",
      nativeInstanceId: "light.living_room:main",
    });

    assert.deepEqual(result, {
      hwCapabilityId: "hwc-living-room",
      binding: {
        bridgeId: "bridge-bindings",
        nativeId: "light.living_room",
        nativeInstanceId: "light.living_room:main",
      },
    });
    const second = service.resolveBridgeActionTargetForBinding({
      bridgeId: "bridge-bindings",
      nativeId: "light.living_room",
      nativeInstanceId: "light.living_room:main",
    });
    assert.notEqual(result, second);
    assert.notEqual(result?.binding, second?.binding);
  } finally {
    await fiber.dispose();
  }
});

test("ignores provider-shaped fields while returning only the neutral target", async () => {
  const { service, fiber } = await setup({ capabilities: [capability("hwc-provider-shaped")] });
  try {
    const result = service.resolveBridgeActionTargetForBinding({
      bridgeId: "bridge-bindings",
      nativeId: "light.living_room",
      nativeInstanceId: "light.living_room:main",
      entity_id: "light.living_room",
      raw: { state: "on", attributes: { secret: "must-not-escape" } },
    });

    assert.deepEqual(result, {
      hwCapabilityId: "hwc-provider-shaped",
      binding: {
        bridgeId: "bridge-bindings",
        nativeId: "light.living_room",
        nativeInstanceId: "light.living_room:main",
      },
    });
    assert.equal("entity_id" in (result?.binding ?? {}), false);
    assert.equal("raw" in (result?.binding ?? {}), false);
  } finally {
    await fiber.dispose();
  }
});

test("fails closed for unknown, malformed, and oversized bridge bindings", async () => {
  const { service, fiber } = await setup({ capabilities: [capability("hwc-invalid-input")] });
  try {
    const invalidInputs: readonly unknown[] = [
      undefined,
      null,
      {},
      { bridgeId: "", nativeId: "light.living_room", nativeInstanceId: "light.living_room:main" },
      { bridgeId: "bridge-bindings", nativeId: "light.living_room", nativeInstanceId: " " },
      { bridgeId: "bridge-bindings", nativeId: "x".repeat(257), nativeInstanceId: "light.living_room:main" },
      { bridgeId: "bridge-bindings", nativeId: "light.living_room\u0000", nativeInstanceId: "light.living_room:main" },
      { bridgeId: 42, nativeId: "light.living_room", nativeInstanceId: "light.living_room:main" },
      { bridgeId: "bridge-bindings", nativeId: "missing-device", nativeInstanceId: "missing-device:main" },
      { bridgeId: "bridge-bindings", nativeId: "light.living_room", get nativeInstanceId() { throw new Error("provider detail"); } },
      new Proxy({}, { get() { throw new Error("provider proxy detail"); }, ownKeys() { throw new Error("provider keys detail"); } }),
    ];
    for (const input of invalidInputs) {
      assert.equal(service.resolveBridgeActionTargetForBinding(input), undefined);
    }
  } finally {
    await fiber.dispose();
  }
});

test("fails closed when one exact tuple is shared by multiple authority capabilities", async () => {
  const binding = capability("hwc-ambiguous-a");
  const { service, fiber } = await setup({
    capabilities: [binding, { ...capability("hwc-ambiguous-b"), bindings: binding.bindings.map((item) => ({ ...item })) }],
  });
  try {
    assert.equal(service.resolveBridgeActionTargetForBinding(binding.bindings[0]), undefined);
  } finally {
    await fiber.dispose();
  }
});

test("fails closed when the runtime capability is no longer valid", async () => {
  const { service, fiber } = await setup({ capabilities: [capability("hwc-invalid-runtime")] });
  try {
    const runtime = service.runtime("bridge-bindings");
    assert.ok(runtime);
    const result = await runtime.ingest.ingest(frame("bridge-bindings-epoch", 5, {
      kind: "state",
      state: {
        nativeId: "light.living_room",
        nativeInstanceId: "light.living_room:main",
        attrs: { state: "on", leaked: true },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }));
    assert.equal(result.accepted, false);
    assert.equal(runtime.ingest.worldSnapshot().get("light.living_room")?.validity, "invalid-source");
    assert.equal(service.resolveBridgeActionTargetForBinding(capability("hwc-invalid-runtime").bindings[0]), undefined);
  } finally {
    await fiber.dispose();
  }
});

test("fails closed when the binding bridge is not ready", async () => {
  const { service, fiber } = await setup({ capabilities: [capability("hwc-not-ready")] });
  try {
    service.runtime("bridge-bindings")?.ingest.recordStreamError("upstream_unavailable");
    assert.equal(service.snapshot().bridges["bridge-bindings"]?.diagnostics.connectionState, "degraded");
    assert.equal(service.resolveBridgeActionTargetForBinding(capability("hwc-not-ready").bindings[0]), undefined);
  } finally {
    await fiber.dispose();
  }
});
