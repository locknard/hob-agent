import assert from "node:assert/strict";
import test from "node:test";

import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import { apply } from "./dsh-home-proposal-tool.js";

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
  const value = await registered!.execute({
    kind: "automation-draft",
    title: "Review arrival lighting",
    summary: "A possible rule based on observed state.",
    idempotencyKey: "arrival-light:v1",
    selectedHwIds: ["hw-1"],
    selectedHwCapabilityIds: ["hwc-1"],
    evidenceLookbackHours: 24,
    riskLevel: "medium",
    riskReasons: ["Could overlap an existing rule"],
    intentDescription: "Prepare a draft automation for review.",
    rollback: "Discard the draft.",
  }, {
    agent: { id: "home-main" },
    rootCallId: "call-7",
  } as never);

  assert.deepEqual((draft?.provenance), {
    producer: "dsh-home-agent",
    sessionId: "home-main",
    turnId: "call-7",
  });
  assert.equal("conflictCheck" in (draft ?? {}), false);
  assert.deepEqual(draft?.selectedHwCapabilityIds, ["hwc-1"]);
  assert.equal(draft?.evidenceLookbackHours, 24);
  assert.deepEqual(value, {
    proposalId: "proposal-1",
    status: "pending_review",
    revision: 1,
    applicationStatus: "not_available",
    conflictSummary: { existingAutomationCount: 15, matchCount: 1 },
    evidenceSummary: { referenceCount: 1, coverageStatus: "partial", truncated: false },
  });
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
    idempotencyKey: "incomplete-scan:v1",
    selectedHwIds: ["hw-1"],
    riskLevel: "low",
    riskReasons: [],
    intentDescription: "Do not create.",
    rollback: "No change.",
  }, { rootCallId: "call-incomplete" } as never), /inventory incomplete/);
  assert.equal(drafts, 0);
});
