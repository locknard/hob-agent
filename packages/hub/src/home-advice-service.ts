import { Context, Service } from "@deepseek-ai/cordis";
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
}

interface AdviceWorldPort {
  snapshot(): Parameters<typeof isHomeWorldReady>[0];
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeAdvice: HomeAdviceService;
  }
}

export interface HomeAdviceServiceOptions extends SqliteHomeAdviceStoreOptions {
  readonly store?: HomeAdviceStore & { close?: () => void };
  readonly clock?: () => string;
}

/** Hub-owned lifecycle for explicit, persisted, non-executing advice requests. */
export class HomeAdviceService extends Service {
  private readonly store: HomeAdviceStore & { close?: () => void };
  private readonly clock: () => string;
  private inFlight = false;

  constructor(ctx: Context, options: HomeAdviceServiceOptions) {
    super(ctx, "homeAdvice");
    this.store = options.store ?? new SqliteHomeAdviceStore(options);
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  protected [Service.init](): void {
    this.ctx.effect(() => () => this.store.close?.(), "home-advice.close");
  }

  canAsk(): boolean {
    const world = this.ctx.get("homeWorld") as unknown as AdviceWorldPort | undefined;
    const agent = this.ctx.get("homeAgent") as unknown as AdviceAgentPort | undefined;
    return world !== undefined
      && agent !== undefined
      && !this.inFlight
      && agent.observationStatus === "idle"
      && isHomeWorldReady(world.snapshot());
  }

  async ask(question: string, signal?: AbortSignal): Promise<HomeAdviceRecord> {
    const boundedQuestion = validateHomeAdviceQuestion(question);
    const world = this.ctx.get("homeWorld") as unknown as AdviceWorldPort | undefined;
    const agent = this.ctx.get("homeAgent") as unknown as AdviceAgentPort | undefined;
    if (world === undefined || agent === undefined) throw new Error("Home advice is unavailable");
    if (!isHomeWorldReady(world.snapshot())) throw new Error("Home advice requires a ready home");
    if (this.inFlight || agent.observationStatus !== "idle") throw new Error("Home advice Agent is busy");
    const createdAt = timestamp(this.clock);
    const id = this.store.begin({ question: boundedQuestion, createdAt });
    this.inFlight = true;
    try {
      const report = await agent.requestAdvice(boundedQuestion, signal);
      this.store.complete({ id, report, completedAt: timestamp(this.clock) });
      const completed = this.store.get(id);
      if (completed?.status !== "completed") throw new Error("Home advice completion is unavailable");
      return completed;
    } catch {
      try {
        this.store.fail({ id, completedAt: timestamp(this.clock) });
      } catch {
        // Preserve one redacted product error even if the local failure record cannot be updated.
      }
      throw new Error("Home advice request failed");
    } finally {
      this.inFlight = false;
    }
  }

  get(id: string): HomeAdviceRecord | undefined {
    return this.store.get(id);
  }

  list(query?: { readonly limit?: number }): readonly HomeAdviceRecord[] {
    return this.store.list(query);
  }
}

function timestamp(clock: () => string): string {
  const value = clock();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("Home advice clock must return an ISO timestamp");
  }
  return value;
}
