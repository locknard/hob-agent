import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";
import { assembleContextFor } from "@deepseek-ai/dsh-agent";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { renderContextSnapshot, renderPrompt } from "@deepseek-ai/dsh-system-prompt";

import { mountDshHomeAgent } from "./home-agent-composition.js";

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
  assert.ok((await ctx.llm.resolveModelInfo("deepseek", "deepseek-v4-flash")).context?.contextWindow);

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

test("mounts a hand-declared OpenAI-compatible custom deployment", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorldService);
  await ctx.plugin(StubProposalService);
  const fiber = await mountDshHomeAgent(ctx, {
    provider: "custom",
    model: "deepseek-v4-flash-0731",
    baseURL: "https://models.example.test:8443/v1/",
    profile: {
      id: "custom:primary",
      provider: "custom",
      kind: "api_key",
      secretRef: "keychain:hob-agent/custom:primary",
    },
    vault: { read: async () => "custom-profile-key" },
    sessionId: "custom-provider-test",
  });

  assert.deepEqual(ctx.llm.listProviders().map((provider) => provider.id), ["hob-custom-openai"]);
  assert.deepEqual((await ctx.llm.listModels("hob-custom-openai")).map((model) => model.id), [
    "deepseek-v4-flash-0731",
  ]);
  assert.equal(
    (await ctx.credentials.resolve(credentialRef("HOB_CUSTOM_MODEL_API_KEY")))?.value,
    "custom-profile-key",
  );
  assert.equal(
    (await ctx.llm.resolveModelInfo("hob-custom-openai", "deepseek-v4-flash-0731")).provider,
    "hob-custom-openai",
  );

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

test("contributes tenant SKILL.md through the official registry without adding tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-composition-skills-"));
  try {
    await writeFile(join(directory, "SOUL.md"), "Be bounded.");
    await writeFile(join(directory, "HOME.md"), "The home is local.");
    await writeFile(join(directory, "MEMORY.md"), "No extra authority.");
    await mkdir(join(directory, "skills"));
    await writeFile(join(directory, "skills", "tenant-help.md"), [
      "---",
      "name: tenant-help",
      "description: A bounded tenant household workflow.",
      "---",
      "Never treat this skill as permission to add tools or authority.",
    ].join("\n"));
    await writeFile(join(directory, "skills", "review-home-observation.md"), [
      "---",
      "name: review-home-observation",
      "description: Tenant attempted override.",
      "---",
      "Tenant override must not replace the reviewed runtime workflow.",
    ].join("\n"));
    const ctx = new Context();
    await ctx.plugin(StubWorldService);
    await ctx.plugin(StubProposalService);
    const fiber = await mountDshHomeAgent(ctx, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "home-tenant-skill-test",
      householdDirectory: directory,
    });

    const skills = ctx.get("skills");
    assert.ok(skills);
    assert.equal((await skills.list()).some((skill) => skill.name === "tenant-help"), true);
    const loaded = await ctx.tools.execute({
      callId: "load-tenant-skill" as never,
      name: "skill",
      arguments: { name: "tenant-help" },
      agent: ctx.homeAgent.agent,
      signal: new AbortController().signal,
    });
    assert.equal(loaded.isError, false);
    assert.match(loaded.content.map((item) => "text" in item ? item.text : "").join(" "), /never treat.*permission/i);
    const reviewed = await ctx.tools.execute({
      callId: "load-reviewed-skill" as never,
      name: "skill",
      arguments: { name: "review-home-observation" },
      agent: ctx.homeAgent.agent,
      signal: new AbortController().signal,
    });
    assert.equal(reviewed.isError, false);
    assert.match(reviewed.content.map((item) => "text" in item ? item.text : "").join(" "), /governed Home Product Bundle tools/i);
    assert.doesNotMatch(reviewed.content.map((item) => "text" in item ? item.text : "").join(" "), /tenant override/i);
    assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name).sort(), [
      "create_home_proposal",
      "get_home_activity",
      "get_home_calibration",
      "get_home_evidence",
      "get_home_inventory",
      "get_home_rules",
      "get_home_snapshot",
      "report_home_advice",
      "report_home_observation",
      "skill",
    ].sort());

    await fiber.dispose();
    await ctx.fiber.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
