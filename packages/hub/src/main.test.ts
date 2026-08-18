import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import {
  createHomeHubProcessOptions,
  main,
} from "./main.js";

const ENV = {
  HOB_HA_URL: "http://ha.local:8123",
  HOB_HA_TOKEN: "home-assistant-secret",
  HOB_MODEL: "gpt/gpt-5.4",
  OPENAI_API_KEY: "openai-secret",
};

test("builds executable process options from the allowlisted environment", () => {
  const options = createHomeHubProcessOptions(ENV);

  assert.deepEqual(options.runtime.homeAssistant, {
    baseUrl: "http://ha.local:8123",
    accessToken: "home-assistant-secret",
  });
  assert.deepEqual(options.runtime.agent, {
    provider: "gpt",
    model: "gpt-5.4",
  });
  assert.equal(options.runtime.launchEnvironment.get("OPENAI_API_KEY")?.value, "openai-secret");
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

test("main fails closed before creating a Cordis runtime when required env is missing", async () => {
  await assert.rejects(
    main({
      env: { ...ENV, HOB_HA_TOKEN: "" },
      createRuntime: async () => ({ context: new Context(), stop: async () => undefined }),
    }),
    /HOB_HA_TOKEN/,
  );
});
