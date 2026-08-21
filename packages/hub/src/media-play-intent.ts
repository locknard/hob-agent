import { z } from "zod";

import type { MediaCatalogCandidate } from "./media-catalog.js";
import type {
  MediaPlayerInventory,
  MediaPlayerInventoryEntry,
  MediaPlayerPlaybackState,
} from "./media-player-inventory.js";

export const MEDIA_QUEUE_MODES = Object.freeze([
  "replace_and_play",
  "play_next",
  "add_to_queue",
] as const);

export type MediaQueueMode = typeof MEDIA_QUEUE_MODES[number];

export interface MediaPlayIntent {
  readonly kind: "play_media";
  readonly playerHwCapabilityId: string;
  readonly mediaRef: string;
  readonly queueMode: MediaQueueMode;
}

export type MediaPlaybackBlockReason =
  | "invalid_intent"
  | "media_ref_unavailable"
  | "media_not_playable"
  | "player_not_found"
  | "player_ambiguous"
  | "player_unavailable"
  | "player_state_unknown";

export interface MediaPlaybackBlocked {
  readonly status: "blocked";
  readonly reason: MediaPlaybackBlockReason;
}

export interface MediaPlaybackPrepared {
  readonly status: "requires_confirmation";
  readonly intent: MediaPlayIntent;
  readonly player: {
    readonly hwCapabilityId: string;
    readonly displayLabel: string;
    readonly spaces: readonly { readonly hwSpaceId: string; readonly name?: string }[];
    readonly playbackState: MediaPlayerPlaybackState;
    readonly volume: { readonly reported: boolean; readonly level?: number };
  };
  readonly media: {
    readonly title: string;
    readonly kind: MediaCatalogCandidate["kind"];
    readonly sourceLabel: string;
    readonly playable: true;
    readonly creator?: string;
    readonly durationSeconds?: number;
  };
}

export type MediaPlaybackPreparation = MediaPlaybackBlocked | MediaPlaybackPrepared;

export interface MediaReferenceResolver {
  resolveMediaRef(input: {
    readonly tenantId: string;
    readonly mediaRef: string;
    readonly now: number;
  }): MediaCatalogCandidate | undefined;
}

export interface PrepareMediaPlayIntentInput {
  readonly intent: unknown;
  readonly tenantId: string;
  readonly now: number;
  readonly catalog: MediaReferenceResolver;
  readonly inventory: MediaPlayerInventory;
}

export class MediaPlayIntentError extends TypeError {
  readonly code = "invalid_intent" as const;

  constructor() {
    super("Invalid media play intent");
    this.name = "MediaPlayIntentError";
  }
}

const boundedId = z.string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value && !hasControl(value));
const mediaRef = z.string().regex(/^[A-Za-z0-9_-]{16,256}$/);
const intentSchema = z.object({
  kind: z.literal("play_media"),
  playerHwCapabilityId: boundedId,
  mediaRef,
  queueMode: z.enum(MEDIA_QUEUE_MODES),
}).strict();
const tenantId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PLAYBACK_STATES = new Set<MediaPlayerPlaybackState>([
  "playing", "paused", "buffering", "idle", "stopped", "unknown",
]);
const MEDIA_KINDS = new Set<MediaCatalogCandidate["kind"]>([
  "artist", "album", "track", "playlist", "radio", "audiobook", "podcast", "episode", "genre",
]);
const MAX_PLAYER_ROWS = 200;

export function parseMediaPlayIntent(value: unknown): MediaPlayIntent {
  const parsed = intentSchema.safeParse(value);
  if (!parsed.success) throw new MediaPlayIntentError();
  return Object.freeze(parsed.data);
}

/**
 * Revalidates one neutral player and one short-lived catalog result.
 * This function has no ticket, bridge, queue, volume-control, or execution seam.
 */
export function prepareMediaPlayIntent(input: PrepareMediaPlayIntentInput): MediaPlaybackPreparation {
  validatePreparationInput(input);
  let intent: MediaPlayIntent;
  try {
    intent = parseMediaPlayIntent(input.intent);
  } catch {
    return blocked("invalid_intent");
  }

  const rawCandidate = input.catalog.resolveMediaRef({
    tenantId: input.tenantId,
    mediaRef: intent.mediaRef,
    now: input.now,
  });
  const candidate = projectCandidate(rawCandidate, intent.mediaRef, input.now);
  if (candidate === undefined) return blocked("media_ref_unavailable");
  if (!candidate.playable) return blocked("media_not_playable");

  const matchingPlayers = input.inventory.players.filter((player) => (
    player?.hwCapabilityId === intent.playerHwCapabilityId
  ));
  if (matchingPlayers.length === 0) return blocked("player_not_found");
  if (matchingPlayers.length !== 1) return blocked("player_ambiguous");
  const player = matchingPlayers[0]!;
  if (player.availability === "unavailable") return blocked("player_unavailable");
  if (player.availability !== "available") return blocked("player_state_unknown");

  const projectedPlayer = projectPlayer(player);
  if (projectedPlayer === undefined) return blocked("player_state_unknown");
  return deepFreeze({
    status: "requires_confirmation" as const,
    intent,
    player: projectedPlayer,
    media: {
      title: candidate.title,
      kind: candidate.kind,
      sourceLabel: candidate.sourceLabel,
      playable: true as const,
      ...(candidate.creator === undefined ? {} : { creator: candidate.creator }),
      ...(candidate.durationSeconds === undefined ? {} : { durationSeconds: candidate.durationSeconds }),
    },
  });
}

function validatePreparationInput(input: PrepareMediaPlayIntentInput): void {
  if (!input
    || typeof input !== "object"
    || !tenantId.test(input.tenantId)
    || !Number.isSafeInteger(input.now)
    || input.now < 0
    || input.now > 8_640_000_000_000_000
    || !input.catalog
    || typeof input.catalog.resolveMediaRef !== "function"
    || !input.inventory
    || !Array.isArray(input.inventory.players)
    || input.inventory.players.length > MAX_PLAYER_ROWS) {
    throw new TypeError("Media playback preparation is invalid");
  }
}

function projectCandidate(
  value: MediaCatalogCandidate | undefined,
  expectedRef: string,
  now: number,
): MediaCatalogCandidate | undefined {
  if (!value
    || value.mediaRef !== expectedRef
    || !isFreshExpiry(value.expiresAt, now)
    || !boundedText(value.title, 256)
    || !MEDIA_KINDS.has(value.kind)
    || !boundedText(value.sourceLabel, 128)
    || typeof value.playable !== "boolean") return undefined;
  if (value.creator !== undefined && !boundedText(value.creator, 256)) return undefined;
  if (value.durationSeconds !== undefined
    && (!Number.isSafeInteger(value.durationSeconds) || value.durationSeconds < 0 || value.durationSeconds > 2_678_400)) {
    return undefined;
  }
  return value;
}

function isFreshExpiry(value: unknown, now: number): value is string {
  if (typeof value !== "string") return false;
  const expiresAt = Date.parse(value);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function projectPlayer(player: MediaPlayerInventoryEntry): MediaPlaybackPrepared["player"] | undefined {
  if (!boundedIdentity(player.hwCapabilityId, 256)
    || !boundedText(player.displayLabel, 512)
    || !Array.isArray(player.spaces)
    || player.spaces.length > 10
    || !PLAYBACK_STATES.has(player.playbackState)) return undefined;
  const spaces: Array<{ readonly hwSpaceId: string; readonly name?: string }> = [];
  const seen = new Set<string>();
  for (const space of player.spaces) {
    if (!space || !boundedIdentity(space.hwSpaceId, 256) || seen.has(space.hwSpaceId)) return undefined;
    if (space.name !== undefined && !boundedText(space.name, 512)) return undefined;
    seen.add(space.hwSpaceId);
    spaces.push({ hwSpaceId: space.hwSpaceId, ...(space.name === undefined ? {} : { name: space.name }) });
  }
  const volume = player.volume?.reported === true
    && typeof player.volume.level === "number"
    && Number.isFinite(player.volume.level)
    && player.volume.level >= 0
    && player.volume.level <= 1
    ? { reported: true as const, level: player.volume.level }
    : { reported: false as const };
  return deepFreeze({
    hwCapabilityId: player.hwCapabilityId,
    displayLabel: player.displayLabel,
    spaces,
    playbackState: player.playbackState,
    volume,
  });
}

function blocked(reason: MediaPlaybackBlockReason): MediaPlaybackBlocked {
  return Object.freeze({ status: "blocked", reason });
}

function boundedIdentity(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maxLength
    && value.trim() === value
    && !hasControl(value);
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maxLength
    && !hasControl(value);
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001F\u007F]/u.test(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
