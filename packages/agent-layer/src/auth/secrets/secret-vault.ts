import { parseSecretRef } from "./secret-ref.js";

export interface SecretVault {
  read(reference: string): Promise<string | undefined>;
}

/** Reads only explicitly allowlisted process-environment references. */
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
