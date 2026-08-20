import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

interface MediaServicesModule {
  readonly HomeMediaPlayerService: new (ctx: Context, options?: Record<string, unknown>) => Service & {
    snapshot(input: {
      readonly readCut?: string;
      readonly hwSpaceIds?: readonly string[];
      readonly afterHwCapabilityId?: string;
      readonly signal: AbortSignal;
    }): unknown;
    advance(readCut: string, nextAfterHwCapabilityId: string): void;
    release(readCut: string): void;
  };
  readonly HomeMediaCatalogService: new (ctx: Context, options: Record<string, unknown>) => Service & {
    search(input: Record<string, unknown>): Promise<unknown>;
  };
  readonly SyntheticMediaCatalogProvider: new (rows: readonly Record<string, unknown>[]) => {
    search(input: { readonly query: string; readonly kinds: readonly string[]; readonly limit: number; readonly signal: AbortSignal }): Promise<readonly unknown[]>;
  };
}

async function loadServices(): Promise<MediaServicesModule> {
  try {
    const loaded = await import("./home-media-services.js") as unknown as Partial<MediaServicesModule>;
    if (typeof loaded.HomeMediaPlayerService !== "function"
      || typeof loaded.HomeMediaCatalogService !== "function"
      || typeof loaded.SyntheticMediaCatalogProvider !== "function") {
      throw new Error("home media service exports are incomplete");
    }
    return loaded as MediaServicesModule;
  } catch (error) {
    assert.fail(`home media services are missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

class StubWorld extends Service {
  includeSecondPlayer = false;

  constructor(ctx: Context) {
    super(ctx, "homeWorld");
  }

  snapshot() {
    const binding = { bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "instance-a", hwSpaceId: "hws-a" };
    const devices: Record<string, unknown>[] = [{
      hwId: "hw-a",
      name: "房间音响",
      validity: "valid",
      capabilities: [{ hwCapabilityId: "hwc-a", hwId: "hw-a", semanticKind: "media", bindings: [binding] }],
      states: [{ nativeId: "native-a", nativeInstanceId: "instance-a", attrs: { state: "idle" } }],
    }];
    if (this.includeSecondPlayer) {
      const secondBinding = {
        bridgeId: "bridge-a",
        nativeId: "native-b",
        nativeInstanceId: "instance-b",
        hwSpaceId: "hws-a",
      };
      devices.push({
        hwId: "hw-b",
        name: "房间音响",
        validity: "valid",
        capabilities: [{ hwCapabilityId: "hwc-b", hwId: "hw-b", semanticKind: "media", bindings: [secondBinding] }],
        states: [{ nativeId: "native-b", nativeInstanceId: "instance-b", attrs: { state: "idle" } }],
      });
    }
    return {
      bridges: { "bridge-a": { metrics: { connection: "up" } } },
      spaces: [{ hwSpaceId: "hws-a", name: "多媒体室" }],
      devices,
    };
  }
}

test("keeps one Hub-owned media-player read cut stable while HomeWorld changes", async () => {
  const { HomeMediaPlayerService } = await loadServices();
  const ctx = new Context();
  await ctx.plugin(StubWorld);
  let cutSequence = 0;
  const fiber = await ctx.plugin(HomeMediaPlayerService, {
    now: () => 1_000,
    readCutFactory: () => `opaqueReadCut000${++cutSequence}`,
    readCutTtlMs: 60_000,
    maxReadCuts: 4,
  });
  try {
    const service = ctx.get("homeMediaPlayers") as unknown as {
      snapshot(input: {
        readonly readCut?: string;
        readonly hwSpaceIds?: readonly string[];
        readonly afterHwCapabilityId?: string;
        readonly signal: AbortSignal;
      }): {
        readonly readCut: string;
        readonly inventory: { readonly players: readonly Record<string, unknown>[] };
      };
      advance(readCut: string, nextAfterHwCapabilityId: string): void;
      release(readCut: string): void;
    };
    const first = service.snapshot({ signal: new AbortController().signal });
    assert.equal(first.readCut, "opaqueReadCut0001");
    assert.deepEqual(first.inventory, { players: [{
        hwCapabilityId: "hwc-a",
        hwId: "hw-a",
        spaces: [{ hwSpaceId: "hws-a", name: "多媒体室" }],
        displayLabel: "房间音响",
        availability: "available",
        playbackState: "idle",
        volume: { reported: false },
    }] });
    (ctx.get("homeWorld") as unknown as StubWorld).includeSecondPlayer = true;
    service.advance(first.readCut, "hwc-a");
    assert.throws(
      () => service.snapshot({ readCut: first.readCut, signal: new AbortController().signal }),
      /read cut/i,
    );
    assert.throws(
      () => service.snapshot({
        readCut: first.readCut,
        hwSpaceIds: ["hws-other"],
        afterHwCapabilityId: "hwc-a",
        signal: new AbortController().signal,
      }),
      /read cut/i,
    );
    const sameCut = service.snapshot({
      readCut: first.readCut,
      afterHwCapabilityId: "hwc-a",
      signal: new AbortController().signal,
    });
    assert.equal(sameCut.inventory.players.length, 1);
    const nextCut = service.snapshot({ signal: new AbortController().signal });
    assert.equal(nextCut.inventory.players.length, 2);
    service.release(first.readCut);
    assert.throws(
      () => service.snapshot({ readCut: first.readCut, signal: new AbortController().signal }),
      /read cut/i,
    );
    for (const forbidden of ["play", "pause", "queue", "invoke", "resolveMediaRef"]) {
      assert.equal(forbidden in service, false, `player inventory exposed ${forbidden}`);
    }
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("bounds active media-player read cuts and expires abandoned cuts", async () => {
  const { HomeMediaPlayerService } = await loadServices();
  const ctx = new Context();
  await ctx.plugin(StubWorld);
  let now = 1_000;
  let cutSequence = 0;
  const fiber = await ctx.plugin(HomeMediaPlayerService, {
    now: () => now,
    readCutFactory: () => `boundedReadCut00${++cutSequence}`,
    readCutTtlMs: 1_000,
    maxReadCuts: 1,
  });
  try {
    const service = ctx.get("homeMediaPlayers") as unknown as {
      snapshot(input: { readonly readCut?: string; readonly signal: AbortSignal }): { readonly readCut: string };
    };
    const first = service.snapshot({ signal: new AbortController().signal });
    assert.throws(
      () => service.snapshot({ signal: new AbortController().signal }),
      /read cut/i,
    );
    now = 2_000;
    const afterExpiry = service.snapshot({ signal: new AbortController().signal });
    assert.notEqual(afterExpiry.readCut, first.readCut);
    assert.throws(
      () => service.snapshot({ readCut: first.readCut, signal: new AbortController().signal }),
      /read cut/i,
    );
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("mounts an explicit synthetic catalog behind a search-only service", async () => {
  const { HomeMediaCatalogService, SyntheticMediaCatalogProvider } = await loadServices();
  const provider = new SyntheticMediaCatalogProvider([
    { providerItemId: "jazz-1", title: "晚间爵士", kind: "playlist", playable: true, creator: "家庭测试目录" },
    { providerItemId: "rock-1", title: "摇滚", kind: "playlist", playable: true },
  ]);
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeMediaCatalogService, {
    tenantId: "household-test",
    catalogId: "synthetic-test",
    generation: 1,
    sourceLabel: "Synthetic household library",
    mediaRefTtlMs: 60_000,
    maxQueryChars: 128,
    maxResults: 3,
    provider,
    now: () => 1_000,
    mediaRefFactory: () => "syntheticOpaqueRef001",
  });
  try {
    const service = ctx.get("homeMediaCatalog") as unknown as {
      search(input: Record<string, unknown>): Promise<{
        candidates: readonly Record<string, unknown>[];
        coverage: "complete" | "best_effort";
      }>;
    };
    const result = await service.search({
      query: "爵士",
      kinds: ["playlist"],
      limit: 3,
      signal: new AbortController().signal,
    });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.coverage, "complete");
    assert.deepEqual(
      Object.keys(result.candidates[0]!).sort(),
      ["creator", "expiresAt", "kind", "mediaRef", "playable", "sourceLabel", "title"],
    );
    for (const forbidden of [
      "play", "pause", "queue", "invoke", "resolveMediaRef", "providerItemId",
      "catalog", "provider", "stopController",
    ]) {
      assert.equal(forbidden in service, false, `catalog service exposed ${forbidden}`);
    }
    assert.equal(
      Reflect.ownKeys((ctx as unknown as { homeMediaCatalog: object }).homeMediaCatalog)
        .some((key) => typeof key === "symbol" && String(key).toLowerCase().includes("mediacatalog")),
      false,
      "catalog service exposed a reflective core/provider symbol",
    );
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("aborts an in-flight catalog search when its Cordis service is disposed", async () => {
  const { HomeMediaCatalogService } = await loadServices();
  let providerSignal: AbortSignal | undefined;
  let finish: (() => void) | undefined;
  const provider = {
    search(input: { readonly signal: AbortSignal }) {
      providerSignal = input.signal;
      return new Promise<readonly unknown[]>((resolve) => {
        finish = () => resolve([]);
      });
    },
  };
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeMediaCatalogService, {
    tenantId: "household-test",
    catalogId: "synthetic-test",
    generation: 1,
    sourceLabel: "Synthetic household library",
    mediaRefTtlMs: 60_000,
    maxQueryChars: 128,
    maxResults: 3,
    provider,
  });
  const service = ctx.get("homeMediaCatalog") as unknown as { search(input: Record<string, unknown>): Promise<unknown> };
  const pending = service.search({ query: "jazz", limit: 1, signal: new AbortController().signal });
  await fiber.dispose();
  assert.equal(providerSignal?.aborted, true);
  finish?.();
  await assert.rejects(() => pending, /search failed/i);
  await ctx.fiber.dispose();
});
