import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

import { providerSetup, type SupportedModelProvider } from "./model-providers.js";
import { probeProvider, type ProviderProbeResult } from "./provider-probe.js";

export interface LiveProbeModels {
  getModel(providerId: string, modelId: string): Model<Api> | undefined;
  completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<unknown>;
}

/**
 * Explicitly sends the smallest supported text request through a pi model
 * collection. The response is immediately discarded; only ProbeResult is
 * returned, so callers must show a cost warning before invoking this.
 */
export async function probeLiveProvider(
  provider: SupportedModelProvider,
  modelId: string,
  createModels: () => LiveProbeModels | Promise<LiveProbeModels>,
  clock: () => number = Date.now,
  signal?: AbortSignal,
): Promise<ProviderProbeResult> {
  const setup = providerSetup(provider);
  return probeProvider(`${provider}/${modelId}`, async () => {
    const models = await createModels();
    const model = models.getModel(setup.piProviderId, modelId);
    if (!model) throw new Error("Configured model is unavailable");
    await models.completeSimple(model, {
      messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: 0 }],
    }, signal ? { maxTokens: 1, signal } : { maxTokens: 1 });
  }, clock);
}
