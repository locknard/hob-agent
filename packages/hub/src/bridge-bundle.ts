import { BridgeCatalog } from "./bridge-catalog.js";
import { HOME_ASSISTANT_ADAPTER_REGISTRATION } from "./home-assistant-bridge.js";
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

export function createBuiltinBridgeCatalog(
  bundle: BridgeProductBundle = builtinBridgeProductBundle,
): BridgeCatalog {
  const catalog = new BridgeCatalog();
  bundle.register(catalog);
  return catalog;
}
