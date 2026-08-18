import type { AuthInteraction } from "@earendil-works/pi-ai";

import type { ProfileMetadataWriter } from "./api-key-profile-provisioner.js";
import type { AuthProfile } from "./auth-profiles.js";
import type { WritableSecretVault } from "./macos-keychain-secret-vault.js";
import type { OAuthProfileCredentialStoreOptions } from "./oauth-profile-credential-store.js";
import { loginOAuthProfile, type OAuthProfileModelsFactory } from "./oauth-profile-login.js";
import { logoutOAuthProfile, type OAuthProfileLogoutModelsFactory } from "./oauth-profile-logout.js";

/** Persist OAuth lifecycle metadata around provider-owned login/logout flows. */
export async function loginAndRecordOAuthProfile(
  profile: AuthProfile,
  vault: WritableSecretVault,
  metadata: ProfileMetadataWriter,
  interaction: AuthInteraction,
  createModels?: OAuthProfileModelsFactory,
): Promise<AuthProfile> {
  const pending = withoutExpiry(profile);
  await metadata.upsert(pending);
  const credential = await loginOAuthProfile(profile, vault, interaction, createModels);
  if (credential.type !== "oauth") throw new Error("OAuth login did not return an OAuth credential");
  const active = { ...pending, expiresAt: credential.expires };
  await metadata.upsert(active);
  return active;
}

/** Mark the profile unavailable before deleting its local OAuth credential. */
export async function logoutAndRecordOAuthProfile(
  profile: AuthProfile,
  vault: WritableSecretVault,
  metadata: ProfileMetadataWriter,
  createModels?: OAuthProfileLogoutModelsFactory,
): Promise<AuthProfile> {
  const pending = withoutExpiry(profile);
  await metadata.upsert(pending);
  await logoutOAuthProfile(profile, vault, createModels);
  return pending;
}

/**
 * Turns a non-secret pi credential-store mutation into persisted profile
 * availability metadata. OAuth token values never leave the SecretVault.
 */
export function createOAuthProfileMetadataSync(
  profile: AuthProfile,
  metadata: ProfileMetadataWriter,
): OAuthProfileCredentialStoreOptions {
  return {
    onChanged: async ({ expiresAt }) => {
      await metadata.upsert(expiresAt === undefined
        ? withoutExpiry(profile)
        : { ...profile, expiresAt });
    },
  };
}

function withoutExpiry(profile: AuthProfile): AuthProfile {
  const { expiresAt: _expiresAt, ...pending } = profile;
  return pending;
}
