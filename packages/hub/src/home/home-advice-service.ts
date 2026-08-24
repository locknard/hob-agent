import { Context, Service } from "@deepseek-ai/cordis";
import type { AgentLoopTrace } from "@hob-agent/agent-layer/agent-loop-trace";
import type { HomeAdviceReport } from "@hob-agent/agent-layer/home-advice-report";

import {
  SqliteHomeAdviceStore,
  validateHomeAdviceQuestion,
  type HomeAdviceCompletionNotification,
  type HomeAdviceProgressData,
  type HomeAdviceProgressEvent,
  type HomeAdviceProgressType,
  type HomeAdviceRecord,
  type HomeAdviceStore,
  type SqliteHomeAdviceStoreOptions,
} from "./home-advice-store.js";
import { isHomeWorldReady } from "./home-observation-scheduler.js";
import type { OneShotActionActor } from "../authority/one-shot-action-plane.js";

export type {
  HomeAdviceCompletionNotification,
  HomeAdviceProgressData,
  HomeAdviceProgressEvent,
  HomeAdviceProgressType,
} from "./home-advice-store.js";

interface AdviceAgentPort {
  readonly observationStatus: "idle" | "running";
  /** The mounted Home Agent projects its Hub-owned resolver status without exposing provider details. */
  readonly modelStatus?: { readonly state: "active" | "degraded" | "retrying" | "switching" };
  requestAdvice(question: string, signal?: AbortSignal): Promise<HomeAdviceReport>;
  /** Safe, already-redacted DSH metadata. Prompt text and tool payloads are never exposed here. */
  traceSnapshot?(): AgentLoopTrace | undefined;
}

interface AdviceWorldPort {
  snapshot(): Parameters<typeof isHomeWorldReady>[0];
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeAdvice: HomeAdviceService;
  }
}

export type HomeAdviceAvailability =
  | { readonly status: "ready" }
  | { readonly status: "setup_required" }
  | { readonly status: "home_connecting" }
  | { readonly status: "agent_busy" }
  | { readonly status: "active_request"; readonly activeAdviceId: string }
  | { readonly status: "model_unavailable" }
  | { readonly status: "stopped" };

export type HomeAdviceProgressListener = (event: HomeAdviceProgressEvent) => void;

export class HomeAdviceUnavailableError extends Error {
  readonly code: HomeAdviceAvailability["status"];
  readonly availability: HomeAdviceAvailability;
  readonly activeAdviceId?: string;

  constructor(availability: HomeAdviceAvailability) {
    super(`Home advice cannot start: ${availability.status}`);
    this.name = "HomeAdviceUnavailableError";
    this.code = availability.status;
    this.availability = availability;
    if (availability.status === "active_request") this.activeAdviceId = availability.activeAdviceId;
  }
}

export interface HomeAdviceServiceOptions extends SqliteHomeAdviceStoreOptions {
  readonly store?: HomeAdviceStore & { close?: () => void };
  readonly clock?: () => string;
  /** Polls the redacted DSH trace only while an advice request is running. */
  readonly progressPollIntervalMs?: number;
  /** Bounds the low-frequency wait for a ready owner after startup. */
  readonly backgroundRecoveryIntervalMs?: number;
  readonly maxProgressStreams?: number;
}

interface ActiveAdvice {
  readonly id: string;
  readonly question: string;
  readonly controller: AbortController;
  readonly traceToolIds: Set<string>;
  readonly progressTypes: Set<HomeAdviceProgressType>;
  backgrounded: boolean;
  cancelRequested: boolean;
  preserveBackgroundOnShutdown: boolean;
  removeExternalAbort: () => void;
}

type HomeAdviceNonTerminalProgressType = Exclude<HomeAdviceProgressType, "completed" | "failed" | "cancelled">;

const TOOL_PROGRESS: Readonly<Record<string, HomeAdviceNonTerminalProgressType>> = {
  get_home_inventory: "reading_inventory",
  get_home_snapshot: "inspecting_home",
  get_home_activity: "evaluating_evidence",
  get_home_calibration: "evaluating_evidence",
  get_home_evidence: "evaluating_evidence",
  get_home_history: "evaluating_evidence",
  get_home_causality: "causality",
  get_home_rules: "checking_rules",
  report_home_advice: "composing_answer",
};

/** Hub-owned lifecycle for explicit, persisted, non-executing advice requests. */
export class HomeAdviceService extends Service {
  private readonly store: HomeAdviceStore & { close?: () => void };
  private readonly clock: () => string;
  private readonly progressPollIntervalMs: number;
  private readonly backgroundRecoveryIntervalMs: number;
  private readonly maxProgressStreams: number;
  /** Ephemeral fanout only; durable replay remains owned by the store. */
  private readonly progressSubscribers = new Map<string, Set<HomeAdviceProgressListener>>();
  private active: ActiveAdvice | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(ctx: Context, options: HomeAdviceServiceOptions) {
    super(ctx, "homeAdvice");
    this.store = options.store ?? new SqliteHomeAdviceStore(options);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.progressPollIntervalMs = boundedOption(
      options.progressPollIntervalMs ?? 100,
      "home advice progress poll interval",
      1,
      10_000,
    );
    this.backgroundRecoveryIntervalMs = boundedOption(
      options.backgroundRecoveryIntervalMs ?? 1_000,
      "home advice background recovery interval",
      1,
      60_000,
    );
    this.maxProgressStreams = boundedOption(
      options.maxProgressStreams ?? 128,
      "home advice progress stream limit",
      1,
      1_024,
    );
  }

  protected [Service.init](): void {
    queueMicrotask(() => {
      this.scheduleBackgroundRecovery(0);
    });
    this.ctx.effect(() => () => {
      this.closed = true;
      if (this.recoveryTimer !== undefined) {
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = undefined;
      }
      const active = this.active;
      if (active !== undefined) {
        const record = this.store.get(active.id);
        if (record?.status === "background") {
          active.preserveBackgroundOnShutdown = true;
        } else {
          active.cancelRequested = true;
        }
        active.controller.abort();
      }
      this.progressSubscribers.clear();
      this.store.close?.();
    }, "home-advice.close");
  }

  availability(): HomeAdviceAvailability {
    if (this.closed) return { status: "stopped" };
    const active = this.active;
    if (active !== undefined) return { status: "active_request", activeAdviceId: active.id };
    const world = this.ctx.get("homeWorld") as unknown as AdviceWorldPort | undefined;
    const agent = this.ctx.get("homeAgent") as unknown as AdviceAgentPort | undefined;
    if (world === undefined || agent === undefined) return { status: "setup_required" };
    if (!isHomeWorldReady(world.snapshot())) return { status: "home_connecting" };
    if (agent.modelStatus?.state === "degraded" || agent.modelStatus?.state === "retrying") {
      return { status: "model_unavailable" };
    }
    if (agent.observationStatus !== "idle") return { status: "agent_busy" };
    return { status: "ready" };
  }

  canAsk(): boolean {
    return this.availability().status === "ready";
  }

  activeRequestId(): string | undefined {
    return this.active?.id;
  }

  /**
   * Persists a running request and returns immediately. The DSH turn is owned
   * by the Hub background lifecycle and never runs in the HTTP request path.
   */
  async ask(
    question: string,
    signalOrActor?: AbortSignal | OneShotActionActor,
    actor?: OneShotActionActor,
  ): Promise<HomeAdviceRecord> {
    const signal = isAbortSignal(signalOrActor) ? signalOrActor : undefined;
    if (signalOrActor !== undefined && signal === undefined && !isPresentActor(signalOrActor)) {
      throw new TypeError("an authenticated present actor is required");
    }
    const authenticatedActor = actor ?? (isPresentActor(signalOrActor) ? signalOrActor : undefined);
    if (authenticatedActor !== undefined && !isPresentActor(authenticatedActor)) {
      throw new TypeError("an authenticated present actor is required");
    }
    const boundedQuestion = validateHomeAdviceQuestion(question);
    if (signal?.aborted) throw new Error("Home advice was cancelled");
    const availability = this.availability();
    if (availability.status !== "ready") throw new HomeAdviceUnavailableError(availability);
    const agent = this.ctx.get("homeAgent") as unknown as AdviceAgentPort | undefined;
    if (agent === undefined) throw new HomeAdviceUnavailableError({ status: "setup_required" });
    const createdAt = timestamp(this.clock);
    const id = this.store.begin({ question: boundedQuestion, createdAt });
    const controller = new AbortController();
    const active: ActiveAdvice = {
      id,
      question: boundedQuestion,
      controller,
      traceToolIds: new Set(),
      progressTypes: new Set(["accepted"]),
      backgrounded: false,
      cancelRequested: false,
      preserveBackgroundOnShutdown: false,
      removeExternalAbort: () => undefined,
    };
    if (signal !== undefined) {
      const onAbort = () => {
        active.cancelRequested = true;
        controller.abort();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      active.removeExternalAbort = () => signal.removeEventListener("abort", onAbort);
    }
    this.active = active;
    this.emit(id, "accepted", createdAt);
    void this.run(active, agent);
    const running = this.store.get(id);
    if (running?.status !== "running") throw new Error("Home advice request was not accepted");
    return running;
  }

  /** Moves the active turn to a durable background owner without changing its id. */
  background(id: string): boolean {
    const active = this.active;
    if (active === undefined || active.id !== id) return false;
    const record = this.store.get(id);
    if (record?.status !== "running") return false;
    const backgroundAt = timestamp(this.clock);
    if (!this.store.background({ id, backgroundAt })) return false;
    active.backgrounded = true;
    this.publishStoredEvent(id);
    return true;
  }

  cancel(id: string): boolean {
    const active = this.active;
    if (active === undefined || active.id !== id) return false;
    const status = this.store.get(id)?.status;
    if (status !== "running" && status !== "background") return false;
    active.cancelRequested = true;
    active.controller.abort();
    return true;
  }

  get(id: string): HomeAdviceRecord | undefined {
    return this.store.get(id);
  }

  list(query?: { readonly limit?: number }): readonly HomeAdviceRecord[] {
    return this.store.list(query);
  }

  events(id: string, afterSeq = 0): readonly HomeAdviceProgressEvent[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new TypeError("Invalid home advice progress cursor");
    return this.store.events(id, afterSeq).map(copyEvent);
  }

  subscribe(id: string, listener: HomeAdviceProgressListener, afterSeq = 0): () => void {
    if (typeof listener !== "function") throw new TypeError("Home advice progress listener is required");
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new TypeError("Invalid home advice progress cursor");
    for (const event of this.store.events(id, afterSeq)) notify(listener, event);
    const current = this.store.get(id);
    if (current === undefined || isTerminalStatus(current.status)) return () => undefined;
    let listeners = this.progressSubscribers.get(id);
    if (listeners === undefined) {
      while (this.progressSubscribers.size >= this.maxProgressStreams) {
        const oldest = this.progressSubscribers.keys().next().value;
        if (typeof oldest !== "string") break;
        this.progressSubscribers.delete(oldest);
      }
      listeners = new Set();
      this.progressSubscribers.set(id, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.progressSubscribers.delete(id);
    };
  }

  peekNextCompletionNotification(): HomeAdviceCompletionNotification | undefined {
    return this.store.peekNextCompletionNotification();
  }

  acknowledgeCompletionNotification(id: string): boolean {
    return this.store.acknowledgeCompletionNotification(id);
  }

  /** Reattaches one durable background turn to the current Agent owner. */
  recoverBackground(): boolean {
    if (this.closed || this.active !== undefined) return false;
    const world = this.ctx.get("homeWorld") as unknown as AdviceWorldPort | undefined;
    const agent = this.ctx.get("homeAgent") as unknown as AdviceAgentPort | undefined;
    if (world === undefined
      || agent === undefined
      || !isHomeWorldReady(world.snapshot())
      || agent.modelStatus?.state === "degraded"
      || agent.modelStatus?.state === "retrying"
      || agent.observationStatus !== "idle") {
      return false;
    }
    const record = this.store.list({ limit: 1, status: "background" })[0];
    if (record === undefined || record.status !== "background") return false;
    const active: ActiveAdvice = {
      id: record.id,
      question: record.question,
      controller: new AbortController(),
      traceToolIds: new Set(),
      progressTypes: new Set(this.store.events(record.id).map((event) => event.type)),
      backgrounded: true,
      cancelRequested: false,
      preserveBackgroundOnShutdown: false,
      removeExternalAbort: () => undefined,
    };
    this.active = active;
    void this.run(active, agent);
    return true;
  }

  private scheduleBackgroundRecovery(delayMs: number): void {
    if (this.closed || this.recoveryTimer !== undefined) return;
    if (this.store.list({ limit: 1, status: "background" }).length === 0) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (this.closed) return;
      if (this.active !== undefined || !this.recoverBackground()) {
        this.scheduleBackgroundRecovery(this.backgroundRecoveryIntervalMs);
      }
    }, delayMs);
  }

  private async run(active: ActiveAdvice, agent: AdviceAgentPort): Promise<void> {
    const baseline = agent.traceSnapshot?.();
    for (const tool of baseline?.tools ?? []) active.traceToolIds.add(tool.id);
    const timer = agent.traceSnapshot === undefined
      ? undefined
      : setInterval(() => this.captureTrace(active, agent), this.progressPollIntervalMs);
    try {
      const report = await agent.requestAdvice(active.question, active.controller.signal);
      // Capture the terminal redacted trace before the report closes the
      // durable lifecycle; this catches a completed causality call that lands
      // between two polling ticks.
      this.captureTrace(active, agent);
      if (active.preserveBackgroundOnShutdown) return;
      if (active.cancelRequested || active.controller.signal.aborted) {
        this.finishFailed(active, "cancelled");
        return;
      }
      const completedAt = timestamp(this.clock);
      if (this.store.complete({ id: active.id, report, completedAt })) this.publishStoredEvent(active.id);
    } catch {
      this.captureTrace(active, agent);
      if (active.preserveBackgroundOnShutdown) return;
      this.finishFailed(active, active.cancelRequested || active.controller.signal.aborted ? "cancelled" : "failed");
    } finally {
      if (timer !== undefined) clearInterval(timer);
      active.removeExternalAbort();
      if (this.active?.id === active.id) this.active = undefined;
      this.scheduleBackgroundRecovery(this.backgroundRecoveryIntervalMs);
    }
  }

  private finishFailed(active: ActiveAdvice, eventType: "failed" | "cancelled"): void {
    if (active.preserveBackgroundOnShutdown) return;
    let completedAt: string | undefined;
    try {
      const status = this.store.get(active.id)?.status;
      if (status === "running" || status === "background") {
        completedAt = timestamp(this.clock);
        if (this.store.fail({ id: active.id, completedAt, eventType })) this.publishStoredEvent(active.id);
      }
    } catch {
      // Preserve the request boundary even if persistence is already closing.
    }
  }

  private captureTrace(active: ActiveAdvice, agent: AdviceAgentPort): void {
    const trace = agent.traceSnapshot?.();
    if (trace === undefined || trace.sessionId.length === 0) return;
    for (const tool of trace.tools) {
      // A causal explanation is evidence only after the governed tool has
      // completed. Keep the id unclaimed while running so a later completed
      // snapshot can produce the one durable marker; failed calls stay absent.
      if (tool.name === "get_home_causality" && tool.status !== "completed") continue;
      if (active.traceToolIds.has(tool.id)) continue;
      active.traceToolIds.add(tool.id);
      const progressType = TOOL_PROGRESS[tool.name];
      if (progressType === undefined || active.progressTypes.has(progressType)) continue;
      active.progressTypes.add(progressType);
      this.emit(active.id, progressType);
    }
  }

  private emit(
    id: string,
    type: Exclude<HomeAdviceProgressType, "completed" | "failed" | "cancelled">,
    at?: string,
  ): void {
    if (this.closed) return;
    const eventAt = at ?? safeTimestamp(this.clock);
    if (eventAt === undefined) return;
    this.store.appendProgress({ id, type, at: eventAt });
    this.publishStoredEvent(id);
  }

  private publishStoredEvent(id: string): void {
    if (this.closed) return;
    const event = this.store.events(id).at(-1);
    if (event === undefined) return;
    const listeners = this.progressSubscribers.get(id);
    if (listeners !== undefined) {
      for (const listener of listeners) notify(listener, event);
    }
    if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") {
      this.progressSubscribers.delete(id);
    }
  }
}

function notify(listener: HomeAdviceProgressListener, event: HomeAdviceProgressEvent): void {
  try {
    listener(copyEvent(event));
  } catch {
    // A disconnected stream must not affect the Hub lifecycle.
  }
}

function copyEvent(event: HomeAdviceProgressEvent): HomeAdviceProgressEvent {
  return { id: event.id, type: event.type, data: { ...event.data } };
}

function isTerminalStatus(status: HomeAdviceRecord["status"]): status is "completed" | "failed" {
  return status === "completed" || status === "failed";
}

function boundedOption(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be from ${minimum} to ${maximum}`);
  }
  return value;
}

function timestamp(clock: () => string): string {
  const value = clock();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("Home advice clock must return an ISO timestamp");
  }
  return value;
}

function safeTimestamp(clock: () => string): string | undefined {
  try {
    return timestamp(clock);
  } catch {
    return undefined;
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object"
    && value !== null
    && typeof (value as { aborted?: unknown }).aborted === "boolean"
    && typeof (value as { addEventListener?: unknown }).addEventListener === "function";
}

function isPresentActor(value: unknown): value is OneShotActionActor {
  return typeof value === "object"
    && value !== null
    && typeof (value as { principalId?: unknown }).principalId === "string"
    && (value as { principalId: string }).principalId.length > 0
    && ((value as { role?: unknown }).role === "admin"
      || (value as { role?: unknown }).role === "adult_member"
      || (value as { role?: unknown }).role === "member"
      || (value as { role?: unknown }).role === "child"
      || (value as { role?: unknown }).role === "guest")
    && (value as { present?: unknown }).present === true
    && typeof (value as { device?: unknown }).device === "object"
    && (value as { device: { kind?: unknown } }).device !== null
    && ((value as { device: { kind?: unknown } }).device.kind === "private"
      || (value as { device: { kind?: unknown } }).device.kind === "shared");
}
