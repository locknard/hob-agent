import type { SupportedModelProvider } from "./model-providers.js";

const SUPPORTED = new Set<SupportedModelProvider>(["gpt", "claude", "deepseek", "kimi", "glm"]);

export interface ModelReference {
  provider: SupportedModelProvider;
  modelId: string;
}

/** Parse the sole persisted model form; aliases and ambient defaults are not accepted. */
export function parseModelReference(value: string): ModelReference {
  const match = /^(?<provider>[^/\s]+)\/(?<model>[^/\s]+)$/.exec(value);
  if (!match?.groups) throw new Error(`Invalid model reference: ${value}`);
  if (!SUPPORTED.has(match.groups.provider as SupportedModelProvider)) {
    throw new Error(`Unsupported model provider: ${match.groups.provider}`);
  }
  return { provider: match.groups.provider as SupportedModelProvider, modelId: match.groups.model };
}
