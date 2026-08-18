import assert from "node:assert/strict";
import test from "node:test";

import { createHomeHubProcessOptions } from "./main.js";
import { readHomeHubLaunchConfig } from "./launch-config.js";

const ENV = {
  HOB_DATA_DIR: "/tmp/hob-agent-data",
  HOB_BRIDGES: JSON.stringify([{
    bridgeId: "synthetic-main",
    adapterType: "synthetic",
    config: {},
    credentialRefs: {},
  }]),
  HOB_MODEL: "gpt/gpt-5.4",
  OPENAI_API_KEY: "openai-secret",
};

test("requires an explicit data directory and forwards durable hub paths", () => {
  const config = readHomeHubLaunchConfig(ENV);
  assert.equal(config.dataDirectory, ENV.HOB_DATA_DIR);

  const options = createHomeHubProcessOptions(ENV);
  assert.equal(options.runtime.homeWorld.journalDirectory, ENV.HOB_DATA_DIR);
  assert.equal(options.runtime.homeWorld.registryPath, "/tmp/hob-agent-data/bridge-registry.sqlite");
  assert.equal(options.runtime.homeWorld.worldModelPath, "/tmp/hob-agent-data/world-model.sqlite");
  assert.equal(options.runtime.agent.sessionPersistencePath, "/tmp/hob-agent-data/dsh-sessions.sqlite");
  assert.notEqual(options.runtime.homeWorld.journalDirectory, ":memory:");
  assert.notEqual(options.runtime.homeWorld.registryPath, ":memory:");
  assert.notEqual(options.runtime.homeWorld.worldModelPath, ":memory:");
  assert.notEqual(options.runtime.agent.sessionPersistencePath, ":memory:");
});

test("fails closed for blank or non-absolute data directories", () => {
  assert.throws(
    () => readHomeHubLaunchConfig({ ...ENV, HOB_DATA_DIR: "" }),
    /HOB_DATA_DIR/,
  );
  assert.throws(
    () => readHomeHubLaunchConfig({ ...ENV, HOB_DATA_DIR: "./.env" }),
    /HOB_DATA_DIR/,
  );
});

test("forwards an explicitly configured household directory only to the Agent composition", () => {
  const options = createHomeHubProcessOptions({
    ...ENV,
    HOB_HOME_DIR: "/tmp/hob-private-home",
  });

  assert.equal(options.runtime.agent.householdDirectory, "/tmp/hob-private-home");
  assert.equal(JSON.stringify(options.runtime.homeWorld).includes("hob-private-home"), false);
});
