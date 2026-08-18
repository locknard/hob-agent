import type { CredentialStore } from "@earendil-works/pi-ai";

import type { AuthProfile } from "./auth-profiles.js";
import { providerSetup, type SupportedModelProvider } from "./model-providers.js";
import { ProfileCredentialStore, type SecretVault } from "./pi-credential-store.js";

/**
 * Narrows an explicitly selected API-key profile to one pi provider. OAuth and
 * external CLI profiles require their own credential-store implementations.
 */
export function createProfileCredentialStore(
  profile: AuthProfile,
  vault: SecretVault,
): CredentialStore {
  if (profile.kind !== "api_key") throw new Error("Selected profile is not an API-key profile");
  if (!profile.secretRef) throw new Error("Selected API-key profile is missing a secret reference");
  const provider = providerSetup(profile.provider as SupportedModelProvider);
  return new ProfileCredentialStore(vault, { [provider.piProviderId]: profile.secretRef });
}
