import { Context, Service } from "@deepseek-ai/cordis";

export interface HomeObservationSchedulerLike {
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface HomeObservationSchedulerOptions {
  readonly intervalMinutes: number;
  readonly runOnStart?: boolean;
  readonly readinessPollMs?: number;
  readonly scheduler?: HomeObservationSchedulerLike;
  readonly clock?: () => string;
}

export type HomeObservationOutcome =
  | "started"
  | "world_not_ready"
  | "proposal_pending"
  | "agent_busy"
  | "failed";

export interface HomeObservationStatus {
  readonly enabled: true;
  readonly intervalMinutes: number;
  readonly runOnStart: boolean;
  readonly state: "waiting" | "running" | "stopped";
  readonly lastAttempt?: { readonly at: string; readonly outcome: HomeObservationOutcome };
}

export interface ObservationPorts {
  homeWorld: {
    snapshot(): {
      readonly bridges: Readonly<Record<string, unknown>>;
      readonly bridgeWatermarks: readonly { readonly bridgeId: string }[];
      readonly diagnostics: readonly { readonly bridgeId: string; readonly connectionState: string }[];
    };
  };
  homeProposals: {
    list(query: { status: "pending_review"; limit: number }): readonly unknown[];
  };
  homeAgent: {
    readonly observationStatus: "idle" | "running";
    requestObservation(signal?: AbortSignal): Promise<void>;
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
  static inject = ["homeWorld", "homeProposals", "homeAgent"];

  private readonly scheduler: HomeObservationSchedulerLike;
  private readonly clock: () => string;
  private readonly intervalMinutes: number;
  private readonly intervalMs: number;
  private readonly readinessPollMs: number;
  private readonly runOnStart: boolean;
  private state: HomeObservationStatus["state"] = "waiting";
  private lastAttempt: HomeObservationStatus["lastAttempt"];
  private stopped = false;

  constructor(ctx: Context, options: HomeObservationSchedulerOptions) {
    super(ctx, "homeObservationScheduler");
    if (!options
      || !Number.isSafeInteger(options.intervalMinutes)
      || options.intervalMinutes < MIN_INTERVAL_MINUTES
      || options.intervalMinutes > MAX_INTERVAL_MINUTES) {
      throw new TypeError(`observation interval must be from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES} minutes`);
    }
    const readinessPollMs = options.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;
    if (!Number.isSafeInteger(readinessPollMs) || readinessPollMs < 1_000 || readinessPollMs > 300_000) {
      throw new TypeError("observation readiness poll must be from 1000 to 300000 milliseconds");
    }
    this.intervalMinutes = options.intervalMinutes;
    this.intervalMs = options.intervalMinutes * 60_000;
    this.readinessPollMs = readinessPollMs;
    this.runOnStart = options.runOnStart ?? false;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  protected [Service.init](): void {
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
    if (this.state === "running") return "agent_busy";
    if (this.stopped) return "failed";
    this.state = "running";
    let outcome: HomeObservationOutcome = "failed";
    try {
      outcome = await requestGovernedHomeObservation(this.ctx as unknown as ObservationPorts, signal);
      return outcome;
    } finally {
      this.lastAttempt = { at: observationTimestamp(this.clock), outcome };
      this.state = this.stopped ? "stopped" : "waiting";
    }
  }

  snapshot(): HomeObservationStatus {
    return {
      enabled: true,
      intervalMinutes: this.intervalMinutes,
      runOnStart: this.runOnStart,
      state: this.state,
      ...(this.lastAttempt === undefined ? {} : { lastAttempt: { ...this.lastAttempt } }),
    };
  }

  private async run(signal: AbortSignal): Promise<void> {
    if (this.runOnStart) {
      while (!signal.aborted) {
        const outcome = await this.observeNow(signal);
        if (outcome !== "world_not_ready") break;
        await this.scheduler.wait(this.readinessPollMs, signal);
      }
    }
    while (!signal.aborted) {
      await this.scheduler.wait(this.intervalMs, signal);
      if (!signal.aborted) await this.observeNow(signal);
    }
  }
}

/** Applies the shared Hub-owned gates to one explicit or scheduled observation. */
export async function requestGovernedHomeObservation(
  ctx: ObservationPorts,
  signal: AbortSignal = new AbortController().signal,
): Promise<HomeObservationOutcome> {
  try {
    if (signal.aborted) return "failed";
    if (!isHomeWorldReady(ctx.homeWorld.snapshot())) return "world_not_ready";
    if (ctx.homeProposals.list({ status: "pending_review", limit: 1 }).length > 0) {
      return "proposal_pending";
    }
    if (ctx.homeAgent.observationStatus !== "idle") return "agent_busy";
    await ctx.homeAgent.requestObservation(signal);
    return "started";
  } catch {
    return "failed";
  }
}

export function isHomeWorldReady(snapshot: ReturnType<ObservationPorts["homeWorld"]["snapshot"]>): boolean {
  const bridgeIds = Object.keys(snapshot.bridges);
  const watermarks = new Set(snapshot.bridgeWatermarks.map((item) => item.bridgeId));
  const diagnostics = new Map(snapshot.diagnostics.map((item) => [item.bridgeId, item.connectionState]));
  return bridgeIds.length > 0
    && bridgeIds.every((bridgeId) => diagnostics.get(bridgeId) === "ready" && watermarks.has(bridgeId));
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
