import { Context, Service } from "@deepseek-ai/cordis";

import {
  HomeMediaActionIdempotencyConflictError,
  SqliteHomeMediaActionTurnStore,
  type HomeMediaActionTurnCompletionNotification,
  type HomeMediaActionTurnEvent,
  type HomeMediaActionTurnFailureReason,
  type HomeMediaActionTurnRecord,
  type HomeMediaActionTurnStore,
  type SqliteHomeMediaActionTurnStoreOptions,
} from "./home-media-action-turn-store.js";
import type { HomeMediaConversationState } from "./home-media-conversation-service.js";
import type { OneShotActionActor, OneShotActionTicket } from "../authority/one-shot-action-plane.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeMediaActionTurns: HomeMediaActionTurnService;
  }
}

interface HomeMediaActionAgentPort {
  readonly observationStatus: "idle" | "running";
  readonly modelStatus?: { readonly state: "active" | "degraded" | "retrying" | "switching" };
  requestMediaActionTurn(question: string, signal?: AbortSignal): Promise<void>;
}

interface HomeMediaActionConversationPort {
  runActionTurn(
    actor: OneShotActionActor,
    requestId: string,
    callback: () => unknown | PromiseLike<unknown>,
    signal?: AbortSignal,
  ): Promise<HomeMediaConversationState>;
}

interface HomeMediaActionReviewPort {
  getActionTicket(ticketId: string): OneShotActionTicket | undefined;
  getActionTicketForRequest(requestId: string): OneShotActionTicket | undefined;
}

export interface HomeMediaActionTurnServiceOptions extends Partial<SqliteHomeMediaActionTurnStoreOptions> {
  readonly store?: HomeMediaActionTurnStore & { close?: () => void };
  readonly clock?: () => string;
  readonly agent?: HomeMediaActionAgentPort;
  readonly conversation?: HomeMediaActionConversationPort;
  readonly reviewCenter?: HomeMediaActionReviewPort;
  readonly actionTimeoutMs?: number;
  readonly maxSubscriptions?: number;
}

type HomeMediaActionTurnProjectionBase = {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly question: string;
  readonly createdAt: string;
};

export type HomeMediaActionTurnProjection =
  | (HomeMediaActionTurnProjectionBase & { readonly status: "running" })
  | (HomeMediaActionTurnProjectionBase & {
      readonly status: "clarification";
      readonly clarification: Extract<HomeMediaActionTurnRecord, { readonly status: "clarification" }>["clarification"];
      readonly transitionedAt: string;
    })
  | (HomeMediaActionTurnProjectionBase & {
      readonly status: "ticket";
      readonly ticketId: string;
      readonly transitionedAt: string;
      readonly ticket: OneShotActionTicket;
    })
  | (HomeMediaActionTurnProjectionBase & {
      readonly status: "failed" | "cancelled";
      readonly reason: HomeMediaActionTurnFailureReason;
      readonly transitionedAt: string;
    })
  | (HomeMediaActionTurnProjectionBase & {
      readonly status: "unavailable" | "corrupted";
      readonly ticketId: string;
      readonly transitionedAt: string;
      readonly reason: "ticket_missing" | "ticket_request_mismatch";
    });

export type HomeMediaActionTurnAvailability =
  | { readonly status: "ready" }
  | { readonly status: "active_turn"; readonly activeTurnId: string }
  | { readonly status: "model_unavailable" | "agent_busy" | "stopped" | "unavailable" };

export class HomeMediaActionTurnUnavailableError extends Error {
  readonly code: Exclude<HomeMediaActionTurnAvailability["status"], "ready">;

  constructor(readonly availability: Exclude<HomeMediaActionTurnAvailability, { readonly status: "ready" }>) {
    super(`Home media action cannot start: ${availability.status}`);
    this.name = "HomeMediaActionTurnUnavailableError";
    this.code = availability.status;
  }
}

export type HomeMediaActionTurnListener = (event: HomeMediaActionTurnEvent) => void;

interface ActiveTurn {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  cancelRequested: boolean;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_QUESTION_LENGTH = 512;

/**
 * Hub-owned, durable orchestration for one explicit media command. It holds a
 * present actor only in memory, delegates every command to the existing
 * media/review owners, and persists only lifecycle state plus a ticket link.
 */
export class HomeMediaActionTurnService extends Service {
  private readonly store: HomeMediaActionTurnStore & { close?: () => void };
  private readonly clock: () => string;
  private readonly agent: HomeMediaActionAgentPort | undefined;
  private readonly conversation: HomeMediaActionConversationPort | undefined;
  private readonly reviewCenter: HomeMediaActionReviewPort | undefined;
  private readonly actionTimeoutMs: number;
  private readonly maxSubscriptions: number;
  private readonly subscribers = new Map<string, Set<HomeMediaActionTurnListener>>();
  private subscriptionCount = 0;
  private active: ActiveTurn | undefined;
  private closed = false;
  private recoveryUnavailable = false;

  constructor(ctx: Context, options: HomeMediaActionTurnServiceOptions = {}) {
    super(ctx, "homeMediaActionTurns");
    if (options.store !== undefined && options.path !== undefined) {
      throw new TypeError("Home media action turns accept a store or path, not both");
    }
    if (options.store === undefined && options.path === undefined) {
      throw new TypeError("Home media action turns require a durable store path or explicit store");
    }
    this.store = options.store ?? new SqliteHomeMediaActionTurnStore({
      path: options.path!,
      ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
      ...(options.maxEventsPerTurn === undefined ? {} : { maxEventsPerTurn: options.maxEventsPerTurn }),
    });
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.agent = options.agent ?? asAgent(ctx.get("homeAgent"));
    this.conversation = options.conversation ?? asConversation(ctx.get("homeMediaConversation"));
    this.reviewCenter = options.reviewCenter ?? asReviewCenter(ctx.get("homeReviewCenter"));
    this.actionTimeoutMs = positiveInteger(options.actionTimeoutMs ?? DEFAULT_TIMEOUT_MS, "home media action timeout");
    this.maxSubscriptions = positiveInteger(options.maxSubscriptions ?? 128, "home media action subscription limit");
  }

  protected [Service.init](): void {
    this.recoverInterrupted();
    this.ctx.effect(() => () => { void this.close(); }, "home-media-action-turns.close");
  }

  availability(): HomeMediaActionTurnAvailability {
    if (this.closed) return { status: "stopped" };
    if (this.recoveryUnavailable) return { status: "unavailable" };
    if (this.active !== undefined) return { status: "active_turn", activeTurnId: this.active.id };
    if (this.agent === undefined || this.conversation === undefined || this.reviewCenter === undefined) {
      return { status: "model_unavailable" };
    }
    if (this.agent.modelStatus?.state === "degraded" || this.agent.modelStatus?.state === "retrying") {
      return { status: "model_unavailable" };
    }
    if (this.agent.observationStatus !== "idle") return { status: "agent_busy" };
    return { status: "ready" };
  }

  async start(input: {
    readonly question: string;
    readonly actor: OneShotActionActor;
    readonly idempotencyKey: string;
  }): Promise<HomeMediaActionTurnProjection> {
    const question = boundedQuestion(input?.question);
    assertPresentActor(input?.actor);
    const idempotencyKey = boundedIdempotencyKey(input?.idempotencyKey);
    if (this.closed || this.recoveryUnavailable) {
      const unavailable = this.availability();
      throw new HomeMediaActionTurnUnavailableError(
        unavailable.status === "ready" ? { status: "unavailable" } : unavailable,
      );
    }
    // A retry is read-only and works even when a new Agent turn cannot start.
    // The store performs the question-hash conflict check before this owner
    // considers model availability or another active request.
    let replayed: HomeMediaActionTurnRecord | undefined;
    try {
      replayed = this.store.replay({ idempotencyKey, question });
    } catch (error) {
      if (error instanceof HomeMediaActionIdempotencyConflictError) throw error;
      this.failClosedUnavailable();
      throw new HomeMediaActionTurnUnavailableError({ status: "unavailable" });
    }
    if (replayed !== undefined) return this.requireProjection(replayed.id);
    const availability = this.availability();
    if (availability.status !== "ready") throw new HomeMediaActionTurnUnavailableError(availability);
    let begun: ReturnType<HomeMediaActionTurnStore["begin"]>;
    try {
      begun = this.store.begin({ createdAt: timestamp(this.clock), idempotencyKey, question });
    } catch (error) {
      if (error instanceof HomeMediaActionIdempotencyConflictError) throw error;
      this.failClosedUnavailable();
      throw new HomeMediaActionTurnUnavailableError({ status: "unavailable" });
    }
    const existing = begun.outcome === "existing";
    if (existing) return this.requireProjection(begun.turn.id);
    if (begun.turn.status !== "running") {
      this.failClosedUnavailable();
      throw new HomeMediaActionTurnUnavailableError({ status: "unavailable" });
    }
    const agent = this.agent;
    const conversation = this.conversation;
    if (agent === undefined || conversation === undefined) {
      // Availability closed this branch before durable acceptance; retain an explicit guard for dynamic composition.
      this.store.fail({ id: begun.turn.id, reason: "agent_unavailable", transitionedAt: timestamp(this.clock) });
      return this.requireProjection(begun.turn.id);
    }
    const controller = new AbortController();
    const activeTurn = {
      id: begun.turn.id,
      idempotencyKey,
      controller,
      cancelRequested: false,
      timedOut: false,
      settled: Promise.resolve(),
    } as ActiveTurn;
    const settled = this.run(activeTurn, input.actor, question, agent, conversation).catch(() => {
      // Background persistence failures have no request caller. Keep the
      // process alive, close this owner to new commands, and never leak a raw
      // SQLite or provider failure as an unhandled rejection.
      this.failClosedUnavailable();
    });
    (activeTurn as { settled: Promise<void> }).settled = settled;
    this.active = activeTurn;
    return begun.turn;
  }

  get(id: string): HomeMediaActionTurnProjection | undefined {
    if (!isMediaActionTurnId(id)) return undefined;
    if (this.recoveryUnavailable) return undefined;
    try {
      const record = this.store.get(id);
      return record === undefined ? undefined : this.project(record);
    } catch {
      this.failClosedUnavailable();
      return undefined;
    }
  }

  events(id: string, afterSeq = 0): readonly HomeMediaActionTurnEvent[] {
    validateCursor(afterSeq);
    if (!isMediaActionTurnId(id)) return [];
    if (this.recoveryUnavailable) return [];
    try {
      return this.store.events(id, afterSeq).map(copyEvent);
    } catch {
      this.failClosedUnavailable();
      return [];
    }
  }

  /** Forwards the oldest durable clarification/failure signal as its minimal product payload. */
  peekNextCompletionNotification(): HomeMediaActionTurnCompletionNotification | undefined {
    if (this.closed || this.recoveryUnavailable) return undefined;
    try {
      return this.store.peekNextCompletionNotification();
    } catch {
      this.failClosedUnavailable();
      return undefined;
    }
  }

  /** Acknowledges one exact durable notification id by turn id. */
  acknowledgeCompletionNotification(id: string): boolean {
    if (this.closed || this.recoveryUnavailable || !isMediaActionTurnId(id)) return false;
    try {
      return this.store.acknowledgeCompletionNotification(id);
    } catch {
      this.failClosedUnavailable();
      return false;
    }
  }

  subscribe(id: string, listener: HomeMediaActionTurnListener, afterSeq = 0): () => void {
    if (typeof listener !== "function") throw new TypeError("Home media action turn listener is required");
    validateCursor(afterSeq);
    if (!isMediaActionTurnId(id)) return () => undefined;
    if (this.recoveryUnavailable) return () => undefined;
    let record: HomeMediaActionTurnRecord | undefined;
    let replay: readonly HomeMediaActionTurnEvent[];
    try {
      record = this.store.get(id);
      replay = record === undefined ? [] : this.store.events(id, afterSeq);
    } catch {
      this.failClosedUnavailable();
      return () => undefined;
    }
    if (record === undefined) return () => undefined;
    let subscribed = false;
    if (!isTerminal(record.status)) {
      if (this.subscriptionCount >= this.maxSubscriptions) {
        throw new Error("Home media action subscription limit reached");
      }
      let listeners = this.subscribers.get(id);
      if (listeners === undefined) {
        listeners = new Set();
        this.subscribers.set(id, listeners);
      }
      listeners.add(listener);
      subscribed = true;
      this.subscriptionCount += 1;
    }
    for (const event of replay) notify(listener, event);
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const listeners = this.subscribers.get(id);
      if (listeners?.delete(listener) === true) this.subscriptionCount -= 1;
      if (listeners?.size === 0) this.subscribers.delete(id);
    };
  }

  /** Revokes only a still-running model scope. A durable review ticket remains owned by Review Center. */
  cancel(id: string): boolean {
    if (!isMediaActionTurnId(id)) return false;
    if (this.recoveryUnavailable) return false;
    const active = this.active;
    if (active === undefined || active.id !== id) return false;
    try {
      const record = this.store.get(id);
      if (record?.status !== "running") return false;
      if (this.bindTicketForRequest(record)) return false;
    } catch {
      this.failClosedUnavailable();
      return false;
    }
    active.cancelRequested = true;
    active.controller.abort(new Error("Home media action was cancelled"));
    return true;
  }

  /**
   * Recovery never reuses an old actor or re-runs a model. It only binds a
   * ticket which OneShotActionPlane already persisted, or closes the turn.
   */
  recoverInterrupted(): void {
    if (this.closed) return;
    try {
      for (const record of this.store.recoverable()) {
        if (this.bindTicketForRequest(record)) continue;
        this.store.fail({ id: record.id, reason: "interrupted_before_action", transitionedAt: timestamp(this.clock) });
        this.publishLatest(record.id);
      }
    } catch {
      this.failClosedUnavailable();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = this.active;
    if (active !== undefined) {
      active.cancelRequested = true;
      active.controller.abort(new Error("Home media action owner stopped"));
      await active.settled;
    }
    this.subscribers.clear();
    this.subscriptionCount = 0;
    this.store.close?.();
  }

  private async run(
    active: ActiveTurn,
    actor: OneShotActionActor,
    question: string,
    agent: HomeMediaActionAgentPort,
    conversation: HomeMediaActionConversationPort,
  ): Promise<void> {
    const timeout = setTimeout(() => {
      active.timedOut = true;
      active.controller.abort(new Error("Home media action timed out"));
    }, this.actionTimeoutMs);
    try {
      const record = this.store.get(active.id);
      if (record?.status !== "running") return;
      const state = await conversation.runActionTurn(actor, record.requestId, () =>
        agent.requestMediaActionTurn(question, active.controller.signal), active.controller.signal);
      this.completeState(record, state, active.cancelRequested, active.timedOut);
    } catch {
      const record = this.store.get(active.id);
      if (record?.status === "running") {
        if (!this.bindTicketForRequest(record)) {
          if (active.cancelRequested) {
            this.store.cancel({ id: record.id, transitionedAt: timestamp(this.clock) });
          } else {
            this.store.fail({
              id: record.id,
              reason: active.timedOut ? "timed_out" : "agent_unavailable",
              transitionedAt: timestamp(this.clock),
            });
          }
          this.publishLatest(record.id);
        }
      }
    } finally {
      clearTimeout(timeout);
      if (this.active === active) this.active = undefined;
    }
  }

  private completeState(
    record: Extract<HomeMediaActionTurnRecord, { readonly status: "running" }>,
    state: HomeMediaConversationState,
    cancellationRequested: boolean,
    timedOut: boolean,
  ): void {
    if (cancellationRequested) {
      if (!this.bindTicketForRequest(record)) {
        this.store.cancel({ id: record.id, transitionedAt: timestamp(this.clock) });
        this.publishLatest(record.id);
      }
      return;
    }
    if (timedOut) {
      if (!this.bindTicketForRequest(record)) {
        this.store.fail({ id: record.id, reason: "timed_out", transitionedAt: timestamp(this.clock) });
        this.publishLatest(record.id);
      }
      return;
    }
    if (state.status === "clarification") {
      this.store.clarify({ id: record.id, clarification: state, transitionedAt: timestamp(this.clock) });
      this.publishLatest(record.id);
      return;
    }
    if ("ticketId" in state && typeof state.ticketId === "string") {
      const ticket = this.reviewCenter?.getActionTicketForRequest(record.requestId);
      if (ticket !== undefined && ticket.id === state.ticketId && ticket.requestId === record.requestId) {
        this.store.ticket({ id: record.id, ticketId: ticket.id, transitionedAt: timestamp(this.clock) });
        this.publishLatest(record.id);
        return;
      }
    }
    if (this.bindTicketForRequest(record)) return;
    this.store.fail({ id: record.id, reason: "invalid_result", transitionedAt: timestamp(this.clock) });
    this.publishLatest(record.id);
  }

  private bindTicketForRequest(record: Extract<HomeMediaActionTurnRecord, { readonly status: "running" }>): boolean {
    const ticket = this.reviewCenter?.getActionTicketForRequest(record.requestId);
    if (ticket === undefined || ticket.requestId !== record.requestId) return false;
    const changed = this.store.ticket({ id: record.id, ticketId: ticket.id, transitionedAt: timestamp(this.clock) });
    if (changed) this.publishLatest(record.id);
    return changed;
  }

  private project(record: HomeMediaActionTurnRecord): HomeMediaActionTurnProjection {
    if (record.status !== "ticket") return record;
    const ticket = this.reviewCenter?.getActionTicket(record.ticketId);
    if (ticket === undefined) return { ...record, status: "unavailable", reason: "ticket_missing" };
    if (ticket.requestId !== record.requestId) return { ...record, status: "corrupted", reason: "ticket_request_mismatch" };
    return { ...record, status: "ticket", ticket };
  }

  private requireProjection(id: string): HomeMediaActionTurnProjection {
    const projection = this.get(id);
    if (projection === undefined) throw new Error("Home media action turn was not persisted");
    return projection;
  }

  private failClosedUnavailable(): void {
    this.recoveryUnavailable = true;
    const active = this.active;
    if (active !== undefined && !active.controller.signal.aborted) {
      active.controller.abort(new Error("Home media action persistence is unavailable"));
    }
  }

  private publishLatest(id: string): void {
    const event = this.store.events(id).at(-1);
    if (event === undefined) return;
    const listeners = this.subscribers.get(id);
    for (const listener of listeners ?? []) notify(listener, event);
    const record = this.store.get(id);
    if (record !== undefined && isTerminal(record.status) && listeners !== undefined) {
      this.subscriptionCount -= listeners.size;
      this.subscribers.delete(id);
    }
  }
}

function asAgent(value: unknown): HomeMediaActionAgentPort | undefined {
  return isRecord(value)
    && (value.observationStatus === "idle" || value.observationStatus === "running")
    && typeof value.requestMediaActionTurn === "function"
    ? value as unknown as HomeMediaActionAgentPort
    : undefined;
}

function asConversation(value: unknown): HomeMediaActionConversationPort | undefined {
  return isRecord(value) && typeof value.runActionTurn === "function"
    ? value as unknown as HomeMediaActionConversationPort
    : undefined;
}

function asReviewCenter(value: unknown): HomeMediaActionReviewPort | undefined {
  return isRecord(value)
    && typeof value.getActionTicket === "function"
    && typeof value.getActionTicketForRequest === "function"
    ? value as unknown as HomeMediaActionReviewPort
    : undefined;
}

function boundedQuestion(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_QUESTION_LENGTH || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new TypeError("Home media action question is invalid");
  }
  return value;
}

function boundedIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/u.test(value)) {
    throw new TypeError("Home media action idempotency key is invalid");
  }
  return value;
}

function isMediaActionTurnId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 180
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function assertPresentActor(value: unknown): asserts value is OneShotActionActor {
  if (!isRecord(value)
    || typeof value.principalId !== "string" || value.principalId.length === 0
    || !isActorRole(value.role) || value.present !== true
    || !isRecord(value.device) || (value.device.kind !== "private" && value.device.kind !== "shared")) {
    throw new TypeError("an authenticated present actor is required");
  }
}

function isActorRole(value: unknown): boolean {
  return value === "admin" || value === "adult_member" || value === "member" || value === "child" || value === "guest";
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 300_000) {
    throw new TypeError(`${name} must be from 1 to 300000 milliseconds`);
  }
  return value as number;
}

function timestamp(clock: () => string): string {
  const value = clock();
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError("Home media action clock returned an invalid timestamp");
  return value;
}

function validateCursor(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("Invalid home media action event cursor");
}

function isTerminal(status: HomeMediaActionTurnRecord["status"]): boolean {
  return status === "clarification" || status === "ticket" || status === "failed" || status === "cancelled";
}

function copyEvent(event: HomeMediaActionTurnEvent): HomeMediaActionTurnEvent {
  return { ...event };
}

function notify(listener: HomeMediaActionTurnListener, event: HomeMediaActionTurnEvent): void {
  try {
    listener(copyEvent(event));
  } catch {
    // A product subscriber cannot change the durable action lifecycle.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
