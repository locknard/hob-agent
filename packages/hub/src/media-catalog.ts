import { randomUUID } from "node:crypto";

import { z } from "zod";

export const MEDIA_CATALOG_KINDS = Object.freeze([
  "artist",
  "album",
  "track",
  "playlist",
  "radio",
  "audiobook",
  "podcast",
  "episode",
  "genre",
] as const);

export type MediaCatalogKind = typeof MEDIA_CATALOG_KINDS[number];

export interface MediaCatalogProviderSearchInput {
  readonly query: string;
  readonly limit: number;
  readonly kinds: readonly MediaCatalogKind[];
  readonly signal: AbortSignal;
}

/** Hub-private provider seam. Native item identity never enters a search result. */
export interface MediaCatalogProvider {
  search(input: MediaCatalogProviderSearchInput): Promise<readonly unknown[]>;
}

export interface MediaCatalogCandidate {
  readonly mediaRef: string;
  readonly title: string;
  readonly kind: MediaCatalogKind;
  readonly sourceLabel: string;
  readonly playable: boolean;
  readonly creator?: string;
  readonly durationSeconds?: number;
  readonly expiresAt: string;
}

export interface MediaCatalogSearchInput {
  readonly query: string;
  readonly limit?: number;
  readonly kinds?: readonly MediaCatalogKind[];
  readonly signal?: AbortSignal;
}

export interface MediaCatalogSearchResult {
  readonly candidates: readonly MediaCatalogCandidate[];
}

export interface MediaCatalogOptions {
  readonly tenantId: string;
  readonly catalogId: string;
  readonly generation: number;
  readonly sourceLabel: string;
  readonly mediaRefTtlMs: number;
  readonly maxQueryChars: number;
  readonly maxResults: number;
  readonly now?: () => number;
  readonly mediaRefFactory?: () => string;
  readonly provider: MediaCatalogProvider;
}

export type MediaCatalogErrorCode =
  | "invalid_configuration"
  | "invalid_query"
  | "provider_failed"
  | "invalid_provider_result";

export class MediaCatalogError extends Error {
  constructor(readonly code: MediaCatalogErrorCode, message: string) {
    super(message);
    this.name = "MediaCatalogError";
  }
}

interface StoredMediaRef {
  readonly tenantId: string;
  readonly catalogId: string;
  readonly generation: number;
  readonly providerItemId: string;
  readonly expiresAt: number;
  readonly candidate: MediaCatalogCandidate;
}

const providerCandidateSchema = z.object({
  providerItemId: z.string().min(1).max(512),
  title: z.string().min(1).max(256),
  kind: z.enum(MEDIA_CATALOG_KINDS),
  playable: z.boolean(),
  creator: z.string().min(1).max(256).optional(),
  durationSeconds: z.number().int().nonnegative().max(2_678_400).optional(),
}).strict();

const canonicalId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const opaqueMediaRef = /^[A-Za-z0-9_-]{16,256}$/;
const MAX_PROVIDER_ROWS = 100;

/**
 * Phase 0 read-only media discovery boundary.
 *
 * The provider and native ref map are Hub-private. Agent-facing callers can
 * search and receive only bounded neutral candidates; this class has no player
 * or queue control method.
 */
export class MediaCatalog {
  private readonly tenantId: string;
  private readonly catalogId: string;
  private readonly generation: number;
  private readonly sourceLabel: string;
  private readonly mediaRefTtlMs: number;
  private readonly maxQueryChars: number;
  private readonly maxResults: number;
  private readonly now: () => number;
  private readonly mediaRefFactory: () => string;
  private readonly provider: MediaCatalogProvider;
  private readonly refs = new Map<string, StoredMediaRef>();

  constructor(options: MediaCatalogOptions) {
    if (!options || !canonicalId.test(options.tenantId) || !canonicalId.test(options.catalogId)) {
      throw new MediaCatalogError("invalid_configuration", "Media catalog identity is invalid");
    }
    if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
      throw new MediaCatalogError("invalid_configuration", "Media catalog generation is invalid");
    }
    if (!isBoundedDisplayText(options.sourceLabel, 128)) {
      throw new MediaCatalogError("invalid_configuration", "Media catalog source label is invalid");
    }
    if (!Number.isSafeInteger(options.mediaRefTtlMs) || options.mediaRefTtlMs < 1 || options.mediaRefTtlMs > 3_600_000) {
      throw new MediaCatalogError("invalid_configuration", "Media catalog reference TTL is invalid");
    }
    if (!Number.isSafeInteger(options.maxQueryChars) || options.maxQueryChars < 1 || options.maxQueryChars > 1_000) {
      throw new MediaCatalogError("invalid_configuration", "Media catalog query budget is invalid");
    }
    if (!Number.isSafeInteger(options.maxResults) || options.maxResults < 1 || options.maxResults > 20) {
      throw new MediaCatalogError("invalid_configuration", "Media catalog result budget is invalid");
    }
    if (typeof options.provider?.search !== "function") {
      throw new MediaCatalogError("invalid_configuration", "Media catalog provider is invalid");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new MediaCatalogError("invalid_configuration", "Media catalog clock is invalid");
    }
    if (options.mediaRefFactory !== undefined && typeof options.mediaRefFactory !== "function") {
      throw new MediaCatalogError("invalid_configuration", "Media catalog reference factory is invalid");
    }

    this.tenantId = options.tenantId;
    this.catalogId = options.catalogId;
    this.generation = options.generation;
    this.sourceLabel = options.sourceLabel;
    this.mediaRefTtlMs = options.mediaRefTtlMs;
    this.maxQueryChars = options.maxQueryChars;
    this.maxResults = options.maxResults;
    this.now = options.now ?? Date.now;
    this.mediaRefFactory = options.mediaRefFactory ?? (() => randomUUID().replaceAll("-", ""));
    this.provider = options.provider;
  }

  async search(input: MediaCatalogSearchInput): Promise<MediaCatalogSearchResult> {
    const query = this.query(input?.query);
    const limit = input?.limit ?? this.maxResults;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxResults) {
      throw new MediaCatalogError("invalid_query", "Media catalog limit is invalid");
    }
    const kinds = this.kinds(input?.kinds);
    const signal = input?.signal ?? new AbortController().signal;
    if (!(signal instanceof AbortSignal)) {
      throw new MediaCatalogError("invalid_query", "Media catalog signal is invalid");
    }
    if (signal.aborted) throw new MediaCatalogError("provider_failed", "Media catalog search failed");

    let raw: readonly unknown[];
    try {
      raw = await this.provider.search({ query, limit, kinds, signal });
    } catch {
      throw new MediaCatalogError("provider_failed", "Media catalog search failed");
    }
    if (!Array.isArray(raw) || raw.length > MAX_PROVIDER_ROWS) {
      throw new MediaCatalogError("invalid_provider_result", "Media catalog provider result is invalid");
    }

    const issuedAt = this.timestamp(this.now());
    this.pruneExpiredRefs(issuedAt);
    const expiresAt = issuedAt + this.mediaRefTtlMs;
    const candidates: MediaCatalogCandidate[] = [];
    const stagedRefs: StoredMediaRef[] = [];
    const stagedMediaRefs = new Set<string>();
    for (const value of raw.slice(0, limit)) {
      const parsed = providerCandidateSchema.safeParse(value);
      if (!parsed.success || !kinds.includes(parsed.data.kind)) {
        throw new MediaCatalogError("invalid_provider_result", "Media catalog provider result is invalid");
      }
      const mediaRef = this.issueMediaRef(stagedMediaRefs);
      stagedMediaRefs.add(mediaRef);
      const candidate = Object.freeze({
        mediaRef,
        title: parsed.data.title,
        kind: parsed.data.kind,
        sourceLabel: this.sourceLabel,
        playable: parsed.data.playable,
        ...(parsed.data.creator === undefined ? {} : { creator: parsed.data.creator }),
        ...(parsed.data.durationSeconds === undefined ? {} : { durationSeconds: parsed.data.durationSeconds }),
        expiresAt: new Date(expiresAt).toISOString(),
      });
      stagedRefs.push(Object.freeze({
        tenantId: this.tenantId,
        catalogId: this.catalogId,
        generation: this.generation,
        providerItemId: parsed.data.providerItemId,
        expiresAt,
        candidate,
      }));
      candidates.push(candidate);
    }
    for (const stored of stagedRefs) this.refs.set(stored.candidate.mediaRef, stored);
    return Object.freeze({ candidates: Object.freeze(candidates) });
  }

  /** Hub-private freshness check; it exposes no provider or native identity. */
  resolveMediaRef(input: {
    readonly tenantId: string;
    readonly mediaRef: string;
    readonly now: number;
  }): MediaCatalogCandidate | undefined {
    if (!input || !canonicalId.test(input.tenantId) || !opaqueMediaRef.test(input.mediaRef)) return undefined;
    const now = this.timestamp(input.now);
    const stored = this.refs.get(input.mediaRef);
    if (stored === undefined
      || stored.tenantId !== input.tenantId
      || stored.catalogId !== this.catalogId
      || stored.generation !== this.generation
      || now >= stored.expiresAt) {
      return undefined;
    }
    return stored.candidate;
  }

  private query(value: unknown): string {
    if (typeof value !== "string") throw new MediaCatalogError("invalid_query", "Media catalog query is invalid");
    const query = value.trim();
    if (query.length < 1 || query.length > this.maxQueryChars) {
      throw new MediaCatalogError("invalid_query", "Media catalog query is invalid");
    }
    return query;
  }

  private kinds(value: readonly MediaCatalogKind[] | undefined): readonly MediaCatalogKind[] {
    if (value === undefined) return MEDIA_CATALOG_KINDS;
    if (!Array.isArray(value) || value.length < 1 || value.length > MEDIA_CATALOG_KINDS.length) {
      throw new MediaCatalogError("invalid_query", "Media catalog kinds are invalid");
    }
    const kinds = value as readonly unknown[];
    if (new Set(kinds).size !== kinds.length
      || kinds.some((kind) => typeof kind !== "string" || !MEDIA_CATALOG_KINDS.includes(kind as MediaCatalogKind))) {
      throw new MediaCatalogError("invalid_query", "Media catalog kinds are invalid");
    }
    return Object.freeze([...value]);
  }

  private issueMediaRef(staged: ReadonlySet<string>): string {
    const mediaRef = this.mediaRefFactory();
    if (!opaqueMediaRef.test(mediaRef) || this.refs.has(mediaRef) || staged.has(mediaRef)) {
      throw new MediaCatalogError("invalid_provider_result", "Media catalog reference generation failed");
    }
    return mediaRef;
  }

  private pruneExpiredRefs(now: number): void {
    for (const [mediaRef, stored] of this.refs) {
      if (now >= stored.expiresAt) this.refs.delete(mediaRef);
    }
  }

  private timestamp(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
      throw new MediaCatalogError("invalid_configuration", "Media catalog clock is invalid");
    }
    return value;
  }
}

function isBoundedDisplayText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.trim() === value
    && value.length >= 1
    && value.length <= maxLength;
}
