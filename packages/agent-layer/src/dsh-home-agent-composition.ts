import { join } from "node:path";

import { Context, Service } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as PiAiPlugin from "@deepseek-ai/dsh-llm-pi-ai";

import type { AuthProfile } from "./auth-profiles.js";
import { DshHomeAgentService } from "./dsh-home-agent-service.js";
import { DshProfileCredentialProvider } from "./dsh-profile-credential-provider.js";
import { loadHouseholdPromptContext } from "./household-prompt-context.js";
import { providerSetup, type SupportedModelProvider } from "./model-providers.js";
import type { SecretVault } from "./secret-vault.js";

export interface DshHomeAgentCompositionOptions {
  readonly provider: SupportedModelProvider;
  readonly model: string;
  /** HTTPS OpenAI-compatible endpoint required only for the custom provider. */
  readonly baseURL?: string;
  /** Optional explicit API-key profile; requires vault and takes precedence over ambient env. */
  readonly profile?: AuthProfile;
  readonly vault?: SecretVault;
  readonly sessionId?: string;
  readonly sessionPersistencePath?: string;
  readonly householdDirectory?: string;
  readonly systemPrompt?: string;
}

/** Owns the official DSH pi-ai adapter and the single Home Agent as one fiber. */
class DshHomeAgentComposition extends Service {
  constructor(ctx: Context, private readonly options: DshHomeAgentCompositionOptions) {
    super(ctx, "dshHomeAgentComposition");
  }

  protected async [Service.init](): Promise<void> {
    const setup = providerSetup(
      this.options.provider,
      this.options.baseURL === undefined ? undefined : { baseURL: this.options.baseURL },
    );
    const householdContext = this.options.householdDirectory === undefined
      ? undefined
      : await loadHouseholdPromptContext(this.options.householdDirectory);
    if ((this.options.profile === undefined) !== (this.options.vault === undefined)) {
      throw new Error("Selected profile and SecretVault must be provided together");
    }
    if (this.options.profile && this.options.vault) {
      if (this.options.profile.provider !== this.options.provider || this.options.profile.kind !== "api_key") {
        throw new Error("Selected profile cannot authenticate this DSH provider route");
      }
      if (!this.options.profile.secretRef) throw new Error("Selected API-key profile is missing a secret reference");
      await this.ctx.plugin(DshProfileCredentialProvider, {
        references: { [setup.credentialEnv]: this.options.profile.secretRef },
        vault: this.options.vault,
      });
    }
    await this.ctx.plugin(LlmRuntime);
    await this.ctx.plugin(PiAiPlugin, {
      providers: {
        [setup.runtimeProviderId]: setup.baseURL === undefined
          ? { apiKeyEnv: setup.credentialEnv }
          : {
              displayName: "Custom OpenAI-compatible deployment",
              apiKeyEnv: setup.credentialEnv,
              api: "openai-completions",
              baseURL: setup.baseURL,
              models: [{ id: this.options.model, name: this.options.model }],
            },
      },
    });
    await this.ctx.plugin(DshHomeAgentService, {
      provider: setup.runtimeProviderId,
      model: this.options.model,
      ...(this.options.sessionId === undefined ? {} : { sessionId: this.options.sessionId }),
      ...(this.options.sessionPersistencePath === undefined
        ? {}
        : { sessionPersistencePath: this.options.sessionPersistencePath }),
      ...(householdContext === undefined ? {} : { householdContext }),
      ...(this.options.householdDirectory === undefined
        ? {}
        : { householdSkillDirectory: join(this.options.householdDirectory, "skills") }),
      ...(this.options.systemPrompt === undefined ? {} : { systemPrompt: this.options.systemPrompt }),
    });
  }
}

/** Mounts a product provider name onto the official DSH pi-ai provider route. */
export function mountDshHomeAgent(ctx: Context, options: DshHomeAgentCompositionOptions) {
  return ctx.plugin(DshHomeAgentComposition, options);
}
