import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { BridgeCatalog } from "./bridge-catalog.js";
import { BridgeRegistry } from "./bridge-registry.js";
import {
  createXiaomiHomeAdapterRegistration,
  type XiaomiHomeChange,
  type XiaomiHomeTransport,
} from "./xiaomi-home-bridge.js";
import { InMemoryOneShotActionStore } from "../authority/one-shot-action-plane.js";
import { HouseholdReviewCenterService } from "../home/household-review-center-service.js";
import { SqliteIngestJournal } from "../world/ingest-journal.js";
import { HomeWorldService } from "../world/home-world-service.js";
import { WorldIdentityManager } from "../world/world-identity.js";

const BRIDGE_ID = "xiaomi-cn-home";
const CAPABILITY_ID = "hwc-xiaomi-living-room-light";

const initialSnapshot = {
  installationId: "authorized-fixture:living-room",
  devices: [{
    did: "miot-living-room-light",
    name: "客厅灯",
    online: true,
    properties: [{
      siid: 2,
      piid: 1,
      value: true,
      format: "bool",
      writable: true,
      semanticKind: "light" as const,
    }],
  }],
} as const;

class WritableXiaomiTransport implements XiaomiHomeTransport {
  readonly writes: { readonly did: string; readonly siid: number; readonly piid: number; readonly value: unknown }[] = [];
  private readonly queued: XiaomiHomeChange[] = [];
  private waiting: ((change: XiaomiHomeChange | undefined) => void) | undefined;
  private closed = false;
  private lightOn = true;

  constructor(private readonly observationAfterWrite: "correct" | "missing" | "inverse" = "correct") {}

  async connect(): Promise<typeof initialSnapshot> {
    return initialSnapshot;
  }

  async *changes(signal: AbortSignal): AsyncIterable<XiaomiHomeChange> {
    while (!signal.aborted && !this.closed) {
      const change = await this.nextChange(signal);
      if (change === undefined) return;
      yield change;
    }
  }

  async resync(): Promise<typeof initialSnapshot> {
    return {
      ...initialSnapshot,
      devices: initialSnapshot.devices.map((device) => ({
        ...device,
        properties: device.properties.map((property) => ({ ...property, value: this.lightOn })),
      })),
    };
  }

  async setProperty(input: { readonly did: string; readonly siid: number; readonly piid: number; readonly value: unknown; readonly signal: AbortSignal }): Promise<void> {
    this.writes.push({ did: input.did, siid: input.siid, piid: input.piid, value: input.value });
    if (typeof input.value !== "boolean") throw new TypeError("fixture only accepts boolean MIoT values");
    if (this.observationAfterWrite === "missing") return;
    this.lightOn = this.observationAfterWrite === "inverse" ? !input.value : input.value;
    this.push({
      kind: "property",
      did: input.did,
      property: {
        siid: input.siid,
        piid: input.piid,
        value: this.lightOn,
        format: "bool",
        writable: true,
        semanticKind: "light",
      },
    });
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.(undefined);
  }

  markDeviceUnavailable(): void {
    this.push({ kind: "online", did: "miot-living-room-light", online: false });
  }

  private push(change: XiaomiHomeChange): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    if (waiting === undefined) this.queued.push(change);
    else waiting(change);
  }

  private nextChange(signal: AbortSignal): Promise<XiaomiHomeChange | undefined> {
    const next = this.queued.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => {
      const abort = () => {
        if (this.waiting !== undefined) this.waiting = undefined;
        resolve(undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting = (change) => {
        signal.removeEventListener("abort", abort);
        resolve(change);
      };
    });
  }
}

function identityManager(): WorldIdentityManager {
  return new WorldIdentityManager({
    idFactory: (kind) => ({
      hw: "hw-xiaomi-living-room-light",
      hwCapability: CAPABILITY_ID,
      hwSpace: "hws-xiaomi-living-room",
      proposal: "proposal-xiaomi",
      audit: "audit-xiaomi",
    })[kind],
  });
}

async function waitForReady(context: Context): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (context.homeWorld.snapshot().bridges[BRIDGE_ID]?.diagnostics.connectionState === "ready") return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Xiaomi peer did not become ready");
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("an authorized writable Xiaomi peer crosses governed action and verified read-back without Home Assistant", async () => {
  const transport = new WritableXiaomiTransport();
  const catalog = new BridgeCatalog();
  catalog.register(createXiaomiHomeAdapterRegistration({
    credentialRequirements: [],
    create: () => transport,
  }));
  const context = new Context();
  const worldFiber = await context.plugin(HomeWorldService, {
    catalog,
    registry: new BridgeRegistry({ catalog }),
    bridges: [{ bridgeId: BRIDGE_ID, adapterType: "xiaomi-home", config: { region: "cn", transport: "cloud" } }],
    journalFactory: () => new SqliteIngestJournal(":memory:"),
    identityManager: identityManager(),
    actionAuthorityConfig: {
      [CAPABILITY_ID]: {
        bridgeId: BRIDGE_ID,
        approved: true,
        policyClass: "direct",
        configIdentity: `sha256:${"a".repeat(64)}`,
        configRevision: 1,
      },
    },
    maxRestarts: 0,
    monitorIntervalMs: 0,
  });
  const reviewFiber = await context.plugin(HouseholdReviewCenterService, {
    store: new InMemoryOneShotActionStore(),
    actionDescriptorSource: { actionDescriptorFor: (capabilityId) => context.homeWorld.actionDescriptorFor(capabilityId) },
    verificationWindowMs: 100,
    verificationPollMs: 1,
    maxVerificationReads: 5,
    sleep: async () => new Promise<void>((resolve) => setImmediate(resolve)),
  });

  try {
    await waitForReady(context);
    const result = await context.homeReviewCenter.requestAction({
      requestId: "xiaomi-living-room-light-off",
      capabilityId: CAPABILITY_ID,
      summary: "关闭客厅灯",
      action: { kind: "set_boolean", value: false },
      actor: {
        principalId: "member-1",
        role: "adult_member",
        present: true,
        device: { kind: "private", boundPrincipalId: "member-1" },
      },
    });

    for (let attempt = 0; attempt < 10; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(result.status, "verified", JSON.stringify({ result, writes: transport.writes, state: context.homeWorld.snapshot().devices[0]?.states[0]?.attrs }));
    assert.equal(result.ticket.afterValue, false);
    assert.deepEqual(transport.writes, [{
      did: "miot-living-room-light",
      siid: 2,
      piid: 1,
      value: false,
    }]);
    assert.equal(context.homeWorld.snapshot().devices[0]?.states[0]?.attrs.value, false);
  } finally {
    await reviewFiber.dispose();
    await worldFiber.dispose();
  }
});

test("a Xiaomi acknowledgement without matching observed state never becomes verified", async () => {
  for (const observationAfterWrite of ["missing", "inverse"] as const) {
    const transport = new WritableXiaomiTransport(observationAfterWrite);
    const catalog = new BridgeCatalog();
    catalog.register(createXiaomiHomeAdapterRegistration({
      credentialRequirements: [],
      create: () => transport,
    }));
    const context = new Context();
    const worldFiber = await context.plugin(HomeWorldService, {
      catalog,
      registry: new BridgeRegistry({ catalog }),
      bridges: [{ bridgeId: BRIDGE_ID, adapterType: "xiaomi-home", config: { region: "cn", transport: "cloud" } }],
      journalFactory: () => new SqliteIngestJournal(":memory:"),
      identityManager: identityManager(),
      actionAuthorityConfig: {
        [CAPABILITY_ID]: {
          bridgeId: BRIDGE_ID,
          approved: true,
          policyClass: "direct",
          configIdentity: `sha256:${"c".repeat(64)}`,
          configRevision: 1,
        },
      },
      maxRestarts: 0,
      monitorIntervalMs: 0,
    });
    const reviewFiber = await context.plugin(HouseholdReviewCenterService, {
      store: new InMemoryOneShotActionStore(),
      actionDescriptorSource: { actionDescriptorFor: (capabilityId) => context.homeWorld.actionDescriptorFor(capabilityId) },
      verificationWindowMs: 100,
      verificationPollMs: 1,
      maxVerificationReads: 3,
      sleep: async () => new Promise<void>((resolve) => setImmediate(resolve)),
    });

    try {
      await waitForReady(context);
      const result = await context.homeReviewCenter.requestAction({
        requestId: `xiaomi-unobserved-${observationAfterWrite}`,
        capabilityId: CAPABILITY_ID,
        summary: "关闭客厅灯",
        action: { kind: "set_boolean", value: false },
        actor: {
          principalId: "member-1",
          role: "adult_member",
          present: true,
          device: { kind: "private", boundPrincipalId: "member-1" },
        },
      });

      assert.equal(result.status, "failed", `${observationAfterWrite} observation did not settle as a mismatch`);
      assert.equal(result.reason, "postcondition_mismatch");
      assert.deepEqual(transport.writes, [{
        did: "miot-living-room-light",
        siid: 2,
        piid: 1,
        value: false,
      }]);
    } finally {
      await reviewFiber.dispose();
      await worldFiber.dispose();
    }
  }
});

test("a Xiaomi action stays fail-closed when its once-live bound device becomes unavailable", async () => {
  const transport = new WritableXiaomiTransport();
  const catalog = new BridgeCatalog();
  catalog.register(createXiaomiHomeAdapterRegistration({
    credentialRequirements: [],
    create: () => transport,
  }));
  const context = new Context();
  const worldFiber = await context.plugin(HomeWorldService, {
    catalog,
    registry: new BridgeRegistry({ catalog }),
    bridges: [{ bridgeId: BRIDGE_ID, adapterType: "xiaomi-home", config: { region: "cn", transport: "cloud" } }],
    journalFactory: () => new SqliteIngestJournal(":memory:"),
    identityManager: identityManager(),
    actionAuthorityConfig: {
      [CAPABILITY_ID]: {
        bridgeId: BRIDGE_ID,
        approved: true,
        policyClass: "direct",
        configIdentity: `sha256:${"b".repeat(64)}`,
        configRevision: 1,
      },
    },
    maxRestarts: 0,
    monitorIntervalMs: 0,
  });
  const reviewFiber = await context.plugin(HouseholdReviewCenterService, {
    store: new InMemoryOneShotActionStore(),
    actionDescriptorSource: { actionDescriptorFor: (capabilityId) => context.homeWorld.actionDescriptorFor(capabilityId) },
  });

  try {
    await waitForReady(context);
    assert.deepEqual(context.homeReviewCenter.actionDescriptorFor(CAPABILITY_ID)?.action, {
      kind: "set_boolean",
      value: false,
    });

    transport.markDeviceUnavailable();
    await waitFor(
      () => context.homeReviewCenter.actionDescriptorFor(CAPABILITY_ID) === undefined,
      "offline Xiaomi device remained action-eligible",
    );
    const result = await context.homeReviewCenter.requestAction({
      requestId: "xiaomi-offline-action",
      capabilityId: CAPABILITY_ID,
      summary: "关闭客厅灯",
      action: { kind: "set_boolean", value: false },
      actor: {
        principalId: "member-1",
        role: "adult_member",
        present: true,
        device: { kind: "private", boundPrincipalId: "member-1" },
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.reason, "bridge_rejected");
    assert.deepEqual(transport.writes, []);
  } finally {
    await reviewFiber.dispose();
    await worldFiber.dispose();
  }
});

test("a Xiaomi property remains unwritable until the household has configured and approved it", async () => {
  const transport = new WritableXiaomiTransport();
  const catalog = new BridgeCatalog();
  catalog.register(createXiaomiHomeAdapterRegistration({
    credentialRequirements: [],
    create: () => transport,
  }));
  const context = new Context();
  const worldFiber = await context.plugin(HomeWorldService, {
    catalog,
    registry: new BridgeRegistry({ catalog }),
    bridges: [{ bridgeId: BRIDGE_ID, adapterType: "xiaomi-home", config: { region: "cn", transport: "cloud" } }],
    journalFactory: () => new SqliteIngestJournal(":memory:"),
    identityManager: identityManager(),
    maxRestarts: 0,
    monitorIntervalMs: 0,
  });
  const reviewFiber = await context.plugin(HouseholdReviewCenterService, {
    store: new InMemoryOneShotActionStore(),
    actionDescriptorSource: { actionDescriptorFor: (capabilityId) => context.homeWorld.actionDescriptorFor(capabilityId) },
  });

  try {
    await waitForReady(context);
    assert.equal(context.homeReviewCenter.actionDescriptorFor(CAPABILITY_ID), undefined);
    const result = await context.homeReviewCenter.requestAction({
      requestId: "xiaomi-unapproved-action",
      capabilityId: CAPABILITY_ID,
      summary: "关闭客厅灯",
      action: { kind: "set_boolean", value: false },
      actor: {
        principalId: "member-1",
        role: "adult_member",
        present: true,
        device: { kind: "private", boundPrincipalId: "member-1" },
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.reason, "action_authority_unavailable");
    assert.deepEqual(transport.writes, []);
  } finally {
    await reviewFiber.dispose();
    await worldFiber.dispose();
  }
});
