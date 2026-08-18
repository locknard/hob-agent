import type { SupportedModelProvider } from "./model-providers.js";

export type ProviderAuthMethod = "api_key" | "oauth" | "external_cli";
export interface ProviderAdapter {
  id: SupportedModelProvider;
  authMethods: ProviderAuthMethod[];
  /** OAuth is exposed only when the selected pi provider implements it. */
  oauth?: { status: "pi_supported" };
}

const ADAPTERS: Record<SupportedModelProvider, ProviderAdapter> = {
  gpt: { id: "gpt", authMethods: ["api_key"] },
  claude: { id: "claude", authMethods: ["api_key", "oauth", "external_cli"], oauth: { status: "pi_supported" } },
  deepseek: { id: "deepseek", authMethods: ["api_key"] },
  kimi: { id: "kimi", authMethods: ["api_key"] },
  glm: { id: "glm", authMethods: ["api_key"] },
};

export function providerAdapter(provider: SupportedModelProvider): ProviderAdapter {
  return ADAPTERS[provider];
}
