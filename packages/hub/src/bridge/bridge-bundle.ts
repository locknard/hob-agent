import {
  BridgeCatalog,
  type AdapterRegistration,
  type CredentialRequirement,
} from "./bridge-catalog.js";
import {
  HOME_ASSISTANT_ADAPTER_REGISTRATION,
  probeHomeAssistantReadAccess,
} from "./home-assistant-bridge.js";
import {
  createXiaomiHomeAdapterRegistration,
  type XiaomiHomeTransportPlugin,
} from "./xiaomi-home-bridge.js";

/** Product-owned registration seam; composition code only sees this bundle. */
export interface BridgeProductBundle {
  /** Runtime registrations available to every product generation from this bundle. */
  readonly adapterRegistrations: readonly ProductBridgeAdapterRegistration[];
  /** Setup peers are a deliberately bounded subset of the runtime registrations. */
  readonly setupRegistrations: readonly ProductBridgeSetupRegistration[];
  register(catalog: BridgeCatalog): void;
}

export interface BridgeProductBundleInput {
  readonly adapterRegistrations: readonly ProductBridgeAdapterRegistration[];
  readonly setupRegistrations: readonly ProductBridgeSetupRegistration[];
}

/** Erases only the adapter-private config generic while retaining its catalog registration behavior. */
export interface ProductBridgeAdapterRegistration {
  readonly adapterType: string;
  /** The exact adapter credential contract retained for setup/runtime compatibility checks. */
  readonly credentialRequirements: readonly CredentialRequirement[];
  register(catalog: BridgeCatalog): void;
}

export function productBridgeAdapterRegistration<Config>(
  registration: AdapterRegistration<Config>,
): ProductBridgeAdapterRegistration {
  return Object.freeze({
    adapterType: registration.adapterType,
    credentialRequirements: Object.freeze(registration.credentialRequirements.map((requirement) => Object.freeze({ ...requirement }))),
    register(catalog: BridgeCatalog): void { catalog.register(registration); },
  });
}

/**
 * Creates the one product-owned bridge inventory. A setup peer always has its
 * exact runtime adapter in the same bundle; adapters without a setup entry
 * remain runtime-only until their authorized setup flow exists.
 */
export function createBridgeProductBundle(input: BridgeProductBundleInput): BridgeProductBundle {
  const adapterRegistrations = Object.freeze([...input.adapterRegistrations]);
  const setupRegistrations = Object.freeze([...input.setupRegistrations]);
  const adaptersByType = new Map<string, ProductBridgeAdapterRegistration>();
  for (const registration of adapterRegistrations) {
    if (adaptersByType.has(registration.adapterType)) {
      throw new TypeError(`Product bridge bundle repeats runtime adapter "${registration.adapterType}"`);
    }
    adaptersByType.set(registration.adapterType, registration);
  }
  const setupAdapterTypes = new Set<string>();
  for (const registration of setupRegistrations) {
    if (setupAdapterTypes.has(registration.adapterType)) {
      throw new TypeError(`Product bridge bundle repeats setup peer "${registration.adapterType}"`);
    }
    setupAdapterTypes.add(registration.adapterType);
    const runtime = adaptersByType.get(registration.adapterType);
    if (runtime === undefined) {
      throw new TypeError(`Product bridge setup "${registration.adapterType}" requires a runtime adapter in the same bundle`);
    }
    const [credential] = runtime.credentialRequirements;
    if (runtime.credentialRequirements.length !== 1
      || credential?.alias !== registration.credentialAlias
      || credential.kind !== "secret_text") {
      throw new TypeError(
        `Product bridge setup "${registration.adapterType}" requires exactly one secret_text credential "${registration.credentialAlias}" from its runtime adapter`,
      );
    }
  }
  return Object.freeze({
    adapterRegistrations,
    setupRegistrations,
    register(catalog: BridgeCatalog): void {
      for (const registration of adapterRegistrations) registration.register(catalog);
    },
  });
}

export interface BuiltinBridgeProductBundleOptions {
  /** Present only when a separately authorized Xiaomi transport is installed. */
  readonly xiaomi?: XiaomiHomeTransportPlugin;
}

/**
 * Built-in trusted adapters for the executable product.  Ecosystem-specific
 * registrations stay inside this bundle so the composition root remains a
 * catalog/world runtime rather than an ecosystem service locator.
 */
export function createBuiltinBridgeProductBundle(
  options: BuiltinBridgeProductBundleOptions = {},
): BridgeProductBundle {
  return createBridgeProductBundle({
    adapterRegistrations: [
      productBridgeAdapterRegistration(HOME_ASSISTANT_ADAPTER_REGISTRATION),
      ...(options.xiaomi === undefined
        ? []
        : [productBridgeAdapterRegistration(createXiaomiHomeAdapterRegistration(options.xiaomi))]),
    ],
    setupRegistrations: builtinProductBridgeSetupRegistrations(),
  });
}

export const builtinBridgeProductBundle = createBuiltinBridgeProductBundle();

export type ProductBridgeSetupProbeResult =
  | {
      readonly status: "connected";
      readonly latencyMs: number;
      readonly summary: { readonly states: number; readonly entities: number; readonly devices: number; readonly areas: number };
      /** Every successful setup probe provides the bounded map review required for activation. */
      readonly review: ProductBridgeSetupMapReview;
    }
  | { readonly status: "credential_rejected" | "endpoint_unreachable" | "incompatible" | "timed_out" };

/** Adapter-neutral, bounded aggregate suitable for household map confirmation. */
export interface ProductBridgeSetupMapReview {
  readonly areas: readonly { readonly name: string; readonly deviceCount: number }[];
  readonly unassignedDeviceCount: number;
  readonly complete: true;
}

export interface ProductBridgeSetupRegistration {
  readonly adapterType: string;
  readonly label: string;
  readonly credentialAlias: string;
  normalizeConfig(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  /** Optional household-readable location; adapter config remains opaque to Hub setup. */
  displayEndpoint?(config: Readonly<Record<string, unknown>>): string;
  probe(input: {
    readonly config: Readonly<Record<string, unknown>>;
    readonly credential: string;
    /** Cancels this bounded read-only setup probe. */
    readonly signal?: AbortSignal;
  }): Promise<ProductBridgeSetupProbeResult>;
}

/** Product-owned setup catalog; concrete probe code remains inside the bundle. */
function builtinProductBridgeSetupRegistrations(): readonly ProductBridgeSetupRegistration[] {
  return Object.freeze([Object.freeze({
    adapterType: "home-assistant",
    label: "Home Assistant",
    credentialAlias: "access-token",
    normalizeConfig(input: Readonly<Record<string, unknown>>) {
      if (typeof input.baseUrl !== "string") throw new TypeError("Bridge endpoint is invalid");
      const url = new URL(input.baseUrl.trim());
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== ""
        || url.search !== "" || url.hash !== "") throw new TypeError("Bridge endpoint is invalid");
      url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
      return Object.freeze({ baseUrl: url.toString().replace(/\/$/u, "") });
    },
    displayEndpoint(config: Readonly<Record<string, unknown>>) {
      return String(config.baseUrl);
    },
    async probe(input: { readonly config: Readonly<Record<string, unknown>>; readonly credential: string; readonly signal?: AbortSignal }): Promise<ProductBridgeSetupProbeResult> {
      const result = await probeHomeAssistantReadAccess({
        baseUrl: String(input.config.baseUrl),
        accessToken: input.credential,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (result.status !== "connected") return result;
      if (!result.review.complete) return { status: "incompatible" };
      return {
        status: "connected",
        latencyMs: result.latencyMs,
        summary: result.summary,
        review: { ...result.review, complete: true },
      };
    },
  })]);
}

export function createBuiltinBridgeCatalog(
  bundle: BridgeProductBundle = builtinBridgeProductBundle,
): BridgeCatalog {
  const catalog = new BridgeCatalog();
  bundle.register(catalog);
  return catalog;
}
