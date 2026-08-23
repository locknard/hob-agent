import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import {
  ProductSetupHttpService,
  type ProductSetupDraftPort,
  type ProductSetupDraftProjection,
  type ProductSetupModelProbeResult,
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
  readonly voiceChecks: Array<{
    readonly kind: "asr" | "tts";
    readonly transport: "wyoming" | "openai_http";
    readonly endpoint: string;
    readonly credential?: string;
    readonly locale?: string;
    readonly voice?: string;
    readonly model?: string;
  }> = [];
  modelProbe: ((input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly provider: string;
    readonly modelId: string;
    readonly baseURL?: string;
    readonly apiKey: string;
    readonly signal?: AbortSignal;
  }) => Promise<ProductSetupModelProbeResult>) | undefined;

  seed(sessionToken: string, projection: ProductSetupDraftProjection): void {
    this.token = sessionToken;
    this.projection = projection;
  }

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
    readonly signal?: AbortSignal;
  }) {
    if (this.modelProbe !== undefined) return this.modelProbe(input);
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
      stage: "voice" as const,
      bridge: {
        adapterType: input.adapterType,
        label: "Home Assistant",
        endpoint: String(input.config.baseUrl ?? ""),
        summary: { states: 21, entities: 20, devices: 8, areas: 4 },
      },
    };
    return Promise.resolve({ status: "ready" as const, draft: this.projection });
  }

  probeVoice(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly track: {
      readonly kind: "asr" | "tts";
      readonly transport: "wyoming" | "openai_http";
      readonly endpoint: string;
      readonly credential?: string;
      readonly locale?: string;
      readonly voice?: string;
      readonly model?: string;
    };
  }) {
    if (input.sessionToken !== this.token || input.expectedRevision !== this.projection?.revision || this.projection.stage !== "voice") {
      return Promise.resolve({ status: "conflict" as const });
    }
    if (input.track.credential !== "voice-test-secret") return Promise.resolve({ status: "credential_rejected" as const });
    this.voiceChecks.push(input.track);
    const voice = {
      ...(this.projection.voice ?? {}),
      [input.track.kind]: {
        transport: input.track.transport,
        endpoint: input.track.endpoint,
        ...(input.track.model === undefined ? {} : { model: input.track.model }),
        ...(input.track.kind === "tts" ? {
          locale: input.track.locale,
          ...(input.track.voice === undefined ? {} : { voice: input.track.voice }),
        } : {}),
        probeLatencyMs: 18,
      },
    };
    const complete = voice.asr !== undefined && voice.tts !== undefined;
    this.projection = {
      ...this.projection,
      revision: input.expectedRevision + 1,
      stage: complete ? "map" : "voice",
      voice,
    };
    return Promise.resolve({ status: "ready" as const, draft: this.projection });
  }

  skipVoice(input: { readonly sessionToken: string; readonly expectedRevision: number }) {
    if (input.sessionToken !== this.token || input.expectedRevision !== this.projection?.revision || this.projection.stage !== "voice") {
      throw new Error("Setup draft conflict");
    }
    const { voice: _voice, ...withoutVoice } = this.projection;
    this.projection = { ...withoutVoice, revision: input.expectedRevision + 1, stage: "map", voiceSkipped: true };
    return Promise.resolve(this.projection);
  }
}

class ExpiringSetupDrafts extends MemorySetupDrafts {
  expired = false;

  override loadForSession(sessionToken: string) {
    return this.expired ? Promise.resolve(undefined) : super.loadForSession(sessionToken);
  }
}

test("rotates an expired setup session through a short-lived recovery code without losing verified draft progress", async () => {
  let now = new Date("2026-08-23T02:01:00.000Z");
  let sessionNumber = 0;
  const ctx = new Context();
  const setupDrafts = new ExpiringSetupDrafts();
  const fiber = await ctx.plugin(ProductSetupHttpService, {
    port: 0,
    pairingCode: "FIRST-HOME",
    pairingExpiresAt: new Date("2026-08-23T02:10:00.000Z"),
    now: () => now,
    sessionTtlMs: 60_000,
    createSessionToken: () => `recovery-setup-session-token-${String(++sessionNumber).padStart(8, "0")}`,
    createRecoveryPairingCode: () => "RESUME-HOME",
    recoveryPairingTtlMs: 60_000,
    setupDrafts,
  });
  try {
    const initial = await fetch(`${ctx.productSetupHttp.origin}/setup/pair`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: ctx.productSetupHttp.origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: "FIRST-HOME" }),
    });
    assert.equal(initial.status, 303);
    const initialCookie = initial.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(initialCookie);

    const named = await fetch(`${ctx.productSetupHttp.origin}/setup/identity`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: ctx.productSetupHttp.origin, cookie: initialCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ revision: "1", householdName: "梧桐家", agentName: "小满" }),
    });
    assert.equal(named.status, 303);

    const model = await fetch(`${ctx.productSetupHttp.origin}/setup/model/probe`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: ctx.productSetupHttp.origin, cookie: initialCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        revision: "2",
        provider: "custom",
        modelId: "family-model",
        baseURL: "http://127.0.0.1:18090/v1",
        apiKey: "model-test-secret",
      }),
    });
    assert.equal(model.status, 303);

    now = new Date("2026-08-23T02:02:01.000Z");
    setupDrafts.expired = true;
    const recovery = await fetch(`${ctx.productSetupHttp.origin}/setup`, { headers: { cookie: initialCookie } });
    const recoveryHtml = await recovery.text();
    assert.equal(recovery.status, 200);
    assert.match(recoveryHtml, /继续此前设置/);
    assert.match(recoveryHtml, /RESUMEHOME/);
    const unrelated = await fetch(`${ctx.productSetupHttp.origin}/setup`);
    assert.equal((await unrelated.text()).includes("RESUMEHOME"), false);

    const resumed = await fetch(`${ctx.productSetupHttp.origin}/setup/pair`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: ctx.productSetupHttp.origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: "RESUME-HOME" }),
    });
    assert.equal(resumed.status, 303);
    const resumedCookie = resumed.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(resumedCookie);
    assert.notEqual(resumedCookie, initialCookie);

    setupDrafts.expired = false;
    const workspace = await fetch(`${ctx.productSetupHttp.origin}/setup`, { headers: { cookie: resumedCookie } });
    assert.match(await workspace.text(), /接入家庭/);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("runs a setup model check in the background and waits for cancellation to settle without exposing its secret", async () => {
  const ctx = new Context();
  const setupDrafts = new MemorySetupDrafts();
  const sessionToken = "setup-background-probe-private-token";
  setupDrafts.seed(sessionToken, { draftId: "draft-background-probe", revision: 2, stage: "model", householdName: "测试家", agentName: "测试助手" });
  let receivedSignal: AbortSignal | undefined;
  let started: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  setupDrafts.modelProbe = async (input) => {
    receivedSignal = input.signal;
    started?.();
    await new Promise<void>((resolve) => input.signal?.addEventListener("abort", () => resolve(), { once: true }));
    return { status: "unavailable" as const };
  };
  const fiber = await ctx.plugin(ProductSetupHttpService, {
    port: 0,
    pairingCode: "BACKGROUND-HOME",
    pairingExpiresAt: new Date("2026-08-23T02:10:00.000Z"),
    now: () => new Date("2026-08-23T02:01:00.000Z"),
    createSessionToken: () => "unused-private-setup-session-token",
    setupDrafts,
  });
  const cookie = `hob_product_session=${sessionToken}`;
  try {
    const startedResponse = await fetch(`${ctx.productSetupHttp.origin}/setup/model/probe`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: ctx.productSetupHttp.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ revision: "2", provider: "custom", modelId: "fixture-model", baseURL: "http://127.0.0.1:18090/v1", apiKey: "setup-model-secret" }),
    });
    assert.equal(startedResponse.status, 303);
    assert.equal(startedResponse.headers.get("location"), "/setup");
    await entered;
    const pending = await fetch(`${ctx.productSetupHttp.origin}/setup`, { headers: { cookie } });
    const pendingHtml = await pending.text();
    assert.match(pendingHtml, /正在检查模型服务/);
    assert.match(pendingHtml, /可以离开这个页面/);
    assert.match(pendingHtml, /action="\/setup\/probe\/cancel"/);
    assert.match(pendingHtml, /<a class="secondary-action probe-result-link" href="\/setup">查看检查结果<\/a>/);
    assert.equal(pendingHtml.includes("setup-model-secret"), false);
    const taskId = /name="taskId" value="([a-f0-9]{32})"/u.exec(pendingHtml)?.[1];
    assert.notEqual(taskId, undefined);
    const status = await fetch(`${ctx.productSetupHttp.origin}/setup/probe-status`, { headers: { origin: ctx.productSetupHttp.origin, cookie } });
    assert.deepEqual(await status.json(), { status: "pending", taskId, kind: "model" });

    const cancelled = await fetch(`${ctx.productSetupHttp.origin}/setup/probe/cancel`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: ctx.productSetupHttp.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ taskId: taskId! }),
    });
    assert.equal(cancelled.status, 303);
    assert.equal(receivedSignal?.aborted, true);
    await new Promise((resolve) => setImmediate(resolve));
    const completedHead = await fetch(`${ctx.productSetupHttp.origin}/setup`, { method: "HEAD", headers: { cookie } });
    assert.equal(completedHead.status, 200);
    assert.equal(await completedHead.text(), "");
    const completed = await fetch(`${ctx.productSetupHttp.origin}/setup`, { headers: { cookie } });
    const completedHtml = await completed.text();
    assert.match(completedHtml, /已停止这次模型服务检查/);
    const completedAfterNotice = await fetch(`${ctx.productSetupHttp.origin}/setup`, { headers: { cookie } });
    assert.doesNotMatch(await completedAfterNotice.text(), /已停止这次模型服务检查/);
    assert.equal(completedHtml.includes("setup-model-secret"), false);
    assert.match(completedHtml, /连接模型/);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("keeps a failed background bridge check available after a HEAD request", async () => {
  const ctx = new Context();
  const setupDrafts = new MemorySetupDrafts();
  const sessionToken = "setup-failed-bridge-private-token";
  setupDrafts.seed(sessionToken, {
    draftId: "draft-failed-bridge-probe",
    revision: 3,
    stage: "bridge",
    householdName: "测试家",
    agentName: "测试助手",
    model: { provider: "custom", modelId: "fixture-model" },
  });
  const fiber = await ctx.plugin(ProductSetupHttpService, {
    port: 0,
    pairingCode: "FAILED-BRIDGE-HOME",
    pairingExpiresAt: new Date("2026-08-23T02:10:00.000Z"),
    now: () => new Date("2026-08-23T02:01:00.000Z"),
    createSessionToken: () => "unused-private-setup-session-token",
    setupDrafts,
  });
  const cookie = `hob_product_session=${sessionToken}`;
  try {
    const started = await fetch(`${ctx.productSetupHttp.origin}/setup/bridge/probe`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: ctx.productSetupHttp.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        revision: "3",
        adapterType: "home-assistant",
        baseUrl: "http://homeassistant.local:8123",
        accessToken: "rejected-token",
      }),
    });
    assert.equal(started.status, 303);
    await new Promise((resolve) => setImmediate(resolve));

    const head = await fetch(`${ctx.productSetupHttp.origin}/setup`, { method: "HEAD", headers: { cookie } });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    const firstGet = await fetch(`${ctx.productSetupHttp.origin}/setup`, { headers: { cookie } });
    assert.match(await firstGet.text(), /Home Assistant 没有接受这个令牌，请重新复制长期访问令牌。/);
    const secondGet = await fetch(`${ctx.productSetupHttp.origin}/setup`, { headers: { cookie } });
    assert.doesNotMatch(await secondGet.text(), /Home Assistant 没有接受这个令牌，请重新复制长期访问令牌。/);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("activates the exact map revision through the paired product session", async () => {
  const ctx = new Context();
  const setupDrafts = new MemorySetupDrafts();
  const sessionToken = "activation-private-product-session-token";
  setupDrafts.seed(sessionToken, {
    draftId: "draft-activation",
    revision: 4,
    stage: "map",
    householdName: "梧桐家",
    agentName: "小满",
    bridge: {
      adapterType: "fixture-peer",
      label: "家庭桥",
      endpoint: "fixture://home",
      summary: { states: 21, entities: 20, devices: 8, areas: 4 },
      review: {
        areas: [
          { name: "客厅", deviceCount: 4 },
          { name: "卧室", deviceCount: 2 },
          { name: "厨房", deviceCount: 1 },
          { name: "书房", deviceCount: 1 },
        ],
        unassignedDeviceCount: 0,
        complete: true,
      },
    },
  });
  const calls: unknown[] = [];
  const fiber = await ctx.plugin(ProductSetupHttpService, {
    port: 0,
    pairingCode: "START-HOME",
    pairingExpiresAt: new Date("2026-08-23T02:10:00.000Z"),
    now: () => new Date("2026-08-23T02:01:00.000Z"),
    createSessionToken: () => "unused-private-product-session-token",
    setupDrafts,
    activation: {
      activate: async (input) => { calls.push(input); return { status: "activated" as const }; },
    },
  });
  const cookie = `hob_product_session=${sessionToken}`;
  try {
    const map = await fetch(`${ctx.productSetupHttp.origin}/setup`, { headers: { cookie } });
    const mapHtml = await map.text();
    assert.match(mapHtml, /action="\/setup\/activate"/);
    assert.match(mapHtml, />继续设置家庭</);

    const activated = await fetch(`${ctx.productSetupHttp.origin}/setup/activate`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: ctx.productSetupHttp.origin,
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ revision: "4", mapReviewed: "confirmed" }),
    });
    assert.equal(activated.status, 303);
    assert.equal(activated.headers.get("location"), "/onboarding");
    assert.deepEqual(calls, [{ sessionToken, expectedRevision: 4 }]);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("allows an honest partial household map review with explicit confirmation", async () => {
  const ctx = new Context();
  const setupDrafts = new MemorySetupDrafts();
  const sessionToken = "map-review-private-product-session-token";
  setupDrafts.seed(sessionToken, {
    draftId: "draft-map-review",
    revision: 4,
    stage: "map",
    householdName: "梧桐家",
    agentName: "小满",
    bridge: {
      adapterType: "fixture-peer",
      label: "家庭桥",
      endpoint: "fixture://home",
      summary: { states: 21, entities: 20, devices: 8, areas: 4 },
      review: {
        areas: [{
          name: "客厅",
          deviceCount: 2,
        }, {
          name: "卧室",
          deviceCount: 1,
        }],
        unassignedDeviceCount: 0,
        complete: false,
      },
    },
  });
  const calls: unknown[] = [];
  const fiber = await ctx.plugin(ProductSetupHttpService, {
    port: 0,
    pairingCode: "START-HOME",
    pairingExpiresAt: new Date("2026-08-23T02:10:00.000Z"),
    now: () => new Date("2026-08-23T02:01:00.000Z"),
    createSessionToken: () => "unused-private-product-session-token",
    setupDrafts,
    activation: { activate: async (input) => { calls.push(input); return { status: "activated" as const }; } },
  });
  const cookie = `hob_product_session=${sessionToken}`;
  try {
    const map = await fetch(`${ctx.productSetupHttp.origin}/setup`, { headers: { cookie } });
    const mapHtml = await map.text();
    assert.match(mapHtml, /核对家庭地图/);
    assert.match(mapHtml, /客厅/);
    assert.match(mapHtml, /已同步 2 个设备/);
    assert.match(mapHtml, /这次只读同步展示了当前可确认的空间结构/);
    assert.match(mapHtml, /我已核对当前空间结构与设备数量/);
    assert.match(mapHtml, /name="mapReviewed" value="confirmed" required/);

    const missingConfirmation = await fetch(`${ctx.productSetupHttp.origin}/setup/activate`, {
      method: "POST",
      headers: { origin: ctx.productSetupHttp.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ revision: "4" }),
    });
    assert.equal(missingConfirmation.status, 400);
    assert.match(await missingConfirmation.text(), /请先核对家庭地图，再确认继续/);
    assert.deepEqual(calls, []);

    const activated = await fetch(`${ctx.productSetupHttp.origin}/setup/activate`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: ctx.productSetupHttp.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ revision: "4", mapReviewed: "confirmed" }),
    });
    assert.equal(activated.status, 303);
    assert.deepEqual(calls, [{ sessionToken, expectedRevision: 4 }]);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("holds activation until the bridge supplies a household-readable map review", async () => {
  const ctx = new Context();
  const setupDrafts = new MemorySetupDrafts();
  const sessionToken = "summary-only-private-product-session-token";
  setupDrafts.seed(sessionToken, {
    draftId: "draft-summary-only",
    revision: 4,
    stage: "map",
    bridge: {
      adapterType: "fixture-peer",
      label: "家庭桥",
      summary: { states: 21, entities: 20, devices: 8, areas: 4 },
    },
  });
  const fiber = await ctx.plugin(ProductSetupHttpService, {
    port: 0,
    pairingCode: "START-HOME",
    pairingExpiresAt: new Date("2026-08-23T02:10:00.000Z"),
    now: () => new Date("2026-08-23T02:01:00.000Z"),
    createSessionToken: () => "unused-private-product-session-token",
    setupDrafts,
    activation: { activate: async () => ({ status: "activated" as const }) },
  });
  try {
    const map = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      headers: { cookie: `hob_product_session=${sessionToken}` },
    });
    const html = await map.text();
    assert.match(html, /家庭地图尚未准备好/);
    assert.match(html, /连接摘要/);
    assert.equal(html.includes('action="/setup/activate"'), false);

    setupDrafts.seed(sessionToken, {
      draftId: "draft-summary-only",
      revision: 4,
      stage: "map",
      bridge: {
        adapterType: "fixture-peer",
        label: "家庭桥",
        summary: { states: 21, entities: 20, devices: 8, areas: 4 },
        review: { areas: [{ name: "客厅", deviceCount: 4 }], unassignedDeviceCount: 0, complete: true },
      },
    });
    const inconsistent = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      headers: { cookie: `hob_product_session=${sessionToken}` },
    });
    const inconsistentHtml = await inconsistent.text();
    assert.match(inconsistentHtml, /家庭地图尚未准备好/);
    assert.equal(inconsistentHtml.includes('action="/setup/activate"'), false);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("keeps the setup return path when activation is temporarily unavailable", async () => {
  const ctx = new Context();
  const setupDrafts = new MemorySetupDrafts();
  const sessionToken = "activation-unavailable-private-product-session-token";
  setupDrafts.seed(sessionToken, { draftId: "draft-activation-unavailable", revision: 4, stage: "map" });
  const fiber = await ctx.plugin(ProductSetupHttpService, {
    port: 0,
    pairingCode: "START-HOME",
    pairingExpiresAt: new Date("2026-08-23T02:10:00.000Z"),
    now: () => new Date("2026-08-23T02:01:00.000Z"),
    createSessionToken: () => "unused-private-product-session-token",
    setupDrafts,
  });
  try {
    const response = await fetch(`${ctx.productSetupHttp.origin}/setup/activate`, {
      method: "POST",
      headers: {
        origin: ctx.productSetupHttp.origin,
        cookie: `hob_product_session=${sessionToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ revision: "4" }),
    });
    assert.equal(response.status, 503);
    const page = await response.text();
    assert.match(page, /暂时无法完成启用，请稍后再试/);
    assert.match(page, /href="\/setup"/);
    assert.equal(page.includes("尚未配置"), false);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("keeps the verified map actionable when product activation is temporarily unavailable", async () => {
  const ctx = new Context();
  const setupDrafts = new MemorySetupDrafts();
  const sessionToken = "activation-retry-product-session-token";
  setupDrafts.seed(sessionToken, {
    draftId: "draft-retry",
    revision: 7,
    stage: "map",
    householdName: "梧桐家",
    agentName: "小满",
    bridge: {
      adapterType: "fixture-peer",
      label: "家庭桥",
      endpoint: "fixture://home",
      summary: { states: 3, entities: 3, devices: 2, areas: 1 },
      review: { areas: [{ name: "客厅", deviceCount: 2 }], unassignedDeviceCount: 0, complete: true },
    },
  });
  const fiber = await ctx.plugin(ProductSetupHttpService, {
    port: 0,
    pairingCode: "START-HOME",
    pairingExpiresAt: new Date("2026-08-23T02:10:00.000Z"),
    now: () => new Date("2026-08-23T02:01:00.000Z"),
    createSessionToken: () => "unused-private-product-session-token",
    setupDrafts,
    activation: { activate: async () => ({ status: "unavailable" as const }) },
  });
  try {
    const response = await fetch(`${ctx.productSetupHttp.origin}/setup/activate`, {
      method: "POST",
      headers: {
        origin: ctx.productSetupHttp.origin,
        cookie: `hob_product_session=${sessionToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ revision: "7", mapReviewed: "confirmed" }),
    });
    const html = await response.text();
    assert.equal(response.status, 503);
    assert.match(html, /已验证的设置仍然保留，可以直接再试/);
    assert.match(html, /action="\/setup\/activate"/);
    assert.match(html, />继续设置家庭</);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

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

test("gives the setup grid a definite width so the product card cannot collapse to one character", async () => {
  const context = new Context();
  const fiber = await context.plugin(ProductSetupHttpService, {
    port: 0,
    pairingCode: "WIDE-HOME",
    pairingExpiresAt: new Date("2026-08-23T03:00:00.000Z"),
    now: () => new Date("2026-08-23T02:00:00.000Z"),
    createSessionToken: () => "layout-review-session-token-with-enough-entropy",
    setupDrafts: new MemorySetupDrafts(),
  });
  try {
    const css = await (await fetch(`${context.productSetupHttp.origin}/setup/assets/setup.css`)).text();
    assert.match(css, /\.setup-shell\{width:100%;min-height:100vh/);
    assert.match(css, /\.welcome-card,\.workspace\{width:min\(100%,46rem\)/);
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});

test("keeps setup links and completion labels legible in dark mode and gives check results a full touch target", async () => {
  const context = new Context();
  const fiber = await context.plugin(ProductSetupHttpService, {
    port: 0,
    pairingCode: "DARK-HOME",
    pairingExpiresAt: new Date("2026-08-23T03:00:00.000Z"),
    now: () => new Date("2026-08-23T02:00:00.000Z"),
    createSessionToken: () => "dark-mode-review-session-token-with-enough-entropy",
    setupDrafts: new MemorySetupDrafts(),
  });
  try {
    const css = await (await fetch(`${context.productSetupHttp.origin}/setup/assets/setup.css`)).text();
    assert.match(css, /@media\(prefers-color-scheme:dark\).*a\{color:#6eb4ff\}/s);
    assert.match(css, /@media\(prefers-color-scheme:dark\).*\.eyebrow\.success\{color:#75d59a\}/s);
    assert.ok(contrastRatio("#6eb4ff", "#1c1c1e") >= 4.5);
    assert.ok(contrastRatio("#75d59a", "#1c1c1e") >= 4.5);
    assert.match(css, /\.probe-result-link\{[^}]*display:inline-flex[^}]*min-height:44px/s);
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/.{2}/g)?.map((channel) => Number.parseInt(channel, 16) / 255) ?? [];
    const [red, green, blue] = channels.map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (lighter! + 0.05) / (darker! + 0.05);
}

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
    const modelHead = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      method: "HEAD",
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    assert.equal(modelHead.status, 200);
    assert.equal(await modelHead.text(), "");
    const bridgeStep = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    const bridgeHtml = await bridgeStep.text();
    assert.match(bridgeHtml, /模型已连接/);
    assert.match(bridgeHtml, /模型检查已完成，请查看当前步骤。/);
    assert.match(bridgeHtml, /接入家庭/);
    assert.match(bridgeHtml, /action="\/setup\/bridge\/probe"/);
    assert.equal(bridgeHtml.includes("model-test-secret"), false);
    const bridgeStepAfterNotice = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    assert.doesNotMatch(await bridgeStepAfterNotice.text(), /模型检查已完成，请查看当前步骤。/);

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
    const bridgeHead = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      method: "HEAD",
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    assert.equal(bridgeHead.status, 200);
    assert.equal(await bridgeHead.text(), "");
    const voiceStep = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    const voiceHtml = await voiceStep.text();
    assert.match(voiceHtml, /设置私人语音/);
    assert.match(voiceHtml, /家庭连接检查已完成，请查看当前步骤。/);
    assert.match(voiceHtml, /action="\/setup\/voice\/asr\/verify"/);
    assert.match(voiceHtml, /action="\/setup\/voice\/tts\/verify"/);
    assert.match(voiceHtml, /本次跳过/);
    assert.match(voiceHtml, /密钥写入本机凭据保险箱，页面不会回显；运行语音服务时由 Hob 读取/);
    assert.doesNotMatch(voiceHtml, /密钥只在验证时使用/);
    assert.equal(voiceHtml.includes("ha-test-secret"), false);
    const voiceStepAfterNotice = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    assert.doesNotMatch(await voiceStepAfterNotice.text(), /家庭连接检查已完成，请查看当前步骤。/);

    const asrChecked = await fetch(`${ctx.productSetupHttp.origin}/setup/voice/asr/verify`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: ctx.productSetupHttp.origin,
        cookie: cookie.split(";")[0] ?? "",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        revision: "4",
        service: "openai_http",
        endpoint: "http://voice.local",
        credential: "voice-test-secret",
        model: "gpt-4o-mini-transcribe",
      }),
    });
    assert.equal(asrChecked.status, 303);
    const asrHead = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      method: "HEAD",
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    assert.equal(asrHead.status, 200);
    assert.equal(await asrHead.text(), "");
    const ttsStep = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    const ttsHtml = await ttsStep.text();
    assert.match(ttsHtml, /语音检查已完成，请查看当前步骤。/);
    assert.match(ttsHtml, /语音输入已验证，启用产品时生效/);
    assert.match(ttsHtml, /语音输出/);
    assert.equal(ttsHtml.includes("voice-test-secret"), false);
    assert.equal(ttsHtml.includes("transport"), false);
    assert.equal(ttsHtml.includes("runtime"), false);
    const ttsStepAfterNotice = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    assert.doesNotMatch(await ttsStepAfterNotice.text(), /语音检查已完成，请查看当前步骤。/);

    const ttsChecked = await fetch(`${ctx.productSetupHttp.origin}/setup/voice/tts/verify`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: ctx.productSetupHttp.origin,
        cookie: cookie.split(";")[0] ?? "",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        revision: "5",
        service: "openai_http",
        endpoint: "http://voice.local",
        credential: "voice-test-secret",
        locale: "zh-CN",
        voice: "alloy",
        model: "gpt-4o-mini-tts",
      }),
    });
    assert.equal(ttsChecked.status, 303);
    assert.deepEqual(setupDrafts.voiceChecks, [{
      kind: "asr",
      transport: "openai_http",
      endpoint: "http://voice.local",
      credential: "voice-test-secret",
      model: "gpt-4o-mini-transcribe",
    }, {
      kind: "tts",
      transport: "openai_http",
      endpoint: "http://voice.local",
      credential: "voice-test-secret",
      locale: "zh-CN",
      voice: "alloy",
      model: "gpt-4o-mini-tts",
    }]);
    const ttsHead = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      method: "HEAD",
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    assert.equal(ttsHead.status, 200);
    assert.equal(await ttsHead.text(), "");
    const mapStep = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    const mapHtml = await mapStep.text();
    assert.match(mapHtml, /语音检查已完成，请查看当前步骤。/);
    assert.match(mapHtml, /家庭连接已验证/);
    assert.match(mapHtml, /私人语音已验证，将和家庭助手一起启用/);
    assert.match(mapHtml, /<strong>8<\/strong><span>个设备/);
    assert.match(mapHtml, /<strong>4<\/strong><span>个空间/);
    assert.equal(mapHtml.includes("voice-test-secret"), false);
    const mapStepAfterNotice = await fetch(`${ctx.productSetupHttp.origin}/setup`, {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    assert.doesNotMatch(await mapStepAfterNotice.text(), /语音检查已完成，请查看当前步骤。/);

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

test("accepts only one allowed value for each private voice form field", async () => {
  const ctx = new Context();
  const setupDrafts = new MemorySetupDrafts();
  const sessionToken = "voice-form-private-product-session-token";
  setupDrafts.seed(sessionToken, { draftId: "draft-voice-form", revision: 4, stage: "voice" });
  const fiber = await ctx.plugin(ProductSetupHttpService, {
    port: 0,
    pairingCode: "VOICE-HOME",
    pairingExpiresAt: new Date("2026-08-23T02:10:00.000Z"),
    now: () => new Date("2026-08-23T02:01:00.000Z"),
    createSessionToken: () => "unused-private-product-session-token",
    setupDrafts,
  });
  const request = (body: URLSearchParams, origin = ctx.productSetupHttp.origin, cookie = `hob_product_session=${sessionToken}`) => fetch(
    `${ctx.productSetupHttp.origin}/setup/voice/asr/verify`,
    { method: "POST", redirect: "manual", headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" }, body },
  );

  try {
    const unknownField = await request(new URLSearchParams({
      revision: "4", service: "openai_http", endpoint: "http://voice.local", credential: "voice-test-secret", model: "whisper", extra: "ignored",
    }));
    assert.equal(unknownField.status, 400);

    const duplicateService = new URLSearchParams({ revision: "4", service: "openai_http", endpoint: "http://voice.local", credential: "voice-test-secret" });
    duplicateService.append("service", "wyoming");
    assert.equal((await request(duplicateService)).status, 400);
    assert.equal((await request(new URLSearchParams({ revision: "4", service: "other", endpoint: "http://voice.local" }))).status, 400);
    assert.equal((await request(new URLSearchParams({ revision: "4", service: "openai_http", endpoint: "http://voice.local", credential: "x".repeat(4097) }))).status, 400);
    assert.equal((await request(new URLSearchParams({ revision: "4", service: "openai_http", endpoint: "http://voice.local" }), "https://foreign.example")).status, 403);
    assert.equal((await request(new URLSearchParams({ revision: "4", service: "openai_http", endpoint: "http://voice.local" }), ctx.productSetupHttp.origin, "")).status, 401);
    assert.equal(setupDrafts.voiceChecks.length, 0);

    const invalidSkip = await fetch(`${ctx.productSetupHttp.origin}/setup/voice/skip`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: ctx.productSetupHttp.origin, cookie: `hob_product_session=${sessionToken}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ revision: "4", continue: "now" }),
    });
    assert.equal(invalidSkip.status, 400);
    const skipped = await fetch(`${ctx.productSetupHttp.origin}/setup/voice/skip`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: ctx.productSetupHttp.origin, cookie: `hob_product_session=${sessionToken}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ revision: "4" }),
    });
    assert.equal(skipped.status, 303);
    const map = await fetch(`${ctx.productSetupHttp.origin}/setup`, { headers: { cookie: `hob_product_session=${sessionToken}` } });
    assert.match(await map.text(), /本次不连接私人语音；文字对话仍可使用/);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});
