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
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");

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

test("rejects short authentication secrets before opening a listener", () => {
  assert.throws(() => createInboxBasicAuthenticator("too-short"), /at least 32/);
});
