import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import {
  createHomeHubProcessOptions,
  main,
  resolveHomeHubProcessOptions,
} from "./main.js";
import { provisionPrimaryModelApiKey } from "./model-credential-profile.js";

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
  assert.deepEqual(options.runtime.homeSafety?.bindings, []);
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

test("main fails closed before creating a Cordis runtime when neutral bridge config is missing", async () => {
  await assert.rejects(
    main({
      env: { ...ENV, HOB_BRIDGES: "" },
      createRuntime: async () => ({ context: new Context(), stop: async () => undefined }),
    }),
    /HOB_BRIDGES/,
  );
});
