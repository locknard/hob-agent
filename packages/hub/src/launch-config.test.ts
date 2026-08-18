import assert from "node:assert/strict";
import test from "node:test";

import { readHomeHubLaunchConfig } from "./launch-config.js";

const BASE_ENV = {
  HOB_HA_URL: "http://ha.local:8123",
  HOB_HA_TOKEN: "home-assistant-secret",
  HOB_MODEL: "gpt/gpt-5.4",
  OPENAI_API_KEY: "openai-secret",
  DEEPSEEK_API_KEY: "must-not-enter-the-snapshot",
};

test("reads a canonical model route and snapshots only the selected provider credential", () => {
  const config = readHomeHubLaunchConfig(BASE_ENV);

  assert.deepEqual(config.homeAssistant, {
    baseUrl: "http://ha.local:8123",
    accessToken: "home-assistant-secret",
  });
  assert.deepEqual(config.agent, {
    provider: "gpt",
    model: "gpt-5.4",
  });
  assert.deepEqual(config.launchEnvironment.get("OPENAI_API_KEY"), {
    value: "openai-secret",
    source: "process",
  });
  assert.equal(config.launchEnvironment.get("DEEPSEEK_API_KEY"), undefined);
  assert.equal(config.launchEnvironment.get("HOB_HA_TOKEN"), undefined);
});

test("selects the corresponding standard credential env without copying the provider allowlist", () => {
  const config = readHomeHubLaunchConfig({
    HOB_HA_URL: BASE_ENV.HOB_HA_URL,
    HOB_HA_TOKEN: BASE_ENV.HOB_HA_TOKEN,
    HOB_MODEL: "deepseek/deepseek-v4-flash",
    DEEPSEEK_API_KEY: "deepseek-secret",
    OPENAI_API_KEY: "must-not-enter-the-snapshot",
  });

  assert.equal(config.launchEnvironment.get("DEEPSEEK_API_KEY")?.value, "deepseek-secret");
  assert.equal(config.launchEnvironment.get("OPENAI_API_KEY"), undefined);
});

test("fails closed for missing or blank required launch values without echoing values", () => {
  for (const name of ["HOB_HA_URL", "HOB_HA_TOKEN", "HOB_MODEL", "OPENAI_API_KEY"] as const) {
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

test("rejects malformed model references without echoing the selected credential", () => {
  assert.throws(
    () => readHomeHubLaunchConfig({ ...BASE_ENV, HOB_MODEL: "openai/gpt-5.4" }),
    (error: unknown) => error instanceof Error
      && error.message.includes("HOB_MODEL")
      && !error.message.includes("openai-secret"),
  );
});

test("reads only the explicit launch allowlist from the supplied environment", () => {
  const reads: string[] = [];
  const environment = new Proxy({ ...BASE_ENV, UNRELATED_SECRET: "do-not-read" }, {
    get(target, property, receiver) {
      if (typeof property === "string") reads.push(property);
      return Reflect.get(target, property, receiver);
    },
  });

  readHomeHubLaunchConfig(environment);

  assert.equal(reads.includes("UNRELATED_SECRET"), false);
  assert.deepEqual(reads.filter((name) => name !== "toJSON"), [
    "HOB_HA_URL",
    "HOB_HA_TOKEN",
    "HOB_MODEL",
    "OPENAI_API_KEY",
  ]);
});
