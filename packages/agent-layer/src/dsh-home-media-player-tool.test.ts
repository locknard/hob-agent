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
    query: {
      readonly readCut: string;
      readonly hwSpaceIds?: readonly string[];
      readonly limit?: number;
      readonly afterHwCapabilityId?: string;
    },
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
  readonly snapshots: Array<{
    readonly readCut?: string;
    readonly hwSpaceIds?: readonly string[];
    readonly signal: AbortSignal;
  }> = [];
  readonly releases: string[] = [];
  readonly advances: Array<{ readonly readCut: string; readonly nextAfterHwCapabilityId: string }> = [];

  constructor(ctx: Context) {
    super(ctx, "homeMediaPlayers");
  }

  snapshot(input: {
    readonly readCut?: string;
    readonly hwSpaceIds?: readonly string[];
    readonly signal: AbortSignal;
  }) {
    this.snapshots.push(input);
    const readCut = input.readCut ?? "opaquePlayerReadCut0001";
    if (readCut !== "opaquePlayerReadCut0001") throw new Error("read cut unavailable");
    return { readCut, inventory: { players: players() } };
  }

  release(readCut: string) {
    this.releases.push(readCut);
  }

  advance(readCut: string, nextAfterHwCapabilityId: string) {
    this.advances.push({ readCut, nextAfterHwCapabilityId });
  }
}

test("pages same-room player candidates without choosing between duplicate labels", async () => {
  const { pageHomeMediaPlayers } = await loadTool();

  assert.deepEqual(pageHomeMediaPlayers(
    { players: players() },
    { readCut: "opaquePlayerReadCut0001", hwSpaceIds: ["hws-media-room"], limit: 1 },
  ), {
    players: [players()[1]],
    readCut: "opaquePlayerReadCut0001",
    page: {
      limit: 1,
      returnedPlayers: 1,
      totalMatchedPlayers: 2,
      nextAfterHwCapabilityId: "hwc-media-room-a",
    },
  });
  assert.deepEqual(pageHomeMediaPlayers(
    { players: players() },
    {
      readCut: "opaquePlayerReadCut0001",
      hwSpaceIds: ["hws-media-room"],
      limit: 1,
      afterHwCapabilityId: "hwc-media-room-a",
    },
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
    () => pageHomeMediaPlayers(
      { players: [invalid as unknown as Player] },
      { readCut: "opaquePlayerReadCut0001" },
    ),
    /hwCapabilityId/i,
  );
});

test("rejects a cursor or duplicate identity that cannot identify one position in the cut", async () => {
  const { pageHomeMediaPlayers } = await loadTool();
  assert.throws(
    () => pageHomeMediaPlayers(
      { players: players() },
      { readCut: "opaquePlayerReadCut0001", afterHwCapabilityId: "hwc-missing" },
    ),
    /restart.*first page/i,
  );
  assert.throws(
    () => pageHomeMediaPlayers(
      { players: [players()[0], { ...players()[0] }] },
      { readCut: "opaquePlayerReadCut0001" },
    ),
    /identity/i,
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
    () => pageHomeMediaPlayers(
      { players: [huge] },
      { readCut: "opaquePlayerReadCut0001", limit: 1 },
    ),
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
      ["afterHwCapabilityId", "hwSpaceIds", "limit", "readCut"],
    );
    const signal = new AbortController().signal;
    const first = await ctx.tools.execute({
      callId: "media-players-1" as never,
      name: "get_home_media_players",
      arguments: { hwSpaceIds: ["hws-media-room"], limit: 1 },
      signal,
    });
    assert.equal(first.isError, false);
    const textBlock = first.content.find((block) => block.type === "text");
    assert.ok(textBlock && textBlock.type === "text");
    const firstPage = JSON.parse(textBlock.text) as {
      readonly readCut: string;
      readonly page: { readonly nextAfterHwCapabilityId: string };
    };
    assert.equal(firstPage.readCut, "opaquePlayerReadCut0001");
    assert.equal(firstPage.page.nextAfterHwCapabilityId, "hwc-media-room-a");
    const second = await ctx.tools.execute({
      callId: "media-players-2" as never,
      name: "get_home_media_players",
      arguments: {
        hwSpaceIds: ["hws-media-room"],
        limit: 1,
        afterHwCapabilityId: firstPage.page.nextAfterHwCapabilityId,
        readCut: firstPage.readCut,
      },
      signal,
    });
    assert.equal(second.isError, false);
    const secondBlock = second.content.find((block) => block.type === "text");
    assert.ok(secondBlock && secondBlock.type === "text");
    const finalPage = JSON.parse(secondBlock.text) as Record<string, unknown>;
    assert.equal("readCut" in finalPage, false);
    const service = (ctx as unknown as { homeMediaPlayers: StubMediaPlayers }).homeMediaPlayers;
    assert.equal(service.snapshots[0]?.signal, signal);
    assert.equal(service.snapshots[1]?.readCut, "opaquePlayerReadCut0001");
    assert.deepEqual(service.advances, [{
      readCut: "opaquePlayerReadCut0001",
      nextAfterHwCapabilityId: "hwc-media-room-a",
    }]);
    assert.deepEqual(service.releases, ["opaquePlayerReadCut0001"]);
    const text = `${textBlock.text}${secondBlock.text}`;
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

test("rejects dangling cursors or read cuts before reading the Hub service", async () => {
  const { apply, inject, name } = await loadTool();
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(StubMediaPlayers);
  const fiber = await ctx.plugin({ name, inject, apply });
  try {
    for (const arguments_ of [
      { afterHwCapabilityId: "hwc-media-room-a" },
      { readCut: "opaquePlayerReadCut0001" },
    ]) {
      const result = await ctx.tools.execute({
        callId: "invalid-media-page" as never,
        name: "get_home_media_players",
        arguments: arguments_,
        signal: new AbortController().signal,
      });
      assert.equal(result.isError, true);
    }
    assert.equal((ctx as unknown as { homeMediaPlayers: StubMediaPlayers }).homeMediaPlayers.snapshots.length, 0);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});
