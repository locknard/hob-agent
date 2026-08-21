import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Context, Service } from "@deepseek-ai/cordis";

import type { InboxRejectionFeedbackCode, InboxReviewInput } from "./proposal-inbox.js";
import { ADVICE_CLIENT_JS } from "./advice-client.js";
import { INBOX_CSS } from "./inbox-styles.js";
import { renderVoiceSurface } from "./voice-surface.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_FORM_BYTES = 4 * 1024;
// application/x-www-form-urlencoded expands a 1,000-character CJK question to roughly 9 KiB.
const MAX_ADVICE_FORM_BYTES = 12 * 1024;
const MAX_ADVICE_EVENT_TEXT = 4 * 1024;
const MAX_ADVICE_EVENT_ID = 64;
const ADVICE_SSE_HEARTBEAT_MS = 15_000;
const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

export type InboxAuthenticator = (authorization: string | undefined) => boolean;

export interface ProposalInboxHttpOptions {
  /** Port 0 is accepted only as a test/embedding seam. */
  readonly port: number;
  readonly authenticate: InboxAuthenticator;
  readonly reviewer?: string;
}

/**
 * The small, neutral availability vocabulary exposed by the Inbox boundary.
 * The HTTP layer intentionally does not know about DSH, HA, or provider
 * implementation details.
 */
export type AdviceAvailabilityStatus =
  | "ready"
  | "active_request"
  | "setup_required"
  | "home_connecting"
  | "agent_busy"
  | "model_unavailable"
  | "stopped"
  | "unavailable";

export interface AdviceAvailability {
  readonly status: AdviceAvailabilityStatus;
  readonly activeAdviceId?: string;
}

export type AdviceProgressEventType =
  | "accepted"
  | "inspecting_home"
  | "reading_inventory"
  | "checking_rules"
  | "evaluating_evidence"
  | "composing_answer"
  | "answer_delta"
  | "completed"
  | "failed"
  | "cancelled";

/** Untrusted input from the agent layer; it is narrowed before SSE delivery. */
export interface AdviceProgressEvent {
  readonly id: string | number;
  readonly type: AdviceProgressEventType | "progress";
  readonly data?: unknown;
  readonly text?: unknown;
}

export interface AdviceStartResult {
  readonly id?: string;
  readonly status?: "accepted" | "active_request" | "already_active";
  readonly activeAdviceId?: string;
}

type AdviceEventListener = (event: AdviceProgressEvent) => void;

interface InboxHttpPort {
  renderControlCenter?(): string;
  renderList(): string;
  renderDetail(proposalId: string): string | undefined;
  review(input: InboxReviewInput): Promise<unknown>;
  canRetryPreparation?(): boolean;
  retryPreparation?(input: {
    proposalId: string;
    expectedRevision: number;
    expectedVersion: number;
  }): Promise<unknown>;
  canObserveNow(): boolean;
  observeNow(): Promise<unknown>;
  /** New asynchronous advice port. Each method is optional for old embedders. */
  getAdviceAvailability?(): AdviceAvailability | Promise<AdviceAvailability>;
  adviceAvailability?(): AdviceAvailability | Promise<AdviceAvailability>;
  availability?(): AdviceAvailability | Promise<AdviceAvailability>;
  startAdvice?(question: string): Promise<AdviceStartResult>;
  ask?(question: string): Promise<AdviceStartResult | { id: string }>;
  readAdviceEvents?(
    id: string,
    after?: string,
  ): readonly AdviceProgressEvent[] | Promise<readonly AdviceProgressEvent[]>;
  events?(
    id: string,
    afterSeq?: number,
  ): readonly AdviceProgressEvent[] | Promise<readonly AdviceProgressEvent[]>;
  subscribeAdvice?(id: string, listener: AdviceEventListener): void | (() => void);
  subscribe?(id: string, listener: AdviceEventListener, afterSeq?: number): void | (() => void);
  unsubscribeAdvice?(id: string, listener: AdviceEventListener): void;
  unsubscribe?(id: string, listener: AdviceEventListener): void;
  cancelAdvice?(id: string): Promise<unknown> | unknown;
  cancel?(id: string): Promise<unknown> | unknown;
  /** Compatibility port for the pre-streaming Inbox service. */
  canAskAdvice?(): boolean;
  askAdvice?(question: string): Promise<{ id: string }>;
  renderAdvice(id: string): string | undefined;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeInboxHttp: ProposalInboxHttpService;
  }
}

/** Creates a constant-time HTTP Basic verifier without retaining the raw token. */
export function createInboxBasicAuthenticator(token: string): InboxAuthenticator {
  if (typeof token !== "string" || token.length < 32 || token.length > 512) {
    throw new TypeError("Inbox authentication token must be at least 32 and at most 512 characters");
  }
  const expected = digest(`Basic ${Buffer.from(`home:${token}`).toString("base64")}`);
  return (authorization) => timingSafeEqual(expected, digest(authorization ?? ""));
}

/** Optional localhost-only HTTP delivery for the same-root Inbox controller. */
export class ProposalInboxHttpService extends Service {
  static inject = ["homeInbox"];

  origin = "";
  private readonly server: Server;
  private readonly inbox: InboxHttpPort;
  private readonly reviewer: string;

  constructor(ctx: Context, private readonly options: ProposalInboxHttpOptions) {
    super(ctx, "homeInboxHttp");
    if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new TypeError("Inbox HTTP port must be an integer from 0 to 65535");
    }
    if (typeof options.authenticate !== "function") throw new TypeError("Inbox HTTP authenticator is required");
    this.reviewer = options.reviewer?.trim() || "local-household-reviewer";
    if (this.reviewer.length > 200) throw new TypeError("Inbox reviewer identity is too long");
    this.inbox = ctx.homeInbox as unknown as InboxHttpPort;
    this.server = createServer((request, response) => { void this.handle(request, response); });
  }

  protected async [Service.init](): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.options.port, LOOPBACK_HOST, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("Inbox HTTP listener has no TCP address");
    this.origin = `http://${LOOPBACK_HOST}:${address.port}`;
    this.ctx.effect(() => async () => {
      this.server.closeIdleConnections?.();
      await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    }, "home-inbox-http.close");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.options.authenticate(request.headers.authorization)) {
        response.setHeader("www-authenticate", 'Basic realm="hob-agent Inbox", charset="UTF-8"');
        return send(response, 401, "Authentication required");
      }
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", this.origin);
      if ((method === "GET" || method === "HEAD") && url.pathname === "/assets/inbox.css") {
        return sendCss(response, 200, INBOX_CSS, method === "HEAD");
      }
      if ((method === "GET" || method === "HEAD") && url.pathname === "/assets/advice.js") {
        return sendJavaScript(response, 200, ADVICE_CLIENT_JS, method === "HEAD");
      }
      if ((method === "GET" || method === "HEAD") && (url.pathname === "/" || url.pathname === "/control-center")) {
        const html = this.inbox.renderControlCenter?.();
        return html === undefined
          ? send(response, 404, "Control center unavailable")
          : sendHtml(response, 200, document(html, "Control center · hob-agent", "overview"), method === "HEAD");
      }
      if ((method === "GET" || method === "HEAD") && url.pathname === "/voice-preview") {
        const stateValues = url.searchParams.getAll("state");
        const html = stateValues.length > 1 ? undefined : renderVoiceSurface(stateValues[0] ?? "idle");
        return html === undefined
          ? send(response, 404, "Voice preview state not found")
          : sendHtml(response, 200, document(html, "Voice lab · hob-agent", "voice"), method === "HEAD");
      }
      if ((method === "GET" || method === "HEAD") && url.pathname === "/proposals") {
        return sendHtml(response, 200, document(this.inbox.renderList(), "Home · hob-agent", "inbox"), method === "HEAD");
      }
      if ((method === "GET" || method === "HEAD") && url.pathname === "/advice") {
        return redirectAdviceAvailability(response);
      }
      const adviceEvents = /^\/advice\/([^/]+)\/events$/.exec(url.pathname);
      if (method === "GET" && adviceEvents) {
        const adviceId = safeDecode(adviceEvents[1]!);
        return adviceId === undefined
          ? send(response, 404, "Household advice not found")
          : this.handleAdviceEvents(request, response, adviceId);
      }
      const adviceCancel = /^\/advice\/([^/]+)\/cancel$/.exec(url.pathname);
      if (method === "POST" && adviceCancel) {
        if (request.headers.origin !== this.origin) return send(response, 403, "Household advice origin rejected");
        const adviceId = safeDecode(adviceCancel[1]!);
        if (adviceId === undefined) return send(response, 400, "Invalid household advice cancellation");
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported household advice content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid household advice cancellation");
        }
        if (body.length !== 0) return send(response, 400, "Invalid household advice cancellation");
        const cancelAdvice = this.inbox.cancelAdvice ?? this.inbox.cancel;
        if (cancelAdvice === undefined) return send(response, 404, "Household advice cancellation unavailable");
        try {
          const result = await cancelAdvice.call(this.inbox, adviceId);
          const status = adviceCancelStatus(result);
          if (status === "not_found") return send(response, 404, "Household advice not found");
          if (status === "terminal_status") return send(response, 409, "Household advice is no longer running");
        } catch (error) {
          const code = errorCode(error);
          if (code === "not_found") return send(response, 404, "Household advice not found");
          if (code === "terminal_status") return send(response, 409, "Household advice is no longer running");
          return send(response, 500, "Household advice cancellation failed");
        }
        response.statusCode = 303;
        applySecurityHeaders(response);
        response.setHeader("location", `/advice/${encodeURIComponent(adviceId)}`);
        response.end();
        return;
      }
      const adviceDetail = /^\/advice\/([^/]+)$/.exec(url.pathname);
      if ((method === "GET" || method === "HEAD") && adviceDetail) {
        const adviceId = safeDecode(adviceDetail[1]!);
        const html = adviceId === undefined ? undefined : this.inbox.renderAdvice(adviceId);
        return html === undefined
          ? send(response, 404, "Household advice not found")
          : sendHtml(response, 200, document(html, "Advice · hob-agent", "inbox"), method === "HEAD");
      }
      if (method === "POST" && url.pathname === "/advice") {
        if (request.headers.origin !== this.origin) return send(response, 403, "Household advice origin rejected");
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported household advice content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request, MAX_ADVICE_FORM_BYTES);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid household advice request");
        }
        const question = adviceQuestion(body);
        if (question === undefined) return send(response, 400, "Invalid household advice request");
        const availability = await this.adviceAvailability();
        if (availability.status !== "ready") {
          if (availability.status === "active_request" && availability.activeAdviceId !== undefined) {
            return redirectAdvice(response, availability.activeAdviceId);
          }
          return redirectAdviceAvailability(response);
        }
        let advice: AdviceStartResult;
        try {
          advice = await this.startAdvice(question);
        } catch (error) {
          const code = errorCode(error);
          const activeAdviceId = adviceActiveId(error);
          if ((code === "active_request" || code === "already_active") && activeAdviceId !== undefined) {
            return redirectAdvice(response, activeAdviceId);
          }
          if (isAdviceAvailabilityStatus(code)) {
            return redirectAdviceAvailability(response);
          }
          return send(response, 500, "Household advice request failed");
        }
        if (advice.id === undefined || safeDecode(advice.id) === undefined) {
          if ((advice.status === "active_request" || advice.status === "already_active")
            && advice.activeAdviceId !== undefined) return redirectAdvice(response, advice.activeAdviceId);
          return send(response, 500, "Household advice request failed");
        }
        if ((advice.status === "active_request" || advice.status === "already_active")
          && advice.activeAdviceId !== undefined) {
          return redirectAdvice(response, advice.activeAdviceId);
        }
        return redirectAdvice(response, advice.id);
      }
      const detail = /^\/proposals\/([^/]+)$/.exec(url.pathname);
      if ((method === "GET" || method === "HEAD") && detail) {
        const proposalId = safeDecode(detail[1]!);
        const html = proposalId === undefined ? undefined : this.inbox.renderDetail(proposalId);
        return html === undefined
          ? send(response, 404, "Proposal not found")
          : sendHtml(response, 200, document(html, "Proposal · hob-agent", "inbox"), method === "HEAD");
      }
      if (method === "POST" && url.pathname === "/observations/run") {
        if (request.headers.origin !== this.origin) return send(response, 403, "Observation origin rejected");
        if (!this.inbox.canObserveNow()) return send(response, 404, "Observation unavailable");
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported observation content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid observation request");
        }
        if (body.length !== 0) return send(response, 400, "Invalid observation request");
        try {
          await this.inbox.observeNow();
        } catch {
          return send(response, 500, "Observation failed");
        }
        response.statusCode = 303;
        applySecurityHeaders(response);
        response.setHeader("location", "/proposals");
        response.end();
        return;
      }
      const preparationRetry = /^\/proposals\/([^/]+)\/preparation\/retry$/.exec(url.pathname);
      if (method === "POST" && preparationRetry) {
        if (request.headers.origin !== this.origin) return send(response, 403, "Preparation retry origin rejected");
        if (!(this.inbox.canRetryPreparation?.() ?? false) || this.inbox.retryPreparation === undefined) {
          return send(response, 404, "Preparation retry unavailable");
        }
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported preparation retry content type");
        }
        const proposalId = safeDecode(preparationRetry[1]!);
        if (proposalId === undefined) return send(response, 400, "Invalid preparation retry");
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid preparation retry");
        }
        const input = preparationRetryInput(proposalId, body);
        if (input === undefined) return send(response, 400, "Invalid preparation retry");
        try {
          await this.inbox.retryPreparation(input);
        } catch (error) {
          const code = errorCode(error);
          if (code === "job_transition_conflict" || code === "revision_conflict") {
            return send(response, 409, "Preparation retry conflict");
          }
          if (code === "not_found") return send(response, 404, "Preparation job not found");
          return send(response, 500, "Preparation retry failed");
        }
        response.statusCode = 303;
        applySecurityHeaders(response);
        response.setHeader("location", `/proposals/${encodeURIComponent(proposalId)}`);
        response.end();
        return;
      }
      const review = /^\/proposals\/([^/]+)\/review$/.exec(url.pathname);
      if (method === "POST" && review) {
        if (request.headers.origin !== this.origin) return send(response, 403, "Review origin rejected");
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported review content type");
        }
        const proposalId = safeDecode(review[1]!);
        if (proposalId === undefined) return send(response, 400, "Invalid proposal review");
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid proposal review");
        }
        const input = reviewInput(proposalId, body, this.reviewer);
        if (input === undefined) return send(response, 400, "Invalid proposal review");
        try {
          await this.inbox.review(input);
        } catch (error) {
          const code = errorCode(error);
          if (code === "revision_conflict" || code === "terminal_status") {
            return send(response, 409, "Proposal review conflict");
          }
          if (code === "not_found") return send(response, 404, "Proposal not found");
          return send(response, 500, "Proposal review failed");
        }
        response.statusCode = 303;
        applySecurityHeaders(response);
        response.setHeader("location", `/proposals/${encodeURIComponent(proposalId)}`);
        response.end();
        return;
      }
      if (!["GET", "HEAD", "POST"].includes(method)) {
        response.setHeader("allow", "GET, HEAD, POST");
        return send(response, 405, "Method not allowed");
      }
      return send(response, 404, "Not found");
    } catch {
      return send(response, 500, "Inbox request failed");
    }
  }

  private async adviceAvailability(): Promise<AdviceAvailability> {
    const getAvailability = this.inbox.getAdviceAvailability ?? this.inbox.adviceAvailability ?? this.inbox.availability;
    if (getAvailability !== undefined) {
      try {
        return normalizeAdviceAvailability(await getAvailability.call(this.inbox));
      } catch {
        return { status: "stopped" };
      }
    }
    return this.inbox.canAskAdvice?.() === true ? { status: "ready" } : { status: "unavailable" };
  }

  private async startAdvice(question: string): Promise<AdviceStartResult> {
    const start = this.inbox.startAdvice ?? this.inbox.ask;
    if (start !== undefined) {
      return normalizeAdviceStart(await start.call(this.inbox, question));
    }
    if (this.inbox.askAdvice !== undefined) {
      return normalizeAdviceStart(await this.inbox.askAdvice(question));
    }
    throw new Error("advice_unavailable");
  }

  private async handleAdviceEvents(
    request: IncomingMessage,
    response: ServerResponse,
    adviceId: string,
  ): Promise<void> {
    const readEvents = this.inbox.readAdviceEvents;
    const legacyReadEvents = this.inbox.events;
    const subscribeAdvice = this.inbox.subscribeAdvice;
    const subscribeLegacy = this.inbox.subscribe;
    if (readEvents === undefined && legacyReadEvents === undefined
      && subscribeAdvice === undefined && subscribeLegacy === undefined) {
      return send(response, 404, "Household advice progress unavailable");
    }

    applySseHeaders(response);
    response.flushHeaders();
    let closed = false;
    let replaying = true;
    let terminal = false;
    let lastSent: string | undefined;
    let highestSentSequence: number | undefined = adviceEventSequence(lastEventId(request.headers["last-event-id"]));
    const queued: AdviceProgressEvent[] = [];
    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let finish: (() => void) | undefined;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (unsubscribe !== undefined) {
        try { unsubscribe(); } catch { /* adapter cleanup must not affect the client */ }
      } else {
        const remove = this.inbox.unsubscribeAdvice ?? this.inbox.unsubscribe;
        if (remove !== undefined) {
          try { remove.call(this.inbox, adviceId, onAdviceEvent); } catch { /* best effort */ }
        }
      }
      finish?.();
    };

    const writeEvent = (raw: AdviceProgressEvent) => {
      const event = safeAdviceEvent(raw);
      if (event === undefined || closed) return;
      const eventId = String(event.id);
      if (lastSent !== undefined && eventId === lastSent) return;
      const sequence = adviceEventSequence(eventId);
      if (sequence !== undefined && highestSentSequence !== undefined && sequence <= highestSentSequence) return;
      if (response.destroyed) {
        cleanup();
        return;
      }
      response.write(formatSseEvent(event));
      lastSent = eventId;
      if (sequence !== undefined) highestSentSequence = sequence;
      if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") terminal = true;
    };

    function onAdviceEvent(event: AdviceProgressEvent): void {
      if (replaying) queued.push(event);
      else writeEvent(event);
      if (!replaying && terminal) {
        cleanup();
        response.end();
      }
    }

    try {
      const after = lastEventId(request.headers["last-event-id"]);
      if (subscribeAdvice !== undefined) {
        unsubscribe = subscribeAdvice.call(this.inbox, adviceId, onAdviceEvent) ?? undefined;
      } else if (subscribeLegacy !== undefined) {
        unsubscribe = subscribeLegacy.call(this.inbox, adviceId, onAdviceEvent, adviceEventSequence(after) ?? 0) ?? undefined;
      }
      const replay = readEvents !== undefined
        ? await readEvents.call(this.inbox, adviceId, after)
        : legacyReadEvents === undefined
          ? []
          : await legacyReadEvents.call(this.inbox, adviceId, after === undefined ? 0 : Number(after));
      for (const event of replay) writeEvent(event);
      replaying = false;
      for (const event of queued) writeEvent(event);
      queued.length = 0;
      if (terminal) {
        cleanup();
        response.end();
        return;
      }
      heartbeat = setInterval(() => {
        if (closed || response.destroyed) {
          cleanup();
          return;
        }
        response.write(": heartbeat\n\n");
      }, ADVICE_SSE_HEARTBEAT_MS);
      await new Promise<void>((resolve) => {
        finish = resolve;
        response.once("close", cleanup);
        request.once("aborted", cleanup);
        if (response.destroyed) cleanup();
      });
    } catch {
      cleanup();
      if (!response.writableEnded) response.end();
    }
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function applySecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
}

function applySseHeaders(response: ServerResponse): void {
  applySecurityHeaders(response);
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
}

function redirectAdvice(response: ServerResponse, adviceId: string): void {
  if (safeDecode(adviceId) === undefined) {
    send(response, 500, "Household advice request failed");
    return;
  }
  response.statusCode = 303;
  applySecurityHeaders(response);
  response.setHeader("location", `/advice/${encodeURIComponent(adviceId)}`);
  response.end();
}

function redirectAdviceAvailability(response: ServerResponse): void {
  response.statusCode = 303;
  applySecurityHeaders(response);
  response.setHeader("location", "/proposals#advice");
  response.end();
}

function normalizeAdviceAvailability(value: unknown): AdviceAvailability {
  if (!isRecord(value)) return { status: "unavailable" };
  const rawStatus = typeof value.status === "string" ? value.status : value.state;
  const status = isAdviceAvailabilityStatus(rawStatus) ? rawStatus : "unavailable";
  const activeAdviceId = typeof value.activeAdviceId === "string" && safeDecode(value.activeAdviceId) !== undefined
    ? value.activeAdviceId
    : undefined;
  return activeAdviceId === undefined ? { status } : { status, activeAdviceId };
}

function normalizeAdviceStart(value: unknown): AdviceStartResult {
  if (!isRecord(value)) throw new Error("advice_start_invalid");
  const status = value.status === "active_request" || value.status === "already_active" || value.status === "accepted"
    ? value.status
    : undefined;
  const activeAdviceId = typeof value.activeAdviceId === "string" && safeDecode(value.activeAdviceId) !== undefined
    ? value.activeAdviceId
    : undefined;
  const id = typeof value.id === "string" ? value.id : activeAdviceId;
  if (id === undefined) throw new Error("advice_start_invalid");
  return status === undefined && activeAdviceId === undefined
    ? { id }
    : { id, ...(status === undefined ? {} : { status }), ...(activeAdviceId === undefined ? {} : { activeAdviceId }) };
}

function isAdviceAvailabilityStatus(value: unknown): value is AdviceAvailabilityStatus {
  return value === "ready" || value === "active_request" || value === "setup_required"
    || value === "home_connecting" || value === "agent_busy" || value === "model_unavailable"
    || value === "stopped" || value === "unavailable";
}

function adviceCancelStatus(value: unknown): "cancelled" | "not_found" | "terminal_status" | undefined {
  if (value === true) return "cancelled";
  if (value === false) return "terminal_status";
  if (!isRecord(value) || typeof value.status !== "string") return undefined;
  return value.status === "cancelled" || value.status === "not_found" || value.status === "terminal_status"
    ? value.status
    : undefined;
}

function adviceActiveId(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const value = error.activeAdviceId;
  return typeof value === "string" && safeDecode(value) !== undefined ? value : undefined;
}

type SafeAdviceEvent = {
  readonly id: string | number;
  readonly type: AdviceProgressEventType;
  readonly data: Record<string, string>;
};

function safeAdviceEvent(value: AdviceProgressEvent): SafeAdviceEvent | undefined {
  if (!isRecord(value)) return undefined;
  const id = safeEventId(value.id);
  if (id === undefined) return undefined;
  const data = isRecord(value.data) ? value.data : {};
  const rawType = typeof value.type === "string" ? value.type : undefined;
  const type = rawType === "progress" && typeof data.phase === "string" ? data.phase : rawType;
  if (type === "accepted" || type === "inspecting_home" || type === "reading_inventory"
    || type === "checking_rules" || type === "evaluating_evidence" || type === "composing_answer") {
    return { id, type, data: {} };
  }
  if (type === "answer_delta") {
    const rawText = typeof data.text === "string" ? data.text : value.text;
    const text = boundedEventText(rawText);
    return text === undefined ? undefined : { id, type, data: { text } };
  }
  if (type === "completed") return { id, type, data: {} };
  if (type === "failed") return { id, type, data: { reason: "advice_failed" } };
  if (type === "cancelled") return { id, type, data: {} };
  return undefined;
}

function safeEventId(value: unknown): string | number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ADVICE_EVENT_ID) return undefined;
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined;
}

function boundedEventText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, MAX_ADVICE_EVENT_TEXT);
  return text.length === 0 ? undefined : text;
}

function formatSseEvent(event: SafeAdviceEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function lastEventId(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return undefined;
  if (value === undefined || value.length === 0 || value.length > MAX_ADVICE_EVENT_ID) return undefined;
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined;
}

function adviceEventSequence(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function send(response: ServerResponse, status: number, text: string): void {
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(text);
}

function sendHtml(response: ServerResponse, status: number, html: string, head: boolean): void {
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(head ? undefined : html);
}

function sendCss(response: ServerResponse, status: number, css: string, head: boolean): void {
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "text/css; charset=utf-8");
  response.end(head ? undefined : css);
}

function sendJavaScript(response: ServerResponse, status: number, script: string, head: boolean): void {
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "text/javascript; charset=utf-8");
  response.end(head ? undefined : script);
}

function document(content: string, title: string, current: "overview" | "inbox" | "voice"): string {
  const currentAttribute = (page: "overview" | "inbox" | "voice") => page === current ? ` aria-current="page"` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f3f7f2"><title>${title}</title><link rel="stylesheet" href="/assets/inbox.css"></head><body><a class="skip-link" href="#main-content">Skip to main content</a><div class="app-shell"><header class="app-topbar"><a class="brand" href="/control-center"><strong>hob-agent</strong><span>Household agent</span></a><span class="topbar-note">Local review</span></header><div class="app-body"><nav class="app-nav" aria-label="Primary"><a href="/control-center"${currentAttribute("overview")}><span class="nav-mark" aria-hidden="true">O</span>Overview</a><a href="/proposals"${currentAttribute("inbox")}><span class="nav-mark" aria-hidden="true">I</span>Inbox</a><a href="/voice-preview"${currentAttribute("voice")}><span class="nav-mark" aria-hidden="true">V</span>Voice lab</a></nav><div class="app-content">${content}</div></div></div></body></html>`;
}

function mediaType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}

function safeDecode(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 200 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function adviceQuestion(body: string): string | undefined {
  const params = new URLSearchParams(body);
  if ([...params.keys()].some((key) => key !== "question") || params.getAll("question").length !== 1) return undefined;
  const question = params.get("question")?.trim();
  return question !== undefined && question.length >= 1 && question.length <= 1_000 ? question : undefined;
}

function preparationRetryInput(
  proposalId: string,
  body: string,
): { proposalId: string; expectedRevision: number; expectedVersion: number } | undefined {
  const params = new URLSearchParams(body);
  if ([...params.keys()].some((key) => !["expectedRevision", "expectedVersion"].includes(key))
    || params.getAll("expectedRevision").length !== 1
    || params.getAll("expectedVersion").length !== 1) return undefined;
  const expectedRevision = positiveInteger(params.get("expectedRevision"));
  const expectedVersion = positiveInteger(params.get("expectedVersion"));
  return expectedRevision === undefined || expectedVersion === undefined
    ? undefined
    : { proposalId, expectedRevision, expectedVersion };
}

function positiveInteger(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readBoundedBody(request: IncomingMessage, maximumBytes = MAX_FORM_BYTES): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new PayloadTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) overflow = true;
    else chunks.push(buffer);
  }
  if (overflow) throw new PayloadTooLargeError();
  return Buffer.concat(chunks).toString("utf8");
}

class PayloadTooLargeError extends Error {}

function isPayloadTooLarge(error: unknown): boolean {
  return error instanceof PayloadTooLargeError;
}

function reviewInput(proposalId: string, body: string, reviewer: string): InboxReviewInput | undefined {
  const form = new URLSearchParams(body);
  if ([...form.keys()].some((key) => !["expectedRevision", "decision", "feedbackCode", "note"].includes(key))) return undefined;
  if (form.getAll("expectedRevision").length !== 1 || form.getAll("decision").length !== 1
    || form.getAll("feedbackCode").length !== 1 || form.getAll("note").length > 1) {
    return undefined;
  }
  const revisionRaw = form.get("expectedRevision") ?? "";
  if (!/^[1-9]\d*$/.test(revisionRaw)) return undefined;
  const expectedRevision = Number(revisionRaw);
  if (!Number.isSafeInteger(expectedRevision)) return undefined;
  const decision = form.get("decision");
  if (decision !== "approved" && decision !== "rejected") return undefined;
  const feedbackCode = form.get("feedbackCode");
  const note = form.get("note")?.trim();
  if (note !== undefined && note.length > 1_000) return undefined;
  if (feedbackCode === "other" && !note) return undefined;
  const base = {
    proposalId,
    expectedRevision,
    reviewer,
    ...(note ? { note } : {}),
  };
  if (decision === "approved") {
    return feedbackCode === "useful_as_is"
      ? { ...base, decision, feedbackCode }
      : undefined;
  }
  return isRejectionFeedbackCode(feedbackCode)
    ? { ...base, decision, feedbackCode }
    : undefined;
}

function isRejectionFeedbackCode(value: string | null): value is InboxRejectionFeedbackCode {
  return value !== null && [
    "already_covered",
    "not_useful",
    "incorrect_assumption",
    "insufficient_evidence",
    "household_preference",
    "too_risky",
    "other",
  ].includes(value);
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}
