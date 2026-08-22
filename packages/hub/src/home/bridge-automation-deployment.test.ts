import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeAutomationSpec } from "@hob/bridge-contract";

import { BridgeAutomationDeployment, automationIdForProposal } from "./bridge-automation-deployment.js";

const content = {
  trigger: { kind: "schedule" as const, timezone: "Asia/Shanghai", daysOfWeek: [1, 2, 3, 4, 5], at: "23:30" },
  conditions: [{
    kind: "capability_value" as const,
    source: { hwCapabilityId: "hwc-presence" },
    operator: "equals" as const,
    value: false,
  }],
  actions: [{ kind: "set_boolean" as const, target: { hwCapabilityId: "hwc-strip" }, value: false }],
  rollback: { kind: "restore_previous_state" as const, target: { hwCapabilityId: "hwc-strip" }, maxAgeSeconds: 3_600 },
  postconditions: [{
    kind: "capability_value" as const,
    source: { hwCapabilityId: "hwc-strip" },
    operator: "equals" as const,
    value: false,
    withinSeconds: 30,
  }],
};

function bridgeStub(overrides: {
  readonly deployResult?: unknown;
  readonly resolvable?: boolean;
} = {}) {
  const calls: { deploys: BridgeAutomationSpec[]; toggles: unknown[]; withdrawals: unknown[] } = {
    deploys: [], toggles: [], withdrawals: [],
  };
  const bridge = {
    bridgeId: "ha-main",
    automations: {
      deploy: async (spec: BridgeAutomationSpec) => {
        calls.deploys.push(spec);
        return (overrides.deployResult ?? { status: "deployed", nativeAutomationId: spec.automationId }) as never;
      },
      setEnabled: async (request: unknown) => {
        calls.toggles.push(request);
        return { status: "acknowledged" } as const;
      },
      withdraw: async (request: unknown) => {
        calls.withdrawals.push(request);
        return { status: "acknowledged" } as const;
      },
    },
    resolveTarget: (hwCapabilityId: string) => (overrides.resolvable ?? true)
      ? { hwCapabilityId, binding: { bridgeId: "ha-main", nativeId: `dev-${hwCapabilityId}`, nativeInstanceId: `ent-${hwCapabilityId}` } }
      : undefined,
  };
  return {
    calls,
    world: {
      automationBridgeForTargets: (ids: readonly string[]) => (overrides.resolvable ?? true) && ids.length > 0 ? bridge : bridge,
      automationsHandleFor: (bridgeId: string) => bridgeId === "ha-main" ? bridge.automations : undefined,
    },
  };
}

test("compiles the neutral artifact with resolved bindings and reports a verified deployment", async () => {
  const { calls, world } = bridgeStub();
  const port = new BridgeAutomationDeployment(world);
  const outcome = await port.deploy({
    proposalId: "proposal-Media.Power:41",
    revision: 3,
    kind: "automation-draft",
    title: "睡前自动关掉多媒体室电源",
    artifactCandidate: { schemaVersion: "1", content },
  });
  assert.deepEqual(outcome, {
    status: "verified",
    deploymentId: "hob_proposal_media_power_41",
    target: "ha-main",
  });
  const spec = calls.deploys[0]!;
  assert.equal(spec.automationId, automationIdForProposal("proposal-Media.Power:41"));
  assert.equal(spec.trigger.kind, "schedule");
  assert.equal(spec.actions[0]?.kind, "set_boolean");
  assert.equal((spec.actions[0] as { target: { binding: { nativeId: string } } }).target.binding.nativeId, "dev-hwc-strip");
});

test("fails in household language when no bridge, no binding, or the adapter rejects", async () => {
  const noBridge = new BridgeAutomationDeployment({
    automationBridgeForTargets: () => undefined,
    automationsHandleFor: () => undefined,
  });
  const missing = await noBridge.deploy({
    proposalId: "p1", revision: 1, kind: "automation-draft", title: "t",
    artifactCandidate: { schemaVersion: "1", content },
  });
  assert.equal(missing.status, "failed");
  assert.match((missing as { reason: string }).reason, /部署通道/);

  const unbound = new BridgeAutomationDeployment(bridgeStub({ resolvable: false }).world);
  const unresolved = await unbound.deploy({
    proposalId: "p2", revision: 1, kind: "automation-draft", title: "t",
    artifactCandidate: { schemaVersion: "1", content },
  });
  assert.equal(unresolved.status, "failed");
  assert.match((unresolved as { reason: string }).reason, /无法定位/);

  const rejecting = new BridgeAutomationDeployment(
    bridgeStub({ deployResult: { status: "rejected", reason: "unsupported" } }).world,
  );
  const rejected = await rejecting.deploy({
    proposalId: "p3", revision: 1, kind: "automation-draft", title: "t",
    artifactCandidate: { schemaVersion: "1", content },
  });
  assert.equal(rejected.status, "failed");
  assert.match((rejected as { reason: string }).reason, /暂不支持/);
  assert.doesNotMatch((rejected as { reason: string }).reason, /entity|api|http/i);
});

test("pause, resume and withdraw address only the hub deployment", async () => {
  const { calls, world } = bridgeStub();
  const port = new BridgeAutomationDeployment(world);
  await port.pause({ proposalId: "p1", deploymentId: "hob_p1", target: "ha-main" });
  await port.resume({ proposalId: "p1", deploymentId: "hob_p1", target: "ha-main" });
  const withdrawal = await port.withdraw({ proposalId: "p1", deploymentId: "hob_p1", target: "ha-main" });
  assert.deepEqual(calls.toggles, [
    { nativeAutomationId: "hob_p1", enabled: false },
    { nativeAutomationId: "hob_p1", enabled: true },
  ]);
  assert.deepEqual(calls.withdrawals, [{ nativeAutomationId: "hob_p1" }]);
  assert.deepEqual(withdrawal, { restored: true });
});
