import { randomUUID } from "node:crypto";

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

export interface HomeMediaPlayerServiceOptions {
  readonly now?: () => number;
  readonly readCutFactory?: () => string;
  readonly readCutTtlMs?: number;
  readonly maxReadCuts?: number;
}

export interface HomeMediaPlayerReadCut {
  readonly readCut: string;
  readonly inventory: MediaPlayerInventory;
}

interface StoredMediaPlayerReadCut extends HomeMediaPlayerReadCut {
  readonly hwSpaceIdsKey: string;
  readonly expiresAt: number;
  readonly expectedAfterHwCapabilityId?: string;
}

const opaqueReadCut = /^[A-Za-z0-9_-]{16,256}$/;
const safeSpaceId = /^[^\u0000-\u001F\u007F]{1,256}$/u;
const DEFAULT_READ_CUT_TTL_MS = 30_000;
const DEFAULT_MAX_READ_CUTS = 8;
const MAX_READ_CUT_TTL_MS = 300_000;
const MAX_READ_CUTS = 32;
const MAX_READ_CUT_BYTES = 262_144;
const MAX_MEDIA_PLAYERS = 200;
const MAX_ISSUE_ATTEMPTS = 8;

/** Hub-owned, read-only projection of neutral media-player state. */
export class HomeMediaPlayerService extends Service {
  static inject = ["homeWorld"];

  readonly snapshot: (input: {
    readonly readCut?: string;
    readonly hwSpaceIds?: readonly string[];
    readonly afterHwCapabilityId?: string;
    readonly signal: AbortSignal;
  }) => HomeMediaPlayerReadCut;
  readonly advance: (readCut: string, nextAfterHwCapabilityId: string) => void;
  readonly release: (readCut: string) => void;

  private readonly now: () => number;
  private readonly readCutFactory: () => string;
  private readonly readCutTtlMs: number;
  private readonly maxReadCuts: number;

  constructor(ctx: Context, options: HomeMediaPlayerServiceOptions = {}) {
    super(ctx, "homeMediaPlayers");
    const readCutTtlMs = options.readCutTtlMs ?? DEFAULT_READ_CUT_TTL_MS;
    const maxReadCuts = options.maxReadCuts ?? DEFAULT_MAX_READ_CUTS;
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("Media-player read-cut clock is invalid");
    }
    if (options.readCutFactory !== undefined && typeof options.readCutFactory !== "function") {
      throw new TypeError("Media-player read-cut factory is invalid");
    }
    if (!Number.isSafeInteger(readCutTtlMs) || readCutTtlMs < 1 || readCutTtlMs > MAX_READ_CUT_TTL_MS) {
      throw new TypeError("Media-player read-cut TTL is invalid");
    }
    if (!Number.isSafeInteger(maxReadCuts) || maxReadCuts < 1 || maxReadCuts > MAX_READ_CUTS) {
      throw new TypeError("Media-player read-cut capacity is invalid");
    }
    this.now = options.now ?? Date.now;
    this.readCutFactory = options.readCutFactory ?? (() => randomUUID().replaceAll("-", ""));
    this.readCutTtlMs = readCutTtlMs;
    this.maxReadCuts = maxReadCuts;
    const readCuts = new Map<string, StoredMediaPlayerReadCut>();
    this.snapshot = (input) => this.takeSnapshot(input, readCuts);
    this.advance = (readCut, nextAfterHwCapabilityId) => {
      this.advanceReadCut(readCut, nextAfterHwCapabilityId, readCuts);
    };
    this.release = (readCut) => {
      if (typeof readCut === "string" && opaqueReadCut.test(readCut)) readCuts.delete(readCut);
    };
    this.ctx.effect(() => () => readCuts.clear(), "home-media-players.stop");
  }

  private takeSnapshot(input: {
    readonly readCut?: string;
    readonly hwSpaceIds?: readonly string[];
    readonly afterHwCapabilityId?: string;
    readonly signal: AbortSignal;
  }, readCuts: Map<string, StoredMediaPlayerReadCut>): HomeMediaPlayerReadCut {
    if (!input || !(input.signal instanceof AbortSignal)) {
      throw new TypeError("Media-player read-cut request is invalid");
    }
    input.signal.throwIfAborted();
    const now = this.timestamp();
    this.prune(now, readCuts);
    const hwSpaceIdsKey = canonicalSpaceIds(input.hwSpaceIds);
    const afterHwCapabilityId = optionalBoundedId(input.afterHwCapabilityId);
    if (input.readCut !== undefined) {
      if (typeof input.readCut !== "string" || !opaqueReadCut.test(input.readCut)) throw readCutUnavailable();
      const stored = readCuts.get(input.readCut);
      if (stored === undefined
        || stored.hwSpaceIdsKey !== hwSpaceIdsKey
        || stored.expectedAfterHwCapabilityId === undefined
        || stored.expectedAfterHwCapabilityId !== afterHwCapabilityId) {
        throw readCutUnavailable();
      }
      input.signal.throwIfAborted();
      readCuts.set(stored.readCut, Object.freeze({
        readCut: stored.readCut,
        inventory: stored.inventory,
        hwSpaceIdsKey: stored.hwSpaceIdsKey,
        expiresAt: stored.expiresAt,
      }));
      return Object.freeze({ readCut: stored.readCut, inventory: stored.inventory });
    }
    if (afterHwCapabilityId !== undefined) throw readCutUnavailable();
    if (readCuts.size >= this.maxReadCuts) throw readCutUnavailable();
    const world = (this.ctx as HomeMediaPlayerContext).homeWorld;
    const inventory = projectMediaPlayerInventory(world.snapshot.call(world));
    input.signal.throwIfAborted();
    if (inventory.players.length > MAX_MEDIA_PLAYERS
      || new TextEncoder().encode(JSON.stringify(inventory)).byteLength > MAX_READ_CUT_BYTES) {
      throw readCutUnavailable();
    }
    const readCut = this.issueReadCut(readCuts);
    const expiresAt = now + this.readCutTtlMs;
    if (!Number.isSafeInteger(expiresAt)) throw readCutUnavailable();
    const stored = Object.freeze({
      readCut,
      inventory,
      hwSpaceIdsKey,
      expiresAt,
    });
    readCuts.set(readCut, stored);
    return Object.freeze({ readCut, inventory });
  }

  private advanceReadCut(
    readCut: string,
    nextAfterHwCapabilityId: string,
    readCuts: Map<string, StoredMediaPlayerReadCut>,
  ): void {
    if (typeof readCut !== "string" || !opaqueReadCut.test(readCut)) throw readCutUnavailable();
    const nextAfter = optionalBoundedId(nextAfterHwCapabilityId);
    if (nextAfter === undefined) throw readCutUnavailable();
    const now = this.timestamp();
    this.prune(now, readCuts);
    const stored = readCuts.get(readCut);
    if (stored === undefined
      || stored.expectedAfterHwCapabilityId !== undefined
      || !stored.inventory.players.some((player) => player.hwCapabilityId === nextAfter)) {
      throw readCutUnavailable();
    }
    readCuts.set(readCut, Object.freeze({
      ...stored,
      expectedAfterHwCapabilityId: nextAfter,
    }));
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw readCutUnavailable();
    return value;
  }

  private prune(now: number, readCuts: Map<string, StoredMediaPlayerReadCut>): void {
    for (const [readCut, stored] of readCuts) {
      if (stored.expiresAt <= now) readCuts.delete(readCut);
    }
  }

  private issueReadCut(readCuts: ReadonlyMap<string, StoredMediaPlayerReadCut>): string {
    for (let attempt = 0; attempt < MAX_ISSUE_ATTEMPTS; attempt += 1) {
      let candidate: unknown;
      try {
        candidate = this.readCutFactory();
      } catch {
        throw readCutUnavailable();
      }
      if (typeof candidate === "string" && opaqueReadCut.test(candidate) && !readCuts.has(candidate)) {
        return candidate;
      }
    }
    throw readCutUnavailable();
  }
}

function canonicalSpaceIds(value: readonly string[] | undefined): string {
  if (value === undefined) return "";
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > 20
    || value.some((id) => typeof id !== "string" || !safeSpaceId.test(id))
    || new Set(value).size !== value.length) {
    throw new TypeError("Media-player space filter is invalid");
  }
  return [...new Set(value)].sort((left, right) => left.localeCompare(right)).join("\u0000");
}

function optionalBoundedId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !safeSpaceId.test(value)) throw readCutUnavailable();
  return value;
}

function readCutUnavailable(): Error {
  return new Error("Media-player read cut is unavailable; restart from the first page");
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
