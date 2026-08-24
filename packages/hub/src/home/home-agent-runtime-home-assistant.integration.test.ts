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
  const requests: Array<{ method: string; url: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ method: init?.method ?? "GET", url });
    return new Response(JSON.stringify(RULE_CONFIG), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, requests };
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

test("runs a real HA migration through preparation completion into an exact artifact review", async () => {
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
    assert.equal(socket.sent.some((message) => message.type === "call_service"), false);
    assert.equal(fetchFake.requests.every((request) => request.method === "GET"), true);
    assert.equal(fetchFake.requests.every((request) => request.url.endsWith("/api/config/automation/config/arrival_light")), true);
  } finally {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
