import {
  createUserMessage,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";

import { providerSetup, type SupportedModelProvider } from "./model-providers.js";
import { probeProvider, type ProviderProbeResult } from "./provider-probe.js";

export interface LiveProbeModels {
  resolveModelInfo(
    providerId: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}

/**
 * Explicitly sends the smallest supported text request through the DSH LLM
 * runtime. The response is immediately discarded; only ProbeResult is
 * returned, so callers must show a cost warning before invoking this.
 */
export async function probeLiveProvider(
  provider: SupportedModelProvider,
  modelId: string,
  createRuntime: () => LiveProbeModels | Promise<LiveProbeModels>,
  clock: () => number = Date.now,
  signal?: AbortSignal,
): Promise<ProviderProbeResult> {
  const setup = providerSetup(provider);
  return probeProvider(`${provider}/${modelId}`, async () => {
    const models = await createRuntime();
    await models.resolveModelInfo(setup.runtimeProviderId, modelId, signal);
    const options: GenerateOptions = {
      provider: setup.runtimeProviderId,
      model: modelId,
      messages: [createUserMessage({
        content: [{ type: "text", text: "Reply with exactly: OK" }],
        source: { kind: "user" },
      })],
      maxTokens: 1,
      ...(signal === undefined ? {} : { signal }),
    };
    let finished = false;
    for await (const chunk of models.stream(options)) {
      if (chunk.type !== "finish") continue;
      finished = true;
      if (
        chunk.reason.kind === "stop" ||
        chunk.reason.kind === "max-tokens" ||
        chunk.reason.kind === "tool-calls"
      ) return;
      throw dshFailureError(chunk.reason);
    }
    if (!finished) throw new Error("DSH provider stream ended without a terminal finish");
  }, clock);
}

function dshFailureError(reason: Extract<StreamChunk, { type: "finish" }>['reason']): Error {
  if (reason.kind === "aborted") return new Error("DSH provider request timed out");
  if (reason.kind === "error") {
    const code = reason.failure.code.toUpperCase();
    if (reason.failure.status === 401 || reason.failure.status === 403 || code === "AUTH") {
      return new Error("DSH provider authentication failed (401)");
    }
    if (code.includes("RATE") || code.includes("QUOTA")) return new Error("DSH provider rate limit exceeded");
    if (code.includes("TIMEOUT")) return new Error("DSH provider request timed out");
    if (code.includes("OVERLOAD") || code.includes("CAPACITY")) return new Error("DSH provider overloaded");
    if (code.includes("INVALID") || code.includes("UNSUPPORTED") || code.includes("FORMAT")) {
      return new Error("DSH provider returned an invalid request");
    }
  }
  return new Error("DSH provider request failed");
}
