import type { AuthProfile } from "../profiles/auth-profiles.js";
import type { DshOAuthCredential } from "./dsh-oauth-seam.js";
import type { WritableSecretVault } from "../secrets/macos-keychain-secret-vault.js";
import { providerSetup, type SupportedModelProvider } from "../../model/model-providers.js";
import {
  withOAuthRefreshLock,
  type OAuthRefreshLockOptions,
} from "./oauth-refresh-lock.js";

type StoredOAuthCredential = DshOAuthCredential;

export interface OAuthCredentialInfo {
  readonly providerId: string;
  readonly type: "oauth";
}

export interface OAuthCredentialStore {
  read(providerId: string): Promise<StoredOAuthCredential | undefined>;
  list(): Promise<readonly OAuthCredentialInfo[]>;
  modify(
    providerId: string,
    fn: (current: StoredOAuthCredential | undefined) => Promise<StoredOAuthCredential | undefined>,
  ): Promise<StoredOAuthCredential | undefined>;
  delete(providerId: string): Promise<void>;
}

export interface OAuthProfileCredentialStoreOptions {
  /** Called only after a vault mutation, without exposing OAuth token material. */
  onChanged?: (change: { expiresAt?: number }) => Promise<void> | void;
  /** Cross-process lock policy; enabled by default for the selected provider/profile. */
  lock?: OAuthRefreshLockOptions | false;
}

/**
 * A writeable compatibility credential store for exactly one selected OAuth profile.
 * Tokens live as one JSON value in SecretVault; profile/status persistence
 * never receives their contents. DSH's current credential seam only carries a
 * single opaque string and the official LLM adapter accepts API keys only, so
 * this provider-owned OAuth store stays outside the DSH model path until DSH
 * exposes a structured OAuth credential contract.
 */
export class OAuthProfileCredentialStore implements OAuthCredentialStore {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly providerId: string,
    private readonly reference: string,
    private readonly vault: WritableSecretVault,
    private readonly options: OAuthProfileCredentialStoreOptions = {},
    private readonly lockIdentity: { provider: string; profileId: string } = {
      provider: providerId,
      profileId: reference,
    },
  ) {}

  async read(providerId: string): Promise<StoredOAuthCredential | undefined> {
    if (providerId !== this.providerId) return undefined;
    return this.readSelected();
  }

  async list(): Promise<readonly OAuthCredentialInfo[]> {
    return [{ providerId: this.providerId, type: "oauth" }];
  }

  async modify(
    providerId: string,
    fn: (current: StoredOAuthCredential | undefined) => Promise<StoredOAuthCredential | undefined>,
  ): Promise<StoredOAuthCredential | undefined> {
    this.assertProvider(providerId);
    return this.enqueue(() => this.withRefreshLock(async () => {
      const current = await this.readSelected();
      const next = await fn(current);
      if (next === undefined) return current;
      if (!isStoredOAuthCredential(next)) throw new Error("Selected profile requires an OAuth credential");
      await this.vault.write(this.reference, JSON.stringify(next));
      await this.options.onChanged?.({ expiresAt: next.expires });
      return next;
    }));
  }

  async delete(providerId: string): Promise<void> {
    this.assertProvider(providerId);
    await this.enqueue(() => this.withRefreshLock(async () => {
      await this.vault.delete(this.reference);
      await this.options.onChanged?.({});
    }));
  }

  private async readSelected(): Promise<StoredOAuthCredential | undefined> {
    const value = await this.vault.read(this.reference);
    if (value === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("Stored OAuth credential is invalid");
    }
    if (!isStoredOAuthCredential(parsed)) throw new Error("Stored OAuth credential is invalid");
    return parsed;
  }

  private withRefreshLock<T>(task: () => Promise<T>): Promise<T> {
    if (this.options.lock === false) return task();
    return withOAuthRefreshLock(
      this.lockIdentity.provider,
      this.lockIdentity.profileId,
      this.options.lock ?? {},
      task,
    );
  }

  private assertProvider(providerId: string): void {
    if (providerId !== this.providerId) throw new Error(`Credential store is scoped to ${this.providerId}`);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function createOAuthProfileCredentialStore(
  profile: AuthProfile,
  vault: WritableSecretVault,
  options?: OAuthProfileCredentialStoreOptions,
): OAuthProfileCredentialStore {
  if (profile.kind !== "oauth") throw new Error("Selected profile is not an OAuth profile");
  if (!profile.secretRef) throw new Error("Selected OAuth profile is missing a secret reference");
  const provider = providerSetup(profile.provider as SupportedModelProvider);
  return new OAuthProfileCredentialStore(
    provider.runtimeProviderId,
    profile.secretRef,
    vault,
    options,
    { provider: profile.provider, profileId: profile.id },
  );
}

function isStoredOAuthCredential(value: unknown): value is StoredOAuthCredential {
  if (!value || typeof value !== "object") return false;
  const credential = value as Record<string, unknown>;
  return credential.type === "oauth" &&
    typeof credential.access === "string" &&
    typeof credential.refresh === "string" &&
    typeof credential.expires === "number" &&
    Number.isFinite(credential.expires);
}
