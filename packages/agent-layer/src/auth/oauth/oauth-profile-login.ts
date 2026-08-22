import type { AuthProfile } from "../profiles/auth-profiles.js";
import {
  isDshOAuthCredential,
  unsupportedDshOAuthProvider,
  type DshOAuthCredential,
  type DshOAuthInteraction,
  type DshOAuthProvider,
} from "./dsh-oauth-seam.js";
import type { WritableSecretVault } from "../secrets/macos-keychain-secret-vault.js";
import { withOAuthRefreshLock } from "./oauth-refresh-lock.js";
import { providerSetup, type SupportedModelProvider } from "../../model/model-providers.js";

/**
 * Runs the provider-owned OAuth flow through the DSH seam. The provider
 * adapter owns callback mechanics; this boundary owns profile storage and
 * suppresses raw provider errors.
 */
export async function loginOAuthProfile(
  profile: AuthProfile,
  vault: WritableSecretVault,
  interaction: DshOAuthInteraction,
  provider: DshOAuthProvider = unsupportedDshOAuthProvider,
): Promise<DshOAuthCredential> {
  let providerLabel = "unsupported provider";
  try {
    const setup = providerSetup(profile.provider as SupportedModelProvider);
    providerLabel = setup.id;
    if (profile.kind !== "oauth" || !profile.secretRef) throw new Error("Invalid OAuth profile");
    const credential = await provider.login({
      provider: setup.runtimeProviderId,
      profileId: profile.id,
      interaction,
    });
    if (!isDshOAuthCredential(credential)) throw new Error("OAuth provider returned an invalid credential");
    await withOAuthRefreshLock(setup.id, profile.id, {}, async () => {
      await vault.write(profile.secretRef!, JSON.stringify(credential));
    });
    return credential;
  } catch {
    throw new Error(`OAuth login failed for ${providerLabel}`);
  }
}
