import assert from "node:assert/strict";
import test from "node:test";

import {
  MigrationCutoverRecoveryCoordinator,
  type MigrationCutoverRecoveryOptions,
  type MigrationCutoverWorkflowLookup,
} from "./migration-cutover-recovery.js";

const SOURCE_BRIDGE = "source-bridge";
const TARGET_BRIDGE = "target-bridge";

interface FixtureProposal {
  readonly id: string;
  readonly revision: number;
  readonly reviewLane: string;
  readonly lifecycle: string;
  readonly deployment?: { readonly target?: string };
}

function proposal(
  id: string,
  lifecycle: string,
  overrides: Partial<FixtureProposal> = {},
): FixtureProposal {
  return {
    id,
    revision: 7,
    reviewLane: "migration",
    lifecycle,
    deployment: { target: TARGET_BRIDGE },
    ...overrides,
  };
}

function lookup(
  status: "ready" | "governed" | "ambiguous" | "not_migration",
  overrides: Record<string, unknown> = {},
): MigrationCutoverWorkflowLookup {
  if (status === "ambiguous" || status === "not_migration") return { status };
  if (status === "ready") {
    return {
      status,
      sourceBridgeId: SOURCE_BRIDGE,
      ...overrides,
    } as MigrationCutoverWorkflowLookup;
  }
  return {
    status,
    sourceBridgeId: SOURCE_BRIDGE,
    workflowStatus: "switching",
    ...overrides,
  } as MigrationCutoverWorkflowLookup;
}

function harness(
  automations: readonly FixtureProposal[],
  workflows: ReadonlyMap<string, MigrationCutoverWorkflowLookup>,
  options: {
    readonly ready?: boolean;
    readonly onRetry?: (input: unknown) => void | Promise<void>;
    readonly onRecover?: (input: unknown) => void | Promise<void>;
    readonly isBridgeReady?: (bridgeId: string) => boolean;
  } = {},
): {
  readonly options: MigrationCutoverRecoveryOptions;
  readonly retries: unknown[];
  readonly recoveries: unknown[];
  readonly bridgeChecks: string[];
} {
  const retries: unknown[] = [];
  const recoveries: unknown[] = [];
  const bridgeChecks: string[] = [];
  return {
    options: {
      proposals: {
        listAutomations: () => automations,
        retryEnable: async (input) => {
          retries.push(input);
          await options.onRetry?.(input);
        },
        recoverAutomation: async (input) => {
          recoveries.push(input);
          await options.onRecover?.(input);
        },
      },
      migrations: {
        findWorkflowForProposal: (proposalId) => workflows.get(proposalId) ?? { status: "not_migration" },
      },
      isBridgeReady: options.isBridgeReady ?? ((bridgeId) => {
        bridgeChecks.push(bridgeId);
        return options.ready ?? true;
      }),
    },
    retries,
    recoveries,
    bridgeChecks,
  };
}

test("retries only restartable enabling migration cutovers with exact system CAS input", async () => {
  const automations = [
    proposal("ready", "enabling"),
    proposal("switching", "enabling"),
    proposal("verified", "enabling"),
    proposal("switch-failed", "enabling"),
    proposal("switch-unknown", "enabling"),
    proposal("verification-without-target", "enabling"),
  ];
  const workflows = new Map<string, MigrationCutoverWorkflowLookup>([
    ["ready", lookup("ready")],
    ["switching", lookup("governed", { workflowStatus: "switching" })],
    ["verified", lookup("governed", { workflowStatus: "verified" })],
    ["switch-failed", lookup("governed", { workflowStatus: "needs_attention", failureReason: "switch_failed" })],
    ["switch-unknown", lookup("governed", { workflowStatus: "needs_attention", failureReason: "switch_unknown" })],
    ["verification-without-target", lookup("governed", { workflowStatus: "needs_attention", failureReason: "verification_failed" })],
  ]);
  const fixture = harness(automations, workflows);

  const result = await new MigrationCutoverRecoveryCoordinator(fixture.options).sweep();

  assert.deepEqual(result, { scanned: 6, retried: 6, recovered: 0, skipped: 0, failed: 0 });
  assert.deepEqual(fixture.retries, automations.map((item) => ({
    proposalId: item.id,
    expectedRevision: item.revision,
    actor: "system",
  })));
  assert.deepEqual(fixture.recoveries, []);
});

test("recovers only governed rolling-back and allowed migration attention states", async () => {
  const automations = [
    proposal("rolling-back", "recovery_required"),
    proposal("verification-failed", "recovery_required"),
    proposal("rollback-failed", "recovery_required"),
    proposal("rollback-unknown", "recovery_required"),
  ];
  const workflows = new Map<string, MigrationCutoverWorkflowLookup>([
    ["rolling-back", lookup("governed", { workflowStatus: "rolling_back" })],
    ["verification-failed", lookup("governed", { workflowStatus: "needs_attention", failureReason: "verification_failed" })],
    ["rollback-failed", lookup("governed", { workflowStatus: "needs_attention", failureReason: "rollback_failed" })],
    ["rollback-unknown", lookup("governed", { workflowStatus: "needs_attention", failureReason: "rollback_unknown" })],
  ]);
  const fixture = harness(automations, workflows);

  const result = await new MigrationCutoverRecoveryCoordinator(fixture.options).sweep();

  assert.deepEqual(result, { scanned: 4, retried: 0, recovered: 4, skipped: 0, failed: 0 });
  assert.deepEqual(fixture.recoveries, automations.map((item) => ({
    proposalId: item.id,
    expectedRevision: item.revision,
    actor: "system",
  })));
  assert.deepEqual(fixture.retries, []);
});

test("skips non-migration, ambiguous, unsupported, identity-bearing, and not-ready rows without writes", async () => {
  const automations = [
    proposal("standard-lane", "enabling", { reviewLane: "standard" }),
    proposal("active", "active"),
    proposal("ambiguous", "enabling"),
    proposal("not-migration", "enabling"),
    proposal("unsupported", "enabling"),
    proposal("failed-with-target", "enabling"),
    proposal("wrong-recovery-reason", "recovery_required"),
    proposal("target-not-ready", "enabling"),
  ];
  const workflows = new Map<string, MigrationCutoverWorkflowLookup>([
    ["standard-lane", lookup("ready")],
    ["active", lookup("governed", { workflowStatus: "verified" })],
    ["ambiguous", lookup("ambiguous")],
    ["not-migration", lookup("not_migration")],
    ["unsupported", lookup("governed", { workflowStatus: "rolling_back" })],
    ["failed-with-target", lookup("governed", {
      workflowStatus: "needs_attention",
      failureReason: "verification_failed",
      deploymentId: "native-automation-1",
    })],
    ["wrong-recovery-reason", lookup("governed", { workflowStatus: "needs_attention", failureReason: "switch_failed" })],
    ["target-not-ready", lookup("ready")],
  ]);
  const fixture = harness(automations, workflows);
  // Keep the source bridge ready while the target bridge is unavailable.
  const readyChecks: string[] = [];
  const options: MigrationCutoverRecoveryOptions = {
    ...fixture.options,
    isBridgeReady: (bridgeId) => {
      readyChecks.push(bridgeId);
      return bridgeId !== TARGET_BRIDGE;
    },
  };

  const result = await new MigrationCutoverRecoveryCoordinator(options).sweep();

  assert.equal(result.scanned, automations.length);
  assert.equal(result.retried, 0);
  assert.equal(result.recovered, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, automations.length);
  assert.deepEqual(fixture.retries, []);
  assert.deepEqual(fixture.recoveries, []);
  assert.deepEqual(readyChecks, [SOURCE_BRIDGE, TARGET_BRIDGE]);
});

test("bounds one sweep at one hundred rows and isolates lookup and action failures", async () => {
  let lookupCalls = 0;
  const automations = Array.from({ length: 101 }, (_, index) => proposal(`proposal-${index}`, "enabling"));
  const workflows = new Map<string, MigrationCutoverWorkflowLookup>();
  for (const item of automations) workflows.set(item.id, lookup("ready"));
  const base = harness(automations, workflows);
  const options: MigrationCutoverRecoveryOptions = {
    ...base.options,
    migrations: {
      findWorkflowForProposal: (proposalId) => {
        lookupCalls += 1;
        if (proposalId === "proposal-0") throw new Error("corrupt workflow row");
        return workflows.get(proposalId) ?? { status: "not_migration" };
      },
    },
    proposals: {
      ...base.options.proposals,
      retryEnable: async (input) => {
        base.retries.push(input);
        if ((input as { readonly proposalId: string }).proposalId === "proposal-1") {
          throw new Error("owner unavailable");
        }
      },
    },
  };

  const result = await new MigrationCutoverRecoveryCoordinator(options).sweep();

  assert.equal(result.scanned, 100);
  assert.equal(lookupCalls, 100);
  assert.equal(result.retried, 99);
  assert.equal(result.recovered, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 1);
  assert.equal(base.retries.some((input) => (input as { readonly proposalId: string }).proposalId === "proposal-100"), false);
});

test("coalesces concurrent sweeps and releases the single-flight after completion", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const automations = [proposal("one", "enabling")];
  const fixture = harness(automations, new Map([["one", lookup("ready")]]), {
    onRetry: async () => {
      calls += 1;
      await gate;
    },
  });
  const coordinator = new MigrationCutoverRecoveryCoordinator(fixture.options);

  const first = coordinator.sweep();
  const second = coordinator.sweep();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  release?.();
  assert.deepEqual(await first, { scanned: 1, retried: 1, recovered: 0, skipped: 0, failed: 0 });

  const third = coordinator.sweep();
  assert.notEqual(third, first);
  assert.deepEqual(await third, { scanned: 1, retried: 1, recovered: 0, skipped: 0, failed: 0 });
  assert.equal(calls, 2);
});
