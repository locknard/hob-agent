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


function completePreparation(store: SqliteProposalStore, proposalId: string): void {
  const job = store.listPreparationJobs().find((candidate) =>
    candidate.proposalId === proposalId && candidate.status === "queued");
  if (job === undefined) return;
  const claimed = store.claimPreparationJob({ jobId: job.jobId, expectedVersion: job.version });
  store.completePreparationJob({
    jobId: claimed.jobId,
    expectedVersion: claimed.version,
    preparedArtifact: {
      artifactId: `artifact-${proposalId}`,
      revision: 1,
      contentHash: "sha256:prepared-content",
      compileResultId: "sha256:compile-result",
      dryRunResultId: "sha256:dry-run-result",
    },
  });
}

function prepareToReady(store: SqliteProposalStore, proposalId: string) {
  completePreparation(store, proposalId);
  return store.markProposalReady({ proposalId });
}

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
  capabilitySemanticKind: "light" | "lock" | undefined = "light";
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
          ...(this.capabilitySemanticKind === undefined ? {} : { semanticKind: this.capabilitySemanticKind }),
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

  const proposal = ctx.homeProposals.markProposalReady({ proposalId: (await ctx.homeProposals.createDraft(draft)).id });
  assert.equal(proposal.conflictCheck.status, "checked");
  assert.equal(proposal.conflictCheck.existingAutomationCount, 1);
  ctx.homeProposals.review({
    proposalId: proposal.id,
    expectedRevision: proposal.revision,
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

  const created = ctx.homeProposals.markProposalReady({ proposalId: ctx.homeProposals.create(candidate).id });
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
  assert.throws(() => ctx.homeProposals.list());
  await ctx.fiber.dispose();
});

test("exposes the synchronous approved source gate without accepting caller evidence", async () => {
  const ctx = new Context();
  const store = new SqliteProposalStore({ path: ":memory:", now: () => "2026-08-19T01:00:00.000Z" });
  const fiber = await ctx.plugin(HomeProposalService, { store } as never);
  const createdCreated = ctx.homeProposals.create({
    ...candidate,
    kind: "automation-draft",
    intent: { ...candidate.intent, type: "automation-draft" },
    idempotencyKey: "source-gate:automation:v1",
    artifactCandidate: automationCandidate,
  });
  completePreparation(store, createdCreated.id);
  const created = ctx.homeProposals.markProposalReady({ proposalId: createdCreated.id });
  const source = ctx.homeProposals.withApprovedProposalAtRevision(
    created.id,
    created.revision,
    (value) => value,
  );
  assert.equal(source.proposalId, created.id);
  assert.equal(source.revision, created.revision);
  assert.deepEqual(source.evidence, created.evidence);
  assert.equal(Object.isFrozen(source), true);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("requires a Hub-verifiable artifact candidate for new automation drafts", async () => {
  const ctx = new Context();
  await ctx.plugin(StubHomeWorld);
  const store = new SqliteProposalStore({ path: ":memory:" });
  const fiber = await ctx.plugin(HomeProposalService, { store } as never);
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
  const proposalCreated = await ctx.homeProposals.createDraft({ ...base, artifactCandidate: automationCandidate });
  completePreparation(store, proposalCreated.id);
  const proposal = ctx.homeProposals.markProposalReady({ proposalId: proposalCreated.id });
  assert.deepEqual(proposal.artifactCandidate, automationCandidate);
  ctx.homeProposals.review({
    proposalId: proposal.id,
    expectedRevision: proposal.revision,
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

  world.actionPolicyClass = "confirmation";
  world.capabilitySemanticKind = undefined;
  await assert.rejects(
    () => ctx.homeProposals.createDraft({ ...base, dedupKey: "policy:unnamed", idempotencyKey: "policy:unnamed:v1" }),
    /household-readable device name/,
    "a confirmation action nobody can name never enters review",
  );

  world.capabilitySemanticKind = "light";
  const disclosed = await ctx.homeProposals.createDraft({ ...base, dedupKey: "policy:labeled", idempotencyKey: "policy:labeled:v1" });
  assert.deepEqual(disclosed.confirmationDeviceNames, ["灯"], "an unnamed device falls back to its stable household label");

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
  const store = new SqliteProposalStore({
    path: ":memory:",
    now: () => "2026-08-19T01:00:00.000Z",
    id: (() => {
      let value = 0;
      return () => String(++value);
    })(),
  });
  const fiber = await ctx.plugin(HomeProposalService, { store } as never);

  const proposalCreated = await ctx.homeProposals.createDraft({
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
  completePreparation(store, proposalCreated.id);
  const proposal = ctx.homeProposals.markProposalReady({ proposalId: proposalCreated.id });

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
    expectedRevision: proposal.revision,
    decision: "rejected",
    reviewer: "household-owner",
    feedbackCode: "incorrect_assumption",
  });
  ctx.homeProposals.review({
    proposalId: secondProposal.id,
    expectedRevision: secondProposal.revision,
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

  for (const candidate of ctx.homeProposals.list({ status: "pending_review" })) {
    if (candidate.lifecycle === "preparing") ctx.homeProposals.markProposalReady({ proposalId: candidate.id });
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

    const prepared = ctx.homeProposals.markProposalReady({ proposalId: first.id, expectedRevision: merged.revision });
    const snoozed = ctx.homeProposals.snoozeProposal({
      proposalId: prepared.id,
      expectedRevision: prepared.revision,
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
    const created = prepareToReady(store, store.create(candidate).id);
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

test("wakes exactly once with the committed queued job when a qualifying automation is admitted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-proposal-wake-"));
  const path = join(directory, "proposals.sqlite");
  const store = new SqliteProposalStore({ path, now: () => "2026-08-19T01:00:00.000Z" });
  const observer = new SqliteProposalStore({ path, now: () => "2026-08-19T01:00:00.000Z" });
  const ctx = new Context();
  let fiber: Awaited<ReturnType<typeof ctx.plugin>> | undefined;
  const callbackJobs: ArtifactPreparationJob[] = [];
  const callbackVisibleJobs: (ArtifactPreparationJob | undefined)[] = [];
  try {
    fiber = await ctx.plugin(HomeProposalService, {
      store,
      onPreparationQueued: (job: ArtifactPreparationJob) => {
        callbackJobs.push(job);
        callbackVisibleJobs.push(observer.getPreparationJob(job.jobId));
      },
    } as never);
    const proposalCreated = ctx.homeProposals.create({
      ...candidate,
      kind: "automation-draft",
      idempotencyKey: "service-wake:approved:v1",
      intent: { ...candidate.intent, type: "automation-draft" },
      artifactCandidate: automationCandidate,
    });
    const queued = observer.listPreparationJobs()[0];

    assert.equal(callbackJobs.length, 1);
    assert.equal(queued?.proposalId, proposalCreated.id);
    assert.equal(queued?.proposalRevision, 1);
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
    const rejectedCreated = store.create({
      ...candidate,
      kind: "automation-draft",
      idempotencyKey: "service-wake:rejected:v1",
      intent: { ...candidate.intent, type: "automation-draft" },
      artifactCandidate: automationCandidate,
    });
    completePreparation(store, rejectedCreated.id);
    const rejected = store.markProposalReady({ proposalId: rejectedCreated.id });
    const expiredCreated = store.create({
      ...candidate,
      kind: "automation-draft",
      idempotencyKey: "service-wake:expired:v1",
      intent: { ...candidate.intent, type: "automation-draft" },
      artifactCandidate: automationCandidate,
    });
    completePreparation(store, expiredCreated.id);
    const expired = store.markProposalReady({ proposalId: expiredCreated.id });
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

test("does not report a wake-hook failure after the proposal and queued job commit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-proposal-wake-error-"));
  const path = join(directory, "proposals.sqlite");
  const store = new SqliteProposalStore({ path, now: () => "2026-08-19T01:00:00.000Z" });
  const observer = new SqliteProposalStore({ path, now: () => "2026-08-19T01:00:00.000Z" });
  const ctx = new Context();
  let fiber: Awaited<ReturnType<typeof ctx.plugin>> | undefined;
  let calls = 0;
  try {
    fiber = await ctx.plugin(HomeProposalService, {
      store,
      onPreparationQueued: () => {
        calls += 1;
        throw new Error("worker wake failed");
      },
    } as never);
    const proposalCreated = ctx.homeProposals.create({
      ...candidate,
      kind: "automation-draft",
      idempotencyKey: "service-wake:error:v1",
      intent: { ...candidate.intent, type: "automation-draft" },
      artifactCandidate: automationCandidate,
    });
    completePreparation(store, proposalCreated.id);
    let proposal;
    assert.doesNotThrow(() => {
      proposal = ctx.homeProposals.markProposalReady({ proposalId: proposalCreated.id });
    });
    assert.equal(proposal.lifecycle, "ready");
    assert.equal(calls, 1);
    assert.equal(observer.get(proposal.id)?.status, "pending_review");
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
    const proposalCreated = store.create({
      ...candidate,
      kind: "automation-draft",
      idempotencyKey: "service-projection:exact:v1",
      intent: { ...candidate.intent, type: "automation-draft" },
      artifactCandidate: automationCandidate,
    });
    const queued = store.listPreparationJobs()[0];
    assert.ok(queued);
    const proposal = proposalCreated;

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

    const initial = service.preparationForProposal(proposal.id, queued.proposalRevision);
    assert.deepEqual(initial, {
      proposalId: proposal.id,
      proposalRevision: queued.proposalRevision,
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
    const failure = service.preparationForProposal(proposal.id, queued.proposalRevision);
    assert.deepEqual(failure, {
      proposalId: proposal.id,
      proposalRevision: queued.proposalRevision,
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
    assert.equal(service.preparationForProposal(proposal.id, queued.proposalRevision + 1), undefined);
    assert.equal(service.preparationForProposal("missing-proposal", queued.proposalRevision), undefined);

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


test("recovers the crash window between external deployment and the local record", async () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => "2026-08-22T01:00:00.000Z" });
  const statuses = new Map<string, "running" | "paused" | "missing" | "unknown">();
  const ctx = new Context();
  let fiber: Awaited<ReturnType<typeof ctx.plugin>> | undefined;
  try {
    fiber = await ctx.plugin(HomeProposalService, {
      store,
      deployment: {
        deploy: async () => ({ status: "verified" as const, deploymentId: "hob_x", target: "ha-main" }),
        status: async (request: { deploymentId: string }) => ({ status: statuses.get(request.deploymentId) ?? "unknown" }),
      },
    } as never);

    const created = store.create({
      ...candidate,
      kind: "automation-draft",
      idempotencyKey: "reconcile:crashed:v1",
      dedupKey: "reconcile:crashed",
      intent: { ...candidate.intent, type: "automation-draft" },
      artifactCandidate: automationCandidate,
    });
    const ready = prepareToReady(store, created.id);
    // The approval persists the deployment intent; the process dies before the
    // external result is recorded.
    const enabling = store.decideProposal({
      proposalId: ready.id,
      expectedRevision: ready.revision,
      decision: "approve",
      reviewer: "household-owner",
      deploymentIntent: { deploymentId: "hob_crashed", target: "ha-main", targets: [{ hwCapabilityId: "hwc-4", binding: { bridgeId: "ha-main", nativeId: "dev-hwc-4", nativeInstanceId: "ent-hwc-4" } }] },
    });
    assert.equal(enabling.lifecycle, "enabling");
    assert.equal(enabling.deployment?.deploymentId, "hob_crashed");
    assert.equal(enabling.deployment?.target, "ha-main");

    statuses.set("hob_crashed", "running");
    await ctx.homeProposals.reconcileAutomations();
    const recovered = store.get(enabling.id);
    assert.equal(recovered?.lifecycle, "active", "a deployed-but-unrecorded enablement heals from bridge truth");
    assert.equal(recovered?.applicationStatus, "running");

    statuses.set("hob_crashed", "paused");
    await ctx.homeProposals.reconcileAutomations();
    assert.equal(store.get(enabling.id)?.lifecycle, "paused", "a natively paused automation is reflected");

    statuses.set("hob_crashed", "missing");
    await ctx.homeProposals.reconcileAutomations();
    assert.equal(store.get(enabling.id)?.lifecycle, "closed", "a natively deleted automation closes locally");
  } finally {
    await fiber?.dispose();
    await ctx.fiber.dispose();
    store.close();
  }
});


test("drift survives persistence and the fingerprint baseline reaches the record", async () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => "2026-08-22T02:00:00.000Z" });
  const statuses = new Map<string, { status: "running" | "paused" | "missing" | "unknown"; configFingerprint?: string }>();
  const ctx = new Context();
  let fiber: Awaited<ReturnType<typeof ctx.plugin>> | undefined;
  try {
    fiber = await ctx.plugin(HomeProposalService, {
      store,
      deployment: {
        resolveIntent: () => ({ deploymentId: "hob_drift", target: "ha-main", targets: [{ hwCapabilityId: "hwc-4", binding: { bridgeId: "ha-main", nativeId: "dev-hwc-4", nativeInstanceId: "ent-hwc-4" } }] }),
        deploy: async () => ({
          status: "verified" as const,
          deploymentId: "hob_drift",
          target: "ha-main",
          configFingerprint: "sha256:approved-behavior",
        }),
        status: async (request: { deploymentId: string }) => statuses.get(request.deploymentId) ?? { status: "unknown" as const },
      },
    } as never);

    const created = ctx.homeProposals.create({
      ...candidate,
      kind: "automation-draft",
      idempotencyKey: "drift:roundtrip:v1",
      dedupKey: "drift:roundtrip",
      intent: { ...candidate.intent, type: "automation-draft" },
      artifactCandidate: automationCandidate,
    });
    completePreparation(store, created.id);
    const ready = ctx.homeProposals.markProposalReady({ proposalId: created.id });
    const active = await ctx.homeProposals.enableProposal({ proposalId: ready.id, reviewer: "household-owner" });
    assert.equal(active.lifecycle, "active");
    assert.equal(active.deployment?.configFingerprint, "sha256:approved-behavior", "the deployed fingerprint is the drift baseline");

    statuses.set("hob_drift", { status: "running", configFingerprint: "sha256:natively-edited" });
    await ctx.homeProposals.reconcileAutomations();
    const drifted = store.get(active.id);
    assert.equal(drifted?.deployment?.drifted, true, "a native edit surfaces as drift");
    assert.equal(drifted?.audit.at(-1)?.action, "drift_detected");
    assert.equal(store.get(active.id)?.deployment?.drifted, true, "the drifted record reads back without corruption");

    statuses.set("hob_drift", { status: "running", configFingerprint: "sha256:approved-behavior" });
    await ctx.homeProposals.reconcileAutomations();
    assert.equal(store.get(active.id)?.deployment?.drifted, false, "restoring the behavior clears the drift");
  } finally {
    await fiber?.dispose();
    await ctx.fiber.dispose();
    store.close();
  }
});

test("a passing outage keeps the plan enableable and recovery enables it", async () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => "2026-08-22T03:00:00.000Z" });
  const ctx = new Context();
  let fiber: Awaited<ReturnType<typeof ctx.plugin>> | undefined;
  let available = false;
  const intent = {
    deploymentId: "hob_recover",
    target: "ha-main",
    targets: [{ hwCapabilityId: "hwc-strip", binding: { bridgeId: "ha-main", nativeId: "dev-hwc-strip", nativeInstanceId: "ent-hwc-strip" } }],
  };
  try {
    fiber = await ctx.plugin(HomeProposalService, {
      store,
      deployment: {
        resolveIntent: () => available
          ? intent
          : { reason: "方案里有设备现在暂时连不上，家里的设置保持原样；稍后再试一次就好。" },
        deploy: async () => ({ status: "verified" as const, deploymentId: "hob_recover", target: "ha-main" }),
      },
    } as never);

    const created = ctx.homeProposals.create({
      ...candidate,
      kind: "automation-draft",
      idempotencyKey: "outage:recover:v1",
      dedupKey: "outage:recover",
      intent: { ...candidate.intent, type: "automation-draft" },
      artifactCandidate: automationCandidate,
    });
    completePreparation(store, created.id);
    const ready = ctx.homeProposals.markProposalReady({ proposalId: created.id });

    await assert.rejects(
      () => ctx.homeProposals.enableProposal({ proposalId: ready.id, reviewer: "household-owner" }),
      (error: unknown) => error instanceof ProposalStoreError && /稍后再试/.test(error.message),
    );
    const afterOutage = store.get(ready.id);
    assert.equal(afterOutage?.lifecycle, "ready", "the outage spends nothing");
    assert.equal(afterOutage?.enableBlockedReason, undefined, "a passing outage never persists a block");
    assert.equal(afterOutage?.revision, ready.revision);

    available = true;
    const enabled = await ctx.homeProposals.enableProposal({ proposalId: ready.id, reviewer: "household-owner" });
    assert.equal(enabled.lifecycle, "active", "the same plan enables once the world recovers");
  } finally {
    await fiber?.dispose();
    await ctx.fiber.dispose();
    store.close();
  }
});

test("a changed world demotes a prepared plan instead of spending the decision", async () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => "2026-08-22T03:00:00.000Z" });
  const ctx = new Context();
  let fiber: Awaited<ReturnType<typeof ctx.plugin>> | undefined;
  try {
    fiber = await ctx.plugin(HomeProposalService, {
      store,
      deployment: {
        resolveIntent: () => ({ revalidationReason: "方案里有设备已改为管理员档，需要重新准备。" }),
        deploy: async () => { throw new Error("deploy must not run under stale consent"); },
      },
    } as never);

    const created = ctx.homeProposals.create({
      ...candidate,
      kind: "automation-draft",
      idempotencyKey: "revalidate:demote:v1",
      dedupKey: "revalidate:demote",
      intent: { ...candidate.intent, type: "automation-draft" },
      artifactCandidate: automationCandidate,
    });
    completePreparation(store, created.id);
    const ready = ctx.homeProposals.markProposalReady({ proposalId: created.id });

    const demoted = await ctx.homeProposals.enableProposal({ proposalId: ready.id, reviewer: "household-owner" });
    assert.equal(demoted.lifecycle, "preparing", "the plan re-verifies before it can be decided");
    assert.equal(demoted.status, "pending_review", "the household decision was not spent");
    assert.equal(demoted.preparedArtifact, undefined, "stale preparation refs are cleared");
    assert.equal(demoted.audit.at(-1)?.action, "revalidation_required");
    assert.equal(store.listPreparationJobs().some((job) =>
      job.proposalId === demoted.id && job.proposalRevision === demoted.revision && job.status === "queued"), true,
      "a fresh preparation is queued for the new revision");
  } finally {
    await fiber?.dispose();
    await ctx.fiber.dispose();
    store.close();
  }
});
