import { classifyProviderFailure } from "./provider-failover.js";

export interface ProviderProbeResult { model: string; status: "ok" | "auth" | "rate_limit" | "billing" | "timeout" | "format" | "overloaded" | "unknown"; latencyMs: number; }

/** Explicit live probe: no content or credential material is persisted in its result. */
export async function probeProvider(model: string, execute: () => Promise<unknown>, clock: () => number = Date.now): Promise<ProviderProbeResult> {
  const startedAt = clock();
  try {
    await execute();
    return { model, status: "ok", latencyMs: clock() - startedAt };
  } catch (error) {
    return { model, status: classifyProviderFailure(error), latencyMs: clock() - startedAt };
  }
}
