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
  provenance: { producer: "dsh-home-agent", sessionId: "home-main", toolCallId: "call-7" },
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
  rationale: {
    householdValue: "Reduce unnecessary lighting after arrivals.",
    whyNow: "Recent bounded evidence shows a candidate pattern.",
    uncertainties: ["Whether late arrivals intentionally keep the light on."],
  },
  spaceCoverage: {
    selectedDevices: 1,
    devicesWithSingleSpace: 0,
    devicesWithoutSpace: 1,
    devicesWithMultipleSpaces: 0,
  },
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
        asOfSeq: 6,
        turns: [
          { turn: 1, status: "completed", startedAt: 1, endedAt: 4, durationMs: 3, usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 } },
          { turn: 2, status: "completed", startedAt: 5, endedAt: 8, durationMs: 3, usage: { inputTokens: 40, outputTokens: 8, reasoningTokens: 1 } },
        ],
        steps: [
          { turn: 1, step: 1, status: "completed", startedAt: 2, endedAt: 3, durationMs: 1 },
          { turn: 2, step: 1, status: "completed", startedAt: 6, endedAt: 7, durationMs: 1 },
        ],
        tools: [{ id: "call-7", turn: 1, step: 1, name: "create_home_proposal", status: "completed", startedAt: 2, endedAt: 3, durationMs: 1 }],
        compactions: [],
        prunes: [],
        usage: { inputTokens: 50, outputTokens: 13, reasoningTokens: 3 },
      }),
    },
  });

  const list = controller.list();
  assert.equal(list[0]?.existingAutomationCount, 15);
  const listHtml = renderProposalList(list, {
    enabled: true,
    intervalMinutes: 360,
    runOnStart: false,
    state: "waiting",
    lastAttempt: {
      at: "2026-08-19T00:00:00.000Z",
      outcome: "no_proposal",
      disposition: "insufficient_evidence",
      metrics: {
        durationMs: 2500,
        inputTokens: 120,
        outputTokens: 18,
        reasoningTokens: 7,
        toolCalls: 6,
        failedToolCalls: 0,
      },
    },
    recentAttempts: [{
      id: "observation-2",
      trigger: "scheduled",
      startedAt: "2026-08-19T00:00:00.000Z",
      completedAt: "2026-08-19T00:00:02.000Z",
      status: "completed",
      outcome: "no_proposal",
      disposition: "insufficient_evidence",
      metrics: {
        durationMs: 2500,
        inputTokens: 120,
        outputTokens: 18,
        reasoningTokens: 7,
        toolCalls: 6,
        failedToolCalls: 0,
      },
    }, {
      id: "observation-1",
      trigger: "startup",
      startedAt: "2026-08-18T23:00:00.000Z",
      status: "interrupted",
    }, {
      id: "observation-current",
      trigger: "manual",
      startedAt: "2026-08-19T00:01:00.000Z",
      status: "running",
    }],
  });
  assert.equal(listHtml.includes("<script>"), false);
  assert.match(listHtml, /&lt;script&gt;Unsafe title&lt;\/script&gt;/);
  assert.match(listHtml, /no proposal · Agent reported: insufficient evidence/i);
  assert.match(listHtml, /Recent observations/i);
  assert.match(listHtml, /scheduled · no proposal · Agent reported: insufficient evidence/i);
  assert.match(listHtml, /6 tools · 120 input \/ 18 output \/ 7 reasoning tokens · 2500 ms/i);
  assert.match(listHtml, /startup · interrupted safely/i);
  assert.match(listHtml, /manual · running/i);

  const detail = controller.detail("proposal-1");
  assert.equal(detail?.trace?.sessionId, "home-main");
  assert.deepEqual(detail?.trace?.turns.map((turn) => turn.turn), [1]);
  assert.deepEqual(detail?.trace?.usage, { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 });
  const detailHtml = renderProposalDetail(detail!);
  assert.match(detailHtml, /606/);
  assert.match(detailHtml, /partial/);
  assert.match(detailHtml, /window_before_baseline/);
  assert.match(detailHtml, /metadata-only overlap screen/i);
  assert.match(detailHtml, /does not prove non-interference/i);
  assert.match(detailHtml, /seq 607/);
  assert.match(detailHtml, /Expected household value/i);
  assert.match(detailHtml, /Reduce unnecessary lighting after arrivals/i);
  assert.match(detailHtml, /Why now/i);
  assert.match(detailHtml, /Agent-declared uncertainties/i);
  assert.match(detailHtml, /do not replace Hub evidence/i);
  assert.match(detailHtml, /Selected-device space coverage/i);
  assert.match(detailHtml, /Unassigned.*1/i);
  assert.match(detailHtml, /Hub-produced/i);
  assert.match(detailHtml, /create_home_proposal/);
  assert.match(detailHtml, /Approve/);
  assert.match(detailHtml, /Reject/);
  assert.match(detailHtml, /Why does this match your household\?/i);
  assert.match(detailHtml, /Already handled/i);
  assert.match(detailHtml, /Does not fit our household/i);

  const reviewed = await controller.review({
    proposalId: "proposal-1",
    expectedRevision: 1,
    decision: "approved",
    reviewer: "household-owner",
    feedbackCode: "useful_as_is",
  });
  assert.equal(reviewed.status, "approved");
  assert.deepEqual(reviews, [{
    proposalId: "proposal-1",
    expectedRevision: 1,
    decision: "approved",
    reviewer: "household-owner",
    feedbackCode: "useful_as_is",
  }]);
  assert.equal("apply" in controller, false);
});

test("renders the recorded structured household feedback without treating it as authority", () => {
  const reviewed: InboxProposal = {
    ...proposal,
    revision: 2,
    status: "rejected",
    review: {
      decision: "rejected",
      reviewer: "household-owner",
      reviewedAt: "2026-08-19T01:10:00.000Z",
      feedbackCode: "insufficient_evidence",
      note: "Observe for another week.",
    },
  };
  const html = renderProposalDetail({ proposal: reviewed });
  assert.match(html, /Not enough evidence/i);
  assert.match(html, /Observe for another week/i);
  assert.equal(html.includes("<form"), false);
});
