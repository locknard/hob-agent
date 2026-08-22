import assert from "node:assert/strict";
import test from "node:test";

import { projectHomeMediaSearch } from "@hob-agent/agent-layer/home-media-tool";

import { MediaCatalog, type MediaCatalogKind } from "./media-catalog.js";

interface SearchCall {
  readonly query: string;
  readonly mediaTypes: readonly string[];
  readonly limit: number;
  readonly signal: AbortSignal;
}

interface MusicAssistantSearchClient {
  search(input: SearchCall): Promise<unknown>;
  dispose?(): void | Promise<void>;
}

interface ProviderRow {
  readonly providerItemId: string;
  readonly title: string;
  readonly kind: MediaCatalogKind;
  readonly playable: boolean;
  readonly creator?: string;
  readonly durationSeconds?: number;
}

interface MusicAssistantMediaProvider {
  readonly searchCoverage: "best_effort";
  search(input: {
    readonly query: string;
    readonly limit: number;
    readonly kinds: readonly MediaCatalogKind[];
    readonly signal: AbortSignal;
  }): Promise<readonly ProviderRow[]>;
  dispose(): Promise<void>;
}

interface ProviderModule {
  readonly MusicAssistantMediaCatalogProvider: new (
    client: MusicAssistantSearchClient,
  ) => MusicAssistantMediaProvider;
}

async function loadProviderModule(): Promise<ProviderModule> {
  try {
    const loaded = await import("./music-assistant-media-provider.js") as unknown as Partial<ProviderModule>;
    if (typeof loaded.MusicAssistantMediaCatalogProvider !== "function") {
      throw new Error("MusicAssistantMediaCatalogProvider export is missing");
    }
    return loaded as ProviderModule;
  } catch (error) {
    assert.fail(`Music Assistant media provider is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function mediaItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: "native-track-id",
    provider: "library",
    name: "Night Jazz",
    uri: "library://track/native-track-id",
    is_playable: true,
    media_type: "track",
    duration: 184,
    artists: [{ name: "House Trio", uri: "library://artist/private" }],
    provider_mappings: [{ provider_instance: "private-provider", item_id: "private-id" }],
    metadata: { images: [{ path: "https://private.invalid/art.jpg" }] },
    ...overrides,
  };
}

test("maps the reviewed Music Assistant search subset without leaking native payload fields", async () => {
  const { MusicAssistantMediaCatalogProvider } = await loadProviderModule();
  const calls: SearchCall[] = [];
  const provider = new MusicAssistantMediaCatalogProvider({
    async search(input) {
      calls.push(input);
      return {
        artists: [],
        albums: [],
        tracks: [mediaItem()],
        playlists: [],
        radio: [],
        podcasts: [],
        audiobooks: [],
        genres: [],
        future_native_bucket: [{ token: "must-not-cross" }],
      };
    },
  });
  const signal = new AbortController().signal;

  assert.equal(provider.searchCoverage, "best_effort");

  const rows = await provider.search({ query: "jazz", limit: 3, kinds: ["track"], signal });

  assert.deepEqual(calls, [{ query: "jazz", mediaTypes: ["track"], limit: 3, signal }]);
  assert.deepEqual(rows, [{
    providerItemId: "library://track/native-track-id",
    title: "Night Jazz",
    kind: "track",
    playable: true,
    creator: "House Trio",
    durationSeconds: 184,
  }]);
  assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), [
    "creator",
    "durationSeconds",
    "kind",
    "playable",
    "providerItemId",
    "title",
  ]);
  assert.equal(JSON.stringify(rows).includes("provider_mappings"), false);
  assert.equal(JSON.stringify(rows).includes("private-provider"), false);
  assert.equal(JSON.stringify(rows).includes("art.jpg"), false);
  assert.equal(JSON.stringify(rows).includes("must-not-cross"), false);
});

test("interleaves requested Music Assistant result groups and enforces one total limit", async () => {
  const { MusicAssistantMediaCatalogProvider } = await loadProviderModule();
  const provider = new MusicAssistantMediaCatalogProvider({
    async search() {
      return {
        artists: [mediaItem({ uri: "library://artist/1", name: "Jazz Artist", media_type: "artist", is_playable: false })],
        albums: [mediaItem({ uri: "library://album/1", name: "Jazz Album", media_type: "album" })],
        tracks: [
          mediaItem({ uri: "library://track/1", name: "Jazz Track One" }),
          mediaItem({ uri: "library://track/2", name: "Jazz Track Two" }),
        ],
        playlists: [],
        radio: [],
        podcasts: [],
        audiobooks: [],
        genres: [],
      };
    },
  });

  const rows = await provider.search({
    query: "jazz",
    limit: 3,
    kinds: ["artist", "album", "track"],
    signal: new AbortController().signal,
  });

  assert.deepEqual(rows.map((row) => [row.kind, row.title]), [
    ["artist", "Jazz Artist"],
    ["album", "Jazz Album"],
    ["track", "Jazz Track One"],
  ]);
});

test("uses explicit kind aliases and never invents unsupported Music Assistant search groups", async () => {
  const { MusicAssistantMediaCatalogProvider } = await loadProviderModule();
  const calls: SearchCall[] = [];
  const provider = new MusicAssistantMediaCatalogProvider({
    async search(input) {
      calls.push(input);
      return {
        tracks: [mediaItem({ media_type: "folder", uri: "provider://folder/private" })],
        podcast_episodes: [mediaItem({ media_type: "podcast_episode", uri: "library://podcast_episode/1" })],
      };
    },
  });

  const unsupportedOnly = await provider.search({
    query: "episode",
    limit: 2,
    kinds: ["episode"],
    signal: new AbortController().signal,
  });
  const mismatched = await provider.search({
    query: "folder",
    limit: 2,
    kinds: ["track"],
    signal: new AbortController().signal,
  });

  assert.deepEqual(unsupportedOnly, []);
  assert.deepEqual(mismatched, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.mediaTypes, ["track"]);
});

test("fails closed on invalid configuration, oversized groups, and cancellation", async () => {
  const { MusicAssistantMediaCatalogProvider } = await loadProviderModule();
  assert.throws(() => new MusicAssistantMediaCatalogProvider({ search: undefined } as never));

  const oversized = new MusicAssistantMediaCatalogProvider({
    async search() {
      return { tracks: Array.from({ length: 101 }, () => mediaItem()) };
    },
  });
  await assert.rejects(() => oversized.search({
    query: "jazz",
    limit: 1,
    kinds: ["track"],
    signal: new AbortController().signal,
  }), /result/i);

  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let called = false;
  const cancelled = new MusicAssistantMediaCatalogProvider({
    async search() {
      called = true;
      return {};
    },
  });
  await assert.rejects(() => cancelled.search({
    query: "jazz",
    limit: 1,
    kinds: ["track"],
    signal: controller.signal,
  }), /cancelled/i);
  assert.equal(called, false);
});

test("forwards in-flight cancellation and releases its injected Music Assistant client", async () => {
  const { MusicAssistantMediaCatalogProvider } = await loadProviderModule();
  let finish: ((value: unknown) => void) | undefined;
  let disposeCalls = 0;
  const provider = new MusicAssistantMediaCatalogProvider({
    search: () => new Promise((resolve) => {
      finish = resolve;
    }),
    dispose: () => {
      disposeCalls += 1;
    },
  });
  const controller = new AbortController();
  const pending = provider.search({
    query: "jazz",
    limit: 1,
    kinds: ["track"],
    signal: controller.signal,
  });
  controller.abort(new Error("cancelled in flight"));
  finish?.({ tracks: [mediaItem()] });

  await assert.rejects(() => pending, /cancelled in flight/i);
  await provider.dispose();
  await provider.dispose();
  assert.equal(disposeCalls, 1);
  await assert.rejects(() => provider.search({
    query: "jazz",
    limit: 1,
    kinds: ["track"],
    signal: new AbortController().signal,
  }), /disposed/i);
});

test("keeps Music Assistant native data private through MediaCatalog and the DSH tool", async () => {
  const { MusicAssistantMediaCatalogProvider } = await loadProviderModule();
  const provider = new MusicAssistantMediaCatalogProvider({
    async search() {
      return {
        tracks: [mediaItem()],
      };
    },
  });
  const catalog = new MediaCatalog({
    tenantId: "household-test",
    catalogId: "music-assistant-test",
    generation: 1,
    sourceLabel: "家庭音乐库",
    mediaRefTtlMs: 60_000,
    maxQueryChars: 128,
    maxResults: 3,
    provider,
    now: () => 1_000,
    mediaRefFactory: () => "opaqueMusicRef0001",
  });
  const searched = await catalog.search({
    query: "jazz",
    kinds: ["track"],
    limit: 1,
    signal: new AbortController().signal,
  });
  const projected = projectHomeMediaSearch(searched);
  const serialized = JSON.stringify(projected);

  assert.deepEqual(projected, {
    candidates: [{
      mediaRef: "opaqueMusicRef0001",
      title: "Night Jazz",
      kind: "track",
      sourceLabel: "家庭音乐库",
      playable: true,
      creator: "House Trio",
      durationSeconds: 184,
    }],
    coverage: "best_effort",
  });
  for (const forbidden of [
    "library://",
    "native-track-id",
    "private-provider",
    "private-id",
    "art.jpg",
  ]) assert.equal(serialized.includes(forbidden), false, `DSH media output leaked ${forbidden}`);
});
