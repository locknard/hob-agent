import { Context, Service } from "@deepseek-ai/cordis";

import {
  MediaCatalog,
  type MediaCatalogKind,
  type MediaCatalogOptions,
  type MediaCatalogProvider,
  type MediaCatalogSearchResult,
} from "./media-catalog.js";
import {
  projectMediaPlayerInventory,
  type MediaPlayerInventory,
} from "./media-player-inventory.js";
import type { HomeWorldService } from "./home-world-service.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeMediaPlayers: HomeMediaPlayerService;
    homeMediaCatalog: HomeMediaCatalogService;
  }
}

type HomeMediaPlayerContext = Context & { homeWorld: HomeWorldService };

/** Hub-owned, read-only projection of neutral media-player state. */
export class HomeMediaPlayerService extends Service {
  static inject = ["homeWorld"];

  constructor(ctx: Context) {
    super(ctx, "homeMediaPlayers");
  }

  list(signal?: AbortSignal): MediaPlayerInventory {
    signal?.throwIfAborted();
    const world = (this.ctx as HomeMediaPlayerContext).homeWorld;
    return projectMediaPlayerInventory(world.snapshot.call(world));
  }
}

export interface DisposableMediaCatalogProvider extends MediaCatalogProvider {
  dispose?(): void | Promise<void>;
}

export interface HomeMediaCatalogServiceOptions extends Omit<MediaCatalogOptions, "provider"> {
  readonly provider: DisposableMediaCatalogProvider;
}

/** Search-only Cordis seam; native ref resolution remains inside Hub core. */
export class HomeMediaCatalogService extends Service {
  readonly search: (input: {
    readonly query: string;
    readonly limit?: number;
    readonly kinds?: readonly MediaCatalogKind[];
    readonly signal: AbortSignal;
  }) => Promise<MediaCatalogSearchResult>;

  constructor(ctx: Context, options: HomeMediaCatalogServiceOptions) {
    super(ctx, "homeMediaCatalog");
    const stopController = new AbortController();
    const provider = options.provider;
    const catalog = new MediaCatalog(options);
    this.search = (input) => {
      const signal = AbortSignal.any([input.signal, stopController.signal]);
      return catalog.search({
        query: input.query,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
        signal,
      });
    };
    this.ctx.effect(() => async () => {
      stopController.abort(new Error("Home media catalog stopped"));
      await provider.dispose?.();
    }, "home-media-catalog.stop");
  }
}

export interface SyntheticMediaCatalogRow {
  readonly providerItemId: string;
  readonly title: string;
  readonly kind: MediaCatalogKind;
  readonly playable: boolean;
  readonly creator?: string;
  readonly durationSeconds?: number;
}

/** Deterministic development/test provider. It is never mounted by default. */
export class SyntheticMediaCatalogProvider implements MediaCatalogProvider {
  readonly searchCoverage = "complete" as const;
  private readonly rows: readonly SyntheticMediaCatalogRow[];

  constructor(rows: readonly SyntheticMediaCatalogRow[]) {
    if (!Array.isArray(rows) || rows.length > 100) throw new TypeError("Synthetic media rows are invalid");
    this.rows = Object.freeze(rows.map(validateSyntheticRow));
  }

  async search(input: {
    readonly query: string;
    readonly limit: number;
    readonly kinds: readonly MediaCatalogKind[];
    readonly signal: AbortSignal;
  }): Promise<readonly unknown[]> {
    if (input.signal.aborted) throw input.signal.reason;
    const query = input.query.toLocaleLowerCase();
    const rows = this.rows.filter((row) => input.kinds.includes(row.kind)
      && `${row.title}\u0000${row.creator ?? ""}`.toLocaleLowerCase().includes(query))
      .slice(0, input.limit)
      .map((row) => ({ ...row }));
    if (input.signal.aborted) throw input.signal.reason;
    return rows;
  }
}

function validateSyntheticRow(value: SyntheticMediaCatalogRow): SyntheticMediaCatalogRow {
  if (!value || typeof value !== "object") throw new TypeError("Synthetic media row is invalid");
  const keys = Object.keys(value);
  const allowed = new Set(["providerItemId", "title", "kind", "playable", "creator", "durationSeconds"]);
  if (keys.some((key) => !allowed.has(key))) throw new TypeError("Synthetic media row has unknown fields");
  if (!boundedText(value.providerItemId, 512) || !boundedText(value.title, 256)) {
    throw new TypeError("Synthetic media row identity is invalid");
  }
  const kinds: readonly string[] = ["artist", "album", "track", "playlist", "radio", "audiobook", "podcast", "episode", "genre"];
  if (!kinds.includes(value.kind) || typeof value.playable !== "boolean") {
    throw new TypeError("Synthetic media row kind is invalid");
  }
  if (value.creator !== undefined && !boundedText(value.creator, 256)) {
    throw new TypeError("Synthetic media row creator is invalid");
  }
  if (value.durationSeconds !== undefined
    && (!Number.isSafeInteger(value.durationSeconds) || value.durationSeconds < 0 || value.durationSeconds > 2_678_400)) {
    throw new TypeError("Synthetic media row duration is invalid");
  }
  return Object.freeze({
    providerItemId: value.providerItemId,
    title: value.title,
    kind: value.kind,
    playable: value.playable,
    ...(value.creator === undefined ? {} : { creator: value.creator }),
    ...(value.durationSeconds === undefined ? {} : { durationSeconds: value.durationSeconds }),
  });
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001F\u007F]/u.test(value);
}
