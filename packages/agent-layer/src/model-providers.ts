import { createModels, type CredentialStore } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";

export type SupportedModelProvider = "gpt" | "claude" | "deepseek" | "kimi" | "glm";

export interface ProviderSetup {
  id: SupportedModelProvider;
  piProviderId: "openai" | "anthropic" | "deepseek" | "moonshotai" | "zai";
  credentialEnv: string;
}

const PROVIDERS: Record<SupportedModelProvider, ProviderSetup> = {
  gpt: { id: "gpt", piProviderId: "openai", credentialEnv: "OPENAI_API_KEY" },
  claude: { id: "claude", piProviderId: "anthropic", credentialEnv: "ANTHROPIC_API_KEY" },
  deepseek: { id: "deepseek", piProviderId: "deepseek", credentialEnv: "DEEPSEEK_API_KEY" },
  kimi: { id: "kimi", piProviderId: "moonshotai", credentialEnv: "MOONSHOT_API_KEY" },
  glm: { id: "glm", piProviderId: "zai", credentialEnv: "ZAI_API_KEY" },
};

export function providerSetup(id: SupportedModelProvider): ProviderSetup {
  const setup = PROVIDERS[id];
  if (!setup) throw new Error(`Unsupported model provider: ${id}`);
  return setup;
}

export function createProviderModels(options: { credentials?: CredentialStore } = {}) {
  const models = createModels({ credentials: options.credentials });
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  models.setProvider(deepseekProvider());
  models.setProvider(moonshotaiProvider());
  models.setProvider(zaiProvider());
  return models;
}
