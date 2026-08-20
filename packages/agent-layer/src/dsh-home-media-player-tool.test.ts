import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service, type Context as CordisContext } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

interface Player {
  readonly hwCapabilityId: string;
  readonly hwId: string;
  readonly spaces: readonly { readonly hwSpaceId: string; readonly name?: string }[];
  readonly displayLabel: string;
  readonly availability: "available" | "unavailable" | "unknown";
  readonly playbackState: "playing" | "paused" | "buffering" | "idle" | "stopped" | "unknown";
  readonly volume: { readonly reported: boolean; readonly level?: number };
}

interface ToolModule {
  readonly name: string;
  readonly inject: readonly string[];
  readonly apply: (ctx: CordisContext) => void;
  readonly pageHomeMediaPlayers: (
    value: { readonly players: readonly Player[] },
    query: { readonly hwSpaceIds?: readonly string[]; readonly limit?: number; readonly afterHwCapabilityId?: string },
  ) => unknown;
}

async function loadTool(): Promise<ToolModule> {
  try {
    const loaded = await import("./dsh-home-media-player-tool.js") as unknown as Partial<ToolModule>;
    if (loaded.name !== "dsh-home-media-player-tool"
      || !Array.isArray(loaded.inject)
      || typeof loaded.apply !== "function"
      || typeof loaded.pageHomeMediaPlayers !== "function") {
      throw new Error("media-player tool exports are incomplete");
    }
    return loaded as ToolModule;
  } catch (error) {
    assert.fail(`get_home_media_players implementation is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function players(): Player[] {
  return [
    {
      hwCapabilityId: "hwc-living-room",
      hwId: "hw-living-room",
      spaces: [{ hwSpaceId: "hws-living-room", name: "客厅" }],
      displayLabel: "客厅音响",
      availability: "available",
      playbackState: "playing",
      volume: { reported: true, level: 0.2 },
    },
    {
      hwCapabilityId: "hwc-media-room-a",
      hwId: "hw-media-room-a",
      spaces: [{ hwSpaceId: "hws-media-room", name: "多媒体室" }],
      displayLabel: "多媒体室",
      availability: "available",
      playbackState: "idle",
      volume: { reported: true, level: 0.15 },
    },
    {
      hwCapabilityId: "hwc-media-room-b",
      hwId: "hw-media-room-b",
      spaces: [{ hwSpaceId: "hws-media-room", name: "多媒体室" }],
      displayLabel: "多媒体室",
      availability: "available",
      playbackState: "idle",
      volume: { reported: true, level: 0.15 },
    },
  ];
}

class StubMediaPlayers extends Service {
  readonly signals: Array<AbortSignal | undefined> = [];

  constructor(ctx: Context) {
    super(ctx, "homeMediaPlayers");
  }

  list(signal?: AbortSignal) {
    this.signals.push(signal);
    return { players: players() };
  }
}

test("pages same-room player candidates without choosing between duplicate labels", async () => {
  const { pageHomeMediaPlayers } = await loadTool();

  assert.deepEqual(pageHomeMediaPlayers(
    { players: players() },
    { hwSpaceIds: ["hws-media-room"], limit: 1 },
  ), {
    players: [players()[1]],
    page: {
      limit: 1,
      returnedPlayers: 1,
      totalMatchedPlayers: 2,
      nextAfterHwCapabilityId: "hwc-media-room-a",
    },
  });
  assert.deepEqual(pageHomeMediaPlayers(
    { players: players() },
    { hwSpaceIds: ["hws-media-room"], limit: 1, afterHwCapabilityId: "hwc-media-room-a" },
  ), {
    players: [players()[2]],
    page: { limit: 1, returnedPlayers: 1, totalMatchedPlayers: 2 },
  });
});

test("rejects a player whose required neutral identity is missing", async () => {
  const { pageHomeMediaPlayers } = await loadTool();
  const invalid = { ...players()[0] } as unknown as Record<string, unknown>;
  delete invalid.hwCapabilityId;

  assert.throws(
    () => pageHomeMediaPlayers({ players: [invalid as unknown as Player] }, {}),
    /hwCapabilityId/i,
  );
});

test("fails closed when one player cannot fit the model-visible output budget", async () => {
  const { pageHomeMediaPlayers } = await loadTool();
  const huge = {
    ...players()[0],
    displayLabel: "音".repeat(512),
    spaces: Array.from({ length: 10 }, (_, index) => ({
      hwSpaceId: `${index}-${"s".repeat(250)}`,
      name: "房".repeat(512),
    })),
  };

  assert.throws(
    () => pageHomeMediaPlayers({ players: [huge] }, { limit: 1 }),
    /output budget/i,
  );
});

test("registers one bounded read-only player inventory tool", async () => {
  const { apply, inject, name } = await loadTool();
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(StubMediaPlayers);
  const fiber = await ctx.plugin({ name, inject, apply });
  try {
    assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name), ["get_home_media_players"]);
    const definition = ctx.tools.get("get_home_media_players");
    assert.ok(definition);
    assert.match(definition.description, /read.only/i);
    assert.match(definition.description, /untrusted/i);
    assert.match(definition.description, /(?:no|does not grant).*authority/i);
    assert.deepEqual(
      Object.keys(definition.parameters.properties as Record<string, unknown>).sort(),
      ["afterHwCapabilityId", "hwSpaceIds", "limit"],
    );
    const signal = new AbortController().signal;
    const result = await ctx.tools.execute({
      callId: "media-players-1" as never,
      name: "get_home_media_players",
      arguments: { hwSpaceIds: ["hws-media-room"], limit: 2 },
      signal,
    });
    assert.equal(result.isError, false);
    assert.equal((ctx as unknown as { homeMediaPlayers: StubMediaPlayers }).homeMediaPlayers.signals[0], signal);
    const textBlock = result.content.find((block) => block.type === "text");
    assert.ok(textBlock && textBlock.type === "text");
    const text = textBlock.text;
    assert.match(text, /hwc-media-room-a/);
    assert.match(text, /hwc-media-room-b/);
    for (const forbidden of ["nativeId", "nativeInstanceId", "service", "uri", "play_media", "invoke"]) {
      assert.equal(text.includes(forbidden), false, `tool leaked ${forbidden}`);
    }
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});
