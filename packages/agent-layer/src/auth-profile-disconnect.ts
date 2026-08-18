import type { AuthProfile } from "./auth-profiles.js";
import type { WritableSecretVault } from "./macos-keychain-secret-vault.js";

export interface ProfileMetadataRemover {
  remove(profileId: string): Promise<void> | void;
}

/**
 * Disconnects a profile from all product selection paths before attempting
 * secret cleanup. A Keychain cleanup error never restores the profile or leaks
 * OS/provider error detail to the caller.
 */
export async function disconnectAuthProfile(
  profile: AuthProfile,
  metadata: ProfileMetadataRemover,
  vault: WritableSecretVault,
): Promise<void> {
  await metadata.remove(profile.id);
  if (!profile.secretRef) return;
  try {
    await vault.delete(profile.secretRef);
  } catch {
    throw new Error("Profile disconnected, but secret cleanup needs retry");
  }
}
