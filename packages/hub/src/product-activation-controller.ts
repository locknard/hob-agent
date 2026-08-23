import type {
  ProductBootstrapConfigDraft,
  ProductBootstrapConfiguration,
  ProductBootstrapConfigStore,
} from "./product-bootstrap-config-store.js";
import { ProductBootstrapConfigurationConflictError } from "./product-bootstrap-config-store.js";

/** A fully ready product composition that remains owned by its successful activation. */
export interface MountedProductBundle {
  dispose(): Promise<void>;
}

/** The configuration store retains the active product generation. */
export interface ProductBootstrapConfigCommitter {
  commit: ProductBootstrapConfigStore["commit"];
}

/** Dependencies that mount a candidate before the controller records it as active. */
export interface ProductActivationControllerOptions {
  readonly configurationStore: ProductBootstrapConfigCommitter;
  readonly mountCandidate: (draft: ProductBootstrapConfigDraft) => Promise<MountedProductBundle | undefined>;
}

export type ProductActivationResult =
  | { readonly status: "activated"; readonly configuration: ProductBootstrapConfiguration; readonly mounted: MountedProductBundle }
  | { readonly status: "busy" }
  | { readonly status: "conflict" }
  | { readonly status: "unavailable" };

/**
 * Serializes mount-before-commit activation so only one candidate can own the
 * product generation at a time.
 */
export class ProductActivationController {
  private activating = false;

  constructor(private readonly options: ProductActivationControllerOptions) {}

  async activate(input: {
    readonly draft: ProductBootstrapConfigDraft;
    readonly expectedGeneration: number;
  }): Promise<ProductActivationResult> {
    if (this.activating) return { status: "busy" };
    this.activating = true;
    try {
      const mounted = await this.options.mountCandidate(input.draft);
      if (mounted === undefined) return { status: "unavailable" };
      try {
        const configuration = await this.options.configurationStore.commit(input.expectedGeneration, input.draft);
        return { status: "activated", configuration, mounted };
      } catch (error) {
        await mounted.dispose();
        return {
          status: error instanceof ProductBootstrapConfigurationConflictError
            ? "conflict"
            : "unavailable",
        };
      }
    } catch {
      return { status: "unavailable" };
    } finally {
      this.activating = false;
    }
  }
}
