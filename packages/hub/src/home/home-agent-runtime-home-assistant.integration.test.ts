import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";

import {
  HOME_ASSISTANT_ACCESS_TOKEN_ALIAS,
  HOME_ASSISTANT_ADAPTER_REGISTRATION,
  createHomeAssistantBridgeAdapter,
  type WebSocketLike,
} from "../bridge/home-assistant-bridge.js";
import { BridgeCatalog } from "../bridge/bridge-catalog.js";
import type { ArtifactRegistry } from "../artifact/artifact-registry.js";
import { createHomeAgentRuntime } from "../home-agent-runtime.js";
import { SqliteIngestJournal } from "../world/ingest-journal.js";
import type { HomeWorldSnapshot } from "../world/home-world-service.js";

const BRIDGE_ID = "bridge-ha";
const CONFIG = {
  baseUrl: "http://ha.local:8123",
  authenticationPrincipal: "owner-a",
} as const;
const BASELINE_TIME = "2026-08-17T12:00:00.000Z";
const LIVE_ON_TIME = "2026-08-24T12:00:05.000Z";
const LIVE_OFF_TIME = "2026-08-24T12:00:06.000Z";
const RULE_CONFIG = {
  alias: "晚间灯光",
  mode: "single",
  trigger: [{ platform: "state", entity_id: "light.kitchen" }],
  condition: [{ condition: "state", entity_id: "light.kitchen", state: "off" }],
  action: [{
    service: "light.turn_on",
    target: { entity_id: "light.kitchen" },
    data: {},
  }],
} as const;

class FakeSocket implements WebSocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  onclose: (() => void) | undefined;
  onerror: ((error: Error) => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.onclose?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

type FetchRequest = {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
};

const SOURCE_STATE_URL = "http://ha.local:8123/api/states/automation.arrival_light";
const SOURCE_CONFIG_URL = "http://ha.local:8123/api/config/automation/config/arrival_light";

function credentialSource() {
  return {
    async resolve(alias: string) {
      return alias === HOME_ASSISTANT_ACCESS_TOKEN_ALIAS
        ? { kind: "secret_text" as const, value: "ha-secret" }
        : undefined;
    },
    async describe(alias: string) {
      return { configured: alias === HOME_ASSISTANT_ACCESS_TOKEN_ALIAS };
    },
  };
}

function respondToBootstrap(socket: FakeSocket): void {
  socket.receive({ type: "auth_required", ha_version: "2026.8.0" });
  socket.receive({ type: "auth_ok", ha_version: "2026.8.0" });
  const commands = socket.sent.slice(1) as Array<{ id: number; type: string }>;
  for (const command of commands) {
    const result = command.type === "get_states"
      ? [
          { entity_id: "automation.arrival_light", state: "on", attributes: { friendly_name: "Arrival light" } },
          { entity_id: "light.kitchen", state: "off", attributes: { friendly_name: "Kitchen light" } },
        ]
        : command.type === "config/entity_registry/list"
          ? [
              { id: "automation-stable-1", entity_id: "automation.arrival_light", device_id: "device-automation", name: "Arrival light" },
              { id: "entity-light-1", entity_id: "light.kitchen", device_id: "device-light", name: "Kitchen light" },
            ]
            : command.type === "config/device_registry/list"
              ? [{ id: "device-automation", name: "Automations" }, { id: "device-light", name: "Kitchen" }]
              : [];
    socket.receive({ id: command.id, type: "result", success: true, result });
  }
}

function createFetchFake() {
  const requests: FetchRequest[] = [];
  let sourceState: "on" | "off" = "on";
  const targetAutomations = new Map<string, { config: Record<string, unknown>; state: "on" | "off" }>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ method, url, ...(body === undefined ? {} : { body }) });
    if (url === SOURCE_STATE_URL && method === "GET") {
      return new Response(JSON.stringify({ state: sourceState }), { status: 200 });
    }
    if (url === SOURCE_CONFIG_URL && method === "GET") {
      return new Response(JSON.stringify(RULE_CONFIG), { status: 200 });
    }
    const targetMatch = /^http:\/\/ha\.local:8123\/api\/(?:states\/automation\.|config\/automation\/config\/)([a-z0-9][a-z0-9_]{2,120})$/u.exec(url);
    const targetId = targetMatch?.[1];
    if (targetId === undefined) return new Response("{}", { status: 404 });
    if (method === "POST") {
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return new Response("{}", { status: 400 });
      }
      targetAutomations.set(targetId, { config: body as Record<string, unknown>, state: "on" });
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    }
    if (method === "DELETE") {
      const existed = targetAutomations.delete(targetId);
      return new Response("{}", { status: existed ? 200 : 404 });
    }
    const stored = targetAutomations.get(targetId);
    if (stored === undefined) return new Response("{}", { status: 404 });
    if (url.includes("/api/states/automation.")) {
      return new Response(JSON.stringify({ state: stored.state }), { status: 200 });
    }
    return new Response(JSON.stringify(stored.config), { status: 200 });
  };
  return {
    fetchImpl,
    requests,
    setSourceState(next: "on" | "off"): void {
      sourceState = next;
    },
    sourceState(): "on" | "off" {
      return sourceState;
    },
    targetAutomations,
  };
}

function sendStateChanged(
  socket: FakeSocket,
  subscriptionId: number,
  state: "on" | "off",
  timeFired: string,
): void {
  socket.receive({
    id: subscriptionId,
    type: "event",
    event: {
      event_type: "state_changed",
      time_fired: timeFired,
      data: {
        entity_id: "light.kitchen",
        new_state: { state, attributes: {} },
      },
    },
  });
}

async function waitFor<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  description: string,
  diagnostic?: () => unknown,
): Promise<T> {
  let latest = read();
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (predicate(latest)) return latest;
    await new Promise<void>((resolve) => setImmediate(resolve));
    latest = read();
  }
  assert.fail(`Timed out waiting for ${description}: ${JSON.stringify({ latest, diagnostic: diagnostic?.() })}`);
}

function targetState(
  snapshot: HomeWorldSnapshot,
  hwCapabilityId: string,
): unknown {
  for (const device of snapshot.devices) {
    if (!device.capabilities.some((capability) => capability.hwCapabilityId === hwCapabilityId)) continue;
    const state = device.states.find((candidate) => candidate.nativeInstanceId === "entity-light-1");
    return state?.attrs.value;
  }
  return undefined;
}

async function waitForServiceCommand(
  socket: FakeSocket,
  service: "turn_on" | "turn_off",
  afterSentCount = 0,
): Promise<Record<string, unknown>> {
  return waitFor(
    () => [...socket.sent].slice(afterSentCount).reverse().find((message) => (
      message.type === "call_service"
      && message.domain === "automation"
      && message.service === service
    )),
    (message): message is Record<string, unknown> => message !== undefined,
    `Home Assistant automation.${service} call_service`,
  );
}

async function createReadyMigrationFixture() {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-agent-ha-runtime-"));
  const socket = new FakeSocket();
  const fetchFake = createFetchFake();
  const catalog = new BridgeCatalog();
  const now = { value: BASELINE_TIME };
  let bootstrapScheduled = false;
  const registration = {
    ...HOME_ASSISTANT_ADAPTER_REGISTRATION,
    factory: (factoryContext: Parameters<typeof createHomeAssistantBridgeAdapter>[0]) => {
      const adapter = createHomeAssistantBridgeAdapter(factoryContext, {
        socketFactory: () => socket,
        snapshotIdFactory: () => "integration-snapshot",
        fetchImpl: fetchFake.fetchImpl,
      });
      return {
        info: adapter.info,
        control: adapter.control,
        extension: (name: Parameters<typeof adapter.extension>[0]) => adapter.extension(name),
        events: (signal: AbortSignal) => {
          const stream = adapter.events(signal);
          if (!bootstrapScheduled) {
            bootstrapScheduled = true;
            setImmediate(() => respondToBootstrap(socket));
          }
          return stream;
        },
      };
    },
  };
  catalog.register(registration);

  const runtime = createHomeAgentRuntime({
    homeWorld: {
      catalog,
      credentialSource: credentialSource(),
      bridges: [{ bridgeId: BRIDGE_ID, adapterType: "home-assistant", config: CONFIG }],
      journalFactory: () => new SqliteIngestJournal(":memory:"),
      actionAuthorityConfigPath: join(directory, "action-authority.json"),
      clock: () => now.value,
      monitorIntervalMs: 0,
      maxRestarts: 0,
      scheduler: { wait: async () => undefined },
    },
    homeProposals: { path: join(directory, "proposals.sqlite"), now: () => now.value },
    homeArtifacts: { path: join(directory, "artifacts.sqlite"), now: () => now.value },
    homeAuthorityCandidates: {
      path: join(directory, "authority-candidates.sqlite"),
      now: () => now.value,
      id: (() => {
        let sequence = 0;
        return () => `integration-${++sequence}`;
      })(),
    },
    homeAutomationMigrations: {
      path: join(directory, "migrations.sqlite"),
      clock: () => now.value,
      migrationIdFactory: () => "a".repeat(32),
      idempotencyKeyFactory: () => "b".repeat(32),
    },
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "home-agent-ha-runtime-integration",
    },
    launchEnvironment: createLaunchEnvironmentSnapshot([{
      source: "process",
      values: { DEEPSEEK_API_KEY: "integration-test-key" },
    }]),
  });

  try {
    await runtime.start();
    const world = runtime.context.homeWorld;
    await waitFor(
      () => world.snapshot(),
      (snapshot) => snapshot.bridges[BRIDGE_ID]?.diagnostics.connectionState === "ready",
      "HomeWorld bridge readiness",
    );

    const snapshot = world.snapshot();
    const baseline = snapshot.bridgeWatermarks.find((watermark) => watermark.bridgeId === BRIDGE_ID);
    const target = snapshot.devices
      .flatMap((device) => device.capabilities)
      .find((capability) => capability.bindings.some((binding) => (
        binding.bridgeId === BRIDGE_ID
        && binding.nativeId === "device-light"
        && binding.nativeInstanceId === "entity-light-1"
      )));
    if (baseline === undefined || target === undefined) assert.fail("HA baseline or target capability is unavailable");
    assert.equal(targetState(snapshot, target.hwCapabilityId), false);
    assert.equal(world.configureActionAuthority({
      directCapabilityIds: [target.hwCapabilityId],
      confirmationCapabilityIds: [],
      administratorCapabilityIds: [],
    }).status, "configured");
    assert.equal(world.resolveActionAuthority(target.hwCapabilityId).status, "available");
    assert.equal(world.resolveAuthorityCandidateInput(target.hwCapabilityId)?.available, true);

    const subscription = socket.sent.find((message) => message.type === "subscribe_events");
    if (typeof subscription?.id !== "number") assert.fail("HA state subscription was not established");
    now.value = LIVE_ON_TIME;
    sendStateChanged(socket, subscription.id, "on", LIVE_ON_TIME);
    await waitFor(
      () => world.snapshot(),
      (current) => targetState(current, target.hwCapabilityId) === true,
      "post-baseline on event",
    );
    now.value = LIVE_OFF_TIME;
    sendStateChanged(socket, subscription.id, "off", LIVE_OFF_TIME);
    await waitFor(
      () => world.snapshot(),
      (current) => targetState(current, target.hwCapabilityId) === false,
      "post-baseline off event",
    );

    const evidence = world.queryRecentEvidence({
      hwCapabilityIds: [target.hwCapabilityId],
      lookbackHours: 168,
      limit: 32,
    });
    assert.equal(evidence.coverage.every((item) => item.status === "complete"), true, JSON.stringify(evidence));
    assert.equal(evidence.coverage.every((item) => item.reasons.length === 0), true, JSON.stringify(evidence));
    assert.deepEqual(evidence.events.map((event) => event.value), [true, false]);
    assert.equal(evidence.events.every((event) => typeof event.value === "boolean"), true);

    const catalogRead = await world.foreignRuleCatalog();
    assert.equal(catalogRead[0]?.status, "available", JSON.stringify(catalogRead));
    assert.equal(catalogRead[0]?.rules.length, 1, JSON.stringify(catalogRead));
    const assessed = await runtime.context.homeAutomationMigrations.assessBridgeCatalog(BRIDGE_ID);
    assert.equal(assessed.outcome, "created", JSON.stringify(assessed));
    assert.equal(assessed.assessment.sourceEpochId, baseline.epochId);
    assert.equal(assessed.assessment.sourceLastSeq, baseline.lastSeq);
    const rule = assessed.assessment.rules[0];
    if (rule === undefined) assert.fail("HA migration catalog did not contain a rule");

    const prepared = await runtime.context.homeAutomationMigrations.prepareRuleReview({
      migrationId: assessed.assessment.migrationId,
      ruleRef: rule.ruleRef,
    });
    assert.equal(prepared.status, "translated");
    if (prepared.status !== "translated") assert.fail("HA migration did not create a translated review");

    const review = await waitFor(
      () => runtime.context.homeArtifacts.reviewForProposal(prepared.proposalId, prepared.candidateProposalRevision),
      (current) => current?.compile.status === "compiled" && current.dryRun.status === "passed",
      "artifact compile and dry-run completion",
      () => runtime.context.homeProposals.preparationForProposal(prepared.proposalId, prepared.candidateProposalRevision),
    );
    if (review === undefined || review.compile.status !== "compiled" || review.dryRun.status !== "passed") {
      assert.fail("Artifact review did not reach compiled/passed");
    }

    const completedWorkflow = await waitFor(
      () => runtime.context.homeAutomationMigrations.get(assessed.assessment.migrationId),
      (current) => current?.rules.some((candidate) => (
        candidate.ruleRef === rule.ruleRef && candidate.workflow?.status === "ready"
      )) === true,
      "migration completion handoff to ready",
    );
    const workflow = completedWorkflow?.rules.find((candidate) => candidate.ruleRef === rule.ruleRef)?.workflow;
    assert.equal(workflow?.status, "ready");

    return { directory, socket, fetchFake, runtime, world, baseline, target, assessed, rule, prepared, review };
  } catch (error) {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

test("runs a real HA cutover through verified deployment and read-back rollback", async () => {
  const fixture = await createReadyMigrationFixture();
  const { directory, socket, fetchFake, runtime, world, baseline, target, assessed, rule, prepared, review } = fixture;
  try {
    const expectedWatermark = {
      bridgeId: baseline.bridgeId,
      epochId: baseline.epochId,
      lastSeq: baseline.lastSeq,
      ...(baseline.lastSyncCompleteAt === undefined ? {} : { lastSyncCompleteAt: baseline.lastSyncCompleteAt }),
      freshness: "fresh" as const,
      gapCount: 0,
    };
    assert.deepEqual(review.evidence?.watermarks, [expectedWatermark]);
    assert.deepEqual(review.compile.usedWatermarks, [expectedWatermark]);
    assert.deepEqual(review.dryRun.checkedWatermarks, [expectedWatermark]);
    assert.deepEqual(review.dryRun.diff, review.compile.diff);
    assert.equal(review.dryRun.compileAttestationId, review.compile.resultId);
    assert.equal(review.dryRun.compileInputIdentity, review.compile.inputIdentity);
    assert.equal(review.writesPerformed, false);
    assert.equal(review.dryRun.writesPerformed, false);
    assert.deepEqual(review.compile.diff, {
      status: "changes",
      operations: [{
        actionOrder: 1,
        kind: "set_boolean",
        hwCapabilityId: target.hwCapabilityId,
        actionAuthorityCandidateId: review.compile.actionAuthorityBindings[0]?.actionAuthorityCandidateId,
        before: false,
        after: true,
      }],
      unchangedCount: 0,
      redacted: true,
    });
    assert.equal(review.compile.actionAuthorityBindings.length, 1);

    assert.equal("latestResult" in runtime.context.homeArtifacts, false, "compiler result rows stay root-private");
    const artifactRegistry = (runtime as unknown as {
      bundle: { artifactRegistry: ArtifactRegistry };
    }).bundle.artifactRegistry;
    const compileResult = artifactRegistry.latestResult({ kind: "compile-attestation", artifact: review.artifact });
    const dryRunResult = artifactRegistry.latestResult({ kind: "dry-run-attestation", artifact: review.artifact });
    if (compileResult?.kind !== "compile-attestation" || dryRunResult?.kind !== "dry-run-attestation") {
      assert.fail("Artifact compiler result rows are unavailable");
    }
    assert.equal(compileResult.result.worldCutIdentity, dryRunResult.result.worldCutIdentity);

    const proposalBeforeEnable = runtime.context.homeProposals.get(prepared.proposalId);
    if (proposalBeforeEnable === undefined) assert.fail("Prepared migration proposal is unavailable");
    const enabling = runtime.context.homeProposals.enableProposal({
      proposalId: prepared.proposalId,
      expectedRevision: proposalBeforeEnable.revision,
      reviewer: "household-owner",
    });
    const pauseCommand = await waitForServiceCommand(socket, "turn_off");
    assert.equal(pauseCommand.domain, "automation");
    assert.deepEqual(pauseCommand.target, { entity_id: "automation.arrival_light" });
    assert.deepEqual(pauseCommand.service_data, {});
    fetchFake.setSourceState("off");
    if (typeof pauseCommand.id !== "number") assert.fail("Source pause command id is unavailable");
    socket.receive({ id: pauseCommand.id, type: "result", success: true, result: null });
    const enabled = await enabling;
    assert.equal(enabled.lifecycle, "active", JSON.stringify(enabled));
    assert.equal(fetchFake.sourceState(), "off");
    const deployment = enabled.deployment;
    if (deployment?.deploymentId === undefined || deployment.target === undefined) {
      assert.fail("Verified target deployment identity is unavailable");
    }
    const deployedWorkflow = runtime.context.homeAutomationMigrations.get(assessed.assessment.migrationId)
      ?.rules.find((candidate) => candidate.ruleRef === rule.ruleRef)?.workflow;
    assert.equal(deployedWorkflow?.status, "verified");
    assert.equal(fetchFake.targetAutomations.get(deployment.deploymentId)?.state, "on");

    const post = fetchFake.requests.find((request) => (
      request.method === "POST"
      && request.url.endsWith(`/api/config/automation/config/${deployment.deploymentId}`)
    ));
    assert.ok(post, "target deployment must use the automation config POST");
    assert.deepEqual(post.body, {
      id: deployment.deploymentId,
      alias: deployment.deploymentId,
      description: "hob:晚间灯光",
      trigger: [{ platform: "state", entity_id: "light.kitchen" }],
      condition: [{ condition: "state", entity_id: "light.kitchen", state: "off" }],
      action: [{ service: "homeassistant.turn_on", target: { entity_id: "light.kitchen" } }],
      mode: "single",
    });

    const closing = runtime.context.homeProposals.closeAutomation({
      proposalId: prepared.proposalId,
      actor: "household-owner",
    });
    const restoreCommand = await waitForServiceCommand(socket, "turn_on");
    assert.equal(restoreCommand.domain, "automation");
    assert.deepEqual(restoreCommand.target, { entity_id: "automation.arrival_light" });
    assert.deepEqual(restoreCommand.service_data, {});
    fetchFake.setSourceState("on");
    if (typeof restoreCommand.id !== "number") assert.fail("Source restore command id is unavailable");
    socket.receive({ id: restoreCommand.id, type: "result", success: true, result: null });
    const closed = await closing;
    assert.equal(closed.lifecycle, "closed", JSON.stringify(closed));
    assert.equal(fetchFake.sourceState(), "on");
    const restoredWorkflow = runtime.context.homeAutomationMigrations.get(assessed.assessment.migrationId)
      ?.rules.find((candidate) => candidate.ruleRef === rule.ruleRef)?.workflow;
    assert.equal(restoredWorkflow?.status, "restored");
    assert.equal(fetchFake.targetAutomations.has(deployment.deploymentId), false);

    const serviceCalls = socket.sent.filter((message) => message.type === "call_service");
    assert.deepEqual(serviceCalls, [pauseCommand, restoreCommand]);
    assert.equal(fetchFake.requests.filter((request) => request.method === "POST").length, 1);
    assert.equal(fetchFake.requests.filter((request) => request.method === "DELETE").length, 1);
    assert.equal(fetchFake.requests.filter((request) => request.method !== "GET").every((request) => (
      request.url.endsWith(`/api/config/automation/config/${deployment.deploymentId}`)
    )), true);
    const allowedReadUrls = new Set([
      SOURCE_STATE_URL,
      SOURCE_CONFIG_URL,
      `http://ha.local:8123/api/states/automation.${deployment.deploymentId}`,
      `http://ha.local:8123/api/config/automation/config/${deployment.deploymentId}`,
    ]);
    assert.equal(fetchFake.requests.filter((request) => request.method === "GET").every((request) => allowedReadUrls.has(request.url)), true);
  } finally {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recovers a failed HA rollback with a fresh receipt and no blind replay", async () => {
  const fixture = await createReadyMigrationFixture();
  const { directory, socket, fetchFake, runtime, assessed, rule, prepared } = fixture;
  try {
    const proposalBeforeEnable = runtime.context.homeProposals.get(prepared.proposalId);
    if (proposalBeforeEnable === undefined) assert.fail("Prepared migration proposal is unavailable");
    const enabling = runtime.context.homeProposals.enableProposal({
      proposalId: prepared.proposalId,
      expectedRevision: proposalBeforeEnable.revision,
      reviewer: "household-owner",
    });
    const pauseCommand = await waitForServiceCommand(socket, "turn_off");
    assert.deepEqual(pauseCommand.target, { entity_id: "automation.arrival_light" });
    if (typeof pauseCommand.id !== "number") assert.fail("Source pause command id is unavailable");
    fetchFake.setSourceState("off");
    socket.receive({ id: pauseCommand.id, type: "result", success: true, result: null });
    const enabled = await enabling;
    assert.equal(enabled.lifecycle, "active", JSON.stringify(enabled));
    const deployment = enabled.deployment;
    if (deployment?.deploymentId === undefined || deployment.target === undefined) {
      assert.fail("Verified target deployment identity is unavailable");
    }
    assert.equal(fetchFake.targetAutomations.has(deployment.deploymentId), true);

    const proposalBeforeClose = runtime.context.homeProposals.get(prepared.proposalId);
    if (proposalBeforeClose === undefined) assert.fail("Active migration proposal is unavailable");
    const firstRestoreSentCount = socket.sent.length;
    const closing = runtime.context.homeProposals.closeAutomation({
      proposalId: prepared.proposalId,
      expectedRevision: proposalBeforeClose.revision,
      actor: "household-owner",
    });
    const firstRestore = await waitForServiceCommand(socket, "turn_on", firstRestoreSentCount);
    assert.deepEqual(firstRestore.target, { entity_id: "automation.arrival_light" });
    if (typeof firstRestore.id !== "number") assert.fail("First source restore command id is unavailable");
    socket.receive({
      id: firstRestore.id,
      type: "result",
      success: false,
      error: { code: "restore_failed", message: "source restore unavailable" },
    });
    const failedClose = await closing;
    assert.equal(failedClose.lifecycle, "recovery_required", JSON.stringify(failedClose));
    assert.equal(fetchFake.sourceState(), "off");
    assert.equal(fetchFake.targetAutomations.has(deployment.deploymentId), false);
    assert.equal(fetchFake.requests.filter((request) => request.method === "DELETE").length, 1);
    assert.equal(failedClose.applicationStatus, "failed");

    const failedWorkflow = runtime.context.homeAutomationMigrations.findWorkflowForProposal(prepared.proposalId);
    if (failedWorkflow.status !== "governed") assert.fail("Failed rollback workflow is not governed");
    assert.equal(failedWorkflow.workflowStatus, "needs_attention");
    assert.equal(failedWorkflow.failureReason, "rollback_unknown");
    if (failedWorkflow.rollbackOperationId === undefined) assert.fail("Failed rollback receipt is unavailable");
    const firstRollbackOperationId = failedWorkflow.rollbackOperationId;

    const proposalBeforeRecovery = runtime.context.homeProposals.get(prepared.proposalId);
    if (proposalBeforeRecovery === undefined) assert.fail("Recovery-required migration proposal is unavailable");
    const recoverySentCount = socket.sent.length;
    const recovering = runtime.context.homeProposals.recoverAutomation({
      proposalId: prepared.proposalId,
      expectedRevision: proposalBeforeRecovery.revision,
      actor: "household-recovery-member",
    });
    const secondRestore = await waitForServiceCommand(socket, "turn_on", recoverySentCount);
    assert.deepEqual(secondRestore.target, { entity_id: "automation.arrival_light" });
    if (typeof secondRestore.id !== "number") assert.fail("Second source restore command id is unavailable");
    assert.notEqual(secondRestore.id, firstRestore.id, "recovery must issue a new WebSocket command");
    const recoveringWorkflow = runtime.context.homeAutomationMigrations.findWorkflowForProposal(prepared.proposalId);
    if (recoveringWorkflow.status !== "governed") assert.fail("Recovery rollback workflow is not governed");
    assert.equal(recoveringWorkflow.workflowStatus, "rolling_back");
    if (recoveringWorkflow.rollbackOperationId === undefined) assert.fail("Recovery rollback receipt is unavailable");
    assert.notEqual(recoveringWorkflow.rollbackOperationId, firstRollbackOperationId, "recovery must issue a fresh rollback receipt");

    fetchFake.setSourceState("on");
    socket.receive({ id: secondRestore.id, type: "result", success: true, result: null });
    const recovered = await recovering;
    assert.equal(recovered.lifecycle, "closed", JSON.stringify(recovered));
    assert.equal(fetchFake.sourceState(), "on");
    assert.equal(fetchFake.targetAutomations.has(deployment.deploymentId), false);
    assert.equal(recovered.applicationStatus, "withdrawn");
    assert.equal(recovered.deployment?.status, "rolled_back");
    assert.equal(recovered.audit.filter((event) => event.action === "approved").length, 1, "recovery must not create a second approval");
    const restoredWorkflow = runtime.context.homeAutomationMigrations.findWorkflowForProposal(prepared.proposalId);
    if (restoredWorkflow.status !== "governed") assert.fail("Restored workflow is not governed");
    assert.equal(restoredWorkflow.workflowStatus, "restored");

    const serviceCalls = socket.sent.filter((message) => message.type === "call_service");
    assert.equal(serviceCalls.length, 3);
    assert.equal(serviceCalls.filter((message) => message.service === "turn_off").length, 1);
    assert.equal(serviceCalls.filter((message) => message.service === "turn_on").length, 2);
    assert.equal(serviceCalls.filter((message) => message.domain !== "automation").length, 0);
    assert.equal(serviceCalls.every((message) => (
      message.domain === "automation"
      && message.target !== undefined
      && JSON.stringify(message.target) === JSON.stringify({ entity_id: "automation.arrival_light" })
    )), true);
    assert.equal(fetchFake.requests.filter((request) => request.method === "POST").length, 1);
    assert.equal(fetchFake.requests.filter((request) => request.method === "DELETE").length, 1);
    assert.equal(fetchFake.requests.filter((request) => request.method !== "GET").every((request) => (
      request.url.endsWith(`/api/config/automation/config/${deployment.deploymentId}`)
    )), true);
  } finally {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
