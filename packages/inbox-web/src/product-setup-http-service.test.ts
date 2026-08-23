import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import {
  ProductSetupHttpService,
  type ProductSetupDraftPort,
  type ProductSetupDraftProjection,
} from "./product-setup-http-service.js";
import { ProductHttpHost } from "./product-http-host.js";

class MemorySetupDrafts implements ProductSetupDraftPort {
  private token: string | undefined;
  private projection: ProductSetupDraftProjection | undefined;
  readonly bridgeProbes: Array<{
    readonly adapterType: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly credential: string;
  }> = [];

  establishSession(input: { readonly sessionToken: string; readonly sessionExpiresAt: Date }) {
    this.token = input.sessionToken;
    this.projection ??= { draftId: "draft-1", revision: 1, stage: "identity" };
    return Promise.resolve(this.projection);
  }

  loadForSession(sessionToken: string) {
    return Promise.resolve(sessionToken === this.token ? this.projection : undefined);
  }

  saveIdentity(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly householdName: string;
    readonly agentName: string;
  }) {
    if (input.sessionToken !== this.token || input.expectedRevision !== this.projection?.revision) {
      throw new Error("Setup draft conflict");
    }
    this.projection = {
      draftId: "draft-1",
      revision: input.expectedRevision + 1,
      stage: "model",
      householdName: input.householdName,
      agentName: input.agentName,
    };
    return Promise.resolve(this.projection);
  }

  probeModel(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly provider: string;
    readonly modelId: string;
    readonly baseURL?: string;
    readonly apiKey: string;
  }) {
    if (input.sessionToken !== this.token || input.expectedRevision !== this.projection?.revision) {
      throw new Error("Setup draft conflict");
    }
    if (input.apiKey !== "model-test-secret") return Promise.resolve({ status: "rejected" as const });
    this.projection = {
      ...this.projection,
      revision: input.expectedRevision + 1,
      stage: "bridge",
      model: {
        provider: input.provider,
        modelId: input.modelId,
        ...(input.baseURL === undefined ? {} : { baseURL: input.baseURL }),
      },
    };
    return Promise.resolve({ status: "ready" as const, draft: this.projection });
  }

  probeBridge(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly adapterType: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly credential: string;
  }) {
    if (input.sessionToken !== this.token || input.expectedRevision !== this.projection?.revision) {
      throw new Error("Setup draft conflict");
    }
    this.bridgeProbes.push({
      adapterType: input.adapterType,
      config: input.config,
      credential: input.credential,
    });
    if (input.credential !== "ha-test-secret") return Promise.resolve({ status: "credential_rejected" as const });
    this.projection = {
      ...this.projection,
      revision: input.expectedRevision + 1,
      stage: "map",
      bridge: {
        adapterType: input.adapterType,
        label: "Home Assistant",
        endpoint: String(input.config.baseUrl ?? ""),
        summary: { states: 21, entities: 20, devices: 8, areas: 4 },
      },
    };
    return Promise.resolve({ status: "ready" as const, draft: this.projection });
  }
}

test("waits for an explicit attachment before setup serves through an external product host", async () => {
  const host = new ProductHttpHost({ port: 0 });
  await host.listen();
  const ctx = new Context();
  let fiber: { dispose(): Promise<void> } | undefined;

  try {
    fiber = await ctx.plugin(ProductSetupHttpService, {
      host,
      pairingCode: "WAVE-HOME",
      pairingExpiresAt: new Date("2026-08-23T02:10:00.000Z"),
      now: () => new Date("2026-08-23T02:01:00.000Z"),
      createSessionToken: () => "setup-session-token-with-sufficient-entropy",
      setupDrafts: new MemorySetupDrafts(),
    });
    assert.equal(ctx.productSetupHttp.origin, host.origin);
    assert.equal((await fetch(`${host.origin}/setup`)).status, 503);

    ctx.productSetupHttp.attach();
    const setup = await fetch(`${host.origin}/setup`);
    assert.equal(setup.status, 200);
    assert.match(await setup.text(), /连接这台设备/);
  } finally {
    await fiber?.dispose();
    await ctx.fiber.dispose();
    await host.dispose();
  }
});

test("pairs one private setup device without exposing the launch code", async () => {
  const ctx = new Context();
  const setupDrafts = new MemorySetupDrafts();
  const expiresAt = new Date("2026-08-23T02:10:00.000Z");
  const fiber = await ctx.plugin(ProductSetupHttpService, {
    port: 0,
    pairingCode: "WAVE-HOME",
    pairingExpiresAt: expiresAt,
    now: () => new Date("2026-08-23T02:01:00.000Z"),
    createSessionToken: () => "setup-session-token-with-sufficient-entropy",
    setupDrafts,
  });

  try {
    const landing = await fetch(`${ctx.productSetupHttp.origin}/setup`);
    const landingHtml = await landing.text();
    assert.equal(landing.status, 200);
    assert.match(landingHtml, /连接这台设备/);
    assert.match(landingHtml, /autocomplete="one-time-code"/);
    assert.equal(landingHtml.includes("WAVE-HOME"), false);
    assert.equal(landingHtml.includes("setup-session-token"), false);

    const paired = await fetch(`${ctx.productSetupHttp.origin}/setup/pair`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: ctx.productSetupHttp.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code: "wave home" }),
    });
    assert.equal(paired.status, 303);
    assert.equal(paired.headers.get("location"), "/setup");
    const cookie = paired.headers.get("set-cookie") ?? "";
    assert.match(cookie, /^hob_product_session=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\/;/i);
    assert.equal(cookie.includes("setup-session-token-with-sufficient-entropy"), true);
    assert.equal(cookie.includes("WAVE-HOME"), false);

    const workspace = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    const workspaceHtml = await workspace.text();
    assert.equal(workspace.status, 200);
    assert.match(workspaceHtml, /给家和助手起个名字/);
    assert.match(workspaceHtml, /action="\/setup\/identity"/);
    assert.equal(workspaceHtml.includes("setup-session-token"), false);

    const named = await fetch(`${ctx.productSetupHttp.origin}/setup/identity`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: ctx.productSetupHttp.origin,
        cookie: cookie.split(";")[0] ?? "",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ revision: "1", householdName: "梧桐家", agentName: "小满" }),
    });
    assert.equal(named.status, 303);
    assert.equal(named.headers.get("location"), "/setup");
    const modelStep = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    const modelHtml = await modelStep.text();
    assert.match(modelHtml, /小满已经记住梧桐家/);
    assert.match(modelHtml, /连接模型/);
    assert.match(modelHtml, /action="\/setup\/model\/probe"/);
    assert.equal(modelHtml.includes("功能正在接入"), false);

    const probed = await fetch(`${ctx.productSetupHttp.origin}/setup/model/probe`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: ctx.productSetupHttp.origin,
        cookie: cookie.split(";")[0] ?? "",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        revision: "2",
        provider: "custom",
        modelId: "deepseek-v4-flash-0731",
        baseURL: "https://model.example.test/v1",
        apiKey: "model-test-secret",
      }),
    });
    assert.equal(probed.status, 303);
    assert.equal(probed.headers.get("location"), "/setup");
    assert.equal((await probed.text()).includes("model-test-secret"), false);
    const bridgeStep = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    const bridgeHtml = await bridgeStep.text();
    assert.match(bridgeHtml, /模型已连接/);
    assert.match(bridgeHtml, /接入家庭/);
    assert.match(bridgeHtml, /action="\/setup\/bridge\/probe"/);
    assert.equal(bridgeHtml.includes("model-test-secret"), false);

    const bridgeProbed = await fetch(`${ctx.productSetupHttp.origin}/setup/bridge/probe`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: ctx.productSetupHttp.origin,
        cookie: cookie.split(";")[0] ?? "",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        revision: "3",
        adapterType: "home-assistant",
        baseUrl: "http://ha.local:8123",
        accessToken: "ha-test-secret",
      }),
    });
    assert.equal(bridgeProbed.status, 303);
    assert.deepEqual(setupDrafts.bridgeProbes, [{
      adapterType: "home-assistant",
      config: { baseUrl: "http://ha.local:8123" },
      credential: "ha-test-secret",
    }]);
    const mapStep = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    const mapHtml = await mapStep.text();
    assert.match(mapHtml, /家庭连接已验证/);
    assert.match(mapHtml, /<strong>8<\/strong><span>个设备/);
    assert.match(mapHtml, /<strong>4<\/strong><span>个空间/);
    assert.equal(mapHtml.includes("ha-test-secret"), false);

    const reused = await fetch(`${ctx.productSetupHttp.origin}/setup/pair`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: ctx.productSetupHttp.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code: "WAVE-HOME" }),
    });
    assert.equal(reused.status, 409);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("keeps pairing failures inside the product flow and enforces expiry and origin", async () => {
  let now = new Date("2026-08-23T02:01:00.000Z");
  const ctx = new Context();
  const setupDrafts = new MemorySetupDrafts();
  const fiber = await ctx.plugin(ProductSetupHttpService, {
    port: 0,
    pairingCode: "CALM-ROOM",
    pairingExpiresAt: new Date("2026-08-23T02:10:00.000Z"),
    now: () => now,
    createSessionToken: () => "another-private-setup-session-token",
    setupDrafts,
  });

  try {
    const wrongOrigin = await fetch(`${ctx.productSetupHttp.origin}/setup/pair`, {
      method: "POST",
      headers: {
        origin: "https://foreign.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code: "CALM-ROOM" }),
    });
    assert.equal(wrongOrigin.status, 403);

    const incorrect = await fetch(`${ctx.productSetupHttp.origin}/setup/pair`, {
      method: "POST",
      headers: {
        origin: ctx.productSetupHttp.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code: "OTHER-CODE" }),
    });
    assert.equal(incorrect.status, 400);
    assert.match(await incorrect.text(), /配对码没有对上/);

    now = new Date("2026-08-23T02:11:00.000Z");
    const expired = await fetch(`${ctx.productSetupHttp.origin}/setup/pair`, {
      method: "POST",
      headers: {
        origin: ctx.productSetupHttp.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code: "CALM-ROOM" }),
    });
    assert.equal(expired.status, 410);
    assert.match(await expired.text(), /配对码已过期/);
    assert.equal(expired.headers.get("set-cookie"), null);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("allows exactly one winner when two devices submit the pairing code together", async () => {
  const ctx = new Context();
  let sessionSequence = 0;
  const fiber = await ctx.plugin(ProductSetupHttpService, {
    port: 0,
    pairingCode: "ONLY-ONCE",
    pairingExpiresAt: new Date("2026-08-23T02:10:00.000Z"),
    now: () => new Date("2026-08-23T02:01:00.000Z"),
    createSessionToken: () => `private-session-${String(++sessionSequence).padStart(32, "0")}`,
    setupDrafts: new MemorySetupDrafts(),
  });
  const request = () => fetch(`${ctx.productSetupHttp.origin}/setup/pair`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: ctx.productSetupHttp.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ code: "ONLY-ONCE" }),
  });

  try {
    const results = await Promise.all([request(), request()]);
    assert.deepEqual(results.map((response) => response.status).sort(), [303, 409]);
    const winner = results.find((response) => response.status === 303);
    const cookie = winner?.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const workspace = await fetch(`${ctx.productSetupHttp.origin}/setup`, { headers: { cookie } });
    assert.match(await workspace.text(), /给家和助手起个名字/);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("bounds incorrect pairing attempts and oversized setup forms with recoverable product pages", async () => {
  let now = new Date("2026-08-23T02:01:00.000Z");
  const ctx = new Context();
  const fiber = await ctx.plugin(ProductSetupHttpService, {
    port: 0,
    pairingCode: "LIMIT-CODE",
    pairingExpiresAt: new Date("2026-08-23T02:10:00.000Z"),
    now: () => now,
    createSessionToken: () => "limited-private-setup-session-token-value",
    setupDrafts: new MemorySetupDrafts(),
  });
  const pair = (code: string) => fetch(`${ctx.productSetupHttp.origin}/setup/pair`, {
    method: "POST",
    headers: {
      origin: ctx.productSetupHttp.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ code }),
  });

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await pair("wrong-code")).status, 400);
    const limited = await pair("LIMIT-CODE");
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/u);
    assert.match(await limited.text(), /尝试次数有点多/);

    now = new Date("2026-08-23T02:02:01.000Z");
    const oversized = await pair("x".repeat(10_000));
    assert.equal(oversized.status, 413);
    assert.match(await oversized.text(), /内容太长/);
    assert.match(oversized.headers.get("content-type") ?? "", /^text\/html/u);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});
