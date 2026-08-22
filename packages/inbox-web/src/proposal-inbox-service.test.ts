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
  provenance: { producer: "test", sessionId: "home-main", toolCallId: "call-7" },
  evidence: { references: [], watermarks: [] },
  conflictCheck: { status: "checked" as const, existingAutomationCount: 0, matches: [] },
  dryRun: { status: "passed", summary: "No writes." },
  risk: { level: "low", reasons: [], requiresHumanApproval: true },
  intent: { type: "automation-draft", description: "Review only.", rollback: "Discard." },
  audit: [],
};

const trialProposal = {
  ...reviewProposal,
  id: "proposal-trial",
  revision: 8,
  status: "approved" as const,
  rolloutState: "trial_active" as const,
  trial: {
    durationDays: 7 as const,
    startedAt: "2026-08-20T01:00:00.000Z",
    endsAt: "2026-08-27T01:00:00.000Z",
  },
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

class StubGovernedReviewedProposals extends StubReviewedProposals {
  readonly decisions: unknown[] = [];
  readonly snoozes: unknown[] = [];
  readonly enablements: unknown[] = [];

  override get(id: string) {
    if (id === trialProposal.id) return trialProposal;
    return super.get(id);
  }

  override list(query?: { readonly visibleOnly?: boolean }) {
    const snoozed = {
      ...reviewProposal,
      id: "proposal-snoozed",
      snoozeCount: 1,
      snoozedUntil: "2026-08-23T09:00:00.000Z",
    };
    return query?.visibleOnly === true ? [reviewProposal] : [reviewProposal, snoozed];
  }

  proposalCapacity() {
    return { used: 5, max: 5 as const, available: 0 };
  }

  snoozeProposal(input: unknown) {
    this.snoozes.push(input);
  }

  decideProposal(input: unknown) {
    this.decisions.push(input);
  }

  enableProposal(input: unknown) {
    this.enablements.push(input);
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

class StubSafety extends Service {
  readonly acknowledgements: unknown[] = [];
  private alert = {
    id: "leak:1",
    title: "厨房漏水",
    source: "厨房传感器",
    status: "active" as const,
    severity: "safety" as const,
    snoozeAllowed: false as const,
  };

  constructor(ctx: Context) {
    super(ctx, "homeSafety");
  }

  snapshot() {
    return { generatedAt: "2026-08-22T08:00:00.000Z", alerts: [this.alert] };
  }

  acknowledge(alertId: string, actorId: string) {
    this.acknowledgements.push({ alertId, actorId });
    this.alert = { ...this.alert, status: "acknowledged" };
    return this.alert;
  }
}

const runtimeConfirmationFixture = {
  id: "runtime-admin-1",
  dedupKey: "front-door:unlock",
  actionSummary: "Unlock the front door",
  approvalLevel: "admin" as const,
  requestedAt: "2026-08-21T09:00:00.000Z",
  expiresAt: "2026-08-21T09:00:10.000Z",
  status: "pending" as const,
};

class StubRuntimeReviewCenter extends Service {
  readonly approvals: unknown[] = [];
  readonly rejections: unknown[] = [];

  constructor(ctx: Context) {
    super(ctx, "homeReviewCenter");
  }

  listRuntimeConfirmations() {
    return [runtimeConfirmationFixture];
  }

  snapshot() {
    return { runtimeConfirmations: [runtimeConfirmationFixture] };
  }

  canApproveRuntimeConfirmation(_confirmationId: string, actor: typeof runtimeAdminActor) {
    return (actor.role === "admin" || actor.role === "adult_member")
      && actor.device.kind === "private"
      && actor.device.boundPrincipalId === actor.principalId;
  }

  activities() {
    return [{
      id: "activity-expired-1",
      at: "2026-08-21T08:30:00.000Z",
      title: "关闭厨房总水阀 · 已过期",
      actor: "家庭服务",
      attribution: "system" as const,
      cause: ["等待放行达到时限", "安全规则取消了这项动作"],
      verification: "未执行",
    }];
  }

  approveRuntimeConfirmation(input: unknown) {
    this.approvals.push(input);
    return { status: "approved" as const, confirmation: { ...runtimeConfirmationFixture, status: "approved" as const } };
  }

  rejectRuntimeConfirmation(input: unknown) {
    this.rejections.push(input);
    return { status: "rejected" as const, confirmation: { ...runtimeConfirmationFixture, status: "rejected" as const } };
  }
}

class StubControlReviewCenter extends StubRuntimeReviewCenter {
  readonly actionRequests: unknown[] = [];
  readonly undoRequests: unknown[] = [];
  private actionTicket: unknown;

  actionDescriptorFor(capabilityId: string) {
    return capabilityId === "cap-light"
      ? {
          action: { kind: "set_boolean" as const, value: false },
          label: "顶灯",
          actionLabel: "关闭",
          summary: "关闭顶灯",
          value: "开",
        }
      : undefined;
  }

  requestAction(input: unknown) {
    this.actionRequests.push(input);
    const request = input as { readonly capabilityId: string; readonly action: unknown; readonly summary: string };
    this.actionTicket = {
      id: "action-ticket-1",
      requestId: "control-request-1",
      capabilityId: request.capabilityId,
      action: request.action,
      summary: request.summary,
      policyClass: "direct" as const,
      reversible: true,
      status: "verified" as const,
      requestedAt: "2026-08-20T10:00:00.000Z",
      initiator: runtimeAdminActor,
      undoExpiresAt: "2026-08-20T10:00:10.000Z",
      undoStatus: "available" as const,
    };
    return {
      status: "verified" as const,
      ticket: this.actionTicket,
      undo: {
        status: "available" as const,
        ticketId: "action-ticket-1",
        expiresAt: "2026-08-20T10:00:10.000Z",
      },
    };
  }

  listActionTickets() {
    return this.actionTicket === undefined ? [] : [this.actionTicket];
  }

  undoAction(input: unknown) {
    this.undoRequests.push(input);
    return {
      status: "verified" as const,
      ticket: {
        id: "undo-ticket-1",
        requestId: "undo-request-1",
        capabilityId: "cap-light",
        action: { kind: "set_boolean" as const, value: true },
        policyClass: "direct" as const,
        reversible: false,
        status: "verified" as const,
        requestedAt: "2026-08-20T10:00:01.000Z",
        initiator: runtimeAdminActor,
      },
    };
  }
}

class StubBatchControlReviewCenter extends StubControlReviewCenter {
  override actionDescriptorFor(capabilityId: string) {
    const descriptors = {
      "cap-light": {
        action: { kind: "set_boolean" as const, value: false },
        label: "顶灯",
        actionLabel: "关闭",
        summary: "关闭顶灯",
        value: "开",
        policyClass: "direct" as const,
      },
      "cap-fan": {
        action: { kind: "set_level" as const, level: 2 },
        label: "风扇",
        actionLabel: "调到二档",
        summary: "把风扇调到二档",
        value: "一档",
        policyClass: "confirmation" as const,
      },
      "cap-lock": {
        action: { kind: "set_boolean" as const, value: true },
        label: "门锁",
        actionLabel: "锁门",
        summary: "锁上门锁",
        value: "未锁",
        policyClass: "administrator" as const,
      },
    } as const;
    return descriptors[capabilityId as keyof typeof descriptors];
  }
}

class StubBatchActions extends Service {
  readonly requests: unknown[] = [];

  constructor(ctx: Context) {
    super(ctx, "homeBatchActions");
  }

  async submit(command: unknown) {
    this.requests.push(command);
    const input = command as {
      readonly requestId: string;
      readonly capabilityIds: readonly string[];
      readonly targets: readonly [{ readonly capabilityId: string; readonly descriptor: { readonly policyClass?: string } }, ...unknown[]];
    };
    const items = input.targets.map((target) => {
      const pending = target.descriptor.policyClass !== "direct";
      return {
        capabilityId: target.capabilityId,
        requestId: input.requestId,
        policyClass: target.descriptor.policyClass,
        status: pending ? "pending_confirmation" as const : "verified" as const,
        ticketId: `ticket-${target.capabilityId.slice(4)}`,
        reason: pending ? "等待现有确认所有者处理。" : "动作已完成并验证。",
        verification: pending ? "pending_confirmation" as const : "verified" as const,
      };
    });
    return {
      requestId: input.requestId,
      items,
      counts: {
        total: input.capabilityIds.length,
        verified: items.filter((item) => item.status === "verified").length,
        pending_confirmation: items.filter((item) => item.status === "pending_confirmation").length,
        failed: 0,
        unknown: 0,
      },
    };
  }
}

const runtimeAdminActor = {
  principalId: "admin-1",
  role: "admin" as const,
  present: true,
  device: { kind: "private" as const, boundPrincipalId: "admin-1" },
};

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
  actors: unknown[] = [];
  cancelled: string[] = [];
  backgrounded: string[] = [];
  completionNotificationConsumed = false;
  constructor(ctx: Context) { super(ctx, "homeAdvice"); }
  canAsk() { return true; }
  availability() { return { status: "ready" as const }; }
  async ask(question: string, actor?: unknown) {
    this.questions.push(question);
    this.actors.push(actor);
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
  background(id: string) {
    if (id !== "advice-running") return false;
    this.backgrounded.push(id);
    return true;
  }
  peekNextCompletionNotification() {
    if (this.completionNotificationConsumed) return undefined;
    return {
      adviceId: "advice-background-completed",
      status: "completed" as const,
      completedAt: "2026-08-20T10:00:03.000Z",
      eventId: 4,
    };
  }
  acknowledgeCompletionNotification(adviceId: string) {
    if (adviceId !== "advice-background-completed") return false;
    this.completionNotificationConsumed = true;
    return true;
  }
  list() { return [this.get("advice-1")!]; }
  get(id: string) {
    if (id === "advice-failed") return {
      id,
      status: "failed" as const,
      question: "Why did the curtain open too early?",
      createdAt: "2026-08-20T09:00:00.000Z",
      completedAt: "2026-08-20T09:00:02.000Z",
      errorCode: "model_unavailable",
    };
    if (id === "advice-running") return {
      id,
      status: "running" as const,
      question: "Check the curtain timing in the background.",
      createdAt: "2026-08-20T09:30:00.000Z",
    };
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

class StubCorrection extends Service {
  readonly submissions: unknown[] = [];

  constructor(ctx: Context) { super(ctx, "homeCorrection"); }

  submit(input: unknown) {
    this.submissions.push(input);
    return {
      status: "updated" as const,
      correctionId: "correction-1",
      adviceId: "advice-1",
      correctionType: "household_fact" as const,
      message: "已更新" as const,
      destination: "MEMORY.md#household-facts",
    };
  }

  acknowledgementForAdvice(adviceId: string, actorId: string) {
    return adviceId === "advice-1" && actorId === "adult-1"
      ? this.submit({ adviceId, actorId })
      : undefined;
  }
}

const correctionActor = {
  principalId: "adult-1",
  role: "adult_member" as const,
  present: true,
  device: { kind: "private" as const, boundPrincipalId: "adult-1" },
};

test("mounts a local review facade when the optional DSH trace is absent", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.deepEqual(ctx.homeInbox.list(), []);
  assert.equal("apply" in ctx.homeInbox, false);

  await fiber.dispose();
  assert.equal(ctx.homeInbox, undefined);
  await ctx.fiber.dispose();
});

test("exposes canonical projections without the retired HTML renderer methods", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.equal("renderList" in ctx.homeInbox, false);
  assert.equal("renderDetail" in ctx.homeInbox, false);
  assert.equal("renderAdvice" in ctx.homeInbox, false);
  assert.equal("renderControlCenter" in ctx.homeInbox, false);
  assert.deepEqual(ctx.homeInbox.getProductReviewCounts(), {
    runtimeConfirmations: 0,
    persistentProposals: 0,
  });

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("projects Hub safety incidents into every shell and keeps acknowledgement separate from resolution", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  const safetyFiber = await ctx.plugin(StubSafety);
  const fiber = await ctx.plugin(ProposalInboxService);

  const projection = ctx.homeInbox.getProductShellProjection(runtimeAdminActor);
  assert.equal(projection.safetyAlerts?.[0]?.title, "厨房漏水");
  assert.equal(projection.safetyAlerts?.[0]?.snoozeAllowed, false);
  assert.equal(projection.safetyAlerts?.[0]?.canAcknowledge, true);
  await ctx.homeInbox.acknowledgeSafety({ alertId: "leak:1", actor: runtimeAdminActor });
  assert.deepEqual((ctx.get("homeSafety") as unknown as StubSafety).acknowledgements, [{ alertId: "leak:1", actorId: "admin-1" }]);
  assert.equal(ctx.homeInbox.canAcknowledgeSafety({ ...runtimeAdminActor, present: false }), false);

  await fiber.dispose();
  await safetyFiber.dispose();
  await ctx.fiber.dispose();
});

test("composes the product review projection from the runtime center and pending proposal envelopes", async () => {
  const ctx = new Context();
  await ctx.plugin(StubReviewedProposals);
  await ctx.plugin(StubRuntimeReviewCenter);
  const fiber = await ctx.plugin(ProposalInboxService, {
    now: () => new Date("2026-08-21T08:57:10.000Z"),
  });

  assert.deepEqual(ctx.homeInbox.getProductReviewCounts(), {
    runtimeConfirmations: 1,
    persistentProposals: 1,
  });
  const projection = ctx.homeInbox.getProductReviewProjection(runtimeAdminActor);
  assert.equal(projection.runtimeConfirmations.length, 1);
  assert.equal(projection.runtimeConfirmations[0]?.id, runtimeConfirmationFixture.id);
  assert.equal(projection.runtimeConfirmations[0]?.title, runtimeConfirmationFixture.actionSummary);
  assert.equal(projection.runtimeConfirmations[0]?.policyClass, "administrator");
  assert.equal(projection.runtimeConfirmations[0]?.canApprove, true);
  assert.equal(projection.runtimeConfirmations[0]?.expiresIn, "3 分钟");
  assert.equal(projection.runtimeConfirmations[0]?.expiresLabel?.includes("T"), false);
  assert.equal(projection.proposals.length, 1);
  assert.equal(projection.proposals[0]?.id, reviewProposal.id);
  assert.equal(projection.proposals[0]?.title, reviewProposal.title);
  assert.equal(projection.proposalCapacityUsed, 1);
  assert.equal(projection.proposalCapacity, 5);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("projects the bounded proposal trace only onto the selected proposal", async () => {
  const ctx = new Context();
  await ctx.plugin(StubReviewedProposals);
  ctx.provide("homeAgent", {
    traceSnapshot: () => ({
      sessionId: "home-main",
      asOfSeq: 6,
      turns: [{ turn: 1, status: "completed" as const, startedAt: 1, endedAt: 4, durationMs: 3 }],
      steps: [{ turn: 1, step: 1, status: "completed" as const, startedAt: 2, endedAt: 3, durationMs: 1 }],
      tools: [{ id: "call-7", turn: 1, step: 1, name: "create_home_proposal", status: "completed" as const, startedAt: 2, endedAt: 3, durationMs: 1 }],
      compactions: [],
      prunes: [],
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 },
    }),
  });
  const fiber = await ctx.plugin(ProposalInboxService);

  const unselected = ctx.homeInbox.getProductReviewProjection(runtimeAdminActor);
  assert.equal("trace" in unselected.proposals[0]!, false);
  const selected = ctx.homeInbox.getProductReviewProjection(runtimeAdminActor, reviewProposal.id).selectedProposal;
  assert.equal(selected?.trace?.sessionId, "home-main");
  assert.deepEqual(selected?.trace?.tools.map((tool) => tool.name), ["create_home_proposal"]);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("uses the proposal owner for capacity, visible cards, snooze, and both proposal decisions", async () => {
  const ctx = new Context();
  const proposalsFiber = await ctx.plugin(StubGovernedReviewedProposals);
  const fiber = await ctx.plugin(ProposalInboxService);
  const proposals = ctx.homeProposals as unknown as StubGovernedReviewedProposals;

  const projection = ctx.homeInbox.getProductReviewProjection(runtimeAdminActor);
  assert.deepEqual(projection.proposals.map((proposal) => proposal.id), [reviewProposal.id]);
  assert.equal(projection.proposalCapacityUsed, 5);
  assert.equal(projection.proposalCapacity, 5);
  assert.equal(ctx.homeInbox.canSnoozeProposal(), true);
  assert.equal(ctx.homeInbox.canRejectProposal(), true);
  assert.equal(ctx.homeInbox.canLatchProposal(), true);
  assert.equal(ctx.homeInbox.canEnableProposal(), true);

  const selected = ctx.homeInbox.getProductReviewProjection(runtimeAdminActor, trialProposal.id).selectedProposal;
  assert.equal(selected?.id, trialProposal.id);
  assert.equal(selected?.stage, "trial");

  await ctx.homeInbox.snoozeProposal({ proposalId: reviewProposal.id, until: "tomorrow" });
  await ctx.homeInbox.rejectProposal({ proposalId: reviewProposal.id, expectedRevision: 7, reviewer: "admin-1" });
  await ctx.homeInbox.latchProposal({ proposalId: reviewProposal.id, expectedRevision: 7, reviewer: "admin-1" });
  await ctx.homeInbox.enableProposal({ proposalId: trialProposal.id, expectedRevision: 8, reviewer: "admin-1" });

  assert.deepEqual(proposals.snoozes, [{ proposalId: reviewProposal.id, until: "tomorrow" }]);
  assert.deepEqual(proposals.decisions, [
    { proposalId: reviewProposal.id, expectedRevision: 7, reviewer: "admin-1", decision: "reject_once" },
    { proposalId: reviewProposal.id, expectedRevision: 7, reviewer: "admin-1", decision: "do_not_suggest" },
  ]);
  assert.deepEqual(proposals.enablements, [{
    proposalId: trialProposal.id,
    expectedRevision: 8,
    reviewer: "admin-1",
  }]);

  await fiber.dispose();
  await proposalsFiber.dispose();
  await ctx.fiber.dispose();
});

test("forwards runtime decisions through member and administrator approval levels", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  const centerFiber = await ctx.plugin(StubRuntimeReviewCenter);
  const fiber = await ctx.plugin(ProposalInboxService);
  const center = ctx.homeReviewCenter as unknown as StubRuntimeReviewCenter;

  const approved = await ctx.homeInbox.approveRuntimeConfirmation({
    confirmationId: runtimeConfirmationFixture.id,
    actor: runtimeAdminActor,
  });
  assert.equal(approved.status, "approved");
  assert.deepEqual(center.approvals, [{
    confirmationId: runtimeConfirmationFixture.id,
    actor: runtimeAdminActor,
  }]);

  const shared = {
    ...runtimeAdminActor,
    device: { kind: "shared" as const },
  };
  assert.equal(ctx.homeInbox.canApproveRuntimeConfirmation(shared, runtimeConfirmationFixture.id), false);
  assert.equal(ctx.homeInbox.canApproveRuntimeConfirmation({
    ...shared,
    role: "adult_member",
    device: { kind: "private", boundPrincipalId: shared.principalId },
  }, runtimeConfirmationFixture.id), true);
  const denied = await ctx.homeInbox.approveRuntimeConfirmation({
    confirmationId: runtimeConfirmationFixture.id,
    actor: shared,
  });
  assert.deepEqual(denied, { status: "denied", reason: "unauthorized" });
  assert.equal(center.approvals.length, 1);

  await fiber.dispose();
  await centerFiber.dispose();
  await ctx.fiber.dispose();
});

test("exposes explicit observation only when the full runtime supplies the Hub controller", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubObservation);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.equal(ctx.homeInbox.canObserveNow(), true);
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
  const getProductAdviceTurn = (ctx.homeInbox as unknown as {
    getProductAdviceTurn?: (id: string) => unknown;
  }).getProductAdviceTurn;
  assert.equal(typeof getProductAdviceTurn, "function");
  assert.deepEqual(getProductAdviceTurn?.call(ctx.homeInbox, "advice-1"), {
    id: "advice-1",
    question: "Why is the curtain timing uncomfortable?",
    status: "completed",
    answer: "Try a bounded daylight-aware schedule.",
    verifiedFacts: [],
    unknowns: ["Indoor brightness is unavailable."],
    suggestions: ["Review after two weeks."],
    canStop: false,
    canBackground: false,
  });
  assert.equal(getProductAdviceTurn?.call(ctx.homeInbox, "missing"), undefined);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("keeps ordinary advice reports free of correction acknowledgements and reads acknowledgements only from the Hub correction owner", async () => {
  const ordinaryContext = new Context();
  await ordinaryContext.plugin(StubProposals);
  await ordinaryContext.plugin(StubAdvice);
  const ordinaryFiber = await ordinaryContext.plugin(ProposalInboxService);
  assert.equal(ordinaryContext.homeInbox.getProductAdviceTurn("advice-1", correctionActor)?.correctionAck, undefined);
  await ordinaryFiber.dispose();
  await ordinaryContext.fiber.dispose();

  const ctx = new Context();
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubAdvice);
  const correctionFiber = await ctx.plugin(StubCorrection);
  const fiber = await ctx.plugin(ProposalInboxService);
  const turn = ctx.homeInbox.getProductAdviceTurn("advice-1", correctionActor);
  assert.equal(turn?.correctionAck, "已更新");
  assert.equal(turn?.correctionDestination, "MEMORY.md#household-facts");
  const result = await ctx.homeInbox.submitConversationCorrection({
    adviceId: "advice-1",
    actor: correctionActor,
    correctionType: "household_preference",
    correction: "卧室晚上保持安静",
    idempotencyKey: "advice-1:correction",
  });
  assert.equal(result.status, "updated");
  assert.deepEqual((ctx.homeCorrection as unknown as StubCorrection).submissions.at(-1), {
    adviceId: "advice-1",
    actor: correctionActor,
    correctionType: "household_preference",
    correction: "卧室晚上保持安静",
    idempotencyKey: "advice-1:correction",
  });

  await fiber.dispose();
  await correctionFiber.dispose();
  await ctx.fiber.dispose();
});

test("projects the asynchronous advice lifecycle through one neutral Inbox seam", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubAdvice);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.deepEqual(ctx.homeInbox.getAdviceAvailability(), { status: "ready" });
  const started = await ctx.homeInbox.startAdvice("Why is the curtain timing uncomfortable?", correctionActor);
  assert.equal(started.id, "advice-1");
  assert.deepEqual((ctx.homeAdvice as unknown as StubAdvice).actors[0], correctionActor);
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
  assert.deepEqual(await ctx.homeInbox.backgroundAdvice("advice-running"), { status: "background" });
  assert.deepEqual((ctx.homeAdvice as unknown as StubAdvice).backgrounded, ["advice-running"]);
  assert.deepEqual(await ctx.homeInbox.backgroundAdvice("missing"), { status: "not_found" });

  const retried = await ctx.homeInbox.retryAdvice("advice-failed");
  assert.equal(retried.id, "advice-1");
  assert.equal((ctx.homeAdvice as unknown as StubAdvice).questions.at(-1), "Why did the curtain open too early?");
  assert.deepEqual(await ctx.homeInbox.retryAdvice("advice-1"), { status: "terminal_status" });
  assert.deepEqual(await ctx.homeInbox.retryAdvice("missing"), { status: "not_found" });

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("projects one durable background completion notification from the Hub owner", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubAdvice);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.deepEqual(ctx.homeInbox.getProductShellProjection().completionNotification, {
    adviceId: "advice-background-completed",
    status: "completed",
    completedAt: "2026-08-20T10:00:03.000Z",
  });
  assert.deepEqual(ctx.homeInbox.getProductShellProjection().completionNotification, {
    adviceId: "advice-background-completed",
    status: "completed",
    completedAt: "2026-08-20T10:00:03.000Z",
  });
  assert.equal(ctx.homeInbox.acknowledgeCompletionNotification("advice-background-completed"), true);
  assert.equal(ctx.homeInbox.getProductShellProjection().completionNotification, undefined);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("projects the neutral home world into household-facing spaces and connection state", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  const centerFiber = await ctx.plugin(StubControlReviewCenter);
  ctx.provide("homeWorld", {
    snapshot: () => ({
      generatedAt: "2026-08-20T10:00:00.000Z",
      bridges: {
        "bridge-main": {
          adapterType: "home-assistant",
          diagnostics: {
            connectionState: "ready",
            lastSuccessfulContactAt: "2026-08-20T09:59:58.000Z",
          },
          watermark: { epochId: "epoch-main", lastSeq: 7 },
          metrics: { consistency: "ready", connection: "up", eventActivity: "idle" },
        },
      },
      bridgeWatermarks: [{ bridgeId: "bridge-main" }],
      diagnostics: [{ bridgeId: "bridge-main", connectionState: "ready" }],
      spaces: [{ hwSpaceId: "space-living", name: "客厅", bindings: [{ bridgeId: "bridge-main", nativeSpaceId: "living" }] }],
      devices: [{
        hwId: "device-light",
        name: "顶灯",
        health: "reachable",
        validity: "valid",
        bindings: [{ bridgeId: "bridge-main", nativeId: "light.living", nativeInstanceId: "light.living", hwSpaceId: "space-living" }],
        capabilities: [{
          hwCapabilityId: "cap-light",
          hwId: "device-light",
          schema: "ha-state",
          schemaVersion: "1",
          semanticKind: "light",
          bindings: [{ bridgeId: "bridge-main", nativeId: "light.living", nativeInstanceId: "light.living", hwSpaceId: "space-living" }],
        }],
        states: [{
          nativeId: "light.living",
          nativeInstanceId: "light.living",
          attrs: { state: "on", brightness: 180, secret: "must-not-project" },
          time: { sourceTs: "2026-08-20T09:59:57.000Z", sourceTsQuality: "platform" },
          origin: "observed",
        }],
      }],
    }),
  });
  const fiber = await ctx.plugin(ProposalInboxService, { now: () => new Date("2026-08-20T10:00:00.000Z") });

  const projection = ctx.homeInbox.getProductShellProjection();
  assert.equal(projection.connection.state, "quiet");
  assert.equal(projection.connection.lastContact, "刚刚");
  assert.deepEqual(projection.spaces, [{
    id: "space-living",
    name: "客厅",
    deviceCount: 1,
    devices: ["顶灯 · 开"],
  }]);
  assert.deepEqual(projection.controlSpaces, [{
    id: "space-living",
    name: "客厅",
    deviceCount: 1,
    devices: ["顶灯 · 开"],
    controls: [{
      id: "cap-light",
      label: "顶灯",
      value: "开",
      actionLabel: "关闭",
    }],
  }]);
  assert.equal(JSON.stringify(projection).includes("secret"), false);
  assert.equal(JSON.stringify(projection).includes("light.living"), false);

  await fiber.dispose();
  await centerFiber.dispose();
  await ctx.fiber.dispose();
});

test("keeps controls read-only when the Hub provides no explicit action descriptor", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  const centerFiber = await ctx.plugin(StubRuntimeReviewCenter);
  ctx.provide("homeWorld", {
    snapshot: () => ({
      spaces: [{ hwSpaceId: "space-living", name: "客厅" }],
      devices: [{
        hwId: "device-light",
        name: "顶灯",
        validity: "valid",
        capabilities: [{
          hwCapabilityId: "cap-light",
          semanticKind: "light",
          bindings: [{ bridgeId: "bridge-main", nativeId: "light.living", nativeInstanceId: "light.living", hwSpaceId: "space-living" }],
        }],
        states: [{
          nativeId: "light.living",
          nativeInstanceId: "light.living",
          attrs: { state: "on" },
        }],
      }],
    }),
  });
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.deepEqual(ctx.homeInbox.getProductShellProjection().controlSpaces[0]?.controls, []);
  await assert.rejects(
    ctx.homeInbox.requestControl({ capabilityId: "cap-light", actor: runtimeAdminActor }),
    /control_unavailable/,
  );

  await fiber.dispose();
  await centerFiber.dispose();
  await ctx.fiber.dispose();
});

test("obtains the typed batch owner and forwards exact current action targets", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubBatchControlReviewCenter);
  await ctx.plugin(StubBatchActions);
  const fiber = await ctx.plugin(ProposalInboxService);

  const result = await ctx.homeInbox.requestBatchControl({
    capabilityIds: ["cap-light", "cap-fan", "cap-lock"],
    actor: runtimeAdminActor,
  });
  const command = (ctx.get("homeBatchActions") as unknown as StubBatchActions).requests[0] as {
    readonly requestId: string;
    readonly capabilityIds: readonly string[];
    readonly actor: unknown;
    readonly targets: readonly { readonly capabilityId: string; readonly descriptor: unknown }[];
  };
  assert.match(command.requestId, /^batch-/);
  assert.deepEqual(command.capabilityIds, ["cap-light", "cap-fan", "cap-lock"]);
  assert.deepEqual(command.actor, runtimeAdminActor);
  assert.deepEqual(command.targets, [
    {
      capabilityId: "cap-light",
      descriptor: {
        action: { kind: "set_boolean", value: false },
        label: "顶灯",
        actionLabel: "关闭",
        summary: "关闭顶灯",
        value: "开",
        policyClass: "direct",
      },
    },
    {
      capabilityId: "cap-fan",
      descriptor: {
        action: { kind: "set_level", level: 2 },
        label: "风扇",
        actionLabel: "调到二档",
        summary: "把风扇调到二档",
        value: "一档",
        policyClass: "confirmation",
      },
    },
    {
      capabilityId: "cap-lock",
      descriptor: {
        action: { kind: "set_boolean", value: true },
        label: "门锁",
        actionLabel: "锁门",
        summary: "锁上门锁",
        value: "未锁",
        policyClass: "administrator",
      },
    },
  ]);
  assert.deepEqual(result.counts, {
    total: 3,
    verified: 1,
    pending_confirmation: 2,
    failed: 0,
    unknown: 0,
  });
  assert.equal(result.items[0]?.status, "verified");
  assert.equal(result.items[1]?.status, "pending_confirmation");
  assert.equal(result.items[2]?.status, "pending_confirmation");

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("keeps batch control absent and fail closed without a batch owner", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubControlReviewCenter);
  const fiber = await ctx.plugin(ProposalInboxService);

  assert.equal(ctx.homeInbox.canBatchControl(), false);
  assert.equal(ctx.homeInbox.getProductShellProjection().batchControl, undefined);
  await assert.rejects(
    ctx.homeInbox.requestBatchControl({ capabilityIds: ["cap-light"], actor: runtimeAdminActor }),
    /batch_control_unavailable/,
  );

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("forwards a shared-device batch initiator while keeping administrator work pending", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  await ctx.plugin(StubBatchControlReviewCenter);
  await ctx.plugin(StubBatchActions);
  const fiber = await ctx.plugin(ProposalInboxService);
  const sharedActor = {
    principalId: "shared-member-1",
    role: "member" as const,
    present: true,
    device: { kind: "shared" as const },
  };

  const result = await ctx.homeInbox.requestBatchControl({
    capabilityIds: ["cap-lock"],
    actor: sharedActor,
  });
  const command = (ctx.get("homeBatchActions") as unknown as StubBatchActions).requests[0] as { readonly actor: unknown };
  assert.deepEqual(command.actor, sharedActor);
  assert.equal(result.items[0]?.policyClass, "administrator");
  assert.equal(result.items[0]?.status, "pending_confirmation");

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("executes the Hub action descriptor even when semanticKind disagrees", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  const centerFiber = await ctx.plugin(StubControlReviewCenter);
  ctx.provide("homeWorld", {
    snapshot: () => ({
      devices: [{
        hwId: "device-light",
        name: "顶灯",
        validity: "valid",
        capabilities: [{
          hwCapabilityId: "cap-light",
          semanticKind: "media",
          bindings: [{ bridgeId: "bridge-main", nativeId: "light.living", nativeInstanceId: "light.living" }],
        }],
        states: [{
          nativeId: "light.living",
          nativeInstanceId: "light.living",
          attrs: { state: "on" },
        }],
      }],
    }),
  });
  const fiber = await ctx.plugin(ProposalInboxService);

  const result = await ctx.homeInbox.requestControl({ capabilityId: "cap-light", actor: runtimeAdminActor });
  assert.equal(result.status, "verified");
  const request = (ctx.homeReviewCenter as unknown as StubControlReviewCenter).actionRequests[0] as {
    readonly action: unknown;
    readonly summary: string;
  };
  assert.deepEqual(request.action, { kind: "set_boolean", value: false });
  assert.equal(request.summary, "关闭顶灯");

  await fiber.dispose();
  await centerFiber.dispose();
  await ctx.fiber.dispose();
});

test("derives a safe neutral one-shot action from the HomeWorld snapshot", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  const centerFiber = await ctx.plugin(StubControlReviewCenter);
  ctx.provide("homeWorld", {
    snapshot: () => ({
      generatedAt: "2026-08-20T10:00:00.000Z",
      bridges: {
        "bridge-main": {
          adapterType: "home-assistant",
          diagnostics: { connectionState: "ready", lastSuccessfulContactAt: "2026-08-20T09:59:58.000Z" },
          watermark: { epochId: "epoch-main", lastSeq: 7 },
          metrics: { consistency: "ready", connection: "up", eventActivity: "idle" },
        },
      },
      bridgeWatermarks: [{ bridgeId: "bridge-main" }],
      diagnostics: [{ bridgeId: "bridge-main", connectionState: "ready" }],
      spaces: [{ hwSpaceId: "space-living", name: "客厅", bindings: [{ bridgeId: "bridge-main", nativeSpaceId: "living" }] }],
      devices: [{
        hwId: "device-light",
        name: "顶灯",
        validity: "valid",
        bindings: [{ bridgeId: "bridge-main", nativeId: "light.living", nativeInstanceId: "light.living", hwSpaceId: "space-living" }],
        capabilities: [{
          hwCapabilityId: "cap-light",
          hwId: "device-light",
          schema: "ha-state",
          schemaVersion: "1",
          semanticKind: "light",
          bindings: [{ bridgeId: "bridge-main", nativeId: "light.living", nativeInstanceId: "light.living", hwSpaceId: "space-living" }],
        }],
        states: [{
          nativeId: "light.living",
          nativeInstanceId: "light.living",
          attrs: { state: "on", secret: "must-not-cross-the-port" },
          time: { sourceTs: "2026-08-20T09:59:57.000Z", sourceTsQuality: "platform" },
          origin: "observed",
        }],
      }],
    }),
  });
  const fiber = await ctx.plugin(ProposalInboxService, { now: () => new Date("2026-08-20T10:00:00.000Z") });

  const result = await ctx.homeInbox.requestControl({ capabilityId: "cap-light", actor: runtimeAdminActor });
  assert.equal(result.status, "verified");
  const request = (ctx.homeReviewCenter as unknown as StubControlReviewCenter).actionRequests[0] as {
    capabilityId: string;
    action: unknown;
    summary: string;
  };
  assert.equal(request.capabilityId, "cap-light");
  assert.deepEqual(request.action, { kind: "set_boolean", value: false });
  assert.equal(request.summary, "关闭顶灯");
  assert.equal(JSON.stringify(request).includes("light.living"), false);
  assert.equal(JSON.stringify(request).includes("must-not-cross-the-port"), false);
  assert.deepEqual(ctx.homeInbox.getProductControlFeedback("action-ticket-1"), {
    capabilityId: "cap-light",
    ticketId: "action-ticket-1",
    status: "verified",
    label: "关闭顶灯",
    detail: "关闭顶灯已完成。",
    undo: {
      id: "action-ticket-1",
      label: "关闭顶灯",
      inverseLabel: "撤销这次动作",
      remainingSeconds: 10,
      status: "available",
    },
  });

  await fiber.dispose();
  await centerFiber.dispose();
  await ctx.fiber.dispose();
});

test("preserves the Hub-owned bounded activity cause projection", async () => {
  const ctx = new Context();
  await ctx.plugin(StubProposals);
  const centerFiber = await ctx.plugin(StubRuntimeReviewCenter);
  const fiber = await ctx.plugin(ProposalInboxService, {
    now: () => new Date("2026-08-21T10:00:00.000Z"),
  });

  assert.deepEqual(ctx.homeInbox.getProductShellProjection().activity, [{
    id: "activity-expired-1",
    dateGroup: "today",
    time: new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date("2026-08-21T08:30:00.000Z")),
    title: "关闭厨房总水阀 · 已过期",
    actor: "家庭服务",
    attribution: "system",
    cause: ["等待放行达到时限", "安全规则取消了这项动作"],
    verification: "未执行",
  }]);

  await fiber.dispose();
  await centerFiber.dispose();
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
