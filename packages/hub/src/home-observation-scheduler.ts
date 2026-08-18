import { Context, Service } from "@deepseek-ai/cordis";
import type { HomeObservationDisposition } from "@hob-agent/agent-layer/home-observation-report";

import type { ObservationTrigger } from "./observation-audit-store.js";
import type { ObservationRunMetrics } from "./observation-audit-store.js";

export interface HomeObservationSchedulerLike {
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface HomeObservationSchedulerOptions {
  readonly intervalMinutes?: number;
  readonly runOnStart?: boolean;
  readonly readinessPollMs?: number;
  readonly scheduler?: HomeObservationSchedulerLike;
  readonly clock?: () => string;
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
  private readonly intervalMinutes: number | undefined;
  private readonly intervalMs: number | undefined;
  private readonly readinessPollMs: number;
  private readonly runOnStart: boolean;
  private state: HomeObservationStatus["state"] = "waiting";
  private lastAttempt: HomeObservationStatus["lastAttempt"];
  private stopped = false;

  constructor(ctx: Context, options: HomeObservationSchedulerOptions = {}) {
    super(ctx, "homeObservationScheduler");
    if (options.intervalMinutes !== undefined
      && (!Number.isSafeInteger(options.intervalMinutes)
        || options.intervalMinutes < MIN_INTERVAL_MINUTES
        || options.intervalMinutes > MAX_INTERVAL_MINUTES)) {
      throw new TypeError(`observation interval must be from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES} minutes`);
    }
    if (options.runOnStart === true && options.intervalMinutes === undefined) {
      throw new TypeError("observation run-on-start requires a recurring interval");
    }
    const readinessPollMs = options.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;
    if (!Number.isSafeInteger(readinessPollMs) || readinessPollMs < 1_000 || readinessPollMs > 300_000) {
      throw new TypeError("observation readiness poll must be from 1000 to 300000 milliseconds");
    }
    this.intervalMinutes = options.intervalMinutes;
    this.intervalMs = options.intervalMinutes === undefined ? undefined : options.intervalMinutes * 60_000;
    this.readinessPollMs = readinessPollMs;
    this.runOnStart = options.runOnStart ?? false;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  protected [Service.init](): void {
    if (this.intervalMs === undefined) {
      this.ctx.effect(() => () => {
        this.stopped = true;
        this.state = "stopped";
      }, "home-observation-controller.stop");
      return;
    }
    const controller = new AbortController();
    const task = this.run(controller.signal).catch(() => undefined);
    this.ctx.effect(() => async () => {
      this.stopped = true;
      this.state = "stopped";
      controller.abort();
      await task;
    }, "home-observation-scheduler.stop");
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
    if (this.runOnStart) {
      while (!signal.aborted) {
        const outcome = await this.observeRecurring("startup", signal);
        if (outcome !== "world_not_ready") break;
        await this.scheduler.wait(this.readinessPollMs, signal);
      }
    }
    while (!signal.aborted) {
      await this.scheduler.wait(intervalMs, signal);
      if (!signal.aborted) await this.observeRecurring("scheduled", signal);
    }
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
