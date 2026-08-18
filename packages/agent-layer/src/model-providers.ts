export type SupportedModelProvider = "gpt" | "claude" | "deepseek" | "kimi" | "glm";

export interface ProviderSetup {
  id: SupportedModelProvider;
  /** Provider route registered in the DSH LlmRuntime. */
  runtimeProviderId: "openai" | "anthropic" | "deepseek" | "moonshotai" | "zai";
  /** DSH credential reference consumed by dsh-llm-pi-ai's apiKeyEnv field. */
  credentialEnv: string;
}

const PROVIDERS: Record<SupportedModelProvider, ProviderSetup> = {
  gpt: { id: "gpt", runtimeProviderId: "openai", credentialEnv: "OPENAI_API_KEY" },
  claude: { id: "claude", runtimeProviderId: "anthropic", credentialEnv: "ANTHROPIC_API_KEY" },
  deepseek: { id: "deepseek", runtimeProviderId: "deepseek", credentialEnv: "DEEPSEEK_API_KEY" },
  kimi: { id: "kimi", runtimeProviderId: "moonshotai", credentialEnv: "MOONSHOT_API_KEY" },
  glm: { id: "glm", runtimeProviderId: "zai", credentialEnv: "ZAI_API_KEY" },
};

export function providerSetup(id: SupportedModelProvider): ProviderSetup {
  const setup = PROVIDERS[id];
  if (!setup) throw new Error(`Unsupported model provider: ${id}`);
  return setup;
}
