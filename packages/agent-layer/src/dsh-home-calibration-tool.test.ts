import assert from "node:assert/strict";
import test from "node:test";

import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import { apply, projectHomeCalibration } from "./dsh-home-calibration-tool.js";

const SUMMARY = {
  total: 4,
  statuses: { pending_review: 1, approved: 1, rejected: 2, expired: 0 },
  feedback: {
    useful_as_is: 1,
    already_covered: 1,
    not_useful: 0,
    incorrect_assumption: 0,
    insufficient_evidence: 1,
    household_preference: 0,
    too_risky: 0,
    other: 0,
  },
  reviewedWithoutFeedback: 0,
} as const;

test("projects bounded structured household calibration without reviewer identity or notes", () => {
  const value = projectHomeCalibration({
    summary: SUMMARY,
    proposals: [{
      proposalId: "proposal-1",
      kind: "automation-draft",
      title: "Review hallway lighting",
      decision: "rejected",
      reviewedAt: "2026-08-19T03:00:00.000Z",
      feedbackCode: "already_covered",
    }],
  });

  assert.deepEqual(value.recentReviews, [{
    proposalId: "proposal-1",
    kind: "automation-draft",
    title: "Review hallway lighting",
    decision: "rejected",
    reviewedAt: "2026-08-19T03:00:00.000Z",
    feedbackCode: "already_covered",
  }]);
  assert.equal(JSON.stringify(value).includes("private-reviewer"), false);
  assert.equal(JSON.stringify(value).includes("private household detail"), false);
});

test("registers a bounded read-only calibration tool over the proposal service", async () => {
  let registered: ToolDefinition | undefined;
  let query: unknown;
  const ctx = {
    homeProposals: {
      qualitySummary: () => SUMMARY,
      calibrationHistory(input: unknown) {
        query = input;
        return [];
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
  assert.equal(registered?.name, "get_home_calibration");
  const value = await registered!.execute({ limit: 8 }, {} as never);
  assert.equal(query, 8);
  assert.deepEqual(value.summary, SUMMARY);
  assert.deepEqual(value.recentReviews, []);
  assert.throws(() => projectHomeCalibration({ summary: SUMMARY, proposals: [], limit: 21 }), /limit/);
});
