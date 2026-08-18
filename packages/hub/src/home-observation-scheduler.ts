import { Context, Service } from "@deepseek-ai/cordis";

export interface HomeObservationSchedulerLike {
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface HomeObservationSchedulerOptions {
  readonly intervalMinutes: number;
  readonly runOnStart?: boolean;
  readonly readinessPollMs?: number;
  readonly scheduler?: HomeObservationSchedulerLike;
}

export type HomeObservationOutcome =
  | "started"
  | "world_not_ready"
  | "proposal_pending"
  | "agent_busy"
  | "failed";

interface ObservationPorts {
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
  private readonly intervalMs: number;
  private readonly readinessPollMs: number;
  private readonly runOnStart: boolean;

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
    this.intervalMs = options.intervalMinutes * 60_000;
    this.readinessPollMs = readinessPollMs;
    this.runOnStart = options.runOnStart ?? false;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  protected [Service.init](): void {
    const controller = new AbortController();
    const task = this.run(controller.signal).catch(() => undefined);
    this.ctx.effect(() => async () => {
      controller.abort();
      await task;
    }, "home-observation-scheduler.stop");
  }

  async observeNow(signal: AbortSignal = new AbortController().signal): Promise<HomeObservationOutcome> {
    if (signal.aborted) return "failed";
    const ctx = this.ctx as unknown as ObservationPorts;
    try {
      const snapshot = ctx.homeWorld.snapshot();
      const bridgeIds = Object.keys(snapshot.bridges);
      const watermarks = new Set(snapshot.bridgeWatermarks.map((item) => item.bridgeId));
      const diagnostics = new Map(snapshot.diagnostics.map((item) => [item.bridgeId, item.connectionState]));
      if (bridgeIds.length === 0
        || bridgeIds.some((bridgeId) => diagnostics.get(bridgeId) !== "ready" || !watermarks.has(bridgeId))) {
        return "world_not_ready";
      }
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
