import { BridgeCatalog } from "./bridge-catalog.js";
import { HOME_ASSISTANT_ADAPTER_REGISTRATION } from "./home-assistant-bridge.js";

/** Product-owned registration seam; composition code only sees this bundle. */
export interface BridgeProductBundle {
  register(catalog: BridgeCatalog): void;
}

/**
 * Built-in trusted adapters for the executable product.  Ecosystem-specific
 * registrations stay inside this bundle so the composition root remains a
 * catalog/world runtime rather than an ecosystem service locator.
 */
export const builtinBridgeProductBundle: BridgeProductBundle = Object.freeze({
  register(catalog: BridgeCatalog): void {
    catalog.register(HOME_ASSISTANT_ADAPTER_REGISTRATION);
  },
});

export function createBuiltinBridgeCatalog(
  bundle: BridgeProductBundle = builtinBridgeProductBundle,
): BridgeCatalog {
  const catalog = new BridgeCatalog();
  bundle.register(catalog);
  return catalog;
}
