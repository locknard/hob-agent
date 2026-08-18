import type { AuthProfile } from "./auth-profiles.js";
import type { WritableSecretVault } from "./macos-keychain-secret-vault.js";

export interface ProfileMetadataWriter {
  upsert(profile: AuthProfile): Promise<void> | void;
}

/**
 * Writes an API key before publishing its profile metadata. If metadata
 * persistence fails, the prior vault value is restored (or the new item is
 * removed), so a failed setup does not lose an existing credential.
 */
export async function provisionApiKeyProfile(
  vault: WritableSecretVault,
  metadata: ProfileMetadataWriter,
  profile: AuthProfile,
  apiKey: string,
): Promise<void> {
  if (profile.kind !== "api_key") throw new Error("Only API-key profiles can be provisioned");
  if (!profile.secretRef) throw new Error("API-key profile requires a secret reference");
  if (!apiKey.trim()) throw new Error("API key must not be empty");

  const previous = await vault.read(profile.secretRef);
  await vault.write(profile.secretRef, apiKey);
  try {
    await metadata.upsert(profile);
  } catch (error) {
    try {
      if (previous === undefined) await vault.delete(profile.secretRef);
      else await vault.write(profile.secretRef, previous);
    } catch {
      // Preserve the metadata error; callers can surface a focused recovery action.
    }
    throw error;
  }
}
