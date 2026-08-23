import { BridgeCatalog } from "./bridge-catalog.js";
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
  register(catalog: BridgeCatalog): void;
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
  return Object.freeze({
    register(catalog: BridgeCatalog): void {
      catalog.register(HOME_ASSISTANT_ADAPTER_REGISTRATION);
      if (options.xiaomi !== undefined) {
        catalog.register(createXiaomiHomeAdapterRegistration(options.xiaomi));
      }
    },
  });
}

export const builtinBridgeProductBundle = createBuiltinBridgeProductBundle();

export type ProductBridgeSetupProbeResult =
  | {
      readonly status: "connected";
      readonly latencyMs: number;
      readonly summary: { readonly states: number; readonly entities: number; readonly devices: number; readonly areas: number };
    }
  | { readonly status: "credential_rejected" | "endpoint_unreachable" | "incompatible" | "timed_out" };

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
  }): Promise<ProductBridgeSetupProbeResult>;
}

/** Product-owned setup catalog; concrete probe code remains inside the bundle. */
export function createBuiltinProductBridgeSetupCatalog(): readonly ProductBridgeSetupRegistration[] {
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
    async probe(input: { readonly config: Readonly<Record<string, unknown>>; readonly credential: string }) {
      return probeHomeAssistantReadAccess({
        baseUrl: String(input.config.baseUrl),
        accessToken: input.credential,
      });
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
