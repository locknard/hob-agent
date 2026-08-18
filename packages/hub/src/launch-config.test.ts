import assert from "node:assert/strict";
import test from "node:test";

import { readHomeHubLaunchConfig } from "./launch-config.js";

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
  assert.equal(config.sessionPath, "/tmp/hob-agent-launch-test/dsh-sessions.sqlite");
  assert.equal(JSON.stringify(config.bridges).includes("home-assistant-secret"), false);
  assert.deepEqual(config.agent, { provider: "gpt", model: "gpt-5.4" });
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
  });
  const authorization = `Basic ${Buffer.from(`home:${inboxToken}`).toString("base64")}`;

  assert.equal(config.inboxHttp?.port, 9876);
  assert.equal(config.inboxHttp?.authenticate(authorization), true);
  assert.equal(config.inboxHttp?.authenticate(undefined), false);
  assert.equal(JSON.stringify(config).includes(inboxToken), false);
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
    "HOB_MODEL",
    "OPENAI_API_KEY",
    "HOB_INBOX_AUTH_TOKEN",
    "HOB_INBOX_PORT",
  ]);
  await config.bridgeCredentialSource.describeForBridge("ha-main", "access-token");
  assert.equal(reads.at(-1), "HOB_HA_TOKEN");
});
