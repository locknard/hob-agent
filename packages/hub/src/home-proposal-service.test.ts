import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

import { HomeProposalService } from "./home-proposal-service.js";
import type { CreateProposalInput } from "./proposal-store.js";

const candidate: CreateProposalInput = {
  kind: "household-insight",
  title: "Review unavailable device coverage",
  summary: "Some observed capabilities may need household review.",
  idempotencyKey: "health:unavailable-coverage:v1",
  provenance: { producer: "dsh-home-agent", sessionId: "home-main" },
  evidence: {
    references: [{ bridgeId: "bridge-a", observedAt: "2026-08-19T01:00:00.000Z" }],
    watermarks: [{
      bridgeId: "bridge-a",
      epochId: "epoch-a",
      lastSeq: 8,
      freshness: "fresh",
      gapCount: 0,
    }],
  },
  conflictCheck: { status: "checked", existingAutomationCount: 0, matches: [] },
  dryRun: { status: "passed", summary: "Read-only proposal; no changes were made." },
  risk: { level: "low", reasons: [], requiresHumanApproval: true },
  intent: {
    type: "household-insight",
    description: "Ask the household to review coverage.",
    rollback: "Reject or expire the proposal.",
  },
};

class StubHomeWorld extends Service {
  evidenceQueries: unknown[] = [];
  includeUnavailableBridge = false;
  includeUnavailableDevice = false;

  constructor(ctx: Context) {
    super(ctx, "homeWorld");
  }

  snapshot() {
    const unavailableDevice = {
      hwId: "hw-2",
      bindings: [{ bridgeId: "bridge-b", nativeId: "native-2", nativeInstanceId: "entity-2" }],
      capabilities: [],
      states: [],
    };
    return {
      generatedAt: "2026-08-19T01:00:00.000Z",
      bridges: {
        "bridge-a": { diagnostics: { historyGapCount: 0 } },
        ...(this.includeUnavailableBridge ? { "bridge-b": { diagnostics: { historyGapCount: 0 } } } : {}),
      },
      bridgeWatermarks: [
        { bridgeId: "bridge-a", epochId: "epoch-a", lastSeq: 8 },
        ...(this.includeUnavailableBridge ? [{ bridgeId: "bridge-b", epochId: "epoch-b", lastSeq: 4 }] : []),
      ],
      diagnostics: [
        { bridgeId: "bridge-a", connectionState: "ready", historyGapCount: 0 },
        ...(this.includeUnavailableBridge
          ? [{ bridgeId: "bridge-b", connectionState: "ready", historyGapCount: 0 }]
          : []),
      ],
      devices: [{
        hwId: "hw-1",
        bindings: [{ bridgeId: "bridge-a", nativeId: "native-1", nativeInstanceId: "entity-1" }],
        capabilities: [{
          hwCapabilityId: "hwc-1",
          bindings: [{ bridgeId: "bridge-a", nativeId: "native-1", nativeInstanceId: "entity-1" }],
        }],
        states: [{
          nativeId: "native-1",
          nativeInstanceId: "entity-1",
          time: { sourceTs: "2026-08-19T00:59:00.000Z" },
        }],
      }, ...(this.includeUnavailableDevice ? [unavailableDevice] : [])],
    };
  }

  async foreignRuleCatalog() {
    return [{
      bridgeId: "bridge-a",
      status: "available" as const,
      epochId: "epoch-a",
      rules: [{ ruleRef: "rule-1", name: "Arrival light", enabled: true }],
    }, ...(this.includeUnavailableBridge ? [{
      bridgeId: "bridge-b",
      status: "unavailable" as const,
      rules: [],
    }] : [])];
  }

  queryRecentEvidence(input: unknown) {
    this.evidenceQueries.push(input);
    return {
      requestedSince: "2026-08-18T01:00:00.000Z",
      requestedUntil: "2026-08-19T01:00:00.000Z",
      events: [{
        hwId: "hw-1",
        hwCapabilityId: "hwc-1",
        value: "on",
        observedAt: "2026-08-19T00:30:00.000Z",
        sourceTsQuality: "platform" as const,
        origin: "observed" as const,
        provenance: { bridgeId: "bridge-a", epochId: "epoch-a", seq: 11 },
      }],
      coverage: [{
        bridgeId: "bridge-a",
        epochId: "epoch-a",
        baselineSeq: 8,
        baselineAt: "2026-08-18T01:00:00.000Z",
        status: "complete" as const,
        reasons: [],
      }],
      truncated: false,
    };
  }
}

test("scopes authoritative rule coverage to every bridge bound to selected devices", async () => {
  const ctx = new Context();
  await ctx.plugin(StubHomeWorld);
  const world = ctx.homeWorld as unknown as StubHomeWorld;
  world.includeUnavailableBridge = true;
  world.includeUnavailableDevice = true;
  const fiber = await ctx.plugin(HomeProposalService, { path: ":memory:" });
  const draft = {
    kind: "household-insight" as const,
    title: "Review bridge-local behavior",
    summary: "Only the selected bridge should determine rule coverage.",
    idempotencyKey: "bridge-local-coverage:v1",
    provenance: { producer: "dsh-home-agent" },
    selectedHwIds: ["hw-1"],
    risk: { level: "low" as const, reasons: [] },
    intent: {
      type: "household-insight",
      description: "Review a bridge-local observation.",
      rollback: "Reject the proposal.",
    },
  };

  const proposal = await ctx.homeProposals.createDraft(draft);
  assert.equal(proposal.conflictCheck.status, "checked");
  assert.equal(proposal.conflictCheck.existingAutomationCount, 1);
  ctx.homeProposals.review({
    proposalId: proposal.id,
    expectedRevision: 1,
    decision: "rejected",
    reviewer: "household-owner",
  });

  await assert.rejects(() => ctx.homeProposals.createDraft({
    ...draft,
    idempotencyKey: "cross-bridge-coverage:v1",
    selectedHwIds: ["hw-1", "hw-2"],
  }), /conflict check is required/i);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("exposes the hub-owned proposal lifecycle as a Cordis service", async () => {
  const ctx = new Context();
  await ctx.plugin(StubHomeWorld);
  const fiber = await ctx.plugin(HomeProposalService, {
    path: ":memory:",
    now: () => "2026-08-19T01:00:00.000Z",
    id: (() => {
      let value = 0;
      return () => String(++value);
    })(),
  });

  const created = ctx.homeProposals.create(candidate);
  assert.equal(ctx.homeProposals.get(created.id)?.id, created.id);
  assert.deepEqual(ctx.homeProposals.list(), [created]);
  assert.equal(ctx.homeProposals.review({
    proposalId: created.id,
    expectedRevision: 1,
    decision: "rejected",
    reviewer: "household-owner",
  }).status, "rejected");

  await fiber.dispose();
  assert.throws(() => ctx.homeProposals.list());
  await ctx.fiber.dispose();
});

test("creates evidence and conflict findings from the hub instead of trusting model claims", async () => {
  const ctx = new Context();
  await ctx.plugin(StubHomeWorld);
  const fiber = await ctx.plugin(HomeProposalService, {
    path: ":memory:",
    now: () => "2026-08-19T01:00:00.000Z",
    id: (() => {
      let value = 0;
      return () => String(++value);
    })(),
  });

  const proposal = await ctx.homeProposals.createDraft({
    kind: "automation-draft",
    title: "Arrival light follow-up",
    summary: "Review a possible arrival light automation.",
    idempotencyKey: "arrival-light:v1",
    provenance: { producer: "dsh-home-agent", sessionId: "home-main", toolCallId: "call-1" },
    selectedHwIds: ["hw-1"],
    selectedHwCapabilityIds: ["hwc-1"],
    evidenceLookbackHours: 24,
    risk: { level: "medium", reasons: ["Could overlap an existing rule"] },
    intent: {
      type: "automation-draft",
      description: "Prepare a review-only draft.",
      rollback: "Discard the draft.",
    },
  });

  assert.deepEqual(proposal.evidence.watermarks, [{
    bridgeId: "bridge-a",
    epochId: "epoch-a",
    lastSeq: 8,
    freshness: "fresh",
    gapCount: 0,
  }]);
  assert.deepEqual(ctx.homeWorld.evidenceQueries, [{
    hwCapabilityIds: ["hwc-1"],
    lookbackHours: 24,
    limit: 50,
  }]);
  assert.deepEqual(proposal.evidence.references, [{
    bridgeId: "bridge-a",
    hwId: "hw-1",
    capabilityId: "hwc-1",
    observedAt: "2026-08-19T00:30:00.000Z",
    source: "post-baseline-event",
    epochId: "epoch-a",
    seq: 11,
  }]);
  assert.deepEqual(proposal.evidence.temporal, {
    requestedSince: "2026-08-18T01:00:00.000Z",
    requestedUntil: "2026-08-19T01:00:00.000Z",
    truncated: false,
    coverage: [{
      bridgeId: "bridge-a",
      epochId: "epoch-a",
      baselineSeq: 8,
      baselineAt: "2026-08-18T01:00:00.000Z",
      status: "complete",
      reasons: [],
    }],
  });
  assert.equal(proposal.conflictCheck.existingAutomationCount, 1);
  assert.deepEqual(proposal.conflictCheck.matches, [{ identity: "rule-1", relation: "possible_overlap" }]);
  assert.deepEqual(proposal.dryRun, {
    status: "not_run",
    summary: "No automation artifact exists yet; execution simulation was not run.",
  });
  assert.equal(proposal.applicationStatus, "not_available");

  await assert.rejects(() => ctx.homeProposals.createDraft({
    kind: "household-insight",
    title: "Another pending item",
    summary: "This must wait for household review.",
    idempotencyKey: "another-item:v1",
    provenance: { producer: "dsh-home-agent" },
    selectedHwIds: ["hw-1"],
    risk: { level: "low", reasons: [] },
    intent: { type: "household-insight", description: "Wait.", rollback: "Discard it." },
  }), /pending review/);
  ctx.homeProposals.review({
    proposalId: proposal.id,
    expectedRevision: 1,
    decision: "rejected",
    reviewer: "household-owner",
  });

  const currentStateProposal = await ctx.homeProposals.createDraft({
    kind: "household-insight",
    title: "Review current light state",
    summary: "A current-state-only observation for review.",
    idempotencyKey: "current-light:v1",
    provenance: { producer: "dsh-home-agent", sessionId: "home-main", toolCallId: "call-2" },
    selectedHwIds: ["hw-1"],
    risk: { level: "low", reasons: [] },
    intent: {
      type: "household-insight",
      description: "Review the current state only.",
      rollback: "Discard the insight.",
    },
  });
  assert.deepEqual(currentStateProposal.evidence.references, [{
    bridgeId: "bridge-a",
    hwId: "hw-1",
    capabilityId: "hwc-1",
    observedAt: "2026-08-19T00:59:00.000Z",
    source: "current-state",
  }]);
  assert.equal(currentStateProposal.evidence.temporal, undefined);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("rejects temporal capability selections outside the selected devices", async () => {
  const ctx = new Context();
  await ctx.plugin(StubHomeWorld);
  const fiber = await ctx.plugin(HomeProposalService, { path: ":memory:" });

  await assert.rejects(() => ctx.homeProposals.createDraft({
    kind: "household-insight",
    title: "Review evidence",
    summary: "Review a bounded observation.",
    idempotencyKey: "review-evidence:v1",
    provenance: { producer: "dsh-home-agent" },
    selectedHwIds: ["hw-missing"],
    selectedHwCapabilityIds: ["hwc-1"],
    evidenceLookbackHours: 24,
    risk: { level: "low", reasons: [] },
    intent: { type: "household-insight", description: "Review it.", rollback: "Reject it." },
  }), /selected devices/);
  assert.deepEqual(ctx.homeWorld.evidenceQueries, []);

  await fiber.dispose();
  await ctx.fiber.dispose();
});
