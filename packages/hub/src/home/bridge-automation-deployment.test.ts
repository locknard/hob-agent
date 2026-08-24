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
  readonly authority?: { status: string; policyClass?: string; reason?: string };
  readonly deviceName?: string;
  readonly preflight?: () => { readonly status: "compatible" } | { readonly status: "blocked"; readonly reason: string };
  readonly currentState?: {
    readonly status: "available";
    readonly capabilities: readonly {
      readonly hwCapabilityId: string;
      readonly schema: string;
      readonly schemaVersion: string;
      readonly attrs: Readonly<Record<string, unknown>>;
      readonly validity: "valid";
      readonly freshness: "fresh";
    }[];
  } | { readonly status: "blocked"; readonly reason: string };
} = {}) {
  const calls: { deploys: BridgeAutomationSpec[]; toggles: unknown[]; withdrawals: unknown[] } = {
    deploys: [], toggles: [], withdrawals: [],
  };
  const bridge = {
    bridgeId: "ha-main",
    automations: {
      deploy: async (request: { readonly operationId: string; readonly spec: BridgeAutomationSpec }) => {
        calls.deploys.push(request.spec);
        return (overrides.deployResult ?? {
          status: "deployed",
          operationId: request.operationId,
          nativeAutomationId: request.spec.automationId,
        }) as never;
      },
      setEnabled: async (request: { readonly operationId: string; readonly nativeAutomationId: string; readonly enabled: boolean }) => {
        calls.toggles.push({ nativeAutomationId: request.nativeAutomationId, enabled: request.enabled });
        return { status: "acknowledged", operationId: request.operationId } as const;
      },
      withdraw: async (request: { readonly operationId: string; readonly nativeAutomationId: string }) => {
        calls.withdrawals.push({ nativeAutomationId: request.nativeAutomationId });
        return { status: "acknowledged", operationId: request.operationId } as const;
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
      automationBridgeById: (bridgeId: string) => bridgeId === "ha-main" ? bridge : undefined,
      automationsHandleFor: (bridgeId: string) => bridgeId === "ha-main" ? bridge.automations : undefined,
      resolveActionAuthority: () => (overrides.authority ?? { status: "available", policyClass: "direct" }),
      capabilityDeviceName: () => overrides.deviceName,
      currentArtifactPlanState: overrides.currentState === undefined ? undefined : () => overrides.currentState,
      checkArtifactPlanSemantics: overrides.preflight === undefined ? undefined : () => overrides.preflight!(),
    },
  };
}

test("compiles the neutral artifact with resolved bindings and reports a verified deployment", async () => {
  const { calls, world } = bridgeStub();
  const port = new BridgeAutomationDeployment(world);
  const outcome = await port.deploy({
    proposalId: "proposal-Media.Power:41",
    revision: 3,
    actor: "household-owner",
    kind: "automation-draft",
    title: "睡前自动关掉多媒体室电源",
    artifactCandidate: { schemaVersion: "1", content },
    intent: { deploymentId: "hob_proposal_media_power_41", target: "ha-main", targets: [
      { hwCapabilityId: "hwc-presence", binding: { bridgeId: "ha-main", nativeId: "dev-hwc-presence", nativeInstanceId: "ent-hwc-presence" } },
      { hwCapabilityId: "hwc-strip", binding: { bridgeId: "ha-main", nativeId: "dev-hwc-strip", nativeInstanceId: "ent-hwc-strip" } },
    ] },
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
  assert.equal("actor" in spec, false, "the Hub audit actor never enters the provider-native spec");
});

test("checks the neutral current state with the reviewed schema semantics", () => {
  const boolState = {
    status: "available" as const,
    capabilities: [
      {
        hwCapabilityId: "hwc-presence",
        schema: "ha.boolean-actuator",
        schemaVersion: "1.0.0",
        attrs: { state: "on", value: true },
        validity: "valid" as const,
        freshness: "fresh" as const,
      },
      {
        hwCapabilityId: "hwc-strip",
        schema: "ha.boolean-actuator",
        schemaVersion: "1.0.0",
        attrs: { state: "off", value: false },
        validity: "valid" as const,
        freshness: "fresh" as const,
      },
    ],
  };
  const request = {
    proposalId: "proposal-current-semantics",
    kind: "automation-draft" as const,
    artifactCandidate: { schemaVersion: "1" as const, content },
    actionPolicyClasses: ["direct"],
  };
  const compatible = new BridgeAutomationDeployment(bridgeStub({ currentState: boolState }).world).resolveIntent(request);
  assert.ok("deploymentId" in compatible);

  const driftedTargets = [
    { schema: "ha.entity", attrs: { state: "off" } },
    { schema: "ha.boolean-actuator", attrs: { state: "unknown" } },
    { schema: "ha.boolean-actuator", attrs: { state: "unavailable", available: false } },
  ] as const;
  for (const drift of driftedTargets) {
    const currentState = {
      ...boolState,
      capabilities: boolState.capabilities.map((state) => state.hwCapabilityId === "hwc-strip"
        ? { ...state, ...drift }
        : state),
    };
    const blocked = new BridgeAutomationDeployment(bridgeStub({ currentState }).world).resolveIntent(request);
    assert.ok("reason" in blocked);
    assert.match((blocked as { readonly reason: string }).reason, /当前状态或能力语义|重新准备/);
  }
});

test("rechecks current plan semantics before intent and again before the bridge write", async () => {
  let checks = 0;
  const { calls, world } = bridgeStub({
    preflight: () => {
      checks += 1;
      return checks === 1
        ? { status: "compatible" as const }
        : { status: "blocked" as const, reason: "state_stale" };
    },
  });
  const port = new BridgeAutomationDeployment(world);
  const request = {
    proposalId: "proposal-semantic-drift",
    kind: "automation-draft" as const,
    artifactCandidate: { schemaVersion: "1" as const, content },
    actionPolicyClasses: ["direct"],
  };
  const intent = port.resolveIntent(request);
  assert.ok("deploymentId" in intent);

  const outcome = await port.deploy({
    ...request,
    revision: 1,
    actor: "household-owner",
    title: "睡前关闭",
    intent,
  });

  assert.equal(checks, 2, "the plan is checked once for intent and once immediately before write");
  assert.equal(outcome.status, "failed");
  assert.match((outcome as { readonly reason: string }).reason, /当前设备状态|重新准备/);
  assert.equal(calls.deploys.length, 0, "semantic drift never reaches the bridge write");
});


test("the approval binds the named confirmation devices, not only the class set", () => {
  const confirming = new BridgeAutomationDeployment(
    bridgeStub({ authority: { status: "available", policyClass: "confirmation" }, deviceName: "插座（多媒体室）" }).world,
  );
  const request = {
    proposalId: "p-disclosure", kind: "automation-draft",
    artifactCandidate: { schemaVersion: "1" as const, content },
    actionPolicyClasses: ["confirmation"],
  };

  const swapped = confirming.resolveIntent({ ...request, confirmationDeviceNames: ["空调（客厅）"] });
  assert.ok("revalidationReason" in swapped, "a changed confirmation device set re-prepares");
  assert.match((swapped as { revalidationReason: string }).revalidationReason, /需要确认的设备已变化/);
  assert.deepEqual(
    (swapped as { updatedGateDisclosure?: { confirmationDeviceNames?: readonly string[] } }).updatedGateDisclosure?.confirmationDeviceNames,
    ["插座（多媒体室）"],
  );

  const unchanged = confirming.resolveIntent({ ...request, confirmationDeviceNames: ["插座（多媒体室）"] });
  assert.ok("deploymentId" in unchanged, "an unchanged disclosure converges to the intent");

  const unnameable = new BridgeAutomationDeployment(
    bridgeStub({ authority: { status: "available", policyClass: "confirmation" } }).world,
  ).resolveIntent({ ...request, confirmationDeviceNames: ["插座（多媒体室）"] });
  assert.ok("reason" in unnameable, "an unnameable confirmation device is a map defect, not an under-disclosure");
  assert.match((unnameable as { reason: string }).reason, /可读名称/);

  const classShift = confirming.resolveIntent({ ...request, actionPolicyClasses: ["direct"], confirmationDeviceNames: [] });
  assert.ok("revalidationReason" in classShift);
  assert.match((classShift as { revalidationReason: string }).revalidationReason, /确认档位已变化/);
});

test("blocked enablement names the actual household fact", () => {
  const request = {
    proposalId: "p-blocked", kind: "automation-draft",
    artifactCandidate: { schemaVersion: "1" as const, content },
    actionPolicyClasses: ["direct"],
  };
  const resolveWith = (reason: string) => new BridgeAutomationDeployment(
    bridgeStub({ authority: { status: "unavailable", reason } }).world,
  ).resolveIntent(request);

  const outage = resolveWith("configured_binding_unavailable");
  assert.ok("reason" in outage, "a passing outage is retryable and never persists a block");
  assert.match((outage as { reason: string }).reason, /暂时连不上.*稍后再试/);

  const unconfigured = resolveWith("not_configured");
  assert.ok("blockedReason" in unconfigured, "a missing configuration blocks visibly instead of vanishing into preparation");
  assert.match((unconfigured as { blockedReason: string }).blockedReason, /确认方式还没有设置好/);

  const revoked = resolveWith("not_approved");
  assert.ok("blockedReason" in revoked, "a revoked authorization blocks visibly with the revise and decline exits");
  assert.match((revoked as { blockedReason: string }).blockedReason, /家庭已撤回/);

  const vanished = resolveWith("unknown_capability");
  assert.ok("blockedReason" in vanished, "a vanished device can only be revised or declined");
  assert.match((vanished as { blockedReason: string }).blockedReason, /不在家庭地图里/);

  const protectedNow = new BridgeAutomationDeployment(
    bridgeStub({ authority: { status: "available", policyClass: "administrator" } }).world,
  ).resolveIntent(request);
  assert.ok("blockedReason" in protectedNow);
  assert.match((protectedNow as { blockedReason: string }).blockedReason, /高影响保护/);
});

test("fails in household language when no bridge, no binding, or the adapter rejects", async () => {
  const noBridge = new BridgeAutomationDeployment({
    automationBridgeForTargets: () => undefined,
    automationBridgeById: () => undefined,
    automationsHandleFor: () => undefined,
    resolveActionAuthority: () => ({ status: "available", policyClass: "direct" }),
    capabilityDeviceName: () => undefined,
  });
  const missing = await noBridge.deploy({
    proposalId: "p1", revision: 1, actor: "household-owner", kind: "automation-draft", title: "t",
    artifactCandidate: { schemaVersion: "1", content },
    intent: { deploymentId: "hob_p", target: "ha-main", targets: [
      { hwCapabilityId: "hwc-strip", binding: { bridgeId: "ha-main", nativeId: "dev-hwc-strip", nativeInstanceId: "ent-hwc-strip" } },
    ] },
  });
  assert.equal(missing.status, "failed");
  assert.match((missing as { reason: string }).reason, /部署通道/);

  const unbound = new BridgeAutomationDeployment(bridgeStub({ resolvable: false }).world);
  const unresolved = await unbound.deploy({
    proposalId: "p2", revision: 1, actor: "household-owner", kind: "automation-draft", title: "t",
    artifactCandidate: { schemaVersion: "1", content },
    intent: { deploymentId: "hob_p", target: "ha-main", targets: [
      { hwCapabilityId: "hwc-presence", binding: { bridgeId: "ha-main", nativeId: "dev-hwc-presence", nativeInstanceId: "ent-hwc-presence" } },
      { hwCapabilityId: "hwc-strip", binding: { bridgeId: "ha-main", nativeId: "dev-hwc-strip", nativeInstanceId: "ent-hwc-strip" } },
    ] },
  });
  assert.equal(unresolved.status, "failed");
  assert.match((unresolved as { reason: string }).reason, /接入方式.*发生了变化/, "a binding the bridge can no longer resolve fails closed against the authorized vector");

  const rejecting = new BridgeAutomationDeployment(
    bridgeStub({ deployResult: { status: "rejected", reason: "unsupported" } }).world,
  );
  const rejected = await rejecting.deploy({
    proposalId: "p3", revision: 1, actor: "household-owner", kind: "automation-draft", title: "t",
    artifactCandidate: { schemaVersion: "1", content },
    intent: { deploymentId: "hob_p3", target: "ha-main", targets: [
      { hwCapabilityId: "hwc-presence", binding: { bridgeId: "ha-main", nativeId: "dev-hwc-presence", nativeInstanceId: "ent-hwc-presence" } },
      { hwCapabilityId: "hwc-strip", binding: { bridgeId: "ha-main", nativeId: "dev-hwc-strip", nativeInstanceId: "ent-hwc-strip" } },
    ] },
  });
  assert.equal(rejected.status, "failed");
  assert.match((rejected as { reason: string }).reason, /暂不支持/);
  assert.doesNotMatch((rejected as { reason: string }).reason, /entity|api|http/i);
});

test("deploy fails closed when the intent no longer covers the plan's capabilities", async () => {
  const port = new BridgeAutomationDeployment(bridgeStub().world);
  const partial = await port.deploy({
    proposalId: "p-partial", revision: 1, actor: "household-owner", kind: "automation-draft", title: "t",
    artifactCandidate: { schemaVersion: "1", content },
    intent: { deploymentId: "hob_p_partial", target: "ha-main", targets: [
      { hwCapabilityId: "hwc-strip", binding: { bridgeId: "ha-main", nativeId: "dev-hwc-strip", nativeInstanceId: "ent-hwc-strip" } },
    ] },
  });
  assert.equal(partial.status, "failed");
  assert.match((partial as { reason: string }).reason, /方案内容与批准时的意图不一致/);
});

test("pause, resume and withdraw address only the hub deployment", async () => {
  const { calls, world } = bridgeStub();
  const port = new BridgeAutomationDeployment(world);
  await port.pause({ proposalId: "p1", deploymentId: "hob_p1", target: "ha-main", operationId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  await port.resume({ proposalId: "p1", deploymentId: "hob_p1", target: "ha-main", operationId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
  const withdrawal = await port.withdraw({ proposalId: "p1", deploymentId: "hob_p1", target: "ha-main", actor: "household-owner", operationId: "cccccccccccccccccccccccccccccccc" });
  assert.deepEqual(calls.toggles, [
    { nativeAutomationId: "hob_p1", enabled: false },
    { nativeAutomationId: "hob_p1", enabled: true },
  ]);
  assert.deepEqual(calls.withdrawals, [{ nativeAutomationId: "hob_p1" }]);
  assert.deepEqual(withdrawal, { restored: true });
});

test("uses stable operation ids for automations v2 deployment and commands", async () => {
  const operationRequests: Array<{ readonly kind: string; readonly operationId?: string }> = [];
  const v2 = {
    deploy: async (request: { readonly operationId: string; readonly spec: BridgeAutomationSpec }) => {
      operationRequests.push({ kind: "deploy", operationId: request.operationId });
      return { status: "deployed" as const, operationId: request.operationId, nativeAutomationId: request.spec.automationId };
    },
    status: async () => ({ status: "running" as const, configFingerprint: "peer:fingerprint" }),
    setEnabled: async (request: { readonly operationId: string; readonly nativeAutomationId: string; readonly enabled: boolean }) => {
      operationRequests.push({ kind: request.enabled ? "resume" : "pause", operationId: request.operationId });
      return { status: "acknowledged" as const, operationId: request.operationId };
    },
    withdraw: async (request: { readonly operationId: string; readonly nativeAutomationId: string }) => {
      operationRequests.push({ kind: "withdraw", operationId: request.operationId });
      return { status: "acknowledged" as const, operationId: request.operationId };
    },
  };
  const base = bridgeStub().world;
  const world = {
    ...base,
    automationBridgeById: () => ({
      bridgeId: "ha-main",
      automations: v2,
      resolveTarget: base.automationBridgeById("ha-main")!.resolveTarget,
    }),
    automationsHandleFor: () => v2,
  } as never;
  const port = new BridgeAutomationDeployment(world);
  const request = {
    proposalId: "stable-operation-proposal",
    revision: 3,
    actor: "household-owner",
    kind: "automation-draft" as const,
    title: "睡前关闭",
    artifactCandidate: { schemaVersion: "1" as const, content },
    intent: {
      deploymentId: "hob_stable_operation_proposal",
      target: "ha-main",
      targets: [
        { hwCapabilityId: "hwc-presence", binding: { bridgeId: "ha-main", nativeId: "dev-hwc-presence", nativeInstanceId: "ent-hwc-presence" } },
        { hwCapabilityId: "hwc-strip", binding: { bridgeId: "ha-main", nativeId: "dev-hwc-strip", nativeInstanceId: "ent-hwc-strip" } },
      ],
    },
  };

  await port.deploy(request);
  await port.deploy(request);
  await port.pause({ proposalId: request.proposalId, deploymentId: request.intent.deploymentId, target: request.intent.target, operationId: "dddddddddddddddddddddddddddddddd" });
  await port.pause({ proposalId: request.proposalId, deploymentId: request.intent.deploymentId, target: request.intent.target, operationId: "dddddddddddddddddddddddddddddddd" });
  await port.withdraw({ proposalId: request.proposalId, deploymentId: request.intent.deploymentId, target: request.intent.target, actor: request.actor, operationId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" });
  await port.withdraw({ proposalId: request.proposalId, deploymentId: request.intent.deploymentId, target: request.intent.target, actor: request.actor, operationId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" });

  assert.equal(operationRequests.length, 6);
  for (const operation of operationRequests) assert.match(operation.operationId ?? "", /^[0-9a-f]{32}$/);
  assert.equal(operationRequests[0]?.operationId, operationRequests[1]?.operationId, "direct deploy replay is stable");
  assert.equal(operationRequests[2]?.operationId, operationRequests[3]?.operationId, "pause replay is stable");
  assert.equal(operationRequests[4]?.operationId, operationRequests[5]?.operationId, "withdraw replay is stable");
  assert.notEqual(operationRequests[0]?.operationId, operationRequests[2]?.operationId);
  assert.notEqual(operationRequests[2]?.operationId, operationRequests[4]?.operationId);
});
