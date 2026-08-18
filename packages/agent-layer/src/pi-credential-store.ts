import { parseSecretRef } from "./secret-ref.js";

/**
 * Compatibility credential shapes for the still provider-owned OAuth flow.
 *
 * The production model path does not expose these types: API-key profiles are
 * mounted through DSH's `CredentialProvider` (see
 * `dsh-profile-credential-provider.ts`). They remain here only so the pending
 * provider-owned login/logout seam can be migrated independently without
 * importing pi-ai from profile storage.
 */
export interface ApiKeyCredential {
  readonly type: "api_key";
  readonly key?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface OAuthCredential {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly [key: string]: unknown;
}

export type Credential = ApiKeyCredential | OAuthCredential;

export interface CredentialInfo {
  readonly providerId: string;
  readonly type: Credential["type"];
}

export interface CredentialStore {
  read(providerId: string, options?: { signal?: AbortSignal }): Promise<Credential | undefined>;
  list(options?: { signal?: AbortSignal }): Promise<readonly CredentialInfo[]>;
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: { signal?: AbortSignal },
  ): Promise<Credential | undefined>;
  delete(providerId: string, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface SecretVault {
  read(reference: string): Promise<string | undefined>;
}

/**
 * Production-safe API-key source for an explicitly allowlisted process
 * environment. It does not enumerate the environment and refuses every other
 * reference scheme; OAuth and keychain sources need their own vault adapter.
 */
export class EnvironmentSecretVault implements SecretVault {
  private readonly allowed: ReadonlySet<string>;

  constructor(
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
    allowedNames: Iterable<string>,
  ) {
    this.allowed = new Set(allowedNames);
  }

  async read(reference: string): Promise<string | undefined> {
    let ref;
    try {
      ref = parseSecretRef(reference);
    } catch {
      return undefined;
    }
    if (ref.source !== "env" || !this.allowed.has(ref.id)) return undefined;
    const value = this.environment[ref.id];
    return value?.trim().length ? value : undefined;
  }
}

/** Test-only vault; production wiring must use OS keychain or encrypted storage. */
export class InMemorySecretVault implements SecretVault {
  constructor(private readonly values: Record<string, string>) {}
  async read(reference: string): Promise<string | undefined> { return this.values[reference]; }
}

/**
 * Compatibility store for the provider-owned OAuth/probe adapters.
 *
 * DSH production requests use `DshProfileCredentialProvider` instead; this
 * class is intentionally not mounted into the Agent Runtime.
 */
export class ProfileCredentialStore implements CredentialStore {
  constructor(private readonly vault: SecretVault, private readonly selected: Record<string, string>) {}

  async read(providerId: string): Promise<Credential | undefined> {
    const reference = this.selected[providerId];
    if (!reference) return undefined;
    const key = await this.vault.read(reference);
    return key ? { type: "api_key", key } : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.keys(this.selected).map((providerId) => ({ providerId, type: "api_key" as const }));
  }

  async modify(): Promise<Credential | undefined> {
    throw new Error("ProfileCredentialStore is read-only; credentials are written through SecretVault");
  }

  async delete(): Promise<void> {
    throw new Error("ProfileCredentialStore is read-only; credentials are deleted through SecretVault");
  }
}
