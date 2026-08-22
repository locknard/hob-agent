import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service, type Context as CordisContext } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

interface ToolModule {
  readonly name: string;
  readonly inject: readonly string[];
  readonly apply: (ctx: CordisContext) => void;
}

async function loadTool(): Promise<ToolModule> {
  try {
    const loaded = await import("./home-media-preparation-tool.js") as Partial<ToolModule>;
    if (loaded.name !== "dsh-home-media-preparation-tool"
      || !Array.isArray(loaded.inject)
      || typeof loaded.apply !== "function") throw new Error("media preparation tool exports are incomplete");
    return loaded as ToolModule;
  } catch (error) {
    assert.fail(`media preparation tool is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

class StubPreparation extends Service {
  readonly calls: unknown[] = [];
  result: unknown = {
    status: "requires_confirmation",
    intent: {
      kind: "play_media",
      playerHwCapabilityId: "hwc-media-room",
      mediaRef: "opaqueMusicRef0001",
      queueMode: "replace_and_play",
    },
    player: {
      hwCapabilityId: "hwc-media-room",
      displayLabel: "多媒体室音响",
      spaces: [{ hwSpaceId: "hws-media-room", name: "多媒体室" }],
      playbackState: "idle",
      volume: { reported: true, level: 0.2 },
    },
    media: {
      title: "晚间爵士",
      kind: "playlist",
      sourceLabel: "Music Assistant",
      playable: true,
    },
  };

  constructor(ctx: Context) { super(ctx, "homeMediaPlaybackPreparation"); }
  prepare(intent: unknown) { this.calls.push(intent); return this.result; }
}

test("registers one confirmation-only neutral media preparation tool", async () => {
  const { apply, inject, name } = await loadTool();
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(StubPreparation);
  const fiber = await ctx.plugin({ name, inject, apply });
  try {
    assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name), ["prepare_home_media_playback"]);
    const definition = ctx.tools.get("prepare_home_media_playback");
    assert.ok(definition);
    assert.match(definition.description, /requires.*confirmation/i);
    assert.match(definition.description, /does not.*(?:execute|play|control)/i);
    assert.match(definition.description, /untrusted/i);
    assert.deepEqual(
      Object.keys(definition.parameters.properties as Record<string, unknown>).sort(),
      ["mediaRef", "playerHwCapabilityId", "queueMode"],
    );

    const result = await ctx.tools.execute({
      callId: "prepare-media-1" as never,
      name: "prepare_home_media_playback",
      arguments: {
        playerHwCapabilityId: "hwc-media-room",
        mediaRef: "opaqueMusicRef0001",
        queueMode: "replace_and_play",
      },
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, false);
    assert.deepEqual(ctx.homeMediaPlaybackPreparation.calls, [{
      kind: "play_media",
      playerHwCapabilityId: "hwc-media-room",
      mediaRef: "opaqueMusicRef0001",
      queueMode: "replace_and_play",
    }]);
    const block = result.content.find((item) => item.type === "text");
    assert.ok(block && block.type === "text");
    const encoded = block.text;
    assert.match(encoded, /requires_confirmation/);
    for (const forbidden of ["nativeId", "nativeRoute", "service", "uri", "providerItemId", "token", "ticket", "applied", "success"]) {
      assert.equal(encoded.includes(forbidden), false, `tool leaked ${forbidden}`);
    }
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("rejects hidden authority fields and invalid queue modes before calling Hub", async () => {
  const { apply, inject, name } = await loadTool();
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(StubPreparation);
  const fiber = await ctx.plugin({ name, inject, apply });
  try {
    const service = ctx.homeMediaPlaybackPreparation;
    for (const argumentsValue of [
      { playerHwCapabilityId: "hwc-media-room", mediaRef: "opaqueMusicRef0001", queueMode: "play" },
      { playerHwCapabilityId: "hwc-media-room", mediaRef: "opaqueMusicRef0001", queueMode: "replace_and_play", volume: 0.8 },
      { playerHwCapabilityId: "hwc-media-room", mediaRef: "https://provider.invalid/jazz", queueMode: "replace_and_play" },
    ]) {
      const result = await ctx.tools.execute({
        callId: `prepare-invalid-${service.calls.length}` as never,
        name: "prepare_home_media_playback",
        arguments: argumentsValue,
        signal: new AbortController().signal,
      });
      assert.equal(result.isError, true, `accepted invalid arguments ${JSON.stringify(argumentsValue)}`);
    }
    assert.equal(service.calls.length, 0);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("preserves a closed blocked reason without inventing playback success", async () => {
  const { apply, inject, name } = await loadTool();
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(StubPreparation);
  ctx.homeMediaPlaybackPreparation.result = { status: "blocked", reason: "player_state_unknown" };
  const fiber = await ctx.plugin({ name, inject, apply });
  try {
    const result = await ctx.tools.execute({
      callId: "prepare-blocked" as never,
      name: "prepare_home_media_playback",
      arguments: {
        playerHwCapabilityId: "hwc-media-room",
        mediaRef: "opaqueMusicRef0001",
        queueMode: "play_next",
      },
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, false);
    const block = result.content.find((item) => item.type === "text");
    assert.ok(block && block.type === "text");
    assert.deepEqual(JSON.parse(block.text), { status: "blocked", reason: "player_state_unknown" });
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("rejects a prepared player that does not match the requested neutral intent", async () => {
  const { apply, inject, name } = await loadTool();
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(StubPreparation);
  const result = ctx.homeMediaPlaybackPreparation.result as {
    intent: { playerHwCapabilityId: string };
    player: { hwCapabilityId: string };
  };
  result.intent.playerHwCapabilityId = "hwc-different-room";
  result.player.hwCapabilityId = "hwc-different-room";
  const fiber = await ctx.plugin({ name, inject, apply });
  try {
    const execution = await ctx.tools.execute({
      callId: "prepare-mismatched-player" as never,
      name: "prepare_home_media_playback",
      arguments: {
        playerHwCapabilityId: "hwc-media-room",
        mediaRef: "opaqueMusicRef0001",
        queueMode: "replace_and_play",
      },
      signal: new AbortController().signal,
    });
    assert.equal(execution.isError, true);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});
