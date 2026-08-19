import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Context, Service } from "@deepseek-ai/cordis";

import type { InboxRejectionFeedbackCode, InboxReviewInput } from "./proposal-inbox.js";
import { INBOX_CSS } from "./inbox-styles.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_FORM_BYTES = 4 * 1024;
const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
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

interface InboxHttpPort {
  renderList(): string;
  renderDetail(proposalId: string): string | undefined;
  review(input: InboxReviewInput): Promise<unknown>;
  canObserveNow(): boolean;
  observeNow(): Promise<unknown>;
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
      if ((method === "GET" || method === "HEAD") && url.pathname === "/proposals") {
        return sendHtml(response, 200, document(this.inbox.renderList()), method === "HEAD");
      }
      const detail = /^\/proposals\/([^/]+)$/.exec(url.pathname);
      if ((method === "GET" || method === "HEAD") && detail) {
        const proposalId = safeDecode(detail[1]!);
        const html = proposalId === undefined ? undefined : this.inbox.renderDetail(proposalId);
        return html === undefined
          ? send(response, 404, "Proposal not found")
          : sendHtml(response, 200, document(html), method === "HEAD");
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
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function applySecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
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

function document(content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f3f7f2"><title>Reviews · hob-agent</title><link rel="stylesheet" href="/assets/inbox.css"></head><body><a class="skip-link" href="#main-content">Skip to main content</a><div class="app-shell"><header class="app-topbar"><a class="brand" href="/proposals"><strong>hob-agent</strong><span>Household agent</span></a><span class="topbar-note">Local review</span></header><div class="app-body"><nav class="app-nav" aria-label="Primary"><a href="/proposals#overview"><span class="nav-mark" aria-hidden="true">O</span>Overview</a><a href="/proposals#reviews" aria-current="page"><span class="nav-mark" aria-hidden="true">R</span>Reviews</a><a href="/proposals#observations"><span class="nav-mark" aria-hidden="true">A</span>Observations</a><a href="/proposals#home"><span class="nav-mark" aria-hidden="true">H</span>Home</a><a href="/proposals#settings"><span class="nav-mark" aria-hidden="true">S</span>Settings</a></nav><div class="app-content">${content}</div></div></div></body></html>`;
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

async function readBoundedBody(request: IncomingMessage): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) throw new PayloadTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_FORM_BYTES) overflow = true;
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
