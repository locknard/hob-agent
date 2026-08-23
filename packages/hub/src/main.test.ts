import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { ProductHttpHost } from "@hob-agent/inbox-web/product-http-host";

import {
  createHomeHubProcessOptions,
  main,
  resolveProductLaunchSelection,
  resolveHomeHubProcessOptions,
} from "./main.js";
import { provisionPrimaryModelApiKey } from "./model-credential-profile.js";
import { ProductBootstrapConfigStore } from "./product-bootstrap-config-store.js";
import { createBuiltinBridgeProductBundle } from "./bridge/bridge-bundle.js";
import type { XiaomiHomeTransportPlugin } from "./bridge/xiaomi-home-bridge.js";
import {
  type ProductRuntimeSupervisorOptions,
} from "./product-runtime-supervisor.js";
import { PrivateVoiceGateway } from "./voice/private-voice-gateway.js";
import { PrivateVoiceProviderRuntime } from "./voice/private-voice-provider-runtime.js";

const ENV = {
  HOB_DATA_DIR: "/tmp/hob-agent-main-test",
  HOB_BRIDGES: JSON.stringify([{
    bridgeId: "ha-main",
    adapterType: "home-assistant",
    config: { baseUrl: "http://ha.local:8123", authenticationPrincipal: "owner-a" },
    credentialRefs: { "access-token": "HOB_HA_TOKEN" },
  }]),
  HOB_HA_TOKEN: "home-assistant-secret",
  HOB_MODEL: "gpt/gpt-5.4",
  OPENAI_API_KEY: "openai-secret",
};

const MUSIC_ASSISTANT_ENV = {
  HOB_MUSIC_ASSISTANT_BASE_URL: "https://music.example.test",
  HOB_MUSIC_ASSISTANT_CREDENTIAL_REF: "env:HOB_MUSIC_ASSISTANT_TOKEN",
  HOB_MUSIC_ASSISTANT_TOKEN: "music-assistant-private-token",
};

test("classifies first-run and activated product launch without exposing secrets", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-main-launch-selection-"));
  try {
    assert.deepEqual(await resolveProductLaunchSelection({ HOB_DATA_DIR: dataDirectory }), {
      state: "setup",
      dataDirectory,
    });
    await new ProductBootstrapConfigStore(dataDirectory).commit(0, {
      householdName: "我的家",
      agentName: "hob",
      modelReference: "gpt/gpt-5.4",
      modelProfile: {
        id: "gpt:setup:draft-launch",
        provider: "gpt",
        kind: "api_key",
        secretRef: "keychain:hob-agent/setup-model:draft-launch:stage-launch",
      },
      bridges: [],
    });
    assert.deepEqual(await resolveProductLaunchSelection({ HOB_DATA_DIR: dataDirectory }), {
      state: "operational",
      dataDirectory,
      activatedGeneration: 1,
    });
    assert.deepEqual(await resolveProductLaunchSelection(ENV), {
      state: "setup",
      dataDirectory: ENV.HOB_DATA_DIR,
    });
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("resolves the activated product configuration through the single production launch path", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-main-product-config-"));
  try {
    await new ProductBootstrapConfigStore(dataDirectory).commit(0, {
      householdName: "梧桐家",
      agentName: "小满",
      modelReference: "custom/deepseek-v4-flash-0731",
      modelBaseURL: "https://model.example.test/v1",
      modelProfile: {
        id: "custom:setup:draft-product",
        provider: "custom",
        kind: "api_key",
        secretRef: "keychain:hob-agent/setup-model:draft-product:stage-product",
      },
      bridges: [{
        ...JSON.parse(ENV.HOB_BRIDGES)[0],
        credentialRefs: { "access-token": "env:HOB_HA_TOKEN" },
      }],
    });
    const options = await resolveHomeHubProcessOptions({
      HOB_DATA_DIR: dataDirectory,
      HOB_HA_TOKEN: ENV.HOB_HA_TOKEN,
      HOB_CUSTOM_MODEL_API_KEY: ENV.OPENAI_API_KEY,
    });

    assert.equal(options.runtime.agent.provider, "custom");
    assert.equal(options.runtime.agent.model, "deepseek-v4-flash-0731");
    assert.equal(options.runtime.agent.baseURL, "https://model.example.test/v1");
    assert.equal(options.runtime.homeWorld.bridges[0]?.adapterType, "home-assistant");

    const overridden = await resolveHomeHubProcessOptions({
      HOB_DATA_DIR: dataDirectory,
      HOB_MODEL: "gpt/gpt-5.4",
      HOB_HA_TOKEN: ENV.HOB_HA_TOKEN,
      OPENAI_API_KEY: ENV.OPENAI_API_KEY,
    });
    assert.equal(overridden.runtime.agent.provider, "gpt");
    assert.equal(overridden.runtime.agent.baseURL, undefined);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("builds neutral HomeWorld process options from the allowlisted environment", () => {
  const options = createHomeHubProcessOptions(ENV);

  assert.deepEqual(options.runtime.homeWorld.bridges, [{
    bridgeId: "ha-main",
    adapterType: "home-assistant",
    config: { baseUrl: "http://ha.local:8123", authenticationPrincipal: "owner-a" },
  }]);
  assert.equal(options.runtime.homeWorld.catalog.hasAdapter("home-assistant"), true);
  assert.equal(options.runtime.homeProposals.path, "/tmp/hob-agent-main-test/proposals.sqlite");
  assert.equal(options.runtime.homeReviewCenter?.path, "/tmp/hob-agent-main-test/one-shot-actions.sqlite");
  assert.equal(options.runtime.homeArtifacts.path, "/tmp/hob-agent-main-test/artifacts.sqlite");
  assert.equal(options.runtime.homeAuthorityCandidates.path, "/tmp/hob-agent-main-test/authority-candidates.sqlite");
  assert.equal(options.runtime.homeObservationAudit.path, "/tmp/hob-agent-main-test/observation-audit.sqlite");
  assert.equal(options.runtime.homeAdvice.path, "/tmp/hob-agent-main-test/home-advice.sqlite");
  assert.deepEqual(options.runtime.agent, {
    provider: "gpt",
    model: "gpt-5.4",
    sessionPersistencePath: "/tmp/hob-agent-main-test/dsh-sessions.sqlite",
  });
  assert.equal(options.runtime.launchEnvironment.get("OPENAI_API_KEY")?.value, "openai-secret");
  assert.equal(JSON.stringify(options.runtime.homeWorld.bridges).includes("home-assistant-secret"), false);
  assert.equal(options.runtime.inboxHttp, undefined);
  assert.equal(options.runtime.mediaCatalog, undefined);
  assert.equal(options.runtime.homeMediaActionTurns, undefined);
  assert.deepEqual(options.runtime.homeSafety?.bindings, []);
});

test("mounts each candidate with the runtime registrations from its product bridge bundle", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-main-product-bridge-bundle-"));
  const xiaomi: XiaomiHomeTransportPlugin = {
    credentialRequirements: [],
    create: () => ({
      connect: async () => ({ installationId: "fixture", devices: [] }),
      changes: async function* () {},
      resync: async () => ({ installationId: "fixture", devices: [] }),
      dispose: async () => {},
    }),
  };
  const bridgeProductBundle = createBuiltinBridgeProductBundle({ xiaomi });
  let productOptions: ProductRuntimeSupervisorOptions | undefined;
  let observedXiaomi = false;
  const host = new ProductHttpHost({ port: 0 });
  const privateVoice = new PrivateVoiceGateway();
  let running: Awaited<ReturnType<typeof main>> | undefined;
  try {
    running = await main({
      env: { HOB_DATA_DIR: dataDirectory },
      bridgeProductBundle,
      mountProductBundle: async (_context, options) => {
        observedXiaomi = options.homeWorld.catalog.hasAdapter("xiaomi-home");
        return {
          context: { homeInboxHttp: { attach: () => undefined } },
          dispose: async () => undefined,
        } as never;
      },
      createProductRuntime: async (input) => {
        productOptions = input;
        return { context: new Context(), stop: async () => undefined };
      },
    });
    assert.equal(productOptions?.bridgeProductBundle, bridgeProductBundle);
    const mounted = await productOptions!.mountOperational({
      candidate: {
        householdName: "梧桐家",
        agentName: "小满",
        modelReference: "custom/home-model",
        modelBaseURL: "https://model.example.test/v1",
        modelProfile: {
          id: "custom:setup:bundle-main",
          provider: "custom",
          kind: "api_key",
          secretRef: "keychain:hob-agent/setup-model:bundle-main:stage-a",
        },
        bridges: [{
          bridgeId: "xiaomi-main",
          adapterType: "xiaomi-home",
          config: { region: "cn", transport: "central-gateway" },
          credentialRefs: {},
        }],
      },
      context: new Context(),
      host,
      authenticateProductSession: async () => true,
      recoverProductSession: { recover: async () => ({ status: "invalid" as const }) },
      privateVoice,
      voiceSettings: {} as never,
      modelProviderResolver: {} as never,
      modelSettings: {} as never,
    });
    assert.notEqual(mounted, undefined);
    assert.equal(observedXiaomi, true);
    await mounted?.dispose();
  } finally {
    await running?.shutdown.shutdown(0);
    await host.dispose();
    await privateVoice.dispose({ force: true });
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("passes explicit safety bindings only to the Hub safety owner", () => {
  const binding = {
    id: "kitchen-leak",
    hwCapabilityId: "hwc-kitchen-leak",
    kind: "water_leak",
    title: "厨房漏水",
    sourceLabel: "厨房漏水传感器",
    stateAttribute: "state",
    activeValues: ["on"],
    clearValues: ["off"],
  } as const;
  const runtime = createHomeHubProcessOptions({
    ...ENV,
    HOB_SAFETY_BINDINGS: JSON.stringify([binding]),
  }).runtime;

  assert.deepEqual(runtime.homeSafety?.bindings, [binding]);
  assert.equal("safetyBindings" in runtime.agent, false);
});

test("mounts explicit Music Assistant catalog and governed playback composition", () => {
  const options = createHomeHubProcessOptions({ ...ENV, ...MUSIC_ASSISTANT_ENV });
  const mediaCatalog = options.runtime.mediaCatalog;

  assert.equal(mediaCatalog?.catalogId, "music-assistant");
  assert.equal(mediaCatalog?.sourceLabel, "Music Assistant");
  assert.equal(mediaCatalog?.maxResults, 3);
  assert.equal(mediaCatalog?.provider.constructor.name, "MusicAssistantMediaCatalogProvider");
  assert.deepEqual(options.runtime.homeMediaActionTurns, {
    path: "/tmp/hob-agent-main-test/home-media-action-turns.sqlite",
  });
  const client = (mediaCatalog?.provider as unknown as { readonly client?: unknown }).client as {
    readonly constructor: { readonly name: string };
  } | undefined;
  assert.equal(client?.constructor.name, "MusicAssistantWebSocketSearchClient");
  assert.equal(options.runtime.mediaPlayback, undefined);
  assert.equal(options.runtime.launchEnvironment.get("HOB_MUSIC_ASSISTANT_TOKEN"), undefined);
  assert.equal(JSON.stringify(options).includes("music-assistant-private-token"), false);

  const playback = createHomeHubProcessOptions({
    ...ENV,
    ...MUSIC_ASSISTANT_ENV,
    HOB_MUSIC_ASSISTANT_PLAYER_BINDINGS: JSON.stringify({
      "hwc-media-room": "ma-player-room",
    }),
  }).runtime.mediaPlayback;
  assert.equal(playback?.tenantId, "household");
  assert.equal(playback?.playerIdForCapability("hwc-media-room"), "ma-player-room");
  assert.equal(playback?.client.constructor.name, "MusicAssistantWebSocketSearchClient");
});

test("fails closed for incomplete Music Assistant production composition", () => {
  for (const environment of [
    { HOB_MUSIC_ASSISTANT_BASE_URL: MUSIC_ASSISTANT_ENV.HOB_MUSIC_ASSISTANT_BASE_URL },
    { HOB_MUSIC_ASSISTANT_CREDENTIAL_REF: MUSIC_ASSISTANT_ENV.HOB_MUSIC_ASSISTANT_CREDENTIAL_REF },
  ]) {
    assert.throws(
      () => createHomeHubProcessOptions({ ...ENV, ...environment }),
      /HOB_MUSIC_ASSISTANT_(BASE_URL|CREDENTIAL_REF)/,
    );
  }
});

test("passes generated action authority only to HomeWorld and never to the Agent runtime", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-main-action-authority-"));
  try {
    await writeFile(join(dataDirectory, "action-authority.json"), JSON.stringify({
      version: 2,
      bindings: [{
        hwCapabilityId: "hwc-example",
        bridgeId: "ha-main",
        approved: true,
        policyClass: "direct",
        revision: 4,
      }],
    }), { mode: 0o600 });

    const options = await resolveHomeHubProcessOptions({
      ...ENV,
      HOB_DATA_DIR: dataDirectory,
    });

    const actionAuthority = options.runtime.homeWorld.actionAuthorityConfig;
    assert.equal(actionAuthority?.["hwc-example"]?.bridgeId, "ha-main");
    assert.equal(actionAuthority?.["hwc-example"]?.configRevision, 4);
    assert.equal(actionAuthority?.["hwc-example"]?.policyClass, "direct");
    assert.equal("actionAuthorityConfig" in options.runtime.agent, false);
    assert.equal("actionAuthorityConfig" in options.runtime, false);
    assert.equal(JSON.stringify(options.runtime.agent).includes("hwc-example"), false);
    assert.equal(JSON.stringify(options.runtime.homeWorld).includes("action-authority.json"), false);
    assert.equal(JSON.stringify(options.runtime.homeWorld).includes('"bindings"'), false);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("passes an empty action-authority map to HomeWorld when the fixed file is absent", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-main-action-authority-empty-"));
  try {
    const options = await resolveHomeHubProcessOptions({
      ...ENV,
      HOB_DATA_DIR: dataDirectory,
    });

    assert.deepEqual(options.runtime.homeWorld.actionAuthorityConfig, {});
    assert.equal("actionAuthorityConfig" in options.runtime.agent, false);
    assert.equal("actionAuthorityConfig" in options.runtime, false);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("forwards only the Inbox verifier and port into the process composition", () => {
  const inboxToken = "local-inbox-token-that-is-longer-than-32-chars";
  const options = createHomeHubProcessOptions({
    ...ENV,
    HOB_INBOX_AUTH_TOKEN: inboxToken,
    HOB_INBOX_PORT: "9876",
    HOB_INBOX_PRINCIPAL_ID: "household-member",
    HOB_INBOX_PRINCIPAL_ROLE: "adult_member",
    HOB_INBOX_DEVICE_KIND: "private",
    HOB_INBOX_DEVICE_BOUND_PRINCIPAL_ID: "household-member",
  });
  const authorization = `Basic ${Buffer.from(`home:${inboxToken}`).toString("base64")}`;

  assert.equal(options.runtime.inboxHttp?.port, 9876);
  assert.equal(options.runtime.inboxHttp?.authenticate(authorization), true);
  assert.deepEqual(options.runtime.inboxHttp?.principal, {
    principalId: "household-member",
    role: "adult_member",
    present: true,
    device: {
      kind: "private",
      boundPrincipalId: "household-member",
    },
  });
  assert.equal(options.runtime.homeViewRecipeDrafts?.path, "/tmp/hob-agent-main-test/layout-drafts.sqlite");
  assert.equal(JSON.stringify(options).includes(inboxToken), false);
});

test("forwards an explicit observation schedule into the Hub runtime", () => {
  const options = createHomeHubProcessOptions({
    ...ENV,
    HOB_OBSERVATION_INTERVAL_MINUTES: "180",
    HOB_OBSERVE_ON_START: "false",
  });
  assert.deepEqual(options.runtime.observation, { intervalMinutes: 180, runOnStart: false });
});

test("production process resolution prefers the selected private profile over ambient credentials", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-main-profile-"));
  const secrets = new Map<string, string>();
  const vault = {
    read: async (reference: string) => secrets.get(reference),
    write: async (reference: string, value: string) => { secrets.set(reference, value); },
    delete: async (reference: string) => { secrets.delete(reference); },
  };
  await provisionPrimaryModelApiKey(dataDirectory, "deepseek", "private-key", vault);

  const options = await resolveHomeHubProcessOptions({
    ...ENV,
    HOB_DATA_DIR: dataDirectory,
    HOB_MODEL: "deepseek/deepseek-v4-flash",
    OPENAI_API_KEY: undefined,
    DEEPSEEK_API_KEY: undefined,
  }, vault);

  assert.equal(options.runtime.agent.profile?.id, "deepseek:primary");
  assert.equal(options.runtime.agent.vault, vault);
  assert.equal(options.runtime.launchEnvironment.get("DEEPSEEK_API_KEY"), undefined);
});

test("importing the executable module does not install process signal handlers", async () => {
  const signalCount = (signal: NodeJS.Signals): number => process.listenerCount(signal);
  const before = {
    sigint: signalCount("SIGINT"),
    sigterm: signalCount("SIGTERM"),
  };

  await import("./main.js");

  assert.equal(signalCount("SIGINT"), before.sigint);
  assert.equal(signalCount("SIGTERM"), before.sigterm);
});

test("main routes direct model and bridge environment input through product setup", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-main-first-run-"));
  let productStarts = 0;
  try {
    const running = await main({
      env: {
        ...ENV,
        HOB_DATA_DIR: dataDirectory,
        HOB_BRIDGES: "{",
      },
      createProductRuntime: async (input) => {
        productStarts += 1;
        assert.equal(input.dataDirectory, dataDirectory);
        assert.equal(input.port, 8787);
        return { context: new Context(), stop: async () => undefined };
      },
    });

    assert.equal(productStarts, 1);
    await running.shutdown.shutdown(0);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("routes setup and recovery pairing codes through the dedicated local terminal channel", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-main-pairing-terminal-"));
  const terminal: string[] = [];
  let productOptions: ProductRuntimeSupervisorOptions | undefined;
  try {
    const running = await main({
      env: { HOB_DATA_DIR: dataDirectory },
      writeProductTerminal: (message) => { terminal.push(message); },
      createProductRuntime: async (input) => {
        productOptions = input;
        return { context: new Context(), stop: async () => undefined };
      },
    });

    productOptions?.announce?.({
      origin: "http://127.0.0.1:8787",
      pairingCode: "SETU-P123",
      expiresAt: new Date("2026-08-24T01:00:00.000Z"),
    });
    productOptions?.announceRecovery?.({
      origin: "http://127.0.0.1:8787",
      pairingCode: "RECO-4567",
      expiresAt: new Date("2026-08-24T01:10:00.000Z"),
    });

    assert.deepEqual(terminal, [
      "\nHob 本机设置配对\n打开：http://127.0.0.1:8787/setup\n配对码：SETU-P123\n有效至：2026-08-24T01:00:00.000Z\n",
      "\nHob 本机会话恢复\n打开：http://127.0.0.1:8787/pair\n配对码：RECO-4567\n有效至：2026-08-24T01:10:00.000Z\n",
    ]);
    await running.shutdown.shutdown(0);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("main restores an activated product through the same supervisor", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-main-activated-product-"));
  await new ProductBootstrapConfigStore(dataDirectory).commit(0, {
    householdName: "梧桐家",
    agentName: "小满",
    modelReference: "custom/home-model",
    modelBaseURL: "https://model.example.test/v1",
    modelProfile: {
      id: "custom:setup:activated-main",
      provider: "custom",
      kind: "api_key",
      secretRef: "keychain:hob-agent/setup-model:activated-main:stage-a",
    },
    bridges: [],
  });
  let productStarts = 0;
  try {
    const running = await main({
      env: { HOB_DATA_DIR: dataDirectory },
      createProductRuntime: async (input) => {
        productStarts += 1;
        assert.equal(input.dataDirectory, dataDirectory);
        return { context: new Context(), stop: async () => undefined };
      },
    });
    assert.equal(productStarts, 1);
    await running.shutdown.shutdown(0);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("mounts the supervisor's exact stable private voice gateway into the operational HTTP surface", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-main-private-voice-"));
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
  const vault = {
    read: async () => undefined,
    write: async () => undefined,
    delete: async () => undefined,
  };
  const privateVoiceProvider = new PrivateVoiceProviderRuntime({
    config: {
      asr: { transport: "openai_http", endpoint },
      tts: { transport: "openai_http", endpoint, locale: "zh-CN" },
    },
    vault,
  });
  const privateVoice = new PrivateVoiceGateway({
    configGeneration: 1,
    providerGeneration: "main-test:1",
    runtime: privateVoiceProvider,
  });
  const voiceSettings = {} as never;
  const modelProviderResolver = {} as never;
  const modelSettings = {} as never;
  let productOptions: ProductRuntimeSupervisorOptions | undefined;
  let mountedVoice: unknown;
  let mountedVoiceSettings: unknown;
  let mountedRecovery: unknown;
  let mountedModelResolver: unknown;
  let mountedModelSettings: unknown;
  let running: Awaited<ReturnType<typeof main>> | undefined;
  const host = new ProductHttpHost({ port: 0 });
  try {
    assert.deepEqual(await privateVoiceProvider.start(), { status: "active" });
    running = await main({
      env: { HOB_DATA_DIR: dataDirectory },
      modelCredentialVault: vault,
      mountProductBundle: async (_context, options) => {
        mountedVoice = options.inboxHttp?.privateVoice;
        mountedVoiceSettings = options.inboxHttp?.voiceSettings;
        mountedRecovery = options.inboxHttp?.sessionRecovery;
        mountedModelResolver = options.agent.modelProviderResolver;
        mountedModelSettings = (options.inboxHttp as { readonly modelSettings?: unknown } | undefined)?.modelSettings;
        return {
          context: { homeInboxHttp: { attach: () => undefined } },
          dispose: async () => undefined,
        } as never;
      },
      createProductRuntime: async (input) => {
        productOptions = input;
        return { context: new Context(), stop: async () => undefined };
      },
    });
    assert.notEqual(productOptions, undefined);
    const bundle = await productOptions!.mountOperational({
      candidate: {
        householdName: "梧桐家",
        agentName: "小满",
        modelReference: "custom/home-model",
        modelBaseURL: "https://model.example.test/v1",
        modelProfile: {
          id: "custom:setup:main-private-voice",
          provider: "custom",
          kind: "api_key",
          secretRef: "keychain:hob-agent/setup-model:main-private-voice:stage-a",
        },
        bridges: [],
      },
      context: new Context(),
      host,
      authenticateProductSession: async () => true,
      recoverProductSession: { recover: async () => ({ status: "invalid" as const }) },
      privateVoice,
      voiceSettings,
      modelProviderResolver,
      modelSettings,
    });
    assert.notEqual(bundle, undefined);
    assert.equal(mountedVoice, privateVoice);
    assert.equal(mountedVoiceSettings, voiceSettings);
    assert.equal(mountedModelResolver, modelProviderResolver);
    assert.equal(mountedModelSettings, modelSettings);
    assert.notEqual(mountedRecovery, undefined);
    await bundle?.dispose();
  } finally {
    await running?.shutdown.shutdown(0);
    await host.dispose();
    await privateVoice.dispose({ force: true });
    await rm(dataDirectory, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});
