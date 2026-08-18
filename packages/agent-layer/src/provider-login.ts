import type { AuthInteraction, AuthType, Credential } from "@earendil-works/pi-ai";

import { providerAdapter, type ProviderAuthMethod } from "./provider-adapters.js";
import { providerSetup, type SupportedModelProvider } from "./model-providers.js";

export interface ProviderLoginModels {
  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;
  logout?(providerId: string): Promise<void>;
}

/** Delegates concrete OAuth/API-key login to the provider-owned pi-ai implementation. */
export async function loginProvider(
  models: ProviderLoginModels,
  provider: SupportedModelProvider,
  method: Extract<ProviderAuthMethod, AuthType>,
  interaction: AuthInteraction,
): Promise<Credential> {
  if (!providerAdapter(provider).authMethods.includes(method)) {
    throw new Error(`${provider} does not support ${method} authentication`);
  }
  return models.login(providerSetup(provider).piProviderId, method, interaction);
}
