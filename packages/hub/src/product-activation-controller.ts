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

/** A prepared durable side effect that belongs to exactly one activation attempt. */
export interface ProductActivationCommitLease<Receipt> {
  /** Safe metadata for the successful caller; it never needs to contain a credential or token. */
  readonly receipt: Receipt;
  /** Removes this attempt's prepared state when configuration cannot commit. */
  rollback(): Promise<void>;
}

/**
 * Acquires a durable activation side effect after the candidate is mounted and
 * before the active configuration commits.
 */
export interface ProductActivationCommitParticipant<Receipt, Context = undefined> {
  acquire(input: {
    readonly draft: ProductBootstrapConfigDraft;
    readonly expectedGeneration: number;
    readonly context: Context;
  }): Promise<ProductActivationCommitLease<Receipt>>;
}

/** Dependencies that mount a candidate before the controller records it as active. */
export interface ProductActivationControllerOptions<
  Receipt = undefined,
  Context = undefined,
  Mounted extends MountedProductBundle = MountedProductBundle,
> {
  readonly configurationStore: ProductBootstrapConfigCommitter;
  readonly mountCandidate: (draft: ProductBootstrapConfigDraft) => Promise<Mounted | undefined>;
  readonly commitParticipant?: ProductActivationCommitParticipant<Receipt, Context>;
}

export type ProductActivationResult<Receipt = undefined, Mounted extends MountedProductBundle = MountedProductBundle> =
  | {
    readonly status: "activated";
    readonly configuration: ProductBootstrapConfiguration;
    readonly mounted: Mounted;
    readonly receipt?: Receipt;
  }
  | { readonly status: "busy" }
  | { readonly status: "conflict" }
  | { readonly status: "unavailable" };

/**
 * Serializes mount-before-commit activation so only one candidate can own the
 * product generation at a time.
 */
export class ProductActivationController<
  Receipt = undefined,
  Context = undefined,
  Mounted extends MountedProductBundle = MountedProductBundle,
> {
  private activating = false;

  constructor(private readonly options: ProductActivationControllerOptions<Receipt, Context, Mounted>) {}

  async activate(input: {
    readonly draft: ProductBootstrapConfigDraft;
    readonly expectedGeneration: number;
    readonly context: Context;
  }): Promise<ProductActivationResult<Receipt, Mounted>> {
    if (this.activating) return { status: "busy" };
    this.activating = true;
    try {
      const mounted = await this.options.mountCandidate(input.draft);
      if (mounted === undefined) return { status: "unavailable" };
      let lease: ProductActivationCommitLease<Receipt> | undefined;
      try {
        const participant = this.options.commitParticipant;
        lease = participant === undefined ? undefined : await participant.acquire(input);
        const configuration = await this.options.configurationStore.commit(input.expectedGeneration, input.draft);
        return {
          status: "activated",
          configuration,
          mounted,
          ...(lease === undefined ? {} : { receipt: lease.receipt }),
        };
      } catch (error) {
        await lease?.rollback().catch(() => undefined);
        await mounted.dispose().catch(() => undefined);
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
