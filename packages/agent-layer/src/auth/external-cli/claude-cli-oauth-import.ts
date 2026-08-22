import type { AuthProfile } from "../profiles/auth-profiles.js";
import type { ProfileMetadataWriter } from "../profiles/api-key-profile-provisioner.js";
import type { ClaudeCliCredentialReader } from "./claude-cli-external-discoverer.js";
import type { WritableSecretVault } from "../secrets/macos-keychain-secret-vault.js";
import { createOAuthProfileCredentialStore } from "../oauth/oauth-profile-credential-store.js";
import { createOAuthProfileMetadataSync } from "../oauth/oauth-profile-lifecycle.js";

/**
 * Explicitly imports a usable Claude Code OAuth credential into an empty or
 * expired local Claude OAuth profile. It never overwrites a healthy local
 * credential, and returns only non-secret import metadata.
 */
export async function importClaudeCliOAuthCredential(
  profile: AuthProfile,
  reader: ClaudeCliCredentialReader,
  vault: WritableSecretVault,
  metadata: ProfileMetadataWriter,
  now = Date.now(),
): Promise<{ imported: true; expiresAt: number }> {
  if (profile.provider !== "claude" || profile.kind !== "oauth") {
    throw new Error("Claude CLI credentials require a Claude OAuth profile");
  }
  const imported = await reader.read();
  if (!imported || imported.expires <= now) throw new Error("No usable Claude CLI credential to import");

  const credentials = createOAuthProfileCredentialStore(
    profile,
    vault,
    createOAuthProfileMetadataSync(profile, metadata),
  );
  await credentials.modify("anthropic", async (current) => {
    if (current?.type === "oauth" && current.expires > now) {
      throw new Error("Refusing to overwrite a healthy local OAuth credential");
    }
    return {
      type: "oauth",
      access: imported.access,
      refresh: imported.refresh,
      expires: imported.expires,
    };
  });
  return { imported: true, expiresAt: imported.expires };
}
