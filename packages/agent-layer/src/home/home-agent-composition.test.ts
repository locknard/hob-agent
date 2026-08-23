import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";
import { assembleContextFor } from "@deepseek-ai/dsh-agent";
import { createUserMessage, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { renderContextSnapshot, renderPrompt } from "@deepseek-ai/dsh-system-prompt";

import { ModelProviderResolver, type ModelProviderGeneration } from "../model/model-provider-resolver.js";
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

test("uses the Hub-owned prepared resolver identity without creating another Agent or loop", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorldService);
  await ctx.plugin(StubProposalService);
  let disposed = 0;
  const resolver = new ModelProviderResolver(ctx, {
    createGeneration: async (): Promise<ModelProviderGeneration> => ({
      provider: "deepseek",
      model: "hub-selected-model",
      runtime: {
        resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
        stream: async function* (): AsyncIterable<StreamChunk> {
          yield { type: "finish", reason: { kind: "stop" } };
        },
      },
      dispose: async () => { disposed += 1; },
    }),
  });
  resolver.activate(await resolver.prepare({ provider: "deepseek", model: "hub-selected-model" }));

  const fiber = await mountDshHomeAgent(ctx, {
    provider: "deepseek",
    model: "ignored-by-injected-resolver",
    sessionId: "hub-owned-resolver",
    modelProviderResolver: resolver,
  });

  assert.equal(String(ctx.homeAgent.agent.id), "hub-owned-resolver");
  assert.deepEqual(ctx.llm.listProviders().map((provider) => provider.id), ["hob-home-active"]);
  assert.equal(JSON.stringify(ctx.homeAgent.agent.session.header).includes("hub-selected-model"), false);
  await fiber.dispose();
  assert.equal(disposed, 0);
  await resolver.dispose();
  assert.equal(disposed, 1);
  await ctx.fiber.dispose();
});

test("keeps the one Home Agent loop mounted while its injected resolver is degraded", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorldService);
  await ctx.plugin(StubProposalService);
  const resolver = new ModelProviderResolver(ctx, {
    createGeneration: async (): Promise<ModelProviderGeneration> => {
      throw new Error("not available during cold start");
    },
  });

  const fiber = await mountDshHomeAgent(ctx, {
    provider: "deepseek",
    model: "hub-owned-model",
    sessionId: "hub-owned-degraded-resolver",
    modelProviderResolver: resolver,
  });

  assert.equal(String(ctx.homeAgent.agent.id), "hub-owned-degraded-resolver");
  assert.deepEqual(ctx.homeAgent.modelStatus, { state: "degraded" });
  await fiber.dispose();
  await resolver.dispose();
  await ctx.fiber.dispose();
});

test("keeps pressure compaction on the turn's prior generation after a synchronous swap", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorldService);
  await ctx.plugin(StubProposalService);
  const calls: Array<{ generation: string; purpose: string | undefined }> = [];
  const metadataSignals: string[] = [];
  const disposed: string[] = [];
  let normalCalls = 0;
  const resolver = new ModelProviderResolver(ctx, {
    createGeneration: async (selected): Promise<ModelProviderGeneration> => ({
      provider: `physical-${selected.model}`,
      model: selected.model,
      runtime: {
        resolveModelInfo: async (provider, model, signal) => {
          if (signal !== undefined) metadataSignals.push(selected.model);
          return {
            provider,
            id: model,
            name: model,
            context: { contextWindow: 100 },
          };
        },
        stream: async function* (options): AsyncIterable<StreamChunk> {
          calls.push({ generation: selected.model, purpose: options.purpose });
          if (options.purpose === "compaction") {
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text: "Compact household checkpoint." };
            yield { type: "block-end", index: 0, block: { type: "text", text: "Compact household checkpoint." } };
            yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
            yield { type: "finish", reason: { kind: "stop" } };
            return;
          }
          normalCalls += 1;
          if (normalCalls === 1) {
            const argumentsJson = JSON.stringify({ limit: 1 });
            yield { type: "block-start", index: 0, blockType: "tool-call" };
            yield {
              type: "tool-call-delta",
              index: 0,
              id: "inventory-for-compaction",
              name: "get_home_inventory",
              argumentsDelta: argumentsJson,
            };
            yield {
              type: "block-end",
              index: 0,
              block: {
                type: "tool-call",
                id: "inventory-for-compaction",
                name: "get_home_inventory",
                arguments: argumentsJson,
              },
            };
            yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
            yield { type: "finish", reason: { kind: "tool-calls" } };
            return;
          }
          yield { type: "finish", reason: { kind: "stop" } };
        },
      },
      dispose: async () => { disposed.push(selected.model); },
    }),
  });
  resolver.activate(await resolver.prepare({ provider: "deepseek", model: "generation-one" }));
  const second = await resolver.prepare({ provider: "deepseek", model: "generation-two" });
  const fiber = await mountDshHomeAgent(ctx, {
    provider: "deepseek",
    model: "ignored-by-injected-resolver",
    sessionId: "compaction-generation-owner",
    modelProviderResolver: resolver,
  });
  let transition: ReturnType<ModelProviderResolver["activate"]> | undefined;
  const disposeSwap = ctx.on("session/event", (session, event) => {
    if (session !== ctx.homeAgent.agent.session || event.type !== "step/end" || transition !== undefined) return;
    transition = resolver.activate(second);
  }, { global: true });

  ctx.homeAgent.agent.followup(createUserMessage({
    content: [{ type: "text", text: "Inspect the home inventory and continue with a compact answer." }],
    source: { kind: "user" },
  }));
  await ctx.homeAgent.agent.whenIdle();
  disposeSwap();

  assert.ok(transition);
  await transition.drained;
  assert.equal(calls.some((call) => call.generation === "generation-one" && call.purpose === "compaction"), true);
  assert.equal(calls.some((call) => call.generation === "generation-two"), false);
  assert.equal(metadataSignals.includes("generation-one"), true);
  assert.deepEqual(disposed, ["generation-one"]);
  await fiber.dispose();
  await resolver.dispose();
  await ctx.fiber.dispose();
});

test("mounts the official DSH pi-ai adapter for a product provider route", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorldService);
  await ctx.plugin(StubProposalService);

  const fiber = await mountDshHomeAgent(ctx, {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    sessionId: "home-provider-test",
  });

  assert.deepEqual(ctx.llm.listProviders().map((provider) => provider.id), ["hob-home-active"]);
  assert.equal(String(ctx.homeAgent.agent.id), "home-provider-test");
  assert.deepEqual((await ctx.llm.listModels("hob-home-active")).map((model) => model.id), ["hob-home-active"]);
  assert.equal((await ctx.llm.resolveModelInfo("hob-home-active", "hob-home-active")).provider, "hob-home-active");

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("keeps selected API-key profile details outside the root DSH runtime", async () => {
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

  assert.equal(JSON.stringify(ctx.homeAgent.agent.session.header).includes("keychain:"), false);
  assert.equal(JSON.stringify(ctx.homeAgent.agent.session.header).includes("deepseek:primary"), false);
  assert.deepEqual(reads, []);

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

  assert.deepEqual(ctx.llm.listProviders().map((provider) => provider.id), ["hob-home-active"]);
  assert.deepEqual((await ctx.llm.listModels("hob-home-active")).map((model) => model.id), ["hob-home-active"]);
  assert.equal(JSON.stringify(ctx.homeAgent.agent.session.header).includes("models.example.test"), false);
  assert.equal(JSON.stringify(ctx.homeAgent.agent.session.header).includes("keychain:"), false);

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
      "list_home_proposals",
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
