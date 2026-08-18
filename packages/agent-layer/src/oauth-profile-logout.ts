import type { CredentialStore } from "@earendil-works/pi-ai";

import type { AuthProfile } from "./auth-profiles.js";
import type { WritableSecretVault } from "./macos-keychain-secret-vault.js";
import { createProviderModels, providerSetup, type SupportedModelProvider } from "./model-providers.js";
import { createOAuthProfileCredentialStore } from "./oauth-profile-credential-store.js";

export interface ProviderLogoutModels {
  logout(providerId: string): Promise<void>;
}

export type OAuthProfileLogoutModelsFactory = (
  credentials: CredentialStore,
) => ProviderLogoutModels | Promise<ProviderLogoutModels>;

/** Removes the local profile credential through pi; it does not revoke upstream provider access. */
export async function logoutOAuthProfile(
  profile: AuthProfile,
  vault: WritableSecretVault,
  createModels: OAuthProfileLogoutModelsFactory = (credentials) => createProviderModels({ credentials }),
): Promise<void> {
  let providerLabel = "unsupported provider";
  try {
    const setup = providerSetup(profile.provider as SupportedModelProvider);
    providerLabel = setup.id;
    const credentials = createOAuthProfileCredentialStore(profile, vault);
    const models = await createModels(credentials);
    await models.logout(setup.piProviderId);
  } catch {
    throw new Error(`OAuth logout failed for ${providerLabel}`);
  }
}
