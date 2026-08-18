import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";
import { assembleContextFor } from "@deepseek-ai/dsh-agent";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { renderContextSnapshot, renderPrompt } from "@deepseek-ai/dsh-system-prompt";

import { mountDshHomeAgent } from "./dsh-home-agent-composition.js";

class StubWorldService extends Service {
  readonly snapshot = { devices: [], bridgeWatermarks: [], diagnostics: [] };

  constructor(ctx: Context) {
    super(ctx, "homeWorld");
  }
}

class StubProposalService extends Service {
  constructor(ctx: Context) {
    super(ctx, "homeProposals");
  }
}

test("mounts the official DSH pi-ai adapter for a product provider route", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorldService);
  await ctx.plugin(StubProposalService);

  const fiber = await mountDshHomeAgent(ctx, {
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
  await ctx.plugin(StubWorldService);
  await ctx.plugin(StubProposalService);
  const reads: string[] = [];
  const fiber = await mountDshHomeAgent(ctx, {
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

test("loads an explicit household directory into the official DSH prompt seam", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-composition-home-"));
  try {
    await writeFile(join(directory, "SOUL.md"), "Prefer understandable changes.");
    await writeFile(join(directory, "HOME.md"), "Quiet hours start at 22:00.");
    await writeFile(join(directory, "MEMORY.md"), "The household rejected proposal P1.");
    const ctx = new Context();
    await ctx.plugin(StubWorldService);
    await ctx.plugin(StubProposalService);
    const fiber = await mountDshHomeAgent(ctx, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "home-context-test",
      householdDirectory: directory,
    });
    const prompt = ctx.get("systemPrompt");
    assert.ok(prompt);
    const assembly = await prompt.assemble(assembleContextFor(ctx.homeAgent.agent));

    assert.match(renderPrompt(assembly), /Prefer understandable changes/);
    assert.match(renderContextSnapshot(assembly), /Quiet hours start at 22:00/);
    assert.match(renderContextSnapshot(assembly), /rejected proposal P1/);

    await fiber.dispose();
    await ctx.fiber.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
