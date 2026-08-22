import assert from "node:assert/strict";
import test from "node:test";

import {
  readHomeHubLaunchConfig,
  readHomeWorldLaunchConfig,
} from "./launch-config.js";
import {
  MUSIC_ASSISTANT_ENV_CREDENTIAL_REF,
  MUSIC_ASSISTANT_KEYCHAIN_CREDENTIAL_REF,
} from "./cli/music-assistant-credential-setup.js";

const BRIDGES = JSON.stringify([{
  bridgeId: "ha-main",
  adapterType: "home-assistant",
  config: {
    baseUrl: "http://ha.local:8123",
    authenticationPrincipal: "owner-a",
  },
  credentialRefs: { "access-token": "HOB_HA_TOKEN" },
}]);

const BASE_ENV = {
  HOB_DATA_DIR: "/tmp/hob-agent-launch-test",
  HOB_BRIDGES: BRIDGES,
  HOB_HA_TOKEN: "home-assistant-secret",
  HOB_MODEL: "gpt/gpt-5.4",
  OPENAI_API_KEY: "openai-secret",
  DEEPSEEK_API_KEY: "must-not-enter-the-snapshot",
};

const INBOX_PRINCIPAL_ENV = {
  HOB_INBOX_PRINCIPAL_ID: "household-member",
  HOB_INBOX_PRINCIPAL_ROLE: "adult_member",
  HOB_INBOX_DEVICE_KIND: "private",
  HOB_INBOX_DEVICE_BOUND_PRINCIPAL_ID: "household-member",
} as const;

const MUSIC_ASSISTANT_BASE_URL = "https://music.example.test";
const MUSIC_ASSISTANT_KEYCHAIN_REF = MUSIC_ASSISTANT_KEYCHAIN_CREDENTIAL_REF;

test("reads neutral bridge entries and selected model credential without putting bridge secrets in config", async () => {
  const config = readHomeHubLaunchConfig(BASE_ENV);

  assert.deepEqual(config.bridges, [{
    bridgeId: "ha-main",
    adapterType: "home-assistant",
    config: {
      baseUrl: "http://ha.local:8123",
      authenticationPrincipal: "owner-a",
    },
  }]);
  assert.equal(config.catalog.hasAdapter("home-assistant"), true);
  assert.equal(config.proposalPath, "/tmp/hob-agent-launch-test/proposals.sqlite");
  assert.equal(config.oneShotActionPath, "/tmp/hob-agent-launch-test/one-shot-actions.sqlite");
  assert.equal(config.authorityCandidatePath, "/tmp/hob-agent-launch-test/authority-candidates.sqlite");
  assert.equal(config.observationAuditPath, "/tmp/hob-agent-launch-test/observation-audit.sqlite");
  assert.equal(config.advicePath, "/tmp/hob-agent-launch-test/home-advice.sqlite");
  assert.equal(config.sessionPath, "/tmp/hob-agent-launch-test/dsh-sessions.sqlite");
  assert.equal(config.onboardingPath, "/tmp/hob-agent-launch-test/onboarding.sqlite");
  assert.equal(JSON.stringify(config.bridges).includes("home-assistant-secret"), false);
  assert.deepEqual(config.agent, { provider: "gpt", model: "gpt-5.4" });
  assert.equal(config.householdDirectory, undefined);
  assert.deepEqual(config.launchEnvironment.get("OPENAI_API_KEY"), {
    value: "openai-secret",
    source: "process",
  });
  assert.equal(config.launchEnvironment.get("DEEPSEEK_API_KEY"), undefined);
  assert.equal(config.launchEnvironment.get("HOB_HA_TOKEN"), undefined);
  assert.deepEqual(
    await config.bridgeCredentialSource.resolveForBridge("ha-main", "access-token"),
    { kind: "secret_text", value: "home-assistant-secret" },
  );
});

test("does not mount Music Assistant from Home Assistant or unrelated environment values", () => {
  const config = readHomeHubLaunchConfig({
    ...BASE_ENV,
    HOB_HA_TOKEN: "home-assistant-secret",
    HOB_MUSIC_ASSISTANT_TOKEN: "must-not-be-inferred",
  });

  assert.equal(config.musicAssistant, undefined);
  assert.equal(JSON.stringify(config).includes("must-not-be-inferred"), false);
});

test("requires the Music Assistant URL and credential reference as an explicit pair", () => {
  for (const environment of [
    { HOB_MUSIC_ASSISTANT_BASE_URL: MUSIC_ASSISTANT_BASE_URL },
    { HOB_MUSIC_ASSISTANT_CREDENTIAL_REF: MUSIC_ASSISTANT_KEYCHAIN_REF },
    { HOB_MUSIC_ASSISTANT_BASE_URL: "   ", HOB_MUSIC_ASSISTANT_CREDENTIAL_REF: MUSIC_ASSISTANT_KEYCHAIN_REF },
    { HOB_MUSIC_ASSISTANT_BASE_URL: MUSIC_ASSISTANT_BASE_URL, HOB_MUSIC_ASSISTANT_CREDENTIAL_REF: "   " },
  ]) {
    assert.throws(
      () => readHomeHubLaunchConfig({ ...BASE_ENV, ...environment }),
      (error: unknown) => error instanceof Error
        && /HOB_MUSIC_ASSISTANT_(BASE_URL|CREDENTIAL_REF)/.test(error.message)
        && !error.message.includes(MUSIC_ASSISTANT_KEYCHAIN_REF),
    );
  }
});

test("keeps the explicit Music Assistant credential lazy and out of launch JSON", async () => {
  const token = "music-assistant-private-token";
  const reads: string[] = [];
  const config = readHomeHubLaunchConfig({
    ...BASE_ENV,
    HOB_MUSIC_ASSISTANT_BASE_URL: MUSIC_ASSISTANT_BASE_URL,
    HOB_MUSIC_ASSISTANT_CREDENTIAL_REF: MUSIC_ASSISTANT_KEYCHAIN_REF,
  }, undefined, {
    read: async (reference: string) => {
      reads.push(reference);
      return token;
    },
  });

  assert.equal(config.musicAssistant?.baseUrl, MUSIC_ASSISTANT_BASE_URL);
  assert.deepEqual(reads, []);
  assert.equal(JSON.stringify(config).includes(token), false);
  assert.equal(JSON.stringify(config).includes(MUSIC_ASSISTANT_KEYCHAIN_REF), false);
  assert.equal(
    await config.musicAssistant?.resolveToken(new AbortController().signal),
    token,
  );
  assert.deepEqual(reads, [MUSIC_ASSISTANT_KEYCHAIN_REF]);
});

test("accepts explicit neutral Music Assistant player bindings and rejects malformed mappings", () => {
  const config = readHomeHubLaunchConfig({
    ...BASE_ENV,
    HOB_MUSIC_ASSISTANT_BASE_URL: MUSIC_ASSISTANT_BASE_URL,
    HOB_MUSIC_ASSISTANT_CREDENTIAL_REF: MUSIC_ASSISTANT_KEYCHAIN_REF,
    HOB_MUSIC_ASSISTANT_PLAYER_BINDINGS: JSON.stringify({
      "hwc-media-room": "ma-player-room",
    }),
  });

  assert.equal(config.musicAssistant?.playerIdForCapability("hwc-media-room"), "ma-player-room");
  assert.equal(config.musicAssistant?.playerIdForCapability("hwc-unknown"), undefined);
  assert.equal(JSON.stringify(config).includes("ma-player-room"), false);

  for (const value of [
    "[]",
    JSON.stringify({ "../capability": "ma-player-room" }),
    JSON.stringify({ "hwc-media-room": "" }),
  ]) {
    assert.throws(
      () => readHomeHubLaunchConfig({
        ...BASE_ENV,
        HOB_MUSIC_ASSISTANT_BASE_URL: MUSIC_ASSISTANT_BASE_URL,
        HOB_MUSIC_ASSISTANT_CREDENTIAL_REF: MUSIC_ASSISTANT_KEYCHAIN_REF,
        HOB_MUSIC_ASSISTANT_PLAYER_BINDINGS: value,
      }),
      /Invalid HOB_MUSIC_ASSISTANT_PLAYER_BINDINGS/,
    );
  }
});

test("loads explicit safety bindings into the Hub-private launch contract", () => {
  const binding = {
    id: "kitchen-leak",
    hwCapabilityId: "hwc-kitchen-leak",
    kind: "water_leak",
    title: "厨房漏水",
    sourceLabel: "厨房漏水传感器",
    stateAttribute: "state",
    activeValues: ["on"],
    clearValues: ["off"],
  };
  const config = readHomeHubLaunchConfig({
    ...BASE_ENV,
    HOB_SAFETY_BINDINGS: JSON.stringify([binding]),
  });

  assert.deepEqual(config.safetyBindings, [binding]);
  assert.throws(
    () => readHomeHubLaunchConfig({
      ...BASE_ENV,
      HOB_SAFETY_BINDINGS: JSON.stringify([{ ...binding, deviceName: "不受信任的名字" }]),
    }),
    /Invalid HOB_SAFETY_BINDINGS/,
  );
});

test("accepts only the reviewed Music Assistant SecretRef forms", () => {
  for (const reference of [
    "env:HOB_OTHER_TOKEN",
    "env:hob_music_assistant_token",
    "keychain:hob-agent/media:other:access-token",
    "keychain:hob-agent/bridge:music-assistant:access-token",
    "music-assistant-private-token",
  ]) {
    assert.throws(
      () => readHomeHubLaunchConfig({
        ...BASE_ENV,
        HOB_MUSIC_ASSISTANT_BASE_URL: MUSIC_ASSISTANT_BASE_URL,
        HOB_MUSIC_ASSISTANT_CREDENTIAL_REF: reference,
      }),
      (error: unknown) => error instanceof Error
        && /HOB_MUSIC_ASSISTANT_CREDENTIAL_REF/.test(error.message)
        && !error.message.includes(reference),
    );
  }
});

test("reads the HomeWorld validation slice without a model or provider credential", async () => {
  const config = readHomeWorldLaunchConfig({
    HOB_DATA_DIR: BASE_ENV.HOB_DATA_DIR,
    HOB_BRIDGES: BASE_ENV.HOB_BRIDGES,
    HOB_HA_TOKEN: BASE_ENV.HOB_HA_TOKEN,
  });
  assert.equal(config.bridges.length, 1);
  assert.equal(config.catalog.hasAdapter("home-assistant"), true);
  assert.deepEqual(await config.bridgeCredentialSource.resolveForBridge("ha-main", "access-token"), {
    kind: "secret_text",
    value: "home-assistant-secret",
  });
  assert.equal("agent" in config, false);
});

test("resolves an explicitly scoped bridge credential from Keychain on demand", async () => {
  const reads: string[] = [];
  const vault = {
    read: async (reference: string) => {
      reads.push(reference);
      return "home-assistant-keychain-secret";
    },
  };
  const config = readHomeWorldLaunchConfig({
    HOB_DATA_DIR: "/tmp/hob-agent-keychain-bridge-test",
    HOB_BRIDGES: JSON.stringify([{
      bridgeId: "ha-main",
      adapterType: "home-assistant",
      config: { baseUrl: "http://ha.local:8123", authenticationPrincipal: "owner-a" },
      credentialRefs: {
        "access-token": "keychain:hob-agent/bridge:ha-main:access-token",
      },
    }]),
  }, vault);

  assert.deepEqual(await config.bridgeCredentialSource.describeForBridge("ha-main", "access-token"), {
    configured: true,
  });
  assert.deepEqual(reads, []);
  assert.deepEqual(await config.bridgeCredentialSource.resolveForBridge("ha-main", "access-token"), {
    kind: "secret_text",
    value: "home-assistant-keychain-secret",
  });
  assert.deepEqual(reads, ["keychain:hob-agent/bridge:ha-main:access-token"]);
  assert.equal(JSON.stringify(config.bridges).includes("keychain"), false);
});

test("rejects a Keychain bridge locator outside its exact bridge and alias scope", () => {
  const unsafe = "keychain:hob-agent/bridge:other-home:access-token";
  assert.throws(
    () => readHomeWorldLaunchConfig({
      HOB_DATA_DIR: "/tmp/hob-agent-keychain-scope-test",
      HOB_BRIDGES: JSON.stringify([{
        bridgeId: "ha-main",
        adapterType: "home-assistant",
        config: { baseUrl: "http://ha.local:8123", authenticationPrincipal: "owner-a" },
        credentialRefs: { "access-token": unsafe },
      }]),
    }, { read: async () => "must-not-read" }),
    (error: unknown) => error instanceof Error
      && error.message.includes("credentialRef")
      && !error.message.includes(unsafe),
  );
});

test("accepts only an explicit absolute household context directory", () => {
  const config = readHomeHubLaunchConfig({
    ...BASE_ENV,
    HOB_HOME_DIR: "/Users/example/private-home",
  });
  assert.equal(config.householdDirectory, "/Users/example/private-home");
  assert.throws(
    () => readHomeHubLaunchConfig({ ...BASE_ENV, HOB_HOME_DIR: "home-template" }),
    /HOB_HOME_DIR/,
  );
});

test("enables only an explicit bounded observation schedule", () => {
  const config = readHomeHubLaunchConfig({
    ...BASE_ENV,
    HOB_OBSERVATION_INTERVAL_MINUTES: "360",
    HOB_OBSERVE_ON_START: "true",
  });
  assert.deepEqual(config.observation, { intervalMinutes: 360, runOnStart: true });
  assert.equal(readHomeHubLaunchConfig(BASE_ENV).observation, undefined);
  assert.throws(() => readHomeHubLaunchConfig({ ...BASE_ENV, HOB_OBSERVE_ON_START: "true" }), /HOB_OBSERVATION/);
  assert.throws(() => readHomeHubLaunchConfig({ ...BASE_ENV, HOB_OBSERVATION_INTERVAL_MINUTES: "59" }), /HOB_OBSERVATION/);
});

test("does not require legacy Home Assistant URL or token variables when bridges are declared", async () => {
  const config = readHomeHubLaunchConfig({
    HOB_DATA_DIR: "/tmp/hob-agent-launch-test-empty",
    HOB_BRIDGES: JSON.stringify([{
      bridgeId: "bridge-empty-credential",
      adapterType: "synthetic",
      config: {},
      credentialRefs: {},
    }]),
    HOB_MODEL: "deepseek/deepseek-v4-flash",
    DEEPSEEK_API_KEY: "deepseek-secret",
  });

  assert.equal(config.bridges[0]?.bridgeId, "bridge-empty-credential");
  assert.equal(await config.bridgeCredentialSource.resolveForBridge("bridge-empty-credential", "token"), undefined);
  assert.equal(config.inboxHttp, undefined);
});

test("enables authenticated local Inbox delivery without retaining the raw token in launch config", () => {
  const inboxToken = "local-inbox-token-that-is-longer-than-32-chars";
  const config = readHomeHubLaunchConfig({
    ...BASE_ENV,
    HOB_INBOX_AUTH_TOKEN: inboxToken,
    HOB_INBOX_PORT: "9876",
    ...INBOX_PRINCIPAL_ENV,
  });
  const authorization = `Basic ${Buffer.from(`home:${inboxToken}`).toString("base64")}`;

  assert.equal(config.inboxHttp?.port, 9876);
  assert.equal(config.inboxHttp?.authenticate(authorization), true);
  assert.equal(config.inboxHttp?.authenticate(undefined), false);
  assert.deepEqual(config.inboxHttp?.principal, {
    principalId: "household-member",
    role: "adult_member",
    present: true,
    device: {
      kind: "private",
      boundPrincipalId: "household-member",
    },
  });
  assert.notEqual(config.inboxHttp?.principal?.role, "admin");
  assert.equal(JSON.stringify(config).includes(inboxToken), false);
});

test("requires explicit review identity inputs for authenticated Inbox HTTP", () => {
  const authenticated = {
    ...BASE_ENV,
    HOB_INBOX_AUTH_TOKEN: "i".repeat(32),
  };
  for (const name of Object.keys(INBOX_PRINCIPAL_ENV)) {
    const missing = { ...authenticated, ...INBOX_PRINCIPAL_ENV, [name]: undefined };
    assert.throws(
      () => readHomeHubLaunchConfig(missing),
      (error: unknown) => error instanceof Error && error.message.includes(name),
      `missing ${name} must fail closed`,
    );
  }

  for (const [name, value] of [
    ["HOB_INBOX_PRINCIPAL_ROLE", "owner"],
    ["HOB_INBOX_DEVICE_KIND", "personal"],
  ] as const) {
    assert.throws(
      () => readHomeHubLaunchConfig({ ...authenticated, ...INBOX_PRINCIPAL_ENV, [name]: value }),
      (error: unknown) => error instanceof Error && error.message.includes(name),
      `invalid ${name} must fail closed`,
    );
  }

  assert.throws(
    () => readHomeHubLaunchConfig({
      ...authenticated,
      ...INBOX_PRINCIPAL_ENV,
      HOB_INBOX_DEVICE_BOUND_PRINCIPAL_ID: "another-member",
    }),
    /HOB_INBOX_DEVICE_BOUND_PRINCIPAL_ID/,
  );
});

test("treats every Inbox identity setting as an explicit HTTP configuration", () => {
  assert.throws(
    () => readHomeHubLaunchConfig({ ...BASE_ENV, HOB_INBOX_PRINCIPAL_ID: "household-member" }),
    /HOB_INBOX_AUTH_TOKEN/,
  );
  assert.throws(
    () => readHomeHubLaunchConfig({
      ...BASE_ENV,
      HOB_INBOX_AUTH_TOKEN: "i".repeat(32),
      ...INBOX_PRINCIPAL_ENV,
      HOB_INBOX_DEVICE_KIND: "shared",
      HOB_INBOX_DEVICE_BOUND_PRINCIPAL_ID: "household-member",
    }),
    /shared.*binding|binding.*shared/i,
  );
});

test("accepts a shared review device without inventing a private binding", () => {
  const config = readHomeHubLaunchConfig({
    ...BASE_ENV,
    HOB_INBOX_AUTH_TOKEN: "i".repeat(32),
    HOB_INBOX_PRINCIPAL_ID: "shared-member",
    HOB_INBOX_PRINCIPAL_ROLE: "member",
    HOB_INBOX_DEVICE_KIND: "shared",
  });
  assert.deepEqual(config.inboxHttp?.principal, {
    principalId: "shared-member",
    role: "member",
    present: true,
    device: { kind: "shared" },
  });
});

test("fails closed for an invalid Inbox credential or production port without echoing secrets", () => {
  const short = "do-not-echo-short-token";
  assert.throws(
    () => readHomeHubLaunchConfig({ ...BASE_ENV, HOB_INBOX_AUTH_TOKEN: short }),
    (error: unknown) => error instanceof Error && !error.message.includes(short),
  );
  assert.throws(
    () => readHomeHubLaunchConfig({
      ...BASE_ENV,
      HOB_INBOX_AUTH_TOKEN: "local-inbox-token-that-is-longer-than-32-chars",
      HOB_INBOX_PORT: "0",
      ...INBOX_PRINCIPAL_ENV,
    }),
    /HOB_INBOX_PORT/,
  );
});

test("selects the corresponding standard model credential and never copies the provider allowlist", () => {
  const config = readHomeHubLaunchConfig({
    HOB_DATA_DIR: "/tmp/hob-agent-launch-test-deepseek",
    HOB_BRIDGES: BRIDGES,
    HOB_MODEL: "deepseek/deepseek-v4-flash",
    DEEPSEEK_API_KEY: "deepseek-secret",
    OPENAI_API_KEY: "must-not-enter-the-snapshot",
  });

  assert.equal(config.launchEnvironment.get("DEEPSEEK_API_KEY")?.value, "deepseek-secret");
  assert.equal(config.launchEnvironment.get("OPENAI_API_KEY"), undefined);
});

test("configures one explicit HTTPS OpenAI-compatible custom model route", () => {
  const config = readHomeHubLaunchConfig({
    HOB_DATA_DIR: "/tmp/hob-agent-launch-test-custom",
    HOB_BRIDGES: BRIDGES,
    HOB_HA_TOKEN: "home-assistant-secret",
    HOB_MODEL: "custom/deepseek-v4-flash-0731",
    HOB_MODEL_BASE_URL: "https://models.example.test:8443/v1/",
    HOB_CUSTOM_MODEL_API_KEY: "custom-secret",
    OPENAI_API_KEY: "must-not-enter-the-snapshot",
  });

  assert.deepEqual(config.agent, {
    provider: "custom",
    model: "deepseek-v4-flash-0731",
    baseURL: "https://models.example.test:8443/v1",
  });
  assert.equal(config.launchEnvironment.get("HOB_CUSTOM_MODEL_API_KEY")?.value, "custom-secret");
  assert.equal(config.launchEnvironment.get("OPENAI_API_KEY"), undefined);
});

test("requires a safe endpoint only for a custom model route", () => {
  assert.throws(() => readHomeHubLaunchConfig({
    ...BASE_ENV,
    HOB_MODEL: "custom/deepseek-v4-flash-0731",
    HOB_CUSTOM_MODEL_API_KEY: "custom-secret",
  }), /HOB_MODEL_BASE_URL/);
  assert.throws(() => readHomeHubLaunchConfig({
    ...BASE_ENV,
    HOB_MODEL_BASE_URL: "https://models.example.test/v1",
  }), /only valid.*custom/i);
  const unsafe = "https://user:secret@models.example.test/v1";
  assert.throws(
    () => readHomeHubLaunchConfig({
      ...BASE_ENV,
      HOB_MODEL: "custom/deepseek-v4-flash-0731",
      HOB_MODEL_BASE_URL: unsafe,
      HOB_CUSTOM_MODEL_API_KEY: "custom-secret",
    }),
    (error: unknown) => error instanceof Error
      && error.message.includes("HOB_MODEL_BASE_URL")
      && !error.message.includes("secret"),
  );
});

test("uses an explicit Keychain profile without requiring or snapshotting an environment API key", () => {
  const vault = { read: async () => "keychain-secret" };
  const profile = {
    id: "deepseek:primary",
    provider: "deepseek",
    kind: "api_key" as const,
    secretRef: "keychain:hob-agent/deepseek:primary",
  };
  const config = readHomeHubLaunchConfig({
    HOB_DATA_DIR: "/tmp/hob-agent-launch-test-keychain",
    HOB_BRIDGES: BRIDGES,
    HOB_HA_TOKEN: "home-assistant-secret",
    HOB_MODEL: "deepseek/deepseek-v4-flash",
  }, { profile, vault });

  assert.deepEqual(config.agent, {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    profile,
    vault,
  });
  assert.equal(config.launchEnvironment.get("DEEPSEEK_API_KEY"), undefined);
});

test("fails closed for missing or blank required neutral launch values without echoing values", () => {
  for (const name of ["HOB_DATA_DIR", "HOB_BRIDGES", "HOB_MODEL", "OPENAI_API_KEY"] as const) {
    const env = { ...BASE_ENV, [name]: "   " };
    assert.throws(
      () => readHomeHubLaunchConfig(env),
      (error: unknown) => error instanceof Error
        && error.message.includes(name)
        && !error.message.includes("secret")
        && !error.message.includes("   "),
    );
  }
});

test("rejects malformed bridges and secret-like config fields without echoing their values", () => {
  assert.throws(
    () => readHomeHubLaunchConfig({ ...BASE_ENV, HOB_BRIDGES: "not-json" }),
    /HOB_BRIDGES/,
  );
  assert.throws(
    () => readHomeHubLaunchConfig({
      ...BASE_ENV,
      HOB_BRIDGES: JSON.stringify([{
        bridgeId: "ha-main",
        adapterType: "home-assistant",
        config: { baseUrl: "http://ha.local:8123", accessToken: "home-assistant-secret" },
        credentialRefs: { "access-token": "HOB_HA_TOKEN" },
      }]),
    }),
    (error: unknown) => error instanceof Error
      && error.message.includes("Secret-like")
      && !error.message.includes("home-assistant-secret"),
  );
  const nestedApiKey = "must-never-enter-bridge-config";
  assert.throws(
    () => readHomeHubLaunchConfig({
      ...BASE_ENV,
      HOB_BRIDGES: JSON.stringify([{
        bridgeId: "future-bridge",
        adapterType: "synthetic",
        config: { endpoints: [{ apiKey: nestedApiKey }] },
        credentialRefs: {},
      }]),
    }),
    (error: unknown) => error instanceof Error
      && error.message.includes("Secret-like")
      && !error.message.includes(nestedApiKey),
  );
});

test("reads only the explicit launch allowlist before lazy bridge credential resolution", async () => {
  const reads: string[] = [];
  const environment = new Proxy({ ...BASE_ENV, UNRELATED_SECRET: "do-not-read" }, {
    get(target, property, receiver) {
      if (typeof property === "string") reads.push(property);
      return Reflect.get(target, property, receiver);
    },
  });

  const config = readHomeHubLaunchConfig(environment);

  assert.equal(reads.includes("UNRELATED_SECRET"), false);
  assert.deepEqual(reads.filter((name) => name !== "toJSON"), [
    "HOB_DATA_DIR",
    "HOB_BRIDGES",
    "HOB_MUSIC_ASSISTANT_BASE_URL",
    "HOB_MUSIC_ASSISTANT_CREDENTIAL_REF",
    "HOB_MUSIC_ASSISTANT_PLAYER_BINDINGS",
    "HOB_MODEL",
    "HOB_MODEL_BASE_URL",
    "OPENAI_API_KEY",
    "HOB_INBOX_AUTH_TOKEN",
    "HOB_INBOX_PORT",
    "HOB_INBOX_PRINCIPAL_ID",
    "HOB_INBOX_PRINCIPAL_ROLE",
    "HOB_INBOX_DEVICE_KIND",
    "HOB_INBOX_DEVICE_BOUND_PRINCIPAL_ID",
    "HOB_HOME_DIR",
    "HOB_OBSERVATION_INTERVAL_MINUTES",
    "HOB_OBSERVE_ON_START",
    "HOB_SAFETY_BINDINGS",
  ]);
  await config.bridgeCredentialSource.describeForBridge("ha-main", "access-token");
  assert.equal(reads.at(-1), "HOB_HA_TOKEN");
});
