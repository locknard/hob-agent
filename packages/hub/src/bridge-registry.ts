import {
  BridgeCatalog,
  type AdapterFactoryContext,
  type AdapterRegistration,
  type BridgeAdapter,
  type BridgeInfo,
} from "./bridge-catalog.js";
export type { AdapterRegistration, BridgeAdapter, BridgeInfo } from "./bridge-catalog.js";
import {
  createScopedBridgeCredentialProvider,
  type BridgeCredentialProvider,
  type CredentialSource,
  type ScopedCredentialSource,
} from "./bridge-credentials.js";
import {
  bridgeInfoSchema,
  canonicalExtensionKey,
} from "@hob/bridge-contract";

export { SqliteBridgeRegistryStore } from "./bridge-registry-store.js";

export interface BridgeConfigEntry<C = unknown> {
  readonly bridgeId: string;
  readonly adapterType: string;
  readonly config: C;
}

export interface BridgeBindingRecord {
  readonly bridgeId: string;
  readonly adapterType: string;
  readonly createdAt: string;
  readonly generation: number;
  readonly remoteInstanceId?: string;
}

/** Synchronous by design so identity validation can run before ingest journaling. */
export interface BridgeRegistryStore {
  get(bridgeId: string): BridgeBindingRecord | undefined;
  save(record: BridgeBindingRecord): void;
  list?(): readonly BridgeBindingRecord[];
  close?(): void;
}

export class MemoryBridgeRegistryStore implements BridgeRegistryStore {
  private readonly records = new Map<string, BridgeBindingRecord>();

  constructor(records: readonly BridgeBindingRecord[] = []) {
    for (const record of records) this.save(record);
  }

  get(bridgeId: string): BridgeBindingRecord | undefined {
    const record = this.records.get(bridgeId);
    return record === undefined ? undefined : { ...record };
  }

  save(record: BridgeBindingRecord): void {
    this.records.set(record.bridgeId, Object.freeze({ ...record }));
  }

  list(): readonly BridgeBindingRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }
}

export type BridgeRegistryErrorCode =
  | "invalid_bridge_id"
  | "invalid_remote_instance"
  | "unknown_adapter_type"
  | "adapter_type_mismatch"
  | "config_invalid"
  | "config_schema_must_be_synchronous"
  | "credential_scope_missing"
  | "bridge_not_registered"
  | "factory_failed"
  | "factory_must_be_synchronous"
  | "invalid_adapter"
  | "unsupported_core_version"
  | "bridge_id_echo_mismatch"
  | "remote_instance_rebind_required"
  | "rebind_adapter_type_mismatch";

export class BridgeRegistryError extends Error {
  constructor(readonly code: BridgeRegistryErrorCode, message: string) {
    super(message);
    this.name = "BridgeRegistryError";
  }
}

export interface BridgeRegistryOptions {
  readonly catalog: BridgeCatalog;
  readonly store?: BridgeRegistryStore;
  /** A global source; a scoped view is created per adapter factory call. */
  readonly credentialSource?: ScopedCredentialSource;
  /** Alias retained for callers that call the source a credentials provider. */
  readonly credentials?: ScopedCredentialSource;
  /** Contract-oriented alias for the global source. */
  readonly credentialProvider?: ScopedCredentialSource;
  readonly now?: () => string | Date;
}

/**
 * Loads trusted, catalog-registered adapters while preserving bridge identity
 * bindings in an injected store. It never lets an adapter choose its type or
 * silently inherit another bridge's persisted identity.
 */
export class BridgeRegistry {
  private readonly catalog: BridgeCatalog;
  private readonly store: BridgeRegistryStore;
  private readonly credentialSource: ScopedCredentialSource;
  private readonly now: () => string;

  constructor(options: BridgeRegistryOptions);
  constructor(
    catalog: BridgeCatalog,
    store?: BridgeRegistryStore,
    credentialSource?: ScopedCredentialSource,
    now?: () => string | Date,
  );
  constructor(
    optionsOrCatalog: BridgeRegistryOptions | BridgeCatalog,
    positionalStore?: BridgeRegistryStore,
    positionalCredentialSource?: ScopedCredentialSource,
    positionalNow?: () => string | Date,
  ) {
    const options: BridgeRegistryOptions = optionsOrCatalog instanceof BridgeCatalog
      ? {
          catalog: optionsOrCatalog,
          store: positionalStore,
          credentialSource: positionalCredentialSource,
          now: positionalNow,
        }
      : optionsOrCatalog;
    this.catalog = options.catalog;
    this.store = options.store ?? new MemoryBridgeRegistryStore();
    this.credentialSource = options.credentialSource
      ?? options.credentialProvider
      ?? options.credentials
      ?? emptyCredentialSource;
    this.now = () => {
      const value = options.now?.() ?? new Date();
      return value instanceof Date ? value.toISOString() : value;
    };
  }

  load<C>(entry: BridgeConfigEntry<C>): BridgeAdapter {
    validateEntry(entry);
    const registration = this.findRegistration<C>(entry.adapterType);
    const persisted = this.store.get(entry.bridgeId);
    if (persisted !== undefined && persisted.adapterType !== entry.adapterType) {
      throw new BridgeRegistryError(
        "adapter_type_mismatch",
        `Bridge "${entry.bridgeId}" is bound to adapter type "${persisted.adapterType}"`,
      );
    }

    const adapter = this.construct(entry, registration);
    validateAdapterInfo(adapter, entry.bridgeId);
    const guardedAdapter = guardAdapter(adapter, entry.bridgeId);
    if (persisted === undefined) this.store.save(initialBinding(entry, this.now));
    return guardedAdapter;
  }

  /**
   * Validates the remote identity reported by a sync-start and binds the first
   * one. A changed identity never mutates the old binding.
   */
  validateOrBindRemoteInstanceId(bridgeId: string, remoteInstanceId: string): BridgeBindingRecord {
    validateRemoteIdentity(bridgeId, remoteInstanceId);
    const persisted = this.store.get(bridgeId);
    if (persisted === undefined) {
      throw new BridgeRegistryError(
        "bridge_not_registered",
        `Bridge "${bridgeId}" has no persisted adapter binding`,
      );
    }
    if (persisted.remoteInstanceId !== undefined && persisted.remoteInstanceId !== remoteInstanceId) {
      throw new BridgeRegistryError(
        "remote_instance_rebind_required",
        `Bridge "${bridgeId}" reported a different remote instance; explicit rebind is required`,
      );
    }
    if (persisted.remoteInstanceId === undefined) {
      const next = { ...persisted, remoteInstanceId };
      this.store.save(next);
      return next;
    }
    return persisted;
  }

  /** Alias used by ingest adapters that name the operation as a binding check. */
  validateOrBindRemoteInstance(bridgeId: string, remoteInstanceId: string): BridgeBindingRecord {
    return this.validateOrBindRemoteInstanceId(bridgeId, remoteInstanceId);
  }

  /**
   * Adapts the throwing binding seam to BridgeIngest's boolean callback. The
   * ingest boundary can therefore reject a mismatched sync-start before it
   * creates an epoch or appends a journal row.
   */
  createRemoteIdentityValidator(
    bridgeId: string,
  ): (remoteInstanceId: string, epochId?: string) => boolean {
    return (remoteInstanceId: string) => {
      try {
        this.validateOrBindRemoteInstanceId(bridgeId, remoteInstanceId);
        return true;
      } catch {
        return false;
      }
    };
  }

  /** Explicitly starts a new remote identity generation after a rebind review. */
  rebindRemoteInstance(bridgeId: string, remoteInstanceId: string): BridgeBindingRecord {
    validateRemoteIdentity(bridgeId, remoteInstanceId);
    const persisted = this.store.get(bridgeId);
    if (persisted === undefined) {
      throw new BridgeRegistryError(
        "bridge_not_registered",
        `Bridge "${bridgeId}" has no persisted adapter binding`,
      );
    }
    const next: BridgeBindingRecord = {
      ...persisted,
      generation: persisted.generation + 1,
      remoteInstanceId,
    };
    this.store.save(next);
    return next;
  }

  rebind(bridgeId: string, remoteInstanceId: string): BridgeBindingRecord {
    return this.rebindRemoteInstance(bridgeId, remoteInstanceId);
  }

  createAdapter<C>(entry: BridgeConfigEntry<C>): BridgeAdapter {
    return this.load(entry);
  }

  instantiate<C>(entry: BridgeConfigEntry<C>): BridgeAdapter {
    return this.load(entry);
  }

  binding(bridgeId: string): BridgeBindingRecord | undefined {
    return this.store.get(bridgeId);
  }

  private findRegistration<C>(adapterType: string): AdapterRegistration<C> {
    try {
      return this.catalog.requireAdapter<C>(adapterType);
    } catch {
      throw new BridgeRegistryError("unknown_adapter_type", `Unknown adapter type "${adapterType}"`);
    }
  }

  private construct<C>(
    entry: BridgeConfigEntry<C>,
    registration: AdapterRegistration<C>,
  ): BridgeAdapter {
    let config: C;
    try {
      config = registration.configSchema.parse(entry.config);
      if (isPromiseLike(config)) throw new BridgeRegistryError(
        "config_schema_must_be_synchronous",
        `Config schema for adapter "${entry.adapterType}" must be synchronous`,
      );
    } catch (error) {
      if (error instanceof BridgeRegistryError) throw error;
      throw new BridgeRegistryError(
        "config_invalid",
        `Invalid configuration for adapter "${entry.adapterType}"`,
      );
    }

    if (registration.credentialRequirements.length > 0 && this.credentialSource === emptyCredentialSource) {
      throw new BridgeRegistryError(
        "credential_scope_missing",
        `Adapter "${entry.adapterType}" declares credentials but no credential source is configured`,
      );
    }

    const credentials = createScopedBridgeCredentialProvider({
      bridgeId: entry.bridgeId,
      requirements: registration.credentialRequirements,
      source: this.credentialSource,
    });
    const context: AdapterFactoryContext<C> = {
      bridgeId: entry.bridgeId,
      config,
      credentials,
    };

    let adapter: BridgeAdapter;
    try {
      adapter = registration.factory(context);
    } catch (error) {
      if (error instanceof BridgeRegistryError) throw error;
      throw new BridgeRegistryError(
        "factory_failed",
        `Factory failed for adapter "${entry.adapterType}"`,
      );
    }
    if (isPromiseLike(adapter)) {
      throw new BridgeRegistryError(
        "factory_must_be_synchronous",
        `Factory for adapter "${entry.adapterType}" must be synchronous`,
      );
    }
    if (!adapter || typeof adapter !== "object") {
      throw new BridgeRegistryError("invalid_adapter", `Factory for adapter "${entry.adapterType}" returned no adapter`);
    }
    return adapter;
  }
}

function validateEntry<C>(entry: BridgeConfigEntry<C>): void {
  if (!entry || typeof entry !== "object" || !nonEmptyString(entry.bridgeId)) {
    throw new BridgeRegistryError("invalid_bridge_id", "Bridge configuration requires a non-empty bridgeId");
  }
  if (!nonEmptyString(entry.adapterType)) {
    throw new BridgeRegistryError("unknown_adapter_type", "Bridge configuration requires adapterType");
  }
}

function validateAdapterInfo(adapter: BridgeAdapter, bridgeId: string): BridgeAdapter["info"] {
  const info = adapter.info;
  if (!info || typeof info !== "object") {
    throw new BridgeRegistryError("invalid_adapter", "Adapter did not return BridgeInfo");
  }
  const parsed = parseBridgeInfo(info);
  if (parsed === undefined) {
    throw new BridgeRegistryError("invalid_adapter", "Adapter returned invalid BridgeInfo");
  }
  if (parsed.bridgeId !== bridgeId) {
    throw new BridgeRegistryError(
      "bridge_id_echo_mismatch",
      `Adapter BridgeInfo bridgeId does not echo configured bridge "${bridgeId}"`,
    );
  }
  if (semverMajor(parsed.coreVersion) !== SUPPORTED_BRIDGE_CORE_MAJOR) {
    throw new BridgeRegistryError(
      "unsupported_core_version",
      `Bridge "${bridgeId}" requires supported core major ${SUPPORTED_BRIDGE_CORE_MAJOR}`,
    );
  }
  return parsed;
}

export const SUPPORTED_BRIDGE_CORE_MAJOR = 6;

/** The hub's current frozen bridge contract major. */
export const SUPPORTED_CORE_MAJOR = SUPPORTED_BRIDGE_CORE_MAJOR;

/**
 * Keeps the registry's load-time checks in force at the actual subscription
 * boundary. A trusted adapter remains a single-use object, but its info must
 * not be allowed to drift after factory construction.
 */
function guardAdapter(adapter: BridgeAdapter, bridgeId: string): BridgeAdapter {
  return {
    get info() {
      return validateAdapterInfo(adapter, bridgeId);
    },
    events(signal: AbortSignal) {
      validateAdapterInfo(adapter, bridgeId);
      return adapter.events(signal);
    },
    control: adapter.control,
    extension(name) {
      validateAdapterInfo(adapter, bridgeId);
      const key = String(name);
      const declared = adapter.info.extensions.some((declaration) => {
        try {
          return canonicalExtensionKey(declaration) === key;
        } catch {
          return false;
        }
      });
      if (!declared) return undefined;
      return adapter.extension(name as never) as never;
    },
  };
}

function semverMajor(version: string): number {
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  return Number.isSafeInteger(major) ? major : -1;
}

function initialBinding(entry: BridgeConfigEntry, now: () => string): BridgeBindingRecord {
  return {
    bridgeId: entry.bridgeId,
    adapterType: entry.adapterType,
    createdAt: now(),
    generation: 1,
  };
}

function validateRemoteIdentity(bridgeId: string, remoteInstanceId: string): void {
  if (!nonEmptyString(bridgeId)) {
    throw new BridgeRegistryError("invalid_bridge_id", "Remote identity binding requires a non-empty bridgeId");
  }
  if (!nonEmptyString(remoteInstanceId)) {
    throw new BridgeRegistryError("invalid_remote_instance", "Remote identity binding requires a non-empty remoteInstanceId");
  }
}

function parseBridgeInfo(info: unknown): BridgeInfo | undefined {
  if (typeof info !== "object" || info === null) return undefined;
  // The revised contract makes remoteInstanceId a sync-start field. Reject a
  // stale adapter that still tries to self-report it in BridgeInfo.
  if (Object.prototype.hasOwnProperty.call(info, "remoteInstanceId")) return undefined;

  const parsed = bridgeInfoSchema.safeParse(info);
  return parsed.success ? parsed.data : undefined;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

const emptyCredentialSource: CredentialSource = Object.freeze({
  async resolve() {
    return undefined;
  },
  async describe() {
    return { configured: false };
  },
});
