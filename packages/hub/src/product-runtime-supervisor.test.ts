import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { InboxRequestAuthenticator } from "@hob-agent/inbox-web/http";
import type { WritableSecretVault } from "@hob-agent/agent-layer/model-credentials";
import type {
  ProductSetupDraftPort,
  ProductSetupDraftProjection,
} from "@hob-agent/inbox-web/setup";

import type { ProductBootstrapConfigDraft } from "./product-bootstrap-config-store.js";
import { ProductBootstrapConfigStore } from "./product-bootstrap-config-store.js";
import { ProductSetupDraftStore } from "./product-setup-draft-store.js";
import { ProductSessionStore } from "./product-session-store.js";
import {
  ProductRuntimeSupervisor,
  type RuntimeProductBundle,
  type ProductRuntimeSupervisorOptions,
} from "./product-runtime-supervisor.js";

const draft: ProductBootstrapConfigDraft = {
  householdName: "梧桐家",
  agentName: "小满",
  modelReference: "custom/home-model",
  modelBaseURL: "https://model.example.test/v1",
  modelProfile: {
    id: "custom:setup:runtime-supervisor",
    provider: "custom",
    kind: "api_key",
    secretRef: "keychain:hob-agent/setup-model:runtime-supervisor:stage-a",
  },
  bridges: [],
};

test("recovers persisted voice staging once before the setup surface becomes available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-voice-staging-"));
  const events: string[] = [];
  const setup = new MapSetupDrafts(draft);
  Object.assign(setup, {
    recoverVoiceCredentialStaging: async () => { events.push("recover-staging"); },
    sweepVoiceCredentialCleanup: async () => { events.push("sweep-retired"); },
  });
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    setupDrafts: setup,
    mountOperational: async () => undefined,
    announce: () => { events.push("setup-surface"); },
  });
  try {
    await runtime.start();
    assert.deepEqual(events, ["recover-staging", "sweep-retired", "setup-surface"]);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("activates the exact mapped draft and rotates the short-lived setup token into an operational session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-"));
  const setup = new MapSetupDrafts(draft);
  const configurationStore = new ProductBootstrapConfigStore(directory);
  const mounted = mountedBundle();
  let mountedDraft: ProductBootstrapConfigDraft | undefined;
  let authenticator: InboxRequestAuthenticator | undefined;
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    setupDrafts: setup,
    configurationStore,
    now: () => new Date("2026-08-24T00:00:00.000Z"),
    createOperationalSessionToken: () => "operational-session-token-with-at-least-thirty-two-bytes",
    mountOperational: async ({ candidate, authenticateProductSession, host }) => {
      mountedDraft = candidate;
      authenticator = authenticateProductSession;
      mounted.setOnAttach(() => host.switchTo((request, response) => {
        response.statusCode = request.url === "/onboarding" ? 200 : 404;
        response.end();
      }));
      return mounted.bundle;
    },
    announce: () => undefined,
  });
  try {
    await runtime.start();
    const origin = runtime.origin;
    const response = await fetch(`${origin}/setup/activate`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin,
        cookie: "hob_product_session=paired-session-token-which-is-long-enough",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "revision=7",
    });

    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/onboarding");
    assert.match(response.headers.get("set-cookie") ?? "", /^hob_product_session=operational-session-token/u);
    assert.deepEqual(mountedDraft, draft);
    assert.equal(mounted.attachCalls(), 1);
    assert.equal((await configurationStore.load())?.generation, 1);
    assert.equal((await fetch(`${origin}/setup`)).status, 404);
    assert.equal((await fetch(`${origin}/onboarding`)).status, 200);
    assert.equal(await authenticator?.({
      authorization: undefined,
      cookie: "hob_product_session=paired-session-token-which-is-long-enough",
      origin,
    }), false);
    assert.equal(await authenticator?.({
      authorization: undefined,
      cookie: "hob_product_session=operational-session-token-with-at-least-thirty-two-bytes",
      origin,
    }), true);
    await runtime.stop();
    assert.equal(mounted.disposeCalls(), 1);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restores a durable operational session after restart even when setup would have expired", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-session-restart-"));
  const setupToken = "paired-session-token-which-is-long-enough";
  const operationalToken = "restarted-operational-session-token-with-at-least-32";
  const now = new Date("2026-08-25T12:00:00.000Z");
  const first = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    setupDrafts: new MapSetupDrafts(draft),
    now: () => now,
    createOperationalSessionToken: () => operationalToken,
    mountOperational: async () => mountedBundle().bundle,
    announce: () => undefined,
  });
  let authenticator: InboxRequestAuthenticator | undefined;
  const second = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    now: () => new Date("2026-08-26T12:00:00.000Z"),
    mountOperational: async ({ authenticateProductSession }) => {
      authenticator = authenticateProductSession;
      return mountedBundle().bundle;
    },
    announce: () => undefined,
  });
  try {
    await first.start();
    const activation = await fetch(`${first.origin}/setup/activate`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: first.origin,
        cookie: `hob_product_session=${setupToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "revision=7",
    });
    assert.equal(activation.status, 303);
    await first.stop();

    await second.start();
    assert.equal(second.mode, "operational");
    assert.equal(await authenticator?.({ authorization: undefined, cookie: `hob_product_session=${operationalToken}`, origin: second.origin }), true);
    assert.equal(await authenticator?.({ authorization: undefined, cookie: `hob_product_session=${setupToken}`, origin: second.origin }), false);
  } finally {
    await first.stop();
    await second.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("clears an uncommitted operational session before reopening setup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-orphan-session-"));
  const now = new Date("2026-08-24T00:00:00.000Z");
  const sessions = new ProductSessionStore(directory, () => now);
  const abandonedToken = "abandoned-operational-session-token-with-at-least-32";
  const activatedToken = "recovered-operational-session-token-with-at-least-32";
  const configurationStore = new ProductBootstrapConfigStore(directory, () => now);
  let authenticator: InboxRequestAuthenticator | undefined;
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    now: () => now,
    setupDrafts: new MapSetupDrafts(draft),
    configurationStore,
    productSessions: sessions,
    createOperationalSessionToken: () => activatedToken,
    mountOperational: async ({ authenticateProductSession }) => {
      authenticator = authenticateProductSession;
      return mountedBundle().bundle;
    },
    announce: () => undefined,
  });
  try {
    await sessions.create({
      token: abandonedToken,
      principalId: "household-owner",
      deviceId: "setup-browser",
      expiresAt: new Date("2026-11-22T00:00:00.000Z"),
    });

    await runtime.start();
    const response = await fetch(`${runtime.origin}/setup/activate`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: runtime.origin,
        cookie: "hob_product_session=paired-session-token-which-is-long-enough",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "revision=7",
    });

    assert.equal(response.status, 303);
    assert.equal(await authenticator?.({ authorization: undefined, cookie: `hob_product_session=${abandonedToken}`, origin: runtime.origin }), false);
    assert.equal(await authenticator?.({ authorization: undefined, cookie: `hob_product_session=${activatedToken}`, origin: runtime.origin }), true);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("announces one recovery code after restart and lets exactly one local recovery rotate the session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-recovery-"));
  const setupToken = "paired-session-token-which-is-long-enough";
  const oldToken = "expired-operational-session-token-with-at-least-32";
  const newToken = "recovered-operational-session-token-with-at-least-32";
  const first = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    setupDrafts: new MapSetupDrafts(draft),
    now: () => new Date("2026-08-24T00:00:00.000Z"),
    createOperationalSessionToken: () => oldToken,
    mountOperational: async () => mountedBundle().bundle,
    announce: () => undefined,
  });
  let recovery: { recover(code: string): Promise<unknown> } | undefined;
  let authenticator: InboxRequestAuthenticator | undefined;
  const announcements: unknown[] = [];
  const second = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    now: () => new Date("2026-11-24T00:00:00.000Z"),
    createRecoveryPairingCode: () => "FRESH-HOME",
    createOperationalSessionToken: () => newToken,
    announceRecovery: (announcement) => { announcements.push(announcement); },
    mountOperational: async ({ authenticateProductSession, recoverProductSession }) => {
      authenticator = authenticateProductSession;
      recovery = recoverProductSession;
      return mountedBundle().bundle;
    },
  });
  let third: ProductRuntimeSupervisor | undefined;
  try {
    await first.start();
    const activation = await fetch(`${first.origin}/setup/activate`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: first.origin,
        cookie: `hob_product_session=${setupToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "revision=7",
    });
    assert.equal(activation.status, 303);
    await first.stop();

    await second.start();
    assert.equal(announcements.length, 1);
    const results = await Promise.all([recovery?.recover("FRESH-HOME"), recovery?.recover("FRESH-HOME")]);
    assert.equal(results.filter((result) => (result as { status?: string } | undefined)?.status === "recovered").length, 1);
    assert.equal(second.status, "running");
    assert.equal((await new ProductBootstrapConfigStore(directory).load())?.generation, 1);
    assert.equal(await authenticator?.({ authorization: undefined, cookie: `hob_product_session=${oldToken}`, origin: second.origin }), false);
    assert.equal(await authenticator?.({ authorization: undefined, cookie: `hob_product_session=${newToken}`, origin: second.origin }), true);
    await second.stop();

    third = new ProductRuntimeSupervisor({
      dataDirectory: directory,
      port: 0,
      mountOperational: async ({ authenticateProductSession }) => {
        authenticator = authenticateProductSession;
        return mountedBundle().bundle;
      },
      announce: () => undefined,
    });
    await third.start();
    assert.equal(await authenticator?.({ authorization: undefined, cookie: `hob_product_session=${newToken}`, origin: third.origin }), true);
  } finally {
    await first.stop();
    await second.stop();
    await third?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps a committed generation recoverable after both immediate attachments fail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-attach-failure-"));
  const configurationStore = new ProductBootstrapConfigStore(directory);
  let disposals = 0;
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    setupDrafts: new MapSetupDrafts(draft),
    createOperationalSessionToken: () => "attach-failure-operational-token-with-at-least-32",
    configurationStore,
    mountOperational: async () => ({
      attach: () => { throw new Error("product attachment failed"); },
      dispose: async () => { disposals += 1; },
    }),
    announce: () => undefined,
  });
  let restarted: ProductRuntimeSupervisor | undefined;
  try {
    await runtime.start();
    const response = await fetch(`${runtime.origin}/setup/activate`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: runtime.origin,
        cookie: "hob_product_session=paired-session-token-which-is-long-enough",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "revision=7",
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(disposals, 2);
    assert.equal((await configurationStore.load())?.generation, 1);
    await runtime.stop();

    let recoveredAuthenticator: InboxRequestAuthenticator | undefined;
    restarted = new ProductRuntimeSupervisor({
      dataDirectory: directory,
      port: 0,
      configurationStore,
      mountOperational: async ({ authenticateProductSession }) => {
        recoveredAuthenticator = authenticateProductSession;
        return mountedBundle().bundle;
      },
      announce: () => undefined,
    });
    await restarted.start();
    assert.equal(restarted.mode, "operational");
    assert.equal(await recoveredAuthenticator?.({
      authorization: undefined,
      cookie: "hob_product_session=attach-failure-operational-token-with-at-least-32",
      origin: restarted.origin,
    }), true);
  } finally {
    await runtime.stop();
    await restarted?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("remounts the committed generation before returning the activation receipt when its first attachment fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-attach-recovery-"));
  const configurationStore = new ProductBootstrapConfigStore(directory);
  const recovered = mountedBundle();
  let mounts = 0;
  let initialDisposals = 0;
  const operationalToken = "attach-recovery-operational-token-with-at-least-32";
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    setupDrafts: new MapSetupDrafts(draft),
    createOperationalSessionToken: () => operationalToken,
    configurationStore,
    mountOperational: async () => {
      mounts += 1;
      if (mounts === 1) {
        return {
          attach: () => { throw new Error("first attachment failed"); },
          dispose: async () => { initialDisposals += 1; },
        };
      }
      return recovered.bundle;
    },
    announce: () => undefined,
  });
  try {
    await runtime.start();
    const response = await fetch(`${runtime.origin}/setup/activate`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: runtime.origin,
        cookie: "hob_product_session=paired-session-token-which-is-long-enough",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "revision=7",
    });

    assert.equal(response.status, 303);
    assert.match(response.headers.get("set-cookie") ?? "", /^hob_product_session=attach-recovery-operational-token/u);
    assert.equal(mounts, 2);
    assert.equal(initialDisposals, 1);
    assert.equal(recovered.attachCalls(), 1);
    assert.equal(runtime.mode, "operational");
    assert.equal((await configurationStore.load())?.generation, 1);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps setup live and leaves configuration absent when the candidate cannot mount", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-failure-"));
  const configurationStore = new ProductBootstrapConfigStore(directory);
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    setupDrafts: new MapSetupDrafts(draft),
    configurationStore,
    mountOperational: async () => undefined,
    announce: () => undefined,
  });
  try {
    await runtime.start();
    const origin = runtime.origin;
    const response = await fetch(`${origin}/setup/activate`, {
      method: "POST",
      headers: {
        origin,
        cookie: "hob_product_session=paired-session-token-which-is-long-enough",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "revision=7",
    });

    assert.equal(response.status, 503);
    assert.match(await response.text(), /已验证的设置仍然保留/u);
    assert.equal(await configurationStore.load(), undefined);
    assert.equal((await fetch(`${origin}/setup`, {
      headers: { cookie: "hob_product_session=paired-session-token-which-is-long-enough" },
    })).status, 200);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restores an active generation directly into the product bundle after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-restart-"));
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, draft);
  const mounted = mountedBundle();
  let mountedDraft: ProductBootstrapConfigDraft | undefined;
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    setupDrafts: new MapSetupDrafts(draft),
    configurationStore,
    mountOperational: async ({ candidate }) => {
      mountedDraft = candidate;
      return mounted.bundle;
    },
    announce: () => undefined,
  });
  try {
    await runtime.start();
    assert.equal(mountedDraft?.modelReference, draft.modelReference);
    assert.equal(mountedDraft?.householdName, draft.householdName);
    assert.equal(mounted.attachCalls(), 1);
    assert.equal(runtime.mode, "operational");
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mounts the private voice provider setup capability as the only Cordis voice owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-voice-"));
  const calls: string[] = [];
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    setupDrafts: new MapSetupDrafts(draft),
    voiceSetup: {
      probe: async ({ track }) => {
        calls.push(track.kind);
        return { status: "ready", latencyMs: 4 };
      },
    },
    mountOperational: async () => undefined,
    announce: () => undefined,
  });
  try {
    await runtime.start();
    const result = await runtime.context.productVoiceSetup.probe({
      setupId: "runtime-supervisor",
      track: { kind: "tts", transport: "wyoming", endpoint: "wyoming://127.0.0.1:10301", locale: "zh-CN" },
    });
    assert.equal(result.status, "ready");
    assert.deepEqual(calls, ["tts"]);
    assert.equal("privateVoiceRuntime" in runtime.context, false);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses the one Cordis-mounted voice setup owner for the real first-run controller", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-voice-controller-"));
  const now = new Date("2026-08-24T00:30:00.000Z");
  const sessionToken = "paired-voice-controller-session-token-value";
  const store = new ProductSetupDraftStore(directory, () => now, () => "voice-controller-draft");
  await store.establishSession({ sessionToken, sessionExpiresAt: new Date("2026-08-24T12:30:00.000Z") });
  await store.saveIdentity({
    sessionToken,
    expectedRevision: 1,
    householdName: "梧桐家",
    agentName: "小满",
  });
  await store.recordModelProbe({
    sessionToken,
    expectedRevision: 2,
    stage: {
      profile: {
        id: "custom:setup:voice-controller-draft",
        provider: "custom",
        kind: "api_key",
        secretRef: "keychain:hob-agent/setup-model:voice-controller-draft:model-stage",
      },
      modelId: "local-model",
    },
    latencyMs: 3,
  });
  await store.recordBridgeProbe({
    sessionToken,
    expectedRevision: 3,
    stage: {
      bridgeId: "bridge-0123456789abcdef",
      adapterType: "fixture-peer",
      label: "Fixture peer",
      config: { endpoint: "fixture://peer.local" },
      credentialRefs: { session: "keychain:hob-agent/bridge:bridge-0123456789abcdef:session" },
    },
    latencyMs: 4,
    summary: { states: 5, entities: 4, devices: 3, areas: 2 },
  });

  const calls: string[] = [];
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    now: () => now,
    pairingCode: "LIVE-HOME",
    voiceSetup: {
      probe: async ({ track }) => {
        calls.push(track.kind);
        return { status: "ready", latencyMs: 5 };
      },
    },
    mountOperational: async () => undefined,
    announce: () => undefined,
  });
  try {
    await runtime.start();
    const response = await fetch(`${runtime.origin}/setup/voice/asr/verify`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: runtime.origin,
        cookie: `hob_product_session=${sessionToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "revision=4&service=wyoming&endpoint=wyoming%3A%2F%2F127.0.0.1%3A10300",
    });
    assert.equal(response.status, 303);
    assert.deepEqual(calls, ["asr"]);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("activates the configured private voice providers before handing over the product surface", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/v1/audio/transcriptions") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ text: "语音服务已连接" }));
      return;
    }
    if (request.url === "/v1/audio/speech") {
      response.setHeader("content-type", "audio/wav");
      response.end(Buffer.from([82, 73, 70, 70]));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", (error?: Error) => error === undefined ? resolve() : reject(error)));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const voiceDraft: ProductBootstrapConfigDraft = {
    ...draft,
    voice: {
      asr: { transport: "openai_http", endpoint, model: "local-asr" },
      tts: { transport: "openai_http", endpoint, model: "local-tts", locale: "zh-CN", voice: "warm" },
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-private-voice-"));
  const mounted = mountedBundle();
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    setupDrafts: new MapSetupDrafts(voiceDraft),
    mountOperational: async ({ privateVoice }) => {
      assert.deepEqual(privateVoice?.status, { status: "active" });
      assert.deepEqual(await privateVoice?.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" }), {
        status: "transcribed",
        text: "语音服务已连接",
      });
      return mounted.bundle;
    },
    announce: () => undefined,
  });
  try {
    await runtime.start();
    const response = await fetch(`${runtime.origin}/setup/activate`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: runtime.origin,
        cookie: "hob_product_session=paired-session-token-which-is-long-enough",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "revision=7",
    });
    assert.equal(response.status, 303);
    assert.equal((await new ProductBootstrapConfigStore(directory).load())?.voice?.tts.model, "local-tts");
    await runtime.stop();
    assert.equal(mounted.disposeCalls(), 1);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("activates the household product with text available when private voice is temporarily offline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-private-voice-degraded-"));
  const configurationStore = new ProductBootstrapConfigStore(directory);
  const voiceDraft: ProductBootstrapConfigDraft = {
    ...draft,
    voice: {
      asr: { transport: "openai_http", endpoint: "http://127.0.0.1:1" },
      tts: { transport: "openai_http", endpoint: "http://127.0.0.1:1", locale: "zh-CN" },
    },
  };
  const mounted = mountedBundle();
  let observedVoiceStatus: unknown;
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    setupDrafts: new MapSetupDrafts(voiceDraft),
    configurationStore,
    mountOperational: async ({ privateVoice }) => {
      observedVoiceStatus = privateVoice?.status;
      return mounted.bundle;
    },
    announce: () => undefined,
  });
  try {
    await runtime.start();
    const response = await fetch(`${runtime.origin}/setup/activate`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: runtime.origin,
        cookie: "hob_product_session=paired-session-token-which-is-long-enough",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "revision=7",
    });

    assert.equal(response.status, 303);
    assert.equal(runtime.mode, "operational");
    assert.deepEqual(observedVoiceStatus, { status: "degraded", reason: "endpoint_unreachable" });
    assert.equal((await configurationStore.load())?.generation, 1);
    assert.equal(mounted.attachCalls(), 1);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restores the household product when a committed private voice endpoint is temporarily offline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-private-voice-recovery-"));
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, {
    ...draft,
    voice: {
      asr: { transport: "openai_http", endpoint: "http://127.0.0.1:1" },
      tts: { transport: "openai_http", endpoint: "http://127.0.0.1:1", locale: "zh-CN" },
    },
  });
  const mounted = mountedBundle();
  let observedVoiceStatus: unknown;
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    configurationStore,
    mountOperational: async ({ privateVoice }) => {
      observedVoiceStatus = privateVoice?.status;
      return mounted.bundle;
    },
    announce: () => undefined,
  });
  try {
    await runtime.start();
    assert.equal(runtime.mode, "operational");
    assert.deepEqual(observedVoiceStatus, { status: "degraded", reason: "endpoint_unreachable" });
    assert.equal(mounted.attachCalls(), 1);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries a retired voice credential cleanup after restart and after activation without using the expired setup session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-voice-cleanup-"));
  const setupToken = "voice-cleanup-setup-session-token-with-enough-entropy";
  const now = new Date("2026-08-23T02:00:00.000Z");
  const retired = await prepareRetiredVoiceCredential(directory, setupToken, now);
  const deleted: string[] = [];
  let deleteAvailable = false;
  const vault: WritableSecretVault = {
    read: async () => undefined,
    write: async () => undefined,
    delete: async (reference) => {
      deleted.push(reference);
      if (!deleteAvailable) throw new Error("keychain unavailable");
    },
  };
  const first = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    now: () => now,
    pairingCode: "LIVE-HOME",
    voiceSetup: { vault, probe: async () => ({ status: "unavailable" }) },
    mountOperational: async () => mountedBundle().bundle,
    announce: () => undefined,
  });
  const second = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    now: () => now,
    pairingCode: "LIVE-HOME",
    voiceSetup: { vault, probe: async () => ({ status: "unavailable" }) },
    mountOperational: async () => mountedBundle().bundle,
    announce: () => undefined,
  });
  try {
    await first.start();
    assert.deepEqual(deleted, [retired.credentialRef]);
    assert.deepEqual(await new ProductSetupDraftStore(directory, () => now).pendingVoiceCleanupForMaintenance(), [retired]);
    await first.stop();

    deleteAvailable = true;
    await new ProductBootstrapConfigStore(directory, () => now).commit(0, draft);
    await second.start();
    assert.equal(second.mode, "operational");
    assert.deepEqual(deleted, [retired.credentialRef, retired.credentialRef]);
    assert.deepEqual(await new ProductSetupDraftStore(directory, () => now).pendingVoiceCleanupForMaintenance(), []);
  } finally {
    await first.stop();
    await second.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleans a retired voice credential when a mapped setup draft becomes operational", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-voice-activation-cleanup-"));
  const setupToken = "voice-activation-setup-session-token-with-enough-entropy";
  const now = new Date("2026-08-23T02:00:00.000Z");
  const retired = await prepareRetiredVoiceCredential(directory, setupToken, now);
  const deleted: string[] = [];
  let deleteAvailable = false;
  const vault: WritableSecretVault = {
    read: async () => undefined,
    write: async () => undefined,
    delete: async (reference) => {
      deleted.push(reference);
      if (!deleteAvailable) throw new Error("keychain unavailable");
    },
  };
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    now: () => now,
    pairingCode: "LIVE-HOME",
    createOperationalSessionToken: () => "voice-activation-operational-token-with-enough-entropy",
    voiceSetup: { vault, probe: async () => ({ status: "unavailable" }) },
    mountOperational: async () => mountedBundle().bundle,
    announce: () => undefined,
  });
  try {
    await runtime.start();
    assert.deepEqual(deleted, [retired.credentialRef]);

    deleteAvailable = true;
    const response = await fetch(`${runtime.origin}/setup/activate`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: runtime.origin,
        cookie: `hob_product_session=${setupToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "revision=6",
    });
    assert.equal(response.status, 303);
    assert.deepEqual(deleted, [retired.credentialRef, retired.credentialRef]);
    assert.deepEqual(await new ProductSetupDraftStore(directory, () => now).pendingVoiceCleanupForMaintenance(), []);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancels private voice work before waiting for the operational product to finish stopping", async () => {
  let asrCalls = 0;
  let operationStarted: (() => void) | undefined;
  const server = createServer((request, response) => {
    if (request.url === "/v1/audio/transcriptions") {
      asrCalls += 1;
      if (asrCalls === 1) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ text: "语音服务已连接" }));
      } else {
        operationStarted?.();
      }
      return;
    }
    response.setHeader("content-type", "audio/wav");
    response.end(Buffer.from([82, 73, 70, 70]));
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", (error?: Error) => error === undefined ? resolve() : reject(error)));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const candidate: ProductBootstrapConfigDraft = {
    ...draft,
    voice: {
      asr: { transport: "openai_http", endpoint },
      tts: { transport: "openai_http", endpoint, locale: "zh-CN" },
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-private-voice-stop-"));
  let privateVoice: Parameters<ProductRuntimeSupervisorOptions["mountOperational"]>[0]["privateVoice"];
  let releaseProductStop: (() => void) | undefined;
  const productStopped = new Promise<void>((resolve) => { releaseProductStop = resolve; });
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    setupDrafts: new MapSetupDrafts(candidate),
    mountOperational: async (input) => {
      privateVoice = input.privateVoice;
      return { attach: () => undefined, dispose: () => productStopped };
    },
    announce: () => undefined,
  });
  try {
    await runtime.start();
    const activation = await fetch(`${runtime.origin}/setup/activate`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: runtime.origin,
        cookie: "hob_product_session=paired-session-token-which-is-long-enough",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "revision=7",
    });
    assert.equal(activation.status, 303);
    const started = new Promise<void>((resolve) => { operationStarted = resolve; });
    const transcription = privateVoice!.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" });
    await started;
    const stopping = runtime.stop();
    const settledBeforeProduct = await Promise.race([
      transcription.then((result) => ({ settled: true as const, result })),
      new Promise<{ readonly settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), 100)),
    ]);
    assert.deepEqual(settledBeforeProduct, { settled: true, result: { status: "failed", reason: "cancelled" } });
    releaseProductStop?.();
    await stopping;
  } finally {
    releaseProductStop?.();
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

class MapSetupDrafts implements ProductSetupDraftPort {
  private readonly projection: ProductSetupDraftProjection = {
    draftId: "runtime-supervisor",
    revision: 7,
    stage: "map",
    householdName: "梧桐家",
    agentName: "小满",
  };

  constructor(private readonly candidate: ProductBootstrapConfigDraft) {}

  async establishSession(): Promise<ProductSetupDraftProjection> { return this.projection; }
  async loadForSession(token: string): Promise<ProductSetupDraftProjection | undefined> {
    return token === "paired-session-token-which-is-long-enough" ? this.projection : undefined;
  }
  async saveIdentity(): Promise<ProductSetupDraftProjection> { return this.projection; }
  async probeModel(): Promise<never> { throw new Error("not used"); }
  async probeBridge(): Promise<never> { throw new Error("not used"); }
  async activationCandidateForSession(token: string, revision: number): Promise<ProductBootstrapConfigDraft | undefined> {
    return token === "paired-session-token-which-is-long-enough" && revision === 7 ? this.candidate : undefined;
  }
}

function mountedBundle(): {
  readonly bundle: RuntimeProductBundle;
  readonly attachCalls: () => number;
  readonly disposeCalls: () => number;
  readonly setOnAttach: (callback: () => void) => void;
} {
  let attached = 0;
  let disposed = 0;
  let onAttach = (): void => undefined;
  return {
    bundle: {
      attach: () => { attached += 1; onAttach(); },
      dispose: async () => { disposed += 1; },
    },
    attachCalls: () => attached,
    disposeCalls: () => disposed,
    setOnAttach: (callback) => { onAttach = callback; },
  };
}

async function prepareRetiredVoiceCredential(
  directory: string,
  token: string,
  now: Date,
): Promise<{
  readonly kind: "asr";
  readonly transport: "openai_http";
  readonly endpoint: string;
  readonly credentialRef: string;
}> {
  const store = new ProductSetupDraftStore(directory, () => now, () => "runtime-voice-cleanup");
  const retired = {
    kind: "asr" as const,
    transport: "openai_http" as const,
    endpoint: "http://127.0.0.1:9881",
    credentialRef: "keychain:hob-agent/voice:asr:runtime-voice-cleanup:retired",
  };
  await store.establishSession({ sessionToken: token, sessionExpiresAt: new Date("2026-08-23T14:00:00.000Z") });
  await store.saveIdentity({ sessionToken: token, expectedRevision: 1, householdName: "测试家", agentName: "测试助手" });
  await store.recordModelProbe({
    sessionToken: token,
    expectedRevision: 2,
    latencyMs: 10,
    stage: {
      profile: {
        id: "custom:setup:runtime-voice-cleanup",
        provider: "custom",
        kind: "api_key",
        secretRef: "keychain:hob-agent/setup-model:runtime-voice-cleanup:model-stage",
      },
      modelId: "local-model",
    },
  });
  await store.recordBridgeProbe({
    sessionToken: token,
    expectedRevision: 3,
    latencyMs: 10,
    summary: { states: 1, entities: 1, devices: 1, areas: 1 },
    stage: {
      bridgeId: "bridge-0123456789abcdef",
      adapterType: "fixture-peer",
      label: "Fixture peer",
      config: { endpoint: "fixture://peer.local" },
      credentialRefs: { session: "keychain:hob-agent/bridge:bridge-0123456789abcdef:session" },
    },
  });
  await store.reserveVoiceCredential({ sessionToken: token, expectedRevision: 4, stage: retired });
  await store.recordVoiceProbe({ sessionToken: token, expectedRevision: 4, stage: retired, latencyMs: 10 });
  await store.skipVoice({ sessionToken: token, expectedRevision: 5 });
  return retired;
}
