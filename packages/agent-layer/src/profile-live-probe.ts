import type { CredentialStore } from "@earendil-works/pi-ai";

import type { ProfileMetadataWriter } from "./api-key-profile-provisioner.js";
import type { AuthProfile } from "./auth-profiles.js";
import type { WritableSecretVault } from "./macos-keychain-secret-vault.js";
import { createProviderModels, type SupportedModelProvider } from "./model-providers.js";
import { createOAuthProfileCredentialStore } from "./oauth-profile-credential-store.js";
import { createOAuthProfileMetadataSync } from "./oauth-profile-lifecycle.js";
import { createProfileCredentialStore } from "./profile-credential-runtime.js";
import { ProviderProbePolicy } from "./provider-probe-policy.js";
import { probeLiveProvider, type LiveProbeModels } from "./provider-live-probe.js";

const defaultProbePolicy = new ProviderProbePolicy();

export interface ProfileLiveProbeOptions {
  profile: AuthProfile;
  vault: WritableSecretVault;
  /** Required for OAuth so pi refreshes cannot leave status stale. */
  metadata?: ProfileMetadataWriter;
  modelId: string;
  createModels?: (credentials: CredentialStore) => LiveProbeModels | Promise<LiveProbeModels>;
  clock?: () => number;
  policy?: ProviderProbePolicy;
  cooldownUntil?: number;
  signal?: AbortSignal;
}

/** Executes a paid live probe only through the credential store of one profile. */
export async function probeProfileConnection(options: ProfileLiveProbeOptions) {
  const credentials = options.profile.kind === "api_key"
    ? createProfileCredentialStore(options.profile, options.vault)
    : options.profile.kind === "oauth"
      ? createOAuthProbeCredentialStore(options)
      : unsupportedProfile(options.profile);
  const policy = options.policy ?? defaultProbePolicy;
  return policy.run(
    JSON.stringify([options.profile.provider, options.profile.id]),
    (signal) => probeLiveProvider(
      options.profile.provider as SupportedModelProvider,
      options.modelId,
      () => (options.createModels ?? ((store) => createProviderModels({ credentials: store })))(credentials),
      options.clock,
      signal,
    ),
    { cooldownUntil: options.cooldownUntil, signal: options.signal },
  );
}

function createOAuthProbeCredentialStore(options: ProfileLiveProbeOptions) {
  if (!options.metadata) throw new Error("OAuth probe requires profile metadata persistence");
  return createOAuthProfileCredentialStore(
    options.profile,
    options.vault,
    createOAuthProfileMetadataSync(options.profile, options.metadata),
  );
}

function unsupportedProfile(profile: AuthProfile): never {
  throw new Error(`Profile ${profile.id} cannot provide credentials to the provider probe`);
}
