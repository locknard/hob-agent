import type {
  BridgeCredentialProvider as ContractBridgeCredentialProvider,
  CredentialMaterial as ContractCredentialMaterial,
} from "../../../contracts/bridge-contract.js";
import type { CredentialKind, CredentialRequirement } from "./bridge-catalog.js";

export type { CredentialKind, CredentialRequirement } from "./bridge-catalog.js";

export type CredentialMaterial = ContractCredentialMaterial;

export interface CredentialDescription {
  readonly configured: boolean;
}

/** The only credential surface an adapter factory is allowed to receive. */
export type BridgeCredentialProvider = ContractBridgeCredentialProvider;

/** A global vault can bind lookups to both the bridge and the declared alias. */
export interface BridgeAwareCredentialSource {
  resolveForBridge(bridgeId: string, alias: string): Promise<CredentialMaterial | undefined>;
  describeForBridge(bridgeId: string, alias: string): Promise<CredentialDescription>;
}

/** A simpler vault is already scoped by its own implementation. */
export interface CredentialSource {
  resolve(alias: string): Promise<CredentialMaterial | undefined>;
  describe(alias: string): Promise<CredentialDescription>;
}

export type ScopedCredentialSource = CredentialSource | BridgeAwareCredentialSource;

export type CredentialScopeErrorCode =
  | "invalid_requirements"
  | "credential_kind_mismatch"
  | "credential_source_failure";

export class CredentialScopeError extends Error {
  constructor(readonly code: CredentialScopeErrorCode, message: string) {
    super(message);
    this.name = "CredentialScopeError";
  }
}

export class CredentialKindMismatchError extends CredentialScopeError {
  constructor(alias: string, expected: CredentialKind, actual: unknown) {
    super(
      "credential_kind_mismatch",
      `Credential for alias "${alias}" does not match the declared kind "${expected}" (received "${String(actual)}")`,
    );
    this.name = "CredentialKindMismatchError";
  }
}

export interface ScopedBridgeCredentialProviderOptions {
  readonly bridgeId: string;
  readonly requirements: readonly CredentialRequirement[];
  readonly source: ScopedCredentialSource;
}

/**
 * Builds the bridge-level least-authority credential view. Unknown aliases are
 * intentionally indistinguishable from an unconfigured alias and never reach
 * the source, preventing alias enumeration across bridges or providers.
 */
export function createScopedBridgeCredentialProvider(
  options: ScopedBridgeCredentialProviderOptions,
): BridgeCredentialProvider;
export function createScopedBridgeCredentialProvider(
  bridgeId: string,
  requirements: readonly CredentialRequirement[],
  source: ScopedCredentialSource,
): BridgeCredentialProvider;
export function createScopedBridgeCredentialProvider(
  optionsOrBridgeId: ScopedBridgeCredentialProviderOptions | string,
  positionalRequirements?: readonly CredentialRequirement[],
  positionalSource?: ScopedCredentialSource,
): BridgeCredentialProvider {
  const options: ScopedBridgeCredentialProviderOptions = typeof optionsOrBridgeId === "string"
    ? {
        bridgeId: optionsOrBridgeId,
        requirements: positionalRequirements ?? [],
        source: positionalSource as ScopedCredentialSource,
      }
    : optionsOrBridgeId;
  validateScope(options);
  const requirements = new Map(options.requirements.map((requirement) => [requirement.alias, requirement]));
  const source = options.source;
  const bridgeId = options.bridgeId;

  return Object.freeze({
    async resolve(alias: string): Promise<CredentialMaterial | undefined> {
      const requirement = requirements.get(alias);
      if (requirement === undefined) return undefined;

      let material: CredentialMaterial | undefined;
      try {
        material = "resolveForBridge" in source
          ? await source.resolveForBridge(bridgeId, alias)
          : await source.resolve(alias);
      } catch {
        // Never pass through vault/provider errors: adapters must not receive
        // a secret-bearing stack or an upstream credential implementation detail.
        throw new CredentialScopeError(
          "credential_source_failure",
          `Credential lookup failed for alias "${alias}"`,
        );
      }
      if (material === undefined) return undefined;
      if (material.kind !== requirement.kind) {
        throw new CredentialKindMismatchError(alias, requirement.kind, material.kind);
      }
      return normalizeMaterial(material, alias, requirement.kind);
    },

    async describe(alias: string): Promise<CredentialDescription> {
      if (!requirements.has(alias)) return { configured: false };
      try {
        const description = "describeForBridge" in source
          ? await source.describeForBridge(bridgeId, alias)
          : await source.describe(alias);
        return { configured: description.configured === true };
      } catch {
        throw new CredentialScopeError(
          "credential_source_failure",
          `Credential description failed for alias "${alias}"`,
        );
      }
    },
  });
}

/** Short alias for callers that already use the contract's scoped wording. */
export const createScopedCredentialProvider = createScopedBridgeCredentialProvider;
export const scopeBridgeCredentials = createScopedBridgeCredentialProvider;
export const createBridgeCredentialProvider = createScopedBridgeCredentialProvider;

function validateScope(options: ScopedBridgeCredentialProviderOptions): void {
  if (!options || typeof options !== "object" || !nonEmptyString(options.bridgeId)) {
    throw new CredentialScopeError("invalid_requirements", "A bridge credential scope requires bridgeId");
  }
  if (!Array.isArray(options.requirements)) {
    throw new CredentialScopeError("invalid_requirements", "A bridge credential scope requires requirements");
  }
  if (!options.source || typeof options.source !== "object") {
    throw new CredentialScopeError("invalid_requirements", "A bridge credential scope requires a source");
  }
  const aliases = new Map<string, CredentialKind>();
  for (const requirement of options.requirements) {
    if (!requirement || !nonEmptyString(requirement.alias) || !isCredentialKind(requirement.kind)) {
      throw new CredentialScopeError("invalid_requirements", "Credential requirements must declare alias and kind");
    }
    const previous = aliases.get(requirement.alias);
    if (previous !== undefined && previous !== requirement.kind) {
      throw new CredentialScopeError("invalid_requirements", `Alias "${requirement.alias}" has conflicting kinds`);
    }
    aliases.set(requirement.alias, requirement.kind);
  }

  const source = options.source as {
    resolve?: CredentialSource["resolve"];
    describe?: CredentialSource["describe"];
    resolveForBridge?: BridgeAwareCredentialSource["resolveForBridge"];
    describeForBridge?: BridgeAwareCredentialSource["describeForBridge"];
  };
  const bridgeAware = "resolveForBridge" in source || "describeForBridge" in source;
  if (bridgeAware) {
    if (typeof source.resolveForBridge !== "function" || typeof source.describeForBridge !== "function") {
      throw new CredentialScopeError("invalid_requirements", "Bridge-aware credential source is incomplete");
    }
  } else if (typeof source.resolve !== "function" || typeof source.describe !== "function") {
    throw new CredentialScopeError("invalid_requirements", "Credential source is incomplete");
  }
}

function isCredentialKind(value: unknown): value is CredentialKind {
  return value === "secret_text" || value === "oauth" || value === "certificate";
}

function normalizeMaterial(
  material: CredentialMaterial,
  alias: string,
  expectedKind: CredentialKind,
): CredentialMaterial {
  if (material.kind === "secret_text") {
    if (typeof material.value !== "string") throw malformedMaterial(alias, expectedKind);
    return { kind: "secret_text", value: material.value };
  }
  if (material.kind === "oauth") {
    if (typeof material.accessToken !== "string") throw malformedMaterial(alias, expectedKind);
    return {
      kind: "oauth",
      accessToken: material.accessToken,
      ...(typeof material.refreshToken === "string" ? { refreshToken: material.refreshToken } : {}),
      ...(typeof material.expiresAt === "string" ? { expiresAt: material.expiresAt } : {}),
    };
  }
  if (typeof material.certificatePem !== "string" || typeof material.privateKeyPem !== "string") {
    throw malformedMaterial(alias, expectedKind);
  }
  return {
    kind: "certificate",
    certificatePem: material.certificatePem,
    privateKeyPem: material.privateKeyPem,
    ...(typeof material.caPem === "string" ? { caPem: material.caPem } : {}),
  };
}

function malformedMaterial(alias: string, kind: CredentialKind): CredentialScopeError {
  return new CredentialScopeError(
    "credential_source_failure",
    `Credential for alias "${alias}" is not valid ${kind} material`,
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
