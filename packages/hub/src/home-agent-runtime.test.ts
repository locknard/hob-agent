import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from "@deepseek-ai/dsh-launch-environment";

import { BridgeCatalog } from "./bridge-catalog.js";
import { createHomeAgentRuntime } from "./home-agent-runtime.js";
import { SqliteProposalStore } from "./proposal-store.js";

function launchEnvironment() {
  return createLaunchEnvironmentSnapshot([{
    source: "process" as const,
    values: { DEEPSEEK_API_KEY: "test-provider-key" },
  }]);
}

function homeWorldOptions() {
  return {
    catalog: new BridgeCatalog(),
    bridges: [],
    monitorIntervalMs: 0,
  };
}

test("starts HomeWorld before the DSH Home Agent and stops both from one root", async () => {
  const runtime = createHomeAgentRuntime({
    homeWorld: homeWorldOptions(),
    launchEnvironment: launchEnvironment(),
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "home-runtime-test",
    },
  });
  const pluginOrder: string[] = [];
  runtime.context.on("internal/plugin", (fiber) => {
    if (fiber.uid !== null) pluginOrder.push(fiber.runtime?.callback.name ?? fiber.name);
  });

  assert.equal(runtime.status, "created");
  await runtime.start();

  assert.equal(runtime.status, "running");
  assert.deepEqual(pluginOrder.slice(0, 6), [
    "HomeWorldService",
    "HomeObservationAuditService",
    "HomeProposalService",
    "HomeArtifactService",
    "HomeRetentionService",
    "DshHomeAgentComposition",
  ]);
  assert.equal(runtime.context.root, runtime.context);
  assert.equal(runtime.context.homeWorld.name, "homeWorld");
  assert.equal(runtime.context.homeProposals.name, "homeProposals");
  assert.equal(runtime.context.homeObservationAudit.name, "homeObservationAudit");
  assert.equal(runtime.context.homeArtifacts.capabilities().canExecute, false);
  assert.equal(runtime.context.homeAdvice.name, "homeAdvice");
  assert.equal(runtime.context.homeInbox.name, "homeInbox");
  assert.equal(runtime.context.homeInboxHttp, undefined);
  assert.equal(pluginOrder.includes("ProposalInboxService"), true);
  assert.equal(String(runtime.context.homeAgent.agent.id), "home-runtime-test");

  await runtime.stop();

  assert.equal(runtime.status, "stopped");
  assert.equal(runtime.context.homeWorld, undefined);
  assert.equal(runtime.context.homeProposals, undefined);
  assert.equal(runtime.context.homeObservationAudit, undefined);
  assert.equal(runtime.context.homeArtifacts, undefined);
  assert.equal(runtime.context.homeAdvice, undefined);
  assert.equal(runtime.context.homeInbox, undefined);
  assert.equal(runtime.context.homeInboxHttp, undefined);
  assert.equal(runtime.context.homeAgent, undefined);
  await runtime.stop();
});

test("mounts the explicit retention coordinator without starting a timer", async () => {
  const runtime = createHomeAgentRuntime({
    homeWorld: homeWorldOptions(),
    launchEnvironment: launchEnvironment(),
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "retention-runtime-test",
    },
  });

  await runtime.start();
  try {
    assert.equal(runtime.context.homeRetention.name, "homeRetention");
    assert.equal(typeof runtime.context.homeRetention.retain, "function");
  } finally {
    await runtime.stop();
  }
  assert.equal(runtime.context.homeRetention, undefined);
});

test("stops the already-mounted HomeWorld when DSH startup fails", async () => {
  const runtime = createHomeAgentRuntime({
    homeWorld: homeWorldOptions(),
    launchEnvironment: launchEnvironment(),
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      profile: {
        id: "deepseek:primary",
        provider: "deepseek",
        kind: "api_key",
        secretRef: "keychain:hob-agent/deepseek:primary",
      },
    },
  });

  await assert.rejects(runtime.start(), /Selected profile and SecretVault must be provided together/);
  assert.equal(runtime.status, "stopped");
  assert.equal(runtime.context.homeWorld, undefined);
  assert.equal(runtime.context.homeProposals, undefined);
  assert.equal(runtime.context.homeArtifacts, undefined);
  assert.equal(runtime.context.homeInbox, undefined);
  assert.equal(runtime.context.homeInboxHttp, undefined);
  assert.equal(runtime.context.homeAgent, undefined);
});

test("mounts authenticated Inbox HTTP only when explicitly configured", async () => {
  const runtime = createHomeAgentRuntime({
    homeWorld: homeWorldOptions(),
    launchEnvironment: launchEnvironment(),
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "inbox-http-test",
    },
    inboxHttp: { port: 0, authenticate: () => true },
  });

  await runtime.start();
  assert.match(runtime.context.homeInboxHttp.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(runtime.context.homeObservationScheduler.snapshot().enabled, false);
  assert.match(runtime.context.homeInbox.renderList(), /Observe now/i);
  await runtime.stop();
  assert.equal(runtime.context.homeInboxHttp, undefined);
});

test("mounts the opt-in Hub observation scheduler after the DSH Home Agent", async () => {
  const runtime = createHomeAgentRuntime({
    homeWorld: homeWorldOptions(),
    launchEnvironment: launchEnvironment(),
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "observation-scheduler-test",
    },
    observation: {
      intervalMinutes: 60,
      scheduler: { wait: (_delay, signal) => new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }) },
    },
  });

  await runtime.start();
  assert.equal(runtime.context.homeObservationScheduler.name, "homeObservationScheduler");
  assert.match(runtime.context.homeInbox.renderList(), /Observation: waiting/);
  await runtime.stop();
  assert.equal(runtime.context.homeObservationScheduler, undefined);
});

test("provides the immutable DSH launch environment before any runtime plugin mounts", () => {
  const snapshot = launchEnvironment();
  const runtime = createHomeAgentRuntime({
    homeWorld: homeWorldOptions(),
    launchEnvironment: snapshot,
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "launch-environment-test",
    },
  });

  assert.equal(runtime.context.get(DSH_LAUNCH_ENVIRONMENT_KEY), snapshot);
});

test("wakes the private durable runner after an approved automation job commits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-runtime-preparation-"));
  const proposalPath = join(directory, "proposals.sqlite");
  const runtime = createHomeAgentRuntime({
    homeWorld: homeWorldOptions(),
    homeProposals: { path: proposalPath },
    homeArtifacts: { path: join(directory, "artifacts.sqlite") },
    homeAuthorityCandidates: { path: join(directory, "authority-candidates.sqlite") },
    launchEnvironment: launchEnvironment(),
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "preparation-runtime-test",
    },
  });

  await runtime.start();
  try {
    const pending = runtime.context.homeProposals.create({
      kind: "automation-draft",
      title: "Review a local household note",
      summary: "Prepare one local notification without a device write.",
      idempotencyKey: "runtime-preparation-notify:v1",
      provenance: { producer: "runtime-test" },
      evidence: {
        references: [],
        watermarks: [{
          bridgeId: "unavailable-fixture",
          epochId: "unavailable-epoch",
          lastSeq: 1,
          freshness: "unknown",
          gapCount: 0,
        }],
      },
      conflictCheck: { status: "checked", existingAutomationCount: 0, matches: [] },
      dryRun: { status: "not_run", summary: "No artifact has been prepared." },
      risk: { level: "low", reasons: [], requiresHumanApproval: true },
      intent: {
        type: "notify_local",
        description: "Prepare a local review note.",
        rollback: "No remote change exists.",
      },
      artifactCandidate: {
        schemaVersion: "1",
        content: {
          trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "08:00" },
          conditions: [],
          actions: [{ kind: "notify_local", message: "Review the household note." }],
          rollback: { kind: "no_remote_change" },
          postconditions: [],
        },
      },
    });
    const approved = runtime.context.homeProposals.review({
      proposalId: pending.id,
      expectedRevision: pending.revision,
      decision: "approved",
      reviewer: "household-owner",
      feedbackCode: "useful_as_is",
    });

    const observer = new SqliteProposalStore({ path: proposalPath });
    let job = observer.getPreparationJobForProposal(approved.id, approved.revision);
    for (let attempts = 0; job !== undefined && !["succeeded", "failed"].includes(job.status) && attempts < 50; attempts += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      job = observer.getPreparationJobForProposal(approved.id, approved.revision);
    }
    assert.equal(job?.status, "failed");
    assert.equal(job?.error?.code, "unavailable");
    const review = runtime.context.homeArtifacts.reviewForProposal(approved.id, approved.revision);
    assert.equal(review?.compile.status, "not_run");
    assert.equal(review?.dryRun.status, "not_run");
    assert.equal(review?.writesPerformed, false);
    observer.close();
    for (const privateSurface of [
      "artifactRegistry",
      "authorityCandidates",
      "homePreparationJobs",
      "homePreparationPipeline",
    ]) {
      assert.equal(privateSurface in runtime.context, false, privateSurface);
    }
  } finally {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
