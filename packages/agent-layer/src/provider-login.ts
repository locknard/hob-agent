import { providerAdapter, type ProviderAuthMethod } from "./provider-adapters.js";
import { providerSetup, type SupportedModelProvider } from "./model-providers.js";

/** DSH-neutral auth method vocabulary kept for provider-owned auth bridges. */
export type AuthType = "api_key" | "oauth";

/** DSH-neutral credential result; secret values never enter probe metadata. */
export type Credential =
  | { type: "api_key"; key?: string; env?: Record<string, string> }
  | { type: "oauth"; access: string; refresh: string; expires: number; [key: string]: unknown };

export interface ProviderLoginModels {
  /**
   * Provider-owned login remains outside DSH's LlmRuntime. The official DSH
   * plugin has no interactive login/logout surface; an auth bridge may supply
   * one here until a DSH credentials UI exists.
   */
  login(providerId: string, type: AuthType, interaction: unknown): Promise<Credential>;
  logout?(providerId: string): Promise<void>;
}

/** Delegates concrete OAuth/API-key login to a provider-owned auth bridge. */
export async function loginProvider(
  models: ProviderLoginModels,
  provider: SupportedModelProvider,
  method: Extract<ProviderAuthMethod, AuthType>,
  interaction: unknown,
): Promise<Credential> {
  if (!providerAdapter(provider).authMethods.includes(method)) {
    throw new Error(`${provider} does not support ${method} authentication`);
  }
  return models.login(providerSetup(provider).runtimeProviderId, method, interaction);
}
