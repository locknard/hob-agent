import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

import {
  ProposalInboxHttpService,
  createInboxBasicAuthenticator,
  type ProductLayout,
  type ProposalInboxHttpOptions,
} from "./proposal-inbox-http-service.js";

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
  status: "verified" | "pending_confirmation" | "failed" | "unknown" = "verified";

  getProductShellProjection() {
    return {
      connection: { state: "quiet" as const, lastContact: "刚刚" },
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
          stage: "enable" as const,
          status: "approved" as const,
        },
      } : {}),
    };
  }

  canEnableProposal() { return true; }

  enableProposal(input: unknown) {
    this.enablements.push(input);
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

  const voicePreview = await fetch(`${ctx.homeInboxHttp.origin}/voice-preview?state=awaiting_confirmation`, {
    headers: { authorization },
    redirect: "manual",
  });
  assert.equal(voicePreview.status, 303);
  assert.equal(voicePreview.headers.get("location"), "/voice-preview");

  const canonicalVoice = await fetch(`${ctx.homeInboxHttp.origin}/voice-preview`, {
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

  const invalidVoiceState = await fetch(`${ctx.homeInboxHttp.origin}/voice-preview?state=%3Cscript%3E`, {
    headers: { authorization },
    redirect: "manual",
  });
  assert.equal(invalidVoiceState.status, 303);
  assert.equal(invalidVoiceState.headers.get("location"), "/voice-preview");

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

test("keeps administrator confirmations and proposal decisions on a bound private device", async () => {
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
    const denied = await fetch(`${ctx.homeInboxHttp.origin}/runtime-confirmations/runtime-1/reject`, {
      method: "POST",
      headers,
      body: "",
      redirect: "manual",
    });
    assert.equal(denied.status, 403);
    assert.match(await denied.text(), /authorized device/i);

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

test("keeps the trial proposal detail reachable and accepts the second enablement consent", async () => {
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
    assert.match(detailHtml, /确认长期使用/);

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

test("keeps the Host Shell fixed while ProductLayout supplies ordinary route content", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const rendered: Array<{ route: string; reviewCounts?: unknown; proposalId?: string }> = [];
  const layout: ProductLayout = {
    renderContent(model, input) {
      const legacyKeys = ["reviews", "confirmations", "home", "turn"].filter((key) => key in model);
      assert.deepEqual(legacyKeys, []);
      rendered.push({ route: input.route, reviewCounts: input.reviewCounts, proposalId: input.proposalId });
      return `<section data-product-route="${input.route}"><h1>${input.route}</h1></section>`;
    },
  };
  const options: ProposalInboxHttpOptions = {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    layout,
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
      assert.ok((html.match(/<header/g) ?? []).length <= 1);
      assert.equal(html.includes('class="skip-link"'), false);
    }
    assert.deepEqual(rendered.map((entry) => entry.route), [
      "home", "conversation", "review-center", "activity", "control", "settings", "onboarding",
    ]);
    assert.deepEqual(rendered[2]?.reviewCounts, {
      runtimeConfirmations: 2,
      persistentProposals: 3,
    });
    assert.deepEqual(rendered[0]?.reviewCounts, {
      runtimeConfirmations: 2,
      persistentProposals: 3,
    });
    assert.equal(JSON.stringify(rendered[2]?.reviewCounts ?? {}).includes("total"), false);

    const selectedProposal = await fetch(`${ctx.homeInboxHttp.origin}/review-center?proposal=proposal-1`, {
      headers: { authorization },
    });
    assert.equal(selectedProposal.status, 200);
    assert.equal(rendered.at(-1)?.proposalId, "proposal-1");

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
    assert.match(await js.text(), /data-runtime-countdown/);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("uses the bundled ProductLayout for canonical routes when no layout is injected", async () => {
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
      body: "step=4&memberName=%E5%B0%8F%E9%9B%A8&memberRole=adult_admin",
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
    for (const path of ["/home", "/conversation", "/review-center", "/activity", "/control", "/settings", "/onboarding"] as const) {
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
