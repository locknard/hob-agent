import type { ProfileMetadataWriter } from "./api-key-profile-provisioner.js";
import type { AuthProfile } from "./auth-profiles.js";
import type { WritableSecretVault } from "./macos-keychain-secret-vault.js";
import { type SupportedModelProvider } from "./model-providers.js";
import { ProviderProbePolicy } from "./provider-probe-policy.js";
import { probeLiveProvider, type LiveProbeModels } from "./provider-live-probe.js";

const defaultProbePolicy = new ProviderProbePolicy();

export interface ProfileLiveProbeOptions {
  profile: AuthProfile;
  vault: WritableSecretVault;
  /** Required for OAuth so a DSH credential adapter can persist refreshed metadata. */
  metadata?: ProfileMetadataWriter;
  modelId: string;
  /** A runtime already mounted with the selected profile's DSH credential route. */
  runtime?: LiveProbeModels;
  /**
   * Builds a profile-scoped DSH runtime. The factory owns mounting the
   * official dsh-llm-pi-ai plugin and DSH credential provider; no provider SDK
   * credential store crosses this boundary.
   */
  createRuntime?: (
    options: ProfileLiveProbeRuntimeOptions,
    signal: AbortSignal,
  ) => LiveProbeModels | Promise<LiveProbeModels>;
  clock?: () => number;
  policy?: ProviderProbePolicy;
  cooldownUntil?: number;
  signal?: AbortSignal;
}

export interface ProfileLiveProbeRuntimeOptions {
  profile: AuthProfile;
  vault: WritableSecretVault;
  metadata?: ProfileMetadataWriter;
}

/** Executes a paid live probe only through one profile-scoped DSH runtime. */
export async function probeProfileConnection(options: ProfileLiveProbeOptions) {
  validateProfileForProbe(options);
  if (!options.runtime && !options.createRuntime) {
    throw new Error("Profile probe requires a DSH LlmRuntime");
  }
  const policy = options.policy ?? defaultProbePolicy;
  return policy.run(
    JSON.stringify([options.profile.provider, options.profile.id]),
    async (signal) => {
      const runtime = options.runtime ?? await options.createRuntime?.({
        profile: options.profile,
        vault: options.vault,
        ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      }, signal);
      if (!runtime) throw new Error("Profile probe requires a DSH LlmRuntime");
      return probeLiveProvider(
        options.profile.provider as SupportedModelProvider,
        options.modelId,
        () => runtime,
        options.clock,
        signal,
      );
    },
    { cooldownUntil: options.cooldownUntil, signal: options.signal },
  );
}

function validateProfileForProbe(options: ProfileLiveProbeOptions): void {
  if (options.profile.kind === "api_key") {
    if (!options.profile.secretRef) throw new Error("Selected API-key profile is missing a secret reference");
    return;
  }
  if (options.profile.kind === "oauth") {
    if (!options.metadata) throw new Error("OAuth probe requires profile metadata persistence");
    return;
  }
  unsupportedProfile(options.profile);
}

function unsupportedProfile(profile: AuthProfile): never {
  throw new Error(`Profile ${profile.id} cannot provide credentials to the provider probe`);
}
