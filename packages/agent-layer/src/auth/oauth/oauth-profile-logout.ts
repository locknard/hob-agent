import type { AuthProfile } from "../profiles/auth-profiles.js";
import {
  parseDshOAuthCredential,
  unsupportedDshOAuthProvider,
  type DshOAuthProvider,
} from "./dsh-oauth-seam.js";
import type { WritableSecretVault } from "../secrets/macos-keychain-secret-vault.js";
import { withOAuthRefreshLock } from "./oauth-refresh-lock.js";
import { providerSetup, type SupportedModelProvider } from "../../model/model-providers.js";

/** Revokes/removes the profile credential through the DSH provider seam. */
export async function logoutOAuthProfile(
  profile: AuthProfile,
  vault: WritableSecretVault,
  provider: DshOAuthProvider = unsupportedDshOAuthProvider,
): Promise<void> {
  let providerLabel = "unsupported provider";
  try {
    const setup = providerSetup(profile.provider as SupportedModelProvider);
    providerLabel = setup.id;
    if (profile.kind !== "oauth" || !profile.secretRef) throw new Error("Invalid OAuth profile");
    await withOAuthRefreshLock(setup.id, profile.id, {}, async () => {
      const stored = await vault.read(profile.secretRef!);
      const credential = stored === undefined ? undefined : parseDshOAuthCredential(stored);
      await provider.logout({
        provider: setup.runtimeProviderId,
        profileId: profile.id,
        ...(credential === undefined ? {} : { credential }),
      });
      await vault.delete(profile.secretRef!);
    });
  } catch {
    throw new Error(`OAuth logout failed for ${providerLabel}`);
  }
}
