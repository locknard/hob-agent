import assert from "node:assert/strict";
import test from "node:test";

type MediaKind =
  | "artist"
  | "album"
  | "track"
  | "playlist"
  | "radio"
  | "audiobook"
  | "podcast"
  | "episode"
  | "genre";

interface MediaCatalogCandidate {
  readonly mediaRef: string;
  readonly title: string;
  readonly kind: MediaKind;
  readonly sourceLabel: string;
  readonly playable: boolean;
  readonly creator?: string;
  readonly durationSeconds?: number;
  readonly expiresAt: string;
}

interface MediaCatalogSearchInput {
  readonly query: string;
  readonly limit?: number;
  readonly kinds?: readonly MediaKind[];
}

interface MediaCatalogSearchResult {
  readonly candidates: readonly MediaCatalogCandidate[];
}

interface MediaCatalogProvider {
  search(input: {
    readonly query: string;
    readonly limit: number;
    readonly kinds: readonly MediaKind[];
  }): Promise<readonly unknown[]>;
}

interface MediaCatalogOptions {
  readonly tenantId: string;
  readonly catalogId: string;
  readonly generation: number;
  readonly sourceLabel: string;
  readonly mediaRefTtlMs: number;
  readonly maxQueryChars: number;
  readonly maxResults: number;
  readonly now: () => number;
  readonly mediaRefFactory?: () => string;
  readonly provider: MediaCatalogProvider;
}

interface MediaCatalog {
  search(input: MediaCatalogSearchInput): Promise<MediaCatalogSearchResult>;
  resolveMediaRef(input: {
    readonly tenantId: string;
    readonly mediaRef: string;
    readonly now: number;
  }): MediaCatalogCandidate | undefined;
}

interface MediaCatalogModule {
  MediaCatalog: new (options: MediaCatalogOptions) => MediaCatalog;
}

interface Fixture {
  readonly catalog: MediaCatalog;
  readonly calls: {
    readonly query: string;
    readonly limit: number;
    readonly kinds: readonly MediaKind[];
  }[];
  setNow(value: number): void;
}

let modulePromise: Promise<MediaCatalogModule> | undefined;

async function loadMediaCatalogModule(): Promise<MediaCatalogModule> {
  if (modulePromise !== undefined) return modulePromise;
  modulePromise = (async () => {
    try {
      const loaded = await import("./media-catalog.js") as unknown as Partial<MediaCatalogModule>;
      if (typeof loaded.MediaCatalog !== "function") {
        throw new Error("MediaCatalog export is missing");
      }
      return loaded as MediaCatalogModule;
    } catch (error) {
      assert.fail(`mediaCatalog@1 implementation is missing: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  return modulePromise;
}

function providerRow(
  providerItemId: string,
  title: string,
): Record<string, unknown> {
  return {
    providerItemId,
    title,
    kind: "track",
    playable: true,
    creator: "House Trio",
    durationSeconds: 184,
  };
}

function unsafeProviderRow(): Record<string, unknown> {
  return {
    ...providerRow("secret-native-id", "Unsafe result"),
    url: "https://catalog.example.invalid/track/secret-native-id",
    accessToken: "bearer-provider-token",
    nativeEntityId: "media_player.private-room",
    rawPayload: { token: "raw-payload-token" },
  };
}

async function fixture(
  rows: readonly unknown[] = [providerRow("native-track-1", "Night Jazz")],
  overrides: Partial<Pick<MediaCatalogOptions, "tenantId" | "catalogId" | "generation" | "sourceLabel" | "mediaRefTtlMs" | "maxQueryChars" | "maxResults" | "mediaRefFactory">> = {},
): Promise<Fixture> {
  const { MediaCatalog } = await loadMediaCatalogModule();
  let now = 1_000;
  const calls: { query: string; limit: number; kinds: readonly MediaKind[] }[] = [];
  const catalog = new MediaCatalog({
    tenantId: "household-a",
    catalogId: "music-assistant-main",
    generation: 1,
    sourceLabel: "House library",
    mediaRefTtlMs: 1_000,
    maxQueryChars: 128,
    maxResults: 3,
    now: () => now,
    provider: {
      async search(input) {
        calls.push({ query: input.query, limit: input.limit, kinds: input.kinds });
        return rows;
      },
    },
    ...overrides,
  });
  return {
    catalog,
    calls,
    setNow(value: number): void {
      now = value;
    },
  };
}

test("bounds a mediaCatalog@1 query and limit before asking the provider", async () => {
  const { catalog, calls } = await fixture();

  await assert.rejects(
    () => catalog.search({ query: " ".repeat(129), limit: 1 }),
    /query/i,
  );
  await assert.rejects(
    () => catalog.search({ query: "jazz", limit: 0 }),
    /limit/i,
  );
  await assert.rejects(
    () => catalog.search({ query: "jazz", limit: 4 }),
    /limit/i,
  );
  await assert.rejects(
    () => catalog.search({ query: "jazz", limit: 1.5 }),
    /limit/i,
  );
  await assert.rejects(
    () => catalog.search({ query: "jazz", kinds: ["track", "track"] }),
    /kind/i,
  );

  assert.deepEqual(calls, []);
});

test("caps provider results and returns only bounded neutral candidate fields", async () => {
  const rows = [
    providerRow("native-track-1", "Night Jazz"),
    providerRow("native-track-2", "Morning Jazz"),
    providerRow("native-track-3", "Live Jazz"),
    providerRow("native-track-4", "Extra Jazz"),
  ];
  const { catalog, calls } = await fixture(rows);

  const result = await catalog.search({ query: "  jazz  ", limit: 3, kinds: ["track", "radio"] });

  assert.deepEqual(calls, [{ query: "jazz", limit: 3, kinds: ["track", "radio"] }]);
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(Object.keys(result.candidates[0]!).sort(), [
    "creator",
    "durationSeconds",
    "expiresAt",
    "kind",
    "mediaRef",
    "playable",
    "sourceLabel",
    "title",
  ]);
  assert.deepEqual(
    result.candidates.map(({ title, kind, sourceLabel, playable, creator, durationSeconds }) => ({
      title,
      kind,
      sourceLabel,
      playable,
      creator,
      durationSeconds,
    })),
    [
      { title: "Night Jazz", kind: "track", sourceLabel: "House library", playable: true, creator: "House Trio", durationSeconds: 184 },
      { title: "Morning Jazz", kind: "track", sourceLabel: "House library", playable: true, creator: "House Trio", durationSeconds: 184 },
      { title: "Live Jazz", kind: "track", sourceLabel: "House library", playable: true, creator: "House Trio", durationSeconds: 184 },
    ],
  );
});

test("uses the reviewed Music Assistant-compatible media kinds when no filter is supplied", async () => {
  const { catalog, calls } = await fixture();

  await catalog.search({ query: "jazz", limit: 1 });

  assert.deepEqual(calls[0]?.kinds, [
    "artist",
    "album",
    "track",
    "playlist",
    "radio",
    "audiobook",
    "podcast",
    "episode",
    "genre",
  ]);
});

test("rejects a provider page with URL, native, token, or raw payload fields", async () => {
  const { catalog } = await fixture([unsafeProviderRow()]);

  await assert.rejects(
    () => catalog.search({ query: "jazz", limit: 1 }),
    /provider result/i,
  );
});

test("issues opaque mediaRefs without encoding tenant, catalog, generation, or native identity", async () => {
  const { catalog } = await fixture();

  const result = await catalog.search({ query: "jazz", limit: 1 });
  const candidate = result.candidates[0];
  assert.ok(candidate);
  assert.equal(typeof candidate.mediaRef, "string");
  assert.ok(candidate.mediaRef.length >= 16 && candidate.mediaRef.length <= 256);
  assert.equal(candidate.mediaRef.includes("native-track-1"), false);
  assert.equal(candidate.mediaRef.includes("household-a"), false);
  assert.equal(candidate.mediaRef.includes("music-assistant-main"), false);
  assert.equal(/https?:\/\//iu.test(candidate.mediaRef), false);
  assert.equal(/[/:]/u.test(candidate.mediaRef), false);
  assert.equal(JSON.stringify(result).includes("providerItemId"), false);
});

test("binds mediaRefs to the tenant, catalog generation, and expiry", async () => {
  const { catalog, setNow } = await fixture();
  const result = await catalog.search({ query: "jazz", limit: 1 });
  const candidate = result.candidates[0];
  assert.ok(candidate);
  assert.equal(candidate.expiresAt, "1970-01-01T00:00:02.000Z");

  assert.deepEqual(
    catalog.resolveMediaRef({ tenantId: "household-a", mediaRef: candidate.mediaRef, now: 1_999 }),
    candidate,
  );
  assert.equal(
    catalog.resolveMediaRef({ tenantId: "household-b", mediaRef: candidate.mediaRef, now: 1_999 }),
    undefined,
  );
  assert.equal(
    catalog.resolveMediaRef({ tenantId: "household-a", mediaRef: "unknown-ref", now: 1_999 }),
    undefined,
  );

  const nextGeneration = await fixture([providerRow("native-track-1", "Night Jazz")], {
    generation: 2,
  });
  assert.equal(
    nextGeneration.catalog.resolveMediaRef({ tenantId: "household-a", mediaRef: candidate.mediaRef, now: 1_999 }),
    undefined,
  );

  setNow(2_000);
  assert.equal(
    catalog.resolveMediaRef({ tenantId: "household-a", mediaRef: candidate.mediaRef, now: 2_000 }),
    undefined,
  );
});

test("does not retain a partially issued ref when a later provider row is invalid", async () => {
  const refs = ["firstOpaqueRef0001", "secondOpaqueRef002"];
  const { catalog } = await fixture([
    providerRow("native-track-1", "Night Jazz"),
    unsafeProviderRow(),
  ], {
    mediaRefFactory: () => refs.shift() ?? "unusedOpaqueRef003",
  });

  await assert.rejects(
    () => catalog.search({ query: "jazz", limit: 2 }),
    /provider result/i,
  );
  assert.equal(catalog.resolveMediaRef({
    tenantId: "household-a",
    mediaRef: "firstOpaqueRef0001",
    now: 1_001,
  }), undefined);
});

test("prunes expired refs so an opaque value can be safely reissued", async () => {
  const fixedRef = "reusableOpaqueRef001";
  const { catalog, setNow } = await fixture(undefined, {
    mediaRefFactory: () => fixedRef,
  });

  const first = await catalog.search({ query: "jazz", limit: 1 });
  assert.equal(first.candidates[0]?.mediaRef, fixedRef);

  setNow(2_000);
  const second = await catalog.search({ query: "jazz", limit: 1 });
  assert.equal(second.candidates[0]?.mediaRef, fixedRef);
});

test("keeps mediaCatalog read-only and exposes no player-control surface", async () => {
  const { catalog, calls } = await fixture();

  await catalog.search({ query: "jazz", limit: 1 });

  for (const forbiddenMethod of ["play", "pause", "stop", "queue", "setVolume", "control", "invoke"]) {
    assert.equal(forbiddenMethod in catalog, false, `${forbiddenMethod} must not be part of mediaCatalog@1`);
  }
  assert.deepEqual(Object.keys(calls[0] ?? {}).sort(), ["kinds", "limit", "query"]);
  assert.equal(JSON.stringify(catalog).includes("media_player"), false);
});
