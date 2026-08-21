import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

import {
  ProposalInboxHttpService,
  createInboxBasicAuthenticator,
} from "./proposal-inbox-http-service.js";

class StubInbox extends Service {
  readonly reviews: unknown[] = [];
  observations = 0;
  readonly questions: string[] = [];

  constructor(ctx: Context) {
    super(ctx, "homeInbox");
  }

  renderList() { return "<main>Inbox list</main>"; }
  renderControlCenter() { return "<main>Control center</main>"; }
  renderDetail(id: string) { return id === "proposal-1" ? "<main>Proposal detail</main>" : undefined; }
  async review(input: unknown) {
    this.reviews.push(input);
    return { status: "approved" };
  }
  canObserveNow() { return true; }
  async observeNow() { this.observations += 1; return "no_proposal"; }
  canAskAdvice() { return true; }
  async askAdvice(question: string) { this.questions.push(question); return { id: "advice-1" }; }
  renderAdvice(id: string) { return id === "advice-1" ? "<main>Advice detail</main>" : undefined; }
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

  renderAdvice(id: string) {
    return id === this.adviceId || id === "advice-active" ? "<main>Advice detail</main>" : undefined;
  }
}

const token = "a-secure-local-inbox-token-1234567890";
const authorization = `Basic ${Buffer.from(`home:${token}`).toString("base64")}`;

test("serves an authenticated localhost-only Inbox with restrictive response headers", async () => {
  const ctx = new Context();
  await ctx.plugin(StubInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    reviewer: "local-household-reviewer",
  });

  assert.match(ctx.homeInboxHttp.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const unauthenticated = await fetch(`${ctx.homeInboxHttp.origin}/proposals`);
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get("www-authenticate") ?? "", /^Basic /);

  const response = await fetch(`${ctx.homeInboxHttp.origin}/proposals`, {
    headers: { authorization },
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Inbox list/);

  const adviceEntry = await fetch(`${ctx.homeInboxHttp.origin}/advice`, {
    headers: { authorization },
    redirect: "manual",
  });
  assert.equal(adviceEntry.status, 303);
  assert.equal(adviceEntry.headers.get("location"), "/proposals#advice");

  const controlCenter = await fetch(`${ctx.homeInboxHttp.origin}/`, {
    headers: { authorization },
  });
  assert.equal(controlCenter.status, 200);
  const controlCenterHtml = await controlCenter.text();
  assert.match(controlCenterHtml, /Control center/);
  const primaryNavigation = controlCenterHtml.match(/<nav class="app-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? "";
  assert.equal((primaryNavigation.match(/<a /g) ?? []).length, 3);
  assert.match(primaryNavigation, />Overview<\/a>/);
  assert.match(primaryNavigation, />Inbox<\/a>/);
  assert.match(primaryNavigation, />Voice lab<\/a>/);
  assert.equal(primaryNavigation.includes("#observations"), false);

  const namedControlCenter = await fetch(`${ctx.homeInboxHttp.origin}/control-center`, {
    headers: { authorization },
  });
  assert.equal(namedControlCenter.status, 200);
  assert.match(await namedControlCenter.text(), /Control center/);
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
  assert.equal(adviceClient.status, 200);
  assert.equal(adviceClient.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(await adviceClient.text(), /new EventSource/);

  const stylesheet = await fetch(`${ctx.homeInboxHttp.origin}/assets/inbox.css`, {
    headers: { authorization },
  });
  assert.equal(stylesheet.status, 200);
  assert.equal(stylesheet.headers.get("content-type"), "text/css; charset=utf-8");
  const stylesheetText = await stylesheet.text();
  assert.match(stylesheetText, /--color-ink:/);
  assert.match(stylesheetText, /\.brand\s*\{[^}]*min-height:\s*2\.75rem/s);
  assert.match(stylesheetText, /\.advice-form\s*\{/);
  assert.match(stylesheetText, /\.hardware-suggestions\s*\{/);
  assert.match(stylesheetText, /\.home-pulse\s*\{/);
  assert.match(stylesheetText, /data-voice-state="listening"/);
  assert.match(stylesheetText, /prefers-reduced-motion:\s*reduce/);

  const voicePreview = await fetch(`${ctx.homeInboxHttp.origin}/voice-preview?state=awaiting_confirmation`, {
    headers: { authorization },
  });
  assert.equal(voicePreview.status, 200);
  const voicePreviewHtml = await voicePreview.text();
  assert.match(voicePreviewHtml, /data-voice-state="awaiting_confirmation"/);
  assert.match(voicePreviewHtml, /aria-current="page"[^>]*>[^<]*<span[^>]*>V<\/span>Voice lab/);
  assert.equal(voicePreviewHtml.includes("<script"), false);

  const invalidVoiceState = await fetch(`${ctx.homeInboxHttp.origin}/voice-preview?state=%3Cscript%3E`, {
    headers: { authorization },
  });
  assert.equal(invalidVoiceState.status, 404);

  const html = await fetch(`${ctx.homeInboxHttp.origin}/proposals`, {
    headers: { authorization },
  }).then((page) => page.text());
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /href="\/assets\/inbox.css"/);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /aria-label="Primary"/);
  assert.match(html, /href="\/proposals"[^>]*>[^<]*<span[^>]*>I<\/span>Inbox/);

  await fiber.dispose();
  assert.equal(ctx.homeInboxHttp, undefined);
  await ctx.fiber.dispose();
});

test("requires exact same-origin review posts and derives reviewer identity from configuration", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
    reviewer: "local-household-reviewer",
  });
  const url = `${ctx.homeInboxHttp.origin}/proposals/proposal-1/review`;
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
  assert.equal(accepted.headers.get("location"), "/proposals/proposal-1");
  assert.deepEqual((ctx.homeInbox as unknown as StubInbox).reviews, [{
    proposalId: "proposal-1",
    expectedRevision: 1,
    decision: "approved",
    reviewer: "local-household-reviewer",
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

test("serves an authenticated, same-origin preparation retry with only bounded revision fields", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubRetryableInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
  });
  const url = `${ctx.homeInboxHttp.origin}/proposals/proposal-1/preparation/retry`;
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
    assert.equal(accepted.headers.get("location"), "/proposals/proposal-1");
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

test("returns 404 for preparation retry when the standalone Inbox has no retry port", async () => {
  const ctx = new Context();
  const inboxFiber = await ctx.plugin(StubInbox);
  const fiber = await ctx.plugin(ProposalInboxHttpService, {
    port: 0,
    authenticate: createInboxBasicAuthenticator(token),
  });
  const response = await fetch(`${ctx.homeInboxHttp.origin}/proposals/proposal-1/preparation/retry`, {
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
  assert.equal(accepted.headers.get("location"), "/proposals");
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
  });
  const url = `${ctx.homeInboxHttp.origin}/advice`;
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
  assert.equal(accepted.headers.get("location"), "/advice/advice-1");
  assert.deepEqual((ctx.homeInbox as unknown as StubInbox).questions, ["Why is the curtain timing uncomfortable?"]);

  const answer = await fetch(`${ctx.homeInboxHttp.origin}/advice/advice-1`, { headers: { authorization } });
  assert.equal(answer.status, 200);
  assert.match(await answer.text(), /Advice detail/);

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
  });
  const url = `${ctx.homeInboxHttp.origin}/advice`;
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
  assert.equal(unavailable.headers.get("location"), "/proposals#advice");

  inbox.availability = "active_request";
  const duplicate = await fetch(url, {
    method: "POST",
    headers,
    body: "question=Should+I+add+a+sensor%3F",
    redirect: "manual",
  });
  assert.equal(duplicate.status, 303);
  assert.equal(duplicate.headers.get("location"), "/advice/advice-active");
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
  });
  const inbox = ctx.homeInbox as unknown as StructuredAdviceInbox;
  const adviceUrl = `${ctx.homeInboxHttp.origin}/advice`;
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
  assert.equal(accepted.headers.get("location"), "/advice/advice-stream");
  assert.deepEqual(inbox.started, ["窗帘为什么总是太早打开?"]);

  const events = await fetch(`${ctx.homeInboxHttp.origin}/advice/advice-stream/events`, {
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

  const unauthorized = await fetch(`${ctx.homeInboxHttp.origin}/advice/advice-stream/events`);
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
  });
  const inbox = ctx.homeInbox as unknown as StructuredAdviceInbox;
  const url = `${ctx.homeInboxHttp.origin}/advice/advice-stream/cancel`;
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
  assert.equal(cancelled.headers.get("location"), "/advice/advice-stream");
  assert.deepEqual(inbox.cancelled, ["advice-stream"]);

  await fiber.dispose();
  await inboxFiber.dispose();
  await ctx.fiber.dispose();
});

test("rejects short authentication secrets before opening a listener", () => {
  assert.throws(() => createInboxBasicAuthenticator("too-short"), /at least 32/);
});
