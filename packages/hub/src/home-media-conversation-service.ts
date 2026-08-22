import { AsyncLocalStorage } from "node:async_hooks";
import { Context, Service } from "@deepseek-ai/cordis";

import type {
  MediaPlaybackPreparation,
  MediaPlaybackPrepared,
  MediaPlayIntent,
} from "./media-play-intent.js";
import type {
  OneShotAction,
  OneShotActionActor,
  OneShotActionResult,
  OneShotActionTicket,
} from "./authority/one-shot-action-plane.js";
import type {
  RuntimeDecisionProjection,
} from "./household-review-center-service.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeMediaConversation: HomeMediaConversationService;
  }
}

export const MEDIA_QUEUE_MODES = Object.freeze([
  "replace_and_play",
  "play_next",
  "add_to_queue",
] as const);

export type MediaQueueMode = typeof MEDIA_QUEUE_MODES[number];

export const MEDIA_CLARIFICATION_SLOTS = Object.freeze([
  "query",
  "mediaRef",
  "playerCapabilityId",
  "queueMode",
] as const);

export type MediaClarificationSlot = typeof MEDIA_CLARIFICATION_SLOTS[number];

export type MediaClarificationReason = "missing" | "ambiguous" | "no_match" | "not_playable";

export interface HomeMediaCandidate {
  readonly mediaRef: string;
  readonly title: string;
  readonly kind: "artist" | "album" | "track" | "playlist" | "radio" | "audiobook" | "podcast" | "episode" | "genre";
  readonly sourceLabel: string;
  readonly playable: boolean;
  readonly creator?: string;
  readonly durationSeconds?: number;
}

export interface HomeMediaClarificationOption {
  readonly mediaRef?: string;
  readonly playerCapabilityId?: string;
  readonly queueMode?: MediaQueueMode;
  readonly title?: string;
  readonly sourceLabel?: string;
  readonly playable?: boolean;
}

export interface HomeMediaClarificationState {
  readonly status: "clarification";
  readonly slot: MediaClarificationSlot;
  readonly reason: MediaClarificationReason;
  readonly options: readonly HomeMediaClarificationOption[];
}

export interface HomeMediaSearchState {
  readonly status: "search_results";
  readonly query: string;
  readonly candidates: readonly HomeMediaCandidate[];
  readonly coverage: "complete" | "best_effort";
}

export interface HomeMediaPreparedState {
  readonly status: "prepared";
  readonly intent: MediaPlayIntent;
  readonly preparation: MediaPlaybackPrepared;
}

export type HomeMediaPreparationBlockReason =
  | "invalid_intent"
  | "media_ref_unavailable"
  | "media_not_playable"
  | "player_not_found"
  | "player_ambiguous"
  | "player_unavailable"
  | "player_state_unknown";

export interface HomeMediaBlockedState {
  readonly status: "blocked";
  readonly reason:
    | HomeMediaPreparationBlockReason
    | "authenticated_actor_required"
    | "authenticated_private_actor_required"
    | "invalid_request"
    | "invalid_preparation"
    | "ticket_not_found"
    | "ticket_not_pending"
    | "ticket_not_media"
    | "unauthorized"
    | "expired"
    | "already_decided"
    | "unavailable";
}

export type HomeMediaActionState =
  | {
      readonly status: "pending_confirmation" | "verified" | "failed" | "unknown";
      readonly ticketId: string;
      readonly policyClass: "direct" | "confirmation" | "administrator";
      readonly intent: MediaPlayIntent;
      readonly preparation?: MediaPlaybackPrepared;
      readonly reason?: string;
    }
  | HomeMediaBlockedState;

export type HomeMediaConversationState =
  | HomeMediaClarificationState
  | HomeMediaSearchState
  | HomeMediaPreparedState
  | HomeMediaActionState;

export interface HomeMediaCatalogPort {
  search(input: {
    readonly query: string;
    readonly kinds?: readonly HomeMediaCandidate["kind"][];
    readonly limit?: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly candidates: readonly unknown[];
    readonly coverage: "complete" | "best_effort";
  }>;
}

export interface HomeMediaPreparationPort {
  prepare(intent: MediaPlayIntent): MediaPlaybackPreparation | Promise<MediaPlaybackPreparation>;
}

export interface HomeMediaReviewPort {
  requestAction(input: {
    readonly requestId: string;
    readonly capabilityId: string;
    readonly summary: string;
    readonly action: OneShotAction;
    readonly actor: OneShotActionActor;
    readonly source?: "member" | "hob" | "system" | "external-rule" | "unknown";
    readonly signal?: AbortSignal;
  }): Promise<OneShotActionResult>;
  approveRuntimeConfirmation(input: {
    readonly confirmationId: string;
    readonly actor: OneShotActionActor;
  }): Promise<RuntimeDecisionProjection>;
  listActionTickets(): readonly OneShotActionTicket[];
}

export interface HomeMediaConfirmationActor extends OneShotActionActor {
  /** The caller's authenticated private-device assertion is explicit for voice. */
  readonly authenticated: true;
}

export interface HomeMediaConversationServiceOptions {
  readonly catalog?: HomeMediaCatalogPort;
  readonly preparation?: HomeMediaPreparationPort;
  readonly reviewCenter?: HomeMediaReviewPort;
}

export interface HomeMediaSearchInput {
  readonly query: string;
  readonly kinds?: readonly HomeMediaCandidate["kind"][];
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface HomeMediaPreparationInput {
  readonly playerCapabilityId: string;
  readonly mediaRef: string;
  readonly queueMode: MediaQueueMode;
  readonly signal?: AbortSignal;
}

export interface HomeMediaActionRequest {
  readonly requestId: string;
  readonly query?: string;
  readonly playerCapabilityId?: string;
  readonly mediaRef?: string;
  readonly queueMode?: MediaQueueMode;
  readonly actor?: OneShotActionActor;
  readonly source?: "member" | "hob" | "system" | "external-rule" | "unknown";
  readonly signal?: AbortSignal;
}

export type HomeMediaConversationInput =
  | ({ readonly operation: "search" } & HomeMediaSearchInput)
  | ({ readonly operation: "prepare" } & HomeMediaPreparationInput)
  | ({ readonly operation: "request_action" } & HomeMediaActionRequest);

const MEDIA_KINDS = new Set<HomeMediaCandidate["kind"]>([
  "artist", "album", "track", "playlist", "radio", "audiobook", "podcast", "episode", "genre",
]);
const OPAQUE_MEDIA_REF = /^[A-Za-z0-9_-]{16,256}$/u;
const MAX_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 512;
const MAX_RESULTS = 3;

/**
 * Joins media discovery, exact intent preparation, and the existing Hub action
 * owner. It stores no confirmation or ticket state of its own.
 */
export class HomeMediaConversationService extends Service {
  readonly search: (input: HomeMediaSearchInput) => Promise<HomeMediaSearchState>;
  readonly prepare: (input: HomeMediaPreparationInput) => Promise<HomeMediaPreparedState | HomeMediaBlockedState>;
  readonly request: (input: HomeMediaActionRequest) => Promise<HomeMediaConversationState>;
  readonly requestAction: (input: HomeMediaActionRequest) => Promise<HomeMediaConversationState>;
  readonly handle: (input: HomeMediaConversationInput) => Promise<HomeMediaConversationState>;
  readonly confirm: (input: {
    readonly ticketId: string;
    readonly channel: "click" | "spoken";
    readonly actor?: OneShotActionActor | HomeMediaConfirmationActor;
    readonly signal?: AbortSignal;
  }) => Promise<HomeMediaActionState>;

  private readonly catalog: HomeMediaCatalogPort;
  private readonly preparation: HomeMediaPreparationPort;
  private readonly reviewCenter: HomeMediaReviewPort;
  private readonly actorScope = new AsyncLocalStorage<OneShotActionActor>();

  constructor(ctx: Context, options: HomeMediaConversationServiceOptions = {}) {
    super(ctx, "homeMediaConversation");
    this.catalog = options.catalog ?? readRequiredPort(ctx, "homeMediaCatalog") as HomeMediaCatalogPort;
    this.preparation = options.preparation
      ?? readRequiredPort(ctx, "homeMediaPlaybackPreparation") as HomeMediaPreparationPort;
    this.reviewCenter = options.reviewCenter
      ?? readRequiredPort(ctx, "homeReviewCenter") as HomeMediaReviewPort;

    this.search = (input) => this.searchCatalog(input);
    this.prepare = (input) => this.prepareIntent(input);
    this.request = (input) => this.requestMediaAction(input);
    this.requestAction = this.request;
    this.handle = (input) => this.handleInput(input);
    this.confirm = (input) => this.confirmAction(input);
  }

  /** Runs one authenticated member request with an isolated action owner. */
  runWithActor<T>(
    actor: OneShotActionActor,
    callback: () => T | PromiseLike<T>,
  ): T | PromiseLike<T> {
    if (!isPresentActor(actor)) throw new TypeError("an authenticated present actor is required");
    if (typeof callback !== "function") throw new TypeError("an actor scope callback is required");
    return this.actorScope.run(actor, callback);
  }

  private async searchCatalog(input: HomeMediaSearchInput): Promise<HomeMediaSearchState> {
    const query = boundedText(input?.query, "query", MAX_TEXT_LENGTH).trim();
    if (query.length === 0) throw new RangeError("query must not be blank");
    const limit = validateLimit(input?.limit);
    const signal = input?.signal ?? new AbortController().signal;
    if (signal.aborted) throw signal.reason;
    const kinds = validateKinds(input?.kinds);
    const value = await this.catalog.search({
      query,
      ...(kinds === undefined ? {} : { kinds }),
      limit,
      signal,
    });
    if (signal.aborted) throw signal.reason;
    return {
      status: "search_results",
      query,
      candidates: projectCandidates(value, limit),
      coverage: value.coverage,
    };
  }

  private async prepareIntent(input: HomeMediaPreparationInput): Promise<HomeMediaPreparedState | HomeMediaBlockedState> {
    const playerCapabilityId = boundedId(input?.playerCapabilityId, "playerCapabilityId");
    const mediaRef = validateMediaRef(input?.mediaRef);
    const queueMode = validateQueueMode(input?.queueMode);
    const signal = input?.signal ?? new AbortController().signal;
    if (signal.aborted) throw signal.reason;
    const intent: MediaPlayIntent = {
      kind: "play_media",
      playerHwCapabilityId: playerCapabilityId,
      mediaRef,
      queueMode,
    };
    let result: MediaPlaybackPreparation;
    try {
      result = await this.preparation.prepare(intent);
    } catch {
      return { status: "blocked", reason: "invalid_preparation" };
    }
    if (signal.aborted) throw signal.reason;
    if (!isRecord(result) || typeof result.status !== "string") {
      return { status: "blocked", reason: "invalid_preparation" };
    }
    if (result.status === "blocked") {
      return isPreparationBlockReason(result.reason)
        ? { status: "blocked", reason: result.reason }
        : { status: "blocked", reason: "invalid_preparation" };
    }
    if (result.status !== "requires_confirmation" || !preparedMatches(result, intent)) {
      return { status: "blocked", reason: "invalid_preparation" };
    }
    return { status: "prepared", intent, preparation: result };
  }

  private async requestMediaAction(input: HomeMediaActionRequest): Promise<HomeMediaConversationState> {
    const requestId = boundedId(input?.requestId, "requestId");
    const signal = input?.signal ?? new AbortController().signal;
    if (signal.aborted) throw signal.reason;
    let mediaRef = input.mediaRef === undefined ? undefined : validateMediaRef(input.mediaRef);
    const query = input.query === undefined ? undefined : boundedText(input.query, "query", MAX_TEXT_LENGTH).trim();
    if (query !== undefined && query.length === 0) return clarification("query", "missing");
    if (mediaRef === undefined) {
      if (query === undefined) return clarification("query", "missing");
      const search = await this.searchCatalog({ query, signal });
      const playable = search.candidates.filter((candidate) => candidate.playable);
      if (playable.length === 0) {
        return clarification("mediaRef", search.candidates.length === 0 ? "no_match" : "not_playable");
      }
      if (playable.length !== 1) {
        return clarification("mediaRef", "ambiguous", playable.map((candidate) => ({
          mediaRef: candidate.mediaRef,
          title: candidate.title,
          sourceLabel: candidate.sourceLabel,
          playable: true,
        })));
      }
      mediaRef = playable[0]!.mediaRef;
    }
    const playerCapabilityId = input.playerCapabilityId === undefined
      ? undefined
      : boundedId(input.playerCapabilityId, "playerCapabilityId");
    if (playerCapabilityId === undefined) return clarification("playerCapabilityId", "missing");
    const queueMode = input.queueMode === undefined ? undefined : validateQueueMode(input.queueMode);
    if (queueMode === undefined) {
      return clarification("queueMode", "missing", MEDIA_QUEUE_MODES.map((mode) => ({ queueMode: mode })));
    }
    const actor = input.actor ?? this.actorScope.getStore();
    if (!isPresentActor(actor)) return { status: "blocked", reason: "authenticated_actor_required" };
    const prepared = await this.prepareIntent({
      playerCapabilityId,
      mediaRef,
      queueMode,
      signal,
    });
    if (prepared.status !== "prepared") return prepared;
    const action: OneShotAction = {
      kind: "play_media",
      mediaRef,
      queueMode,
    };
    const result = await this.reviewCenter.requestAction({
      requestId,
      capabilityId: playerCapabilityId,
      summary: actionSummary(prepared.preparation, queueMode),
      action,
      actor,
      source: input.source ?? "member",
      signal,
    });
    return projectActionResult(result, prepared.preparation, prepared.intent);
  }

  private async handleInput(input: HomeMediaConversationInput): Promise<HomeMediaConversationState> {
    if (!input || typeof input !== "object") throw new TypeError("media conversation input is invalid");
    if (input.operation === "search") return this.searchCatalog(input);
    if (input.operation === "prepare") return this.prepareIntent(input);
    if (input.operation === "request_action") return this.requestMediaAction(input);
    throw new TypeError("media conversation operation is invalid");
  }

  private async confirmAction(input: {
    readonly ticketId: string;
    readonly channel: "click" | "spoken";
    readonly actor?: OneShotActionActor | HomeMediaConfirmationActor;
    readonly signal?: AbortSignal;
  }): Promise<HomeMediaActionState> {
    const ticketId = boundedId(input?.ticketId, "ticketId");
    if (input?.channel !== "click" && input?.channel !== "spoken") {
      return { status: "blocked", reason: "invalid_request" };
    }
    const actor = input.actor;
    if (input.channel === "spoken" && !isAuthenticatedPrivateActor(actor)) {
      return { status: "blocked", reason: "authenticated_private_actor_required" };
    }
    if (!isPresentActor(actor)) return { status: "blocked", reason: "authenticated_actor_required" };
    const ticket = this.reviewCenter.listActionTickets().find((item) => item.id === ticketId);
    if (ticket === undefined) return { status: "blocked", reason: "ticket_not_found" };
    if (ticket.action.kind !== "play_media") return { status: "blocked", reason: "ticket_not_media" };
    if (ticket.status !== "pending_confirmation") return { status: "blocked", reason: "ticket_not_pending" };
    if (input.signal?.aborted) throw input.signal.reason;
    const decision = await this.reviewCenter.approveRuntimeConfirmation({
      confirmationId: ticketId,
      actor,
    });
    if (input.signal?.aborted) throw input.signal.reason;
    const updated = this.reviewCenter.listActionTickets().find((item) => item.id === ticketId);
    if (updated === undefined || updated.action.kind !== "play_media") {
      return { status: "blocked", reason: "ticket_not_found" };
    }
    if (decision.status === "denied") return blockedDecision(decision);
    return projectActionTicket(updated);
  }
}

function readRequiredPort(ctx: Context, key: string): unknown {
  const value = ctx.get(key);
  if (value === undefined) throw new Error(`Home media conversation requires ${key}`);
  return value;
}

function projectCandidates(
  value: { readonly candidates: readonly unknown[]; readonly coverage: "complete" | "best_effort" },
  limit: number,
): readonly HomeMediaCandidate[] {
  if (!value || !Array.isArray(value.candidates) || value.candidates.length > limit) {
    throw new TypeError("media conversation candidates are invalid");
  }
  if (value.coverage !== "complete" && value.coverage !== "best_effort") {
    throw new TypeError("media conversation coverage is invalid");
  }
  return value.candidates.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError("media conversation candidate is invalid");
    }
    const row = candidate as Record<string, unknown>;
    const mediaRef = validateMediaRef(row.mediaRef);
    const title = boundedText(row.title, "title", MAX_TEXT_LENGTH);
    const sourceLabel = boundedText(row.sourceLabel, "sourceLabel", MAX_TEXT_LENGTH);
    if (typeof row.kind !== "string" || !MEDIA_KINDS.has(row.kind as HomeMediaCandidate["kind"])) {
      throw new TypeError("media conversation kind is invalid");
    }
    if (typeof row.playable !== "boolean") throw new TypeError("media conversation playable is invalid");
    const creator = row.creator === undefined ? undefined : boundedText(row.creator, "creator", MAX_TEXT_LENGTH);
    const durationSeconds = row.durationSeconds;
    if (durationSeconds !== undefined
      && (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds < 0)) {
      throw new TypeError("media conversation duration is invalid");
    }
    return {
      mediaRef,
      title,
      kind: row.kind as HomeMediaCandidate["kind"],
      sourceLabel,
      playable: row.playable,
      ...(creator === undefined ? {} : { creator }),
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
    };
  });
}

function preparedMatches(value: MediaPlaybackPrepared, expected: MediaPlayIntent): value is MediaPlaybackPrepared {
  return isRecord(value)
    && isRecord(value.intent)
    && value.intent.kind === "play_media"
    && value.intent.playerHwCapabilityId === expected.playerHwCapabilityId
    && value.intent.mediaRef === expected.mediaRef
    && value.intent.queueMode === expected.queueMode
    && isRecord(value.player)
    && value.player.hwCapabilityId === expected.playerHwCapabilityId
    && isRecord(value.media)
    && value.media.playable === true;
}

function projectActionResult(
  result: OneShotActionResult,
  preparation: MediaPlaybackPrepared,
  intent: MediaPlayIntent,
): HomeMediaActionState {
  if (result.ticket.capabilityId !== intent.playerHwCapabilityId
    || result.ticket.action.kind !== "play_media"
    || result.ticket.action.mediaRef !== intent.mediaRef
    || result.ticket.action.queueMode !== intent.queueMode) {
    return { status: "blocked", reason: "invalid_preparation" };
  }
  if (result.status === "pending_confirmation"
    || result.status === "verified"
    || result.status === "failed"
    || result.status === "unknown") {
    return {
      status: result.status,
      ticketId: result.ticket.id,
      policyClass: result.ticket.policyClass,
      intent,
      preparation,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    };
  }
  return {
    status: "unknown",
    ticketId: result.ticket.id,
    policyClass: result.ticket.policyClass,
    intent,
    preparation,
    reason: result.reason ?? "execution_in_progress",
  };
}

function projectActionTicket(ticket: OneShotActionTicket): HomeMediaActionState {
  if (ticket.action.kind !== "play_media") return { status: "blocked", reason: "ticket_not_media" };
  const status = ticket.status === "pending_confirmation"
    ? "pending_confirmation"
    : ticket.status === "verified" ? "verified" : ticket.status === "unknown" ? "unknown" : "failed";
  return {
    status,
    ticketId: ticket.id,
    policyClass: ticket.policyClass,
    intent: {
      kind: "play_media",
      playerHwCapabilityId: ticket.capabilityId,
      mediaRef: ticket.action.mediaRef,
      queueMode: ticket.action.queueMode,
    },
    ...(ticket.resultReason === undefined ? {} : { reason: ticket.resultReason }),
  };
}

function blockedDecision(decision: RuntimeDecisionProjection): HomeMediaBlockedState {
  if (decision.status !== "denied") return { status: "blocked", reason: "invalid_request" };
  switch (decision.reason) {
    case "not_found": return { status: "blocked", reason: "ticket_not_found" };
    case "expired": return { status: "blocked", reason: "expired" };
    case "unauthorized": return { status: "blocked", reason: "unauthorized" };
    case "already_decided": return { status: "blocked", reason: "already_decided" };
    case "unavailable": return { status: "blocked", reason: "unavailable" };
  }
}

function clarification(
  slot: MediaClarificationSlot,
  reason: MediaClarificationReason,
  options: readonly HomeMediaClarificationOption[] = [],
): HomeMediaClarificationState {
  return { status: "clarification", slot, reason, options };
}

function actionSummary(preparation: MediaPlaybackPrepared, queueMode: MediaQueueMode): string {
  const queueLabel = queueMode === "replace_and_play"
    ? "替换当前队列并播放"
    : queueMode === "play_next" ? "接下来播放" : "加入队列";
  return `在${preparation.player.displayLabel}播放${preparation.media.title}，${queueLabel}`;
}

function isPresentActor(value: OneShotActionActor | undefined): value is OneShotActionActor {
  return value !== undefined
    && value !== null
    && typeof value.principalId === "string"
    && value.principalId.length > 0
    && (value.role === "admin"
      || value.role === "adult_member"
      || value.role === "member"
      || value.role === "child"
      || value.role === "guest")
    && value.present === true
    && value.device !== undefined
    && value.device !== null
    && (value.device.kind === "private" || value.device.kind === "shared");
}

function isAuthenticatedPrivateActor(
  value: OneShotActionActor | HomeMediaConfirmationActor | undefined,
): value is HomeMediaConfirmationActor {
  return isPresentActor(value)
    && (value as Partial<HomeMediaConfirmationActor>).authenticated === true
    && value.device.kind === "private"
    && value.device.boundPrincipalId === value.principalId;
}

function isPreparationBlockReason(value: unknown): value is HomeMediaPreparationBlockReason {
  return value === "invalid_intent"
    || value === "media_ref_unavailable"
    || value === "media_not_playable"
    || value === "player_not_found"
    || value === "player_ambiguous"
    || value === "player_unavailable"
    || value === "player_state_unknown";
}

function validateKinds(value: readonly HomeMediaCandidate["kind"][] | undefined): readonly HomeMediaCandidate["kind"][] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > MEDIA_KINDS.size) {
    throw new TypeError("media kinds are invalid");
  }
  const kinds = value.map((kind) => {
    if (typeof kind !== "string" || !MEDIA_KINDS.has(kind as HomeMediaCandidate["kind"])) {
      throw new TypeError("media kinds are invalid");
    }
    return kind as HomeMediaCandidate["kind"];
  });
  if (new Set(kinds).size !== kinds.length) throw new TypeError("media kinds contain duplicates");
  return kinds;
}

function validateLimit(value: unknown): number {
  const limit = value ?? MAX_RESULTS;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RESULTS) {
    throw new RangeError(`media limit must be from 1 to ${MAX_RESULTS}`);
  }
  return limit as number;
}

function validateQueueMode(value: unknown): MediaQueueMode {
  if (typeof value !== "string" || !MEDIA_QUEUE_MODES.includes(value as MediaQueueMode)) {
    throw new TypeError("queueMode is invalid");
  }
  return value as MediaQueueMode;
}

function validateMediaRef(value: unknown): string {
  if (typeof value !== "string" || !OPAQUE_MEDIA_REF.test(value)) throw new TypeError("mediaRef is invalid");
  return value;
}

function boundedId(value: unknown, field: string): string {
  return boundedText(value, field, MAX_ID_LENGTH);
}

function boundedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > maxLength
    || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
