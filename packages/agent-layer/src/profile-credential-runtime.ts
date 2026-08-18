import type { Context } from "@deepseek-ai/cordis";

import type { AuthProfile } from "./auth-profiles.js";
import { DshProfileCredentialProvider } from "./dsh-profile-credential-provider.js";
import { providerSetup, type SupportedModelProvider } from "./model-providers.js";
import type { SecretVault } from "./secret-vault.js";

/**
 * Mounts one selected API-key profile into DSH's credential service. The
 * provider resolves the selected SecretRef for every operation, so key
 * rotation is visible to the next model request without rebuilding DSH.
 */
export function mountProfileCredentialProvider(
  ctx: Context,
  profile: AuthProfile,
  vault: SecretVault,
) {
  if (profile.kind !== "api_key") throw new Error("Selected profile is not an API-key profile");
  if (!profile.secretRef) throw new Error("Selected API-key profile is missing a secret reference");
  const provider = providerSetup(profile.provider as SupportedModelProvider);
  return ctx.plugin(DshProfileCredentialProvider, {
    references: { [provider.credentialEnv]: profile.secretRef },
    vault,
  });
}
