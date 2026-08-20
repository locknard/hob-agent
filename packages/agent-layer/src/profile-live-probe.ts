import type { ProfileMetadataWriter } from "./api-key-profile-provisioner.js";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as PiAiPlugin from "@deepseek-ai/dsh-llm-pi-ai";
import type { AuthProfile } from "./auth-profiles.js";
import type { WritableSecretVault } from "./macos-keychain-secret-vault.js";
import { type SupportedModelProvider } from "./model-providers.js";
import { ProviderProbePolicy } from "./provider-probe-policy.js";
import { probeLiveProvider, type LiveProbeModels } from "./provider-live-probe.js";
import { DshProfileCredentialProvider } from "./dsh-profile-credential-provider.js";
import { providerSetup } from "./model-providers.js";

const defaultProbePolicy = new ProviderProbePolicy();

export interface ProfileLiveProbeOptions {
  profile: AuthProfile;
  vault: WritableSecretVault;
  /** Required for OAuth so a DSH credential adapter can persist refreshed metadata. */
  metadata?: ProfileMetadataWriter;
  modelId: string;
  /** Required only for an OpenAI-compatible custom deployment. */
  baseURL?: string;
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

/** Mounts and disposes the official profile-scoped DSH provider for one probe. */
export async function probeDshApiKeyProfile(options: {
  readonly profile: AuthProfile;
  readonly vault: WritableSecretVault;
  readonly modelId: string;
  readonly baseURL?: string;
  readonly signal?: AbortSignal;
}) {
  const provider = options.profile.provider as SupportedModelProvider;
  const setup = providerSetup(
    provider,
    options.baseURL === undefined ? undefined : { baseURL: options.baseURL },
  );
  if (!options.profile.secretRef) throw new Error("Selected API-key profile is missing a secret reference");
  const ctx = new Context();
  try {
    await ctx.plugin(DshProfileCredentialProvider, {
      references: { [setup.credentialEnv]: options.profile.secretRef },
      vault: options.vault,
    });
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(PiAiPlugin, {
      providers: {
        [setup.runtimeProviderId]: setup.baseURL === undefined
          ? { apiKeyEnv: setup.credentialEnv }
          : {
              displayName: "Custom OpenAI-compatible deployment",
              apiKeyEnv: setup.credentialEnv,
              api: "openai-completions",
              baseURL: setup.baseURL,
              models: [{ id: options.modelId, name: options.modelId }],
            },
      },
    });
    return await probeProfileConnection({
      profile: options.profile,
      vault: options.vault,
      modelId: options.modelId,
      ...(setup.baseURL === undefined ? {} : { baseURL: setup.baseURL }),
      runtime: ctx.llm,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } finally {
    await ctx.fiber.dispose();
  }
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
        options.baseURL,
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
