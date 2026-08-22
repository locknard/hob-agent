import { classifyProviderFailure, shouldTryNextProfile } from "./provider-failover.js";

export interface FallbackResult<T> { selectedModel: string; respondingModel: string; value: T; }

/** Turn-local fallback adapted from OpenClaw: the selected model is never mutated. */
export async function runWithModelFallback<T>(models: string[], execute: (model: string) => Promise<T>): Promise<FallbackResult<T>> {
  if (models.length === 0) throw new Error("At least one model is required");
  const selectedModel = models[0]!;
  let lastError: unknown;
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]!;
    try { return { selectedModel, respondingModel: model, value: await execute(model) }; }
    catch (error) {
      lastError = error;
      if (!shouldTryNextProfile(classifyProviderFailure(error)) || index === models.length - 1) throw error;
    }
  }
  throw lastError;
}
