import assert from "node:assert/strict";
import test from "node:test";

import type { ProposalDeploymentPort } from "./home-proposal-service.js";
import {
  HomeAutomationMigrationDeployment,
  type HomeAutomationMigrationDeploymentLookup,
} from "./home-automation-migration-deployment.js";

const SOURCE_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const DEPLOYMENT_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const SWITCH_OPERATION_ID = "9be3b4dceaa5ee83f586d923469eb20b";
const PERSISTED_SWITCH_OPERATION_ID = "11111111111111111111111111111111";
const ROLLBACK_OPERATION_ID = "6374645a003501464e33bcaa734d4ed3";
const RECOVERY_SWITCH_OPERATION_ID = "1327fcc9190451509e41812042f0792b";
const RECOVERY_ROLLBACK_OPERATION_ID = "b089ca611391d06fde794987c0fdc66b";
const FOREIGN_RULE_CATALOG_PREFLIGHT_REASON = "现有规则状态已经变化或暂时无法确认，需要重新准备迁移；家里的设置保持原样。";
const BASE_REQUEST = {
  proposalId: "proposal-migration",
  revision: 3,
  actor: "authenticated-reviewer",
  kind: "automation-draft" as const,
  title: "Living room light",
  artifactCandidate: { schemaVersion: "1" as const, content: { neutral: true } },
  intent: {
    deploymentId: "hob_proposal_migration",
    target: "bridge-ha",
    targets: [{
      hwCapabilityId: "hwc-light",
      binding: { bridgeId: "bridge-ha", nativeId: "neutral-device", nativeInstanceId: "neutral-entity" },
    }],
  },
} satisfies Parameters<ProposalDeploymentPort["deploy"]>[0];

function deploymentFixture() {
  const events: string[] = [];
  const failCalls: unknown[] = [];
  const withdrawRequests: unknown[] = [];
  let sourceState: "running" | "paused" = "running";
  let workflow: "ready" | "verified" = "ready";
  const base: ProposalDeploymentPort = {
    resolveIntent: () => BASE_REQUEST.intent,
    preflight: () => ({ status: "compatible" as const }),
    deploy: async () => {
      events.push("base.deploy");
      return {
        status: "verified",
        deploymentId: BASE_REQUEST.intent.deploymentId,
        target: BASE_REQUEST.intent.target,
        configFingerprint: DEPLOYMENT_FINGERPRINT,
      };
    },
    status: async () => {
      events.push("base.status");
      return events.includes("base.withdraw")
        ? { status: "missing" }
        : { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT };
    },
    pause: async () => {
      events.push("base.pause");
    },
    resume: async () => {
      events.push("base.resume");
    },
    withdraw: async (request) => {
      events.push("base.withdraw");
      withdrawRequests.push(request);
      return { restored: true };
    },
  };
  const runtime = {
    findWorkflowForProposal: () => workflow === "ready"
      ? {
          status: "ready" as const,
          migrationId: "0123456789abcdef0123456789abcdef",
          ruleRef: "opaque-rule-ref",
          sourceBridgeId: "bridge-ha",
          sourceFingerprint: SOURCE_FINGERPRINT,
          reviewProposalRevision: 2,
        }
      : {
          status: "governed" as const,
          workflowStatus: "verified" as const,
          migrationId: "0123456789abcdef0123456789abcdef",
          ruleRef: "opaque-rule-ref",
          sourceBridgeId: "bridge-ha",
          sourceFingerprint: SOURCE_FINGERPRINT,
          reviewProposalRevision: 2,
          approvedProposalRevision: 3,
          switchOperationId: PERSISTED_SWITCH_OPERATION_ID,
          deploymentId: BASE_REQUEST.intent.deploymentId,
          deploymentTarget: BASE_REQUEST.intent.target,
          deploymentConfigFingerprint: DEPLOYMENT_FINGERPRINT,
        },
    startRuleSwitch: () => {
      events.push("runtime.startSwitch");
      workflow = "ready";
      return true;
    },
    verifyRuleSwitch: () => {
      events.push("runtime.verifySwitch");
      workflow = "verified";
      return true;
    },
    startRuleRollback: () => {
      events.push("runtime.startRollback");
      return true;
    },
    resumeRuleSwitch: () => {
      events.push("runtime.resumeSwitch");
      workflow = "ready";
      return true;
    },
    restoreFailedSwitch: () => {
      events.push("runtime.restoreFailedSwitch");
      workflow = "verified";
      return true;
    },
    resumeRuleRollback: () => {
      events.push("runtime.resumeRollback");
      return true;
    },
    restoreRule: () => {
      events.push("runtime.restore");
      workflow = "verified";
      return true;
    },
    failRuleWorkflow: () => {
      events.push("runtime.fail");
      return true;
    },
    readForeignRuleCatalog: () => ({ status: "unchanged" as const }),
  };
  const control = {
    status: async () => {
      events.push("source.status");
      return { status: sourceState, sourceFingerprint: SOURCE_FINGERPRINT } as const;
    },
    setEnabled: async (request: { readonly enabled: boolean }) => {
      events.push(`source.set:${request.enabled}`);
      sourceState = request.enabled ? "running" : "paused";
      return { status: sourceState, sourceFingerprint: SOURCE_FINGERPRINT } as const;
    },
  };
  const sourcePort = { foreignRuleControlFor: () => control };
  const wrapper = new HomeAutomationMigrationDeployment(base, runtime, sourcePort);
  runtime.failRuleWorkflow = (input: unknown) => {
    events.push("runtime.fail");
    failCalls.push(input);
    return true;
  };
  return { events, failCalls, withdrawRequests, runtime, base, control, sourcePort, wrapper };
}

test("preflights current semantics before pausing the source rule or opening a switch CAS", async () => {
  const { events, base, wrapper } = deploymentFixture();
  base.preflight = () => ({ status: "blocked" as const, reason: "state_stale" });

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.equal(outcome.status, "failed");
  assert.match((outcome as { readonly reason: string }).reason, /当前设备状态|重新准备/);
  assert.deepEqual(events, [], "a blocked preflight leaves both the source and target untouched");
});

test("preflights the foreign catalog once before reading or switching the source rule", async () => {
  const { events, runtime, wrapper } = deploymentFixture();
  let catalogReads = 0;
  runtime.readForeignRuleCatalog = (input: { readonly migrationId: string; readonly ruleRef: string }) => {
    catalogReads += 1;
    assert.equal(input.migrationId, "0123456789abcdef0123456789abcdef");
    assert.equal(input.ruleRef, "opaque-rule-ref");
    events.push("foreign.catalog");
    return { status: "unchanged" as const };
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.equal(outcome.status, "verified");
  assert.equal(catalogReads, 1);
  assert.deepEqual(
    events.slice(0, 3),
    ["foreign.catalog", "source.status", "runtime.startSwitch"],
    "the catalog fence precedes source read and switch CAS",
  );
  assert.equal(events.filter((event) => event === "foreign.catalog").length, 1);
});

for (const scenario of [
  { name: "changed", result: { status: "changed" as const } },
  { name: "unavailable", result: { status: "unavailable" as const } },
  { name: "throws", error: new Error("catalog read failed") },
]) {
  test(`fails closed before source access when the ready migration catalog is ${scenario.name}`, async () => {
    const { events, failCalls, runtime, wrapper } = deploymentFixture();
    let catalogReads = 0;
    runtime.readForeignRuleCatalog = () => {
      catalogReads += 1;
      events.push("foreign.catalog");
      if (scenario.error !== undefined) throw scenario.error;
      return scenario.result!;
    };

    const outcome = await wrapper.deploy(BASE_REQUEST);

    assert.equal(outcome.status, "failed");
    assert.equal((outcome as { readonly reason: string }).reason, FOREIGN_RULE_CATALOG_PREFLIGHT_REASON);
    assert.equal(catalogReads, 1);
    assert.deepEqual(events, ["foreign.catalog", "runtime.fail"], "catalog failure leaves source and target untouched");
    assert.deepEqual(failCalls, [{
      migrationId: "0123456789abcdef0123456789abcdef",
      ruleRef: "opaque-rule-ref",
      from: "ready",
      reason: "source_stale",
    }]);
  });
}

function governedLookup(
  workflowStatus: "switching" | "needs_attention" | "rolling_back",
  failureReason?: "switch_failed" | "switch_unknown" | "verification_failed" | "rollback_failed" | "rollback_unknown",
): HomeAutomationMigrationDeploymentLookup {
  const base = {
    status: "governed",
    workflowStatus,
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    sourceBridgeId: "bridge-ha",
    sourceFingerprint: SOURCE_FINGERPRINT,
  } as const;
  const switching = {
    reviewProposalRevision: 2,
    approvedProposalRevision: 3,
    switchOperationId: PERSISTED_SWITCH_OPERATION_ID,
    switchActor: "member:alice",
    sourceWasEnabled: true,
    switchStartedAt: "2026-08-24T00:00:03.000Z",
  } as const;
  const deployment = {
    deploymentId: BASE_REQUEST.intent.deploymentId,
    deploymentTarget: BASE_REQUEST.intent.target,
    deploymentConfigFingerprint: DEPLOYMENT_FINGERPRINT,
  } as const;
  const rollback = {
    rollbackOperationId: "22222222222222222222222222222222",
    rollbackActor: "member:alice",
    rollbackStartedAt: "2026-08-24T00:00:05.000Z",
  } as const;
  if (workflowStatus === "switching") return { ...base, ...switching };
  if (workflowStatus === "rolling_back") return { ...base, ...switching, ...deployment, ...rollback };
  if (failureReason === "rollback_failed" || failureReason === "rollback_unknown") {
    return { ...base, ...switching, ...deployment, ...rollback, failureReason };
  }
  if (failureReason === "verification_failed") {
    return { ...base, ...switching, ...deployment, failureReason };
  }
  return { ...base, ...switching, ...(failureReason === undefined ? {} : { failureReason }) };
}

function governedVerifiedLookup(): Extract<HomeAutomationMigrationDeploymentLookup, { readonly status: "governed" }> {
  return {
    status: "governed",
    workflowStatus: "verified",
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    sourceBridgeId: "bridge-ha",
    sourceFingerprint: SOURCE_FINGERPRINT,
    reviewProposalRevision: 2,
    approvedProposalRevision: BASE_REQUEST.revision,
    switchOperationId: PERSISTED_SWITCH_OPERATION_ID,
    deploymentId: BASE_REQUEST.intent.deploymentId,
    deploymentTarget: BASE_REQUEST.intent.target,
    deploymentConfigFingerprint: DEPLOYMENT_FINGERPRINT,
  };
}

function governedRestoredLookup(): Extract<HomeAutomationMigrationDeploymentLookup, { readonly status: "governed" }> {
  return {
    ...governedVerifiedLookup(),
    workflowStatus: "restored",
  };
}

test("defers generic reconciliation during migration transitions and restored cross-store windows", () => {
  const { runtime, wrapper } = deploymentFixture();
  const guard = (lifecycle: "enabling" | "active" | "paused") =>
    (wrapper as unknown as {
      reconciliationGuard(input: { proposalId: string; lifecycle: string }): "allow" | "defer";
    }).reconciliationGuard({ proposalId: BASE_REQUEST.proposalId, lifecycle });

  runtime.findWorkflowForProposal = () => ({
    status: "ready",
    migrationId: "migration",
    ruleRef: "rule",
    sourceBridgeId: "bridge-ha",
    sourceFingerprint: SOURCE_FINGERPRINT,
    reviewProposalRevision: 2,
  });
  assert.equal(guard("enabling"), "defer");
  for (const workflowStatus of ["switching", "verified", "rolling_back"] as const) {
    runtime.findWorkflowForProposal = () => governedLookup(workflowStatus);
    assert.equal(guard(workflowStatus === "verified" ? "active" : "enabling"), workflowStatus === "verified" ? "allow" : "defer", workflowStatus);
  }
  runtime.findWorkflowForProposal = () => governedLookup("needs_attention", "rollback_unknown");
  assert.equal(guard("active"), "defer");
  runtime.findWorkflowForProposal = () => ({ status: "ambiguous" });
  assert.equal(guard("active"), "defer");
  runtime.findWorkflowForProposal = () => { throw new Error("lookup unavailable"); };
  assert.equal(guard("active"), "defer");

  runtime.findWorkflowForProposal = () => ({
    status: "governed",
    workflowStatus: "restored",
    migrationId: "migration",
    ruleRef: "rule",
    sourceBridgeId: "bridge-ha",
    sourceFingerprint: SOURCE_FINGERPRINT,
  });
  assert.equal(guard("active"), "defer");
  assert.equal(guard("paused"), "defer");

  runtime.findWorkflowForProposal = () => ({ status: "not_migration" });
  assert.equal(guard("active"), "allow");
});

test("allows target readback for stable verified migrations in active and paused lifecycles", () => {
  const { runtime, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedVerifiedLookup();
  const guard = (lifecycle: "active" | "paused") =>
    (wrapper as unknown as {
      reconciliationGuard(input: { proposalId: string; lifecycle: string }): "allow" | "defer";
    }).reconciliationGuard({ proposalId: BASE_REQUEST.proposalId, lifecycle });

  assert.equal(guard("active"), "allow");
  assert.equal(guard("paused"), "allow");
});

test("projects another same-bridge foreign rule into recovery instead of keeping the migration active", async () => {
  const { events, runtime, control, base, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedVerifiedLookup();
  runtime.readForeignRuleCatalog = () => {
    events.push("foreign.catalog");
    return { status: "changed" as const };
  };
  control.status = async () => {
    events.push("source.status");
    return { status: "paused", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const;
  };

  const result = await wrapper.reconcileStatus?.({
    proposalId: BASE_REQUEST.proposalId,
    lifecycle: "active",
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
  });

  assert.equal(result?.disposition, "recovery_required");
  assert.match((result as { readonly reason: string }).reason, /规则目录|重新评估/);
  assert.deepEqual(events, ["foreign.catalog", "runtime.fail"], "catalog drift is fail-closed before source/target reads");
});

test("projects verified target drift but requires recovery for an unknown target or two running rules", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedVerifiedLookup();
  control.status = async () => {
    events.push("source.status");
    return { status: "paused", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "running", configFingerprint: `sha256:${"c".repeat(64)}` } as const;
  };

  const drifted = await wrapper.reconcileStatus?.({
    proposalId: BASE_REQUEST.proposalId,
    lifecycle: "active",
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
  });
  assert.deepEqual(drifted, {
    disposition: "observed",
    target: { status: "running", configFingerprint: `sha256:${"c".repeat(64)}` },
  });

  base.status = async () => {
    events.push("base.status");
    return { status: "paused", configFingerprint: DEPLOYMENT_FINGERPRINT } as const;
  };
  const pausedTarget = await wrapper.reconcileStatus?.({
    proposalId: BASE_REQUEST.proposalId,
    lifecycle: "active",
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
  });
  assert.deepEqual(pausedTarget, {
    disposition: "observed",
    target: { status: "paused", configFingerprint: DEPLOYMENT_FINGERPRINT },
  });

  control.status = async () => {
    events.push("source.status");
    return { status: "running", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const;
  };
  const conflict = await wrapper.reconcileStatus?.({
    proposalId: BASE_REQUEST.proposalId,
    lifecycle: "active",
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
  });
  assert.equal(conflict?.disposition, "recovery_required");
  assert.match((conflict as { readonly reason: string }).reason, /原有规则已经重新运行/);

  control.status = async () => {
    events.push("source.status");
    return { status: "paused", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "unknown" } as const;
  };
  const unknown = await wrapper.reconcileStatus?.({
    proposalId: BASE_REQUEST.proposalId,
    lifecycle: "paused",
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
  });
  assert.equal(unknown?.disposition, "recovery_required");
  assert.match((unknown as { readonly reason: string }).reason, /暂时无法确认/);
  assert.deepEqual(events, [
    "source.status", "base.status",
    "source.status", "base.status",
    "source.status", "base.status", "runtime.fail",
    "source.status", "base.status", "runtime.fail",
  ]);
});

test("switches one ready migration only after CAS and verifies both neutral deployments", async () => {
  const { events, wrapper } = deploymentFixture();

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.deepEqual(outcome, {
    status: "verified",
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
    configFingerprint: DEPLOYMENT_FINGERPRINT,
  });
  assert.deepEqual(events, [
    "source.status",
    "runtime.startSwitch",
    "source.set:false",
    "base.deploy",
    "base.status",
    "source.status",
    "runtime.verifySwitch",
  ]);
});

test("rolls a verified migration back in target-first order", async () => {
  const { events, wrapper } = deploymentFixture();

  await wrapper.deploy(BASE_REQUEST);
  const outcome = await wrapper.withdraw({
    proposalId: BASE_REQUEST.proposalId,
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
    actor: BASE_REQUEST.actor,
  });

  assert.deepEqual(outcome, { restored: true });
  assert.deepEqual(events.slice(-9), [
    "base.status",
    "runtime.startRollback",
    "base.status",
    "base.withdraw",
    "base.status",
    "source.set:true",
    "source.status",
    "base.status",
    "runtime.restore",
  ]);
});

test("fails closed when the verified target is rewritten after rollback CAS preflight", async () => {
  const { events, failCalls, runtime, base, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedVerifiedLookup();
  let targetReads = 0;
  base.status = async () => {
    events.push("base.status");
    targetReads += 1;
    return targetReads === 1
      ? { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const
      : { status: "running", configFingerprint: `sha256:${"c".repeat(64)}` } as const;
  };
  base.withdraw = async () => {
    events.push("base.withdraw.unexpected");
    return { restored: true };
  };

  const outcome = await wrapper.withdraw({
    proposalId: BASE_REQUEST.proposalId,
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
    actor: BASE_REQUEST.actor,
  });

  assert.deepEqual(outcome, {
    restored: false,
    recoveryRequired: true,
    reason: "迁移回退的目标指纹无法验证，需要人工确认后恢复。",
  });
  assert.deepEqual(events, ["source.status", "base.status", "runtime.startRollback", "base.status", "runtime.fail"]);
  assert.equal(events.includes("base.withdraw.unexpected"), false);
  assert.deepEqual(failCalls.at(-1), {
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    from: "rolling_back",
    reason: "rollback_failed",
    expectedRollbackOperationId: ROLLBACK_OPERATION_ID,
  });
});

test("fails closed before rollback CAS when the persisted target fingerprint is missing", async () => {
  const { events, failCalls, runtime, base, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => ({
    ...governedVerifiedLookup(),
    deploymentConfigFingerprint: undefined,
  });
  base.status = async () => {
    events.push("base.status");
    return { status: "running" } as const;
  };
  base.withdraw = async () => {
    events.push("base.withdraw.unexpected");
    return { restored: true };
  };

  const outcome = await wrapper.withdraw({
    proposalId: BASE_REQUEST.proposalId,
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
    actor: BASE_REQUEST.actor,
  });

  assert.deepEqual(outcome, {
    restored: false,
    recoveryRequired: true,
    reason: "迁移回退的目标指纹无法验证，需要人工确认后恢复。",
  });
  assert.deepEqual(events, ["source.status", "base.status", "runtime.fail"]);
  assert.equal(events.includes("runtime.startRollback"), false);
  assert.equal(events.includes("base.withdraw.unexpected"), false);
  assert.deepEqual(failCalls.at(-1), {
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    from: "verified",
    reason: "verification_failed",
    expectedSwitchOperationId: PERSISTED_SWITCH_OPERATION_ID,
  });
});

test("allows a paused target with the exact persisted fingerprint to be withdrawn after rollback CAS", async () => {
  const { events, runtime, base, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedVerifiedLookup();
  let targetReads = 0;
  base.status = async () => {
    events.push("base.status");
    targetReads += 1;
    if (targetReads < 3) return { status: "paused", configFingerprint: DEPLOYMENT_FINGERPRINT } as const;
    return { status: "missing" } as const;
  };

  const outcome = await wrapper.withdraw({
    proposalId: BASE_REQUEST.proposalId,
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
    actor: BASE_REQUEST.actor,
  });

  assert.deepEqual(outcome, { restored: true });
  assert.deepEqual(events, [
    "source.status",
    "base.status",
    "runtime.startRollback",
    "base.status",
    "base.withdraw",
    "base.status",
    "source.status",
    "base.status",
    "runtime.restore",
  ]);
});

test("skips target deletion when the verified target is already missing", async () => {
  const { events, runtime, base, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedVerifiedLookup();
  base.status = async () => {
    events.push("base.status");
    return { status: "missing" } as const;
  };
  base.withdraw = async () => {
    events.push("base.withdraw.unexpected");
    return { restored: true };
  };

  const outcome = await wrapper.withdraw({
    proposalId: BASE_REQUEST.proposalId,
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
    actor: BASE_REQUEST.actor,
  });

  assert.deepEqual(outcome, { restored: true });
  assert.deepEqual(events, [
    "source.status",
    "base.status",
    "runtime.startRollback",
    "base.status",
    "source.status",
    "base.status",
    "runtime.restore",
  ]);
  assert.equal(events.includes("base.withdraw.unexpected"), false);
});

test("replays a verified migration from exact readback without redeploying or writing CAS state", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedVerifiedLookup();
  control.status = async () => {
    events.push("source.status");
    return { status: "paused", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const;
  };
  base.deploy = async () => {
    events.push("base.deploy.unexpected");
    throw new Error("verified replay must not deploy");
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.deepEqual(outcome, {
    status: "verified",
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
    configFingerprint: DEPLOYMENT_FINGERPRINT,
  });
  assert.deepEqual(events, ["source.status", "base.status"]);
});

test("rejects a verified replay when its persisted identity or approved revision disagrees", async () => {
  for (const lookup of [
    { ...governedVerifiedLookup(), approvedProposalRevision: BASE_REQUEST.revision + 1 },
    { ...governedVerifiedLookup(), deploymentId: "other-deployment" },
    { ...governedVerifiedLookup(), deploymentTarget: "other-target" },
    { ...governedVerifiedLookup(), deploymentConfigFingerprint: undefined },
  ]) {
    const { events, runtime, wrapper } = deploymentFixture();
    runtime.findWorkflowForProposal = () => lookup;

    const outcome = await wrapper.deploy(BASE_REQUEST);

    assert.equal(outcome.status, "failed");
    assert.deepEqual(events, []);
  }
});

test("converges a restored migration withdrawal from exact readback without any write", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedRestoredLookup();
  control.status = async () => {
    events.push("source.status");
    return { status: "running", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "missing" } as const;
  };
  base.withdraw = async () => {
    events.push("base.withdraw.unexpected");
    throw new Error("restored withdrawal must not write");
  };

  const outcome = await wrapper.withdraw({
    proposalId: BASE_REQUEST.proposalId,
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
    actor: BASE_REQUEST.actor,
  });

  assert.deepEqual(outcome, { restored: true });
  assert.deepEqual(events, ["source.status", "base.status"]);
});

test("converges restored migration recovery from exact readback without any write", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedRestoredLookup();
  control.status = async () => {
    events.push("source.status");
    return { status: "running", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "missing" } as const;
  };
  base.withdraw = async () => {
    events.push("base.withdraw.unexpected");
    throw new Error("restored recovery must not write");
  };

  const outcome = await wrapper.recover({
    proposalId: BASE_REQUEST.proposalId,
    revision: BASE_REQUEST.revision + 1,
    actor: BASE_REQUEST.actor,
    kind: BASE_REQUEST.kind,
    title: BASE_REQUEST.title,
    artifactCandidate: BASE_REQUEST.artifactCandidate,
    intent: BASE_REQUEST.intent,
  });

  assert.deepEqual(outcome, { restored: true });
  assert.deepEqual(events, ["source.status", "base.status"]);
});

test("rejects restored convergence when the deployment identity is missing or inconsistent", async () => {
  for (const request of [
    { ...BASE_REQUEST, intent: { ...BASE_REQUEST.intent, deploymentId: "other-deployment" } },
    { ...BASE_REQUEST, intent: { ...BASE_REQUEST.intent, target: "other-target" } },
  ]) {
    const { events, runtime, wrapper } = deploymentFixture();
    runtime.findWorkflowForProposal = () => governedRestoredLookup();

    const outcome = await wrapper.withdraw({
      proposalId: request.proposalId,
      deploymentId: request.intent.deploymentId,
      target: request.intent.target,
      actor: request.actor,
    });

    assert.equal(outcome.restored, false);
    assert.equal(outcome.recoveryRequired, true);
    assert.deepEqual(events, []);
  }
});

test("fails closed when verified readback does not match the persisted source or target", async () => {
  for (const mismatch of [
    {
      name: "source status",
      source: { status: "running", sourceFingerprint: SOURCE_FINGERPRINT } as const,
      target: { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const,
    },
    {
      name: "source fingerprint",
      source: { status: "paused", sourceFingerprint: `sha256:${"c".repeat(64)}` } as const,
      target: { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const,
    },
    {
      name: "target status",
      source: { status: "paused", sourceFingerprint: SOURCE_FINGERPRINT } as const,
      target: { status: "paused", configFingerprint: DEPLOYMENT_FINGERPRINT } as const,
    },
    {
      name: "target fingerprint",
      source: { status: "paused", sourceFingerprint: SOURCE_FINGERPRINT } as const,
      target: { status: "running", configFingerprint: `sha256:${"c".repeat(64)}` } as const,
    },
  ]) {
    const { events, runtime, base, control, wrapper } = deploymentFixture();
    runtime.findWorkflowForProposal = () => governedVerifiedLookup();
    control.status = async () => {
      events.push("source.status");
      return mismatch.source;
    };
    base.status = async () => {
      events.push("base.status");
      return mismatch.target;
    };
    base.deploy = async () => {
      events.push("base.deploy.unexpected");
      throw new Error(`${mismatch.name} must not deploy`);
    };
    control.setEnabled = async () => {
      events.push("source.set.unexpected");
      throw new Error(`${mismatch.name} must not change the source`);
    };

    const outcome = await wrapper.deploy(BASE_REQUEST);

    assert.equal(outcome.status, "failed", mismatch.name);
    assert.deepEqual(events, ["source.status", "base.status"], mismatch.name);
  }
});

test("requires exact restored readback before converging a close", async () => {
  for (const mismatch of [
    {
      name: "source status",
      source: { status: "paused", sourceFingerprint: SOURCE_FINGERPRINT } as const,
      target: { status: "missing" } as const,
    },
    {
      name: "source fingerprint",
      source: { status: "running", sourceFingerprint: `sha256:${"c".repeat(64)}` } as const,
      target: { status: "missing" } as const,
    },
    {
      name: "target status",
      source: { status: "running", sourceFingerprint: SOURCE_FINGERPRINT } as const,
      target: { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const,
    },
  ]) {
    const { events, runtime, base, control, wrapper } = deploymentFixture();
    runtime.findWorkflowForProposal = () => governedRestoredLookup();
    control.status = async () => {
      events.push("source.status");
      return mismatch.source;
    };
    base.status = async () => {
      events.push("base.status");
      return mismatch.target;
    };
    base.withdraw = async () => {
      events.push("base.withdraw.unexpected");
      throw new Error(`${mismatch.name} must not withdraw`);
    };
    control.setEnabled = async () => {
      events.push("source.set.unexpected");
      throw new Error(`${mismatch.name} must not change the source`);
    };

    const outcome = await wrapper.withdraw({
      proposalId: BASE_REQUEST.proposalId,
      deploymentId: BASE_REQUEST.intent.deploymentId,
      target: BASE_REQUEST.intent.target,
      actor: BASE_REQUEST.actor,
    });

    assert.equal(outcome.restored, false, mismatch.name);
    assert.equal(outcome.recoveryRequired, true, mismatch.name);
    assert.deepEqual(events, ["source.status", "base.status"], mismatch.name);
  }
});

test("fails closed after a known target deployment failure without a durable target fingerprint", async () => {
  for (const target of [
    { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const,
    { status: "paused", configFingerprint: DEPLOYMENT_FINGERPRINT } as const,
  ]) {
    const { events, failCalls, runtime, base, wrapper } = deploymentFixture();
    const initialLookup = runtime.findWorkflowForProposal;
    let lookupCount = 0;
    runtime.findWorkflowForProposal = (proposalId: string) => {
      lookupCount += 1;
      return lookupCount === 1 ? initialLookup(proposalId) : governedLookup("needs_attention", "switch_failed");
    };
    base.deploy = async () => {
      events.push("base.deploy");
      return {
        status: "failed",
        deploymentId: BASE_REQUEST.intent.deploymentId,
        target: BASE_REQUEST.intent.target,
        reason: "known rejection",
      };
    };
    base.status = async () => {
      events.push("base.status");
      return target;
    };

    const outcome = await wrapper.deploy(BASE_REQUEST);

    assert.equal(outcome.status, "failed", target.status);
    assert.deepEqual(events, [
      "source.status",
      "runtime.startSwitch",
      "source.set:false",
      "base.deploy",
      "base.status",
      "runtime.fail",
    ], target.status);
    assert.deepEqual(failCalls, [{
      migrationId: "0123456789abcdef0123456789abcdef",
      ruleRef: "opaque-rule-ref",
      from: "switching",
      reason: "verification_failed",
      expectedSwitchOperationId: SWITCH_OPERATION_ID,
    }], target.status);
  }
});

test("restores the source after a failed target is read back missing without deleting", async () => {
  const { events, failCalls, runtime, base, wrapper } = deploymentFixture();
  const restoreInputs: unknown[] = [];
  runtime.restoreFailedSwitch = (input: unknown) => {
    events.push("runtime.restoreFailedSwitch");
    restoreInputs.push(input);
    return true;
  };
  const initialLookup = runtime.findWorkflowForProposal;
  let lookupCount = 0;
  runtime.findWorkflowForProposal = (proposalId: string) => {
    lookupCount += 1;
    return lookupCount === 1 ? initialLookup(proposalId) : governedLookup("needs_attention", "switch_failed");
  };
  base.deploy = async () => {
    events.push("base.deploy");
    return {
      status: "failed",
      deploymentId: BASE_REQUEST.intent.deploymentId,
      target: BASE_REQUEST.intent.target,
      reason: "known rejection",
    };
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "missing" } as const;
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.deepEqual(outcome, { status: "failed", reason: "迁移切换没有完成，原有规则保持可恢复状态。" });
  assert.deepEqual(events, [
    "source.status",
    "runtime.startSwitch",
    "source.set:false",
    "base.deploy",
    "base.status",
    "source.set:true",
    "source.status",
    "base.status",
    "runtime.fail",
    "runtime.restoreFailedSwitch",
  ]);
  assert.deepEqual(failCalls, [{
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    from: "switching",
    reason: "switch_failed",
    expectedSwitchOperationId: SWITCH_OPERATION_ID,
  }]);
  assert.deepEqual(restoreInputs, [{
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    expectedApprovedProposalRevision: 3,
    expectedFailureReason: "switch_failed",
    expectedSwitchOperationId: "11111111111111111111111111111111",
    expectedSwitchStartedAt: "2026-08-24T00:00:03.000Z",
  }]);
});

test("fails closed when a failed switch has no persisted target fingerprint", async () => {
  const { events, runtime, base, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedLookup("needs_attention", "switch_failed");
  base.status = async () => {
    events.push("base.status");
    return events.includes("base.withdraw") ? { status: "missing" } as const : { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const;
  };
  base.deploy = async () => {
    events.push("base.deploy.unexpected");
    throw new Error("failed-switch recovery must not replay deployment");
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.deepEqual(outcome, {
    status: "failed",
    reason: "迁移自动化的部署指纹无法验证，已停止后续写入。",
  });
  assert.deepEqual(events, ["source.status", "base.status"]);
  assert.equal(events.includes("base.deploy.unexpected"), false);
});

test("accepts a failed-switch recovery when exact readback is already restored without replaying or writing a new receipt", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedLookup("needs_attention", "switch_unknown");
  control.status = async () => {
    events.push("source.status");
    return { status: "running", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "missing" } as const;
  };
  base.deploy = async () => {
    events.push("base.deploy.unexpected");
    throw new Error("already restored recovery must not deploy");
  };
  base.withdraw = async () => {
    events.push("base.withdraw.unexpected");
    return { restored: false };
  };

  const outcome = await wrapper.recover({
    proposalId: BASE_REQUEST.proposalId,
    revision: BASE_REQUEST.revision,
    actor: BASE_REQUEST.actor,
    kind: BASE_REQUEST.kind,
    title: BASE_REQUEST.title,
    artifactCandidate: BASE_REQUEST.artifactCandidate,
    intent: BASE_REQUEST.intent,
  });

  assert.deepEqual(outcome, { restored: true });
  assert.deepEqual(events, ["source.status", "base.status", "runtime.restoreFailedSwitch"]);
});

test("fails closed before using an un-fingerprinted failed-switch target identity", async () => {
  const { events, runtime, base, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedLookup("needs_attention", "switch_failed");
  base.status = async () => {
    events.push("base.status");
    return events.includes("base.withdraw") ? { status: "missing" } as const : { status: "running" } as const;
  };
  base.withdraw = async (request) => {
    events.push("base.withdraw");
    assert.deepEqual(request, {
      proposalId: BASE_REQUEST.proposalId,
      deploymentId: BASE_REQUEST.intent.deploymentId,
      target: BASE_REQUEST.intent.target,
      actor: BASE_REQUEST.actor,
    });
    return { restored: true };
  };

  const outcome = await wrapper.withdraw({
    proposalId: BASE_REQUEST.proposalId,
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
    actor: BASE_REQUEST.actor,
  });

  assert.deepEqual(outcome, {
    restored: false,
    recoveryRequired: true,
    reason: "迁移自动化的部署指纹无法验证，已停止后续写入。",
  });
  assert.deepEqual(events, ["source.status", "base.status"]);
});

test("does not claim a failed-switch recovery after the exact receipt CAS loses a race", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  const first = governedLookup("needs_attention", "switch_failed");
  runtime.findWorkflowForProposal = () => first;
  control.status = async () => {
    events.push("source.status");
    return { status: "running", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "missing" } as const;
  };
  runtime.restoreFailedSwitch = () => {
    events.push("runtime.restoreFailedSwitch");
    return false;
  };

  const outcome = await wrapper.recover({
    proposalId: BASE_REQUEST.proposalId,
    revision: BASE_REQUEST.revision,
    actor: BASE_REQUEST.actor,
    kind: BASE_REQUEST.kind,
    title: BASE_REQUEST.title,
    artifactCandidate: BASE_REQUEST.artifactCandidate,
    intent: BASE_REQUEST.intent,
  });

  assert.deepEqual(outcome, {
    restored: false,
    recoveryRequired: true,
    reason: "迁移切换结果暂时无法确认，已停止后续写入。",
  });
  assert.deepEqual(events, ["source.status", "base.status", "runtime.restoreFailedSwitch"]);
});

test("fails closed when a verified outcome returns a rogue identity without a durable target fingerprint", async () => {
  const { withdrawRequests, base, wrapper } = deploymentFixture();
  base.deploy = async () => ({
    status: "verified",
    deploymentId: "rogue-deployment",
    target: "rogue-target",
    configFingerprint: DEPLOYMENT_FINGERPRINT,
  });

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.deepEqual(outcome, {
    status: "failed",
    reason: "迁移自动化的部署身份无法验证，已停止后续写入。",
  });
  assert.deepEqual(withdrawRequests, []);
});

test("records rolling-back failure when the Hob target cannot be withdrawn", async () => {
  const { failCalls, base, wrapper } = deploymentFixture();
  await wrapper.deploy(BASE_REQUEST);
  base.withdraw = async () => ({ restored: false });

  const outcome = await wrapper.withdraw({
    proposalId: BASE_REQUEST.proposalId,
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
    actor: BASE_REQUEST.actor,
  });

  assert.deepEqual(outcome, { restored: false, recoveryRequired: true, reason: "迁移回退没有完成，原有规则状态需要处理。" });
  assert.deepEqual(failCalls.at(-1), {
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    from: "rolling_back",
    reason: "rollback_failed",
    expectedRollbackOperationId: ROLLBACK_OPERATION_ID,
  });
});

test("projects a rollback CAS loss as recovery-required and leaves the target untouched", async () => {
  const { events, failCalls, runtime, wrapper } = deploymentFixture();
  await wrapper.deploy(BASE_REQUEST);
  runtime.startRuleRollback = () => {
    events.push("runtime.startRollback");
    return false;
  };

  const outcome = await wrapper.withdraw({
    proposalId: BASE_REQUEST.proposalId,
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
    actor: BASE_REQUEST.actor,
  });

  assert.deepEqual(outcome, {
    restored: false,
    recoveryRequired: true,
    reason: "迁移回退结果暂时无法确认，已停止后续写入。",
  });
  assert.deepEqual(events.slice(-2), ["runtime.startRollback", "runtime.fail"]);
  assert.deepEqual(failCalls.at(-1), {
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    from: "verified",
    reason: "verification_failed",
    expectedSwitchOperationId: PERSISTED_SWITCH_OPERATION_ID,
  });
});

test("rejects a stale source before CAS or any write", async () => {
  const { events, failCalls, control, wrapper } = deploymentFixture();
  control.status = async () => {
    events.push("source.status");
    return { status: "paused", sourceFingerprint: SOURCE_FINGERPRINT };
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.equal(outcome.status, "failed");
  assert.deepEqual(events, ["source.status", "runtime.fail"]);
  assert.deepEqual(failCalls.at(-1), {
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    from: "ready",
    reason: "source_stale",
  });
});

test("stops after an unknown source preflight without downstream writes", async () => {
  const { events, failCalls, control, wrapper } = deploymentFixture();
  control.status = async () => {
    events.push("source.status");
    return { status: "unknown", reason: "unavailable" };
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.equal(outcome.status, "failed");
  assert.deepEqual(events, ["source.status", "runtime.fail"]);
  assert.deepEqual(failCalls.at(-1), {
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    from: "ready",
    reason: "switch_unknown",
  });
});

test("stops after an unknown source command without downstream writes", async () => {
  const { events, failCalls, control, wrapper } = deploymentFixture();
  control.setEnabled = async (request: { readonly enabled: boolean }) => {
    events.push(`source.set:${request.enabled}`);
    return { status: "unknown", reason: "upstream_unavailable" };
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.equal(outcome.status, "failed");
  assert.deepEqual(events, ["source.status", "runtime.startSwitch", "source.set:false", "runtime.fail"]);
  assert.deepEqual(failCalls.at(-1), {
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    from: "switching",
    reason: "switch_unknown",
    expectedSwitchOperationId: SWITCH_OPERATION_ID,
  });
});

test("distinguishes a known source rejection from an unknown source effect", async () => {
  const { events, failCalls, control, wrapper } = deploymentFixture();
  control.setEnabled = async (request: { readonly enabled: boolean }) => {
    events.push(`source.set:${request.enabled}`);
    return { status: "rejected", reason: "stale_source" };
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.equal(outcome.status, "failed");
  assert.deepEqual(events, ["source.status", "runtime.startSwitch", "source.set:false", "runtime.fail"]);
  assert.deepEqual(failCalls.at(-1), {
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    from: "switching",
    reason: "switch_failed",
    expectedSwitchOperationId: SWITCH_OPERATION_ID,
  });
});

test("fully delegates non-migration proposals", async () => {
  const { events, runtime, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => ({ status: "not_migration" });

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.equal(outcome.status, "verified");
  assert.deepEqual(events, ["base.deploy"]);
});

test("pause and resume only delegate the Hob target after migration cutover", async () => {
  const { events, wrapper } = deploymentFixture();
  await wrapper.deploy(BASE_REQUEST);
  await wrapper.pause({ proposalId: BASE_REQUEST.proposalId, deploymentId: BASE_REQUEST.intent.deploymentId, target: BASE_REQUEST.intent.target });
  await wrapper.resume({ proposalId: BASE_REQUEST.proposalId, deploymentId: BASE_REQUEST.intent.deploymentId, target: BASE_REQUEST.intent.target });
  assert.deepEqual(events.slice(-2), ["base.pause", "base.resume"]);
  assert.equal(events.slice(-2).some((event) => event.startsWith("source.")), false);
});

test("records an unknown switch when verification CAS loses a race", async () => {
  const { events, failCalls, runtime, wrapper } = deploymentFixture();
  runtime.verifyRuleSwitch = () => {
    events.push("runtime.verifySwitch");
    return false;
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.equal(outcome.status, "failed");
  assert.deepEqual(events, [
    "source.status",
    "runtime.startSwitch",
    "source.set:false",
    "base.deploy",
    "base.status",
    "source.status",
    "runtime.verifySwitch",
    "runtime.fail",
  ]);
  assert.deepEqual(failCalls.at(-1), {
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    from: "switching",
    reason: "switch_unknown",
    expectedSwitchOperationId: SWITCH_OPERATION_ID,
  });
});

test("records rollback unknown when restore CAS loses a race", async () => {
  const { events, failCalls, runtime, wrapper } = deploymentFixture();
  await wrapper.deploy(BASE_REQUEST);
  runtime.restoreRule = (input: unknown) => {
    events.push("runtime.restore");
    return false;
  };

  const outcome = await wrapper.withdraw({
    proposalId: BASE_REQUEST.proposalId,
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
    actor: BASE_REQUEST.actor,
  });

  assert.deepEqual(outcome, { restored: false, recoveryRequired: true, reason: "迁移回退结果暂时无法确认，已停止后续写入。" });
  assert.deepEqual(failCalls.at(-1), {
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    from: "rolling_back",
    reason: "rollback_unknown",
    expectedRollbackOperationId: ROLLBACK_OPERATION_ID,
  });
});

test("records rollback unknown after CAS when the source control disappears", async () => {
  const { events, failCalls, sourcePort, wrapper } = deploymentFixture();
  await wrapper.deploy(BASE_REQUEST);
  sourcePort.foreignRuleControlFor = () => undefined;

  const outcome = await wrapper.withdraw({
    proposalId: BASE_REQUEST.proposalId,
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
    actor: BASE_REQUEST.actor,
  });

  assert.deepEqual(outcome, { restored: false, recoveryRequired: true, reason: "迁移回退结果暂时无法确认，已停止后续写入。" });
  assert.deepEqual(events.slice(-2), ["runtime.verifySwitch", "runtime.fail"]);
  assert.deepEqual(failCalls.at(-1), {
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    from: "verified",
    reason: "verification_failed",
    expectedSwitchOperationId: PERSISTED_SWITCH_OPERATION_ID,
  });
});

test("does not start rollback when verified source or target preflight is unknown", async () => {
  const { events, failCalls, control, base, wrapper } = deploymentFixture();
  await wrapper.deploy(BASE_REQUEST);
  control.status = async () => {
    events.push("source.status");
    return { status: "unknown", reason: "unavailable" } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "unknown" } as const;
  };

  const outcome = await wrapper.withdraw({
    proposalId: BASE_REQUEST.proposalId,
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
    actor: BASE_REQUEST.actor,
  });

  assert.deepEqual(outcome, {
    restored: false,
    recoveryRequired: true,
    reason: "迁移回退结果暂时无法确认，已停止后续写入。",
  });
  assert.deepEqual(events.slice(-3), ["source.status", "base.status", "runtime.fail"]);
  assert.deepEqual(failCalls.at(-1), {
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    from: "verified",
    reason: "verification_failed",
    expectedSwitchOperationId: PERSISTED_SWITCH_OPERATION_ID,
  });
});

test("closes a throwing deployment request without traversing provider fields", async () => {
  const { events, wrapper } = deploymentFixture();
  const throwing = new Proxy(BASE_REQUEST, {
    get() {
      throw new Error("provider payload must not be read");
    },
  });

  const outcome = await wrapper.deploy(throwing as never);

  assert.equal(outcome.status, "failed");
  assert.deepEqual(events, []);
});

test("recovers a paused source with a missing target without redeploying", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedLookup("needs_attention", "switch_failed");
  control.status = async () => {
    events.push("source.status");
    return { status: "paused", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "missing" } as const;
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.equal(outcome.status, "failed");
  assert.deepEqual(events, ["source.status", "base.status", "runtime.resumeSwitch", "source.set:true", "source.status", "base.status", "runtime.fail"]);
});

test("treats a paused target as known but unsafe and performs no recovery write", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedLookup("needs_attention", "switch_unknown");
  control.status = async () => {
    events.push("source.status");
    return { status: "paused", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "paused", configFingerprint: DEPLOYMENT_FINGERPRINT } as const;
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.deepEqual(outcome, {
    status: "failed",
    reason: "迁移自动化的部署指纹无法验证，已停止后续写入。",
  });
  assert.deepEqual(events, ["source.status", "base.status"]);
});

test("fails closed when failed-switch recovery has no persisted target fingerprint", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedLookup("needs_attention", "switch_unknown");
  control.status = async () => {
    events.push("source.status");
    return { status: events.filter((event) => event === "source.set:false").length > 0 ? "paused" : "running", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const;
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.deepEqual(outcome, {
    status: "failed",
    reason: "迁移自动化的部署指纹无法验证，已停止后续写入。",
  });
  assert.deepEqual(events, ["source.status", "base.status"]);
});

test("rejects a failed-switch receipt carrying an unexpected persisted target fingerprint", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => ({
    ...governedLookup("needs_attention", "switch_unknown"),
    deploymentConfigFingerprint: `sha256:${"c".repeat(64)}`,
  });
  control.status = async () => {
    events.push("source.status.unexpected");
    throw new Error("invalid failed-switch receipt must not read source");
  };
  base.status = async () => {
    events.push("base.status.unexpected");
    throw new Error("invalid failed-switch receipt must not read target");
  };
  base.withdraw = async () => {
    events.push("base.withdraw.unexpected");
    return { restored: true };
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.deepEqual(outcome, {
    status: "failed",
    reason: "迁移切换结果暂时无法确认，已停止后续写入。",
  });
  assert.deepEqual(events, []);
});

test("fails closed for a needs-attention switch when a present target lacks an exact persisted fingerprint", async () => {
  for (const scenario of [
    {
      name: "running target without fingerprint",
      target: { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const,
      persistedFingerprint: undefined,
    },
    {
      name: "paused target without fingerprint",
      target: { status: "paused", configFingerprint: DEPLOYMENT_FINGERPRINT } as const,
      persistedFingerprint: undefined,
    },
    {
      name: "running target with a mismatched fingerprint",
      target: { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const,
      persistedFingerprint: `sha256:${"c".repeat(64)}`,
    },
    {
      name: "paused target with a mismatched fingerprint",
      target: { status: "paused", configFingerprint: DEPLOYMENT_FINGERPRINT } as const,
      persistedFingerprint: `sha256:${"c".repeat(64)}`,
    },
  ]) {
    const { events, runtime, base, control, wrapper } = deploymentFixture();
    runtime.findWorkflowForProposal = () => ({
      ...governedLookup("needs_attention", "verification_failed"),
      deploymentId: undefined,
      deploymentTarget: undefined,
      deploymentConfigFingerprint: scenario.persistedFingerprint,
    });
    control.status = async () => {
      events.push("source.status");
      return { status: "running", sourceFingerprint: SOURCE_FINGERPRINT } as const;
    };
    control.setEnabled = async () => {
      events.push("source.set.unexpected");
      throw new Error(`${scenario.name} must not change the source`);
    };
    base.status = async () => {
      events.push("base.status");
      return scenario.target;
    };
    base.withdraw = async () => {
      events.push("base.withdraw.unexpected");
      return { restored: true };
    };

    const outcome = await wrapper.deploy(BASE_REQUEST);

    assert.deepEqual(outcome, {
      status: "failed",
      reason: "迁移自动化的部署指纹无法验证，已停止后续写入。",
    }, scenario.name);
    assert.deepEqual(events, ["source.status", "base.status"], scenario.name);
  }
});

test("cleans up a paused target only after needs-attention recovery confirms its exact fingerprint", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => ({
    ...governedLookup("needs_attention", "verification_failed"),
    deploymentId: undefined,
    deploymentTarget: undefined,
    deploymentConfigFingerprint: DEPLOYMENT_FINGERPRINT,
  });
  control.status = async () => {
    events.push("source.status");
    return events.includes("source.set:true")
      ? { status: "running", sourceFingerprint: SOURCE_FINGERPRINT } as const
      : { status: "paused", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return events.includes("base.withdraw")
      ? { status: "missing" } as const
      : { status: "paused", configFingerprint: DEPLOYMENT_FINGERPRINT } as const;
  };
  base.withdraw = async (request) => {
    events.push("base.withdraw");
    assert.deepEqual(request, {
      proposalId: BASE_REQUEST.proposalId,
      deploymentId: BASE_REQUEST.intent.deploymentId,
      target: BASE_REQUEST.intent.target,
      actor: BASE_REQUEST.actor,
    });
    return { restored: true };
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.deepEqual(outcome, {
    status: "failed",
    reason: "迁移切换没有完成，原有规则保持可恢复状态。",
  });
  assert.deepEqual(events, [
    "source.status",
    "base.status",
    "runtime.resumeSwitch",
    "base.status",
    "base.withdraw",
    "base.status",
    "source.set:true",
    "source.status",
    "runtime.fail",
  ]);
});

test("rechecks a paused target fingerprint after opening recovery CAS", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => ({
    ...governedLookup("needs_attention", "verification_failed"),
    deploymentId: undefined,
    deploymentTarget: undefined,
    deploymentConfigFingerprint: DEPLOYMENT_FINGERPRINT,
  });
  control.status = async () => {
    events.push("source.status");
    return { status: "paused", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  let targetReads = 0;
  base.status = async () => {
    events.push("base.status");
    targetReads += 1;
    return targetReads === 1
      ? { status: "paused", configFingerprint: DEPLOYMENT_FINGERPRINT } as const
      : { status: "running", configFingerprint: `sha256:${"c".repeat(64)}` } as const;
  };
  base.withdraw = async () => {
    events.push("base.withdraw.unexpected");
    return { restored: true };
  };
  control.setEnabled = async () => {
    events.push("source.set.unexpected");
    throw new Error("rewritten target must not change the source");
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.deepEqual(outcome, {
    status: "failed",
    reason: "迁移自动化的部署指纹无法验证，已停止后续写入。",
  });
  assert.deepEqual(events, ["source.status", "base.status", "runtime.resumeSwitch", "base.status", "runtime.fail"]);
});

test("does not write when recovery preflight is unknown", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedLookup("needs_attention", "switch_unknown");
  control.status = async () => {
    events.push("source.status");
    return { status: "unknown", reason: "unavailable" } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "unknown" } as const;
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.equal(outcome.status, "failed");
  assert.deepEqual(events, ["source.status"]);
});

test("closes an active switching receipt for every recovery preflight rejection without remote writes", async () => {
  for (const scenario of [
    {
      name: "semantic preflight blocked",
      kind: "semantic" as const,
      reason: "verification_failed" as const,
      events: ["runtime.fail"],
    },
    {
      name: "source control missing",
      kind: "control-missing" as const,
      reason: "switch_unknown" as const,
      events: ["runtime.fail"],
    },
    {
      name: "source status unknown",
      kind: "source-unknown" as const,
      reason: "switch_unknown" as const,
      events: ["source.status", "runtime.fail"],
    },
    {
      name: "source fingerprint stale",
      kind: "source-stale" as const,
      reason: "switch_failed" as const,
      events: ["source.status", "runtime.fail"],
    },
    {
      name: "target status unknown",
      kind: "target-unknown" as const,
      reason: "switch_unknown" as const,
      events: ["source.status", "base.status", "runtime.fail"],
    },
    {
      name: "target paused",
      kind: "target-paused" as const,
      reason: "verification_failed" as const,
      events: ["source.status", "base.status", "runtime.fail"],
    },
    {
      name: "target fingerprint mismatched",
      kind: "target-fingerprint" as const,
      reason: "verification_failed" as const,
      events: ["source.status", "base.status", "runtime.fail"],
    },
    {
      name: "paused target fingerprint mismatched",
      kind: "target-paused-fingerprint" as const,
      reason: "verification_failed" as const,
      events: ["source.status", "base.status", "runtime.fail"],
    },
  ]) {
    const { events, failCalls, runtime, base, control, sourcePort, wrapper } = deploymentFixture();
    runtime.findWorkflowForProposal = () => {
      const lookup = governedLookup("switching");
      return scenario.kind === "target-fingerprint" || scenario.kind === "target-paused-fingerprint"
        ? { ...lookup, deploymentConfigFingerprint: DEPLOYMENT_FINGERPRINT }
        : lookup;
    };

    if (scenario.kind === "semantic") {
      base.preflight = () => ({ status: "blocked" as const, reason: "state_stale" });
    } else if (scenario.kind === "control-missing") {
      sourcePort.foreignRuleControlFor = () => undefined;
    } else if (scenario.kind === "source-unknown") {
      control.status = async () => {
        events.push("source.status");
        return { status: "unknown", reason: "unavailable" } as const;
      };
    } else if (scenario.kind === "source-stale") {
      control.status = async () => {
        events.push("source.status");
        return { status: "running", sourceFingerprint: `sha256:${"c".repeat(64)}` } as const;
      };
    } else if (scenario.kind === "target-unknown") {
      base.status = async () => {
        events.push("base.status");
        return { status: "unknown" } as const;
      };
    } else if (scenario.kind === "target-paused") {
      base.status = async () => {
        events.push("base.status");
        return { status: "paused", configFingerprint: DEPLOYMENT_FINGERPRINT } as const;
      };
    } else if (scenario.kind === "target-fingerprint") {
      base.status = async () => {
        events.push("base.status");
        return { status: "running", configFingerprint: `sha256:${"c".repeat(64)}` } as const;
      };
    } else if (scenario.kind === "target-paused-fingerprint") {
      base.status = async () => {
        events.push("base.status");
        return { status: "paused", configFingerprint: `sha256:${"c".repeat(64)}` } as const;
      };
    }

    const outcome = await wrapper.deploy(BASE_REQUEST);

    assert.equal(outcome.status, "failed", scenario.name);
    assert.deepEqual(events, scenario.events, scenario.name);
    assert.deepEqual(failCalls, [{
      migrationId: "0123456789abcdef0123456789abcdef",
      ruleRef: "opaque-rule-ref",
      from: "switching",
      reason: scenario.reason,
      expectedSwitchOperationId: PERSISTED_SWITCH_OPERATION_ID,
    }], scenario.name);
  }
});

test("restarts switching recovery with a fresh operation id after a crash-left receipt", async () => {
  const { events, runtime, wrapper } = deploymentFixture();
  let workflow: "switching" | "needs_attention" | "verified" = "switching";
  let receipt = {
    operationId: PERSISTED_SWITCH_OPERATION_ID,
    startedAt: "2026-08-24T00:00:03.000Z",
  };
  const deployment = {
    deploymentId: BASE_REQUEST.intent.deploymentId,
    deploymentTarget: BASE_REQUEST.intent.target,
    deploymentConfigFingerprint: DEPLOYMENT_FINGERPRINT,
  } as const;
  const resumeOperationIds: string[] = [];
  runtime.findWorkflowForProposal = () => {
    if (workflow === "verified") return governedVerifiedLookup();
    if (workflow === "switching") {
      return {
        ...governedLookup("switching"),
        ...deployment,
        switchOperationId: receipt.operationId,
        switchStartedAt: receipt.startedAt,
      };
    }
    return {
      ...governedLookup("needs_attention", "switch_unknown"),
      ...deployment,
      switchOperationId: receipt.operationId,
      switchStartedAt: receipt.startedAt,
    };
  };
  runtime.failRuleWorkflow = (value: unknown) => {
    events.push("runtime.fail");
    const input = value as { readonly from: string; readonly expectedSwitchOperationId?: string };
    if (input.from === "switching") {
      assert.equal(input.expectedSwitchOperationId, receipt.operationId);
      workflow = "needs_attention";
    }
    return true;
  };
  runtime.resumeRuleSwitch = (...args: unknown[]) => {
    events.push("runtime.resumeSwitch");
    const input = args[0] as { readonly switchOperationId: string };
    resumeOperationIds.push(input.switchOperationId);
    if (input.switchOperationId === receipt.operationId) return false;
    receipt = {
      operationId: input.switchOperationId,
      startedAt: "2026-08-24T00:00:03.000Z",
    };
    workflow = "switching";
    if (resumeOperationIds.length === 1) throw new Error("simulated crash after recovery receipt");
    return true;
  };
  runtime.verifyRuleSwitch = () => {
    events.push("runtime.verifySwitch");
    workflow = "verified";
    return true;
  };

  await assert.rejects(() => wrapper.deploy(BASE_REQUEST), /simulated crash after recovery receipt/);
  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.deepEqual(outcome, {
    status: "verified",
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
    configFingerprint: DEPLOYMENT_FINGERPRINT,
  });
  assert.equal(resumeOperationIds.length, 2);
  assert.notEqual(resumeOperationIds[1], resumeOperationIds[0]);
  assert.equal(resumeOperationIds.every((value) => /^[0-9a-f]{32}$/.test(value)), true);
});

test("does not verify an un-fingerprinted running target during switching recovery", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedLookup("switching");
  control.status = async () => {
    events.push("source.status");
    return { status: "running", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return events.filter((event) => event === "base.withdraw").length > 0
      ? { status: "missing" } as const
      : { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const;
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.deepEqual(outcome, {
    status: "failed",
    reason: "迁移自动化的部署指纹无法验证，已停止后续写入。",
  });
  assert.deepEqual(events, ["source.status", "base.status", "runtime.fail"]);
});

test("records a switching fingerprint failure before target cleanup when no fingerprint is persisted", async () => {
  const { events, runtime, base, control, failCalls, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedLookup("switching");
  base.withdraw = undefined;
  control.status = async () => {
    events.push("source.status");
    return { status: "running", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const;
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.deepEqual(outcome, {
    status: "failed",
    reason: "迁移自动化的部署指纹无法验证，已停止后续写入。",
  });
  assert.deepEqual(events, ["source.status", "base.status", "runtime.fail"]);
  assert.deepEqual(failCalls, [
    {
      migrationId: "0123456789abcdef0123456789abcdef",
      ruleRef: "opaque-rule-ref",
      from: "switching",
      reason: "verification_failed",
      expectedSwitchOperationId: PERSISTED_SWITCH_OPERATION_ID,
    },
  ]);
});

test("gates recoverKnownFailure by the durable target fingerprint before cleanup", async () => {
  for (const scenario of [
    { name: "unknown target", target: { status: "unknown" } as const, reason: "迁移切换结果暂时无法确认，已停止后续写入。" },
    { name: "mismatched target", target: { status: "running", configFingerprint: `sha256:${"c".repeat(64)}` } as const, reason: "迁移自动化的运行状态无法验证，已停止后续写入。" },
    { name: "paused mismatched target", target: { status: "paused", configFingerprint: `sha256:${"c".repeat(64)}` } as const, reason: "迁移自动化的运行状态无法验证，已停止后续写入。" },
    { name: "missing target", target: { status: "missing" } as const, reason: "迁移自动化的运行状态无法验证，已停止后续写入。" },
  ]) {
    const { events, failCalls, runtime, base, wrapper } = deploymentFixture();
    runtime.findWorkflowForProposal = () => ({
      ...governedLookup("switching"),
      deploymentId: BASE_REQUEST.intent.deploymentId,
      deploymentTarget: BASE_REQUEST.intent.target,
      deploymentConfigFingerprint: DEPLOYMENT_FINGERPRINT,
    });
    let targetReads = 0;
    base.status = async () => {
      events.push("base.status");
      targetReads += 1;
      if (targetReads === 1) return { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const;
      return scenario.target;
    };
    base.withdraw = async () => {
      events.push("base.withdraw.unexpected");
      return { restored: true };
    };

    const outcome = await wrapper.deploy(BASE_REQUEST);

    assert.deepEqual(outcome, { status: "failed", reason: scenario.reason }, scenario.name);
    assert.equal(events.includes("base.withdraw.unexpected"), false, scenario.name);
    assert.equal(events.includes("source.set:true"), scenario.name === "missing target", scenario.name);
    assert.equal(events.includes("runtime.verifySwitch"), false, scenario.name);
    assert.deepEqual(failCalls.at(-1), {
      migrationId: "0123456789abcdef0123456789abcdef",
      ruleRef: "opaque-rule-ref",
      from: "switching",
      reason: scenario.name === "unknown target" ? "switch_unknown" : "verification_failed",
      expectedSwitchOperationId: RECOVERY_SWITCH_OPERATION_ID,
    }, scenario.name);
  }
});

test("allows recoverKnownFailure cleanup after an exact durable target readback", async () => {
  const { events, failCalls, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => ({
    ...governedLookup("switching"),
    deploymentId: BASE_REQUEST.intent.deploymentId,
    deploymentTarget: BASE_REQUEST.intent.target,
    deploymentConfigFingerprint: DEPLOYMENT_FINGERPRINT,
  });
  control.status = async () => {
    events.push("source.status");
    return { status: "running", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  let targetReads = 0;
  base.status = async () => {
    events.push("base.status");
    targetReads += 1;
    return targetReads >= 4 || events.includes("base.withdraw")
      ? { status: "missing" } as const
      : { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const;
  };
  base.withdraw = async (request) => {
    events.push("base.withdraw");
    assert.deepEqual(request, {
      proposalId: BASE_REQUEST.proposalId,
      deploymentId: BASE_REQUEST.intent.deploymentId,
      target: BASE_REQUEST.intent.target,
      actor: BASE_REQUEST.actor,
    });
    return { restored: true };
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.deepEqual(outcome, {
    status: "failed",
    reason: "迁移自动化的运行状态无法验证，已停止后续写入。",
  });
  assert.equal(events.includes("runtime.verifySwitch"), false);
  assert.deepEqual(failCalls.at(-1), {
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    from: "switching",
    reason: "verification_failed",
    expectedSwitchOperationId: RECOVERY_SWITCH_OPERATION_ID,
  });
});

test("rollback recovery withdraws the approved target, confirms missing, then restores source", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedLookup("needs_attention", "rollback_unknown");
  control.status = async () => {
    events.push("source.status");
    return { status: events.filter((event) => event === "source.set:true").length > 0 ? "running" : "paused", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return events.filter((event) => event === "base.withdraw").length > 0
      ? { status: "missing" } as const
      : { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const;
  };

  const outcome = await wrapper.recover({
    proposalId: BASE_REQUEST.proposalId,
    revision: BASE_REQUEST.revision,
    actor: BASE_REQUEST.actor,
    kind: BASE_REQUEST.kind,
    title: BASE_REQUEST.title,
    artifactCandidate: BASE_REQUEST.artifactCandidate,
    intent: BASE_REQUEST.intent,
  });

  assert.deepEqual(outcome, { restored: true });
  assert.deepEqual(events, ["source.status", "base.status", "runtime.resumeRollback", "base.status", "base.withdraw", "base.status", "source.set:true", "source.status", "base.status", "runtime.restore"]);
});

test("fails closed when recovery sees a rewritten target after resuming its rollback receipt", async () => {
  const { events, failCalls, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedLookup("needs_attention", "rollback_unknown");
  control.status = async () => {
    events.push("source.status");
    return { status: "paused", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  let targetReads = 0;
  base.status = async () => {
    events.push("base.status");
    targetReads += 1;
    return targetReads === 1
      ? { status: "running", configFingerprint: DEPLOYMENT_FINGERPRINT } as const
      : { status: "running", configFingerprint: `sha256:${"c".repeat(64)}` } as const;
  };
  base.withdraw = async () => {
    events.push("base.withdraw.unexpected");
    return { restored: true };
  };

  const outcome = await wrapper.recover({
    proposalId: BASE_REQUEST.proposalId,
    revision: BASE_REQUEST.revision + 1,
    actor: BASE_REQUEST.actor,
    kind: BASE_REQUEST.kind,
    title: BASE_REQUEST.title,
    artifactCandidate: BASE_REQUEST.artifactCandidate,
    intent: BASE_REQUEST.intent,
  });

  assert.deepEqual(outcome, {
    restored: false,
    recoveryRequired: true,
    reason: "迁移回退的目标指纹无法验证，需要人工确认后恢复。",
  });
  assert.deepEqual(events, ["source.status", "base.status", "runtime.resumeRollback", "base.status", "runtime.fail"]);
  assert.equal(events.includes("base.withdraw.unexpected"), false);
  assert.deepEqual(failCalls.at(-1), {
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    from: "rolling_back",
    reason: "rollback_failed",
    expectedRollbackOperationId: RECOVERY_ROLLBACK_OPERATION_ID,
  });
});

test("fails closed before recovery receipt CAS when the persisted target fingerprint is missing", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => ({
    ...governedLookup("needs_attention", "rollback_unknown"),
    deploymentConfigFingerprint: undefined,
  });
  control.status = async () => {
    events.push("source.status");
    return { status: "paused", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "running" } as const;
  };
  base.withdraw = async () => {
    events.push("base.withdraw.unexpected");
    return { restored: true };
  };

  const outcome = await wrapper.recover({
    proposalId: BASE_REQUEST.proposalId,
    revision: BASE_REQUEST.revision + 1,
    actor: BASE_REQUEST.actor,
    kind: BASE_REQUEST.kind,
    title: BASE_REQUEST.title,
    artifactCandidate: BASE_REQUEST.artifactCandidate,
    intent: BASE_REQUEST.intent,
  });

  assert.deepEqual(outcome, {
    restored: false,
    recoveryRequired: true,
    reason: "迁移回退的目标指纹无法验证，需要人工确认后恢复。",
  });
  assert.deepEqual(events, ["source.status", "base.status"]);
  assert.equal(events.includes("runtime.resumeRollback"), false);
  assert.equal(events.includes("base.withdraw.unexpected"), false);
});

test("allows a paused target with the exact persisted fingerprint during rollback recovery", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedLookup("needs_attention", "rollback_unknown");
  control.status = async () => {
    events.push("source.status");
    return { status: events.includes("source.set:true") ? "running" : "paused", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  let targetReads = 0;
  base.status = async () => {
    events.push("base.status");
    targetReads += 1;
    return targetReads < 3
      ? { status: "paused", configFingerprint: DEPLOYMENT_FINGERPRINT } as const
      : { status: "missing" } as const;
  };

  const outcome = await wrapper.recover({
    proposalId: BASE_REQUEST.proposalId,
    revision: BASE_REQUEST.revision + 1,
    actor: BASE_REQUEST.actor,
    kind: BASE_REQUEST.kind,
    title: BASE_REQUEST.title,
    artifactCandidate: BASE_REQUEST.artifactCandidate,
    intent: BASE_REQUEST.intent,
  });

  assert.deepEqual(outcome, { restored: true });
  assert.deepEqual(events, [
    "source.status",
    "base.status",
    "runtime.resumeRollback",
    "base.status",
    "base.withdraw",
    "base.status",
    "source.set:true",
    "source.status",
    "base.status",
    "runtime.restore",
  ]);
});

test("skips target deletion when rollback recovery reads a missing target", async () => {
  const { events, runtime, base, control, wrapper } = deploymentFixture();
  runtime.findWorkflowForProposal = () => governedLookup("needs_attention", "rollback_unknown");
  control.status = async () => {
    events.push("source.status");
    return { status: events.includes("source.set:true") ? "running" : "paused", sourceFingerprint: SOURCE_FINGERPRINT } as const;
  };
  base.status = async () => {
    events.push("base.status");
    return { status: "missing" } as const;
  };
  base.withdraw = async () => {
    events.push("base.withdraw.unexpected");
    return { restored: true };
  };

  const outcome = await wrapper.recover({
    proposalId: BASE_REQUEST.proposalId,
    revision: BASE_REQUEST.revision + 1,
    actor: BASE_REQUEST.actor,
    kind: BASE_REQUEST.kind,
    title: BASE_REQUEST.title,
    artifactCandidate: BASE_REQUEST.artifactCandidate,
    intent: BASE_REQUEST.intent,
  });

  assert.deepEqual(outcome, { restored: true });
  assert.deepEqual(events, [
    "source.status",
    "base.status",
    "runtime.resumeRollback",
    "base.status",
    "source.set:true",
    "source.status",
    "base.status",
    "runtime.restore",
  ]);
  assert.equal(events.includes("base.withdraw.unexpected"), false);
});
