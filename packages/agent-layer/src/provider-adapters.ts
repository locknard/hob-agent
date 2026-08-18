import type { SupportedModelProvider } from "./model-providers.js";

export type ProviderAuthMethod = "api_key" | "oauth" | "external_cli";
export interface ProviderAdapter {
  id: SupportedModelProvider;
  authMethods: ProviderAuthMethod[];
  /** OAuth remains unavailable until a provider-specific DSH adapter is mounted. */
  oauth?: { status: "dsh_adapter_required" };
}

const ADAPTERS: Record<SupportedModelProvider, ProviderAdapter> = {
  gpt: { id: "gpt", authMethods: ["api_key"] },
  claude: { id: "claude", authMethods: ["api_key", "oauth", "external_cli"], oauth: { status: "dsh_adapter_required" } },
  deepseek: { id: "deepseek", authMethods: ["api_key"] },
  kimi: { id: "kimi", authMethods: ["api_key"] },
  glm: { id: "glm", authMethods: ["api_key"] },
};

export function providerAdapter(provider: SupportedModelProvider): ProviderAdapter {
  return ADAPTERS[provider];
}
