import type { AuthInteraction, Credential, CredentialStore } from "@earendil-works/pi-ai";

import type { AuthProfile } from "./auth-profiles.js";
import type { WritableSecretVault } from "./macos-keychain-secret-vault.js";
import { createProviderModels, providerSetup, type SupportedModelProvider } from "./model-providers.js";
import { createOAuthProfileCredentialStore } from "./oauth-profile-credential-store.js";
import { loginProvider, type ProviderLoginModels } from "./provider-login.js";

export type OAuthProfileModelsFactory = (
  credentials: CredentialStore,
) => ProviderLoginModels | Promise<ProviderLoginModels>;

/**
 * Runs the provider-owned OAuth flow with a profile-scoped, writeable
 * CredentialStore. pi owns the Claude loopback/manual callback mechanics;
 * this boundary owns profile storage and suppresses raw provider errors.
 */
export async function loginOAuthProfile(
  profile: AuthProfile,
  vault: WritableSecretVault,
  interaction: AuthInteraction,
  createModels: OAuthProfileModelsFactory = (credentials) => createProviderModels({ credentials }),
): Promise<Credential> {
  let providerLabel = "unsupported provider";
  try {
    const setup = providerSetup(profile.provider as SupportedModelProvider);
    providerLabel = setup.id;
    const credentials = createOAuthProfileCredentialStore(profile, vault);
    const models = await createModels(credentials);
    return await loginProvider(
      models,
      setup.id,
      "oauth",
      interaction,
    );
  } catch {
    throw new Error(`OAuth login failed for ${providerLabel}`);
  }
}
