import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

import {
  ProposalInboxHttpService,
  createInboxBasicAuthenticator,
  type ProductViewProvider,
  type ProposalInboxHttpOptions,
} from "./proposal-inbox-http-service.js";
import { ProductHttpHost } from "./product-http-host.js";
import type { ProductConnectionState } from "./product-shell.js";
import { runProductViewRecipeConformance } from "./product-view-recipe-conformance.js";

type TestVoiceProvider = {
  readonly captureMode: "encoded_audio" | "pcm_s16le";
  transcribe(input: Record<string, unknown>): Promise<unknown>;
  synthesize(input: Record<string, unknown>): Promise<unknown>;
};

function voiceGateway(provider: TestVoiceProvider): ProposalInboxHttpOptions["privateVoice"] {
  return {
    status: "active",
    beginTurn() {
      return {
        captureMode: provider.captureMode,
        transcribe: provider.transcribe,
        synthesize: provider.synthesize,
        async release() {},
      };
    },
  };
}

async function leaseVoiceTurn(origin: string, headers: Record<string, string>): Promise<string> {
  const response = await fetch(`${origin}/voice/turns`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: "",
  });
  assert.equal(response.status, 201);
  const body = await response.json() as { readonly status: string; readonly voiceTurnId: string };
  assert.equal(body.status, "leased");
  return body.voiceTurnId;
}

function transcribeVoiceTurn(origin: string, turnId: string, headers: Record<string, string>, body: Uint8Array): Promise<Response> {
  return fetch(`${origin}/voice/turns/${encodeURIComponent(turnId)}/transcribe`, { method: "POST", headers, body });
}

function speakVoiceTurn(origin: string, turnId: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${origin}/voice/turns/${encodeURIComponent(turnId)}/speech`, { headers });
}

async function completedPrivateVoiceConfigurationReceipt(
  origin: string,
  headers: Record<string, string>,
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${origin}/settings/private-voice/configuration-status`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json() as { readonly status: string; readonly receipt?: string };
    if (body.status === "completed") {
      assert.match(body.receipt ?? "", /^[a-f0-9]{32}$/);
      return body.receipt!;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("background private voice configuration did not settle");
}

async function acceptedVoiceTurn(origin: string, headers: Record<string, string>): Promise<string> {
  const turnId = await leaseVoiceTurn(origin, headers);
  const response = await transcribeVoiceTurn(origin, turnId, headers, new Uint8Array([1, 2]));
  assert.equal(response.status, 202);
  return turnId;
}

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
    { id: 4, type: "answer", data: { text: "先按日光和最早、最晚边界试用一周。" } },
    { id: 5, type: "completed", data: {} },
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

class MultiSpeechAdviceInbox extends StructuredAdviceInbox {
  getProductAdviceTurn(id: string) {
    if (/^speech-\d+$/.test(id)) {
      return {
        id,
        question: "语音回答",
        status: "completed" as const,
        answer: `回答 ${id}`,
        canStop: false,
        canBackground: false,
      };
    }
    return super.getProductAdviceTurn(id);
  }
}

class TestVoiceSpeechResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  statusCode = 0;
  readonly headers = new Map<string, string>();
  body: Uint8Array | string | undefined;

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  end(body?: Uint8Array | string): void {
    this.writableEnded = true;
    this.body = body;
  }

  disconnect(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

function testVoiceSpeechRequest(): EventEmitter & { readonly headers: Record<string, string> } {
  const request = new EventEmitter() as EventEmitter & { readonly headers: Record<string, string> };
  Object.defineProperty(request, "headers", { value: {} });
  return request;
}

function testVoiceSpeechHandler(ctx: Context): (
  request: unknown,
  response: unknown,
  adviceId: string,
) => Promise<void> {
  const service = ctx.homeInboxHttp as unknown as {
    options: { privateVoice?: { beginTurn(): unknown } };
    privateVoiceTurns: Map<string, unknown>;
    privateVoiceSessionKey(request: unknown): string;
    handleVoiceSpeech(request: unknown, response: unknown, token: string): Promise<void>;
  };
  const token = "t".repeat(43);
  return (request, response) => {
    if (!service.privateVoiceTurns.has(token)) {
      const lease = service.options.privateVoice?.beginTurn();
      if (lease === undefined) throw new Error("Voice test lease is unavailable");
      service.privateVoiceTurns.set(token, {
        token,
        sessionKey: service.privateVoiceSessionKey(request),
        lease,
        phase: "awaiting_advice",
        uploadUsed: true,
        adviceId: "advice-stream",
        expiresAt: Date.now() + 60_000,
      });
    }
    return service.handleVoiceSpeech(request, response, token);
  };
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

test("waits for an explicit attachment before Inbox serves through an external product host", async () => {
  const host = new ProductHttpHost({ port: 0 });
  await host.listen();
  const ctx = new Context();
  let inboxFiber: { dispose(): Promise<void> } | undefined;
  let fiber: { dispose(): Promise<void> } | undefined;

  try {
    inboxFiber = await ctx.plugin(StubInbox);
    fiber = await ctx.plugin(ProposalInboxHttpService, {
      host,
      authenticate: createInboxBasicAuthenticator(token),
      principal: adminPrincipal,
    });
    assert.equal(ctx.homeInboxHttp.origin, host.origin);
    assert.equal((await fetch(`${host.origin}/home`, { headers: { authorization } })).status, 503);

    ctx.homeInboxHttp.attach();
    const home = await fetch(`${host.origin}/home`, { headers: { authorization } });
    assert.equal(home.status, 200);
  } finally {
    await fiber?.dispose();
    await inboxFiber?.dispose();
    await ctx.fiber.dispose();
    await host.dispose();
  }
});

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
  assert.match(voiceHtml, /data-voice-state="text_mode"/);
  assert.match(voiceHtml, /data-voice-surface/);
  assert.match(voiceHtml, /data-private-voice-status="unavailable"/);
  assert.doesNotMatch(voiceHtml, /data-private-voice-capture-mode/);

  const voiceScript = await fetch(`${ctx.homeInboxHttp.origin}/assets/product.js`, {
    headers: { authorization },
  });
  assert.equal(voiceScript.status, 200);
  const voiceScriptText = await voiceScript.text();
  assert.match(voiceScriptText, /getUserMedia/);
  assert.match(voiceScriptText, /MediaRecorder/);
  assert.match(voiceScriptText, /voice\/turns/);
  assert.match(voiceScriptText, /\/transcribe/);
  assert.match(voiceScriptText, /\/speech/);
  assert.doesNotMatch(voiceScriptText, /SpeechRecognition|webkitSpeechRecognition|play_media|mediaRef/);

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

test("uses an async product-session authenticator without Basic challenges and preserves the configured principal", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  const authenticatedRequests: unknown[] = [];
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    principal: adminPrincipal,
    requestAuthenticator: async (request) => {
      authenticatedRequests.push(request);
      return request.cookie === "hob_product_session=supervisor-session";
    },
  });

  try {
    const denied = await fetch(`${ctx.homeInboxHttp.origin}/home`);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("www-authenticate"), null);
    assert.match(await denied.text(), /恢复本地会话/);
    assert.deepEqual(authenticatedRequests, [{ authorization: undefined, cookie: undefined, origin: undefined }]);

    const accepted = await fetch(`${ctx.homeInboxHttp.origin}/conversation`, {
      method: "POST",
      headers: {
        cookie: "hob_product_session=supervisor-session",
        origin: ctx.homeInboxHttp.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "question=%E5%AE%A2%E5%8E%85%E7%8E%B0%E5%9C%A8%E6%80%8E%E4%B9%88%E6%A0%B7",
      redirect: "manual",
    });
    assert.equal(accepted.status, 303);
    assert.deepEqual((ctx.homeInbox as unknown as StubInbox).adviceActors, [adminPrincipal]);
    assert.deepEqual(authenticatedRequests[1], {
      authorization: undefined,
      cookie: "hob_product_session=supervisor-session",
      origin: ctx.homeInboxHttp.origin,
    });
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("recovers a missing product cookie only through the local pairing page", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  const recoveryCode = "FRESH-HOME";
  const recoveredToken = "recovered-product-session-token-with-at-least-32";
  const recoveryAttempts: string[] = [];
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    principal: adminPrincipal,
    requestAuthenticator: async (request) => request.cookie === `hob_product_session=${recoveredToken}`,
    sessionRecovery: {
      recover: async (code: string) => {
        recoveryAttempts.push(code);
        return code === recoveryCode
          ? { status: "recovered" as const, sessionToken: recoveredToken, expiresAt: new Date("2026-11-22T00:00:00.000Z") }
          : { status: "invalid" as const };
      },
    },
  });

  try {
    const denied = await fetch(`${ctx.homeInboxHttp.origin}/home`, { redirect: "manual" });
    assert.equal(denied.status, 303);
    assert.equal(denied.headers.get("location"), "/pair");

    const pairingPage = await fetch(`${ctx.homeInboxHttp.origin}/pair`);
    const pairingHtml = await pairingPage.text();
    assert.equal(pairingPage.status, 200);
    assert.match(pairingHtml, /恢复家庭控制台/u);
    assert.match(pairingHtml, /href="\/assets\/product\.css"/u);
    assert.match(pairingHtml, /name="code"/u);
    assert.equal(pairingHtml.includes(recoveryCode), false);
    assert.equal(pairingHtml.includes(recoveredToken), false);
    assert.equal((await fetch(`${ctx.homeInboxHttp.origin}/assets/product.css`)).status, 200);

    const wrongOrigin = await fetch(`${ctx.homeInboxHttp.origin}/pair`, {
      method: "POST",
      headers: { origin: "http://not-the-household", "content-type": "application/x-www-form-urlencoded" },
      body: "code=FRESH-HOME",
      redirect: "manual",
    });
    assert.equal(wrongOrigin.status, 403);

    const paired = await fetch(`${ctx.homeInboxHttp.origin}/pair`, {
      method: "POST",
      headers: { origin: ctx.homeInboxHttp.origin, "content-type": "application/x-www-form-urlencoded" },
      body: "code=FRESH-HOME",
      redirect: "manual",
    });
    assert.equal(paired.status, 303);
    assert.equal(paired.headers.get("location"), "/home");
    assert.match(paired.headers.get("set-cookie") ?? "", /hob_product_session=recovered-product-session-token/u);
    assert.match(paired.headers.get("set-cookie") ?? "", /HttpOnly/u);
    assert.match(paired.headers.get("set-cookie") ?? "", /SameSite=Strict/u);
    assert.equal((await fetch(`${ctx.homeInboxHttp.origin}/home`, {
      headers: { cookie: `hob_product_session=${recoveredToken}` },
    })).status, 200);
    assert.deepEqual(recoveryAttempts, [recoveryCode]);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("limits failed local recovery pairing attempts without revealing a session secret", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  const recoveryCode = "LIMIT-HOME";
  const sessionToken = "session-token-that-must-never-appear-in-a-recovery-error";
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    principal: adminPrincipal,
    requestAuthenticator: async () => false,
    sessionRecovery: {
      recover: async (code: string) => code === recoveryCode
        ? { status: "recovered" as const, sessionToken, expiresAt: new Date("2026-11-22T00:00:00.000Z") }
        : { status: "invalid" as const },
    },
  });
  const attempt = () => fetch(`${ctx.homeInboxHttp.origin}/pair`, {
    method: "POST",
    headers: { origin: ctx.homeInboxHttp.origin, "content-type": "application/x-www-form-urlencoded" },
    body: "code=WRONG-HOME",
    redirect: "manual",
  });

  try {
    for (let index = 0; index < 5; index += 1) assert.equal((await attempt()).status, 401);
    const limited = await attempt();
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/u);
    assert.equal((await limited.text()).includes(sessionToken), false);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("admits only one recovery attempt while a code check is in flight", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let invocations = 0;
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    principal: adminPrincipal,
    requestAuthenticator: async () => false,
    sessionRecovery: {
      recover: async () => {
        invocations += 1;
        await gate;
        return { status: "invalid" as const };
      },
    },
  });
  const attempt = () => fetch(`${ctx.homeInboxHttp.origin}/pair`, {
    method: "POST",
    headers: { origin: ctx.homeInboxHttp.origin, "content-type": "application/x-www-form-urlencoded" },
    body: "code=WRONG-HOME",
    redirect: "manual",
  });

  try {
    const attempts = Array.from({ length: 6 }, () => attempt());
    for (let index = 0; index < 20 && invocations === 0; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const admitted = invocations;
    release();
    const statuses = (await Promise.all(attempts)).map((response) => response.status).sort();
    assert.equal(admitted, 1);
    assert.equal(statuses.filter((status) => status === 401).length <= 5, true);
    assert.equal(statuses.includes(429), true);
  } finally {
    release();
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
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
    configureActionPolicy: (selection: { directCapabilityIds: readonly string[]; confirmationCapabilityIds: readonly string[]; administratorCapabilityIds: readonly string[] }) => {
      const rows = selection.directCapabilityIds.length + selection.confirmationCapabilityIds.length + selection.administratorCapabilityIds.length;
      if (rows === 0) return { status: "configured" as const, changedCount: 0 };
      configured.push(selection);
      return { status: "configured" as const, changedCount: rows };
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
    assert.match(settingsHtml, /data-policy-form/, "the form is marked for the change-gated save button");
    const asset = await fetch(`${ctx.homeInboxHttp.origin}/assets/product.js`, { headers: { authorization } });
    assert.match(await asset.text(), /data-policy-form[\s\S]*disabled = true/, "the asset gates the save button until a real change");

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

    const empty = await fetch(`${ctx.homeInboxHttp.origin}/settings/action-policy`, {
      method: "POST",
      headers,
      body: "",
      redirect: "manual",
    });
    assert.equal(empty.status, 303, "choosing nothing is a truthful no-change, not an error");
    const emptyReceipt = /policy=([a-f0-9]{32})/.exec(empty.headers.get("location") ?? "")?.[1];
    assert.ok(emptyReceipt !== undefined);
    const emptyConfirmed = await fetch(`${ctx.homeInboxHttp.origin}/settings?policy=${emptyReceipt}`, { headers: { authorization } });
    assert.match(await emptyConfirmed.text(), /确认方式没有变化。/);
    assert.equal(rechecks, 1, "a no-change save rechecks nothing");

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

test("operational private voice settings stay authenticated, same-origin, credential-private, and receipt-scoped", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  const calls: unknown[] = [];
  let projectionCalls = 0;
  const operationalPrivateVoice = {
    async projection() {
      projectionCalls += 1;
      return {
        status: "active" as const,
        generation: 8,
        configured: true as const,
        asr: { transport: "wyoming" as const, endpoint: "http://voice.local/asr", model: "whisper", credentialConfigured: true },
        tts: { transport: "openai_http" as const, endpoint: "http://voice.local/tts", locale: "zh-CN", voice: "calm", credentialConfigured: false },
      };
    },
    async configure(input: unknown) {
      calls.push({ type: "configure", input });
      return { status: "configured" as const, generation: 9 };
    },
    async disable(input: unknown) {
      calls.push({ type: "disable", input });
      return { status: "disabled" as const, generation: 9 };
    },
    async retry() {
      calls.push({ type: "retry" });
      return "retrying" as const;
    },
    cancelRetry() {
      calls.push({ type: "cancel-retry" });
    },
  };
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    voiceSettings: operationalPrivateVoice,
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };
  const asrCredential = "private-asr-secret";
  const ttsCredential = "private-tts-secret";
  try {
    const settings = await fetch(`${ctx.homeInboxHttp.origin}/settings`, { headers: { authorization } });
    const settingsHtml = await settings.text();
    assert.equal(projectionCalls, 1);
    assert.match(settingsHtml, /id="private-voice"/);
    assert.match(settingsHtml, /value="http:\/\/voice\.local\/asr"/);
    assert.doesNotMatch(settingsHtml, /private-(?:asr|tts)-secret/);
    const asset = await fetch(`${ctx.homeInboxHttp.origin}/assets/product.js`, { headers: { authorization } });
    assert.match(await asset.text(), /data-private-voice-form/);

    const rejectedQuery = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/configure?credential=${asrCredential}`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ expectedGeneration: "8" }),
      redirect: "manual",
    });
    assert.equal(rejectedQuery.status, 400, "credentials never enter URLs");
    const rejectedOrigin = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/configure`, {
      method: "POST",
      headers: { ...headers, origin: "http://elsewhere.invalid" },
      body: new URLSearchParams({ expectedGeneration: "8" }),
      redirect: "manual",
    });
    assert.equal(rejectedOrigin.status, 403);

    const configured = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/configure`, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        expectedGeneration: "8",
        asrTransport: "wyoming",
        asrEndpoint: "http://voice.local/asr",
        asrModel: "whisper",
        asrCredential,
        ttsTransport: "openai_http",
        ttsEndpoint: "http://voice.local/tts",
        ttsModel: "speak",
        ttsLocale: "zh-CN",
        ttsVoice: "calm",
        ttsCredential,
      }),
      redirect: "manual",
    });
    assert.equal(configured.status, 303);
    const configuredLocation = configured.headers.get("location") ?? "";
    assert.equal(configuredLocation, "/settings#private-voice", "the browser returns before the server-side check settles");
    assert.doesNotMatch(configuredLocation, /private-(?:asr|tts)-secret/);
    const configureCall = calls[0] as { readonly type: string; readonly input: Record<string, unknown> };
    assert.equal(configureCall.input.signal instanceof AbortSignal, true);
    const { signal: _signal, ...configureInput } = configureCall.input;
    assert.deepEqual({
      type: configureCall.type,
      input: configureInput,
    }, {
      type: "configure",
      input: {
        expectedGeneration: 8,
        asr: { kind: "asr", transport: "wyoming", endpoint: "http://voice.local/asr", model: "whisper", credential: asrCredential },
        tts: { kind: "tts", transport: "openai_http", endpoint: "http://voice.local/tts", model: "speak", locale: "zh-CN", voice: "calm", credential: ttsCredential },
      },
    });
    const receipt = await completedPrivateVoiceConfigurationReceipt(ctx.homeInboxHttp.origin, { authorization });
    const received = await fetch(`${ctx.homeInboxHttp.origin}/settings?voice=${receipt}`, { headers: { authorization } });
    const receivedHtml = await received.text();
    assert.match(receivedHtml, /语音服务已检查并保存。/);
    assert.doesNotMatch(receivedHtml, /private-(?:asr|tts)-secret/);
    const replayed = await fetch(`${ctx.homeInboxHttp.origin}/settings?voice=${receipt}`, { headers: { authorization } });
    assert.doesNotMatch(await replayed.text(), /语音服务已检查并保存。/);

    const disabled = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/disable`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ expectedGeneration: "8", confirmDisable: "confirmed" }),
      redirect: "manual",
    });
    assert.equal(disabled.status, 303);
    assert.deepEqual(calls[1], { type: "disable", input: { expectedGeneration: 8 } });
    const retry = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/retry`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ expectedGeneration: "8" }),
      redirect: "manual",
    });
    assert.equal(retry.status, 303);
    const cancel = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/cancel-retry`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ expectedGeneration: "8" }),
      redirect: "manual",
    });
    assert.equal(cancel.status, 303);
    assert.deepEqual(calls.slice(2), [{ type: "retry" }, { type: "cancel-retry" }]);
    const staleRetry = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/retry`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ expectedGeneration: "7" }),
      redirect: "manual",
    });
    assert.equal(staleRetry.status, 303);
    assert.deepEqual(calls.slice(2), [{ type: "retry" }, { type: "cancel-retry" }], "a stale settings page cannot retry the replacement generation");
    const staleReceipt = /voice=([a-f0-9]{32})/.exec(staleRetry.headers.get("location") ?? "")?.[1];
    assert.ok(staleReceipt !== undefined);
    const staleSettings = await fetch(`${ctx.homeInboxHttp.origin}/settings?voice=${staleReceipt}`, { headers: { authorization } });
    assert.match(await staleSettings.text(), /语音设置已经更新，请查看当前设置后再继续。/);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("operational private voice starts one credential-private configuration check in the background", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  let resolveConfiguration: ((result: { readonly status: "configured"; readonly generation: number }) => void) | undefined;
  const configuration = new Promise<{ readonly status: "configured"; readonly generation: number }>((resolve) => {
    resolveConfiguration = resolve;
  });
  let configureCalls = 0;
  let configureInput: unknown;
  const asrCredential = "private-background-asr-secret";
  const ttsCredential = "private-background-tts-secret";
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    voiceSettings: {
      async projection() {
        return { status: "disabled" as const, generation: 8, configured: false as const };
      },
      async configure(input: unknown) {
        configureCalls += 1;
        configureInput = input;
        return configuration;
      },
      async disable() { return { status: "disabled" as const, generation: 8 }; },
      async retry() { return "disabled" as const; },
      cancelRetry() {},
    },
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };
  const submit = fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/configure`, {
    method: "POST",
    headers,
    body: new URLSearchParams({
      expectedGeneration: "8",
      asrTransport: "wyoming",
      asrEndpoint: "http://voice.local/asr",
      asrModel: "whisper",
      asrCredential,
      ttsTransport: "openai_http",
      ttsEndpoint: "http://voice.local/tts",
      ttsModel: "speak",
      ttsLocale: "zh-CN",
      ttsVoice: "calm",
      ttsCredential,
    }),
    redirect: "manual",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      submit,
      new Promise<"timed-out">((resolve) => { timeout = setTimeout(() => resolve("timed-out"), 50); }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (response === "timed-out") {
      resolveConfiguration?.({ status: "configured", generation: 9 });
      await submit;
      assert.fail("configuration POST waits for the provider check instead of redirecting immediately");
    }
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/settings#private-voice");
    assert.equal(configureCalls, 1);
    const input = configureInput as { readonly signal?: AbortSignal };
    assert.ok(input.signal instanceof AbortSignal, "the server owns one cancellable background task");

    const pendingPage = await fetch(`${ctx.homeInboxHttp.origin}/settings`, { headers: { authorization } });
    const pendingHtml = await pendingPage.text();
    assert.match(pendingHtml, /正在检查语音识别与回复服务/);
    assert.doesNotMatch(pendingHtml, /settings\/private-voice\/configure/);
    assert.doesNotMatch(pendingHtml, /private-background-(?:asr|tts)-secret/);
    const configurationId = /data-private-voice-configuration-id="([a-f0-9]{32})"/.exec(pendingHtml)?.[1];
    assert.ok(configurationId !== undefined);

    const anonymousStatus = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/configuration-status`);
    assert.equal(anonymousStatus.status, 401);
    const crossOriginStatus = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/configuration-status`, {
      headers: { authorization, origin: "http://elsewhere.invalid" },
    });
    assert.equal(crossOriginStatus.status, 403);
    const pendingStatus = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/configuration-status`, { headers: { authorization } });
    assert.equal(pendingStatus.status, 200);
    assert.deepEqual(await pendingStatus.json(), {
      status: "pending",
      configurationId,
    });

    resolveConfiguration?.({ status: "configured", generation: 9 });
    let completion: { readonly status: string; readonly receipt?: string } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/configuration-status`, { headers: { authorization } });
      completion = await status.json() as { readonly status: string; readonly receipt?: string };
      if (completion.status === "completed") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(completion?.status, "completed");
    assert.match(completion?.receipt ?? "", /^[a-f0-9]{32}$/);
    assert.doesNotMatch(JSON.stringify(completion), /private-background-(?:asr|tts)-secret/);
    const receiptPage = await fetch(`${ctx.homeInboxHttp.origin}/settings?voice=${completion?.receipt}`, { headers: { authorization } });
    const receiptHtml = await receiptPage.text();
    assert.match(receiptHtml, /语音服务已检查并保存。/);
    assert.doesNotMatch(receiptHtml, /private-background-(?:asr|tts)-secret/);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    resolveConfiguration?.({ status: "configured", generation: 9 });
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("operational private voice shows an already-settled background receipt once on the redirected settings page", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    voiceSettings: {
      async projection() {
        return { status: "disabled" as const, generation: 3, configured: false as const };
      },
      async configure() { return { status: "configured" as const, generation: 4 }; },
      async disable() { return { status: "disabled" as const, generation: 3 }; },
      async retry() { return "disabled" as const; },
      cancelRetry() {},
    },
  });
  try {
    const configured = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/configure`, {
      method: "POST",
      headers: {
        authorization,
        origin: ctx.homeInboxHttp.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        expectedGeneration: "3", asrTransport: "wyoming", asrEndpoint: "http://voice.local/asr", asrModel: "",
        asrCredential: "", ttsTransport: "openai_http", ttsEndpoint: "http://voice.local/tts", ttsModel: "",
        ttsLocale: "zh-CN", ttsVoice: "", ttsCredential: "",
      }),
      redirect: "manual",
    });
    assert.equal(configured.status, 303);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const settled = await fetch(`${ctx.homeInboxHttp.origin}/settings`, { headers: { authorization } });
    assert.match(await settled.text(), /语音服务已检查并保存。/);
    const replay = await fetch(`${ctx.homeInboxHttp.origin}/settings`, { headers: { authorization } });
    assert.doesNotMatch(await replay.text(), /语音服务已检查并保存。/);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("operational private voice cancels only its exact background check and keeps the active generation", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  let generation = 3;
  let configurationSignal: AbortSignal | undefined;
  let configureCalls = 0;
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    voiceSettings: {
      async projection() {
        return { status: "disabled" as const, generation, configured: false as const };
      },
      async configure(input: unknown) {
        configureCalls += 1;
        configurationSignal = (input as { readonly signal?: AbortSignal }).signal;
        return await new Promise<{ readonly status: "cancelled" }>((resolve) => {
          configurationSignal?.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
        });
      },
      async disable() { return { status: "disabled" as const, generation }; },
      async retry() { return "disabled" as const; },
      cancelRetry() {},
    },
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };
  const configureBody = new URLSearchParams({
    expectedGeneration: "3", asrTransport: "wyoming", asrEndpoint: "http://voice.local/asr", asrModel: "",
    asrCredential: "", ttsTransport: "openai_http", ttsEndpoint: "http://voice.local/tts", ttsModel: "",
    ttsLocale: "zh-CN", ttsVoice: "", ttsCredential: "",
  });
  try {
    const started = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/configure`, {
      method: "POST", headers, body: configureBody, redirect: "manual",
    });
    assert.equal(started.status, 303);
    assert.equal(configureCalls, 1);
    assert.equal(configurationSignal?.aborted, false);
    const pending = await fetch(`${ctx.homeInboxHttp.origin}/settings`, { headers: { authorization } });
    const pendingHtml = await pending.text();
    const configurationId = /data-private-voice-configuration-id="([a-f0-9]{32})"/.exec(pendingHtml)?.[1];
    assert.ok(configurationId !== undefined);

    const crossOrigin = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/cancel-configure`, {
      method: "POST",
      headers: { ...headers, origin: "http://elsewhere.invalid" },
      body: new URLSearchParams({ configurationId }),
      redirect: "manual",
    });
    assert.equal(crossOrigin.status, 403);
    assert.match(await crossOrigin.text(), /请从家庭控制台继续此操作。/);
    assert.equal(configurationSignal?.aborted, false);

    const malformed = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/cancel-configure`, {
      method: "POST", headers, body: new URLSearchParams({ configurationId: "forged" }), redirect: "manual",
    });
    assert.equal(malformed.status, 400);
    assert.equal(configurationSignal?.aborted, false);

    const forged = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/cancel-configure`, {
      method: "POST", headers, body: new URLSearchParams({ configurationId: "f".repeat(32) }), redirect: "manual",
    });
    assert.equal(forged.status, 303);
    assert.equal(configurationSignal?.aborted, false, "a guessed opaque id cannot stop the active task");

    const stopped = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/cancel-configure`, {
      method: "POST", headers, body: new URLSearchParams({ configurationId }), redirect: "manual",
    });
    assert.equal(stopped.status, 303);
    assert.equal(stopped.headers.get("location"), "/settings#private-voice");
    const receipt = await completedPrivateVoiceConfigurationReceipt(ctx.homeInboxHttp.origin, { authorization });
    const complete = await fetch(`${ctx.homeInboxHttp.origin}/settings?voice=${receipt}`, { headers: { authorization } });
    const completeHtml = await complete.text();
    assert.match(completeHtml, /已停止这次检查，原来的语音设置保持不变。/);
    assert.match(completeHtml, /name="expectedGeneration" value="3"/);
    assert.equal(configurationSignal?.aborted, true);
    assert.equal(generation, 3);
  } finally {
    generation = 3;
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("disposing the HTTP service aborts its one in-flight private voice configuration", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  let configurationSignal: AbortSignal | undefined;
  let aborts = 0;
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    voiceSettings: {
      async projection() {
        return { status: "disabled" as const, generation: 3, configured: false as const };
      },
      async configure(input: unknown) {
        configurationSignal = (input as { readonly signal?: AbortSignal }).signal;
        return await new Promise<{ readonly status: "cancelled" }>((resolve) => {
          configurationSignal?.addEventListener("abort", () => {
            aborts += 1;
            resolve({ status: "cancelled" });
          }, { once: true });
        });
      },
      async disable() { return { status: "disabled" as const, generation: 3 }; },
      async retry() { return "disabled" as const; },
      cancelRetry() {},
    },
  });
  try {
    const response = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/configure`, {
      method: "POST",
      headers: {
        authorization,
        origin: ctx.homeInboxHttp.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        expectedGeneration: "3", asrTransport: "wyoming", asrEndpoint: "http://voice.local/asr", asrModel: "",
        asrCredential: "", ttsTransport: "openai_http", ttsEndpoint: "http://voice.local/tts", ttsModel: "",
        ttsLocale: "zh-CN", ttsVoice: "", ttsCredential: "",
      }),
      redirect: "manual",
    });
    assert.equal(response.status, 303);
    assert.equal(configurationSignal?.aborted, false);
    await fiber.dispose();
    assert.equal(configurationSignal?.aborted, true);
    assert.equal(aborts, 1);
  } finally {
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("operational private voice returns family-facing receipts for busy, conflict, and unavailable outcomes", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  const outcomes = ["busy", "conflict", "unavailable", "cancelled"] as const;
  let next = 0;
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    voiceSettings: {
      async projection() {
        return {
          status: "disabled" as const,
          generation: 3,
          configured: false as const,
        };
      },
      async configure() { return { status: outcomes[next++]! }; },
      async disable() { return { status: "unavailable" as const }; },
      async retry() { return "degraded" as const; },
      cancelRetry() {},
    },
  });
  const headers = {
    authorization,
    origin: ctx.homeInboxHttp.origin,
    "content-type": "application/x-www-form-urlencoded",
  };
  const form = new URLSearchParams({
    expectedGeneration: "3", asrTransport: "wyoming", asrEndpoint: "http://voice.local/asr", asrModel: "",
    asrCredential: "", ttsTransport: "openai_http", ttsEndpoint: "http://voice.local/tts", ttsModel: "",
    ttsLocale: "zh-CN", ttsVoice: "", ttsCredential: "",
  });
  try {
    for (const expected of [/语音设置正在处理/, /语音设置已经更新/, /私有语音暂时不可用/, /已停止这次检查/] as const) {
      const response = await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/configure`, {
        method: "POST", headers, body: form, redirect: "manual",
      });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), "/settings#private-voice");
      const receipt = await completedPrivateVoiceConfigurationReceipt(ctx.homeInboxHttp.origin, { authorization });
      const settings = await fetch(`${ctx.homeInboxHttp.origin}/settings?voice=${receipt}`, { headers: { authorization } });
      const html = await settings.text();
      assert.match(html, expected);
      assert.match(html, /id="private-voice"/, "the recovery entry stays available");
    }
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("allows every present bound private household member to configure voice while refusing shared and unbound devices", async () => {
  const form = new URLSearchParams({
    expectedGeneration: "3", asrTransport: "wyoming", asrEndpoint: "http://voice.local/asr", asrModel: "",
    asrCredential: "", ttsTransport: "openai_http", ttsEndpoint: "http://voice.local/tts", ttsModel: "",
    ttsLocale: "zh-CN", ttsVoice: "", ttsCredential: "",
  });
  const createSettings = (calls: unknown[]) => ({
    async projection() {
      return { status: "disabled" as const, generation: 3, configured: false as const };
    },
    async configure(input: unknown) {
      calls.push(input);
      return { status: "configured" as const, generation: 4 };
    },
    async disable() { return { status: "disabled" as const, generation: 4 }; },
    async retry() { return "disabled" as const; },
    cancelRetry() {},
  });
  const request = async (
    principal: ProposalInboxHttpOptions["principal"],
    calls: unknown[],
  ) => {
    const ctx = new Context();
    const inboxFiber = await ctx.plugin(StubInbox);
    const fiber = await ctx.plugin(ProposalInboxHttpService, {
      port: 0,
      authenticate: createInboxBasicAuthenticator(token),
      principal,
      voiceSettings: createSettings(calls),
    });
    try {
      return await fetch(`${ctx.homeInboxHttp.origin}/settings/private-voice/configure`, {
        method: "POST",
        headers: {
          authorization,
          origin: ctx.homeInboxHttp.origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
        redirect: "manual",
      });
    } finally {
      await fiber.dispose();
      await inboxFiber.dispose();
      await ctx.fiber.dispose();
    }
  };

  const memberCalls: unknown[] = [];
  const member = await request({
    principalId: "member-1",
    role: "child",
    present: true,
    device: { kind: "private", boundPrincipalId: "member-1" },
  }, memberCalls);
  assert.equal(member.status, 303);
  assert.equal(memberCalls.length, 1, "a present bound member needs no administrator role to configure their household voice");

  const sharedCalls: unknown[] = [];
  const shared = await request(childSharedPrincipal, sharedCalls);
  assert.equal(shared.status, 403);
  assert.equal(sharedCalls.length, 0);

  const unboundCalls: unknown[] = [];
  const unbound = await request({
    principalId: "member-2",
    role: "adult_member",
    present: true,
    device: { kind: "private", boundPrincipalId: "another-member" },
  }, unboundCalls);
  assert.equal(unbound.status, 403);
  assert.equal(unboundCalls.length, 0);
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
    configureActionPolicy: () => ({ status: "configured" as const, changedCount: 1 }),
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
  assert.match(body, /id: 4\nevent: answer\ndata: \{"text":"先按日光和最早、最晚边界试用一周。"\}\n\n/);
  assert.match(body, /id: 5\nevent: completed\ndata: \{\}\n\n/);
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

test("accepts bounded private encoded audio only from the product session and starts the canonical advice turn", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const transcriptionCalls: Array<Record<string, unknown>> = [];
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: voiceGateway({
      status: { status: "active" },
      captureMode: "encoded_audio",
      async transcribe(input: Record<string, unknown>) {
        transcriptionCalls.push(input);
        return { status: "transcribed" as const, text: "客厅现在怎么样？" };
      },
      async synthesize() { return { status: "failed" as const, reason: "unavailable" as const }; },
    }),
  } as ProposalInboxHttpOptions);
  const origin = ctx.homeInboxHttp.origin;
  const headers = { authorization, origin, "content-type": "audio/wav" };

  try {
    const foreign = await fetch(`${origin}/voice/turns`, {
      method: "POST",
      headers: { authorization, origin: "https://attacker.invalid", "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(foreign.status, 403);

    const unsupported = await transcribeVoiceTurn(origin, await leaseVoiceTurn(origin, headers), { ...headers, "content-type": "application/octet-stream" }, new Uint8Array([1, 2]));
    assert.equal(unsupported.status, 415);

    const forgedFormat = await transcribeVoiceTurn(origin, await leaseVoiceTurn(origin, headers), { ...headers, "x-audio-rate": "16000" }, new Uint8Array([1, 2]));
    assert.equal(forgedFormat.status, 400);

    const accepted = await transcribeVoiceTurn(origin, await leaseVoiceTurn(origin, headers), headers, new Uint8Array([1, 2, 3]));
    assert.equal(accepted.status, 202);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    assert.deepEqual(await accepted.json(), {
      status: "accepted",
      adviceId: "advice-stream",
      transcript: "客厅现在怎么样？",
    });
    assert.deepEqual((ctx.homeInbox as unknown as StructuredAdviceInbox).started, ["客厅现在怎么样？"]);
    assert.equal(transcriptionCalls.length, 1);
    assert.equal((transcriptionCalls[0]?.audio as Uint8Array).byteLength, 3);
    assert.equal(transcriptionCalls[0]?.mimeType, "audio/wav");
    assert.equal(transcriptionCalls[0]?.format, undefined);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("leases one opaque, session-bound browser turn and releases only its local provider lease", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  let releases = 0;
  const turnId = "a".repeat(43);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoiceTurnToken: () => turnId,
    privateVoice: {
      status: "active",
      beginTurn() {
        return {
          captureMode: "encoded_audio" as const,
          async transcribe() { return { status: "transcribed" as const, text: "客厅现在怎么样？" }; },
          async synthesize() { return { status: "failed" as const, reason: "unavailable" }; },
          async release() { releases += 1; },
        };
      },
    },
  });
  const origin = ctx.homeInboxHttp.origin;
  const headers = { authorization, origin, "content-type": "audio/wav" };
  try {
    const old = await fetch(`${origin}/voice/transcribe`, { method: "POST", headers, body: new Uint8Array([1]) });
    assert.equal(old.status, 404);
    const leased = await leaseVoiceTurn(origin, { authorization, origin });
    assert.equal(leased, turnId);
    const foreign = await transcribeVoiceTurn(origin, leased, { ...headers, authorization: "Basic another-session" }, new Uint8Array([1]));
    assert.equal(foreign.status, 401);
    const accepted = await transcribeVoiceTurn(origin, leased, headers, new Uint8Array([1]));
    assert.equal(accepted.status, 202);
    const repeated = await transcribeVoiceTurn(origin, leased, headers, new Uint8Array([1]));
    assert.equal(repeated.status, 409);
    const release = await fetch(`${origin}/voice/turns/${leased}/release`, { method: "POST", headers: { authorization, origin, "content-type": "application/x-www-form-urlencoded" }, body: "" });
    assert.equal(release.status, 204);
    assert.equal(releases, 1);
    assert.equal((ctx.homeInbox as unknown as StructuredAdviceInbox).cancelled.length, 0);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("pins capture, ASR, advice wait, and TTS to one generation while the next lease uses the replacement", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  let current: "A" | "B" = "A";
  const calls: string[] = [];
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: {
      status: "active",
      beginTurn() {
        const generation = current;
        return {
          captureMode: "encoded_audio" as const,
          async transcribe() { calls.push(`${generation}:asr`); return { status: "transcribed" as const, text: "客厅现在怎么样？" }; },
          async synthesize() { calls.push(`${generation}:tts`); return { status: "synthesized" as const, mimeType: "audio/wav", audio: new Uint8Array([1]) }; },
          async release() { calls.push(`${generation}:release`); },
        };
      },
    },
  });
  const origin = ctx.homeInboxHttp.origin;
  const headers = { authorization, origin, "content-type": "audio/wav" };
  try {
    const oldTurn = await leaseVoiceTurn(origin, headers);
    current = "B";
    assert.equal((await transcribeVoiceTurn(origin, oldTurn, headers, new Uint8Array([1]))).status, 202);
    assert.equal((await speakVoiceTurn(origin, oldTurn, { authorization })).status, 200);
    const newTurn = await leaseVoiceTurn(origin, headers);
    assert.equal((await transcribeVoiceTurn(origin, newTurn, headers, new Uint8Array([1]))).status, 202);
    assert.deepEqual(calls.slice(0, 3), ["A:asr", "A:tts", "B:asr"]);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("expires a private voice capability by releasing its local lease", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  let releases = 0;
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: {
      status: "active",
      beginTurn() { return { captureMode: "encoded_audio" as const, async transcribe() { return { status: "failed" as const, reason: "unavailable" as const }; }, async synthesize() { return { status: "failed" as const, reason: "unavailable" as const }; }, async release() { releases += 1; } }; },
    },
  });
  const origin = ctx.homeInboxHttp.origin;
  try {
    const token = await leaseVoiceTurn(origin, { authorization, origin });
    const service = ctx.homeInboxHttp as unknown as {
      privateVoiceTurns: Map<string, { expiresAt: number }>;
      schedulePrivateVoiceExpiry(): void;
    };
    service.privateVoiceTurns.get(token)!.expiresAt = 0;
    service.schedulePrivateVoiceExpiry();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(releases, 1);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("keeps a second voice upload out of ASR while the household turn is still active", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const inbox = ctx.homeInbox as unknown as StructuredAdviceInbox;
  inbox.availability = "active_request";
  let transcriptionCalls = 0;
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: voiceGateway({
      status: { status: "active" },
      captureMode: "encoded_audio",
      async transcribe() {
        transcriptionCalls += 1;
        return { status: "transcribed" as const, text: "这句不应进入识别" };
      },
      async synthesize() { return { status: "failed" as const, reason: "unavailable" as const }; },
    }),
  } as ProposalInboxHttpOptions);
  const origin = ctx.homeInboxHttp.origin;

  try {
    const response = await transcribeVoiceTurn(origin, await leaseVoiceTurn(origin, { authorization, origin }), { authorization, origin, "content-type": "audio/wav" }, new Uint8Array([1, 2, 3]));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { status: "active", adviceId: "advice-active" });
    assert.equal(transcriptionCalls, 0);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("accepts only bounded PCM headers and maps private voice failures to closed results", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const calls: Array<Record<string, unknown>> = [];
  let transcription: { readonly status: "transcribed"; readonly text: string } | { readonly status: "failed"; readonly reason: string } = {
    status: "transcribed", text: "",
  };
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: voiceGateway({
      status: { status: "active" },
      captureMode: "pcm_s16le",
      async transcribe(input: Record<string, unknown>) { calls.push(input); return transcription; },
      async synthesize() { return { status: "failed" as const, reason: "unavailable" as const }; },
    }),
  } as ProposalInboxHttpOptions);
  const origin = ctx.homeInboxHttp.origin;
  const headers = {
    authorization,
    origin,
    "content-type": "audio/l16",
    "x-audio-rate": "16000",
    "x-audio-width": "2",
    "x-audio-channels": "1",
  };

  try {
    const incomplete = await transcribeVoiceTurn(origin, await leaseVoiceTurn(origin, headers), { authorization, origin, "content-type": "audio/l16" }, new Uint8Array([1]));
    assert.equal(incomplete.status, 400);

    const accepted = await transcribeVoiceTurn(origin, await leaseVoiceTurn(origin, headers), headers, new Uint8Array([1, 2]));
    assert.equal(accepted.status, 422);
    assert.deepEqual(await accepted.json(), { status: "no_input" });
    assert.deepEqual(calls[0]?.format, { rate: 16000, width: 2, channels: 1 });

    transcription = { status: "failed", reason: "endpoint=http://private.invalid token=secret" };
    const failed = await transcribeVoiceTurn(origin, await leaseVoiceTurn(origin, headers), headers, new Uint8Array([1, 2]));
    assert.equal(failed.status, 502);
    const failedBody = await failed.text();
    assert.deepEqual(JSON.parse(failedBody), { status: "failed" });
    assert.equal(failedBody.includes("private.invalid"), false);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("synthesizes only the completed canonical advice answer and never a requested text", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const synthesisCalls: Array<Record<string, unknown>> = [];
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: voiceGateway({
      status: { status: "active" },
      captureMode: "encoded_audio",
      async transcribe() { return { status: "transcribed" as const, text: "客厅现在怎么样？" }; },
      async synthesize(input: Record<string, unknown>) {
        synthesisCalls.push(input);
        return { status: "synthesized" as const, mimeType: "audio/wav", audio: new Uint8Array([82, 73, 70, 70]) };
      },
    }),
  } as ProposalInboxHttpOptions);
  const origin = ctx.homeInboxHttp.origin;

  try {
    const missing = await speakVoiceTurn(origin, "z".repeat(43), { authorization });
    assert.equal(missing.status, 404);
    const turnId = await acceptedVoiceTurn(origin, { authorization, origin, "content-type": "audio/wav" });
    const injected = await fetch(`${origin}/voice/turns/${turnId}/speech?text=turn+off+the+alarm`, { headers: { authorization } });
    assert.equal(injected.status, 400);
    const head = await fetch(`${origin}/voice/turns/${turnId}/speech`, { method: "HEAD", headers: { authorization } });
    assert.equal(head.status, 405);
    assert.equal(head.headers.get("allow"), "GET");
    assert.equal(synthesisCalls.length, 0, "a metadata probe cannot spend a synthesis turn");

    const speech = await speakVoiceTurn(origin, turnId, { authorization });
    assert.equal(speech.status, 200);
    assert.equal(speech.headers.get("content-type"), "audio/wav");
    assert.equal(speech.headers.get("cache-control"), "no-store");
    assert.deepEqual(new Uint8Array(await speech.arrayBuffer()), new Uint8Array([82, 73, 70, 70]));
    assert.deepEqual(synthesisCalls.map((call) => call.text), ["先按日光和最早、最晚边界试用一周。"]);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("wraps Wyoming PCM speech in a browser-playable WAV container", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: voiceGateway({
      status: { status: "active" },
      captureMode: "pcm_s16le",
      async transcribe() { return { status: "transcribed" as const, text: "客厅现在怎么样？" }; },
      async synthesize() {
        return {
          status: "synthesized" as const,
          mimeType: "audio/l16",
          audio: new Uint8Array([0, 0, 255, 127]),
          format: { rate: 16_000, width: 2, channels: 1 },
        };
      },
    }),
  } as ProposalInboxHttpOptions);

  try {
    const speech = await speakVoiceTurn(ctx.homeInboxHttp.origin, await acceptedVoiceTurn(ctx.homeInboxHttp.origin, { authorization, origin: ctx.homeInboxHttp.origin, "content-type": "audio/l16", "x-audio-rate": "16000", "x-audio-width": "2", "x-audio-channels": "1" }), { authorization });
    const audio = new Uint8Array(await speech.arrayBuffer());

    assert.equal(speech.status, 200);
    assert.equal(speech.headers.get("content-type"), "audio/wav");
    assert.equal(new TextDecoder().decode(audio.subarray(0, 4)), "RIFF");
    assert.equal(new TextDecoder().decode(audio.subarray(8, 12)), "WAVE");
    assert.equal(audio.byteLength, 48);
    assert.deepEqual(audio.subarray(44), new Uint8Array([0, 0, 255, 127]));
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("serves only browser-reliable synthesized audio containers", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: voiceGateway({
      status: { status: "active" },
      captureMode: "encoded_audio",
      async transcribe() { return { status: "transcribed" as const, text: "客厅现在怎么样？" }; },
      async synthesize() {
        return {
          status: "synthesized" as const,
          mimeType: "audio/webm",
          audio: new Uint8Array([1, 2]),
        };
      },
    }),
  } as ProposalInboxHttpOptions);

  try {
    const speech = await speakVoiceTurn(ctx.homeInboxHttp.origin, await acceptedVoiceTurn(ctx.homeInboxHttp.origin, { authorization, origin: ctx.homeInboxHttp.origin, "content-type": "audio/wav" }), { authorization });
    assert.equal(speech.status, 502);
    assert.deepEqual(await speech.json(), { status: "failed" });
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("reports an unavailable private speech transport without exposing provider details", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: voiceGateway({
      status: { status: "active" },
      captureMode: "encoded_audio",
      async transcribe() { return { status: "transcribed" as const, text: "客厅现在怎么样？" }; },
      async synthesize() {
        return { status: "failed" as const, reason: "unavailable" };
      },
    }),
  } as ProposalInboxHttpOptions);

  try {
    const speech = await speakVoiceTurn(ctx.homeInboxHttp.origin, await acceptedVoiceTurn(ctx.homeInboxHttp.origin, { authorization, origin: ctx.homeInboxHttp.origin, "content-type": "audio/wav" }), { authorization });
    assert.equal(speech.status, 503);
    assert.deepEqual(await speech.json(), { status: "unavailable" });
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("shares one synthesis for the same answer, caches it briefly, and bounds new speech turns", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(MultiSpeechAdviceInbox);
  let synthesisCalls = 0;
  let releaseFirst: (() => void) | undefined;
  let startedFirst: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: voiceGateway({
      status: { status: "active" },
      captureMode: "encoded_audio",
      async transcribe() { return { status: "transcribed" as const, text: "客厅现在怎么样？" }; },
      async synthesize() {
        synthesisCalls += 1;
        if (synthesisCalls === 1) {
          startedFirst?.();
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        return { status: "synthesized" as const, mimeType: "audio/wav", audio: new Uint8Array([82, 73, 70, 70]) };
      },
    }),
  } as ProposalInboxHttpOptions);
  const origin = ctx.homeInboxHttp.origin;
  const headers = { authorization, origin, "content-type": "audio/wav" };
  const turns: string[] = [];
  const request = (index: number) => speakVoiceTurn(origin, turns[index]!, { authorization });

  try {
    for (let index = 0; index < 6; index += 1) turns.push(await acceptedVoiceTurn(origin, headers));
    const first = request(0);
    await firstStarted;
    const sameAnswer = request(0);
    releaseFirst?.();
    assert.equal((await first).status, 200);
    assert.equal((await sameAnswer).status, 200);
    assert.equal(synthesisCalls, 1, "one advice answer has one in-flight synthesis");
    assert.equal((await request(0)).status, 200);
    assert.equal(synthesisCalls, 1, "a recent canonical answer is served from the short cache");

    for (let index = 1; index <= 5; index += 1) {
      assert.equal((await request(index)).status, 200);
    }
  } finally {
    releaseFirst?.();
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("keeps shared speech synthesis running while one of two listeners remains", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  let upstreamSignal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: voiceGateway({
      status: { status: "active" },
      captureMode: "encoded_audio",
      async transcribe() { return { status: "failed" as const, reason: "unavailable" as const }; },
      async synthesize(input) {
        upstreamSignal = input.signal;
        markStarted?.();
        await new Promise<void>((resolve) => { release = resolve; });
        return { status: "synthesized" as const, mimeType: "audio/wav", audio: new Uint8Array([82, 73, 70, 70]) };
      },
    }),
  } as ProposalInboxHttpOptions);
  const handle = testVoiceSpeechHandler(ctx);
  const firstResponse = new TestVoiceSpeechResponse();
  const secondResponse = new TestVoiceSpeechResponse();

  try {
    const first = handle(testVoiceSpeechRequest(), firstResponse, "advice-stream");
    await started;
    const second = handle(testVoiceSpeechRequest(), secondResponse, "advice-stream");
    await new Promise((resolve) => setImmediate(resolve));
    firstResponse.disconnect();
    assert.equal(upstreamSignal?.aborted, false, "the remaining listener retains the shared synthesis");
    release?.();
    await Promise.all([first, second]);
    assert.equal(firstResponse.writableEnded, false);
    assert.equal(secondResponse.statusCode, 200);
  } finally {
    release?.();
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("aborts shared speech synthesis when its last listener disconnects", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  let upstreamSignal: AbortSignal | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: voiceGateway({
      status: { status: "active" },
      captureMode: "encoded_audio",
      async transcribe() { return { status: "failed" as const, reason: "unavailable" as const }; },
      async synthesize(input) {
        upstreamSignal = input.signal;
        markStarted?.();
        if (input.signal === undefined) return { status: "failed" as const, reason: "unavailable" as const };
        await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }));
        return { status: "failed" as const, reason: "unavailable" as const };
      },
    }),
  } as ProposalInboxHttpOptions);
  const response = new TestVoiceSpeechResponse();

  try {
    const handled = testVoiceSpeechHandler(ctx)(testVoiceSpeechRequest(), response, "advice-stream");
    await started;
    response.disconnect();
    await handled;
    assert.equal(upstreamSignal?.aborted, true);
    assert.equal(response.writableEnded, false);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("never caches speech output returned after every listener cancelled", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  let calls = 0;
  let releaseCancelled: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: voiceGateway({
      status: { status: "active" },
      captureMode: "encoded_audio",
      async transcribe() { return { status: "failed" as const, reason: "unavailable" as const }; },
      async synthesize() {
        calls += 1;
        if (calls === 1) {
          markStarted?.();
          await new Promise<void>((resolve) => { releaseCancelled = resolve; });
        }
        return { status: "synthesized" as const, mimeType: "audio/wav", audio: new Uint8Array([82, 73, 70, 70]) };
      },
    }),
  } as ProposalInboxHttpOptions);
  const handle = testVoiceSpeechHandler(ctx);
  const cancelledResponse = new TestVoiceSpeechResponse();

  try {
    const cancelled = handle(testVoiceSpeechRequest(), cancelledResponse, "advice-stream");
    await started;
    cancelledResponse.disconnect();
    releaseCancelled?.();
    await cancelled;

    const retryResponse = new TestVoiceSpeechResponse();
    await handle(testVoiceSpeechRequest(), retryResponse, "advice-stream");
    assert.equal(calls, 2, "a cancelled synthesis cannot satisfy a later replay from cache");
    assert.equal(retryResponse.statusCode, 200);
  } finally {
    releaseCancelled?.();
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("governs private transcription with one in-flight turn and a recoverable short-window budget", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  let releaseFirst: (() => void) | undefined;
  let startedFirst: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
  let transcriptions = 0;
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: voiceGateway({
      status: { status: "active" },
      captureMode: "encoded_audio",
      async transcribe() {
        transcriptions += 1;
        if (transcriptions === 1) {
          startedFirst?.();
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        return { status: "transcribed" as const, text: "客厅现在怎么样？" };
      },
      async synthesize() { return { status: "failed" as const, reason: "unavailable" as const }; },
    }),
  } as ProposalInboxHttpOptions);
  const origin = ctx.homeInboxHttp.origin;
  const headers = { authorization, origin, "content-type": "audio/wav" };
  const request = async () => transcribeVoiceTurn(origin, await leaseVoiceTurn(origin, headers), headers, new Uint8Array([1, 2]));
  let first: Promise<Response> | undefined;

  try {
    first = request();
    await Promise.race([
      firstStarted,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("first transcription did not start")), 1_000)),
    ]);
    const busy = await request();
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get("retry-after"), "1");
    assert.deepEqual(await busy.json(), { status: "unavailable" });
    assert.equal(transcriptions, 1, "the occupied turn does not read or invoke another ASR request");

    releaseFirst?.();
    assert.equal((await first).status, 202);
    first = undefined;
    assert.equal((await request()).status, 202, "a normal retry proceeds after the first turn releases its slot");

    for (let attempt = 0; attempt < 4; attempt += 1) assert.equal((await request()).status, 202);
    const limited = await request();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "30");
    assert.deepEqual(await limited.json(), { status: "unavailable" });
  } finally {
    releaseFirst?.();
    await first?.catch(() => undefined);
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("ends a slow private audio upload with a recoverable response and releases the ASR turn", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  let transcriptions = 0;
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoiceReadDeadlineMs: 20,
    privateVoice: voiceGateway({
      status: { status: "active" },
      captureMode: "encoded_audio",
      async transcribe() {
        transcriptions += 1;
        return { status: "transcribed" as const, text: "客厅现在怎么样？" };
      },
      async synthesize() { return { status: "failed" as const, reason: "unavailable" as const }; },
    }),
  } as ProposalInboxHttpOptions);
  const origin = ctx.homeInboxHttp.origin;
  const headers = {
    authorization,
    origin,
    "content-type": "audio/wav",
  };

  try {
    const slowTurn = await leaseVoiceTurn(origin, headers);
    const timedOut = await new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
      const request = httpRequest(`${origin}/voice/turns/${slowTurn}/transcribe`, {
        method: "POST",
        headers: { ...headers, "content-length": "2" },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () => {
          request.destroy();
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      });
      request.once("error", reject);
      request.write(Buffer.from([1]));
    });
    assert.equal(timedOut.status, 429);
    assert.deepEqual(JSON.parse(timedOut.body), { status: "unavailable" });
    assert.equal(transcriptions, 0, "a timed-out upload never enters ASR");

    const retry = await transcribeVoiceTurn(origin, await leaseVoiceTurn(origin, headers), headers, new Uint8Array([1, 2]));
    assert.equal(retry.status, 202, "the timed-out upload frees the one-turn ASR slot");
    assert.equal(transcriptions, 1);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("bounds advice events while replay is pending and resumes from the supplied event cursor", async () => {
  class BurstingAdviceInbox extends StructuredAdviceInbox {
    emitted = false;
    readAdviceEvents(_id: string, after?: string) {
      const cursor = Number(after ?? "0");
      return cursor >= 64
        ? [{ id: 65, type: "completed" as const, data: {} }]
        : [];
    }
    subscribeAdvice(_id: string, listener: (event: unknown) => void) {
      if (!this.emitted) {
        this.emitted = true;
        for (let id = 1; id <= 65; id += 1) listener({ id, type: "answer_delta", data: { text: "家庭回答" } });
      }
      return () => undefined;
    }
  }
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(BurstingAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });

  try {
    const overflow = await fetch(`${ctx.homeInboxHttp.origin}/conversation/advice-stream/events`, {
      headers: { authorization },
    });
    assert.equal(overflow.status, 200);
    assert.equal(await overflow.text(), "", "a bounded stream closes before retaining an unbounded live backlog");

    const resumed = await fetch(`${ctx.homeInboxHttp.origin}/conversation/advice-stream/events`, {
      headers: { authorization, "last-event-id": "64" },
    });
    assert.equal(resumed.status, 200);
    assert.match(await resumed.text(), /id: 65\nevent: completed\ndata: \{\}\n\n/);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("bounds queued advice replay by serialized bytes before event count is reached", async () => {
  class LargeBurstAdviceInbox extends StructuredAdviceInbox {
    emitted = false;
    readAdviceEvents() { return []; }
    subscribeAdvice(_id: string, listener: (event: unknown) => void) {
      if (!this.emitted) {
        this.emitted = true;
        const text = "家".repeat(4_096);
        for (let id = 1; id <= 33; id += 1) listener({ id, type: "answer_delta", data: { text } });
      }
      return () => undefined;
    }
  }
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(LargeBurstAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });

  try {
    const overflow = await fetch(`${ctx.homeInboxHttp.origin}/conversation/advice-stream/events`, {
      headers: { authorization },
    });
    assert.equal(overflow.status, 200);
    assert.equal(await overflow.text(), "", "a byte-limited stream closes before retaining a large answer backlog");
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("waits for SSE drain before writing the next replay event", async () => {
  class BackpressuredResponse extends EventEmitter {
    destroyed = false;
    writableEnded = false;
    statusCode = 0;
    readonly chunks: string[] = [];
    writeCount = 0;
    setHeader(): void {}
    flushHeaders(): void {}
    write(chunk: string): boolean {
      this.chunks.push(chunk);
      this.writeCount += 1;
      return this.writeCount !== 1;
    }
    end(): void {
      this.writableEnded = true;
      this.emit("close");
    }
  }
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
  });
  const request = new EventEmitter() as EventEmitter & { headers: Record<string, string> };
  request.headers = {};
  const response = new BackpressuredResponse();

  try {
    const handled = (ctx.homeInboxHttp as unknown as {
      handleAdviceEvents(request: unknown, response: unknown, adviceId: string): Promise<void>;
    }).handleAdviceEvents(request, response, "advice-stream");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(response.writeCount, 1, "one buffered write pauses replay at the transport boundary");
    response.emit("drain");
    await handled;
    assert.equal(response.chunks.filter((chunk) => chunk.startsWith("id:")).length, 5);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("accepts common high-rate PCM while retaining the bounded PCM contract", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  const formats: unknown[] = [];
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: voiceGateway({
      status: { status: "active" },
      captureMode: "pcm_s16le",
      async transcribe(input) {
        formats.push(input.format);
        return { status: "transcribed" as const, text: "客厅现在怎么样？" };
      },
      async synthesize() { return { status: "failed" as const, reason: "unavailable" as const }; },
    }),
  } as ProposalInboxHttpOptions);
  const origin = ctx.homeInboxHttp.origin;
  const headers = (rate: string) => ({
    authorization,
    origin,
    "content-type": "audio/l16",
    "x-audio-rate": rate,
    "x-audio-width": "2",
    "x-audio-channels": "1",
  });

  try {
    for (const rate of ["88200", "96000"]) {
      const accepted = await transcribeVoiceTurn(origin, await leaseVoiceTurn(origin, headers(rate)), headers(rate), new Uint8Array([1, 2]));
      assert.equal(accepted.status, 202);
    }
    assert.deepEqual(formats, [
      { rate: 88_200, width: 2, channels: 1 },
      { rate: 96_000, width: 2, channels: 1 },
    ]);
    const wrongWidth = await transcribeVoiceTurn(origin, await leaseVoiceTurn(origin, headers("16000")), { ...headers("16000"), "x-audio-width": "1" }, new Uint8Array([1, 2]));
    assert.equal(wrongWidth.status, 400);
    const partialFrame = await transcribeVoiceTurn(origin, await leaseVoiceTurn(origin, headers("16000")), headers("16000"), new Uint8Array([1, 2, 3]));
    assert.equal(partialFrame.status, 400);
    const outOfRange = await transcribeVoiceTurn(origin, await leaseVoiceTurn(origin, headers("192000")), headers("192000"), new Uint8Array([1, 2]));
    assert.equal(outOfRange.status, 400);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("releases the private transcription slot after a provider failure", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  let attempts = 0;
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: voiceGateway({
      status: { status: "active" },
      captureMode: "encoded_audio",
      async transcribe() {
        attempts += 1;
        if (attempts === 1) throw new Error("provider private endpoint failed");
        return { status: "transcribed" as const, text: "客厅现在怎么样？" };
      },
      async synthesize() { return { status: "failed" as const, reason: "unavailable" as const }; },
    }),
  } as ProposalInboxHttpOptions);
  const origin = ctx.homeInboxHttp.origin;
  const headers = { authorization, origin, "content-type": "audio/wav" };
  const request = async () => transcribeVoiceTurn(origin, await leaseVoiceTurn(origin, headers), headers, new Uint8Array([1, 2]));

  try {
    assert.equal((await request()).status, 502);
    assert.equal((await request()).status, 202);
    assert.equal(attempts, 2);
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("retries a degraded private voice provider through the authenticated same-origin product route", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StructuredAdviceInbox);
  let status: "active" | "degraded" = "degraded";
  let retries = 0;
  let retrySucceeds = true;
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    principal: adminPrincipal,
    privateVoice: {
      get status() { return status; },
      beginTurn() { return undefined; },
      async retry() { retries += 1; if (retrySucceeds) status = "active"; },
    },
  } as ProposalInboxHttpOptions);
  const origin = ctx.homeInboxHttp.origin;
  const headers = { authorization, origin, "content-type": "application/x-www-form-urlencoded" };

  try {
    const degradedPage = await fetch(`${origin}/voice`, { headers: { authorization } });
    const degradedHtml = await degradedPage.text();
    assert.match(degradedHtml, /data-private-voice-status="retryable"/u);
    assert.match(degradedHtml, /action="\/voice\/retry"/u);
    const foreign = await fetch(`${origin}/voice/retry`, { method: "POST", headers: { ...headers, origin: "https://attacker.invalid" }, body: "", redirect: "manual" });
    assert.equal(foreign.status, 403);
    const retry = await fetch(`${origin}/voice/retry`, { method: "POST", headers, body: "", redirect: "manual" });
    assert.equal(retry.status, 303);
    assert.equal(retry.headers.get("location"), "/voice?notice=voice_retry_result");
    assert.equal(retries, 1);
    const recovered = await fetch(`${origin}${retry.headers.get("location")}`, { headers: { authorization } });
    const recoveredHtml = await recovered.text();
    assert.match(recoveredHtml, /私人语音已重新连接。现在可以开始说话。/u);
    assert.match(recoveredHtml, /data-private-voice-status="active"/u);
    assert.match(recoveredHtml, /data-one-shot-notice/u);
    assert.match(recoveredHtml, /href="\/conversation"[^>]*>改用文字</u);

    status = "degraded";
    retrySucceeds = false;
    const unavailable = await fetch(`${origin}/voice/retry`, { method: "POST", headers, body: "", redirect: "manual" });
    assert.equal(unavailable.status, 303);
    assert.equal(unavailable.headers.get("location"), "/voice?notice=voice_retry_result");
    const stillUnavailable = await fetch(`${origin}${unavailable.headers.get("location")}`, { headers: { authorization } });
    const unavailableHtml = await stillUnavailable.text();
    assert.match(unavailableHtml, /私人语音仍在恢复中。文字对话现在就能继续。/u);
    assert.match(unavailableHtml, /data-private-voice-status="retryable"/u);
    assert.match(unavailableHtml, /data-one-shot-notice/u);
    assert.match(unavailableHtml, />打开文字对话</u);

    const forged = await fetch(`${origin}/voice?notice=voice_recovered`, { headers: { authorization }, redirect: "manual" });
    assert.equal(forged.status, 303);
    assert.equal(forged.headers.get("location"), "/voice");
  } finally {
    await fiber.dispose();
    await inboxFiber.dispose();
    await ctx.fiber.dispose();
  }
});
