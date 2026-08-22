import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Context, Service } from "@deepseek-ai/cordis";

import { HomeProposalService } from "./home-proposal-service.js";
import {
  ProposalStoreError,
  SqliteProposalStore,
  type ArtifactPreparationJob,
  type CreateProposalInput,
} from "./proposal-store.js";

const rationale = {
  householdValue: "Reduce a recurring household inconvenience.",
  whyNow: "Recent bounded evidence makes the suggestion timely.",
  uncertainties: ["Whether this behavior reflects an intentional preference."],
} as const;

const automationCandidate = {
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
  rationale,
  spaceCoverage: {
    selectedDevices: 1,
    devicesWithSingleSpace: 0,
    devicesWithoutSpace: 1,
    devicesWithMultipleSpaces: 0,
  },
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
  bridgeConnectionState: "ready" | "degraded" = "ready";
  bridgeHistoryGapCount = 0;
  extraCapabilities = 0;
  capabilitySemanticKind: "light" | "lock" = "light";
  actionPolicyClass: "direct" | "confirmation" | "administrator" | "unavailable" = "direct";

  constructor(ctx: Context) {
    super(ctx, "homeWorld");
  }

  snapshot() {
    const unavailableDevice = {
      hwId: "hw-2",
      validity: "valid" as const,
      bindings: [{ bridgeId: "bridge-b", nativeId: "native-2", nativeInstanceId: "entity-2" }],
      capabilities: [],
      states: [],
    };
    return {
      generatedAt: "2026-08-19T01:00:00.000Z",
      spaces: [],
      bridges: {
        "bridge-a": { diagnostics: { historyGapCount: this.bridgeHistoryGapCount } },
        ...(this.includeUnavailableBridge ? { "bridge-b": { diagnostics: { historyGapCount: 0 } } } : {}),
      },
      bridgeWatermarks: [
        { bridgeId: "bridge-a", epochId: "epoch-a", lastSeq: 8 },
        ...(this.includeUnavailableBridge ? [{ bridgeId: "bridge-b", epochId: "epoch-b", lastSeq: 4 }] : []),
      ],
      diagnostics: [
        { bridgeId: "bridge-a", connectionState: this.bridgeConnectionState, historyGapCount: this.bridgeHistoryGapCount },
        ...(this.includeUnavailableBridge
          ? [{ bridgeId: "bridge-b", connectionState: "ready", historyGapCount: 0 }]
          : []),
      ],
      devices: [{
        hwId: "hw-1",
        validity: "valid" as const,
        bindings: [{ bridgeId: "bridge-a", nativeId: "native-1", nativeInstanceId: "entity-1" }],
        capabilities: [{
          hwCapabilityId: "hwc-1",
          hwId: "hw-1",
          schema: "fixture.boolean",
          schemaVersion: "1.0.0",
          semanticKind: this.capabilitySemanticKind,
          bindings: [{ bridgeId: "bridge-a", nativeId: "native-1", nativeInstanceId: "entity-1" }],
        }, ...Array.from({ length: this.extraCapabilities }, (_, index) => ({
          hwCapabilityId: `hwc-${index + 2}`,
          hwId: "hw-1",
          schema: "fixture.boolean",
          schemaVersion: "1.0.0",
          semanticKind: "light" as const,
          bindings: [{
            bridgeId: "bridge-a",
            nativeId: "native-1",
            nativeInstanceId: `entity-${index + 2}`,
          }],
        }))],
        states: [{
          nativeId: "native-1",
          nativeInstanceId: "entity-1",
          time: { sourceTs: "2026-08-19T00:59:00.000Z" },
        }, ...Array.from({ length: this.extraCapabilities }, (_, index) => ({
          nativeId: "native-1",
          nativeInstanceId: `entity-${index + 2}`,
          time: { sourceTs: "2026-08-19T00:59:00.000Z" },
        }))],
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

  resolveActionAuthority(hwCapabilityId: string) {
    const numericId = Number.parseInt(hwCapabilityId.replace(/^hwc-/, ""), 10);
    const isKnownCapability = Number.isInteger(numericId)
      && numericId >= 1
      && numericId <= this.extraCapabilities + 1;
    return isKnownCapability && this.actionPolicyClass !== "unavailable"
      ? { status: "available" as const, bridgeId: "bridge-a", policyClass: this.actionPolicyClass }
      : { status: "unavailable" as const, reason: "not_configured" as const };
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

test("the proposal owner preserves degraded bridge evidence for a no-device insight draft", async () => {
  const ctx = new Context();
  await ctx.plugin(StubHomeWorld);
  const world = ctx.homeWorld as unknown as StubHomeWorld;
  world.bridgeConnectionState = "degraded";
  world.bridgeHistoryGapCount = 4;
  const proposalsFiber = await ctx.plugin(HomeProposalService, { path: ":memory:" });

  const proposal = await ctx.homeProposals.createDraft({
    kind: "household-insight",
    title: "Review a household preference",
    summary: "A household member asked for a future behavior change.",
    idempotencyKey: "correction:gapped-world:v1",
    provenance: { producer: "hob-conversation-correction", sessionId: "adult-1" },
    selectedHwIds: [],
    rationale,
    risk: { level: "low", reasons: [] },
    intent: {
      type: "future_behavior",
      description: "Review a household preference.",
      rollback: "Reject or expire the proposal.",
    },
  });

  assert.deepEqual(proposal.evidence.watermarks, [{
    bridgeId: "bridge-a",
    epochId: "epoch-a",
    lastSeq: 8,
    freshness: "stale",
    gapCount: 4,
  }]);
  assert.deepEqual(proposal.spaceCoverage, {
    selectedDevices: 0,
    devicesWithSingleSpace: 0,
    devicesWithoutSpace: 0,
    devicesWithMultipleSpaces: 0,
  });

  await proposalsFiber.dispose();
  await ctx.fiber.dispose();
});

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
    rationale,
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
    feedbackCode: "not_useful",
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
    feedbackCode: "already_covered",
  }).status, "rejected");

  await fiber.dispose();
  assert.throws(() => ctx.homeProposals.list());
  await ctx.fiber.dispose();
});

test("exposes the synchronous approved source gate without accepting caller evidence", async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeProposalService, {
    path: ":memory:",
    now: () => "2026-08-19T01:00:00.000Z",
  });
  const created = ctx.homeProposals.create({
    ...candidate,
    kind: "automation-draft",
    intent: { ...candidate.intent, type: "automation-draft" },
    idempotencyKey: "source-gate:automation:v1",
    artifactCandidate: automationCandidate,
  });
  const approved = ctx.homeProposals.review({
    proposalId: created.id,
    expectedRevision: 1,
    decision: "approved",
    reviewer: "household-owner",
    feedbackCode: "useful_as_is",
  });

  const source = ctx.homeProposals.withApprovedProposalAtRevision(
    approved.id,
    approved.revision,
    (value) => value,
  );
  assert.equal(source.proposalId, approved.id);
  assert.equal(source.revision, approved.revision);
  assert.deepEqual(source.evidence, approved.evidence);
  assert.equal(Object.isFrozen(source), true);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("requires a Hub-verifiable artifact candidate for new automation drafts", async () => {
  const ctx = new Context();
  await ctx.plugin(StubHomeWorld);
  const fiber = await ctx.plugin(HomeProposalService, { path: ":memory:" });
  const base = {
    kind: "automation-draft" as const,
    title: "Review one bounded light trial",
    summary: "A closed candidate for household review only.",
    idempotencyKey: "candidate-required:v1",
    provenance: { producer: "dsh-home-agent" },
    selectedHwIds: ["hw-1"],
    rationale,
    risk: { level: "low" as const, reasons: [] },
    intent: {
      type: "automation-draft",
      description: "Review a bounded light change.",
      rollback: "Restore the previous state.",
    },
  };
  await assert.rejects(() => ctx.homeProposals.createDraft(base), /artifact candidate/i);
  await assert.rejects(() => ctx.homeProposals.createDraft({
    ...base,
    idempotencyKey: "candidate-foreign-target:v1",
    artifactCandidate: {
      ...automationCandidate,
      content: {
        ...automationCandidate.content,
        actions: [{ kind: "set_boolean" as const, target: { hwCapabilityId: "hwc-foreign" }, value: false }],
        rollback: { kind: "restore_previous_state" as const, target: { hwCapabilityId: "hwc-foreign" }, maxAgeSeconds: 3_600 },
        postconditions: [{
          kind: "capability_value" as const,
          source: { hwCapabilityId: "hwc-foreign" },
          operator: "equals" as const,
          value: false,
          withinSeconds: 30,
        }],
      },
    },
  }), /selected devices/i);
  const proposal = await ctx.homeProposals.createDraft({ ...base, artifactCandidate: automationCandidate });
  assert.deepEqual(proposal.artifactCandidate, automationCandidate);
  ctx.homeProposals.review({
    proposalId: proposal.id,
    expectedRevision: 1,
    decision: "rejected",
    reviewer: "household-owner",
    feedbackCode: "not_useful",
  });
  await assert.rejects(() => ctx.homeProposals.createDraft({
    ...base,
    kind: "household-insight",
    idempotencyKey: "candidate-on-insight:v1",
    artifactCandidate: automationCandidate,
  }), /artifact candidate/i);
  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("uses explicit action policy for proposal safety and fails closed without it", async () => {
  const ctx = new Context();
  await ctx.plugin(StubHomeWorld);
  const world = ctx.homeWorld as unknown as StubHomeWorld;
  const fiber = await ctx.plugin(HomeProposalService, { path: ":memory:" });
  const base = {
    kind: "automation-draft" as const,
    title: "Review one bounded action",
    summary: "A closed candidate for household review only.",
    provenance: { producer: "dsh-home-agent" },
    selectedHwIds: ["hw-1"],
    rationale,
    risk: { level: "low" as const, reasons: [] },
    intent: {
      type: "automation-draft",
      description: "Review a bounded change.",
      rollback: "Restore the previous state.",
    },
    artifactCandidate: automationCandidate,
  };

  world.actionPolicyClass = "administrator";
  await assert.rejects(() => ctx.homeProposals.createDraft({ ...base, idempotencyKey: "policy:administrator:v1" }), /administrator policy/i);

  world.actionPolicyClass = "unavailable";
  await assert.rejects(() => ctx.homeProposals.createDraft({ ...base, idempotencyKey: "policy:missing:v1" }), /explicit action policy/i);

  world.actionPolicyClass = "direct";
  world.capabilitySemanticKind = "lock";
  const proposal = await ctx.homeProposals.createDraft({ ...base, idempotencyKey: "policy:direct-lock-hint:v1" });
  assert.equal(proposal.status, "pending_review");

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("snapshots an admitted artifact candidate before awaiting external catalogs", async () => {
  const ctx = new Context();
  await ctx.plugin(StubHomeWorld);
  const world = ctx.homeWorld as unknown as StubHomeWorld;
  const originalCatalog = world.foreignRuleCatalog.bind(world);
  const mutableCandidate = structuredClone(automationCandidate) as unknown as {
    schemaVersion: "1";
    content: {
      trigger: { kind: "capability_changed"; source: { hwCapabilityId: string } };
      conditions: [];
      actions: Array<{ kind: "set_boolean"; target: { hwCapabilityId: string }; value: boolean }>;
      rollback: { kind: "restore_previous_state"; target: { hwCapabilityId: string }; maxAgeSeconds: number };
      postconditions: Array<{
        kind: "capability_value";
        source: { hwCapabilityId: string };
        operator: "equals";
        value: boolean;
        withinSeconds: number;
      }>;
    };
  };
  world.foreignRuleCatalog = async () => {
    mutableCandidate.content.trigger.source.hwCapabilityId = "hwc-foreign";
    mutableCandidate.content.actions[0]!.target.hwCapabilityId = "hwc-foreign";
    mutableCandidate.content.rollback.target.hwCapabilityId = "hwc-foreign";
    mutableCandidate.content.postconditions[0]!.source.hwCapabilityId = "hwc-foreign";
    return originalCatalog();
  };
  const fiber = await ctx.plugin(HomeProposalService, { path: ":memory:" });

  const proposal = await ctx.homeProposals.createDraft({
    kind: "automation-draft",
    title: "Review one immutable candidate",
    summary: "The admitted behavior must not change while the Hub awaits a catalog.",
    idempotencyKey: "candidate-await-snapshot:v1",
    provenance: { producer: "dsh-home-agent" },
    selectedHwIds: ["hw-1"],
    rationale,
    risk: { level: "low", reasons: [] },
    intent: {
      type: "automation-draft",
      description: "Review a bounded light change.",
      rollback: "Restore the previous state.",
    },
    artifactCandidate: mutableCandidate,
  });

  assert.equal(proposal.artifactCandidate?.content.actions[0]?.kind, "set_boolean");
  assert.equal(
    proposal.artifactCandidate?.content.actions[0]?.kind === "set_boolean"
      ? proposal.artifactCandidate.content.actions[0].target.hwCapabilityId
      : undefined,
    "hwc-1",
  );
  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("retains current evidence for an exact candidate capability beyond the general reference cap", async () => {
  const ctx = new Context();
  await ctx.plugin(StubHomeWorld);
  const world = ctx.homeWorld as unknown as StubHomeWorld;
  world.extraCapabilities = 50;
  const fiber = await ctx.plugin(HomeProposalService, { path: ":memory:" });
  const target = { hwCapabilityId: "hwc-51" };
  const proposal = await ctx.homeProposals.createDraft({
    kind: "automation-draft",
    title: "Review one late catalog capability",
    summary: "The reviewed target must remain in bounded current evidence.",
    idempotencyKey: "candidate-evidence-priority:v1",
    provenance: { producer: "dsh-home-agent" },
    selectedHwIds: ["hw-1"],
    rationale,
    risk: { level: "low", reasons: [] },
    intent: {
      type: "automation-draft",
      description: "Review a bounded light change.",
      rollback: "Restore the previous state.",
    },
    artifactCandidate: {
      schemaVersion: "1",
      content: {
        trigger: { kind: "capability_changed", source: target },
        conditions: [],
        actions: [{ kind: "set_boolean", target, value: false }],
        rollback: { kind: "restore_previous_state", target, maxAgeSeconds: 3_600 },
        postconditions: [{
          kind: "capability_value",
          source: target,
          operator: "equals",
          value: false,
          withinSeconds: 30,
        }],
      },
    },
  });

  assert.equal(proposal.evidence.references.length, 50);
  assert.equal(proposal.evidence.references.some((reference) => reference.capabilityId === "hwc-51"), true);
  await fiber.dispose();
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
    rationale,
    selectedHwCapabilityIds: ["hwc-1"],
    evidenceLookbackHours: 24,
    artifactCandidate: automationCandidate,
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
  assert.deepEqual(proposal.rationale, rationale);
  assert.deepEqual(proposal.spaceCoverage, {
    selectedDevices: 1,
    devicesWithSingleSpace: 0,
    devicesWithoutSpace: 1,
    devicesWithMultipleSpaces: 0,
  });
  assert.equal(proposal.applicationStatus, "not_available");

  const secondProposal = await ctx.homeProposals.createDraft({
    kind: "household-insight",
    title: "Another pending item",
    summary: "This joins the bounded household review queue.",
    idempotencyKey: "another-item:v1",
    provenance: { producer: "dsh-home-agent" },
    selectedHwIds: ["hw-1"],
    rationale,
    risk: { level: "low", reasons: [] },
    intent: { type: "household-insight", description: "Wait.", rollback: "Discard it." },
  });
  assert.equal(secondProposal.status, "pending_review");
  ctx.homeProposals.review({
    proposalId: proposal.id,
    expectedRevision: 1,
    decision: "rejected",
    reviewer: "household-owner",
    feedbackCode: "incorrect_assumption",
  });
  ctx.homeProposals.review({
    proposalId: secondProposal.id,
    expectedRevision: 1,
    decision: "rejected",
    reviewer: "household-owner",
    feedbackCode: "not_useful",
  });

  const currentStateProposal = await ctx.homeProposals.createDraft({
    kind: "household-insight",
    title: "Review current light state",
    summary: "A current-state-only observation for review.",
    idempotencyKey: "current-light:v1",
    provenance: { producer: "dsh-home-agent", sessionId: "home-main", toolCallId: "call-2" },
    selectedHwIds: ["hw-1"],
    rationale,
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

test("keeps five unresolved household proposals and rejects the sixth", async () => {
  const ctx = new Context();
  await ctx.plugin(StubHomeWorld);
  const fiber = await ctx.plugin(HomeProposalService, { path: ":memory:" });

  for (let index = 1; index <= 5; index += 1) {
    const proposal = await ctx.homeProposals.createDraft({
      kind: "household-insight",
      title: `Household suggestion ${index}`,
      summary: `Bounded suggestion ${index} for household review.`,
      idempotencyKey: `capacity:${index}:v1`,
      provenance: { producer: "dsh-home-agent" },
      selectedHwIds: ["hw-1"],
      rationale,
      risk: { level: "low", reasons: [] },
      intent: {
        type: "household-insight",
        description: `Review suggestion ${index}.`,
        rollback: "Close the suggestion.",
      },
    });
    assert.equal(proposal.status, "pending_review");
  }

  assert.equal(ctx.homeProposals.list({ status: "pending_review" }).length, 5);
  await assert.rejects(() => ctx.homeProposals.createDraft({
    kind: "household-insight",
    title: "Household suggestion 6",
    summary: "This candidate waits for review capacity.",
    idempotencyKey: "capacity:6:v1",
    provenance: { producer: "dsh-home-agent" },
    selectedHwIds: ["hw-1"],
    rationale,
    risk: { level: "low", reasons: [] },
    intent: {
      type: "household-insight",
      description: "Wait for a review slot.",
      rollback: "Keep the suggestion available for a later explicit retry.",
    },
  }), (error: unknown) => error instanceof ProposalStoreError && error.code === "capacity_full");
  assert.equal(ctx.homeProposals.proposalCapacity().used, 5);
  assert.equal(ctx.homeProposals.list({ status: "pending_review" }).some((proposal) => proposal.dedupKey === "capacity:6:v1"), false);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("forwards stable behavior identity through draft creation and exposes governed snooze and decision commands", async () => {
  const ctx = new Context();
  await ctx.plugin(StubHomeWorld);
  const fiber = await ctx.plugin(HomeProposalService, {
    path: ":memory:",
    now: () => "2026-08-19T01:00:00.000Z",
  });
  try {
    const first = await ctx.homeProposals.createDraft({
      kind: "household-insight",
      title: "Stable behavior identity",
      summary: "Keep equivalent observations on one review card.",
      dedupKey: "home:stable-behavior",
      idempotencyKey: "home:stable-behavior:attempt-1",
      provenance: { producer: "dsh-home-agent" },
      selectedHwIds: ["hw-1"],
      rationale,
      risk: { level: "low", reasons: [] },
      intent: { type: "household-insight", description: "Review it.", rollback: "Reject it." },
    });
    const merged = await ctx.homeProposals.createDraft({
      kind: "household-insight",
      title: "A second phrasing",
      summary: "The behavior identity remains stable.",
      dedupKey: "home:stable-behavior",
      idempotencyKey: "home:stable-behavior:attempt-2",
      provenance: { producer: "dsh-home-agent" },
      selectedHwIds: ["hw-1"],
      rationale,
      risk: { level: "low", reasons: [] },
      intent: { type: "household-insight", description: "Review it.", rollback: "Reject it." },
    });
    assert.equal(first.dedupKey, "home:stable-behavior");
    assert.equal(merged.id, first.id);

    const snoozed = ctx.homeProposals.snoozeProposal({
      proposalId: first.id,
      expectedRevision: merged.revision,
      until: "tomorrow",
    });
    assert.equal(snoozed.snoozeCount, 1);
    const rejected = ctx.homeProposals.decideProposal({
      proposalId: snoozed.id,
      expectedRevision: snoozed.revision,
      decision: "reject_once",
      reviewer: "household-owner",
    });
    assert.equal(rejected.decision?.kind, "reject_once");
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("rejects temporal capability selections outside the selected devices", async () => {
  const ctx = new Context();
  await ctx.plugin(StubHomeWorld);
  const fiber = await ctx.plugin(HomeProposalService, { path: ":memory:" });

  await assert.rejects(() => ctx.homeProposals.createDraft({
    kind: "household-insight",
    title: "Missing product case",
    summary: "A model summary cannot replace a household rationale.",
    idempotencyKey: "missing-rationale:v1",
    provenance: { producer: "dsh-home-agent" },
    selectedHwIds: ["hw-1"],
    risk: { level: "low", reasons: [] },
    intent: { type: "household-insight", description: "Review it.", rollback: "Reject it." },
  }), /rationale/i);

  await assert.rejects(() => ctx.homeProposals.createDraft({
    kind: "household-insight",
    title: "Review evidence",
    summary: "Review a bounded observation.",
    idempotencyKey: "review-evidence:v1",
    provenance: { producer: "dsh-home-agent" },
    selectedHwIds: ["hw-missing"],
    rationale,
    selectedHwCapabilityIds: ["hwc-1"],
    evidenceLookbackHours: 24,
    risk: { level: "low", reasons: [] },
    intent: { type: "household-insight", description: "Review it.", rollback: "Reject it." },
  }), /selected devices/);
  assert.deepEqual(ctx.homeWorld.evidenceQueries, []);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("uses an injected proposal store for existing reads and review without closing the borrowed store", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-proposal-borrowed-"));
  const store = new SqliteProposalStore({ path: join(directory, "proposals.sqlite") });
  const ctx = new Context();
  let fiber: Awaited<ReturnType<typeof ctx.plugin>> | undefined;
  try {
    const created = store.create(candidate);
    fiber = await ctx.plugin(HomeProposalService, { store } as never);

    for (const forbidden of ["listPreparationJobs", "claimPreparationJob", "retryPreparationJob"]) {
      assert.equal(forbidden in ctx.homeProposals, false, forbidden);
    }
    assert.equal(ctx.homeProposals.get(created.id)?.id, created.id);
    assert.deepEqual(ctx.homeProposals.list(), [created]);
    assert.equal(ctx.homeProposals.review({
      proposalId: created.id,
      expectedRevision: created.revision,
      decision: "rejected",
      reviewer: "household-owner",
      feedbackCode: "already_covered",
    }).status, "rejected");

    await fiber.dispose();
    fiber = undefined;
    assert.equal(store.get(created.id)?.status, "rejected");
    assert.equal(store.list()[0]?.id, created.id);
  } finally {
    await fiber?.dispose();
    await ctx.fiber.dispose();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wakes exactly once with the committed queued job after approving a qualifying automation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-proposal-wake-"));
  const path = join(directory, "proposals.sqlite");
  const store = new SqliteProposalStore({ path, now: () => "2026-08-19T01:00:00.000Z" });
  const observer = new SqliteProposalStore({ path, now: () => "2026-08-19T01:00:00.000Z" });
  const ctx = new Context();
  let fiber: Awaited<ReturnType<typeof ctx.plugin>> | undefined;
  const callbackJobs: ArtifactPreparationJob[] = [];
  const callbackVisibleJobs: (ArtifactPreparationJob | undefined)[] = [];
  try {
    const proposal = store.create({
      ...candidate,
      kind: "automation-draft",
      idempotencyKey: "service-wake:approved:v1",
      intent: { ...candidate.intent, type: "automation-draft" },
      artifactCandidate: automationCandidate,
    });
    fiber = await ctx.plugin(HomeProposalService, {
      store,
      onPreparationQueued: (job: ArtifactPreparationJob) => {
        callbackJobs.push(job);
        callbackVisibleJobs.push(observer.getPreparationJob(job.jobId));
      },
    } as never);

    const approved = ctx.homeProposals.review({
      proposalId: proposal.id,
      expectedRevision: proposal.revision,
      decision: "approved",
      reviewer: "household-owner",
      feedbackCode: "useful_as_is",
    });
    const queued = observer.listPreparationJobs()[0];

    assert.equal(approved.status, "approved");
    assert.equal(callbackJobs.length, 1);
    assert.equal(queued?.proposalId, approved.id);
    assert.equal(queued?.proposalRevision, approved.revision);
    assert.deepEqual(callbackJobs, [queued]);
    assert.deepEqual(callbackVisibleJobs, [queued]);
  } finally {
    await fiber?.dispose();
    await ctx.fiber.dispose();
    observer.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not wake for rejected, expired, or non-automation reviews", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-proposal-no-wake-"));
  const path = join(directory, "proposals.sqlite");
  const store = new SqliteProposalStore({ path, now: () => "2026-08-19T01:00:00.000Z" });
  const ctx = new Context();
  let fiber: Awaited<ReturnType<typeof ctx.plugin>> | undefined;
  const callbackJobs: ArtifactPreparationJob[] = [];
  try {
    fiber = await ctx.plugin(HomeProposalService, {
      store,
      onPreparationQueued: (job: ArtifactPreparationJob) => callbackJobs.push(job),
    } as never);
    const rejected = store.create({
      ...candidate,
      kind: "automation-draft",
      idempotencyKey: "service-wake:rejected:v1",
      intent: { ...candidate.intent, type: "automation-draft" },
      artifactCandidate: automationCandidate,
    });
    const expired = store.create({
      ...candidate,
      kind: "automation-draft",
      idempotencyKey: "service-wake:expired:v1",
      intent: { ...candidate.intent, type: "automation-draft" },
      artifactCandidate: automationCandidate,
    });
    const insight = store.create({
      ...candidate,
      idempotencyKey: "service-wake:insight:v1",
    });

    ctx.homeProposals.review({
      proposalId: rejected.id,
      expectedRevision: rejected.revision,
      decision: "rejected",
      reviewer: "household-owner",
      feedbackCode: "not_useful",
    });
    ctx.homeProposals.review({
      proposalId: expired.id,
      expectedRevision: expired.revision,
      decision: "expired",
      reviewer: "household-owner",
    });
    ctx.homeProposals.review({
      proposalId: insight.id,
      expectedRevision: insight.revision,
      decision: "approved",
      reviewer: "household-owner",
      feedbackCode: "useful_as_is",
    });

    assert.deepEqual(callbackJobs, []);
  } finally {
    await fiber?.dispose();
    await ctx.fiber.dispose();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not report a wake-hook failure after the approval and queued job commit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-proposal-wake-error-"));
  const path = join(directory, "proposals.sqlite");
  const store = new SqliteProposalStore({ path, now: () => "2026-08-19T01:00:00.000Z" });
  const observer = new SqliteProposalStore({ path, now: () => "2026-08-19T01:00:00.000Z" });
  const ctx = new Context();
  let fiber: Awaited<ReturnType<typeof ctx.plugin>> | undefined;
  let calls = 0;
  try {
    const proposal = store.create({
      ...candidate,
      kind: "automation-draft",
      idempotencyKey: "service-wake:error:v1",
      intent: { ...candidate.intent, type: "automation-draft" },
      artifactCandidate: automationCandidate,
    });
    fiber = await ctx.plugin(HomeProposalService, {
      store,
      onPreparationQueued: () => {
        calls += 1;
        throw new Error("worker wake failed");
      },
    } as never);

    let approved;
    assert.doesNotThrow(() => {
      approved = ctx.homeProposals.review({
        proposalId: proposal.id,
        expectedRevision: proposal.revision,
        decision: "approved",
        reviewer: "household-owner",
        feedbackCode: "useful_as_is",
      });
    });
    assert.equal(approved?.status, "approved");
    assert.equal(calls, 1);
    assert.equal(observer.get(proposal.id)?.status, "approved");
    assert.equal(observer.listPreparationJobs().length, 1);
  } finally {
    await fiber?.dispose();
    await ctx.fiber.dispose();
    observer.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("projects one exact preparation revision as closed deeply frozen metadata without queue writers", async () => {
  const store = new SqliteProposalStore({
    path: ":memory:",
    now: () => "2026-08-19T01:00:00.000Z",
  });
  const ctx = new Context();
  let fiber: Awaited<ReturnType<typeof ctx.plugin>> | undefined;
  try {
    const proposal = store.create({
      ...candidate,
      kind: "automation-draft",
      idempotencyKey: "service-projection:exact:v1",
      intent: { ...candidate.intent, type: "automation-draft" },
      artifactCandidate: automationCandidate,
    });
    const approved = store.review({
      proposalId: proposal.id,
      expectedRevision: proposal.revision,
      decision: "approved",
      reviewer: "household-owner",
      feedbackCode: "useful_as_is",
    });
    const queued = store.listPreparationJobs()[0];
    assert.ok(queued);

    fiber = await ctx.plugin(HomeProposalService, { store } as never);
    const service = ctx.homeProposals as unknown as {
      preparationForProposal: (proposalId: string, proposalRevision: number) => {
        readonly proposalId: string;
        readonly proposalRevision: number;
        readonly status: string;
        readonly attempt: number;
        readonly version: number;
        readonly stage?: string;
        readonly error?: { readonly stage: string; readonly code: string };
        readonly createdAt: string;
        readonly updatedAt: string;
      } | undefined;
    };

    const initial = service.preparationForProposal(approved.id, approved.revision);
    assert.deepEqual(initial, {
      proposalId: approved.id,
      proposalRevision: approved.revision,
      status: "queued",
      attempt: 1,
      version: queued.version,
      createdAt: queued.createdAt,
      updatedAt: queued.updatedAt,
    });
    assert.equal(Object.isFrozen(initial), true);

    const running = store.claimPreparationJob({
      jobId: queued.jobId,
      expectedVersion: queued.version,
    });
    const failed = store.failPreparationJob({
      jobId: running.jobId,
      expectedVersion: running.version,
      stage: "compile",
      code: "unavailable",
    });
    const failure = service.preparationForProposal(approved.id, approved.revision);
    assert.deepEqual(failure, {
      proposalId: approved.id,
      proposalRevision: approved.revision,
      status: "failed",
      attempt: failed.attempt,
      version: failed.version,
      stage: "compile",
      error: { stage: "compile", code: "unavailable" },
      createdAt: failed.createdAt,
      updatedAt: failed.updatedAt,
    });
    assert.equal(Object.isFrozen(failure), true);
    assert.equal(Object.isFrozen(failure?.error), true);
    assert.throws(() => {
      (failure as unknown as { status: string }).status = "queued";
    }, TypeError);
    assert.throws(() => {
      (failure?.error as unknown as { code: string }).code = "policy_blocked";
    }, TypeError);
    assert.equal(service.preparationForProposal(approved.id, approved.revision - 1), undefined);
    assert.equal(service.preparationForProposal("missing-proposal", approved.revision), undefined);

    for (const forbidden of [
      "listPreparationJobs",
      "getPreparationJob",
      "claimPreparationJob",
      "completePreparationJob",
      "failPreparationJob",
      "retryPreparationJob",
    ]) {
      assert.equal(forbidden in ctx.homeProposals, false, forbidden);
    }
  } finally {
    await fiber?.dispose();
    await ctx.fiber.dispose();
    store.close();
  }
});
