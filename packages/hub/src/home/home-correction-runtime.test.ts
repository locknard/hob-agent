import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";

import { BridgeCatalog } from "../bridge/bridge-catalog.js";
import { createHomeAgentRuntime } from "../home-agent-runtime.js";

test("mounts the durable correction owner in the production HomeAgentRuntime composition", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-correction-runtime-"));
  const runtime = createHomeAgentRuntime({
    homeWorld: { catalog: new BridgeCatalog(), bridges: [], monitorIntervalMs: 0 },
    homeCorrections: {
      path: join(directory, "home-corrections.sqlite"),
      householdDirectory: directory,
    },
    launchEnvironment: createLaunchEnvironmentSnapshot([{
      source: "process",
      values: { DEEPSEEK_API_KEY: "test-provider-key" },
    }]),
    agent: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "home-correction-runtime-test",
    },
  });

  await runtime.start();
  assert.equal(runtime.context.homeCorrection.name, "homeCorrection");
  await runtime.stop();
  assert.equal(runtime.context.homeCorrection, undefined);
});
