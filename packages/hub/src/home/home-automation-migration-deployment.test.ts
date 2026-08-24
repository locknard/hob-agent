import assert from "node:assert/strict";
import test from "node:test";

import type { ProposalDeploymentPort } from "./home-proposal-service.js";
import {
  HomeAutomationMigrationDeployment,
  type HomeAutomationMigrationDeploymentLookup,
} from "./home-automation-migration-deployment.js";

const SOURCE_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const DEPLOYMENT_FINGERPRINT = `sha256:${"b".repeat(64)}`;
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
    switchOperationId: "11111111111111111111111111111111",
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
    "source.status",
    "base.status",
    "runtime.startRollback",
    "base.withdraw",
    "base.status",
    "source.set:true",
    "source.status",
    "base.status",
    "runtime.restore",
  ]);
});

test("records switching failure after a known target deployment failure and restores the source", async () => {
  const { events, failCalls, base, wrapper } = deploymentFixture();
  base.deploy = async () => {
    events.push("base.deploy");
    return {
      status: "failed",
      deploymentId: BASE_REQUEST.intent.deploymentId,
      target: BASE_REQUEST.intent.target,
      reason: "known rejection",
    };
  };

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.equal(outcome.status, "failed");
  assert.deepEqual(events, [
    "source.status",
    "runtime.startSwitch",
    "source.set:false",
    "base.deploy",
    "base.withdraw",
    "base.status",
    "source.set:true",
    "runtime.fail",
  ]);
  assert.deepEqual(failCalls, [{
    migrationId: "0123456789abcdef0123456789abcdef",
    ruleRef: "opaque-rule-ref",
    from: "switching",
    reason: "switch_failed",
  }]);
});

test("uses the approved intent identity when a verified outcome returns a rogue identity", async () => {
  const { withdrawRequests, base, wrapper } = deploymentFixture();
  base.deploy = async () => ({
    status: "verified",
    deploymentId: "rogue-deployment",
    target: "rogue-target",
    configFingerprint: DEPLOYMENT_FINGERPRINT,
  });

  const outcome = await wrapper.deploy(BASE_REQUEST);

  assert.equal(outcome.status, "failed");
  assert.deepEqual(withdrawRequests, [{
    proposalId: BASE_REQUEST.proposalId,
    deploymentId: BASE_REQUEST.intent.deploymentId,
    target: BASE_REQUEST.intent.target,
    actor: BASE_REQUEST.actor,
  }]);
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
  assert.deepEqual(events, ["source.status", "base.status", "runtime.resumeSwitch", "source.set:true", "source.status", "runtime.fail"]);
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

  assert.equal(outcome.status, "failed");
  assert.deepEqual(events, ["source.status", "base.status"]);
});

test("cleans up a running target when switching recovery has no persisted target fingerprint", async () => {
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

  assert.equal(outcome.status, "failed");
  assert.deepEqual(events, [
    "source.status",
    "base.status",
    "runtime.resumeSwitch",
    "base.withdraw",
    "base.status",
    "runtime.fail",
  ]);
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

  assert.equal(outcome.status, "failed");
  assert.deepEqual(events, [
    "source.status",
    "base.status",
    "runtime.fail",
    "runtime.resumeSwitch",
    "base.withdraw",
    "base.status",
    "source.status",
    "runtime.fail",
  ]);
});

test("records a known switching failure when target cleanup is unavailable", async () => {
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

  assert.deepEqual(outcome, { status: "failed", reason: "迁移切换没有完成，原有规则保持可恢复状态。" });
  assert.deepEqual(events, ["source.status", "base.status", "runtime.fail", "runtime.resumeSwitch", "runtime.fail"]);
  assert.deepEqual(failCalls, [
    {
      migrationId: "0123456789abcdef0123456789abcdef",
      ruleRef: "opaque-rule-ref",
      from: "switching",
      reason: "switch_unknown",
    },
    {
      migrationId: "0123456789abcdef0123456789abcdef",
      ruleRef: "opaque-rule-ref",
      from: "switching",
      reason: "switch_failed",
    },
  ]);
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
  assert.deepEqual(events, ["source.status", "base.status", "runtime.resumeRollback", "base.withdraw", "base.status", "source.set:true", "source.status", "base.status", "runtime.restore"]);
});
