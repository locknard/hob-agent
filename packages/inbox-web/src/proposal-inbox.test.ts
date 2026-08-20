import assert from "node:assert/strict";
import test from "node:test";

import {
  ProposalInboxController,
  renderProposalDetail,
  renderProposalList,
  renderHomeAdvice,
  type InboxProposal,
  type InboxHomeAdviceRecord,
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

const artifactCandidate = {
  schemaVersion: "1" as const,
  content: {
    trigger: {
      kind: "schedule" as const,
      timezone: "Etc/UTC",
      daysOfWeek: [1, 3, 5],
      at: "07:30",
    },
    conditions: [{
      kind: "capability_value" as const,
      source: { hwCapabilityId: "hwc-light-context" },
      operator: "less_than" as const,
      value: 0.4,
    }, {
      kind: "capability_value" as const,
      source: { hwCapabilityId: "hwc-<condition>" },
      operator: "equals" as const,
      value: true,
    }],
    actions: [{
      kind: "set_level" as const,
      target: { hwCapabilityId: "hwc-cover-1" },
      value: 0.65,
      transitionSeconds: 30,
    }, {
      kind: "notify_local" as const,
      message: "<script>alert('unsafe')</script>",
    }],
    rollback: {
      kind: "restore_previous_state" as const,
      target: { hwCapabilityId: "hwc-cover-1" },
      maxAgeSeconds: 900,
    },
    postconditions: [{
      kind: "capability_value" as const,
      source: { hwCapabilityId: "hwc-cover-1" },
      operator: "equals" as const,
      value: 0.65,
      withinSeconds: 120,
    }],
  },
};

const proposalWithArtifactCandidate: InboxProposal = {
  ...proposal,
  artifactCandidate,
};

const artifactReview = {
  artifact: {
    artifactId: "artifact-review-<long-id>",
    revision: 4,
    contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  compile: {
    status: "compiled" as const,
    resultId: "compile-result-<opaque>",
    inputIdentity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    compiler: { id: "neutral-compiler", version: "1.2.3" },
    usedWatermarks: [{ bridgeId: "bridge-<opaque>", epochId: "epoch-1", lastSeq: 42, freshness: "fresh", gapCount: 0 }],
    actionAuthorityBindings: [],
    blockingReasons: [] as const,
    diff: {
      status: "changes" as const,
      operations: [{
        actionOrder: 1,
        kind: "set_level" as const,
        hwCapabilityId: "hwc-review-light",
        actionAuthorityCandidateId: "candidate-<opaque>",
        before: 0.2,
        after: 0.8,
      }, {
        actionOrder: 3,
        kind: "notify_local" as const,
        after: "A neutral reminder",
      }],
      unchangedCount: 1,
      redacted: true as const,
    },
    conflicts: {
      status: "possible_overlap" as const,
      findings: [{
        kind: "foreign_rule" as const,
        severity: "warning" as const,
        hwCapabilityId: "hwc-review-light",
        reference: "foreign-rule-<opaque>",
        reason: "possible_overlap",
      }],
    },
  },
  dryRun: {
    status: "passed" as const,
    resultId: "dry-run-result-<opaque>",
    inputIdentity: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    compileAttestationId: "compile-result-<opaque>",
    compileInputIdentity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    checkedWatermarks: [{ bridgeId: "bridge-<opaque>", epochId: "epoch-1", lastSeq: 42, freshness: "fresh", gapCount: 0 }],
    actionAuthorityBindings: [],
    diff: {
      status: "changes" as const,
      operations: [{
        actionOrder: 1,
        kind: "set_level" as const,
        hwCapabilityId: "hwc-review-light",
        actionAuthorityCandidateId: "candidate-<opaque>",
        before: 0.2,
        after: 0.8,
      }, {
        actionOrder: 3,
        kind: "notify_local" as const,
        after: "A neutral reminder",
      }],
      unchangedCount: 1,
      redacted: true as const,
    },
    conflicts: {
      status: "possible_overlap" as const,
      findings: [{
        kind: "foreign_rule" as const,
        severity: "warning" as const,
        hwCapabilityId: "hwc-review-light",
        reference: "foreign-rule-<opaque>",
        reason: "possible_overlap",
      }],
    },
    writesPerformed: false as const,
    summary: "Read-only neutral check completed.",
  },
  writesPerformed: false as const,
};

const proposalWithArtifactReview: InboxProposal = {
  ...proposalWithArtifactCandidate,
  artifactReview,
};

const proposalWithUnexpectedDryRunBlockingReasons = {
  ...proposalWithArtifactCandidate,
  artifactReview: {
    ...artifactReview,
    dryRun: {
      ...artifactReview.dryRun,
      blockingReasons: ["dry_run_reason_should_not_render"],
    },
  },
} as unknown as InboxProposal;

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
  assert.match(listHtml, /id="main-content"/);
  assert.match(listHtml, /id="reviews"/);
  assert.match(listHtml, /id="observations"/);
  assert.match(listHtml, /Review ideas for your home/i);

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
  assert.match(detailHtml, /class="proposal-detail review-desk"/);
  assert.match(detailHtml, /class="evidence-ledger"/);
  assert.match(detailHtml, /Approval records intent only/i);
  assert.match(detailHtml, /No exact neutral behavior candidate is recorded for this legacy proposal/i);
  assert.match(detailHtml, /<details class="agent-details">/);
  assert.match(detailHtml, /<summary>How the Agent reached this<\/summary>/);

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

test("renders an exact neutral artifact candidate in household language without adding an action path", () => {
  const html = renderProposalDetail({ proposal: proposalWithArtifactCandidate });

  assert.match(html, /Unverified automation candidate/i);
  assert.match(html, /Approval records this reviewed intent only/i);
  assert.match(html, /cannot install, enable, or execute anything/i);
  assert.match(html, /When it runs/i);
  assert.match(html, /07:30/);
  assert.match(html, /Etc\/UTC/);
  assert.match(html, /Monday/);
  assert.match(html, /Wednesday/);
  assert.match(html, /Friday/);
  assert.match(html, /All conditions must be true/i);
  assert.match(html, /hwc-light-context/);
  assert.match(html, /less than/);
  assert.match(html, /0\.4/);
  assert.match(html, /hwc-&lt;condition&gt;/);
  assert.match(html, /What would happen/i);
  assert.match(html, /Set capability hwc-cover-1 to 0\.65/);
  assert.match(html, /30 seconds/);
  assert.match(html, /Send a local notification/);
  assert.match(html, /&lt;script&gt;alert\(&#39;unsafe&#39;\)&lt;\/script&gt;/);
  assert.match(html, /How it could be undone/i);
  assert.match(html, /previous value/);
  assert.match(html, /900 seconds/);
  assert.match(html, /What should be true afterward/i);
  assert.match(html, /within 120 seconds/);
  assert.equal(html.includes("<script>alert('unsafe')</script>"), false);
  assert.equal((html.match(/<button /g) ?? []).length, 2);

  const firstCondition = html.indexOf("hwc-light-context");
  const secondCondition = html.indexOf("hwc-&lt;condition&gt;");
  const firstAction = html.indexOf("Set capability hwc-cover-1 to 0.65");
  const secondAction = html.indexOf("Send a local notification");
  assert.ok(firstCondition >= 0 && firstCondition < secondCondition);
  assert.ok(firstAction >= 0 && firstAction < secondAction);
});

test("renders an artifact review as an accessible read-only automation check with diagnostics kept opaque", () => {
  const html = renderProposalDetail({ proposal: proposalWithUnexpectedDryRunBlockingReasons });

  assert.match(html, /Unverified automation candidate/i);
  assert.match(html, /Read-only automation check/i);
  assert.ok(html.indexOf("Unverified automation candidate") < html.indexOf("Read-only automation check"));
  assert.match(html, /<caption>.*automation check.*<\/caption>/i);
  assert.match(html, /<th scope="col">/);
  assert.match(html, /Compiled/i);
  assert.match(html, /Passed/i);
  assert.match(html, /No household changes were made/i);
  assert.match(html, /writesPerformed: false/i);
  assert.match(html, /possible overlap/i);
  assert.match(html, /not prove non-interference|cannot confirm that no other rule overlaps/i);
  assert.match(html, /<details class="artifact-review-diagnostics"><summary>Technical diagnostics<\/summary>/);

  const diagnostics = html.indexOf("Technical diagnostics");
  assert.ok(diagnostics >= 0);
  for (const opaqueValue of [
    "artifact-review-&lt;long-id&gt;",
    "compile-result-&lt;opaque&gt;",
    "dry-run-result-&lt;opaque&gt;",
    "candidate-&lt;opaque&gt;",
    "bridge-&lt;opaque&gt;",
    "possible_overlap",
    "actionOrder",
  ]) {
    assert.ok(html.indexOf(opaqueValue) >= diagnostics, `${opaqueValue} must stay in diagnostics`);
  }
  assert.ok(html.indexOf("actionOrder 1") < html.indexOf("actionOrder 3"));
  const dryRunDiagnostics = html.indexOf("dry-run-diagnostics-heading");
  assert.ok(dryRunDiagnostics >= 0);
  assert.equal(html.slice(dryRunDiagnostics).includes("dry_run_reason_should_not_render"), false);
  assert.equal(html.slice(dryRunDiagnostics).includes("Blocking reasons"), false);
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("provider"), false);
  assert.equal(html.includes("native"), false);
  assert.equal(html.includes("secret"), false);
  assert.equal(/<(?:button|form)[^>]*(?:apply|install|enable|execute)/iu.test(html), false);
});

test("renders bounded preparation status on proposal list and detail without job diagnostics", () => {
  const statuses = ["queued", "running", "succeeded", "failed"] as const;
  const listHtml = renderProposalList(statuses.map((status) => ({
    id: proposal.id,
    revision: proposal.revision,
    status: proposal.status,
    kind: proposal.kind,
    title: proposal.title,
    summary: proposal.summary,
    updatedAt: proposal.updatedAt,
    riskLevel: proposal.risk.level,
    existingAutomationCount: proposal.conflictCheck.existingAutomationCount,
    conflictMatchCount: proposal.conflictCheck.matches.length,
    preparationStatus: {
      status,
      ...(status === "failed" ? { stage: "compile", code: "policy_blocked" } : {}),
    },
  })) as never);

  for (const status of statuses) assert.match(listHtml, new RegExp(`\\b${status}\\b`, "i"));
  assert.match(listHtml, /compile/i);
  assert.match(listHtml, /policy_blocked/i);

  const detailHtml = renderProposalDetail({
    proposal: {
      ...proposalWithArtifactReview,
      preparationStatus: {
        status: "failed",
        stage: "compile",
        code: "policy_blocked",
        jobId: "job-secret-123",
        rawError: "provider timed out while calling bridge native route",
        provider: "provider-secret",
        bridgeId: "bridge-secret",
        nativeId: "native-entity-secret",
      },
    } as never,
  });

  assert.match(detailHtml, /Preparation/i);
  assert.match(detailHtml, /failed/i);
  assert.match(detailHtml, /compile/i);
  assert.match(detailHtml, /policy_blocked/i);
  assert.match(detailHtml, /Read-only automation check/i);
  for (const forbidden of [
    "job-secret-123",
    "provider timed out while calling bridge native route",
    "provider-secret",
    "bridge-secret",
    "native-entity-secret",
  ]) {
    assert.equal(detailHtml.includes(forbidden), false, forbidden);
  }
});

test("shows a preparation retry button only for retryable failed attempts below the limit", () => {
  const cases = [{
    name: "failed and retryable",
    preparationStatus: { status: "failed", stage: "compile", code: "policy_blocked", attempt: 4, version: 9, canRetry: true },
    expectedForms: 1,
  }, {
    name: "failed but not retryable",
    preparationStatus: { status: "failed", stage: "compile", code: "policy_blocked", attempt: 4, version: 9, canRetry: false },
    expectedForms: 0,
  }, {
    name: "failed at the attempt limit",
    preparationStatus: { status: "failed", stage: "compile", code: "policy_blocked", attempt: 5, version: 9, canRetry: true },
    expectedForms: 0,
  }, {
    name: "running",
    preparationStatus: { status: "running", attempt: 1, version: 9, canRetry: true },
    expectedForms: 0,
  }] as const;

  for (const item of cases) {
    const html = renderProposalDetail({
      proposal: {
        ...proposal,
        status: "approved",
        preparationStatus: item.preparationStatus,
      },
    } as never);
    const retryForms = html.match(/<form[^>]*action="[^"]*preparation\/retry[^"]*"[\s\S]*?<\/form>/g) ?? [];
    assert.equal(retryForms.length, item.expectedForms, item.name);
    if (item.expectedForms === 1) {
      const [form] = retryForms;
      assert.ok(form);
      const inputNames = [...form.matchAll(/<input[^>]*name="([^"]+)"/g)].map((match) => match[1]);
      assert.deepEqual(inputNames, ["expectedRevision", "expectedVersion"]);
      assert.match(form, /Retry preparation/i);
      assert.equal(/execute|install|enable|apply/iu.test(form), false);
    }
  }
});

test("renders the minimal not-run review shape without inventing diagnostics", () => {
  const html = renderProposalDetail({
    proposal: {
      ...proposal,
      artifactReview: {
        artifact: {
          artifactId: "artifact-not-run",
          revision: 1,
          contentHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        },
        compile: { status: "not_run" },
        dryRun: { status: "not_run", writesPerformed: false },
        writesPerformed: false,
      },
    },
  });

  assert.match(html, /Household-language compilation[\s\S]*Not run/i);
  assert.match(html, /Read-only dry run[\s\S]*Not run/i);
  assert.match(html, /No exact compile result is recorded/i);
  assert.match(html, /No exact dry-run result is recorded/i);
  assert.match(html, /No household changes were made/i);
  assert.equal(html.includes("undefined"), false);
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

test("renders a household advice document with uncertainty, trial, and capability-only hardware guidance", () => {
  const advice: InboxHomeAdviceRecord = {
    id: "advice-1",
    status: "completed",
    question: "Why is <the curtain> sometimes early and sometimes late?",
    createdAt: "2026-08-20T10:00:00.000Z",
    completedAt: "2026-08-20T10:00:02.000Z",
    report: {
      summary: "Try a daylight-aware schedule before buying hardware.",
      confidence: "partial",
      findings: ["The current schedule appears fixed."],
      unknowns: ["Indoor brightness is unavailable."],
      trial: {
        description: "Use sunrise with bounded earliest and latest times.",
        durationDays: 14,
        successCriteria: ["Fewer manual reversals."],
        rollback: "Restore the fixed schedule.",
      },
      hardwareSuggestions: [{
        capability: "illuminance",
        necessity: "optional",
        reason: "It observes actual room brightness.",
        placement: "Near the window outside direct glare.",
        privacyImpact: "low",
        alternative: "Use sunrise and weather data first.",
      }],
      validationSteps: ["Review after two weeks."],
    },
  };

  const html = renderHomeAdvice(advice);
  assert.equal(html.includes("<the curtain>"), false);
  assert.match(html, /Why is &lt;the curtain&gt;/);
  assert.match(html, /Agent-authored guidance/i);
  assert.match(html, /What remains unknown/i);
  assert.match(html, /14 days/i);
  assert.match(html, /Illuminance sensing/i);
  assert.match(html, /Privacy impact:<\/strong> low/i);
  assert.match(html, /No-purchase alternative/i);
  assert.match(html, /class="no-purchase-alternative"/);
  assert.equal(html.includes("Approve"), false);

  const list = renderProposalList([], undefined, [], undefined, [advice], true);
  assert.match(list, /Ask about your home/i);
  assert.match(list, /name="question"/i);
  assert.match(list, /Try a daylight-aware schedule/i);
});
