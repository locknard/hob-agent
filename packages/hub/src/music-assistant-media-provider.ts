import {
  MEDIA_CATALOG_KINDS,
  type MediaCatalogKind,
  type MediaCatalogProvider,
  type MediaCatalogProviderSearchInput,
} from "./media-catalog.js";

export interface MusicAssistantSearchClient {
  search(input: {
    readonly query: string;
    readonly mediaTypes: readonly string[];
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  dispose?(): void | Promise<void>;
}

export interface MusicAssistantMediaCatalogRow {
  readonly providerItemId: string;
  readonly title: string;
  readonly kind: MediaCatalogKind;
  readonly playable: boolean;
  readonly creator?: string;
  readonly durationSeconds?: number;
}

interface SearchGroup {
  readonly kind: Exclude<MediaCatalogKind, "episode">;
  readonly mediaType: string;
  readonly resultKey: string;
}

const SEARCH_GROUPS: Readonly<Record<Exclude<MediaCatalogKind, "episode">, SearchGroup>> = Object.freeze({
  artist: { kind: "artist", mediaType: "artist", resultKey: "artists" },
  album: { kind: "album", mediaType: "album", resultKey: "albums" },
  track: { kind: "track", mediaType: "track", resultKey: "tracks" },
  playlist: { kind: "playlist", mediaType: "playlist", resultKey: "playlists" },
  radio: { kind: "radio", mediaType: "radio", resultKey: "radio" },
  audiobook: { kind: "audiobook", mediaType: "audiobook", resultKey: "audiobooks" },
  podcast: { kind: "podcast", mediaType: "podcast", resultKey: "podcasts" },
  genre: { kind: "genre", mediaType: "genre", resultKey: "genres" },
});

const MAX_GROUP_ROWS = 100;
const MAX_DURATION_SECONDS = 2_678_400;

/**
 * Hub-private, read-only adapter for Music Assistant's grouped `music/search` result.
 *
 * This class performs no networking itself. The injected client owns transport and
 * credentials. MA identities remain in `providerItemId` until MediaCatalog replaces
 * them with tenant-bound opaque media references.
 */
export class MusicAssistantMediaCatalogProvider implements MediaCatalogProvider {
  readonly searchCoverage = "best_effort" as const;
  private readonly client: MusicAssistantSearchClient;
  private disposed = false;

  constructor(client: MusicAssistantSearchClient) {
    if (!client || typeof client.search !== "function") {
      throw new TypeError("Music Assistant search client is invalid");
    }
    if (client.dispose !== undefined && typeof client.dispose !== "function") {
      throw new TypeError("Music Assistant search client disposal is invalid");
    }
    this.client = client;
  }

  async search(input: MediaCatalogProviderSearchInput): Promise<readonly MusicAssistantMediaCatalogRow[]> {
    if (this.disposed) throw new Error("Music Assistant media provider is disposed");
    validateInput(input);
    input.signal.throwIfAborted();
    const groups = reviewedGroups(input.kinds);
    if (groups.length === 0) return Object.freeze([]);

    const raw = await this.client.search({
      query: input.query,
      mediaTypes: Object.freeze(groups.map((group) => group.mediaType)),
      limit: input.limit,
      signal: input.signal,
    });
    input.signal.throwIfAborted();
    if (!isRecord(raw)) throw new TypeError("Music Assistant search result is invalid");

    const rowsByGroup = groups.map((group) => {
      const value = raw[group.resultKey];
      if (value === undefined) return Object.freeze([]) as readonly MusicAssistantMediaCatalogRow[];
      if (!Array.isArray(value) || value.length > MAX_GROUP_ROWS) {
        throw new TypeError("Music Assistant search result group is invalid");
      }
      return Object.freeze(value.flatMap((item) => {
        const row = mapItem(item, group.kind);
        return row === undefined ? [] : [row];
      }));
    });

    const rows: MusicAssistantMediaCatalogRow[] = [];
    for (let index = 0; rows.length < input.limit; index += 1) {
      let added = false;
      for (const groupRows of rowsByGroup) {
        const row = groupRows[index];
        if (row === undefined) continue;
        rows.push(row);
        added = true;
        if (rows.length === input.limit) break;
      }
      if (!added) break;
      input.signal.throwIfAborted();
    }
    return Object.freeze(rows);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.client.dispose?.();
  }
}

function validateInput(input: MediaCatalogProviderSearchInput): void {
  if (!input || !boundedText(input.query, 1_000)) throw new TypeError("Music Assistant search query is invalid");
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20) {
    throw new TypeError("Music Assistant search limit is invalid");
  }
  if (!Array.isArray(input.kinds)
    || input.kinds.some((kind) => !(MEDIA_CATALOG_KINDS as readonly string[]).includes(kind))) {
    throw new TypeError("Music Assistant search media kinds are invalid");
  }
  if (!(input.signal instanceof AbortSignal)) throw new TypeError("Music Assistant search signal is invalid");
}

function reviewedGroups(kinds: readonly MediaCatalogKind[]): readonly SearchGroup[] {
  const groups: SearchGroup[] = [];
  const seen = new Set<MediaCatalogKind>();
  for (const kind of kinds) {
    if (seen.has(kind)) continue;
    seen.add(kind);
    if (kind === "episode") continue;
    groups.push(SEARCH_GROUPS[kind]);
  }
  return Object.freeze(groups);
}

function mapItem(value: unknown, kind: SearchGroup["kind"]): MusicAssistantMediaCatalogRow | undefined {
  if (!isRecord(value)
    || value.media_type !== SEARCH_GROUPS[kind].mediaType
    || !boundedText(value.uri, 512)
    || !boundedText(value.name, 256)
    || typeof value.is_playable !== "boolean") {
    return undefined;
  }
  const creator = projectCreator(value, kind);
  const durationSeconds = (kind === "track" || kind === "audiobook")
    ? projectDuration(value.duration)
    : undefined;
  return Object.freeze({
    providerItemId: value.uri,
    title: value.name,
    kind,
    playable: value.is_playable,
    ...(creator === undefined ? {} : { creator }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  });
}

function projectCreator(value: Record<string, unknown>, kind: SearchGroup["kind"]): string | undefined {
  if (kind === "track" || kind === "album") return joinedNames(value.artists);
  if (kind === "audiobook") return joinedNames(value.authors);
  if (kind === "podcast") return boundedText(value.publisher, 256) ? value.publisher : undefined;
  if (kind === "playlist") return boundedText(value.owner, 256) ? value.owner : undefined;
  return undefined;
}

function joinedNames(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.flatMap((item) => {
    if (boundedText(item, 256)) return [item];
    if (isRecord(item) && boundedText(item.name, 256)) return [item.name];
    return [];
  });
  if (names.length === 0) return undefined;
  const joined = names.join(" · ");
  return boundedText(joined, 256) ? joined : undefined;
}

function projectDuration(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_DURATION_SECONDS
    ? value as number
    : undefined;
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
