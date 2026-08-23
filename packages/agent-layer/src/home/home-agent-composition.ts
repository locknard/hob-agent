import { join } from "node:path";

import { Context, Service } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";

import type { AuthProfile } from "../auth/profiles/auth-profiles.js";
import { DshHomeAgentService } from "./home-agent-service.js";
import { loadHouseholdPromptContext } from "../prompt/household-prompt-context.js";
import { type SupportedModelProvider } from "../model/model-providers.js";
import type { SecretVault } from "../auth/secrets/secret-vault.js";
import {
  HOME_ACTIVE_MODEL,
  HOME_ACTIVE_PROVIDER_ROUTE,
  ModelProviderResolver,
} from "../model/model-provider-resolver.js";

export interface DshHomeAgentCompositionOptions {
  readonly provider: SupportedModelProvider;
  readonly model: string;
  /** HTTPS OpenAI-compatible endpoint required only for the custom provider. */
  readonly baseURL?: string;
  /** Optional explicit API-key profile; requires vault and takes precedence over ambient env. */
  readonly profile?: AuthProfile;
  readonly vault?: SecretVault;
  /** Hub-owned resolver already prepared and activated through durable config CAS. */
  readonly modelProviderResolver?: ModelProviderResolver;
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
    const householdContext = this.options.householdDirectory === undefined
      ? undefined
      : await loadHouseholdPromptContext(this.options.householdDirectory);
    const resolver = this.options.modelProviderResolver ?? new ModelProviderResolver(this.ctx);
    if (this.options.modelProviderResolver === undefined) {
      const prepared = await resolver.prepare({
        provider: this.options.provider,
        model: this.options.model,
        ...(this.options.baseURL === undefined ? {} : { baseURL: this.options.baseURL }),
        ...(this.options.profile === undefined ? {} : { profile: this.options.profile }),
        ...(this.options.vault === undefined ? {} : { vault: this.options.vault }),
      });
      resolver.activate(prepared);
    }
    await this.ctx.plugin(LlmRuntime);
    const llm = this.ctx.get("llm");
    if (llm === undefined) throw new Error("Root DSH LlmRuntime did not initialize");
    llm.registerAdapter([HOME_ACTIVE_PROVIDER_ROUTE], resolver.adapter);
    await this.ctx.plugin(DshHomeAgentService, {
      provider: HOME_ACTIVE_PROVIDER_ROUTE,
      model: HOME_ACTIVE_MODEL,
      modelProviderResolver: resolver,
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
