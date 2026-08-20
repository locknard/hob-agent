export type SupportedModelProvider = "gpt" | "claude" | "deepseek" | "kimi" | "glm" | "custom";

export interface CustomModelDeployment {
  readonly baseURL: string;
}

export interface ProviderSetup {
  id: SupportedModelProvider;
  /** Provider route registered in the DSH LlmRuntime. */
  runtimeProviderId: string;
  /** DSH credential reference consumed by dsh-llm-pi-ai's apiKeyEnv field. */
  credentialEnv: string;
  /** Present only for an explicitly configured OpenAI-compatible custom route. */
  baseURL?: string;
}

const PROVIDERS: Record<SupportedModelProvider, ProviderSetup> = {
  gpt: { id: "gpt", runtimeProviderId: "openai", credentialEnv: "OPENAI_API_KEY" },
  claude: { id: "claude", runtimeProviderId: "anthropic", credentialEnv: "ANTHROPIC_API_KEY" },
  deepseek: { id: "deepseek", runtimeProviderId: "deepseek", credentialEnv: "DEEPSEEK_API_KEY" },
  kimi: { id: "kimi", runtimeProviderId: "moonshotai", credentialEnv: "MOONSHOT_API_KEY" },
  glm: { id: "glm", runtimeProviderId: "zai", credentialEnv: "ZAI_API_KEY" },
  custom: { id: "custom", runtimeProviderId: "hob-custom-openai", credentialEnv: "HOB_CUSTOM_MODEL_API_KEY" },
};

export function providerSetup(id: SupportedModelProvider, deployment?: CustomModelDeployment): ProviderSetup {
  const setup = PROVIDERS[id];
  if (!setup) throw new Error(`Unsupported model provider: ${id}`);
  if (id !== "custom") {
    if (deployment !== undefined) throw new Error("Custom model endpoint is only valid for custom provider");
    return setup;
  }
  if (deployment === undefined) throw new Error("Custom model endpoint is required");
  return { ...setup, baseURL: validateCustomModelBaseURL(deployment.baseURL) };
}

export function validateCustomModelBaseURL(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048 || value.trim() !== value) {
    throw new Error("Invalid custom model endpoint");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid custom model endpoint");
  }
  if (url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || url.hostname.length === 0) {
    throw new Error("Invalid custom model endpoint");
  }
  return url.toString().replace(/\/+$/, "");
}
