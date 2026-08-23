import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

import {
  ProposalInboxHttpService,
  createInboxBasicAuthenticator,
  type ProductViewProvider,
  type ProposalInboxHttpOptions,
} from "./proposal-inbox-http-service.js";
import type { ProductConnectionState } from "./product-shell.js";
import { runProductViewRecipeConformance } from "./product-view-recipe-conformance.js";

class StubInbox extends Service {
  readonly reviews: unknown[] = [];
  observations = 0;
  readonly questions: string[] = [];
  readonly adviceActors: unknown[] = [];

  constructor(ctx: Context) {
    super(ctx, "homeInbox");
  }

  async review(input: unknown) {
    this.reviews.push(input);
    return { status: "approved" };
  }
  canObserveNow() { return true; }
  async observeNow() { this.observations += 1; return "no_proposal"; }
  getAdviceAvailability() { return { status: "ready" as const }; }
  async startAdvice(question: string, actor?: unknown) {
    this.questions.push(question);
    this.adviceActors.push(actor);
    return { id: "advice-1" };
  }
}

class ControlInbox extends StubInbox {
  readonly controls: unknown[] = [];
  readonly undos: unknown[] = [];
  connectionState: ProductConnectionState = "quiet";
  status: "verified" | "pending_confirmation" | "failed" | "unknown" = "verified";

  getProductShellProjection() {
    return {
      connection: { state: this.connectionState, lastContact: "刚刚" },
      spaces: [{ id: "living-room", name: "客厅", deviceCount: 1, devices: ["顶灯 · 开"] }],
      controlSpaces: [{
        id: "living-room",
        name: "客厅",
        deviceCount: 1,
        devices: ["顶灯 · 开"],
        controls: [{ id: "cap-light", label: "顶灯", value: "开", actionLabel: "关闭" }],
      }],
      activity: [],
    };
  }

  requestControl(input: unknown) {
    this.controls.push(input);
    const status = this.status;
    return {
      capabilityId: "cap-light",
      ticketId: "action-ticket-1",
      status,
      label: "关闭顶灯",
      detail: status === "verified" ? "关闭顶灯已完成。" : status === "pending_confirmation" ? "关闭顶灯正在等待你放行。" : "关闭顶灯没有完成，家里保持原状。",
      ...(status === "pending_confirmation" ? { expiresAt: "2026-08-20T10:00:10.000Z" } : {}),
      ...(status === "verified" ? { undo: { ticketId: "action-ticket-1", expiresAt: "2026-08-20T10:00:10.000Z" } } : {}),
    };
  }

  getProductControlFeedback(ticketId: string) {
    return ticketId === "action-ticket-1"
      ? {
          capabilityId: "cap-light",
          ticketId,
          status: this.status,
          label: "关闭顶灯",
          detail: this.status === "verified" ? "关闭顶灯已完成。" : this.status === "pending_confirmation" ? "关闭顶灯正在等待你放行。" : "关闭顶灯没有完成，家里保持原状。",
          ...(this.status === "pending_confirmation" ? { expiresAt: "2026-08-20T10:00:10.000Z" } : {}),
          ...(this.status === "verified" ? { undo: { id: ticketId, label: "关闭顶灯已完成", remainingSeconds: 9, status: "available" as const } } : {}),
        }
      : undefined;
  }

  undoAction(input: unknown) {
    this.undos.push(input);
    return {
      capabilityId: "cap-light",
      ticketId: "undo-ticket-1",
      status: "verified" as const,
      label: "恢复顶灯",
      detail: "恢复顶灯已完成。",
    };
  }
}

class BatchInbox extends StubInbox {
  readonly batches: unknown[] = [];

  private readonly result = {
    requestId: "batch-request-1",
    counts: { total: 2, verified: 1, pending_confirmation: 1, failed: 0, unknown: 0 },
    items: [
      {
        capabilityId: "cap-light",
        requestId: "batch-request-1",
        policyClass: "direct" as const,
        status: "verified" as const,
        ticketId: "ticket-light",
        reason: "动作已完成并验证。",
        verification: "verified" as const,
        label: "顶灯",
      },
      {
        capabilityId: "cap-lock",
        requestId: "batch-request-1",
        policyClass: "administrator" as const,
        status: "pending_confirmation" as const,
        ticketId: "ticket-lock",
        reason: "等待管理员确认。",
        verification: "pending_confirmation" as const,
        label: "门锁",
      },
    ],
  };

  canBatchControl() { return true; }

  getProductShellProjection(_actor?: unknown, batchRequestId?: string) {
    return {
      connection: { state: "quiet" as const, lastContact: "刚刚" },
      spaces: [{ id: "living-room", name: "客厅", deviceCount: 1, devices: ["顶灯 · 开"] }],
      controlSpaces: [{
        id: "living-room",
        name: "客厅",
        deviceCount: 1,
        devices: ["顶灯 · 开"],
        controls: [{ id: "cap-light", label: "顶灯", value: "开", actionLabel: "关闭", policyClass: "direct" as const }],
      }],
      activity: [],
      batchControl: {
        preview: {
          total: 2,
          direct: 1,
          confirmation: 0,
          administrator: 1,
          items: [
            { capabilityId: "cap-light", label: "顶灯", actionLabel: "关闭", policyClass: "direct" as const },
            { capabilityId: "cap-lock", label: "门锁", actionLabel: "锁门", policyClass: "administrator" as const },
          ],
        },
        ...(batchRequestId === "batch-request-1" ? { result: this.result } : {}),
      },
    };
  }

  requestBatchControl(input: unknown) {
    this.batches.push(input);
    return this.result;
  }
}

class SafetyHttpInbox extends StubInbox {
  readonly acknowledgements: unknown[] = [];

  getProductShellProjection() {
    return {
      connection: { state: "quiet" as const, lastContact: "刚刚" },
      spaces: [],
      controlSpaces: [],
      activity: [],
      safetyAlerts: [{
        id: "leak:1",
        title: "厨房漏水",
        body: "先关闭厨房总水阀。",
        source: "厨房传感器",
        status: "active" as const,
        severity: "safety" as const,
        snoozeAllowed: false as const,
        canAcknowledge: true,
      }],
    };
  }

  acknowledgeSafety(input: unknown) {
    this.acknowledgements.push(input);
  }
}

const adminPrincipal = {
  principalId: "admin-1",
  role: "admin" as const,
  present: true,
  device: { kind: "private" as const, boundPrincipalId: "admin-1" },
};

const adultAdminPrincipal = {
  principalId: "adult-2",
  role: "adult_member" as const,
  present: true,
  device: { kind: "private" as const, boundPrincipalId: "adult-2" },
};

const childSharedPrincipal = {
  principalId: "child-1",
  role: "child" as const,
  present: true,
  device: { kind: "shared" as const },
};

class RuntimeDecisionInbox extends StubInbox {
  readonly runtimeCalls: unknown[] = [];
  runtimeResult: { status: "approved" | "rejected" | "denied"; reason?: string } = { status: "approved" };

  listRuntimeConfirmations() {
    return [{
      id: "runtime-1",
      dedupKey: "front-door:unlock",
      actionSummary: "Unlock the front door",
      approvalLevel: "admin" as const,
      requestedAt: "2026-08-21T09:00:00.000Z",
      expiresAt: "2026-08-21T09:00:10.000Z",
      status: "pending" as const,
    }];
  }

  getProductReviewProjection(actor: typeof adminPrincipal | typeof adultAdminPrincipal) {
    return {
      runtimeConfirmations: [{
        id: "runtime-1",
        title: "Unlock the front door",
        effect: "Unlock the front door",
        policyClass: "administrator" as const,
        eligibleActor: "绑定管理员私人设备",
        status: "pending" as const,
        canApprove: this.canApproveRuntimeConfirmation(actor),
      }],
      proposals: [],
      proposalCapacityUsed: 0,
      proposalCapacity: 5,
    };
  }

  canApproveRuntimeConfirmation(actor: typeof adminPrincipal | typeof adultAdminPrincipal) {
    return (actor.role === "admin" || actor.role === "adult_member")
      && actor.device.kind === "private"
      && actor.device.boundPrincipalId === actor.principalId;
  }

  approveRuntimeConfirmation(input: unknown) {
    this.runtimeCalls.push({ decision: "approve", input });
    return this.runtimeResult.status === "denied"
      ? { status: "denied" as const, reason: (this.runtimeResult.reason ?? "unauthorized") as "unauthorized" | "expired" | "already_decided" | "not_found" }
      : { status: this.runtimeResult.status as "approved", confirmation: this.listRuntimeConfirmations()[0]! };
  }

  rejectRuntimeConfirmation(input: unknown) {
    this.runtimeCalls.push({ decision: "reject", input });
    return this.runtimeResult.status === "denied"
      ? { status: "denied" as const, reason: (this.runtimeResult.reason ?? "unauthorized") as "unauthorized" | "expired" | "already_decided" | "not_found" }
      : { status: "rejected" as const, confirmation: this.listRuntimeConfirmations()[0]! };
  }
}

class ProposalEnableInbox extends StubInbox {
  readonly enablements: unknown[] = [];

  getProductReviewProjection(_actor: unknown, selectedProposalId?: string) {
    return {
      runtimeConfirmations: [],
      proposals: [],
      proposalCapacityUsed: 0,
      proposalCapacity: 5,
      ...(selectedProposalId === "proposal-enable" ? {
        selectedProposal: {
          id: "proposal-enable",
          revision: 9,
          title: "周末窗帘慢亮",
          lifecycle: "ready" as const,
          status: "pending" as const,
        },
      } : {}),
    };
  }

  canEnableProposal() { return true; }

  enableProposal(input: unknown) {
    if (this.enablements.length >= 1) {
      // The second attempt simulates a passing outage during enablement.
      throw Object.assign(
        new Error("方案里有设备现在暂时连不上，家里的设置保持原样；稍后再试一次就好。"),
        { code: "enable_temporarily_unavailable" },
      );
    }
    this.enablements.push(input);
  }

  readonly automationCommands: unknown[] = [];

  canControlAutomation() { return true; }

  controlAutomation(input: unknown) {
    this.automationCommands.push(input);
  }
}

class StubRetryableInbox extends StubInbox {
  readonly retries: unknown[] = [];
  retryFailure: Error & { code?: string } | undefined;

  canRetryPreparation() { return true; }

  async retryPreparation(input: unknown) {
    if (this.retryFailure !== undefined) throw this.retryFailure;
    this.retries.push(input);
    return { status: "queued" as const };
  }
}

class StructuredAdviceInbox extends StubInbox {
  availability: "ready" | "active_request" | "setup_required" = "ready";
  readonly started: string[] = [];
  readonly cancelled: string[] = [];
  readonly backgrounded: string[] = [];
  readonly retried: string[] = [];
  readonly events = [
    { id: 1, type: "accepted", data: {} },
    { id: 2, type: "inspecting_home", data: {} },
    { id: 3, type: "answer_delta", data: { text: "窗帘建议" } },
    { id: 4, type: "completed", data: {} },
  ];
  adviceId = "advice-stream";
  listener: ((event: unknown) => void) | undefined;

  getAdviceAvailability() {
    return this.availability === "active_request"
      ? { status: "active_request" as const, activeAdviceId: "advice-active" }
      : { status: this.availability };
  }

  getProductReviewCounts() {
    return { runtimeConfirmations: 2, persistentProposals: 3 };
  }

  getProductShellProjection() {
    return {
      connection: { state: "quiet" as const, lastContact: "刚刚" },
      spaces: [{ id: "living-room", name: "客厅", deviceCount: 2, devices: ["顶灯 · 开"] }],
      controlSpaces: [{ id: "living-room", name: "客厅", deviceCount: 2, devices: ["顶灯 · 开"], controls: [] }],
      activity: [{
        id: "activity-expired-1",
        dateGroup: "today" as const,
        time: "03:00",
        title: "03:00 米家桥接更新",
        actor: "家庭服务",
        attribution: "system" as const,
        cause: ["等待放行到期", "安全规则自动取消了这项动作"],
        verification: "动作未执行",
      }],
    };
  }

  async startAdvice(question: string) {
    this.started.push(question);
    return { id: this.adviceId };
  }

  readAdviceEvents(id: string, after?: string) {
    assert.equal(id, this.adviceId);
    const last = after === undefined ? 0 : Number(after);
    return this.events.filter((event) => event.id > last);
  }

  subscribeAdvice(id: string, listener: (event: unknown) => void) {
    assert.equal(id, this.adviceId);
    this.listener = listener;
    return () => { this.listener = undefined; };
  }

  async cancelAdvice(id: string) {
    this.cancelled.push(id);
    return { status: "cancelled" as const };
  }

  async backgroundAdvice(id: string) {
    this.backgrounded.push(id);
    return id === "advice-active"
      ? { status: "background" as const }
      : { status: "not_found" as const };
  }

  async retryAdvice(id: string) {
    this.retried.push(id);
    return id === "advice-failed"
      ? { id: "advice-retry", status: "running" as const }
      : { status: "not_found" as const };
  }

  getProductAdviceTurn(id: string) {
    if (id === "advice-active") return {
      id,
      question: "正在分析窗帘时间",
      status: "inspecting" as const,
      stage: "checking_home" as const,
      statusMessage: "正在查看家里的当前状态",
      elapsedSeconds: 12,
      canStop: true,
      canBackground: true,
    };
    return id === this.adviceId ? {
      id,
      question: "窗帘有时太早打开",
      status: "completed" as const,
      answer: "先按日光和最早、最晚边界试用一周。",
      verifiedFacts: ["最近两周有 4 次手动调整"],
      unknowns: ["室内照度当前不可用"],
      suggestions: ["试用一周后再决定"],
      canStop: false,
      canBackground: false,
    } : undefined;
  }

}

class PresentationPreferenceInbox extends StubInbox {
  getProductShellProjection() {
    return {
      connection: { state: "quiet" as const, lastContact: "刚刚" },
      spaces: Array.from({ length: 5 }, (_, index) => ({
        id: `space-${index + 1}`,
        name: `空间 ${index + 1}`,
        deviceCount: index + 1,
      })),
      controlSpaces: [],
      activity: [],
    };
  }

  getProductReviewProjection() {
    return {
      runtimeConfirmations: [],
      proposals: [
        { id: "proposal-1", revision: 1, title: "建议一", status: "pending" as const },
        { id: "proposal-2", revision: 1, title: "建议二", status: "pending" as const },
      ],
      proposalCapacityUsed: 2,
      proposalCapacity: 5,
    };
  }
}

class GenericAdviceInbox extends StructuredAdviceInbox {
  readonly events = [
    { id: 1, type: "accepted", data: {} },
    { id: 2, type: "progress", data: { stage: "inspecting_home" } },
    { id: 3, type: "delta", data: { text: "窗帘建议" } },
    { id: 4, type: "completed", data: {} },
  ];
}

class CorrectionAdviceInbox extends StructuredAdviceInbox {
  readonly corrections: unknown[] = [];

  getProductAdviceTurn(id: string) {
    if (id !== this.adviceId) return undefined;
    return {
      id,
      question: "窗帘有时太早打开",
      status: "completed" as const,
      answer: "先按日光和最早、最晚边界试用一周。",
      verifiedFacts: ["最近两周有 4 次手动调整"],
      unknowns: ["室内照度当前不可用"],
      suggestions: ["试用一周后再决定"],
      ...(this.corrections.length === 0 ? {} : {
        correctionAck: "已更新",
        correctionDestination: "SOUL.md#household-preferences",
      }),
      canStop: false,
      canBackground: false,
    };
  }

  submitConversationCorrection(input: unknown) {
    this.corrections.push(input);
    return {
      status: "updated" as const,
      correctionId: "correction-1",
      adviceId: this.adviceId,
      correctionType: "household_preference" as const,
      message: "已更新",
      destination: "SOUL.md#household-preferences",
    };
  }
}

class IncompleteCorrectionInbox extends CorrectionAdviceInbox {
  getProductAdviceTurn(id: string) {
    return id === this.adviceId
      ? { id, question: "正在分析", status: "inspecting" as const }
      : undefined;
  }
}

class CancelledAdviceInbox extends StructuredAdviceInbox {
  readonly events = [
    { id: 1, type: "accepted", data: {} },
    { id: 2, type: "progress", data: { stage: "checking_rules" } },
    { id: 3, type: "cancelled", data: {} },
  ];
}

const token = "a-secure-local-inbox-token-1234567890";
const authorization = `Basic ${Buffer.from(`home:${token}`).toString("base64")}`;

test("serves an authenticated localhost-only Inbox with restrictive response headers", async () => {
  const ctx = new Context();
  await ctx.plugin(StubInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    reviewer: "local-household-reviewer",
  });

  assert.match(ctx.homeInboxHttp.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const unauthenticated = await fetch(`${ctx.homeInboxHttp.origin}/proposals`);
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get("www-authenticate") ?? "", /^Basic /);

  const response = await fetch(`${ctx.homeInboxHttp.origin}/proposals`, {
    headers: { authorization },
    redirect: "manual",
  });
  assert.equal(response.status, 404);

  const adviceEntry = await fetch(`${ctx.homeInboxHttp.origin}/advice`, {
    headers: { authorization },
    redirect: "manual",
  });
  assert.equal(adviceEntry.status, 404);

  const controlCenter = await fetch(`${ctx.homeInboxHttp.origin}/`, {
    headers: { authorization },
    redirect: "manual",
  });
  assert.equal(controlCenter.status, 303);
  assert.equal(controlCenter.headers.get("location"), "/home");

  const namedControlCenter = await fetch(`${ctx.homeInboxHttp.origin}/control-center`, {
    headers: { authorization },
    redirect: "manual",
  });
  assert.equal(namedControlCenter.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(response.headers.get("content-security-policy") ?? "", /style-src 'self'/);
  assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "same-origin");

  const adviceClient = await fetch(`${ctx.homeInboxHttp.origin}/assets/advice.js`, {
    headers: { authorization },
  });
  assert.equal(adviceClient.status, 404);

  const stylesheet = await fetch(`${ctx.homeInboxHttp.origin}/assets/inbox.css`, {
    headers: { authorization },
  });
  assert.equal(stylesheet.status, 404);

  const retiredVoicePreview = await fetch(`${ctx.homeInboxHttp.origin}/voice-preview`, {
    headers: { authorization },
    redirect: "manual",
  });
  assert.equal(retiredVoicePreview.status, 404);

  const canonicalVoice = await fetch(`${ctx.homeInboxHttp.origin}/voice`, {
    headers: { authorization },
    redirect: "manual",
  });
  assert.equal(canonicalVoice.status, 200);
  const voiceHtml = await canonicalVoice.text();
  assert.match(voiceHtml, /data-voice-state="idle"/);
  assert.match(voiceHtml, /data-voice-surface/);
  assert.match(voiceHtml, /action="\/conversation"/);

  const voiceScript = await fetch(`${ctx.homeInboxHttp.origin}/assets/product.js`, {
    headers: { authorization },
  });
  assert.equal(voiceScript.status, 200);
  const voiceScriptText = await voiceScript.text();
  assert.match(voiceScriptText, /SpeechRecognition/);
  assert.match(voiceScriptText, /webkitSpeechRecognition/);
  assert.match(voiceScriptText, /requestSubmit/);
  assert.doesNotMatch(voiceScriptText, /getUserMedia|MediaRecorder|fetch\(|WebSocket|play_media|mediaRef/);

  const invalidVoiceState = await fetch(`${ctx.homeInboxHttp.origin}/voice?state=%3Cscript%3E`, {
    headers: { authorization },
    redirect: "manual",
  });
  assert.equal(invalidVoiceState.status, 303);
  assert.equal(invalidVoiceState.headers.get("location"), "/voice");

  const html = await fetch(`${ctx.homeInboxHttp.origin}/review-center`, {
    headers: { authorization },
  }).then((page) => page.text());
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /href="\/assets\/product.css"/);
  assert.match(html, /class="product-skip-link"/);
  assert.match(html, /aria-label="家庭导航"/);
  assert.match(html, /href="\/review-center"/);

  await fiber.dispose();
  assert.equal(ctx.homeInboxHttp, undefined);
  await ctx.fiber.dispose();
});

test("keeps safety acknowledgement on the fixed host route", async () => {
  const ctx = new Context();
  await ctx.plugin(SafetyHttpInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };

  try {
    const home = await fetch(`${ctx.homeInboxHttp.origin}/home`, { headers: { authorization } });
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /data-host-owned="true"/);
    assert.match(html, /action="\/safety\/leak%3A1\/acknowledge"/);
    assert.match(html, /data-snooze-allowed="false"/);

    const acknowledgement = await fetch(`${ctx.homeInboxHttp.origin}/safety/leak%3A1/acknowledge`, {
      method: "POST",
      headers,
      body: "",
      redirect: "manual",
    });
    assert.equal(acknowledgement.status, 303);
    assert.equal(acknowledgement.headers.get("location"), "/home");
    assert.deepEqual((ctx.get("homeInbox") as unknown as SafetyHttpInbox).acknowledgements, [{
      alertId: "leak:1",
      actor: adminPrincipal,
    }]);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("routes neutral control requests through the review center and exposes verified undo", async () => {
  const ctx = new Context();
  await ctx.plugin(ControlInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const origin = ctx.homeInboxHttp.origin;
  const post = await fetch(`${origin}/control/cap-light`, {
    method: "POST",
    headers: {
      authorization,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "",
    redirect: "manual",
  });
  assert.equal(post.status, 303);
  assert.equal(post.headers.get("location"), "/control?action=action-ticket-1");
  const request = (ctx.homeInbox as unknown as ControlInbox).controls[0] as { capabilityId: string; actor: unknown };
  assert.equal(request.capabilityId, "cap-light");
  assert.deepEqual(request.actor, adminPrincipal);
  assert.equal(JSON.stringify(request).includes("light.living"), false);

  const controlPage = await fetch(`${origin}/control?action=action-ticket-1`, { headers: { authorization } });
  const html = await controlPage.text();
  assert.equal(controlPage.status, 200);
  assert.match(html, /data-control-status="verified"/);
  assert.match(html, /action="\/actions\/action-ticket-1\/undo"/);
  assert.match(html, /10 秒内/);
  assert.match(html, /href="\/control\?action=action-ticket-1&amp;view=builtin\.control"/);

  const undo = await fetch(`${origin}/actions/action-ticket-1/undo`, {
    method: "POST",
    headers: {
      authorization,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "",
    redirect: "manual",
  });
  assert.equal(undo.status, 303);
  assert.equal(undo.headers.get("location"), "/control?action=undo-ticket-1");
  assert.deepEqual((ctx.homeInbox as unknown as ControlInbox).undos[0], { ticketId: "action-ticket-1", actor: adminPrincipal });

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("accepts a bounded same-origin batch control request and redirects to per-item results", async () => {
  const ctx = new Context();
  await ctx.plugin(BatchInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const origin = ctx.homeInboxHttp.origin;
  const headers = {
    authorization,
    origin,
    "content-type": "application/x-www-form-urlencoded",
  };

  const crossOrigin = await fetch(`${origin}/control/batch`, {
    method: "POST",
    headers: { ...headers, origin: "https://attacker.invalid" },
    body: "capabilityId=cap-light",
    redirect: "manual",
  });
  assert.equal(crossOrigin.status, 403);

  const accepted = await fetch(`${origin}/control/batch`, {
    method: "POST",
    headers,
    body: "capabilityId=cap-light&capabilityId=cap-lock",
    redirect: "manual",
  });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), "/control?batch=batch-request-1");
  assert.deepEqual((ctx.homeInbox as unknown as BatchInbox).batches, [{
    capabilityIds: ["cap-light", "cap-lock"],
    actor: adminPrincipal,
  }]);

  const resultPage = await fetch(`${origin}/control?batch=batch-request-1`, { headers: { authorization } });
  assert.equal(resultPage.status, 200);
  const html = await resultPage.text();
  assert.match(html, /data-batch-result-status="verified"/);
  assert.match(html, /data-ticket-id="ticket-lock"/);
  assert.match(html, /href="\/control\?batch=batch-request-1&amp;view=builtin\.control"/);

  const duplicate = await fetch(`${origin}/control/batch`, {
    method: "POST",
    headers,
    body: "capabilityId=cap-light&capabilityId=cap-light",
  });
  assert.equal(duplicate.status, 400);

  const wrongType = await fetch(`${origin}/control/batch`, {
    method: "POST",
    headers: { authorization, origin, "content-type": "application/json" },
    body: JSON.stringify({ capabilityIds: ["cap-light"] }),
  });
  assert.equal(wrongType.status, 415);

  const oversized = await fetch(`${origin}/control/batch`, {
    method: "POST",
    headers,
    body: `capabilityId=${"x".repeat(9_000)}`,
  });
  assert.equal(oversized.status, 413);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("keeps the batch surface absent when no batch owner is available", async () => {
  const ctx = new Context();
  await ctx.plugin(StubInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const origin = ctx.homeInboxHttp.origin;

  const page = await fetch(`${origin}/control`, { headers: { authorization } });
  assert.equal(page.status, 200);
  assert.doesNotMatch(await page.text(), /data-batch-control/);

  const response = await fetch(`${origin}/control/batch`, {
    method: "POST",
    headers: {
      authorization,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "capabilityId=cap-light",
  });
  assert.equal(response.status, 404);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("requires exact same-origin review posts and derives reviewer identity from configuration", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    reviewer: "local-household-reviewer",
  });
  const url = `${ctx.homeInboxHttp.origin}/review-center/proposals/proposal-1/review`;
  const form = "expectedRevision=1&decision=approved&feedbackCode=useful_as_is&note=Reviewed+locally";

  const crossOrigin = await fetch(url, {
    method: "POST",
    headers: {
      authorization,
      origin: "http://attacker.invalid",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
    redirect: "manual",
  });
  assert.equal(crossOrigin.status, 403);

  const accepted = await fetch(url, {
    method: "POST",
    headers: {
      authorization,
      origin: ctx.homeInboxHttp.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
    redirect: "manual",
  });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), "/review-center/proposals/proposal-1");
  assert.deepEqual((ctx.homeInbox as unknown as StubInbox).reviews, [{
    proposalId: "proposal-1",
    expectedRevision: 1,
    decision: "approved",
    reviewer: "admin-1",
    feedbackCode: "useful_as_is",
    note: "Reviewed locally",
  }]);

  (ctx.homeInbox as unknown as StubInbox).review = async () => {
    const error = new Error("must-not-leak-internal-review-detail") as Error & { code: string };
    error.code = "revision_conflict";
    throw error;
  };
  const stale = await fetch(url, {
    method: "POST",
    headers: {
      authorization,
      origin: ctx.homeInboxHttp.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
    redirect: "manual",
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.text()).includes("must-not-leak"), false);

  const missingFeedback = await fetch(url, {
    method: "POST",
    headers: {
      authorization,
      origin: ctx.homeInboxHttp.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "expectedRevision=1&decision=rejected",
    redirect: "manual",
  });
  assert.equal(missingFeedback.status, 400);

  const oversized = await fetch(url, {
    method: "POST",
    headers: {
      authorization,
      origin: ctx.homeInboxHttp.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `expectedRevision=1&decision=rejected&note=${"x".repeat(5_000)}`,
    redirect: "manual",
  });
  assert.equal(oversized.status, 413);

  await fiber.dispose();
  await inboxFiber.dispose();
  await ctx.fiber.dispose();
});

test("renders the real runtime queue and sends runtime approval through the typed actor port", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(RuntimeDecisionInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adultAdminPrincipal,
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };
  try {
    const page = await fetch(`${ctx.homeInboxHttp.origin}/review-center`, { headers: { authorization } });
    const html = await page.text();
    assert.match(html, /data-review-id="runtime-1"/);
    assert.match(html, /Unlock the front door/);
    assert.match(html, /runtime-confirmations\/runtime-1\/approve/);

    const crossOrigin = await fetch(`${ctx.homeInboxHttp.origin}/runtime-confirmations/runtime-1/approve`, {
      method: "POST",
      headers: { ...headers, origin: "http://attacker.invalid" },
      body: "",
      redirect: "manual",
    });
    assert.equal(crossOrigin.status, 403);

    const approved = await fetch(`${ctx.homeInboxHttp.origin}/runtime-confirmations/runtime-1/approve`, {
      method: "POST",
      headers,
      body: "",
      redirect: "manual",
    });
    assert.equal(approved.status, 303);
    assert.equal(approved.headers.get("location"), "/review-center");
    assert.deepEqual((ctx.homeInbox as unknown as RuntimeDecisionInbox).runtimeCalls[0], {
      decision: "approve",
      input: { confirmationId: "runtime-1", actor: adultAdminPrincipal },
    });

    const inbox = ctx.homeInbox as unknown as RuntimeDecisionInbox;
    inbox.runtimeResult = { status: "denied", reason: "expired" };
    const expired = await fetch(`${ctx.homeInboxHttp.origin}/runtime-confirmations/runtime-1/approve`, {
      method: "POST",
      headers,
      body: "",
      redirect: "manual",
    });
    assert.equal(expired.status, 409);
    assert.match(await expired.text(), /expired/i);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("settings saves confirmation methods and rechecks blocked proposals", async () => {
  const ctx = new Context();
  const configured: unknown[] = [];
  let rechecks = 0;
  class RecheckInbox extends StubInbox {
    recheckBlockedProposals() {
      rechecks += 1;
      return { rechecked: 1, cleared: 1 };
    }
  }
  const inboxFiber = await ctx.plugin(RecheckInbox);
  const onboarding = {
    getState: () => ({ step: 8, complete: true, status: "complete" as const, title: "完成", body: "完成", choices: { status: "available" as const, bridges: [], capabilities: [] } }),
    submit: () => { throw new Error("not used"); },
    actionPolicyChoices: () => ({
      status: "available" as const,
      bridges: [],
      capabilities: [{ id: "hwc-1", label: "灯（客厅） · 灯", bridgeId: "ha", bridgeLabel: "Home Assistant", suggestedPolicyClass: "confirmation" as const }],
    }),
    configureActionPolicy: (selection: unknown) => {
      configured.push(selection);
      return { status: "configured" as const };
    },
  };
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    onboarding,
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };
  try {
    const settings = await fetch(`${ctx.homeInboxHttp.origin}/settings`, { headers: { authorization } });
    const settingsHtml = await settings.text();
    assert.match(settingsHtml, /id="action-policy"/, "settings offers the confirmation-method editor");
    assert.match(settingsHtml, /name="capability:hwc-1"/);

    const saved = await fetch(`${ctx.homeInboxHttp.origin}/settings/action-policy`, {
      method: "POST",
      headers,
      body: "capability%3Ahwc-1=confirmation",
      redirect: "manual",
    });
    assert.equal(saved.status, 303);
    const savedLocation = saved.headers.get("location") ?? "";
    const receipt = /^\/settings\?policy=([a-f0-9]{32})#action-policy$/.exec(savedLocation)?.[1];
    assert.ok(receipt !== undefined, "the redirect carries an opaque single-use receipt, not a guessable literal");
    assert.deepEqual(configured, [{ directCapabilityIds: [], confirmationCapabilityIds: ["hwc-1"], administratorCapabilityIds: [] }]);
    assert.equal(rechecks, 1, "the saved configuration immediately rechecks blocked proposals");

    const probed = await fetch(`${ctx.homeInboxHttp.origin}/settings?policy=${receipt}`, { method: "HEAD", headers: { authorization } });
    assert.equal(probed.status, 200);

    const confirmed = await fetch(`${ctx.homeInboxHttp.origin}/settings?policy=${receipt}`, { headers: { authorization } });
    assert.match(await confirmed.text(), /已保存确认方式，已重新检查 1 条受阻建议，其中 1 条已恢复可启用。/,
      "a HEAD probe never consumes the receipt; the household's GET still reads it");

    const replayed = await fetch(`${ctx.homeInboxHttp.origin}/settings?policy=${receipt}`, { headers: { authorization } });
    assert.doesNotMatch(await replayed.text(), /已保存确认方式/, "a receipt reads exactly once");

    const forged = await fetch(`${ctx.homeInboxHttp.origin}/settings?policy=saved`, { headers: { authorization } });
    assert.doesNotMatch(await forged.text(), /已保存确认方式/, "a crafted URL never fakes a success message");

    const sharedDenied = await fetch(`${ctx.homeInboxHttp.origin}/settings/action-policy`, {
      method: "POST",
      headers: { ...headers },
      body: "capability%3Ahwc-1=direct",
      redirect: "manual",
    });
    assert.equal(sharedDenied.status, 303, "the bound-phone principal saves normally");
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("a recheck failure never undoes the save and the receipt says so", async () => {
  const ctx = new Context();
  class ThrowingRecheckInbox extends StubInbox {
    recheckBlockedProposals(): { rechecked: number; cleared: number } {
      throw new Error("recheck port failed");
    }
  }
  const inboxFiber = await ctx.plugin(ThrowingRecheckInbox);
  const onboarding = {
    getState: () => ({ step: 8, complete: true, status: "complete" as const, title: "完成", body: "完成", choices: { status: "available" as const, bridges: [], capabilities: [] } }),
    submit: () => { throw new Error("not used"); },
    actionPolicyChoices: () => ({
      status: "available" as const,
      bridges: [],
      capabilities: [{ id: "hwc-1", label: "灯（客厅） · 灯", bridgeId: "ha", bridgeLabel: "Home Assistant", suggestedPolicyClass: "confirmation" as const }],
    }),
    configureActionPolicy: () => ({ status: "configured" as const }),
  };
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    onboarding,
  });
  try {
    const saved = await fetch(`${ctx.homeInboxHttp.origin}/settings/action-policy`, {
      method: "POST",
      headers: {
        authorization,
        origin: ctx.homeInboxHttp.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "capability%3Ahwc-1=confirmation",
      redirect: "manual",
    });
    assert.equal(saved.status, 303, "the save survives a recheck failure");
    const receipt = /policy=([a-f0-9]{32})/.exec(saved.headers.get("location") ?? "")?.[1];
    assert.ok(receipt !== undefined);
    const confirmed = await fetch(`${ctx.homeInboxHttp.origin}/settings?policy=${receipt}`, { headers: { authorization } });
    assert.match(await confirmed.text(), /已保存确认方式，建议状态稍后重新检查。/, "the receipt states the recheck did not run");
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("approval stays on a bound private device while any present entry may reject", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(RuntimeDecisionInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: {
      ...adminPrincipal,
      device: { kind: "shared" as const },
    },
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };
  try {
    const page = await fetch(`${ctx.homeInboxHttp.origin}/review-center`, { headers: { authorization } });
    const html = await page.text();
    assert.equal(html.includes("runtime-confirmations/runtime-1/approve"), false);
    const sharedReject = await fetch(`${ctx.homeInboxHttp.origin}/runtime-confirmations/runtime-1/reject`, {
      method: "POST",
      headers,
      body: "",
      redirect: "manual",
    });
    assert.equal(sharedReject.status, 303, "rejection executes nothing, so a present shared screen may say no");

    const sharedApprove = await fetch(`${ctx.homeInboxHttp.origin}/runtime-confirmations/runtime-1/approve`, {
      method: "POST",
      headers,
      body: "",
      redirect: "manual",
    });
    assert.equal(sharedApprove.status, 403, "approval still requires the bound private phone");
    assert.match(await sharedApprove.text(), /private device/i);

    const unavailableSnooze = await fetch(`${ctx.homeInboxHttp.origin}/review-center/proposals/proposal-1/snooze`, {
      method: "POST",
      headers,
      body: "until=tomorrow",
      redirect: "manual",
    });
    assert.equal(unavailableSnooze.status, 403);
    assert.match(await unavailableSnooze.text(), /read-only|private device/i);

    const directionApproval = await fetch(`${ctx.homeInboxHttp.origin}/review-center/proposals/proposal-1/review`, {
      method: "POST",
      headers,
      body: "expectedRevision=1&decision=approved&feedbackCode=useful_as_is",
      redirect: "manual",
    });
    assert.equal(directionApproval.status, 403);
    assert.match(await directionApproval.text(), /private device/i);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("keeps the prepared plan detail reachable and accepts the single enable decision", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(ProposalEnableInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adultAdminPrincipal,
    reviewer: "adult-2",
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };
  try {
    const detail = await fetch(`${ctx.homeInboxHttp.origin}/review-center/proposals/proposal-enable`, {
      headers: { authorization },
    });
    assert.equal(detail.status, 200);
    const detailHtml = await detail.text();
    assert.match(detailHtml, /周末窗帘慢亮/);
    assert.match(detailHtml, />启用</);

    const enabled = await fetch(`${ctx.homeInboxHttp.origin}/review-center/proposals/proposal-enable/enable`, {
      method: "POST",
      headers,
      body: "expectedRevision=9",
      redirect: "manual",
    });
    assert.equal(enabled.status, 303);
    assert.equal(enabled.headers.get("location"), "/review-center/proposals/proposal-enable");
    assert.deepEqual((ctx.homeInbox as unknown as ProposalEnableInbox).enablements, [{
      proposalId: "proposal-enable",
      expectedRevision: 9,
      reviewer: "adult-2",
    }]);

    const retryable = await fetch(`${ctx.homeInboxHttp.origin}/review-center/proposals/proposal-enable/enable`, {
      method: "POST",
      headers,
      body: "expectedRevision=9",
      redirect: "manual",
    });
    assert.equal(retryable.status, 303, "a retryable failure stays inside the product");
    const location = retryable.headers.get("location") ?? "";
    assert.equal(location, "/review-center/proposals/proposal-enable?notice=enable_temporarily_unavailable",
      "only the closed product code travels in the URL, never raw error text");

    const returned = await fetch(`${ctx.homeInboxHttp.origin}${location}`, { headers: { authorization } });
    assert.equal(returned.status, 200);
    const returnedHtml = await returned.text();
    assert.match(returnedHtml, /暂时没能完成.*稍后再试/, "the server renders the fixed household copy for the code");
    assert.match(returnedHtml, />启用</, "the card keeps its full entries after the notice");
    assert.match(returnedHtml, /data-one-shot-notice/, "the notice is marked for the asset-driven cleanup");
    assert.doesNotMatch(returnedHtml, /<script>/, "the CSP forbids inline scripts, so the page ships none");
    const asset = await fetch(`${ctx.homeInboxHttp.origin}/assets/product.js`, { headers: { authorization } });
    assert.match(await asset.text(), /data-one-shot-notice[\s\S]*replaceState/, "the allowed asset performs the URL cleanup");

    const forged = await fetch(
      `${ctx.homeInboxHttp.origin}/review-center/proposals/proposal-enable?notice=${encodeURIComponent("已成功启用门锁自动化")}`,
      { headers: { authorization } },
    );
    const forgedHtml = await forged.text();
    assert.doesNotMatch(forgedHtml, /已成功启用门锁自动化/, "arbitrary query text never renders as a trusted status");
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("serves an authenticated, same-origin preparation retry with only bounded revision fields", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubRetryableInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const url = `${ctx.homeInboxHttp.origin}/review-center/proposals/proposal-1/preparation/retry`;
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };

  try {

    const unauthenticated = await fetch(url, {
    method: "POST",
    headers: { origin: ctx.homeInboxHttp.origin, "content-type": headers["content-type"] },
    body: "expectedRevision=1&expectedVersion=4",
    redirect: "manual",
  });
    assert.equal(unauthenticated.status, 401);

    const crossOrigin = await fetch(url, {
    method: "POST",
    headers: { ...headers, origin: "http://attacker.invalid" },
    body: "expectedRevision=1&expectedVersion=4",
    redirect: "manual",
  });
    assert.equal(crossOrigin.status, 403);

    const wrongContentType = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1, expectedVersion: 4 }),
    redirect: "manual",
  });
    assert.equal(wrongContentType.status, 415);

    const accepted = await fetch(url, {
    method: "POST",
    headers,
    body: "expectedRevision=1&expectedVersion=4",
    redirect: "manual",
  });
    assert.equal(accepted.status, 303);
    assert.equal(accepted.headers.get("location"), "/review-center/proposals/proposal-1");
    assert.deepEqual((ctx.homeInbox as unknown as StubRetryableInbox).retries, [{
      proposalId: "proposal-1",
      expectedRevision: 1,
      expectedVersion: 4,
    }]);

    const extraField = await fetch(url, {
    method: "POST",
    headers,
    body: "expectedRevision=1&expectedVersion=4&jobId=must-not-cross",
    redirect: "manual",
  });
    assert.equal(extraField.status, 400);
    assert.equal((ctx.homeInbox as unknown as StubRetryableInbox).retries.length, 1);

    const failure = new Error("raw retry conflict must not leak") as Error & { code: string };
    failure.code = "job_transition_conflict";
    (ctx.homeInbox as unknown as StubRetryableInbox).retryFailure = failure;
    const conflict = await fetch(url, {
      method: "POST",
      headers,
      body: "expectedRevision=1&expectedVersion=4",
      redirect: "manual",
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.text()).includes("raw retry conflict"), false);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("returns 404 for preparation retry when the Hub retry port is absent", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const response = await fetch(`${ctx.homeInboxHttp.origin}/review-center/proposals/proposal-1/preparation/retry`, {
    method: "POST",
    headers: {
      authorization,
      origin: ctx.homeInboxHttp.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "expectedRevision=1&expectedVersion=4",
    redirect: "manual",
  });
  assert.equal(response.status, 404);

  await fiber.dispose();
  await inboxFiber.dispose();
  await ctx.fiber.dispose();
});

test("requires authentication and exact origin for an explicit observation", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const url = `${ctx.homeInboxHttp.origin}/observations/run`;

  const rejected = await fetch(url, {
    method: "POST",
    headers: {
      authorization,
      origin: "http://attacker.invalid",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "",
    redirect: "manual",
  });
  assert.equal(rejected.status, 403);

  const accepted = await fetch(url, {
    method: "POST",
    headers: {
      authorization,
      origin: ctx.homeInboxHttp.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "",
    redirect: "manual",
  });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), "/home");
  assert.equal((ctx.homeInbox as unknown as StubInbox).observations, 1);

  await fiber.dispose();
  await inboxFiber.dispose();
  await ctx.fiber.dispose();
});

test("accepts one bounded same-origin household question and serves its answer", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const url = `${ctx.homeInboxHttp.origin}/conversation`;
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };

  const crossOrigin = await fetch(url, {
    method: "POST",
    headers: { ...headers, origin: "http://attacker.invalid" },
    body: "question=Ignore+all+policy",
    redirect: "manual",
  });
  assert.equal(crossOrigin.status, 403);

  const accepted = await fetch(url, {
    method: "POST",
    headers,
    body: "question=Why+is+the+curtain+timing+uncomfortable%3F",
    redirect: "manual",
  });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), "/conversation/advice-1");
  assert.deepEqual((ctx.homeInbox as unknown as StubInbox).questions, ["Why is the curtain timing uncomfortable?"]);
  assert.deepEqual((ctx.homeInbox as unknown as StubInbox).adviceActors, [adminPrincipal]);

  const answer = await fetch(`${ctx.homeInboxHttp.origin}/conversation/advice-1`, { headers: { authorization } });
  assert.equal(answer.status, 200);
  assert.match(await answer.text(), /class="product-shell"/);

  const unicodeQuestion = "窗帘".repeat(333) + "？";
  const unicode = await fetch(url, {
    method: "POST",
    headers,
    body: new URLSearchParams({ question: unicodeQuestion }),
    redirect: "manual",
  });
  assert.equal(unicode.status, 303);
  assert.equal((ctx.homeInbox as unknown as StubInbox).questions.at(-1), unicodeQuestion);

  const oversized = await fetch(url, {
    method: "POST",
    headers,
    body: new URLSearchParams({ question: "窗".repeat(5_000) }),
    redirect: "manual",
  });
  assert.equal(oversized.status, 413);

  await fiber.dispose();
  await inboxFiber.dispose();
  await ctx.fiber.dispose();
});

test("reports typed advice availability and redirects duplicate requests to the active advice", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const url = `${ctx.homeInboxHttp.origin}/conversation`;
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };
  const inbox = ctx.homeInbox as unknown as StructuredAdviceInbox;

  inbox.availability = "setup_required";
  const unavailable = await fetch(url, {
    method: "POST",
    headers,
    body: "question=Should+I+add+a+sensor%3F",
    redirect: "manual",
  });
  assert.equal(unavailable.status, 303);
  assert.equal(unavailable.headers.get("location"), "/conversation");

  inbox.availability = "active_request";
  const duplicate = await fetch(url, {
    method: "POST",
    headers,
    body: "question=Should+I+add+a+sensor%3F",
    redirect: "manual",
  });
  assert.equal(duplicate.status, 303);
  assert.equal(duplicate.headers.get("location"), "/conversation/advice-active");
  assert.deepEqual(inbox.started, []);

  await fiber.dispose();
  await inboxFiber.dispose();
  await ctx.fiber.dispose();
});

test("accepts an advice start immediately and streams only bounded replayable household events", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const inbox = ctx.homeInbox as unknown as StructuredAdviceInbox;
  const adviceUrl = `${ctx.homeInboxHttp.origin}/conversation`;
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };

  const accepted = await fetch(adviceUrl, {
    method: "POST",
    headers,
    body: "question=窗帘为什么总是太早打开%3F",
    redirect: "manual",
  });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), "/conversation/advice-stream");
  assert.deepEqual(inbox.started, ["窗帘为什么总是太早打开?"]);

  const events = await fetch(`${ctx.homeInboxHttp.origin}/conversation/advice-stream/events`, {
    headers: { authorization, "last-event-id": "1" },
  });
  assert.equal(events.status, 200);
  assert.equal(events.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(events.headers.get("cache-control"), "no-store");
  const body = await events.text();
  assert.match(body, /id: 2\nevent: inspecting_home\ndata: \{\}\n\n/);
  assert.match(body, /id: 3\nevent: answer_delta\ndata: \{"text":"窗帘建议"\}\n\n/);
  assert.match(body, /id: 4\nevent: completed\ndata: \{\}\n\n/);
  assert.equal(body.includes("raw DSH"), false);
  assert.equal(body.includes("tool_call"), false);

  const unauthorized = await fetch(`${ctx.homeInboxHttp.origin}/conversation/advice-stream/events`);
  assert.equal(unauthorized.status, 401);

  await fiber.dispose();
  await inboxFiber.dispose();
  await ctx.fiber.dispose();
});

test("cancels an advice turn only from the exact local origin", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const inbox = ctx.homeInbox as unknown as StructuredAdviceInbox;
  const url = `${ctx.homeInboxHttp.origin}/conversation/advice-stream/stop`;
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };

  const crossOrigin = await fetch(url, {
    method: "POST",
    headers: { ...headers, origin: "http://attacker.invalid" },
    body: "",
    redirect: "manual",
  });
  assert.equal(crossOrigin.status, 403);

  const cancelled = await fetch(url, {
    method: "POST",
    headers,
    body: "",
    redirect: "manual",
  });
  assert.equal(cancelled.status, 303);
  assert.equal(cancelled.headers.get("location"), "/conversation/advice-stream");
  assert.deepEqual(inbox.cancelled, ["advice-stream"]);

  await fiber.dispose();
  await inboxFiber.dispose();
  await ctx.fiber.dispose();
});

test("keeps a running advice turn replayable and lets the person return home while it continues", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };
  const inbox = ctx.homeInbox as unknown as StructuredAdviceInbox;
  inbox.availability = "active_request";

  try {
    const detail = await fetch(`${ctx.homeInboxHttp.origin}/conversation/advice-active`, {
      headers: { authorization },
    });
    assert.equal(detail.status, 200);
    const detailHtml = await detail.text();
    assert.match(detailHtml, /data-advice-events="\/conversation\/advice-active\/events"/);
    assert.match(detailHtml, /action="\/conversation\/advice-active\/stop"/);
    assert.match(detailHtml, /action="\/conversation\/advice-active\/background"/);

    const background = await fetch(`${ctx.homeInboxHttp.origin}/conversation/advice-active/background`, {
      method: "POST",
      headers,
      body: "",
      redirect: "manual",
    });
    assert.equal(background.status, 303);
    assert.equal(background.headers.get("location"), "/home");
    assert.deepEqual(inbox.backgrounded, ["advice-active"]);

    const home = await fetch(`${ctx.homeInboxHttp.origin}/home`, { headers: { authorization } });
    assert.equal(home.status, 200);
    assert.match(await home.text(), /href="\/conversation\/advice-active"/);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("restarts a persisted failed advice turn through the same-origin product route", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };

  try {
    const retry = await fetch(`${ctx.homeInboxHttp.origin}/conversation/advice-failed/retry`, {
      method: "POST",
      headers,
      body: "",
      redirect: "manual",
    });
    assert.equal(retry.status, 303);
    assert.equal(retry.headers.get("location"), "/conversation/advice-retry");
    assert.deepEqual((ctx.homeInbox as unknown as StructuredAdviceInbox).retried, ["advice-failed"]);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("keeps the Host Shell fixed while a registered view provider supplies ordinary route content", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const rendered: Array<{ route: string; reviewCounts?: unknown; proposalId?: string }> = [];
  const immutableInputs: boolean[] = [];
  const layout: ProductViewProvider = {
    id: "test.layout",
    label: "测试视图",
    renderContent(model, input) {
      const legacyKeys = ["reviews", "confirmations", "home", "turn"].filter((key) => key in model);
      assert.deepEqual(legacyKeys, []);
      immutableInputs.push(Object.isFrozen(model), Object.isFrozen(input), Object.isFrozen(input.reviewCounts));
      try {
        (model as { runtimeConfirmationCount: number }).runtimeConfirmationCount = 99;
      } catch {
        // The Host snapshot is immutable at runtime.
      }
      try {
        (input.reviewCounts as { runtimeConfirmations: number }).runtimeConfirmations = 99;
      } catch {
        // Nested provider context is immutable at runtime.
      }
      rendered.push({ route: input.route, reviewCounts: input.reviewCounts, proposalId: input.proposalId });
      return `<section data-product-route="${input.route}"><h1>${input.route}</h1></section>`;
    },
  };
  const options: ProposalInboxHttpOptions = {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    viewProviders: [layout],
    defaultViewId: layout.id,
  };
  const fiber = await ctx.plugin(ProposalInboxHttpService, options);

  try {
    for (const route of ["/home", "/conversation", "/review-center", "/activity", "/control", "/settings", "/onboarding"]) {
      const response = await fetch(`${ctx.homeInboxHttp.origin}${route}`, { headers: { authorization } });
      assert.equal(response.status, 200, route);
      const html = await response.text();
      assert.match(html, new RegExp(`data-product-route="${route.slice(1)}"`));
      assert.match(html, /class="product-shell"/);
      assert.match(html, /aria-label="家庭导航"/);
      assert.match(html, /data-badge="runtime" data-count="2">2<\/span>/, route);
      assert.match(html, /data-badge="proposal" data-count="3\/5">3<\/span>/, route);
      assert.ok((html.match(/<header/g) ?? []).length <= 1);
      assert.equal(html.includes('class="skip-link"'), false);
    }
    assert.deepEqual(rendered.map((entry) => entry.route), [
      "home", "conversation", "review-center", "activity", "control", "settings", "onboarding",
    ]);
    for (const entry of rendered) assert.deepEqual(entry.reviewCounts, {
      runtimeConfirmations: 2,
      persistentProposals: 3,
    }, entry.route);
    assert.equal(immutableInputs.every(Boolean), true);
    assert.equal(JSON.stringify(rendered[2]?.reviewCounts ?? {}).includes("total"), false);

    const voice = await fetch(`${ctx.homeInboxHttp.origin}/voice`, { headers: { authorization } });
    assert.equal(voice.status, 200);
    const voiceHtml = await voice.text();
    assert.match(voiceHtml, /data-badge="runtime" data-count="2">2<\/span>/);
    assert.match(voiceHtml, /data-badge="proposal" data-count="3\/5">3<\/span>/);

    const selectedProposal = await fetch(`${ctx.homeInboxHttp.origin}/review-center?proposal=proposal-1`, {
      headers: { authorization },
    });
    assert.equal(selectedProposal.status, 200);
    const selectedProposalHtml = await selectedProposal.text();
    assert.equal(rendered.at(-1)?.proposalId, "proposal-1");
    assert.match(selectedProposalHtml, /href="\/review-center\?proposal=proposal-1&amp;view=test\.layout"/);

    const root = await fetch(`${ctx.homeInboxHttp.origin}/`, {
      headers: { authorization },
      redirect: "manual",
    });
    assert.equal(root.status, 303);
    assert.equal(root.headers.get("location"), "/home");

    const legacy = await fetch(`${ctx.homeInboxHttp.origin}/control-center`, {
      headers: { authorization },
      redirect: "manual",
    });
    assert.equal(legacy.status, 404);

    const css = await fetch(`${ctx.homeInboxHttp.origin}/assets/product.css`, { headers: { authorization } });
    assert.equal(css.status, 200);
    assert.match(await css.text(), /\.product-safety-banner/);
    const js = await fetch(`${ctx.homeInboxHttp.origin}/assets/product.js`, { headers: { authorization } });
    assert.equal(js.status, 200);
    const jsText = await js.text();
    assert.match(jsText, /data-runtime-countdown/);
    assert.match(jsText, /data-host-view-menu/);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("registers a data-only recipe provider while the Host keeps semantic fallback pages", async () => {
  const recipe = {
    apiVersion: "hob.view.recipe/v1",
    id: "community.review-first",
    title: "先看决定",
    pages: [{
      route: "overview",
      layout: "split",
      slots: [
        { slot: "overview.header", width: "full" },
        { slot: "overview.review-summary", width: "half" },
        { slot: "overview.spaces", width: "half" },
        { slot: "overview.composer", width: "full" },
      ],
    }],
  };
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    viewRecipes: [recipe],
  });
  try {
    const home = await fetch(`${ctx.homeInboxHttp.origin}/home?view=community.review-first`, {
      headers: { authorization },
    });
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.match(homeHtml, /data-view-provider="community\.review-first"/);
    assert.match(homeHtml, /data-recipe-provider="community\.review-first"/);
    assert.match(homeHtml, /先看决定/);
    assert.match(homeHtml, /data-badge="runtime" data-count="2">2<\/span>/);
    assert.match(homeHtml, /data-badge="proposal" data-count="3\/5">3<\/span>/);

    const reviews = await fetch(`${ctx.homeInboxHttp.origin}/review-center?view=community.review-first`, {
      headers: { authorization },
    });
    assert.equal(reviews.status, 200);
    const reviewHtml = await reviews.text();
    assert.match(reviewHtml, /data-view-provider="community\.review-first"/);
    assert.doesNotMatch(reviewHtml, /data-recipe-layout=/);
    assert.match(reviewHtml, /需要你决定的事/);
    assert.match(reviewHtml, /等待你放行/);
    assert.match(reviewHtml, /给家的建议/);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("admits only bounded conformant recipe contributions before opening the product listener", async () => {
  const marker = "private-layout-marker";
  const invalidContext = new Context();
  const invalidInbox = await invalidContext.plugin(StructuredAdviceInbox);
  await assert.rejects(async () => {
    await invalidContext.plugin(ProposalInboxHttpService, {
      port: 0,
      authenticate: createInboxBasicAuthenticator(token),
      principal: adminPrincipal,
      viewRecipes: [{
        apiVersion: "hob.view.recipe/v1",
        id: "community.invalid",
        title: marker,
        pages: [{
          route: "overview",
          layout: "stack",
          slots: [{ slot: "overview.spaces", width: "full" }],
        }],
      }],
    });
  }, (error) => error instanceof TypeError
    && error.message === "Product view recipe conformance failed"
    && !error.message.includes(marker));
  await invalidInbox.dispose();
  await invalidContext.fiber.dispose();

  const wideContext = new Context();
  const wideInbox = await wideContext.plugin(StructuredAdviceInbox);
  await assert.rejects(async () => {
    await wideContext.plugin(ProposalInboxHttpService, {
      port: 0,
      authenticate: createInboxBasicAuthenticator(token),
      principal: adminPrincipal,
      viewRecipes: Array.from({ length: 17 }, (_, index) => ({
        apiVersion: "hob.view.recipe/v1",
        id: `community.layout-${index}`,
        title: `家庭布局 ${index + 1}`,
        pages: [{
          route: "overview",
          layout: "stack",
          slots: [{ slot: "overview.header", width: "full" }],
        }],
      })),
    });
  }, /at most 16 recipe contributions/i);
  await wideInbox.dispose();
  await wideContext.fiber.dispose();
});

test("uses the bundled life provider for canonical routes when no preference is stored", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });

  try {
    const home = await fetch(`${ctx.homeInboxHttp.origin}/home`, { headers: { authorization } });
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.match(homeHtml, /class="product-shell"/);
    assert.match(homeHtml, /href="\/assets\/product\.css"/);
    assert.equal(homeHtml.includes("Control center"), false);
    assert.equal(homeHtml.includes("Overview"), false);
    assert.equal(homeHtml.includes("Inbox"), false);
    assert.equal(homeHtml.includes("Voice lab"), false);
    assert.match(homeHtml, /客厅/);
    assert.match(homeHtml, /顶灯 · 开/);

    const activity = await fetch(`${ctx.homeInboxHttp.origin}/activity`, { headers: { authorization } });
    assert.equal(activity.status, 200);
    const activityHtml = await activity.text();
    assert.match(activityHtml, /03:00 米家桥接更新/);
    assert.match(activityHtml, /等待放行到期/);
    assert.match(activityHtml, /动作未执行/);

    const reviewCenter = await fetch(`${ctx.homeInboxHttp.origin}/review-center`, { headers: { authorization } });
    assert.equal(reviewCenter.status, 200);
    const reviewHtml = await reviewCenter.text();
    assert.match(reviewHtml, /data-badge="runtime"/);
    assert.match(reviewHtml, /data-badge="proposal"/);
    assert.equal(reviewHtml.includes("data-badge=\"total\""), false);

    const conversation = await fetch(`${ctx.homeInboxHttp.origin}/conversation/advice-stream`, {
      headers: { authorization },
    });
    assert.equal(conversation.status, 200);
    const conversationHtml = await conversation.text();
    assert.doesNotMatch(conversationHtml, /data-advice-events=/);
    assert.doesNotMatch(conversationHtml, /action="\/conversation\/advice-stream\/stop"/);
    assert.match(conversationHtml, /先按日光和最早、最晚边界试用一周/);
    assert.match(conversationHtml, /最近两周有 4 次手动调整/);

    const productJs = await fetch(`${ctx.homeInboxHttp.origin}/assets/product.js`, {
      headers: { authorization },
    });
    const productJsText = await productJs.text();
    assert.match(productJsText, /new EventSource/);
    assert.match(productJsText, /progress/);
    assert.match(productJsText, /delta/);
    assert.match(productJsText, /answer_delta/);
    assert.match(productJsText, /inspecting_home/);
    assert.match(productJsText, /cancelled/);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("switches built-in view providers without changing the semantic route and recovers to the safe view", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });

  try {
    const life = await fetch(`${ctx.homeInboxHttp.origin}/home`, { headers: { authorization } });
    assert.equal(life.status, 200);
    const lifeHtml = await life.text();
    assert.match(lifeHtml, /data-view-provider="builtin\.life"/);
    assert.match(lifeHtml, /aria-label="切换家庭视图"/);
    assert.match(lifeHtml, /生活视图/);

    const control = await fetch(`${ctx.homeInboxHttp.origin}/home?view=builtin.control`, {
      headers: { authorization },
    });
    assert.equal(control.status, 200);
    const preference = control.headers.get("set-cookie") ?? "";
    assert.match(preference, /hob_view_session=builtin\.control/);
    assert.match(preference, /HttpOnly/);
    assert.doesNotMatch(preference, /Max-Age/);
    const controlHtml = await control.text();
    assert.match(controlHtml, /data-route="overview"[^>]*data-view-provider="builtin\.control"/);
    assert.match(controlHtml, /<p class="product-kicker">控制视图<\/p>/);
    assert.match(controlHtml, /data-control-density="dense"/);

    const conversation = await fetch(`${ctx.homeInboxHttp.origin}/conversation`, {
      headers: { authorization, cookie: "hob_view_session=builtin.control; hob_view_default=builtin.life" },
    });
    assert.equal(conversation.status, 200);
    const conversationHtml = await conversation.text();
    assert.match(conversationHtml, /data-route="conversation"[^>]*data-view-provider="builtin\.control"/);
    assert.match(conversationHtml, /和家庭助手对话/);

    const settings = await fetch(`${ctx.homeInboxHttp.origin}/settings`, {
      headers: { authorization, cookie: "hob_view_session=builtin.control; hob_view_default=builtin.life" },
    });
    const settingsHtml = await settings.text();
    assert.match(settingsHtml, /data-view-choice="builtin\.control" data-state="active"/);
    assert.match(settingsHtml, /data-view-choice="builtin\.life"[^>]*data-default-state="default"/);

    const recovered = await fetch(`${ctx.homeInboxHttp.origin}/home?view=missing.provider`, {
      headers: { authorization },
    });
    assert.equal(recovered.status, 200);
    const recoveredHtml = await recovered.text();
    assert.match(recoveredHtml, /data-view-provider="builtin\.life"/);
    assert.match(recoveredHtml, /这个视图当前不可用，已恢复生活视图/);

    const repairedPreference = await fetch(`${ctx.homeInboxHttp.origin}/home`, {
      headers: { authorization, cookie: "hob_view_session=plugin.unavailable" },
    });
    assert.match(repairedPreference.headers.get("set-cookie") ?? "", /hob_view_session=builtin\.life/);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("persists and resets a device default view through the Host-owned settings command", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };

  try {
    const saved = await fetch(`${ctx.homeInboxHttp.origin}/settings/view-default`, {
      method: "POST",
      headers,
      body: "mode=set&viewId=builtin.control",
      redirect: "manual",
    });
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.get("location"), "/settings");
    assert.match(saved.headers.get("set-cookie") ?? "", /hob_view_default=builtin\.control/);
    assert.match(saved.headers.get("set-cookie") ?? "", /hob_view_session=;/);
    assert.match(saved.headers.get("set-cookie") ?? "", /Max-Age=31536000/);

    const reset = await fetch(`${ctx.homeInboxHttp.origin}/settings/view-default`, {
      method: "POST",
      headers,
      body: "mode=reset",
      redirect: "manual",
    });
    assert.equal(reset.status, 303);
    assert.match(reset.headers.get("set-cookie") ?? "", /hob_view_default=;/);
    assert.match(reset.headers.get("set-cookie") ?? "", /hob_view_session=;/);

    const invalid = await fetch(`${ctx.homeInboxHttp.origin}/settings/view-default`, {
      method: "POST",
      headers,
      body: "mode=set&viewId=plugin.missing",
      redirect: "manual",
    });
    assert.equal(invalid.status, 400);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }

  const sharedCtx = new Context();
  const sharedInboxFiber = await sharedCtx.plugin(StructuredAdviceInbox);
  const sharedFiber = await sharedCtx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: childSharedPrincipal,
  });
  try {
    const denied = await fetch(`${sharedCtx.homeInboxHttp.origin}/settings/view-default`, {
      method: "POST",
      headers: {
        authorization,
        origin: sharedCtx.homeInboxHttp.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "mode=set&viewId=builtin.control",
      redirect: "manual",
    });
    assert.equal(denied.status, 403);

    const presentationDenied = await fetch(`${sharedCtx.homeInboxHttp.origin}/settings/view-presentation`, {
      method: "POST",
      headers: {
        authorization,
        origin: sharedCtx.homeInboxHttp.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "mode=set&providerId=builtin.control&key=rowDensity&value=compact",
      redirect: "manual",
    });
    assert.equal(presentationDenied.status, 403);
  } finally {
    await sharedFiber.dispose();
    await sharedInboxFiber.dispose();
    await sharedCtx.fiber.dispose();
  }
});

test("persists only declared provider presentation choices through the Host settings boundary", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };

  try {
    const initial = await fetch(`${ctx.homeInboxHttp.origin}/settings?view=builtin.control`, {
      headers: { authorization },
    });
    const initialHtml = await initial.text();
    assert.match(initialHtml, /action="\/settings\/view-presentation"/);
    assert.match(initialHtml, /name="key" value="rowDensity"/);
    assert.match(initialHtml, /name="value" value="comfortable" checked/);

    const saved = await fetch(`${ctx.homeInboxHttp.origin}/settings/view-presentation`, {
      method: "POST",
      headers,
      body: "mode=set&providerId=builtin.control&key=rowDensity&value=compact",
      redirect: "manual",
    });
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.get("location"), "/settings?view=builtin.control");
    const preferenceCookie = saved.headers.get("set-cookie") ?? "";
    assert.match(preferenceCookie, /hob_view_pref_builtin\.control_rowDensity=compact/);
    assert.match(preferenceCookie, /HttpOnly/);

    const control = await fetch(`${ctx.homeInboxHttp.origin}/control?view=builtin.control`, {
      headers: { authorization, cookie: "hob_view_pref_builtin.control_rowDensity=compact" },
    });
    assert.match(await control.text(), /data-control-row-density="compact"/);

    const tampered = await fetch(`${ctx.homeInboxHttp.origin}/settings?view=builtin.control`, {
      headers: { authorization, cookie: "hob_view_pref_builtin.control_rowDensity=unknown" },
    });
    assert.match(await tampered.text(), /name="value" value="comfortable" checked/);

    for (const body of [
      "mode=set&providerId=builtin.control&key=rowDensity&value=unknown",
      "mode=set&providerId=builtin.control&key=unknown&value=compact",
      "mode=set&providerId=plugin.missing&key=rowDensity&value=compact",
      "mode=set&providerId=builtin.control&key=rowDensity&key=rowDensity&value=compact",
      "mode=reset&providerId=builtin.control&key=rowDensity",
    ]) {
      const invalid = await fetch(`${ctx.homeInboxHttp.origin}/settings/view-presentation`, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
      });
      assert.equal(invalid.status, 400, body);
    }

    const reset = await fetch(`${ctx.homeInboxHttp.origin}/settings/view-presentation`, {
      method: "POST",
      headers,
      body: "mode=reset&providerId=builtin.control",
      redirect: "manual",
    });
    assert.equal(reset.status, 303);
    assert.match(reset.headers.get("set-cookie") ?? "", /hob_view_pref_builtin\.control_rowDensity=;/);
    assert.match(reset.headers.get("set-cookie") ?? "", /Max-Age=0/);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("applies the declared life-view information focus without changing household truth", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(PresentationPreferenceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  try {
    const focused = await fetch(`${ctx.homeInboxHttp.origin}/home?view=builtin.life`, {
      headers: { authorization },
    });
    const focusedHtml = await focused.text();
    assert.match(focusedHtml, /空间 4/);
    assert.doesNotMatch(focusedHtml, /空间 5/);
    assert.match(focusedHtml, /建议一/);
    assert.doesNotMatch(focusedHtml, /建议二/);

    const expanded = await fetch(`${ctx.homeInboxHttp.origin}/home?view=builtin.life`, {
      headers: {
        authorization,
        cookie: "hob_view_pref_builtin.life_overviewFocus=expanded",
      },
    });
    const expandedHtml = await expanded.text();
    assert.match(expandedHtml, /空间 5/);
    assert.match(expandedHtml, /建议二/);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("recovers from a provider render failure inside the Host boundary", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    defaultViewId: "plugin.crash",
    viewProviders: [{
      id: "plugin.crash",
      label: "故障视图",
      renderContent() { throw new Error("provider_failed"); },
    }],
  });

  try {
    const response = await fetch(`${ctx.homeInboxHttp.origin}/home`, { headers: { authorization } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie") ?? "", /hob_view_session=builtin\.life/);
    const html = await response.text();
    assert.match(html, /data-view-provider="builtin\.life"/);
    assert.match(html, /这个视图当前不可用，已恢复生活视图/);
    assert.match(html, /<p class="product-kicker">生活视图<\/p>/);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("keeps governed review intents identical across both built-in providers", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(RuntimeDecisionInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });

  try {
    const actions = [] as string[][];
    for (const view of ["builtin.life", "builtin.control"] as const) {
      const response = await fetch(`${ctx.homeInboxHttp.origin}/review-center?view=${view}`, {
        headers: { authorization },
      });
      assert.equal(response.status, 200);
      const html = await response.text();
      actions.push([...html.matchAll(/<form[^>]+action="([^"]+)"/g)].map((match) => match[1]!).sort());
    }
    assert.deepEqual(actions[0], actions[1]);
    assert.ok(actions[0]?.includes("/runtime-confirmations/runtime-1/approve"));
    assert.ok(actions[0]?.includes("/runtime-confirmations/runtime-1/reject"));
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("keeps the complete control connection state machine identical across built-in providers", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(ControlInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const inbox = ctx.homeInbox as unknown as ControlInbox;
  const expectations: Readonly<Record<ProductConnectionState, "available" | "waiting">> = {
    connected: "available",
    quiet: "available",
    connecting: "waiting",
    disconnected: "waiting",
    unknown: "waiting",
  };

  try {
    for (const [state, availability] of Object.entries(expectations) as Array<[ProductConnectionState, "available" | "waiting"]>) {
      inbox.connectionState = state;
      const mainByView: string[] = [];
      for (const view of ["builtin.life", "builtin.control"] as const) {
        const response = await fetch(`${ctx.homeInboxHttp.origin}/control?view=${view}`, {
          headers: { authorization },
        });
        assert.equal(response.status, 200, `${state}:${view}`);
        const html = await response.text();
        assert.match(html, new RegExp(`data-connection-state="${state}"`), `${state}:${view}`);
        assert.match(html, new RegExp(`data-view-provider="${view}"`), `${state}:${view}`);
        assert.match(html, new RegExp(`data-control-availability="${availability}"`), `${state}:${view}`);
        assert.equal((html.match(/class="product-host-view-switcher"/g) ?? []).length, 1, `${state}:${view}`);
        assert.equal((html.match(/data-badge="runtime"/g) ?? []).length, 2, `${state}:${view}`);
        assert.equal((html.match(/data-badge="proposal"/g) ?? []).length, 2, `${state}:${view}`);
        assert.equal(/<button[^>]+disabled/.test(html), availability === "waiting", `${state}:${view}`);
        const main = /<main class="product-main" id="product-main">([\s\S]+)<\/main>/.exec(html)?.[1];
        assert.ok(main, `${state}:${view}`);
        mainByView.push(main);
      }
      assert.equal(mainByView[0], mainByView[1], state);
    }
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("submits an explicit correction for a completed conversation through the authenticated typed seam", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(CorrectionAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adultAdminPrincipal,
  });
  const origin = ctx.homeInboxHttp.origin;
  const headers = {
    authorization,
    origin,
    "content-type": "application/x-www-form-urlencoded",
  };
  try {
    const conversation = await fetch(`${origin}/conversation/advice-stream`, { headers: { authorization } });
    assert.equal(conversation.status, 200);
    assert.match(await conversation.text(), /name="correctionType" value="household_fact"/);

    const crossOrigin = await fetch(`${origin}/conversation/advice-stream/correction`, {
      method: "POST",
      headers: { ...headers, origin: "http://attacker.invalid" },
      body: "correctionType=household_preference&correction=%E5%AE%89%E9%9D%99&idempotencyKey=advice-stream%3Acorrection",
      redirect: "manual",
    });
    assert.equal(crossOrigin.status, 403);

    const invalidType = await fetch(`${origin}/conversation/advice-stream/correction`, {
      method: "POST",
      headers,
      body: "correctionType=guess&correction=%E5%AE%89%E9%9D%99&idempotencyKey=advice-stream%3Acorrection",
      redirect: "manual",
    });
    assert.equal(invalidType.status, 400);

    const accepted = await fetch(`${origin}/conversation/advice-stream/correction`, {
      method: "POST",
      headers,
      body: "correctionType=household_preference&correction=%E5%8D%A7%E5%AE%A4%E6%99%9A%E4%B8%8A%E4%BF%9D%E6%8C%81%E5%AE%89%E9%9D%99&idempotencyKey=advice-stream%3Acorrection",
      redirect: "manual",
    });
    assert.equal(accepted.status, 303);
    assert.equal(accepted.headers.get("location"), "/conversation/advice-stream");
    assert.deepEqual((ctx.homeInbox as unknown as CorrectionAdviceInbox).corrections, [{
      adviceId: "advice-stream",
      actor: adultAdminPrincipal,
      correctionType: "household_preference",
      correction: "卧室晚上保持安静",
      idempotencyKey: "advice-stream:correction",
    }]);
    const completedAgain = await fetch(`${origin}/conversation/advice-stream`, { headers: { authorization } });
    const completedHtml = await completedAgain.text();
    assert.match(completedHtml, /已更新/);
    assert.match(completedHtml, /SOUL/);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("keeps correction submission fail-closed when the turn is active or the owner is unavailable", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(IncompleteCorrectionInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adultAdminPrincipal,
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };
  try {
    const active = await fetch(`${ctx.homeInboxHttp.origin}/conversation/advice-stream/correction`, {
      method: "POST",
      headers,
      body: "correctionType=household_fact&correction=%E6%B4%BB%E5%8A%A8%E5%AF%B9%E8%AF%9D&idempotencyKey=active-correction",
    });
    assert.equal(active.status, 409);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }

  const unavailableContext = new Context();
  const unavailableInbox = await unavailableContext.plugin(StubInbox);
  const unavailableFiber = await unavailableContext.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adultAdminPrincipal,
  });
  try {
    const unavailable = await fetch(`${unavailableContext.homeInboxHttp.origin}/conversation/advice-stream/correction`, {
      method: "POST",
      headers: {
        authorization,
        origin: unavailableContext.homeInboxHttp.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "correctionType=household_fact&correction=%E6%B2%A1%E6%9C%89%E6%89%80%E6%9C%89%E8%80%85&idempotencyKey=owner-missing",
    });
    assert.equal(unavailable.status, 503);
    assert.match(await unavailable.text(), /unavailable/i);
  } finally {
    await unavailableFiber.dispose();
    await unavailableInbox.dispose();
    await unavailableContext.fiber.dispose();
  }
});

test("resumes the persisted onboarding checkpoint and continues only valid steps", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  const onboarding = {
    state: { step: 4, complete: false, status: "ready" as const, title: "添加家庭成员", body: "确认谁可以在家里做决定。" },
    calls: [] as unknown[],
    getState() { return this.state; },
    submit(command: unknown, actor: unknown) {
      this.calls.push({ command, actor });
      const value = command as { step: number };
      this.state = value.step === 8
        ? { step: 8, complete: true, status: "complete" as const, title: "问第一个问题", body: "进入真实对话。" }
        : { step: (value.step + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, complete: false, status: "ready" as const, title: "下一步", body: "继续。" };
      return {
        state: this.state,
        outcome: "completed" as const,
        complete: this.state.complete,
        completedStep: value.step as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
        ...(value.step === 8 ? { adviceId: "advice-onboarding-1" } : {}),
      };
    },
  };
  const fiber = await ctx.plugin(ProposalInboxHttpService, ({
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    onboarding,
  } as unknown) as never);
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };

  try {
    const resumed = await fetch(`${ctx.homeInboxHttp.origin}/onboarding`, { headers: { authorization } });
    assert.equal(resumed.status, 200);
    const resumedHtml = await resumed.text();
    assert.match(resumedHtml, /第 4 步，共 8 步/);
    assert.match(resumedHtml, /添加家庭成员/);

    const wrongContentType = await fetch(`${ctx.homeInboxHttp.origin}/onboarding/continue`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ step: 4 }),
      redirect: "manual",
    });
    assert.equal(wrongContentType.status, 415);

    const invalid = await fetch(`${ctx.homeInboxHttp.origin}/onboarding/continue`, {
      method: "POST",
      headers,
      body: "step=9",
      redirect: "manual",
    });
    assert.equal(invalid.status, 400);

    const continued = await fetch(`${ctx.homeInboxHttp.origin}/onboarding/continue`, {
      method: "POST",
      headers,
      body: "step=4&memberName=%E5%B0%8F%E9%9B%A8",
      redirect: "manual",
    });
    assert.equal(continued.status, 303);
    assert.equal(continued.headers.get("location"), "/onboarding");
    assert.deepEqual(onboarding.calls, [{
      command: { step: 4, kind: "bind_private_device", memberName: "小雨", role: "adult_admin" },
      actor: adminPrincipal,
    }]);

    const unknownField = await fetch(`${ctx.homeInboxHttp.origin}/onboarding/continue`, {
      method: "POST",
      headers,
      body: "step=5&token=must-not-be-stored",
      redirect: "manual",
    });
    assert.equal(unknownField.status, 400);

    const completed = await fetch(`${ctx.homeInboxHttp.origin}/onboarding/continue`, {
      method: "POST",
      headers,
      body: "step=8&firstQuestion=%E7%AA%97%E5%B8%98%E4%B8%BA%E4%BB%80%E4%B9%88%E6%97%A9%E4%B8%8A%E6%89%8D%E5%BC%80%EF%BC%9F",
      redirect: "manual",
    });
    assert.equal(completed.status, 303);
    assert.equal(completed.headers.get("location"), "/conversation/advice-onboarding-1");
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("projects onboarding identity and real choices across every canonical product route", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  const onboarding = {
    getState: () => ({
      step: 2,
      complete: false,
      status: "ready" as const,
      title: "把已有的家接进来",
      body: "请先完成只读同步。",
      household: { householdName: "小海的家", agentName: "阿灶" },
      choices: {
        status: "available" as const,
        bridges: [{ id: "xiaomi-main", label: "小米家庭", description: "已完成只读同步", selectable: true }],
        capabilities: [{ id: "cap-lamp", label: "客厅主灯 · 灯光", bridgeId: "xiaomi-main", bridgeLabel: "小米家庭", suggestedPolicyClass: "direct" as const }],
      },
    }),
    submit: () => ({ state: { step: 3, complete: false, status: "ready" as const, title: "确认地图", body: "继续。" }, outcome: "completed" as const, complete: false, completedStep: 2 as const }),
  };
  const fiber = await ctx.plugin(ProposalInboxHttpService, ({
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    onboarding,
  } as unknown) as never);
  try {
    for (const path of ["/home", "/conversation", "/review-center", "/activity", "/control", "/settings", "/onboarding", "/voice"] as const) {
      const response = await fetch(`${ctx.homeInboxHttp.origin}${path}`, { headers: { authorization } });
      assert.equal(response.status, 200, path);
      const html = await response.text();
      assert.match(html, /小海的家/, path);
      assert.match(html, /阿灶/, path);
    }
    const onboardingHtml = await (await fetch(`${ctx.homeInboxHttp.origin}/onboarding`, { headers: { authorization } })).text();
    assert.match(onboardingHtml, /value="xiaomi-main"/);
    assert.doesNotMatch(onboardingHtml, /home-assistant/);

    const headers = {
      authorization,
      origin: ctx.homeInboxHttp.origin,
      "content-type": "application/x-www-form-urlencoded",
    };
    const schedule = await fetch(`${ctx.homeInboxHttp.origin}/onboarding/continue`, {
      method: "POST",
      headers,
      body: "step=7&observationEnabled=enabled&observationInterval=720&quietHoursStart=22%3A00&quietHoursEnd=08%3A00",
      redirect: "manual",
    });
    assert.equal(schedule.status, 303);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("HTTP keeps onboarding blocked when the Hub coordinator is absent", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  try {
    const resumed = await fetch(`${ctx.homeInboxHttp.origin}/onboarding`, { headers: { authorization } });
    assert.equal(resumed.status, 200);
    assert.match(await resumed.text(), /首次设置暂不可用/);
    const continued = await fetch(`${ctx.homeInboxHttp.origin}/onboarding/continue`, {
      method: "POST",
      headers: {
        authorization,
        origin: ctx.homeInboxHttp.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "step=1&agentName=%E5%8A%A9%E6%89%8B&householdName=%E5%AE%B6",
      redirect: "manual",
    });
    assert.equal(continued.status, 503);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("uses the canonical conversation write routes only from the exact local origin", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };

  try {
    const crossOriginStart = await fetch(`${ctx.homeInboxHttp.origin}/conversation`, {
      method: "POST",
      headers: { ...headers, origin: "http://attacker.invalid" },
      body: "question=What+changed%3F",
      redirect: "manual",
    });
    assert.equal(crossOriginStart.status, 403);

    const accepted = await fetch(`${ctx.homeInboxHttp.origin}/conversation`, {
      method: "POST",
      headers,
      body: "question=What+changed%3F",
      redirect: "manual",
    });
    assert.equal(accepted.status, 303);
    assert.equal(accepted.headers.get("location"), "/conversation/advice-stream");

    const crossOriginStop = await fetch(`${ctx.homeInboxHttp.origin}/conversation/advice-stream/stop`, {
      method: "POST",
      headers: { ...headers, origin: "http://attacker.invalid" },
      body: "",
      redirect: "manual",
    });
    assert.equal(crossOriginStop.status, 403);

    const stopped = await fetch(`${ctx.homeInboxHttp.origin}/conversation/advice-stream/stop`, {
      method: "POST",
      headers,
      body: "",
      redirect: "manual",
    });
    assert.equal(stopped.status, 303);
    assert.equal(stopped.headers.get("location"), "/conversation/advice-stream");
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("reconnects the canonical conversation stream across accepted progress delta completion and cancellation", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(GenericAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });

  try {
    const resumed = await fetch(`${ctx.homeInboxHttp.origin}/conversation/advice-stream/events`, {
      headers: { authorization, "last-event-id": "1" },
    });
    assert.equal(resumed.status, 200);
    const resumedBody = await resumed.text();
    assert.match(resumedBody, /id: 2\nevent: progress\ndata: \{"stage":"inspecting_home"\}\n\n/);
    assert.match(resumedBody, /id: 3\nevent: delta\ndata: \{"text":"窗帘建议"\}\n\n/);
    assert.match(resumedBody, /id: 4\nevent: completed\ndata: \{\}\n\n/);

    const cancelledContext = new Context();
    const cancelledInbox = await cancelledContext.plugin(CancelledAdviceInbox);
    const cancelledFiber = await cancelledContext.plugin(ProposalInboxHttpService, {
      port: 0,
      authenticate: createInboxBasicAuthenticator(token),
      principal: adminPrincipal,
    });
    try {
      const cancelled = await fetch(`${cancelledContext.homeInboxHttp.origin}/conversation/advice-stream/events`, {
        headers: { authorization, "last-event-id": "2" },
      });
      assert.equal(cancelled.status, 200);
      assert.match(await cancelled.text(), /id: 3\nevent: cancelled\ndata: \{\}\n\n/);
    } finally {
      await cancelledFiber.dispose();
      await cancelledInbox.dispose();
      await cancelledContext.fiber.dispose();
    }
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("rejects short authentication secrets before opening a listener", () => {
  assert.throws(() => createInboxBasicAuthenticator("too-short"), /at least 32/);
});

test("keeps durable layout authoring private while previewing one exact inert revision", async () => {
  const records = new Map<string, {
    draftId: string;
    ownerPrincipalId: string;
    revision: number;
    label: string;
    source: string;
    updatedAt: string;
  }>();
  type FakePublication = {
    generationId: string;
    recipeId: string;
    title: string;
    draftId: string;
    draftRevision: number;
    recipeDigest: `sha256:${string}`;
    source: string;
    publishedBy: string;
    publishedAt: string;
  };
  type FakePublicationEvent = {
    eventId: string;
    kind: "published" | "rolled_back" | "deactivated";
    recipeId: string;
    generationId: string;
    previousGenerationId?: string;
    actorPrincipalId: string;
    occurredAt: string;
  };
  const publicationHistory = new Map<string, FakePublication[]>();
  const activePublications = new Map<string, FakePublication>();
  const publicationEvents: FakePublicationEvent[] = [];
  let nextGeneration = 0;
  const drafts = {
    create(input: { ownerPrincipalId: string; label: string; source: string }) {
      const value = Object.freeze({
        draftId: "draft-1",
        ownerPrincipalId: input.ownerPrincipalId,
        revision: 1,
        label: input.label,
        source: input.source,
        updatedAt: "2026-08-22T01:00:00.000Z",
      });
      records.set(value.draftId, value);
      return value;
    },
    update(input: { draftId: string; ownerPrincipalId: string; expectedRevision: number; label: string; source: string }) {
      const current = records.get(input.draftId);
      if (current === undefined) throw Object.assign(new Error("hidden"), { code: "not_found" });
      if (current.revision !== input.expectedRevision) throw Object.assign(new Error("hidden"), { code: "revision_conflict" });
      const value = Object.freeze({ ...current, revision: current.revision + 1, label: input.label, source: input.source });
      records.set(value.draftId, value);
      return value;
    },
    remove(input: { draftId: string; expectedRevision: number }) {
      const current = records.get(input.draftId);
      if (current === undefined) throw Object.assign(new Error("hidden"), { code: "not_found" });
      if (current.revision !== input.expectedRevision) throw Object.assign(new Error("hidden"), { code: "revision_conflict" });
      records.delete(input.draftId);
    },
    read(draftId: string, ownerPrincipalId: string) {
      const value = records.get(draftId);
      return value?.ownerPrincipalId === ownerPrincipalId ? value : undefined;
    },
    list(ownerPrincipalId: string) {
      return [...records.values()].filter((value) => value.ownerPrincipalId === ownerPrincipalId).map(({ source: _source, ownerPrincipalId: _owner, ...summary }) => summary);
    },
    publish(input: { draftId: string; ownerPrincipalId: string; expectedRevision: number; actorPrincipalId: string }) {
      const draft = records.get(input.draftId);
      if (draft === undefined) throw Object.assign(new Error("hidden"), { code: "not_found" });
      if (draft.revision !== input.expectedRevision) throw Object.assign(new Error("hidden"), { code: "revision_conflict" });
      const parsed = JSON.parse(draft.source) as { id: string; title: string };
      const report = runProductViewRecipeConformance(parsed);
      if (!report.passed || report.recipeDigest === undefined) throw Object.assign(new Error("hidden"), { code: "recipe_invalid" });
      const value = Object.freeze({
        generationId: `generation-${++nextGeneration}`,
        recipeId: parsed.id,
        title: parsed.title,
        draftId: draft.draftId,
        draftRevision: draft.revision,
        recipeDigest: report.recipeDigest,
        source: draft.source,
        publishedBy: input.actorPrincipalId,
        publishedAt: "2026-08-22T02:00:00.000Z",
      });
      const history = publicationHistory.get(value.recipeId) ?? [];
      history.push(value);
      publicationHistory.set(value.recipeId, history);
      activePublications.set(value.recipeId, value);
      publicationEvents.push({
        eventId: `event-${publicationEvents.length + 1}`,
        kind: "published",
        recipeId: value.recipeId,
        generationId: value.generationId,
        actorPrincipalId: input.actorPrincipalId,
        occurredAt: value.publishedAt,
      });
      return value;
    },
    rollbackPublication(input: { recipeId: string; expectedGenerationId: string; actorPrincipalId: string }) {
      const current = activePublications.get(input.recipeId);
      const history = publicationHistory.get(input.recipeId) ?? [];
      if (current?.generationId !== input.expectedGenerationId) throw Object.assign(new Error("hidden"), { code: "publication_conflict" });
      const previous = history.at(-2);
      if (previous === undefined) throw Object.assign(new Error("hidden"), { code: "publication_conflict" });
      activePublications.set(input.recipeId, previous);
      publicationEvents.push({
        eventId: `event-${publicationEvents.length + 1}`,
        kind: "rolled_back",
        recipeId: input.recipeId,
        generationId: previous.generationId,
        previousGenerationId: current.generationId,
        actorPrincipalId: input.actorPrincipalId,
        occurredAt: "2026-08-22T02:01:00.000Z",
      });
      return previous;
    },
    deactivatePublication(input: { recipeId: string; expectedGenerationId: string; actorPrincipalId: string }) {
      const current = activePublications.get(input.recipeId);
      if (current?.generationId !== input.expectedGenerationId) throw Object.assign(new Error("hidden"), { code: "publication_conflict" });
      activePublications.delete(input.recipeId);
      publicationEvents.push({
        eventId: `event-${publicationEvents.length + 1}`,
        kind: "deactivated",
        recipeId: input.recipeId,
        generationId: current.generationId,
        actorPrincipalId: input.actorPrincipalId,
        occurredAt: "2026-08-22T02:02:00.000Z",
      });
    },
    listActivePublications() {
      return [...activePublications.values()];
    },
    canRollbackPublication(recipeId: string, generationId: string) {
      const history = publicationHistory.get(recipeId) ?? [];
      return activePublications.get(recipeId)?.generationId === generationId && history.length > 1;
    },
    listPublicationEvents() {
      return publicationEvents;
    },
  };
  const source = JSON.stringify({
    apiVersion: "hob.view.recipe/v1",
    id: "community.calm",
    title: "安静视图",
    pages: [{
      route: "overview",
      layout: "stack",
      slots: [{ slot: "overview.header", width: "full" }],
    }],
  });
  const sourceV2 = source.replace('"title":"安静视图"', '"title":"安静视图 2"');
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    viewRecipeDrafts: drafts,
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };
  try {
    const created = await fetch(`${ctx.homeInboxHttp.origin}/settings/layout-drafts`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ label: "我的安静视图", source, idempotencyKey: "create-draft-1" }),
      redirect: "manual",
    });
    assert.equal(created.status, 303);
    assert.equal(created.headers.get("location"), "/settings?layout=draft-1");

    const listing = await fetch(`${ctx.homeInboxHttp.origin}/settings`, { headers: { authorization } });
    const listingHtml = await listing.text();
    assert.match(listingHtml, /布局工作室/);
    assert.match(listingHtml, /我的安静视图/);
    assert.doesNotMatch(listingHtml, /community\.calm/);

    const editor = await fetch(`${ctx.homeInboxHttp.origin}/settings?layout=draft-1`, { headers: { authorization } });
    const editorHtml = await editor.text();
    assert.match(editorHtml, /name="source"/);
    assert.match(editorHtml, /community\.calm/);
    assert.match(editorHtml, /草稿版本 1/);

    const preview = await fetch(`${ctx.homeInboxHttp.origin}/settings?layout=draft-1&preview=1`, { headers: { authorization } });
    const previewHtml = await preview.text();
    assert.match(previewHtml, /data-layout-preview-revision="1"/);
    assert.match(previewHtml, /data-layout-preview-status="ready"/);
    assert.match(previewHtml, /<iframe[^>]+inert[^>]+data-layout-preview-canvas[^>]+sandbox/);
    assert.match(previewHtml, /sha256:[a-f0-9]{64}/);

    const updated = await fetch(`${ctx.homeInboxHttp.origin}/settings/layout-drafts/draft-1`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ expectedRevision: "1", label: "继续编辑", source: '{"apiVersion":' }),
      redirect: "manual",
    });
    assert.equal(updated.status, 303);
    const incompletePreview = await fetch(`${ctx.homeInboxHttp.origin}/settings?layout=draft-1&preview=1`, { headers: { authorization } });
    const incompleteHtml = await incompletePreview.text();
    assert.match(incompleteHtml, /data-layout-preview-revision="2"/);
    assert.match(incompleteHtml, /data-layout-preview-status="syntax_error"/);
    assert.match(incompleteHtml, /JSON 结构还未完整，草稿内容保持原样/);

    const stale = await fetch(`${ctx.homeInboxHttp.origin}/settings/layout-drafts/draft-1`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ expectedRevision: "1", label: "旧版本", source }),
      redirect: "manual",
    });
    assert.equal(stale.status, 303);
    assert.equal(stale.headers.get("location"), "/settings?layout=draft-1&layoutNotice=revision");
    const conflictPage = await fetch(`${ctx.homeInboxHttp.origin}${stale.headers.get("location")}`, { headers: { authorization } });
    const conflictHtml = await conflictPage.text();
    assert.match(conflictHtml, /data-layout-notice="revision"/);
    assert.match(conflictHtml, /已载入草稿的新版本/);
    assert.match(conflictHtml, /name="expectedRevision" value="2"/);

    const restored = await fetch(`${ctx.homeInboxHttp.origin}/settings/layout-drafts/draft-1`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ expectedRevision: "2", label: "可预览版本", source }),
      redirect: "manual",
    });
    assert.equal(restored.status, 303);

    const published = await fetch(`${ctx.homeInboxHttp.origin}/settings/layout-drafts/draft-1/publish`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ expectedRevision: "3" }),
      redirect: "manual",
    });
    assert.equal(published.status, 303);
    assert.equal(published.headers.get("location"), "/settings?layout=draft-1&layoutNotice=published");
    const publishedPage = await fetch(`${ctx.homeInboxHttp.origin}${published.headers.get("location")}`, { headers: { authorization } });
    const publishedHtml = await publishedPage.text();
    assert.match(publishedHtml, /布局版本已发布/);
    assert.match(publishedHtml, /href="\/settings\?view=community\.calm"/);
    assert.match(publishedHtml, /当前草稿版本已发布/);

    const fourth = await fetch(`${ctx.homeInboxHttp.origin}/settings/layout-drafts/draft-1`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ expectedRevision: "3", label: "第二个发布版", source: sourceV2 }),
      redirect: "manual",
    });
    assert.equal(fourth.status, 303);
    const republished = await fetch(`${ctx.homeInboxHttp.origin}/settings/layout-drafts/draft-1/publish`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ expectedRevision: "4" }),
      redirect: "manual",
    });
    assert.equal(republished.status, 303);
    assert.equal(activePublications.get("community.calm")?.title, "安静视图 2");

    const rolledBack = await fetch(`${ctx.homeInboxHttp.origin}/settings/layout-publications/community.calm/rollback`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ expectedGenerationId: "generation-2" }),
      redirect: "manual",
    });
    assert.equal(rolledBack.status, 303);
    assert.equal(rolledBack.headers.get("location"), "/settings?layoutNotice=rolled_back");
    assert.equal(activePublications.get("community.calm")?.title, "安静视图");

    const deactivated = await fetch(`${ctx.homeInboxHttp.origin}/settings/layout-publications/community.calm/deactivate`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ expectedGenerationId: "generation-1" }),
      redirect: "manual",
    });
    assert.equal(deactivated.status, 303);
    assert.equal(deactivated.headers.get("location"), "/settings?layoutNotice=deactivated");
    assert.equal(activePublications.size, 0);
    const auditPage = await fetch(`${ctx.homeInboxHttp.origin}/settings?layout=draft-1`, { headers: { authorization } });
    const auditHtml = await auditPage.text();
    assert.match(auditHtml, /发布记录/);
    assert.match(auditHtml, /发布了 community\.calm/);
    assert.match(auditHtml, /恢复了上一版 community\.calm/);
    assert.match(auditHtml, /撤下了 community\.calm/);
    assert.match(auditHtml, /admin-1/);
    assert.doesNotMatch(auditHtml, /generation-[12]/);
    const recovered = await fetch(`${ctx.homeInboxHttp.origin}/settings?view=community.calm`, { headers: { authorization } });
    assert.match(await recovered.text(), /已恢复生活视图/);

    const deleted = await fetch(`${ctx.homeInboxHttp.origin}/settings/layout-drafts/draft-1/delete`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ expectedRevision: "4" }),
      redirect: "manual",
    });
    assert.equal(deleted.status, 303);
    assert.equal(records.size, 0);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }

  drafts.create({ ownerPrincipalId: "admin-1", label: "冲突布局", source });
  const reserved = new Context();
  const reservedInbox = await reserved.plugin(StubInbox);
  const reservedFiber = await reserved.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    viewRecipeDrafts: drafts,
    viewProviders: [{ id: "community.calm", label: "部署视图", renderContent: () => "<h1>部署视图</h1>" }],
  });
  try {
    const conflict = await fetch(`${reserved.homeInboxHttp.origin}/settings/layout-drafts/draft-1/publish`, {
      method: "POST",
      headers: {
        authorization,
        origin: reserved.homeInboxHttp.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ expectedRevision: "1" }),
      redirect: "manual",
    });
    assert.equal(conflict.status, 303);
    assert.equal(conflict.headers.get("location"), "/settings?layout=draft-1&layoutNotice=provider");
    assert.equal(activePublications.size, 0);
    assert.equal(nextGeneration, 2);
  } finally {
    await reservedFiber.dispose();
    await reservedInbox.dispose();
    await reserved.fiber.dispose();
    records.clear();
  }

  const shared = new Context();
  const sharedInbox = await shared.plugin(StubInbox);
  const sharedFiber = await shared.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: childSharedPrincipal,
    viewRecipeDrafts: drafts,
  });
  try {
    const page = await fetch(`${shared.homeInboxHttp.origin}/settings`, { headers: { authorization } });
    assert.doesNotMatch(await page.text(), /布局工作室/);
    const denied = await fetch(`${shared.homeInboxHttp.origin}/settings/layout-drafts`, {
      method: "POST",
      headers: {
        authorization,
        origin: shared.homeInboxHttp.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ label: "共享设备", source, idempotencyKey: "shared-create" }),
      redirect: "manual",
    });
    assert.equal(denied.status, 403);
  } finally {
    await sharedFiber.dispose();
    await sharedInbox.dispose();
    await shared.fiber.dispose();
  }
});

test("requires an explicit principal role and device binding for Basic-authenticated HTTP", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  await assert.rejects(async () => { await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
  }); }, /explicit principal role and device binding/i);
  await inboxFiber.dispose();
  await ctx.fiber.dispose();
});


test("controls a deployed automation including an enable retry", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(ProposalEnableInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adultAdminPrincipal,
    reviewer: "adult-2",
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };
  try {
    for (const command of ["pause", "resume", "close", "retry"] as const) {
      const controlled = await fetch(`${ctx.homeInboxHttp.origin}/automations/proposal-enable/${command}`, {
        method: "POST",
        headers,
        redirect: "manual",
      });
      assert.equal(controlled.status, 303);
      assert.equal(controlled.headers.get("location"), "/automations");
    }
    assert.deepEqual((ctx.homeInbox as unknown as ProposalEnableInbox).automationCommands, [
      { proposalId: "proposal-enable", command: "pause", actor: "adult-2" },
      { proposalId: "proposal-enable", command: "resume", actor: "adult-2" },
      { proposalId: "proposal-enable", command: "close", actor: "adult-2" },
      { proposalId: "proposal-enable", command: "retry", actor: "adult-2" },
    ]);

    const foreign = await fetch(`${ctx.homeInboxHttp.origin}/automations/proposal-enable/pause`, {
      method: "POST",
      headers: { authorization, origin: "https://elsewhere.example" },
      redirect: "manual",
    });
    assert.equal(foreign.status, 403);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});
