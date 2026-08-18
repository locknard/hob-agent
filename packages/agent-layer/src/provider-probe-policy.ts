import type { FailureReason } from "./auth-profiles.js";
import { classifyProviderFailure } from "./provider-failover.js";

export type ProviderProbePolicyReason = FailureReason | "aborted" | "cooldown" | "throttled";

export class ProviderProbePolicyError extends Error {
  readonly name = "ProviderProbePolicyError";

  constructor(readonly reason: ProviderProbePolicyReason) {
    super(`Provider probe blocked (${reason})`);
  }
}

export interface ProviderProbePolicyOptions {
  throttleMs?: number;
  timeoutMs?: number;
  cooldownMarginMs?: number;
  clock?: () => number;
}

export interface ProviderProbeRunOptions {
  cooldownUntil?: number;
  signal?: AbortSignal;
}

/**
 * Bounds explicit, potentially paid provider probes without retaining their
 * response or raw errors. Callers should return only an already-sanitized
 * probe result from `probe`.
 */
export class ProviderProbePolicy {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly lastStartedAt = new Map<string, number>();
  private readonly throttleMs: number;
  private readonly timeoutMs: number;
  private readonly cooldownMarginMs: number;
  private readonly clock: () => number;

  constructor(options: ProviderProbePolicyOptions = {}) {
    this.throttleMs = options.throttleMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.cooldownMarginMs = options.cooldownMarginMs ?? 5_000;
    this.clock = options.clock ?? Date.now;
  }

  run<T>(
    key: string,
    probe: (signal: AbortSignal) => Promise<T>,
    options: ProviderProbeRunOptions = {},
  ): Promise<T> {
    const active = this.inFlight.get(key);
    if (active) return active as Promise<T>;

    const now = this.clock();
    if (options.cooldownUntil !== undefined && options.cooldownUntil > now + this.cooldownMarginMs) {
      return Promise.reject(new ProviderProbePolicyError("cooldown"));
    }
    const previous = this.lastStartedAt.get(key);
    if (previous !== undefined && now - previous < this.throttleMs) {
      return Promise.reject(new ProviderProbePolicyError("throttled"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new ProviderProbePolicyError("aborted"));
    }

    this.lastStartedAt.set(key, now);
    const task = this.execute(probe, options.signal);
    this.inFlight.set(key, task);
    task.then(
      () => { if (this.inFlight.get(key) === task) this.inFlight.delete(key); },
      () => { if (this.inFlight.get(key) === task) this.inFlight.delete(key); },
    );
    return task;
  }

  private async execute<T>(probe: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    let cancellation: "aborted" | "timeout" | undefined;
    const onAbort = () => {
      cancellation = "aborted";
      controller.abort();
    };
    parent?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      cancellation = "timeout";
      controller.abort();
    }, this.timeoutMs);

    try {
      return await Promise.race([
        probe(controller.signal),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("probe cancelled")), { once: true });
        }),
      ]);
    } catch (error) {
      if (cancellation) throw new ProviderProbePolicyError(cancellation);
      throw new ProviderProbePolicyError(classifyProviderFailure(error));
    } finally {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onAbort);
    }
  }
}
