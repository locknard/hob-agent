import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

import { ProposalInboxService } from "./proposal-inbox-service.js";

const reviewFixture = {
  artifact: {
    artifactId: "artifact-review",
    revision: 4,
    contentHash: `sha256:${"a".repeat(64)}`,
  },
  compile: {
    status: "compiled" as const,
    resultId: "compile-result",
    inputIdentity: `sha256:${"b".repeat(64)}`,
    compiler: { id: "neutral-compiler", version: "1.2.3" },
    usedWatermarks: [],
    actionAuthorityBindings: [],
    blockingReasons: [],
    diff: { status: "unchanged" as const, operations: [], unchangedCount: 1, redacted: true as const },
    conflicts: { status: "none" as const, findings: [] },
  },
  dryRun: {
    status: "passed" as const,
    resultId: "dry-run-result",
    inputIdentity: `sha256:${"c".repeat(64)}`,
    compileAttestationId: "compile-result",
    compileInputIdentity: `sha256:${"b".repeat(64)}`,
    checkedWatermarks: [],
    actionAuthorityBindings: [],
    diff: { status: "unchanged" as const, operations: [], unchangedCount: 1, redacted: true as const },
    conflicts: { status: "none" as const, findings: [] },
    writesPerformed: false as const,
    summary: "Read-only neutral check completed.",
  },
  writesPerformed: false as const,
};

const reviewProposal = {
  id: "proposal-review",
  revision: 7,
  status: "pending_review" as const,
  applicationStatus: "not_available" as const,
  kind: "automation-draft",
  title: "Review a bounded automation",
  summary: "A bounded candidate needs household review.",
  createdAt: "2026-08-20T01:00:00.000Z",
  updatedAt: "2026-08-20T01:00:00.000Z",
  provenance: { producer: "test" },
  evidence: { references: [], watermarks: [] },
  conflictCheck: { status: "checked" as const, existingAutomationCount: 0, matches: [] },
  dryRun: { status: "passed", summary: "No writes." },
  risk: { level: "low", reasons: [], requiresHumanApproval: true },
  intent: { type: "automation-draft", description: "Review only.", rollback: "Discard." },
  audit: [],
};

class StubReviewedProposals extends Service {
  constructor(ctx: Context) {
    super(ctx, "homeProposals");
  }

  list() { return [reviewProposal]; }
  get(id: string) { return id === reviewProposal.id ? reviewProposal : undefined; }
  review() { throw new Error("not used"); }
  qualitySummary() {
    return {
      total: 1,
      statuses: { pending_review: 1, approved: 0, rejected: 0, expired: 0 },
      feedback: {
        useful_as_is: 0,
        already_covered: 0,
        not_useful: 0,
        incorrect_assumption: 0,
        insufficient_evidence: 0,
        household_preference: 0,
        too_risky: 0,
        other: 0,
      },
      reviewedWithoutFeedback: 0,
    };
  }
}

type PreparationRetryInput = {
  readonly proposalId: string;
  readonly expectedRevision: number;
  readonly expectedVersion: number;
};

class StubRetryableReviewedProposals extends StubReviewedProposals {
  readonly retries: PreparationRetryInput[] = [];

  preparationForProposal(proposalId: string, proposalRevision: number) {
    return {
      proposalId,
      proposalRevision,
      status: "failed" as const,
      attempt: 2,
      version: 4,
      stage: "compile" as const,
      error: { stage: "compile" as const, code: "policy_blocked" as const },
      createdAt: "2026-08-20T01:00:00.000Z",
      updatedAt: "2026-08-20T01:00:01.000Z",
    };
  }

  async retryPreparation(input: PreparationRetryInput) {
    this.retries.push(input);
    return this.preparationForProposal(input.proposalId, input.expectedRevision);
  }
}

class StubProposals extends Service {
  constructor(ctx: Context) {
    super(ctx, "homeProposals");
  }

  list() { return []; }
  get() { return undefined; }
  review() { throw new Error("not used"); }
  qualitySummary() {
    return {
      total: 2,
      statuses: { pending_review: 0, approved: 1, rejected: 1, expired: 0 },
      feedback: {
        useful_as_is: 1,
        already_covered: 0,
        not_useful: 0,
        incorrect_assumption: 1,
        insufficient_evidence: 0,
        household_preference: 0,
        too_risky: 0,
        other: 0,
      },
      reviewedWithoutFeedback: 0,
    };
  }
}

class StubObservationAudit extends Service {
  constructor(ctx: Context) {
    super(ctx, "homeObservationAudit");
  }

  list() {
    return [{
      id: "observation-1",
      trigger: "one_shot",
      startedAt: "2026-08-19T04:00:00.000Z",
      completedAt: "2026-08-19T04:00:01.000Z",
      status: "completed",
      outcome: "no_proposal",
      disposition: "existing_rule_overlap",
    }];
  }

  summary() {
    return {
      totalAttempts: 3,
      completedAttempts: 3,
      interruptedAttempts: 0,
      runningAttempts: 0,
      outcomes: {
        proposal_created: 1,
        no_proposal: 2,
        world_not_ready: 0,
        proposal_pending: 0,
        agent_busy: 0,
        failed: 0,
      },
      dispositions: {
        no_material_value: 1,
        insufficient_evidence: 0,
        existing_rule_overlap: 1,
        mapping_uncertain: 0,
        other_uncertainty: 0,
      },
      noProposalWithoutDisposition: 0,
      measuredAttempts: 2,
      metrics: {
        durationMs: 5_000,
        inputTokens: 240,
        outputTokens: 36,
        reasoningTokens: 14,
        toolCalls: 12,
        failedToolCalls: 1,
      },
    };
  }
}

class StubObservation extends Service {
  runs = 0;

  constructor(ctx: Context) {
    super(ctx, "homeObservationScheduler");
  }

  snapshot() {
    return { enabled: false, runOnStart: false, state: "waiting" as const };
  }

  async observeNow() {
    this.runs += 1;
    return "no_proposal" as const;
  }
}

class StubAdvice extends Service {
  questions: string[] = [];
  cancelled: string[] = [];
  constructor(ctx: Context) { super(ctx, "homeAdvice"); }
  canAsk() { return true; }
  availability() { return { status: "ready" as const }; }
  async ask(question: string) {
    this.questions.push(question);
    return this.get("advice-1")!;
  }
  events(id: string, afterSeq = 0) {
    return id === "advice-1"
      ? [{ id: 2, type: "inspecting_home" as const, data: { adviceId: id, at: "2026-08-20T10:00:01.000Z", stage: "inspecting_home" as const } }]
        .filter((event) => event.id > afterSeq)
      : [];
  }
  subscribe(id: string, listener: (event: unknown) => void, afterSeq = 0) {
    for (const event of this.events(id, afterSeq)) listener(event);
    return () => undefined;
  }
  cancel(id: string) {
    if (id !== "advice-running") return false;
    this.cancelled.push(id);
    return true;
  }
  list() { return [this.get("advice-1")!]; }
  get(id: string) {
    return id === "advice-1" ? {
      id,
      status: "completed" as const,
      question: "Why is the curtain timing uncomfortable?",
      createdAt: "2026-08-20T10:00:00.000Z",
      completedAt: "2026-08-20T10:00:02.000Z",
      report: {
        summary: "Try a bounded daylight-aware schedule.",
        confidence: "partial" as const,
        findings: [],
        unknowns: ["Indoor brightness is unavailable."],
        hardwareSuggestions: [],
        validationSteps: ["Review after two weeks."],
      },
    } : undefined;
  }
}

test("mounts a local review facade when the optional DSH trace is absent", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.deepEqual(ctx.homeInbox.list(), []);
  assert.match(ctx.homeInbox.renderList(), /Review ideas for your home/);
  assert.match(ctx.homeInbox.renderList(), /Observation schedule is disabled/);
  assert.equal(ctx.homeInbox.renderList().includes("Observe now"), false);
  assert.match(ctx.homeInbox.renderList(), /full home runtime/i);
  assert.equal("apply" in ctx.homeInbox, false);

  await fiber.dispose();
  assert.equal(ctx.homeInbox, undefined);
  await ctx.fiber.dispose();
});

test("exposes explicit observation only when the full runtime supplies the Hub controller", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubObservation);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.equal(ctx.homeInbox.canObserveNow(), true);
  assert.match(ctx.homeInbox.renderList(), /Observe now/i);
  assert.equal(await ctx.homeInbox.observeNow(), "no_proposal");
  assert.equal(ctx.homeObservationScheduler.runs, 1);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("renders bounded persisted observation history without DSH trace content", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubObservationAudit);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.match(ctx.homeInbox.renderList(), /one shot · no proposal · Agent reported: existing rule overlap/i);
  assert.match(ctx.homeInbox.renderList(), /Household calibration/i);
  assert.match(ctx.homeInbox.renderList(), /Useful as-is.*1/i);
  assert.match(ctx.homeInbox.renderList(), /Incorrect assumption.*1/i);
  assert.match(ctx.homeInbox.renderList(), /No material household value.*1/i);
  assert.match(ctx.homeInbox.renderList(), /Existing rule overlap.*1/i);
  assert.match(ctx.homeInbox.renderList(), /Measured attempts.*2/i);
  assert.match(ctx.homeInbox.renderList(), /240 input \/ 36 output \/ 14 reasoning tokens/i);
  assert.match(ctx.homeInbox.renderList(), /12 tool calls \/ 1 failed/i);
  assert.equal(ctx.homeInbox.renderList().includes("observation-1"), false);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("exposes bounded household advice without turning the Inbox into a chat runtime", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubAdvice);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.equal(ctx.homeInbox.canAskAdvice(), true);
  const result = await ctx.homeInbox.askAdvice("Why is the curtain timing uncomfortable?");
  assert.equal(result.id, "advice-1");
  assert.equal((ctx.homeAdvice as unknown as StubAdvice).questions.length, 1);
  assert.match(ctx.homeInbox.renderList(), /Ask about your home/i);
  assert.match(ctx.homeInbox.renderAdvice("advice-1") ?? "", /Try a bounded daylight-aware schedule/i);
  assert.equal(ctx.homeInbox.renderAdvice("missing"), undefined);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("projects the asynchronous advice lifecycle through one neutral Inbox seam", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubAdvice);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.deepEqual(ctx.homeInbox.getAdviceAvailability(), { status: "ready" });
  const started = await ctx.homeInbox.startAdvice("Why is the curtain timing uncomfortable?");
  assert.equal(started.id, "advice-1");
  assert.deepEqual(ctx.homeInbox.readAdviceEvents("advice-1", "1"), [{
    id: 2,
    type: "inspecting_home",
    data: {
      adviceId: "advice-1",
      at: "2026-08-20T10:00:01.000Z",
      stage: "inspecting_home",
    },
  }]);
  const delivered: unknown[] = [];
  const unsubscribe = ctx.homeInbox.subscribeAdvice("advice-1", (event) => delivered.push(event));
  assert.equal(delivered.length, 0);
  unsubscribe();
  assert.deepEqual(await ctx.homeInbox.cancelAdvice("missing"), { status: "not_found" });

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("exposes a read-only control center alongside the proposal Inbox", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.equal("renderControlCenter" in ctx.homeInbox, true);
  assert.match((ctx.homeInbox as unknown as { renderControlCenter(): string }).renderControlCenter(), /Control center/i);
  assert.equal("apply" in ctx.homeInbox, false);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("composes live neutral services into the control center without reading raw bridge data", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  ctx.provide("homeWorld", {
    snapshot: () => ({
      bridges: {
        "bridge-main": {
          adapterType: "home-assistant",
          diagnostics: { connectionState: "ready", currentProcessReadyAt: "2026-08-20T09:00:00.000Z" },
          watermark: { epochId: "epoch-main", lastSeq: 7 },
          metrics: { consistency: "ready" },
        },
      },
      bridgeWatermarks: [{ bridgeId: "bridge-main" }],
      diagnostics: [{ bridgeId: "bridge-main", connectionState: "ready", currentProcessReadyAt: "2026-08-20T09:00:00.000Z" }],
      spaces: [{ hwSpaceId: "space-main" }],
      devices: [{ bindings: [{ hwSpaceId: "space-main" }], capabilities: [{}], states: [{ raw: "must-not-render" }] }],
    }),
  });
  ctx.provide("homeAgent", {
    agent: { options: { provider: "openai", model: "gpt-5.6" }, status: "idle" },
    observationStatus: "idle",
  });
  ctx.provide("homeObservationScheduler", {
    snapshot: () => ({ enabled: true, intervalMinutes: 360, runOnStart: false, state: "waiting" as const }),
    observeNow: async () => "no_proposal" as const,
  });
  const fiber = await ctx.plugin(ProposalInboxService);

  const html = ctx.homeInbox.renderControlCenter();
  assert.match(html, /home-assistant/);
  assert.match(html, /gpt-5\.6/);
  assert.match(html, /Home map/);
  assert.equal(html.includes("must-not-render"), false);
  assert.equal(html.includes("epoch-main"), false);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("passes the Hub retention metadata seam into the read-only Control Center", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  ctx.provide("homeRetention", {
    status: () => ({
      status: "ready" as const,
      capacity: { usedBytes: 100, maxBytes: 1_000, remainingBytes: 900 },
      bridges: [{
        bridgeId: "bridge-main",
        status: "ready" as const,
        capacity: { usedBytes: 100, maxBytes: 1_000, remainingBytes: 900 },
        coverage: { status: "complete" as const, coverageFloor: "2026-08-13T00:00:00.000Z" },
        lastRetention: { appliedAt: "2026-08-20T08:00:00.000Z", result: "complete" as const, bytesDeleted: 42 },
      }],
    }),
  });
  const fiber = await ctx.plugin(ProposalInboxService);

  const html = ctx.homeInbox.renderControlCenter();
  assert.match(html, /Evidence retention/);
  assert.match(html, /42 bytes deleted/);
  assert.equal(html.includes("applyRetention"), false);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("passes only artifact capability diagnostics into the Control Center", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  ctx.provide("homeArtifacts", {
    diagnostics: () => ({
      status: "ready" as const,
      schemaVersion: "1" as const,
      lifecycleStates: ["draft", "superseded"] as const,
      hasRecords: true,
      canCompile: false as const,
      canSimulate: false as const,
      canExecute: false as const,
      privateTitle: "Private artifact title",
    }),
  });
  const fiber = await ctx.plugin(ProposalInboxService);

  const html = ctx.homeInbox.renderControlCenter();
  assert.match(html, /Automation artifacts/);
  assert.match(html, /execution unavailable/);
  assert.equal(html.includes("Private artifact title"), false);
  assert.equal("apply" in ctx.homeInbox, false);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("projects an exact bounded artifact review into proposal list and detail without a write path", async () => {
  const ctx = new Context();
  await ctx.plugin(StubReviewedProposals);
  const reviewCalls: unknown[][] = [];
  const hubReview = {
    ...reviewFixture,
    proposal: { id: reviewProposal.id, revision: reviewProposal.revision },
    evidence: { watermarks: [{ bridgeId: "bridge-private", epochId: "epoch-private", lastSeq: 8, freshness: "fresh", gapCount: 0 }] },
    secret: "must-not-cross",
  };
  let reviewToReturn = hubReview;
  ctx.provide("homeArtifacts", {
    diagnostics: () => ({
      status: "ready" as const,
      schemaVersion: "1" as const,
      lifecycleStates: ["draft", "superseded"] as const,
      hasRecords: true,
      canCompile: false as const,
      canSimulate: false as const,
      canExecute: false as const,
    }),
    reviewForProposal: (proposalId: string, proposalRevision: number) => {
      reviewCalls.push([proposalId, proposalRevision]);
      return reviewToReturn;
    },
  });
  const fiber = await ctx.plugin(ProposalInboxService);

  const list = ctx.homeInbox.list();
  assert.equal((list[0] as unknown as { artifactReview?: unknown }).artifactReview, undefined);
  const detail = ctx.homeInbox.detail(reviewProposal.id);
  assert.deepEqual(detail?.proposal.artifactReview, reviewFixture);
  assert.equal(JSON.stringify(detail?.proposal.artifactReview).includes("must-not-cross"), false);
  assert.equal(JSON.stringify(detail?.proposal.artifactReview).includes("proposal"), false);
  assert.equal(JSON.stringify(detail?.proposal.artifactReview).includes("evidence"), false);
  assert.equal(JSON.stringify(detail?.proposal.artifactReview).includes("compileInputIdentity"), true);
  reviewToReturn = {
    ...hubReview,
    proposal: { id: "other-proposal", revision: 99 },
  };
  assert.equal(ctx.homeInbox.detail(reviewProposal.id)?.proposal.artifactReview, undefined);
  assert.deepEqual(reviewCalls, [
    [reviewProposal.id, reviewProposal.revision],
    [reviewProposal.id, reviewProposal.revision],
  ]);
  assert.equal("apply" in ctx.homeInbox, false);
  assert.equal("execute" in ctx.homeInbox, false);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("delegates failed preparation retry through the optional direct port", async () => {
  const ctx = new Context();
  await ctx.plugin(StubRetryableReviewedProposals);
  const fiber = await ctx.plugin(ProposalInboxService);
  const retryInput: PreparationRetryInput = {
    proposalId: reviewProposal.id,
    expectedRevision: reviewProposal.revision,
    expectedVersion: 4,
  };

  const inbox = ctx.homeInbox as unknown as {
    retryPreparation(input: PreparationRetryInput): Promise<unknown>;
  };
  const status = (ctx.homeInbox.detail(reviewProposal.id)?.proposal as unknown as {
    preparationStatus?: { status?: string; attempt?: number; canRetry?: boolean };
  }).preparationStatus;
  assert.equal(status?.status, "failed");
  assert.equal(status?.attempt, 2);
  assert.equal(status?.canRetry, true);

  await inbox.retryPreparation(retryInput);
  assert.deepEqual((ctx.homeProposals as unknown as StubRetryableReviewedProposals).retries, [retryInput]);

  await fiber.dispose();
  await ctx.fiber.dispose();
});
