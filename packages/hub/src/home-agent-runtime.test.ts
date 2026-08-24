import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from "@deepseek-ai/dsh-launch-environment";
import { Context } from "@deepseek-ai/cordis";

import { BridgeCatalog } from "./bridge/bridge-catalog.js";
import {
  createHomeAgentRuntime,
  createHomeAutomationMigrationSelectionInboxPort,
  mountHomeAgentProductBundle,
} from "./home-agent-runtime.js";
import { initialHomeOnboardingState, InMemoryHomeOnboardingStore } from "./home/home-onboarding-store.js";
import { SyntheticMediaCatalogProvider } from "./media/home-media-services.js";
import { SqliteProposalStore, type CreateProposalInput } from "./home/proposal-store.js";
import { HomeAutomationMigrationDeployment } from "./home/home-automation-migration-deployment.js";
import { homeAutomationMigrationProposalIdentity } from "./home/home-automation-migration-preparation.js";
import { digestToken } from "./home/home-automation-migration-selection.js";
import { SqliteHomeAutomationMigrationStore } from "./home/home-automation-migration-store.js";
import { computeHomeAutomationMigrationCandidateContentHash } from "./home/home-automation-migration-simulator.js";
import { SqliteProductViewRecipeDraftStore } from "./home/product-view-recipe-draft-store.js";
import { SyntheticBridge } from "@hob/bridge-contract/testing";
import { WorldIdentityManager } from "./world/world-identity.js";
import type { BridgeAdapter } from "@hob/bridge-contract";
import type { ActionsExtension } from "@hob/bridge-contract";

const fixtureReviewPrincipal = {
  principalId: "household-member",
  role: "adult_member" as const,
  present: true,
  device: {
    kind: "private" as const,
    boundPrincipalId: "household-member",
  },
};

test("maps the Hub migration selection runtime to the Inbox structural port without leaking identities", async () => {
  const calls: unknown[] = [];
  const port = createHomeAutomationMigrationSelectionInboxPort({
    listMigrationSelections: (principal) => {
      calls.push({ kind: "list", principal });
      return [{ name: "晚间灯光", status: "selectable", token: "a".repeat(32) }];
    },
    submitMigrationSelection: (token, principal) => {
      calls.push({ kind: "prepare", token, principal });
      return Promise.resolve({ name: "晚间灯光", status: "prepared", proposalId: "proposal-1" });
    },
  });
  const actor = {
    ...fixtureReviewPrincipal,
    present: true,
  };
  assert.deepEqual(port.list(actor), [{ name: "晚间灯光", status: "selectable", token: "a".repeat(32) }]);
  assert.deepEqual(await port.prepare!({ selectionToken: "a".repeat(32), actor }), {
    status: "prepared",
    proposalId: "proposal-1",
  });
  assert.deepEqual(port.list({ ...actor, device: { kind: "shared" } }), [{
    name: "晚间灯光",
    status: "selectable",
  }]);
  assert.deepEqual(calls, [
    {
      kind: "list",
      principal: { principalId: "household-member", role: "adult_member", privateDeviceBinding: "verified" },
    },
    {
      kind: "prepare",
      token: "a".repeat(32),
      principal: { principalId: "household-member", role: "adult_member", privateDeviceBinding: "verified" },
    },
    {
      kind: "list",
      principal: { principalId: "household-member", role: "adult_member", privateDeviceBinding: "unverified" },
    },
  ]);
});

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

function actionHomeWorldOptions() {
  const bridge = new SyntheticBridge({
    bridgeId: "runtime-actions",
    remoteInstanceId: "runtime-actions-remote",
    extensions: [{ id: "actions", version: "1.0.0" }],
  });
  const epochId = "runtime-actions-epoch";
  bridge.enqueue({
    epochId,
    seq: 1,
    event: {
      kind: "sync-start",
      snapshotId: "runtime-actions-snapshot",
      remoteInstanceId: "runtime-actions-remote",
      reason: "initial",
    },
  });
  bridge.enqueue({
    epochId,
    seq: 2,
    event: {
      kind: "device-upserted",
      device: {
        nativeId: "runtime-device",
        capabilities: [{ nativeInstanceId: "runtime-capability", schema: "runtime.synthetic", schemaVersion: "1.0.0" }],
      },
    },
  });
  bridge.enqueue({
    epochId,
    seq: 3,
    event: {
      kind: "state",
      state: {
        nativeId: "runtime-device",
        nativeInstanceId: "runtime-capability",
        attrs: { state: "on" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    },
  });
  bridge.enqueue({
    epochId,
    seq: 4,
    event: {
      kind: "sync-complete",
      manifest: { snapshotId: "runtime-actions-snapshot", deviceEnvelopeCount: 1, stateEnvelopeCount: 1 },
    },
  });
  const actions: ActionsExtension = {
    describe: () => ({ action: { kind: "set_boolean", value: false }, reversible: true }),
    execute: async () => ({ status: "acknowledged" }),
  };
  const adapter: BridgeAdapter = {
    info: bridge.info,
    control: bridge.control,
    events: (signal) => (async function* () {
      yield* bridge.events(signal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    })(),
    extension: (name) => name === "actions@1" ? actions as never : undefined,
  };
  const catalog = new BridgeCatalog();
  catalog.register({
    adapterType: "synthetic",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas: [{
      schema: "runtime.synthetic",
      majorVersion: 1,
      attrsSchema: z.record(z.string(), z.unknown()),
      canonicalHash: "runtime.synthetic-v1",
    } as never],
    factory: () => adapter,
  });
  return {
    catalog,
    bridges: [{ bridgeId: "runtime-actions", adapterType: "synthetic", config: {} }],
    monitorIntervalMs: 0,
    identityManager: new WorldIdentityManager({
      idFactory: (kind) => ({
        hw: "hw-runtime",
        hwCapability: "hwc-runtime",
        hwSpace: "hws-runtime",
        proposal: "proposal-runtime",
        audit: "audit-runtime",
      })[kind],
    }),
    actionAuthorityConfig: {
      "hwc-runtime": {
        bridgeId: "runtime-actions",
        approved: true,
        policyClass: "direct" as const,
        configIdentity: `sha256:${"c".repeat(64)}`,
        configRevision: 1,
      },
    },
  };
}

test("mounts the product bundle beneath an external Cordis root and disposes only its own scope", async () => {
  const root = new Context();
  let hostDisposed = false;
  root.effect(() => () => {
    hostDisposed = true;
  });

  const bundle = await mountHomeAgentProductBundle(root, {
    homeWorld: homeWorldOptions(),
    launchEnvironment: launchEnvironment(),
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "mounted-product-bundle-test",
    },
  });

  assert.notEqual(bundle.context, root);
  assert.equal(bundle.context.root, root);
  assert.notEqual(bundle.context.fiber.uid, 0);
  assert.equal(root.homeWorld.name, "homeWorld");

  await bundle.dispose();
  await bundle.dispose();

  assert.equal(bundle.status, "stopped");
  assert.equal(bundle.context.fiber.uid, null);
  assert.equal(root.homeWorld, undefined);
  assert.equal(root.fiber.uid, 0);
  assert.equal(hostDisposed, false);
});

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
  assert.deepEqual(pluginOrder.slice(0, 10), [
    "HomeWorldService",
    "HomeAutomationMigrationRuntimeService",
    "HomeMediaPlayerService",
    "HomeObservationAuditService",
    "HomeProposalService",
    "HomeArtifactService",
    "HomeRetentionService",
    "HouseholdReviewCenterService",
    "HomeBatchActionService",
    "DshHomeAgentComposition",
  ]);
  assert.equal(runtime.context.root, runtime.context);
  assert.equal(runtime.context.homeWorld.name, "homeWorld");
  assert.equal(runtime.context.homeMediaPlayers.name, "homeMediaPlayers");
  assert.equal(runtime.context.tools.schemas().some((schema) => schema.name === "get_home_media_players"), true);
  assert.equal(runtime.context.homeMediaCatalog, undefined);
  assert.equal(runtime.context.homeMediaPlaybackPreparation, undefined);
  assert.equal(runtime.context.tools.schemas().some((schema) => schema.name === "search_home_media"), false);
  assert.equal(runtime.context.tools.schemas().some((schema) => schema.name === "prepare_home_media_playback"), false);
  assert.equal(runtime.context.homeProposals.name, "homeProposals");
  assert.equal(
    (runtime.context.homeProposals as unknown as { deployment: unknown }).deployment instanceof HomeAutomationMigrationDeployment,
    true,
    "the single proposal deployment seam is migration-aware",
  );
  assert.equal(runtime.context.homeObservationAudit.name, "homeObservationAudit");
  assert.equal(runtime.context.homeArtifacts.capabilities().canExecute, false);
  assert.equal(runtime.context.homeAdvice.name, "homeAdvice");
  assert.equal(runtime.context.homeBatchActions.name, "homeBatchActions");
  assert.equal(runtime.context.homeInbox.name, "homeInbox");
  assert.equal(runtime.context.homeInboxHttp, undefined);
  assert.equal(pluginOrder.includes("ProposalInboxService"), true);
  assert.equal(String(runtime.context.homeAgent.agent.id), "home-runtime-test");

  await runtime.stop();

  assert.equal(runtime.status, "stopped");
  assert.equal(runtime.context.homeWorld, undefined);
  assert.equal(runtime.context.homeMediaPlayers, undefined);
  assert.equal(runtime.context.homeMediaPlaybackPreparation, undefined);
  assert.equal(runtime.context.homeProposals, undefined);
  assert.equal(runtime.context.homeObservationAudit, undefined);
  assert.equal(runtime.context.homeArtifacts, undefined);
  assert.equal(runtime.context.homeAdvice, undefined);
  assert.equal(runtime.context.homeBatchActions, undefined);
  assert.equal(runtime.context.homeInbox, undefined);
  assert.equal(runtime.context.homeInboxHttp, undefined);
  assert.equal(runtime.context.homeAgent, undefined);
  await runtime.stop();
});

test("mounts the read-only home automation migration service after HomeWorld and closes its SQLite store", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-runtime-home-automation-migrations-"));
  const path = join(directory, "home-automation-migrations.sqlite");
  const runtime = createHomeAgentRuntime({
    homeWorld: homeWorldOptions(),
    homeAutomationMigrations: { path },
    launchEnvironment: launchEnvironment(),
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "home-automation-migrations-runtime-test",
    },
  });

  try {
    await runtime.start();
    assert.equal(runtime.context.homeAutomationMigrations.name, "homeAutomationMigrations");
    assert.equal(runtime.context.homeAutomationMigrations.path, path);
    assert.equal(typeof runtime.context.homeAutomationMigrations.prepareRuleReview, "function");
    assert.equal(typeof runtime.context.homeAutomationMigrations.refreshRuleWorkflow, "function");
    assert.equal(existsSync(path), true);
  } finally {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(runtime.context.homeAutomationMigrations, undefined);
});

test("runs lookup-only migration selection recovery after the real Proposal owner mounts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-runtime-migration-recovery-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  const now = "2026-08-24T08:00:00.000Z";
  const migrationId = "1".repeat(32);
  const sourceFingerprint = `sha256:${"a".repeat(64)}`;
  const source = { bridgeId: "bridge-ha", epochId: "epoch-1", lastSeq: 12 } as const;
  const rule = {
    ruleRef: "rule-1",
    name: "Living room light",
    enabled: true,
    updatedAt: now,
    triggerClass: "state" as const,
    conditionClass: "flat_and" as const,
    actionClass: "reversible" as const,
    sourceFingerprint,
    disposition: "eligible" as const,
    workflow: { status: "assessed" as const, sourceFingerprint, assessedAt: now },
  };
  const candidate = {
    schemaVersion: "1" as const,
    content: {
      trigger: { kind: "capability_changed" as const, source: { hwCapabilityId: "hwc-1" } },
      conditions: [],
      actions: [{ kind: "set_boolean" as const, target: { hwCapabilityId: "hwc-1" }, value: false }],
      rollback: { kind: "restore_previous_state" as const, target: { hwCapabilityId: "hwc-1" }, maxAgeSeconds: 3_600 },
      postconditions: [{
        kind: "capability_value" as const,
        source: { hwCapabilityId: "hwc-1" },
        operator: "equals" as const,
        value: false,
        withinSeconds: 30,
      }],
    },
  };
  const principal = { principalId: "member-recovery", role: "adult_member" as const, privateDeviceBinding: "verified" as const };
  const migrationStore = new SqliteHomeAutomationMigrationStore({ path: migrationPath });
  const proposalStore = new SqliteProposalStore({ path: proposalPath, now: () => now, id: () => "recovered" });
  let runtime: ReturnType<typeof createHomeAgentRuntime> | undefined;
  try {
    migrationStore.discover({
      migrationId,
      idempotencyKey: "2".repeat(32),
      inputDigest: `sha256:${"b".repeat(64)}`,
      sourceBridgeId: source.bridgeId,
      sourceEpochId: source.epochId,
      sourceLastSeq: source.lastSeq,
      analysisMode: "trusted_neutral",
      rules: [rule],
      createdAt: now,
    });
    assert.equal(migrationStore.assess({
      migrationId,
      status: "assessed",
      assessedAt: now,
      rules: [rule],
    }), true);
    const identity = homeAutomationMigrationProposalIdentity({
      migrationId,
      ruleRef: rule.ruleRef,
      sourceBridgeId: source.bridgeId,
      sourceEpochId: source.epochId,
      sourceLastSeq: source.lastSeq,
      sourceFingerprint,
    });
    const proposalInput: CreateProposalInput = {
      kind: "automation-draft",
      title: "Living room light",
      summary: "Recovered migration candidate",
      dedupKey: identity.dedupKey,
      idempotencyKey: identity.idempotencyKey,
      provenance: { producer: "home-automation-migration" },
      evidence: {
        references: [{ bridgeId: source.bridgeId, observedAt: now }],
        watermarks: [{ bridgeId: source.bridgeId, epochId: source.epochId, lastSeq: source.lastSeq, freshness: "fresh", gapCount: 0 }],
      },
      conflictCheck: { status: "checked", existingAutomationCount: 0, matches: [] },
      dryRun: { status: "not_run", summary: "No automation artifact exists yet; execution simulation was not run." },
      risk: { level: "low", reasons: [], requiresHumanApproval: true },
      rationale: { householdValue: "Keep the existing behavior available for review.", whyNow: "The previous process stopped after proposal admission.", uncertainties: ["The household still wants this behavior."] },
      spaceCoverage: { selectedDevices: 1, devicesWithSingleSpace: 1, devicesWithoutSpace: 0, devicesWithMultipleSpaces: 0 },
      intent: { type: "automation-draft", description: "Review a recovered draft; do not install it.", rollback: "Reject the draft proposal." },
      artifactCandidate: candidate,
    };
    const created = proposalStore.createMigrationGoverned(proposalInput);
    assert.equal(created.kind, "created");
    if (created.kind !== "created") throw new Error("expected recovered migration proposal");
    assert.equal(created.proposal.id, "proposal-recovered");
    migrationStore.issueSelection({
      selectionId: "3".repeat(32),
      migrationId,
      ruleRef: rule.ruleRef,
      principal,
      sourceBridgeId: source.bridgeId,
      sourceEpochId: source.epochId,
      sourceLastSeq: source.lastSeq,
      sourceFingerprint,
      tokenDigest: digestToken("e".repeat(32)),
      generation: "old-generation",
      issuedAt: now,
      expiresAt: "2026-08-24T08:05:00.000Z",
    });
    assert.equal(migrationStore.claimSelection({
      selectionId: "3".repeat(32),
      tokenDigest: digestToken("e".repeat(32)),
      principal,
      generation: "old-generation",
      now,
    }).outcome, "claimed");
    migrationStore.close();
    proposalStore.close();

    runtime = createHomeAgentRuntime({
      homeWorld: homeWorldOptions(),
      homeProposals: { path: proposalPath },
      homeAutomationMigrations: { path: migrationPath },
      launchEnvironment: launchEnvironment(),
      agent: { provider: "deepseek", model: "deepseek-v4-flash", sessionId: "migration-recovery-runtime-test" },
    });
    await runtime.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const recoveredWorkflow = runtime.context.homeAutomationMigrations.get(migrationId)?.rules[0]?.workflow;
    assert.equal(recoveredWorkflow?.status, "translated");
    assert.equal(recoveredWorkflow?.proposalId, "proposal-recovered");
    assert.equal(recoveredWorkflow?.candidateProposalRevision, 1);
    assert.equal(recoveredWorkflow?.candidateContentHash, computeHomeAutomationMigrationCandidateContentHash(candidate.content));
    assert.deepEqual(runtime.context.homeAutomationMigrations.listMigrationSelections(principal), [{
      name: "Living room light",
      status: "prepared",
      proposalId: "proposal-recovered",
    }]);
    assert.deepEqual(runtime.context.homeInbox.getProductShellProjection(fixtureReviewPrincipal, undefined, true).migrationSelections, [{
      name: "Living room light",
      status: "prepared",
      proposalId: "proposal-recovered",
    }]);
  } finally {
    await runtime?.stop();
    try { migrationStore.close(); } catch { /* already closed after setup */ }
    try { proposalStore.close(); } catch { /* already closed after setup */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wires the HomeWorld action descriptor source into the runtime review center", async () => {
  const runtime = createHomeAgentRuntime({
    homeWorld: actionHomeWorldOptions(),
    launchEnvironment: launchEnvironment(),
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "runtime-action-descriptor-test",
    },
  });

  try {
    await runtime.start();
    let descriptor: unknown;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      descriptor = runtime.context.homeReviewCenter.actionDescriptorFor("hwc-runtime");
      if (descriptor !== undefined) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(descriptor, {
      action: { kind: "set_boolean", value: false },
      reversible: true,
      policyClass: "direct",
    });
  } finally {
    await runtime.stop();
  }
});

test("mounts one durable household review center and disposes it with the root", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-runtime-review-center-"));
  const reviewCenterPath = join(directory, "one-shot-actions.sqlite");
  const runtime = createHomeAgentRuntime({
    homeWorld: homeWorldOptions(),
    homeReviewCenter: { path: reviewCenterPath },
    launchEnvironment: launchEnvironment(),
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "review-center-runtime-test",
    },
  });

  try {
    await runtime.start();
    const reviewCenter = (runtime.context as unknown as { homeReviewCenter?: {
      counts(): { readonly runtimeConfirmations: number };
    } }).homeReviewCenter;
    assert.notEqual(reviewCenter, undefined);
    assert.equal(existsSync(reviewCenterPath), true);
    assert.deepEqual(reviewCenter?.counts(), {
      runtimeConfirmations: 0,
    });
  } finally {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }

  assert.equal(runtime.context.homeReviewCenter, undefined);
});

test("mounts an explicit synthetic media catalog before the DSH Agent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-media-action-turn-runtime-"));
  const actionTurnPath = join(directory, "home-media-action-turns.sqlite");
  const runtime = createHomeAgentRuntime({
    homeWorld: homeWorldOptions(),
    launchEnvironment: launchEnvironment(),
    mediaCatalog: {
      tenantId: "household-test",
      catalogId: "synthetic-test",
      generation: 1,
      sourceLabel: "Synthetic household library",
      mediaRefTtlMs: 60_000,
      maxQueryChars: 128,
      maxResults: 3,
      provider: new SyntheticMediaCatalogProvider([
        { providerItemId: "jazz-1", title: "Late Night Jazz", kind: "playlist", playable: true },
      ]),
    },
    homeMediaActionTurns: { path: actionTurnPath },
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "media-runtime-test",
    },
  });
  await runtime.start();
  try {
    assert.equal(runtime.context.homeMediaCatalog.name, "homeMediaCatalog");
    assert.equal(runtime.context.homeMediaPlaybackPreparation.name, "homeMediaPlaybackPreparation");
    assert.equal(runtime.context.homeMediaConversation.name, "homeMediaConversation");
    assert.equal(runtime.context.homeMediaActionTurns.name, "homeMediaActionTurns");
    assert.equal(existsSync(actionTurnPath), true);
    assert.equal(runtime.context.tools.schemas().some((schema) => schema.name === "search_home_media"), true);
    assert.equal(runtime.context.tools.schemas().some((schema) => schema.name === "prepare_home_media_playback"), true);
    assert.equal(runtime.context.tools.schemas().some((schema) => schema.name === "home_media_conversation"), true);
    const result = await runtime.context.tools.execute({
      callId: "synthetic-jazz-search" as never,
      name: "search_home_media",
      arguments: { query: "jazz", kinds: ["playlist"], limit: 1 },
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, false);
    const searchBlock = result.content.find((item) => item.type === "text");
    assert.ok(searchBlock && searchBlock.type === "text");
    assert.match(searchBlock.text, /Late Night Jazz/);
    const searchValue = JSON.parse(searchBlock.text) as { candidates: Array<{ mediaRef: string }> };
    const preparation = await runtime.context.tools.execute({
      callId: "synthetic-jazz-preparation" as never,
      name: "prepare_home_media_playback",
      arguments: {
        playerHwCapabilityId: "hwc-media-room",
        mediaRef: searchValue.candidates[0]?.mediaRef,
        queueMode: "replace_and_play",
      },
      signal: new AbortController().signal,
    });
    assert.equal(preparation.isError, false);
    const preparationBlock = preparation.content.find((item) => item.type === "text");
    assert.ok(preparationBlock && preparationBlock.type === "text");
    assert.deepEqual(JSON.parse(preparationBlock.text), { status: "blocked", reason: "player_not_found" });
  } finally {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(runtime.context.homeMediaCatalog, undefined);
  assert.equal(runtime.context.homeMediaPlaybackPreparation, undefined);
  assert.equal(runtime.context.homeMediaConversation, undefined);
  assert.equal(runtime.context.homeMediaActionTurns, undefined);
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
  const directory = mkdtempSync(join(tmpdir(), "hob-layout-runtime-"));
  const runtime = createHomeAgentRuntime({
    homeWorld: homeWorldOptions(),
    launchEnvironment: launchEnvironment(),
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "inbox-http-test",
    },
    inboxHttp: {
      port: 0,
      authenticate: () => true,
      principal: { ...fixtureReviewPrincipal, role: "admin" },
    },
    homeViewRecipeDrafts: { path: join(directory, "layout-drafts.sqlite") },
  });

  try {
    await runtime.start();
    assert.match(runtime.context.homeInboxHttp.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(runtime.context.homeObservationScheduler.snapshot().enabled, false);
    const home = await fetch(`${runtime.context.homeInboxHttp.origin}/home`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /data-route="overview"/);
    const settings = await fetch(`${runtime.context.homeInboxHttp.origin}/settings`);
    assert.match(await settings.text(), /布局工作室/);
  } finally {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(runtime.context.homeInboxHttp, undefined);
});

test("hydrates exact published layout generations before the Inbox listener opens", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-layout-publication-runtime-"));
  const publicationPath = join(directory, "layout-drafts.sqlite");
  const seed = new SqliteProductViewRecipeDraftStore({ path: publicationPath });
  const draft = seed.create({
    ownerPrincipalId: "household-member",
    label: "持久布局",
    source: JSON.stringify({
      apiVersion: "hob.view.recipe/v1",
      id: "household.persistent",
      title: "持久视图",
      pages: [{
        route: "overview",
        layout: "stack",
        slots: [{ slot: "overview.header", width: "full" }],
      }],
    }),
    idempotencyKey: "seed-published-layout",
  });
  seed.publish({
    draftId: draft.draftId,
    ownerPrincipalId: "household-member",
    expectedRevision: 1,
    actorPrincipalId: "household-member",
  });
  seed.close();
  const runtime = createHomeAgentRuntime({
    homeWorld: homeWorldOptions(),
    launchEnvironment: launchEnvironment(),
    agent: { provider: "deepseek", model: "deepseek-v4-flash", sessionId: "published-layout-runtime" },
    inboxHttp: {
      port: 0,
      authenticate: () => true,
      principal: { ...fixtureReviewPrincipal, role: "admin" },
    },
    homeViewRecipeDrafts: { path: publicationPath },
  });
  try {
    await runtime.start();
    const response = await fetch(`${runtime.context.homeInboxHttp.origin}/home?view=household.persistent`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /data-view-provider="household\.persistent"/);
    assert.match(html, /data-recipe-provider="household\.persistent"/);
    const settings = await fetch(`${runtime.context.homeInboxHttp.origin}/settings?layout=${encodeURIComponent(draft.draftId)}`);
    const settingsHtml = await settings.text();
    assert.match(settingsHtml, /发布记录/);
    assert.match(settingsHtml, /发布了.*household\.persistent/s);
    assert.match(settingsHtml, /household-member/);
  } finally {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
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
  assert.equal(runtime.context.homeObservationScheduler.snapshot().state, "waiting");
  await runtime.stop();
  assert.equal(runtime.context.homeObservationScheduler, undefined);
});

test("uses the persisted onboarding observation schedule as the production runtime source", async () => {
  const initial = initialHomeOnboardingState("2026-08-19T04:00:00.000Z");
  const completedSteps = [1, 2, 3, 4, 5, 6] as const;
  const steps = { ...initial.steps };
  for (const step of completedSteps) steps[step] = { status: "completed", updatedAt: initial.updatedAt, summary: "已完成" };
  const store = new InMemoryHomeOnboardingStore({
    ...initial,
    currentStep: 7,
    completedSteps,
    steps,
    observation: {
      enabled: true,
      intervalMinutes: 720,
      quietHours: { start: "22:00", end: "08:00" },
      configuredAt: initial.updatedAt,
    },
  });
  const runtime = createHomeAgentRuntime({
    homeWorld: homeWorldOptions(),
    homeOnboarding: { store },
    launchEnvironment: launchEnvironment(),
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "onboarding-observation-runtime-test",
    },
  });

  await runtime.start();
  try {
    assert.deepEqual(runtime.context.homeObservationScheduler.snapshot(), {
      enabled: true,
      intervalMinutes: 720,
      quietHours: { start: "22:00", end: "08:00" },
      runOnStart: false,
      state: "waiting",
    });
  } finally {
    await runtime.stop();
  }
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
    const proposalIngress = runtime.context.homeProposals as unknown as {
      store: { create(input: unknown): { id: string; revision: number; status: string } };
      wakePreparation(proposal: { id: string; revision: number }): unknown;
    };
    const pending = proposalIngress.store.create({
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
    // The durable runner never replays on start; admission's wake is the only
    // nudge, so the fixture wakes exactly as governed admission would.
    proposalIngress.wakePreparation(pending);

    const observer = new SqliteProposalStore({ path: proposalPath });
    let job = observer.getPreparationJobForProposal(pending.id, pending.revision);
    for (let attempts = 0; job !== undefined && !["succeeded", "failed"].includes(job.status) && attempts < 50; attempts += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      job = observer.getPreparationJobForProposal(pending.id, pending.revision);
    }
    assert.equal(job?.status, "failed");
    assert.equal(job?.error?.code, "unavailable");
    const review = runtime.context.homeArtifacts.reviewForProposal(pending.id, pending.revision);
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

test("retries one failed exact preparation through the full Inbox facade and wakes only its queued version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-runtime-preparation-retry-"));
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
      sessionId: "preparation-retry-runtime-test",
    },
  });

  await runtime.start();
  const observer = new SqliteProposalStore({ path: proposalPath });
  try {
    const proposalIngress = runtime.context.homeProposals as unknown as {
      store: { create(input: unknown): { id: string; revision: number; status: string } };
      wakePreparation(proposal: { id: string; revision: number }): unknown;
    };
    const pending = proposalIngress.store.create({
      kind: "automation-draft",
      title: "Retry a local household note",
      summary: "Retry one local notification without a device write.",
      idempotencyKey: "runtime-preparation-retry:v1",
      provenance: { producer: "runtime-retry-test" },
      evidence: {
        references: [],
        watermarks: [{
          bridgeId: "unavailable-retry-fixture",
          epochId: "unavailable-retry-epoch",
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
          actions: [{ kind: "notify_local", message: "Retry the household note." }],
          rollback: { kind: "no_remote_change" },
          postconditions: [],
        },
      },
    });
    proposalIngress.wakePreparation(pending);

    let failed = observer.getPreparationJobForProposal(pending.id, pending.revision);
    for (let attempts = 0; failed !== undefined && failed.status !== "failed" && attempts < 50; attempts += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      failed = observer.getPreparationJobForProposal(pending.id, pending.revision);
    }
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.attempt, 1);
    assert.equal(failed?.error?.code, "unavailable");
    const failedVersion = failed!.version;

    const inbox = runtime.context.homeInbox as unknown as {
      retryPreparation(input: {
        readonly proposalId: string;
        readonly expectedRevision: number;
        readonly expectedVersion: number;
      }): Promise<unknown>;
    };
    for (const forbidden of [
      "listPreparationJobs",
      "getPreparationJob",
      "claimPreparationJob",
      "completePreparationJob",
      "failPreparationJob",
      "retryPreparationJob",
      "preparationRunner",
      "homePreparationJobs",
      "homePreparationRunner",
    ]) {
      assert.equal(forbidden in runtime.context, false, `Context leaked ${forbidden}`);
      assert.equal(forbidden in runtime.context.homeInbox, false, `Inbox leaked ${forbidden}`);
    }

    await assert.doesNotReject(() => inbox.retryPreparation({
      proposalId: pending.id,
      expectedRevision: pending.revision,
      expectedVersion: failedVersion,
    }));

    let retried = observer.getPreparationJobForProposal(pending.id, pending.revision);
    for (let attempts = 0; retried !== undefined && !(retried.status === "failed" && retried.attempt === 2) && attempts < 50; attempts += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      retried = observer.getPreparationJobForProposal(pending.id, pending.revision);
    }
    assert.equal(retried?.proposalId, pending.id);
    assert.equal(retried?.proposalRevision, pending.revision);
    assert.equal(retried?.status, "failed");
    assert.equal(retried?.attempt, 2);
    assert.equal(retried?.error?.code, "unavailable");
    assert.ok(retried!.version > failedVersion);

    await assert.rejects(() => inbox.retryPreparation({
      proposalId: pending.id,
      expectedRevision: pending.revision,
      expectedVersion: failedVersion,
    }), /conflict|version|transition/i);
    assert.deepEqual(observer.getPreparationJobForProposal(pending.id, pending.revision), retried);
  } finally {
    observer.close();
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
