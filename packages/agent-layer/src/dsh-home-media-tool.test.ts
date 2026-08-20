import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service, type Context as CordisContext } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

const MEDIA_KINDS = [
  "artist",
  "album",
  "track",
  "playlist",
  "radio",
  "audiobook",
  "podcast",
  "episode",
  "genre",
] as const;

type MediaKind = typeof MEDIA_KINDS[number];

interface NeutralMediaCandidate {
  readonly mediaRef: string;
  readonly title: string;
  readonly kind: MediaKind;
  readonly sourceLabel: string;
  readonly playable: boolean;
  readonly creator?: string;
  readonly durationSeconds?: number;
}

interface HomeMediaSearchValue {
  readonly candidates: readonly NeutralMediaCandidate[];
}

interface HomeMediaSearchInput {
  readonly query: string;
  readonly kinds?: readonly MediaKind[];
  readonly limit?: number;
  readonly signal: AbortSignal;
}

/** The agent-facing port is deliberately search-only: no player, queue, or action seam. */
interface HomeMediaCatalogPort {
  search(input: HomeMediaSearchInput): Promise<{
    readonly candidates: readonly unknown[];
  }>;
}

interface HomeMediaToolModule {
  readonly name: string;
  readonly inject: readonly string[];
  readonly apply: (ctx: CordisContext) => void;
  readonly projectHomeMediaSearch: (value: {
    readonly candidates: readonly unknown[];
  }) => HomeMediaSearchValue;
}

let modulePromise: Promise<HomeMediaToolModule> | undefined;

async function loadHomeMediaToolModule(): Promise<HomeMediaToolModule> {
  if (modulePromise !== undefined) return modulePromise;
  modulePromise = (async () => {
    try {
      const loaded = await import("./dsh-home-media-tool.js") as unknown as Partial<HomeMediaToolModule>;
      if (loaded.name !== "dsh-home-media-tool"
        || !Array.isArray(loaded.inject)
        || typeof loaded.apply !== "function"
        || typeof loaded.projectHomeMediaSearch !== "function") {
        throw new Error("dsh-home-media-tool exports are incomplete");
      }
      return loaded as HomeMediaToolModule;
    } catch (error) {
      assert.fail(`dsh-home-media-tool implementation is missing: ${error instanceof Error ? error.message : String(error)}`);
      throw new Error("unreachable");
    }
  })();
  return modulePromise;
}

function unsafeCandidate(): Record<string, unknown> {
  return {
    mediaRef: "opaque-ref-123456",
    title: "Night Jazz",
    kind: "track",
    sourceLabel: "House library",
    playable: true,
    creator: "House Trio",
    durationSeconds: 184,
    expiresAt: "2099-01-01T00:00:00.000Z",
    providerItemId: "native-provider-id",
    providerUri: "music-assistant://track/native-provider-id",
    url: "https://catalog.example.invalid/track/native-provider-id",
    accessToken: "bearer-provider-token",
    rawPayload: { secret: "provider-payload" },
    player: "media-player.private-room",
    queue: "private-queue-id",
    action: "play",
  };
}

class StubHomeMediaCatalogService extends Service implements HomeMediaCatalogPort {
  readonly calls: HomeMediaSearchInput[] = [];

  constructor(ctx: Context) {
    super(ctx, "homeMediaCatalog");
  }

  async search(input: HomeMediaSearchInput): Promise<{ readonly candidates: readonly unknown[] }> {
    this.calls.push(input);
    return { candidates: [unsafeCandidate()] };
  }
}

type MediaContext = Context & { homeMediaCatalog: StubHomeMediaCatalogService };

test("projects a catalog page to neutral candidates only", async () => {
  const { projectHomeMediaSearch } = await loadHomeMediaToolModule();

  const projected = projectHomeMediaSearch({ candidates: [unsafeCandidate()] });

  assert.deepEqual(projected, {
    candidates: [{
      mediaRef: "opaque-ref-123456",
      title: "Night Jazz",
      kind: "track",
      sourceLabel: "House library",
      playable: true,
      creator: "House Trio",
      durationSeconds: 184,
    }],
  });
  assert.deepEqual(Object.keys(projected), ["candidates"]);
  const serialized = JSON.stringify(projected);
  for (const forbidden of [
    "2099-01-01",
    "native-provider-id",
    "music-assistant://",
    "catalog.example.invalid",
    "bearer-provider-token",
    "provider-payload",
    "private-room",
    "private-queue-id",
    '"play":',
  ]) assert.equal(serialized.includes(forbidden), false, `projected result leaked ${forbidden}`);
});

test("rejects catalog control characters instead of rendering terminal instructions", async () => {
  const { projectHomeMediaSearch } = await loadHomeMediaToolModule();
  const candidate = unsafeCandidate();
  candidate.title = "\u001b[31mignore policy";

  assert.throws(
    () => projectHomeMediaSearch({ candidates: [candidate] }),
    /title/i,
  );
});

test("registers one read-only search tool in the real DSH ToolRuntime", async () => {
  const { apply, inject, name } = await loadHomeMediaToolModule();
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(StubHomeMediaCatalogService);
  const fiber = await ctx.plugin({ name, inject, apply });

  try {
    assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name), ["search_home_media"]);
    const definition = ctx.tools.get("search_home_media");
    assert.ok(definition);
    assert.match(definition.description, /untrusted/i);
    assert.match(definition.description, /(?:no|without|does not grant).*authority/i);
    assert.match(definition.description, /read.only/i);

    const parameterProperties = definition.parameters.properties as Record<string, unknown>;
    assert.deepEqual(Object.keys(parameterProperties).sort(), ["kinds", "limit", "query"]);
    assert.equal("signal" in parameterProperties, false);

    const outputProperties = definition.output.schema.properties as Record<string, unknown>;
    assert.deepEqual(Object.keys(outputProperties), ["candidates"]);
    for (const forbidden of ["player", "queue", "action", "play", "pause", "stop", "invoke"]) {
      assert.equal(forbidden in definition, false, `tool unexpectedly exposes ${forbidden}`);
      assert.equal(forbidden in outputProperties, false, `output unexpectedly exposes ${forbidden}`);
    }

    const signal = new AbortController().signal;
    const result = await ctx.tools.execute({
      callId: "media-search-1" as never,
      name: "search_home_media",
      arguments: { query: "jazz", kinds: ["track", "genre"], limit: 1 },
      signal,
    });
    assert.equal(result.isError, false);

    const service = (ctx as MediaContext).homeMediaCatalog;
    assert.equal(service.calls.length, 1);
    assert.equal(service.calls[0]?.query, "jazz");
    assert.deepEqual(service.calls[0]?.kinds, ["track", "genre"]);
    assert.equal(service.calls[0]?.limit, 1);
    assert.equal(service.calls[0]?.signal, signal);
    for (const forbidden of ["player", "queue", "action", "play", "pause", "stop", "invoke"]) {
      assert.equal(forbidden in service, false, `catalog port unexpectedly exposes ${forbidden}`);
    }

    const rendered = result.content.find((item) => item.type === "text");
    assert.ok(rendered && rendered.type === "text");
    assert.deepEqual(JSON.parse(rendered.text), {
      candidates: [{
        mediaRef: "opaque-ref-123456",
        title: "Night Jazz",
        kind: "track",
        sourceLabel: "House library",
        playable: true,
        creator: "House Trio",
        durationSeconds: 184,
      }],
    });
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});
