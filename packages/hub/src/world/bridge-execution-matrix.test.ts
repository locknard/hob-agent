import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import {
  type ActionsExtension,
  type AutomationsExtension,
  type BridgeActionRequest,
  type BridgeAdapter,
  type BridgeAutomationSpec,
  type Envelope,
} from "@hob/bridge-contract";
import { z } from "zod";

import { BridgeCatalog, type AdapterRegistration } from "../bridge/bridge-catalog.js";
import { BridgeRegistry } from "../bridge/bridge-registry.js";
import { InMemoryOneShotActionStore } from "../authority/one-shot-action-plane.js";
import { HouseholdReviewCenterService } from "../home/household-review-center-service.js";
import { BridgeAutomationDeployment } from "../home/bridge-automation-deployment.js";
import { SqliteIngestJournal } from "./ingest-journal.js";
import { HomeWorldService } from "./home-world-service.js";
import { WorldIdentityManager } from "./world-identity.js";

const PEER_BRIDGE_ID = "test-peer";
const PEER_CAPABILITY_ID = "hwc-test-switch";

/**
 * Test-only peer adapter. It deliberately has no Home Assistant type, native
 * payload, or registration: this file proves the neutral adapter seam alone
 * reaches both governed execution paths.
 */
class TestOnlyPeerAdapter implements BridgeAdapter {
  readonly info = {
    bridgeId: PEER_BRIDGE_ID,
    coreVersion: "6.3.0",
    ecosystem: "test-peer",
    heartbeatIntervalMs: 60_000,
    extensions: [
      { id: "actions", version: "1.0.0" },
      { id: "automations", version: "1.0.0" },
    ],
  } as const;

  readonly executed: BridgeActionRequest[] = [];
  readonly deployed: BridgeAutomationSpec[] = [];
  readonly control = {
    requestResync: async () => ({ status: "completed" as const }),
    dispose: async () => { this.close(); },
  };

  private readonly deliveries: Delivery[] = [];
  private readonly automations = new Map<string, { readonly fingerprint: string; enabled: boolean }>();
  private waiting: ((delivery: Delivery | undefined) => void) | undefined;
  private closed = false;
  private nextSequence = 5;

  private readonly actionHandle: ActionsExtension = {
    describe: (request) => ({
      action: { kind: "set_boolean", value: request.current.state !== "on" },
      reversible: true,
      label: "Peer switch",
    }),
    execute: async (request) => {
      this.executed.push(request);
      if (request.action.kind !== "set_boolean"
        || request.action.target.binding.bridgeId !== PEER_BRIDGE_ID
        || request.action.target.binding.nativeId !== "peer-switch"
        || request.action.target.binding.nativeInstanceId !== "peer-switch:main") {
        return { status: "rejected", reason: "invalid_target" };
      }
      await this.emit({
        epochId: "peer-epoch",
        seq: this.nextSequence++,
        event: {
          kind: "state",
          state: {
            nativeId: "peer-switch",
            nativeInstanceId: "peer-switch:main",
            attrs: { state: request.action.value ? "on" : "off", value: request.action.value },
            time: { sourceTsQuality: "none" },
            origin: "observed",
          },
        },
      });
      return { status: "acknowledged" };
    },
  };

  private readonly automationHandle: AutomationsExtension = {
    deploy: async (spec) => {
      this.deployed.push(spec);
      const fingerprint = `peer:${spec.automationId}`;
      this.automations.set(spec.automationId, { fingerprint, enabled: true });
      return { status: "deployed", nativeAutomationId: spec.automationId, configFingerprint: fingerprint };
    },
    status: async ({ nativeAutomationId }) => {
      const automation = this.automations.get(nativeAutomationId);
      if (automation === undefined) return { status: "missing" };
      return { status: automation.enabled ? "running" : "paused", configFingerprint: automation.fingerprint };
    },
    setEnabled: async ({ nativeAutomationId, enabled }) => {
      const automation = this.automations.get(nativeAutomationId);
      if (automation === undefined) return { status: "rejected", reason: "not_found" };
      automation.enabled = enabled;
      return { status: "acknowledged" };
    },
    withdraw: async ({ nativeAutomationId }) => {
      return this.automations.delete(nativeAutomationId)
        ? { status: "acknowledged" }
        : { status: "rejected", reason: "not_found" };
    },
  };

  constructor() {
    this.emitInitialSnapshot();
  }

  async *events(signal: AbortSignal): AsyncIterable<Envelope> {
    while (!signal.aborted && !this.closed) {
      const delivery = await this.next(signal);
      if (delivery === undefined) return;
      yield delivery.envelope;
      delivery.consumed();
    }
  }

  extension<K extends keyof import("@hob/bridge-contract").ExtensionHandleRegistry>(
    name: K,
  ): import("@hob/bridge-contract").ExtensionHandleRegistry[K] | undefined {
    if (name === "actions@1") return this.actionHandle as never;
    if (name === "automations@1") return this.automationHandle as never;
    return undefined;
  }

  private emitInitialSnapshot(): void {
    void this.emit({
      epochId: "peer-epoch",
      seq: 1,
      event: { kind: "sync-start", snapshotId: "peer-snapshot", remoteInstanceId: "peer-instance", reason: "initial" },
    });
    void this.emit({
      epochId: "peer-epoch",
      seq: 2,
      event: {
        kind: "device-upserted",
        device: {
          nativeId: "peer-switch",
          name: "Peer switch",
          capabilities: [{
            nativeInstanceId: "peer-switch:main",
            schema: "peer.switch",
            schemaVersion: "1.0.0",
            semanticKind: "switch",
          }],
        },
      },
    });
    void this.emit({
      epochId: "peer-epoch",
      seq: 3,
      event: {
        kind: "state",
        state: {
          nativeId: "peer-switch",
          nativeInstanceId: "peer-switch:main",
          attrs: { state: "on", value: true },
          time: { sourceTsQuality: "none" },
          origin: "observed",
        },
      },
    });
    void this.emit({
      epochId: "peer-epoch",
      seq: 4,
      event: { kind: "sync-complete", manifest: { snapshotId: "peer-snapshot", deviceEnvelopeCount: 1, stateEnvelopeCount: 1 } },
    });
  }

  private emit(envelope: Envelope): Promise<void> {
    return new Promise<void>((resolve) => {
      const delivery: Delivery = { envelope, consumed: resolve };
      const waiting = this.waiting;
      this.waiting = undefined;
      if (waiting !== undefined) waiting(delivery);
      else this.deliveries.push(delivery);
    });
  }

  private next(signal: AbortSignal): Promise<Delivery | undefined> {
    const delivery = this.deliveries.shift();
    if (delivery !== undefined) return Promise.resolve(delivery);
    return new Promise<Delivery | undefined>((resolve) => {
      const abort = () => {
        if (this.waiting !== undefined) this.waiting = undefined;
        resolve(undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting = (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
    });
  }

  private close(): void {
    this.closed = true;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.(undefined);
  }
}

interface Delivery {
  readonly envelope: Envelope;
  consumed(): void;
}

function peerRegistration(adapter: TestOnlyPeerAdapter): AdapterRegistration<Record<string, never>> {
  return {
    adapterType: "test-peer",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas: [{
      schema: "peer.switch",
      majorVersion: 1,
      attrsSchema: z.record(z.string(), z.unknown()),
      canonicalHash: "peer-switch-v1",
    }] as never,
    factory: () => adapter,
  };
}

function deterministicIdentityManager(): WorldIdentityManager {
  return new WorldIdentityManager({
    idFactory: (kind) => ({
      hw: "hw-test-switch",
      hwCapability: PEER_CAPABILITY_ID,
      hwSpace: "hws-test-peer",
      proposal: "proposal-test-peer",
      audit: "audit-test-peer",
    })[kind],
  });
}

async function waitForReady(context: Context): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (context.homeWorld.snapshot().bridges[PEER_BRIDGE_ID]?.diagnostics.connectionState === "ready") return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("test peer did not become ready");
}

test("a test-only peer crosses the neutral execution matrix without a Home Assistant adapter", async () => {
  const adapter = new TestOnlyPeerAdapter();
  const catalog = new BridgeCatalog();
  catalog.register(peerRegistration(adapter));
  const context = new Context();
  const worldFiber = await context.plugin(HomeWorldService, {
    catalog,
    registry: new BridgeRegistry({ catalog }),
    bridges: [{ bridgeId: PEER_BRIDGE_ID, adapterType: "test-peer", config: {} }],
    journalFactory: () => new SqliteIngestJournal(":memory:"),
    identityManager: deterministicIdentityManager(),
    actionAuthorityConfig: {
      [PEER_CAPABILITY_ID]: {
        bridgeId: PEER_BRIDGE_ID,
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
    maxVerificationReads: 3,
    sleep: async () => new Promise<void>((resolve) => setImmediate(resolve)),
  });

  try {
    await waitForReady(context);
    assert.deepEqual(context.homeWorld.snapshot().devices.map((device) => device.bridgeId), [PEER_BRIDGE_ID]);
    assert.deepEqual(context.homeReviewCenter.actionDescriptorFor(PEER_CAPABILITY_ID), {
      action: { kind: "set_boolean", value: false },
      reversible: true,
      label: "Peer switch",
      policyClass: "direct",
    });

    const action = await context.homeReviewCenter.requestAction({
      requestId: "peer-switch-off",
      capabilityId: PEER_CAPABILITY_ID,
      summary: "Turn peer switch off",
      action: { kind: "set_boolean", value: false },
      actor: {
        principalId: "member-1",
        role: "adult_member",
        present: true,
        device: { kind: "private", boundPrincipalId: "member-1" },
      },
    });
    assert.equal(action.status, "verified");
    assert.equal(action.ticket.afterValue, false);
    assert.deepEqual(adapter.executed, [{
      requestId: "peer-switch-off",
      action: {
        kind: "set_boolean",
        value: false,
        target: {
          hwCapabilityId: PEER_CAPABILITY_ID,
          binding: {
            bridgeId: PEER_BRIDGE_ID,
            nativeId: "peer-switch",
            nativeInstanceId: "peer-switch:main",
          },
        },
      },
    }]);
    assert.equal(context.homeWorld.snapshot().devices[0]?.states[0]?.attrs.value, false);

    const deployment = new BridgeAutomationDeployment(context.homeWorld);
    const content = {
      trigger: { kind: "schedule" as const, timezone: "Asia/Shanghai", daysOfWeek: [1], at: "22:30" },
      conditions: [],
      actions: [{ kind: "set_boolean" as const, target: { hwCapabilityId: PEER_CAPABILITY_ID }, value: false }],
      rollback: { kind: "restore_previous_state" as const, target: { hwCapabilityId: PEER_CAPABILITY_ID }, maxAgeSeconds: 60 },
      postconditions: [{
        kind: "capability_value" as const,
        source: { hwCapabilityId: PEER_CAPABILITY_ID },
        operator: "equals" as const,
        value: false,
        withinSeconds: 30,
      }],
    };
    const resolved = deployment.resolveIntent({
      proposalId: "peer-evening-switch",
      kind: "automation-draft",
      artifactCandidate: { schemaVersion: "1", content },
      actionPolicyClasses: ["direct"],
    });
    assert.deepEqual(resolved, {
      deploymentId: "hob_peer_evening_switch",
      target: PEER_BRIDGE_ID,
      targets: [{
        hwCapabilityId: PEER_CAPABILITY_ID,
        binding: { bridgeId: PEER_BRIDGE_ID, nativeId: "peer-switch", nativeInstanceId: "peer-switch:main" },
      }],
    });
    if (!("deploymentId" in resolved)) assert.fail("test peer automation intent was not resolved");

    const deployed = await deployment.deploy({
      proposalId: "peer-evening-switch",
      revision: 1,
      kind: "automation-draft",
      title: "Turn peer switch off at night",
      artifactCandidate: { schemaVersion: "1", content },
      intent: resolved,
    });
    assert.deepEqual(deployed, {
      status: "verified",
      deploymentId: "hob_peer_evening_switch",
      target: PEER_BRIDGE_ID,
      configFingerprint: "peer:hob_peer_evening_switch",
    });
    assert.deepEqual(adapter.deployed[0]?.actions, [{
      kind: "set_boolean",
      target: {
        hwCapabilityId: PEER_CAPABILITY_ID,
        binding: { bridgeId: PEER_BRIDGE_ID, nativeId: "peer-switch", nativeInstanceId: "peer-switch:main" },
      },
      value: false,
    }]);
    assert.deepEqual(await deployment.status({ deploymentId: "hob_peer_evening_switch", target: PEER_BRIDGE_ID }), {
      status: "running",
      configFingerprint: "peer:hob_peer_evening_switch",
    });
    await deployment.pause({ proposalId: "peer-evening-switch", deploymentId: "hob_peer_evening_switch", target: PEER_BRIDGE_ID });
    assert.deepEqual(await deployment.status({ deploymentId: "hob_peer_evening_switch", target: PEER_BRIDGE_ID }), {
      status: "paused",
      configFingerprint: "peer:hob_peer_evening_switch",
    });
    await deployment.resume({ proposalId: "peer-evening-switch", deploymentId: "hob_peer_evening_switch", target: PEER_BRIDGE_ID });
    assert.deepEqual(await deployment.withdraw({
      proposalId: "peer-evening-switch",
      deploymentId: "hob_peer_evening_switch",
      target: PEER_BRIDGE_ID,
    }), { restored: true });
    assert.deepEqual(await deployment.status({ deploymentId: "hob_peer_evening_switch", target: PEER_BRIDGE_ID }), { status: "missing" });
  } finally {
    await reviewFiber.dispose();
    await worldFiber.dispose();
  }
});
