import { Context, Service } from "@deepseek-ai/cordis";
import type { HomeObservationDisposition } from "@hob-agent/agent-layer/home-observation-report";

import type { ObservationTrigger } from "./observation-audit-store.js";
import type { ObservationRunMetrics } from "./observation-audit-store.js";

export interface HomeObservationSchedulerLike {
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface HomeObservationScheduleConfiguration {
  readonly enabled: boolean;
  readonly intervalMinutes?: number;
  readonly quietHours?: { readonly start: string; readonly end: string };
}

/**
 * The persisted onboarding record is the Hub-owned schedule source. The
 * scheduler reads it at startup and accepts the same typed shape for a live
 * update after the source has committed.
 */
export interface HomeObservationOnboardingPort {
  snapshot(): {
    readonly observation?: HomeObservationScheduleConfiguration;
  };
}

export interface HomeObservationSchedulerOptions {
  readonly intervalMinutes?: number;
  readonly quietHours?: { readonly start: string; readonly end: string };
  readonly runOnStart?: boolean;
  readonly readinessPollMs?: number;
  readonly scheduler?: HomeObservationSchedulerLike;
  readonly clock?: () => string;
  readonly onboarding?: HomeObservationOnboardingPort;
}

export type HomeObservationOutcome =
  | "proposal_created"
  | "no_proposal"
  | "world_not_ready"
  | "proposal_pending"
  | "agent_busy"
  | "failed";

export interface HomeObservationStatus {
  readonly enabled: boolean;
  readonly intervalMinutes?: number;
  readonly quietHours?: { readonly start: string; readonly end: string };
  readonly runOnStart: boolean;
  readonly state: "waiting" | "running" | "stopped";
  readonly lastAttempt?: {
    readonly at: string;
    readonly outcome: HomeObservationOutcome;
    readonly disposition?: HomeObservationDisposition;
    readonly metrics?: ObservationRunMetrics;
  };
}

export interface HomeObservationResult {
  readonly outcome: HomeObservationOutcome;
  readonly disposition?: HomeObservationDisposition;
  readonly metrics?: ObservationRunMetrics;
}

export interface ObservationPorts {
  homeWorld: {
    snapshot(): {
      readonly bridges: Readonly<Record<string, unknown>>;
      readonly bridgeWatermarks: readonly { readonly bridgeId: string }[];
      readonly diagnostics: readonly {
        readonly bridgeId: string;
        readonly connectionState: string;
        readonly currentProcessReadyAt?: string;
      }[];
    };
  };
  homeProposals: {
    list(query: { status: "pending_review"; limit: number }): readonly unknown[];
  };
  homeAgent: {
    readonly observationStatus: "idle" | "running";
    requestObservation(signal?: AbortSignal): Promise<HomeObservationDisposition | undefined>;
    observationMetrics?(): ObservationRunMetrics | undefined;
  };
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeObservationScheduler: HomeObservationSchedulerService;
  }
}

const MIN_INTERVAL_MINUTES = 60;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const DEFAULT_READINESS_POLL_MS = 30_000;

/** Hub-owned clock policy for optional DSH household observation turns. */
export class HomeObservationSchedulerService extends Service {
  static inject = ["homeWorld", "homeProposals", "homeAgent", "homeObservationAudit"];

  private readonly scheduler: HomeObservationSchedulerLike;
  private readonly clock: () => string;
  private readonly readinessPollMs: number;
  private intervalMinutes: number | undefined;
  private intervalMs: number | undefined;
  private quietHours: HomeObservationScheduleConfiguration["quietHours"];
  private runOnStart: boolean;
  private state: HomeObservationStatus["state"] = "waiting";
  private lastAttempt: HomeObservationStatus["lastAttempt"];
  private stopped = false;
  private initialized = false;
  private recurringController: AbortController | undefined;
  private readonly activeRuns = new Set<Promise<void>>();

  constructor(ctx: Context, options: HomeObservationSchedulerOptions = {}) {
    super(ctx, "homeObservationScheduler");
    const persisted = options.onboarding?.snapshot().observation;
    const initial = persisted === undefined
      ? {
          enabled: options.intervalMinutes !== undefined,
          ...(options.intervalMinutes === undefined ? {} : { intervalMinutes: options.intervalMinutes }),
          ...(options.quietHours === undefined ? {} : { quietHours: options.quietHours }),
        }
      : persisted;
    validateSchedule(initial);
    const runOnStart = persisted === undefined ? options.runOnStart ?? false : false;
    if (runOnStart && !initial.enabled) {
      throw new TypeError("observation run-on-start requires a recurring interval");
    }
    const readinessPollMs = options.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;
    if (!Number.isSafeInteger(readinessPollMs) || readinessPollMs < 1_000 || readinessPollMs > 300_000) {
      throw new TypeError("observation readiness poll must be from 1000 to 300000 milliseconds");
    }
    this.intervalMinutes = initial.enabled ? initial.intervalMinutes : undefined;
    this.intervalMs = this.intervalMinutes === undefined ? undefined : this.intervalMinutes * 60_000;
    this.quietHours = initial.quietHours;
    this.readinessPollMs = readinessPollMs;
    this.runOnStart = runOnStart;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  protected [Service.init](): void {
    this.initialized = true;
    this.startRecurring();
    this.ctx.effect(() => async () => {
      this.stopped = true;
      this.state = "stopped";
      this.stopRecurring();
      await Promise.all([...this.activeRuns]);
    }, "home-observation-scheduler.stop");
  }

  /** Applies a committed Hub-owned schedule to the live scheduler. */
  configure(configuration: HomeObservationScheduleConfiguration): void {
    validateSchedule(configuration);
    if (this.stopped) throw new Error("observation scheduler is stopped");
    this.intervalMinutes = configuration.enabled ? configuration.intervalMinutes : undefined;
    this.intervalMs = this.intervalMinutes === undefined ? undefined : this.intervalMinutes * 60_000;
    this.quietHours = configuration.quietHours;
    if (this.initialized) {
      this.stopRecurring();
      this.startRecurring();
    }
  }

  async observeNow(signal: AbortSignal = new AbortController().signal): Promise<HomeObservationOutcome> {
    return this.observeTriggered("manual", signal);
  }

  private async observeTriggered(
    trigger: ObservationTrigger,
    signal: AbortSignal,
  ): Promise<HomeObservationOutcome> {
    const startedAt = observationTimestamp(this.clock);
    const auditId = this.ctx.homeObservationAudit.begin({ trigger, startedAt });
    if (this.state === "running") {
      this.ctx.homeObservationAudit.complete({
        id: auditId,
        completedAt: observationTimestamp(this.clock),
        outcome: "agent_busy",
      });
      return "agent_busy";
    }
    if (this.stopped) {
      this.ctx.homeObservationAudit.complete({
        id: auditId,
        completedAt: observationTimestamp(this.clock),
        outcome: "failed",
      });
      return "failed";
    }
    this.state = "running";
    let result: HomeObservationResult = { outcome: "failed" };
    try {
      result = await requestGovernedHomeObservation(this.ctx as unknown as ObservationPorts, signal);
      return result.outcome;
    } finally {
      const completedAt = observationTimestamp(this.clock);
      try {
        this.ctx.homeObservationAudit.complete({ id: auditId, completedAt, ...result });
      } finally {
        this.lastAttempt = { at: completedAt, ...result };
        this.state = this.stopped ? "stopped" : "waiting";
      }
    }
  }

  snapshot(): HomeObservationStatus {
    return {
      enabled: this.intervalMinutes !== undefined,
      ...(this.intervalMinutes === undefined ? {} : { intervalMinutes: this.intervalMinutes }),
      ...(this.quietHours === undefined ? {} : { quietHours: { ...this.quietHours } }),
      runOnStart: this.runOnStart,
      state: this.state,
      ...(this.lastAttempt === undefined ? {} : { lastAttempt: { ...this.lastAttempt } }),
    };
  }

  private async observeRecurring(
    trigger: Exclude<ObservationTrigger, "manual" | "one_shot">,
    signal: AbortSignal,
  ): Promise<HomeObservationOutcome> {
    try {
      return await this.observeTriggered(trigger, signal);
    } catch {
      this.lastAttempt = { at: observationTimestamp(this.clock), outcome: "failed" };
      this.state = this.stopped ? "stopped" : "waiting";
      return "failed";
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    const intervalMs = this.intervalMs;
    if (intervalMs === undefined) return;
    if (this.runOnStart && !this.isQuietHours()) {
      while (!signal.aborted) {
        const outcome = await this.observeRecurring("startup", signal);
        if (outcome !== "world_not_ready") break;
        await this.scheduler.wait(this.readinessPollMs, signal);
      }
    }
    while (!signal.aborted) {
      await this.scheduler.wait(intervalMs, signal);
      if (!signal.aborted && !this.isQuietHours()) await this.observeRecurring("scheduled", signal);
    }
  }

  private isQuietHours(): boolean {
    if (this.quietHours === undefined) return false;
    const now = new Date(this.clock());
    if (!Number.isFinite(now.getTime())) return true;
    const current = now.getHours() * 60 + now.getMinutes();
    const start = clockMinutes(this.quietHours.start);
    const end = clockMinutes(this.quietHours.end);
    if (start === end) return false;
    return start < end ? current >= start && current < end : current >= start || current < end;
  }

  private startRecurring(): void {
    if (!this.initialized || this.stopped || this.intervalMs === undefined) return;
    const controller = new AbortController();
    this.recurringController = controller;
    const task = this.run(controller.signal).catch(() => undefined);
    this.activeRuns.add(task);
    task.then(() => this.activeRuns.delete(task), () => this.activeRuns.delete(task));
  }

  private stopRecurring(): void {
    this.recurringController?.abort();
    this.recurringController = undefined;
  }
}

/** Applies the shared Hub-owned gates to one explicit or scheduled observation. */
export async function requestGovernedHomeObservation(
  ctx: ObservationPorts,
  signal: AbortSignal = new AbortController().signal,
): Promise<HomeObservationResult> {
  let agentRequested = false;
  try {
    if (signal.aborted) return { outcome: "failed" };
    if (!isHomeWorldReady(ctx.homeWorld.snapshot())) return { outcome: "world_not_ready" };
    if (ctx.homeProposals.list({ status: "pending_review", limit: 1 }).length > 0) {
      return { outcome: "proposal_pending" };
    }
    if (ctx.homeAgent.observationStatus !== "idle") return { outcome: "agent_busy" };
    agentRequested = true;
    const disposition = await ctx.homeAgent.requestObservation(signal);
    const metrics = ctx.homeAgent.observationMetrics?.();
    return ctx.homeProposals.list({ status: "pending_review", limit: 1 }).length > 0
      ? { outcome: "proposal_created", ...(metrics === undefined ? {} : { metrics }) }
      : {
          outcome: "no_proposal",
          ...(disposition === undefined ? {} : { disposition }),
          ...(metrics === undefined ? {} : { metrics }),
        };
  } catch {
    const metrics = agentRequested ? ctx.homeAgent.observationMetrics?.() : undefined;
    return { outcome: "failed", ...(metrics === undefined ? {} : { metrics }) };
  }
}

export function isHomeWorldReady(snapshot: ReturnType<ObservationPorts["homeWorld"]["snapshot"]>): boolean {
  const bridgeIds = Object.keys(snapshot.bridges);
  const watermarks = new Set(snapshot.bridgeWatermarks.map((item) => item.bridgeId));
  const diagnostics = new Map(snapshot.diagnostics.map((item) => [item.bridgeId, item.connectionState]));
  const currentProcessReady = new Set(snapshot.diagnostics.flatMap((item) =>
    item.currentProcessReadyAt === undefined ? [] : [item.bridgeId]));
  return bridgeIds.length > 0
    && bridgeIds.every((bridgeId) => diagnostics.get(bridgeId) === "ready"
      && watermarks.has(bridgeId)
      && currentProcessReady.has(bridgeId));
}

const defaultScheduler: HomeObservationSchedulerLike = {
  wait(delayMs, signal) {
    return new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(finish, delayMs);
      function finish() {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      }
      signal.addEventListener("abort", finish, { once: true });
    });
  },
};

function observationTimestamp(clock: () => string): string {
  const value = clock();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("observation clock must return an ISO timestamp");
  }
  return value;
}

function validateSchedule(configuration: HomeObservationScheduleConfiguration): void {
  if (typeof configuration.enabled !== "boolean") {
    throw new TypeError("observation enabled flag must be boolean");
  }
  if (configuration.intervalMinutes !== undefined
    && (!Number.isSafeInteger(configuration.intervalMinutes)
      || configuration.intervalMinutes < MIN_INTERVAL_MINUTES
      || configuration.intervalMinutes > MAX_INTERVAL_MINUTES)) {
    throw new TypeError(`observation interval must be from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES} minutes`);
  }
  if (configuration.enabled && configuration.intervalMinutes === undefined) {
    throw new TypeError("enabled observation requires a recurring interval");
  }
  if (configuration.quietHours !== undefined
    && (!validClockTime(configuration.quietHours.start) || !validClockTime(configuration.quietHours.end))) {
    throw new TypeError("observation quiet hours must use HH:MM");
  }
}

function validClockTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function clockMinutes(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}
