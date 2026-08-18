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

  constructor(ctx: Context) {
    super(ctx, "homeInbox");
  }

  renderList() { return "<main>Inbox list</main>"; }
  renderDetail(id: string) { return id === "proposal-1" ? "<main>Proposal detail</main>" : undefined; }
  async review(input: unknown) {
    this.reviews.push(input);
    return { status: "approved" };
  }
  canObserveNow() { return true; }
  async observeNow() { this.observations += 1; return "no_proposal"; }
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
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");

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

test("rejects short authentication secrets before opening a listener", () => {
  assert.throws(() => createInboxBasicAuthenticator("too-short"), /at least 32/);
});
