import { Context, Service } from "@deepseek-ai/cordis";
import type { AgentLoopTrace } from "@hob-agent/agent-layer/agent-loop-trace";
import type { HomeAdviceReport } from "@hob-agent/agent-layer/home-advice-report";

import {
  SqliteHomeAdviceStore,
  validateHomeAdviceQuestion,
  type HomeAdviceRecord,
  type HomeAdviceStore,
  type SqliteHomeAdviceStoreOptions,
} from "./home-advice-store.js";
import { isHomeWorldReady } from "./home-observation-scheduler.js";

interface AdviceAgentPort {
  readonly observationStatus: "idle" | "running";
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

export type HomeAdviceProgressType =
  | "accepted"
  | "inspecting_home"
  | "reading_inventory"
  | "checking_rules"
  | "evaluating_evidence"
  | "composing_answer"
  | "completed"
  | "failed"
  | "cancelled";

export interface HomeAdviceProgressData {
  readonly adviceId: string;
  readonly at: string;
  readonly stage: HomeAdviceProgressType;
}

export interface HomeAdviceProgressEvent {
  /** Monotonic per-advice SSE replay identifier. */
  readonly id: number;
  readonly type: HomeAdviceProgressType;
  readonly data: HomeAdviceProgressData;
}

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
  readonly maxProgressEventsPerAdvice?: number;
  readonly maxProgressStreams?: number;
}

interface ActiveAdvice {
  readonly id: string;
  readonly question: string;
  readonly controller: AbortController;
  readonly traceToolIds: Set<string>;
  readonly progressTypes: Set<HomeAdviceProgressType>;
  cancelRequested: boolean;
  removeExternalAbort: () => void;
}

interface ProgressLog {
  readonly events: HomeAdviceProgressEvent[];
  readonly listeners: Set<HomeAdviceProgressListener>;
  terminal: boolean;
}

const TOOL_PROGRESS: Readonly<Record<string, HomeAdviceProgressType>> = {
  get_home_inventory: "reading_inventory",
  get_home_snapshot: "inspecting_home",
  get_home_activity: "evaluating_evidence",
  get_home_calibration: "evaluating_evidence",
  get_home_evidence: "evaluating_evidence",
  get_home_rules: "checking_rules",
  report_home_advice: "composing_answer",
};

/** Hub-owned lifecycle for explicit, persisted, non-executing advice requests. */
export class HomeAdviceService extends Service {
  private readonly store: HomeAdviceStore & { close?: () => void };
  private readonly clock: () => string;
  private readonly progressPollIntervalMs: number;
  private readonly maxProgressEventsPerAdvice: number;
  private readonly maxProgressStreams: number;
  private readonly progressLogs = new Map<string, ProgressLog>();
  private active: ActiveAdvice | undefined;
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
    this.maxProgressEventsPerAdvice = boundedOption(
      options.maxProgressEventsPerAdvice ?? 64,
      "home advice progress event limit",
      1,
      256,
    );
    this.maxProgressStreams = boundedOption(
      options.maxProgressStreams ?? 128,
      "home advice progress stream limit",
      1,
      1_024,
    );
  }

  protected [Service.init](): void {
    this.ctx.effect(() => () => {
      this.closed = true;
      const active = this.active;
      if (active !== undefined) {
        active.cancelRequested = true;
        active.controller.abort();
      }
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
  async ask(question: string, signal?: AbortSignal): Promise<HomeAdviceRecord> {
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
      cancelRequested: false,
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

  cancel(id: string): boolean {
    const active = this.active;
    if (active === undefined || active.id !== id) return false;
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
    return (this.progressLogs.get(id)?.events ?? []).filter((event) => event.id > afterSeq).map(copyEvent);
  }

  subscribe(id: string, listener: HomeAdviceProgressListener, afterSeq = 0): () => void {
    if (typeof listener !== "function") throw new TypeError("Home advice progress listener is required");
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new TypeError("Invalid home advice progress cursor");
    const log = this.progressLogs.get(id);
    if (log === undefined) return () => undefined;
    for (const event of log.events) {
      if (event.id > afterSeq) notify(listener, event);
    }
    if (log.terminal) return () => undefined;
    log.listeners.add(listener);
    return () => log.listeners.delete(listener);
  }

  private async run(active: ActiveAdvice, agent: AdviceAgentPort): Promise<void> {
    const baseline = agent.traceSnapshot?.();
    for (const tool of baseline?.tools ?? []) active.traceToolIds.add(tool.id);
    const timer = agent.traceSnapshot === undefined
      ? undefined
      : setInterval(() => this.captureTrace(active, agent), this.progressPollIntervalMs);
    try {
      const report = await agent.requestAdvice(active.question, active.controller.signal);
      if (active.cancelRequested || active.controller.signal.aborted) {
        this.finishFailed(active, "cancelled");
        return;
      }
      const completedAt = timestamp(this.clock);
      this.store.complete({ id: active.id, report, completedAt });
      this.emit(active.id, "completed", completedAt);
    } catch {
      this.finishFailed(active, active.cancelRequested || active.controller.signal.aborted ? "cancelled" : "failed");
    } finally {
      if (timer !== undefined) clearInterval(timer);
      active.removeExternalAbort();
      if (this.active?.id === active.id) this.active = undefined;
    }
  }

  private finishFailed(active: ActiveAdvice, eventType: "failed" | "cancelled"): void {
    let completedAt: string | undefined;
    try {
      if (this.store.get(active.id)?.status === "running") {
        completedAt = timestamp(this.clock);
        this.store.fail({ id: active.id, completedAt });
      }
    } catch {
      // Preserve the request boundary even if persistence is already closing.
    }
    this.emit(active.id, eventType, completedAt);
  }

  private captureTrace(active: ActiveAdvice, agent: AdviceAgentPort): void {
    const trace = agent.traceSnapshot?.();
    if (trace === undefined || trace.sessionId.length === 0) return;
    for (const tool of trace.tools) {
      if (active.traceToolIds.has(tool.id)) continue;
      active.traceToolIds.add(tool.id);
      const progressType = TOOL_PROGRESS[tool.name];
      if (progressType === undefined || active.progressTypes.has(progressType)) continue;
      active.progressTypes.add(progressType);
      this.emit(active.id, progressType);
    }
  }

  private emit(id: string, type: HomeAdviceProgressType, at?: string): void {
    if (this.closed) return;
    const eventAt = at ?? safeTimestamp(this.clock);
    if (eventAt === undefined) return;
    let log = this.progressLogs.get(id);
    if (log === undefined) {
      while (this.progressLogs.size >= this.maxProgressStreams) {
        const oldest = this.progressLogs.keys().next().value;
        if (typeof oldest !== "string") break;
        this.progressLogs.delete(oldest);
      }
      log = { events: [], listeners: new Set(), terminal: false };
      this.progressLogs.set(id, log);
    }
    if (log.terminal) return;
    const event: HomeAdviceProgressEvent = {
      id: (log.events.at(-1)?.id ?? 0) + 1,
      type,
      data: { adviceId: id, at: eventAt, stage: type },
    };
    log.events.push(event);
    while (log.events.length > this.maxProgressEventsPerAdvice) log.events.shift();
    for (const listener of log.listeners) notify(listener, event);
    if (type === "completed" || type === "failed" || type === "cancelled") {
      log.terminal = true;
      log.listeners.clear();
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
