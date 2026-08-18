import { Context, Service } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as PiAiPlugin from "@deepseek-ai/dsh-llm-pi-ai";

import type { AuthProfile } from "./auth-profiles.js";
import { DshHomeAgentService } from "./dsh-home-agent-service.js";
import { DshProfileCredentialProvider } from "./dsh-profile-credential-provider.js";
import { providerSetup, type SupportedModelProvider } from "./model-providers.js";
import type { SecretVault } from "./secret-vault.js";

export interface DshHomeAgentCompositionOptions {
  readonly provider: SupportedModelProvider;
  readonly model: string;
  /** Optional explicit API-key profile; requires vault and takes precedence over ambient env. */
  readonly profile?: AuthProfile;
  readonly vault?: SecretVault;
  readonly sessionId?: string;
  readonly systemPrompt?: string;
}

/** Owns the official DSH pi-ai adapter and the single Home Agent as one fiber. */
class DshHomeAgentComposition extends Service {
  constructor(ctx: Context, private readonly options: DshHomeAgentCompositionOptions) {
    super(ctx, "dshHomeAgentComposition");
  }

  protected async [Service.init](): Promise<void> {
    const setup = providerSetup(this.options.provider);
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
        [setup.runtimeProviderId]: { apiKeyEnv: setup.credentialEnv },
      },
    });
    await this.ctx.plugin(DshHomeAgentService, {
      provider: setup.runtimeProviderId,
      model: this.options.model,
      ...(this.options.sessionId === undefined ? {} : { sessionId: this.options.sessionId }),
      ...(this.options.systemPrompt === undefined ? {} : { systemPrompt: this.options.systemPrompt }),
    });
  }
}

/** Mounts a product provider name onto the official DSH pi-ai provider route. */
export function mountDshHomeAgent(ctx: Context, options: DshHomeAgentCompositionOptions) {
  return ctx.plugin(DshHomeAgentComposition, options);
}
