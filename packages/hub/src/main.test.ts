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

test("builds neutral HomeWorld process options from the allowlisted environment", () => {
  const options = createHomeHubProcessOptions(ENV);

  assert.deepEqual(options.runtime.homeWorld.bridges, [{
    bridgeId: "ha-main",
    adapterType: "home-assistant",
    config: { baseUrl: "http://ha.local:8123", authenticationPrincipal: "owner-a" },
  }]);
  assert.equal(options.runtime.homeWorld.catalog.hasAdapter("home-assistant"), true);
  assert.equal(options.runtime.homeProposals.path, "/tmp/hob-agent-main-test/proposals.sqlite");
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
});

test("passes generated action authority only to HomeWorld and never to the Agent runtime", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-main-action-authority-"));
  try {
    await writeFile(join(dataDirectory, "action-authority.json"), JSON.stringify({
      version: 1,
      bindings: [{
        hwCapabilityId: "hwc-example",
        bridgeId: "ha-main",
        approved: true,
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
  });
  const authorization = `Basic ${Buffer.from(`home:${inboxToken}`).toString("base64")}`;

  assert.equal(options.runtime.inboxHttp?.port, 9876);
  assert.equal(options.runtime.inboxHttp?.authenticate(authorization), true);
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
