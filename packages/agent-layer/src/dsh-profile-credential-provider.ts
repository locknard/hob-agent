import { Context } from "@deepseek-ai/cordis";
import CredentialProvider, {
  credentialRef,
  type CredentialInfo,
  type CredentialRef,
  type ResolvedCredential,
} from "@deepseek-ai/dsh-credentials";

import { parseSecretRef } from "./secret-ref.js";
import type { SecretVault } from "./secret-vault.js";

export interface DshProfileCredentialProviderOptions {
  /** DSH env-shaped aliases mapped to hob canonical SecretRefs. */
  readonly references: Readonly<Record<string, string>>;
  readonly vault: SecretVault;
}

/**
 * Read-only bridge from the DSH credential seam to explicitly selected hob
 * SecretRefs. Values are resolved for every operation and never cached.
 */
export class DshProfileCredentialProvider extends CredentialProvider {
  private readonly references: Readonly<Record<string, string>>;

  constructor(ctx: Context, private readonly options: DshProfileCredentialProviderOptions) {
    super(ctx);
    for (const [alias, reference] of Object.entries(options.references)) {
      credentialRef(alias);
      parseSecretRef(reference);
    }
    this.references = { ...options.references };
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const reference = this.references[ref];
    if (!reference) return undefined;
    const value = await this.options.vault.read(reference);
    return value?.trim().length ? { value, source: "profile" } : undefined;
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const configured = (await this.resolve(ref)) !== undefined;
    return {
      configured,
      ...(configured ? { source: "profile" } : {}),
      writable: false,
    };
  }

  async set(): Promise<void> {
    throw new Error("Selected profile credentials are read-only through the DSH seam");
  }

  async unset(): Promise<void> {
    throw new Error("Selected profile credentials are read-only through the DSH seam");
  }
}
