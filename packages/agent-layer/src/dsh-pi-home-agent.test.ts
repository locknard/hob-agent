import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

import { mountDshPiHomeAgent } from "./dsh-pi-home-agent.js";

class StubHomeAssistantService extends Service {
  readonly snapshot = {
    states: [],
    entityRegistry: [],
    deviceRegistry: [],
    areaRegistry: [],
    health: { bridge: "up" as const, devices: {} },
  };

  constructor(ctx: Context) {
    super(ctx, "homeAssistant");
  }
}

test("mounts the official DSH pi-ai adapter for a product provider route", async () => {
  const ctx = new Context();
  await ctx.plugin(StubHomeAssistantService);

  const fiber = await mountDshPiHomeAgent(ctx, {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    sessionId: "home-provider-test",
  });

  assert.deepEqual(ctx.llm.listProviders().map((provider) => provider.id), ["deepseek"]);
  assert.equal(String(ctx.homeAgent.agent.id), "home-provider-test");
  assert.equal((await ctx.llm.listModels("deepseek")).some((model) => model.id === "deepseek-v4-flash"), true);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("bridges a selected API-key profile into the official DSH credential seam", async () => {
  const ctx = new Context();
  await ctx.plugin(StubHomeAssistantService);
  const reads: string[] = [];
  const fiber = await mountDshPiHomeAgent(ctx, {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    profile: {
      id: "deepseek:primary",
      provider: "deepseek",
      kind: "api_key",
      secretRef: "keychain:hob-agent/deepseek:primary",
    },
    vault: {
      read: async (reference) => {
        reads.push(reference);
        return "profile-key";
      },
    },
  });

  assert.equal((await ctx.credentials.resolve(credentialRef("DEEPSEEK_API_KEY")))?.value, "profile-key");
  assert.deepEqual(reads, ["keychain:hob-agent/deepseek:primary"]);

  await fiber.dispose();
  await ctx.fiber.dispose();
});
