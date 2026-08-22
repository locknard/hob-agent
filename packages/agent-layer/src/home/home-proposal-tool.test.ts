import assert from "node:assert/strict";
import test from "node:test";

import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import { apply } from "./home-proposal-tool.js";

const VALID_ARTIFACT_CANDIDATE = {
  schemaVersion: "1",
  content: {
    trigger: {
    kind: "schedule",
    timezone: "Etc/UTC",
    daysOfWeek: [1],
    at: "08:00",
  },
  conditions: [{
    kind: "capability_value",
    source: { hwCapabilityId: "hwc-1" },
    operator: "equals",
    value: true,
  }],
  actions: [{
    kind: "set_level",
    target: { hwCapabilityId: "hwc-1" },
    value: 0.5,
    transitionSeconds: 60,
  }],
  rollback: {
    kind: "restore_previous_state",
    target: { hwCapabilityId: "hwc-1" },
    maxAgeSeconds: 300,
  },
    postconditions: [{
    kind: "capability_value",
    source: { hwCapabilityId: "hwc-1" },
    operator: "greater_than",
    value: 0.4,
    withinSeconds: 60,
    }],
  },
} as const;

function automationArguments(artifactCandidate?: unknown): Record<string, unknown> {
  return {
    kind: "automation-draft",
    title: "Review arrival lighting",
    summary: "A possible rule based on observed state.",
    householdValue: "Reduce unnecessary lighting without changing arrival comfort.",
    whyNow: "A repeated post-baseline pattern is available for review.",
    uncertainties: ["Whether late arrivals intentionally keep this light on."],
    dedupKey: "home:arrival-light",
    idempotencyKey: "arrival-light:v1",
    selectedHwIds: ["hw-1"],
    selectedHwCapabilityIds: ["hwc-1"],
    evidenceLookbackHours: 24,
    riskLevel: "medium",
    riskReasons: ["Could overlap an existing rule"],
    intentDescription: "Prepare a draft automation for review.",
    rollback: "Discard the draft.",
    ...(artifactCandidate === undefined ? {} : { artifactCandidate }),
  };
}

test("registers a review-only proposal tool and injects trusted DSH provenance", async () => {
  let registered: ToolDefinition | undefined;
  let draft: Record<string, unknown> | undefined;
  const ctx = {
    get() { return undefined; },
    homeProposals: {
      async createDraft(input: Record<string, unknown>) {
        draft = input;
        return {
          id: "proposal-1",
          revision: 1,
          status: "pending_review",
          applicationStatus: "not_available",
          conflictCheck: { existingAutomationCount: 15, matches: [{ identity: "rule-1" }] },
          spaceCoverage: {
            selectedDevices: 1,
            devicesWithSingleSpace: 0,
            devicesWithoutSpace: 1,
            devicesWithMultipleSpaces: 0,
          },
          evidence: {
            references: [{ source: "post-baseline-event" }],
            temporal: { coverage: [{ status: "partial" }], truncated: false },
          },
        };
      },
    },
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => undefined;
      },
    },
  } as unknown as Context;

  apply(ctx);
  assert.equal(registered?.name, "create_home_proposal");
  assert.match(registered?.description ?? "", /review-only/i);
  assert.match(registered?.description ?? "", /candidate.*compile|compile.*candidate/i);
  const value = await registered!.execute({
    kind: "automation-draft",
    title: "Review arrival lighting",
    summary: "A possible rule based on observed state.",
    householdValue: "Reduce unnecessary lighting without changing arrival comfort.",
    whyNow: "A repeated post-baseline pattern is available for review.",
    uncertainties: ["Whether late arrivals intentionally keep this light on."],
    dedupKey: "home:arrival-light",
    idempotencyKey: "arrival-light:v1",
    selectedHwIds: ["hw-1"],
    selectedHwCapabilityIds: ["hwc-1"],
    evidenceLookbackHours: 24,
    riskLevel: "medium",
    riskReasons: ["Could overlap an existing rule"],
    intentDescription: "Prepare a draft automation for review.",
    rollback: "Discard the draft.",
    artifactCandidate: VALID_ARTIFACT_CANDIDATE,
  }, {
    agent: { id: "home-main" },
    rootCallId: "call-7",
  } as never);

  assert.deepEqual((draft?.provenance), {
    producer: "dsh-home-agent",
    sessionId: "home-main",
    toolCallId: "call-7",
  });
  assert.equal("conflictCheck" in (draft ?? {}), false);
  assert.deepEqual(draft?.rationale, {
    householdValue: "Reduce unnecessary lighting without changing arrival comfort.",
    whyNow: "A repeated post-baseline pattern is available for review.",
    uncertainties: ["Whether late arrivals intentionally keep this light on."],
  });
  assert.equal(draft?.dedupKey, "home:arrival-light");
  assert.deepEqual(draft?.selectedHwCapabilityIds, ["hwc-1"]);
  assert.equal(draft?.evidenceLookbackHours, 24);
  assert.deepEqual(draft?.artifactCandidate, VALID_ARTIFACT_CANDIDATE);
  assert.deepEqual(value, {
    proposalId: "proposal-1",
    status: "pending_review",
    revision: 1,
    applicationStatus: "not_available",
    conflictSummary: { existingAutomationCount: 15, matchCount: 1 },
    spaceCoverage: {
      selectedDevices: 1,
      devicesWithSingleSpace: 0,
      devicesWithoutSpace: 1,
      devicesWithMultipleSpaces: 0,
    },
    evidenceSummary: { referenceCount: 1, coverageStatus: "partial", truncated: false },
  });
  assert.equal("artifactCandidate" in value, false);
});

test("rejects every unknown nested artifact candidate field before calling Hub", async () => {
  let registered: ToolDefinition | undefined;
  let drafts = 0;
  const ctx = {
    get() { return undefined; },
    homeProposals: { async createDraft() { drafts += 1; throw new Error("must not run"); } },
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => undefined;
      },
    },
  } as unknown as Context;
  apply(ctx);

  const invalidCandidates = [
    { ...VALID_ARTIFACT_CANDIDATE, vendorField: "forbidden" },
    { ...VALID_ARTIFACT_CANDIDATE, content: { ...VALID_ARTIFACT_CANDIDATE.content, vendorField: "forbidden" } },
    { ...VALID_ARTIFACT_CANDIDATE, content: { ...VALID_ARTIFACT_CANDIDATE.content, trigger: { ...VALID_ARTIFACT_CANDIDATE.content.trigger, cron: "* * * * *" } } },
    {
      ...VALID_ARTIFACT_CANDIDATE,
      content: { ...VALID_ARTIFACT_CANDIDATE.content, conditions: [{ ...VALID_ARTIFACT_CANDIDATE.content.conditions[0], rawPath: "attrs.state" }] },
    },
    {
      ...VALID_ARTIFACT_CANDIDATE,
      content: { ...VALID_ARTIFACT_CANDIDATE.content, actions: [{ ...VALID_ARTIFACT_CANDIDATE.content.actions[0], service: "light.turn_on" }] },
    },
    {
      ...VALID_ARTIFACT_CANDIDATE,
      content: { ...VALID_ARTIFACT_CANDIDATE.content, rollback: { ...VALID_ARTIFACT_CANDIDATE.content.rollback, bridgeId: "bridge-a" } },
    },
    {
      ...VALID_ARTIFACT_CANDIDATE,
      content: { ...VALID_ARTIFACT_CANDIDATE.content, postconditions: [{ ...VALID_ARTIFACT_CANDIDATE.content.postconditions[0], nativeId: "light.native" }] },
    },
  ];

  for (const [index, artifactCandidate] of invalidCandidates.entries()) {
    await assert.rejects(
      () => registered!.execute(automationArguments(artifactCandidate), { rootCallId: `call-invalid-${index}` } as never),
      /additionalProperties|not a declared property|oneOf branch/i,
    );
  }
  assert.equal(drafts, 0);
});

test("requires a candidate for automation drafts and rejects it for household insights", async () => {
  let registered: ToolDefinition | undefined;
  let drafts = 0;
  const ctx = {
    get() { return undefined; },
    homeProposals: {
      async createDraft() {
        drafts += 1;
        return {
          id: "proposal-1",
          revision: 1,
          status: "pending_review",
          applicationStatus: "not_available",
          conflictCheck: { existingAutomationCount: 0, matches: [] },
          spaceCoverage: { selectedDevices: 1, devicesWithSingleSpace: 1, devicesWithoutSpace: 0, devicesWithMultipleSpaces: 0 },
          evidence: { references: [] },
        };
      },
    },
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => undefined;
      },
    },
  } as unknown as Context;
  apply(ctx);

  await assert.rejects(
    () => registered!.execute(automationArguments(undefined), { rootCallId: "call-missing-candidate" } as never),
    /artifactCandidate.*required/i,
  );
  await assert.rejects(
    () => registered!.execute({
      ...automationArguments(VALID_ARTIFACT_CANDIDATE),
      kind: "household-insight",
      artifactCandidate: VALID_ARTIFACT_CANDIDATE,
    }, { rootCallId: "call-insight-candidate" } as never),
    /artifactCandidate.*automation-draft/i,
  );
  assert.equal(drafts, 0);
});

test("rejects an autonomous proposal while inventory coverage is incomplete", async () => {
  let registered: ToolDefinition | undefined;
  let drafts = 0;
  const ctx = {
    get(name: string) {
      return name === "homeInventoryCoverage"
        ? { assertProposalAllowed() { throw new Error("inventory incomplete"); } }
        : undefined;
    },
    homeProposals: { async createDraft() { drafts += 1; throw new Error("must not run"); } },
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => undefined;
      },
    },
  } as unknown as Context;
  apply(ctx);
  await assert.rejects(() => registered!.execute({
    kind: "household-insight",
    title: "Incomplete scan",
    summary: "Must not become a proposal.",
    householdValue: "No value can be established from an incomplete scan.",
    whyNow: "The inventory scan is incomplete.",
    uncertainties: ["The rest of the household inventory is unknown."],
    dedupKey: "home:incomplete-scan",
    idempotencyKey: "incomplete-scan:v1",
    selectedHwIds: ["hw-1"],
    riskLevel: "low",
    riskReasons: [],
    intentDescription: "Do not create.",
    rollback: "No change.",
  }, { rootCallId: "call-incomplete" } as never), /inventory incomplete/);
  assert.equal(drafts, 0);
});

test("rejects an autonomous proposal while existing-rule coverage is incomplete", async () => {
  let registered: ToolDefinition | undefined;
  let drafts = 0;
  const ctx = {
    get(name: string) {
      return name === "homeRulesCoverage"
        ? { assertProposalAllowed() { throw new Error("rule catalog incomplete"); } }
        : undefined;
    },
    homeProposals: { async createDraft() { drafts += 1; throw new Error("must not run"); } },
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => undefined;
      },
    },
  } as unknown as Context;
  apply(ctx);
  await assert.rejects(() => registered!.execute({
    kind: "automation-draft",
    title: "Unchecked rule overlap",
    summary: "Must not become a proposal.",
    householdValue: "Avoid duplicating existing household behavior.",
    whyNow: "The existing-rule scan is incomplete.",
    uncertainties: ["Unread rules may already implement this behavior."],
    dedupKey: "home:unchecked-rule-overlap",
    idempotencyKey: "unchecked-rules:v1",
    selectedHwIds: ["hw-1"],
    riskLevel: "low",
    riskReasons: [],
    intentDescription: "Do not create.",
    rollback: "No change.",
    artifactCandidate: VALID_ARTIFACT_CANDIDATE,
  }, { rootCallId: "call-unchecked-rules" } as never), /rule catalog incomplete/);
  assert.equal(drafts, 0);
});

test("rejects an autonomous proposal before household calibration is read", async () => {
  let registered: ToolDefinition | undefined;
  let drafts = 0;
  const ctx = {
    get(name: string) {
      return name === "homeCalibrationCoverage"
        ? { assertProposalAllowed() { throw new Error("calibration unread"); } }
        : undefined;
    },
    homeProposals: { async createDraft() { drafts += 1; throw new Error("must not run"); } },
    tools: { register(definition: ToolDefinition) { registered = definition; return () => undefined; } },
  } as unknown as Context;
  apply(ctx);
  await assert.rejects(() => registered!.execute({
    kind: "household-insight",
    title: "Uncalibrated suggestion",
    summary: "Must not become a proposal.",
    householdValue: "Respect prior household review.",
    whyNow: "Calibration was not read.",
    uncertainties: ["Prior review outcomes are unknown."],
    dedupKey: "home:uncalibrated-suggestion",
    idempotencyKey: "uncalibrated:v1",
    selectedHwIds: ["hw-1"],
    riskLevel: "low",
    riskReasons: [],
    intentDescription: "Do not create.",
    rollback: "No change.",
  }, { rootCallId: "call-uncalibrated" } as never), /calibration unread/);
  assert.equal(drafts, 0);
});
