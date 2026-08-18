import type {
  AdapterFactoryContext as ContractAdapterFactoryContext,
  AdapterRegistration as ContractAdapterRegistration,
  BridgeAdapter as ContractBridgeAdapter,
  BridgeInfo as ContractBridgeInfo,
  CredentialKind as ContractCredentialKind,
  CredentialRequirement as ContractCredentialRequirement,
  EquivalenceMapping,
  JsonValue as ContractJsonValue,
  SchemaRegistration as ContractSchemaRegistration,
} from "../../../contracts/bridge-contract.js";

/** Contract-owned Zod schema; the hub only retains the parse seam internally. */
export type BridgeSchema<T> = ContractAdapterRegistration<T>["configSchema"];

export type JsonValue = ContractJsonValue;

export type CredentialKind = ContractCredentialKind;

export type CredentialRequirement = ContractCredentialRequirement;

export type SchemaRegistration<
  T extends Record<string, JsonValue> = Record<string, JsonValue>,
> = ContractSchemaRegistration<T>;

/** All bridge-facing types are re-exported from the contract source of truth. */
export type BridgeInfo = ContractBridgeInfo;
export type BridgeAdapter = ContractBridgeAdapter;
export type AdapterFactoryContext<C> = ContractAdapterFactoryContext<C>;
export type AdapterRegistration<C> = ContractAdapterRegistration<C>;

export type BridgeCatalogErrorCode =
  | "invalid_registration"
  | "duplicate_adapter_type"
  | "schema_collision"
  | "namespace_owner_conflict"
  | "reserved_namespace";

export class BridgeCatalogError extends Error {
  constructor(
    readonly code: BridgeCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BridgeCatalogError";
  }
}

interface StoredSchemaRegistration {
  readonly schema: string;
  readonly majorVersion: number;
  readonly attrsSchema: BridgeSchema<Record<string, JsonValue>>;
  readonly canonicalHash: string;
}

interface StoredAdapterRegistration {
  readonly adapterType: string;
  readonly configSchema: BridgeSchema<unknown>;
  readonly credentialRequirements: readonly CredentialRequirement[];
  readonly capabilitySchemas: readonly StoredSchemaRegistration[];
  readonly equivalenceMappings?: readonly EquivalenceMapping[];
  readonly factory: (context: AdapterFactoryContext<unknown>) => BridgeAdapter;
}

export interface BridgeCatalogOptions {
  /** The only adapter type allowed to register the reserved `hob.*` namespace. */
  readonly coreAdapterType?: string;
  /** Optional explicit namespace ownership, useful for catalog bootstrap. */
  readonly namespaceOwners?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
}

/**
 * Neutral, process-local catalog for trusted adapter registrations.
 *
 * Registration is staged and committed only after every schema and ownership
 * check succeeds, so a single collision cannot leave a partially loaded
 * adapter behind.
 */
export class BridgeCatalog {
  private readonly adaptersByType = new Map<string, StoredAdapterRegistration>();
  private readonly schemasByKey = new Map<string, StoredSchemaRegistration>();
  private readonly ownersByNamespace = new Map<string, string>();
  private readonly coreAdapterType: string;

  constructor(options: BridgeCatalogOptions = {}) {
    this.coreAdapterType = options.coreAdapterType ?? "core";
    if (!isAdapterType(this.coreAdapterType)) {
      throw new BridgeCatalogError(
        "invalid_registration",
        "Catalog core adapter type must use a canonical adapter name",
      );
    }
    for (const [namespace, adapterType] of namespaceEntries(options.namespaceOwners)) {
      if (!isAdapterType(adapterType) || !isNamespaceOwner(namespace)) {
        throw new BridgeCatalogError(
          "invalid_registration",
          "Catalog namespace ownership must use canonical adapter and namespace names",
        );
      }
      this.ownersByNamespace.set(normalizeNamespace(namespace), adapterType);
    }
  }

  register<C>(registration: AdapterRegistration<C>): AdapterRegistration<C> {
    const prepared = prepareRegistration(registration);
    const stagedSchemas = new Map<string, StoredSchemaRegistration>();
    const stagedOwners = new Map<string, string>();
    for (const capabilitySchema of prepared.capabilitySchemas) {
      const namespace = normalizeNamespace(capabilitySchema.schema);
      if (namespace === "hob" && prepared.adapterType !== this.coreAdapterType) {
        throw new BridgeCatalogError(
          "reserved_namespace",
          `Schema namespace "hob.*" is reserved for adapter type "${this.coreAdapterType}"`,
        );
      }

      const owner = this.ownersByNamespace.get(namespace) ?? stagedOwners.get(namespace);
      if (owner !== undefined && owner !== prepared.adapterType) {
        throw new BridgeCatalogError(
          "namespace_owner_conflict",
          `Schema namespace "${namespace}.*" is owned by adapter type "${owner}"`,
        );
      }
      stagedOwners.set(namespace, prepared.adapterType);

      const key = schemaKey(capabilitySchema.schema, capabilitySchema.majorVersion);
      const previous = this.schemasByKey.get(key) ?? stagedSchemas.get(key);
      if (previous !== undefined && previous.canonicalHash !== capabilitySchema.canonicalHash) {
        throw new BridgeCatalogError(
          "schema_collision",
          `Schema "${key}" has conflicting canonical hashes`,
        );
      }
      stagedSchemas.set(key, capabilitySchema);
    }

    const existing = this.adaptersByType.get(prepared.adapterType);
    if (existing !== undefined) {
      if (equivalentRegistration(existing, prepared)) return exposeRegistration<C>(existing);
      throw new BridgeCatalogError(
        "duplicate_adapter_type",
        `Adapter type "${prepared.adapterType}" is already registered`,
      );
    }

    this.adaptersByType.set(prepared.adapterType, prepared);
    for (const [namespace, owner] of stagedOwners) this.ownersByNamespace.set(namespace, owner);
    for (const [key, capabilitySchema] of stagedSchemas) {
      if (!this.schemasByKey.has(key)) this.schemasByKey.set(key, capabilitySchema);
    }
    return exposeRegistration<C>(prepared);
  }

  hasAdapter(adapterType: string): boolean {
    return this.adaptersByType.has(adapterType);
  }

  getAdapter<C = unknown>(adapterType: string): AdapterRegistration<C> | undefined {
    const registration = this.adaptersByType.get(adapterType);
    return registration === undefined ? undefined : exposeRegistration<C>(registration);
  }

  requireAdapter<C = unknown>(adapterType: string): AdapterRegistration<C> {
    const registration = this.getAdapter<C>(adapterType);
    if (registration === undefined) {
      throw new BridgeCatalogError("invalid_registration", `Unknown adapter type "${adapterType}"`);
    }
    return registration;
  }

  schema(schema: string, majorVersion: number): SchemaRegistration | undefined {
    return this.schemasByKey.get(schemaKey(schema, majorVersion));
  }

  ownsNamespace(namespace: string, adapterType?: string): boolean {
    const owner = this.ownersByNamespace.get(normalizeNamespace(namespace));
    return owner !== undefined && (adapterType === undefined || owner === adapterType);
  }

  listAdapters(): readonly AdapterRegistration<unknown>[] {
    return [...this.adaptersByType.values()].map((registration) => exposeRegistration(registration));
  }
}

export function createBridgeCatalog(options: BridgeCatalogOptions = {}): BridgeCatalog {
  return new BridgeCatalog(options);
}

function prepareRegistration<C>(registration: AdapterRegistration<C>): StoredAdapterRegistration {
  if (!registration || typeof registration !== "object") {
    throw new BridgeCatalogError("invalid_registration", "Adapter registration must be an object");
  }
  if (!isAdapterType(registration.adapterType)) {
    throw new BridgeCatalogError("invalid_registration", "Adapter registration requires adapterType");
  }
  if (typeof registration.configSchema?.parse !== "function"
    || typeof (registration.configSchema as { safeParse?: unknown }).safeParse !== "function") {
    throw new BridgeCatalogError("invalid_registration", `Adapter "${registration.adapterType}" requires configSchema`);
  }
  if (typeof registration.factory !== "function") {
    throw new BridgeCatalogError("invalid_registration", `Adapter "${registration.adapterType}" requires factory`);
  }
  if (!Array.isArray(registration.credentialRequirements)) {
    throw new BridgeCatalogError("invalid_registration", `Adapter "${registration.adapterType}" requires credentialRequirements`);
  }
  validateCredentialRequirements(registration.credentialRequirements, registration.adapterType);
  if (!Array.isArray(registration.capabilitySchemas)) {
    throw new BridgeCatalogError("invalid_registration", `Adapter "${registration.adapterType}" requires capabilitySchemas`);
  }

  const capabilitySchemas = registration.capabilitySchemas.map((candidate) => {
    if (!candidate || !isSchemaName(candidate.schema) || !Number.isInteger(candidate.majorVersion) || candidate.majorVersion < 1) {
      throw new BridgeCatalogError("invalid_registration", `Adapter "${registration.adapterType}" has an invalid schema registration`);
    }
    if (typeof candidate.attrsSchema?.parse !== "function"
      || typeof (candidate.attrsSchema as { safeParse?: unknown }).safeParse !== "function") {
      throw new BridgeCatalogError("invalid_registration", `Schema "${candidate.schema}" requires attrsSchema`);
    }
    if (!nonEmptyString(candidate.canonicalHash)) {
      throw new BridgeCatalogError("invalid_registration", `Schema "${candidate.schema}" has an invalid canonical hash`);
    }
    return Object.freeze({
      schema: candidate.schema,
      majorVersion: candidate.majorVersion,
      attrsSchema: candidate.attrsSchema as BridgeSchema<Record<string, JsonValue>>,
      canonicalHash: candidate.canonicalHash,
    });
  });

  return Object.freeze({
    adapterType: registration.adapterType,
    configSchema: registration.configSchema as BridgeSchema<unknown>,
    credentialRequirements: Object.freeze(
      registration.credentialRequirements.map((requirement) => Object.freeze({ ...requirement })),
    ),
    capabilitySchemas: Object.freeze(capabilitySchemas),
    equivalenceMappings: registration.equivalenceMappings === undefined
      ? undefined
      : Object.freeze([...registration.equivalenceMappings]),
    factory: registration.factory as (context: AdapterFactoryContext<unknown>) => BridgeAdapter,
  });
}

function exposeRegistration<C>(registration: StoredAdapterRegistration): AdapterRegistration<C> {
  return {
    adapterType: registration.adapterType,
    configSchema: registration.configSchema as BridgeSchema<C>,
    credentialRequirements: registration.credentialRequirements,
    capabilitySchemas: registration.capabilitySchemas,
    equivalenceMappings: registration.equivalenceMappings,
    factory: registration.factory as (context: AdapterFactoryContext<C>) => BridgeAdapter,
  };
}

function equivalentRegistration(left: StoredAdapterRegistration, right: StoredAdapterRegistration): boolean {
  if (left.adapterType !== right.adapterType) return false;
  if (left.credentialRequirements.length !== right.credentialRequirements.length) return false;
  if (left.capabilitySchemas.length !== right.capabilitySchemas.length) return false;
  return left.credentialRequirements.every((item, index) => {
    const other = right.credentialRequirements[index];
    return other?.alias === item.alias && other.kind === item.kind;
  }) && left.capabilitySchemas.every((item, index) => {
    const other = right.capabilitySchemas[index];
    return other?.schema === item.schema
      && other.majorVersion === item.majorVersion
      && other.canonicalHash === item.canonicalHash;
  });
}

function validateCredentialRequirements(requirements: readonly CredentialRequirement[], adapterType: string): void {
  const aliases = new Map<string, CredentialKind>();
  for (const requirement of requirements) {
    if (!requirement || !nonEmptyString(requirement.alias) || !isCredentialKind(requirement.kind)) {
      throw new BridgeCatalogError("invalid_registration", `Adapter "${adapterType}" has an invalid credential requirement`);
    }
    const previous = aliases.get(requirement.alias);
    if (previous !== undefined && previous !== requirement.kind) {
      throw new BridgeCatalogError("invalid_registration", `Adapter "${adapterType}" declares an alias with multiple credential kinds`);
    }
    aliases.set(requirement.alias, requirement.kind);
  }
}

function schemaKey(schema: string, majorVersion: number): string {
  return `${schema}@${majorVersion}`;
}

function normalizeNamespace(schemaOrNamespace: string): string {
  const trimmed = schemaOrNamespace.trim();
  const namespace = trimmed.split(".", 1)[0] ?? "";
  return namespace.endsWith("*") ? namespace.slice(0, -1) : namespace;
}

const ADAPTER_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}(?:\.[a-z][a-z0-9-]{0,63})+$/;

function isAdapterType(value: unknown): value is string {
  return typeof value === "string" && ADAPTER_TYPE_PATTERN.test(value);
}

function isNamespaceOwner(value: unknown): value is string {
  return typeof value === "string"
    && (NAMESPACE_PATTERN.test(value) || /^([a-z][a-z0-9-]{0,63})\.\*$/.test(value));
}

function isSchemaName(value: unknown): value is string {
  return typeof value === "string" && SCHEMA_NAME_PATTERN.test(value);
}

function namespaceEntries(
  owners: BridgeCatalogOptions["namespaceOwners"],
): Array<[string, string]> {
  if (owners === undefined) return [];
  return owners instanceof Map ? [...owners.entries()] : Object.entries(owners);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isCredentialKind(value: unknown): value is CredentialKind {
  return value === "secret_text" || value === "oauth" || value === "certificate";
}
