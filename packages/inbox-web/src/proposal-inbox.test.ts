import assert from "node:assert/strict";
import test from "node:test";

import {
  ProposalInboxController,
  renderProposalDetail,
  renderProposalList,
  type InboxProposal,
} from "./proposal-inbox.js";

const proposal: InboxProposal = {
  id: "proposal-1",
  revision: 1,
  status: "pending_review",
  applicationStatus: "not_available",
  kind: "automation-draft",
  title: "<script>Unsafe title</script>",
  summary: "Review an arrival-light draft.",
  createdAt: "2026-08-19T01:00:00.000Z",
  updatedAt: "2026-08-19T01:00:00.000Z",
  provenance: { producer: "dsh-home-agent", sessionId: "home-main", turnId: "call-7" },
  evidence: {
    references: [{
      bridgeId: "ha-main",
      hwId: "hw-1",
      capabilityId: "hwc-1",
      observedAt: "2026-08-19T00:59:00.000Z",
      source: "post-baseline-event",
      epochId: "epoch-a",
      seq: 607,
    }],
    watermarks: [{ bridgeId: "ha-main", epochId: "epoch-a", lastSeq: 606, freshness: "fresh", gapCount: 0 }],
    temporal: {
      requestedSince: "2026-08-18T01:00:00.000Z",
      requestedUntil: "2026-08-19T01:00:00.000Z",
      truncated: false,
      coverage: [{
        bridgeId: "ha-main",
        epochId: "epoch-a",
        baselineSeq: 606,
        status: "partial",
        reasons: ["window_before_baseline"],
      }],
    },
  },
  conflictCheck: {
    status: "checked",
    existingAutomationCount: 15,
    matches: [{ identity: "rule-1", relation: "possible_overlap" }],
  },
  dryRun: { status: "passed", summary: "No changes were made." },
  risk: { level: "medium", reasons: ["Could overlap"], requiresHumanApproval: true },
  intent: { type: "automation-draft", description: "Prepare a draft.", rollback: "Discard it." },
  audit: [{ id: "audit-1", at: "2026-08-19T01:00:00.000Z", action: "created", actor: "dsh-home-agent", revision: 1 }],
};

test("lists and renders untrusted proposal content without creating an application path", async () => {
  const reviews: unknown[] = [];
  const controller = new ProposalInboxController({
    proposals: {
      list: () => [proposal],
      get: (id) => id === proposal.id ? proposal : undefined,
      review: (input) => {
        reviews.push(input);
        return { ...proposal, revision: 2, status: input.decision };
      },
    },
    traces: {
      traceSnapshot: () => ({
        sessionId: "home-main",
        asOfSeq: 3,
        turns: [{ turn: 1, status: "completed", startedAt: 1, endedAt: 4, durationMs: 3 }],
        steps: [{ turn: 1, step: 1, status: "completed", startedAt: 2, endedAt: 3, durationMs: 1 }],
        tools: [{ id: "call-7", turn: 1, step: 1, name: "create_home_proposal", status: "completed", startedAt: 2, endedAt: 3, durationMs: 1 }],
        usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 },
      }),
    },
  });

  const list = controller.list();
  assert.equal(list[0]?.existingAutomationCount, 15);
  const listHtml = renderProposalList(list);
  assert.equal(listHtml.includes("<script>"), false);
  assert.match(listHtml, /&lt;script&gt;Unsafe title&lt;\/script&gt;/);

  const detail = controller.detail("proposal-1");
  assert.equal(detail?.trace?.sessionId, "home-main");
  const detailHtml = renderProposalDetail(detail!);
  assert.match(detailHtml, /606/);
  assert.match(detailHtml, /partial/);
  assert.match(detailHtml, /window_before_baseline/);
  assert.match(detailHtml, /seq 607/);
  assert.match(detailHtml, /create_home_proposal/);
  assert.match(detailHtml, /Approve/);
  assert.match(detailHtml, /Reject/);

  const reviewed = await controller.review({
    proposalId: "proposal-1",
    expectedRevision: 1,
    decision: "approved",
    reviewer: "household-owner",
  });
  assert.equal(reviewed.status, "approved");
  assert.deepEqual(reviews, [{
    proposalId: "proposal-1",
    expectedRevision: 1,
    decision: "approved",
    reviewer: "household-owner",
  }]);
  assert.equal("apply" in controller, false);
});
