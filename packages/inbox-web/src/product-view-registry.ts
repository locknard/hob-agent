export interface RegisteredProductViewProvider<Model, Context> {
  readonly id: string;
  readonly label: string;
  renderContent(model: Model, context: Context): string | Promise<string>;
}

export interface ProductViewResolution<Model, Context> {
  readonly provider: RegisteredProductViewProvider<Model, Context>;
  readonly recoveredFrom?: string;
}

const VIEW_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** Registry for trusted presentation providers. Authority remains in the Host and Hub. */
export class ProductViewRegistry<Model, Context> {
  private readonly providers = new Map<string, RegisteredProductViewProvider<Model, Context>>();

  constructor(
    providers: readonly RegisteredProductViewProvider<Model, Context>[],
    readonly fallbackId: string,
  ) {
    for (const provider of providers) {
      if (!VIEW_ID.test(provider.id) || provider.id.length > 120) throw new TypeError("Product view provider id is invalid");
      if (provider.label.trim() !== provider.label || provider.label.length === 0 || provider.label.length > 80) {
        throw new TypeError("Product view provider label is invalid");
      }
      if (this.providers.has(provider.id)) throw new TypeError(`Duplicate product view provider: ${provider.id}`);
      this.providers.set(provider.id, provider);
    }
    if (!this.providers.has(fallbackId)) throw new TypeError("Product view fallback provider is missing");
  }

  resolve(requestedId?: string): ProductViewResolution<Model, Context> {
    if (requestedId !== undefined) {
      const requested = this.providers.get(requestedId);
      if (requested !== undefined) return { provider: requested };
    }
    return {
      provider: this.providers.get(this.fallbackId)!,
      ...(requestedId === undefined ? {} : { recoveredFrom: requestedId }),
    };
  }

  choices(): readonly { readonly id: string; readonly label: string }[] {
    return [...this.providers.values()].map(({ id, label }) => ({ id, label }));
  }
}
