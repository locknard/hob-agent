export interface RegisteredProductViewPreference {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly defaultValue: string;
  readonly choices: readonly {
    readonly value: string;
    readonly label: string;
  }[];
}

export interface RegisteredProductViewProvider<Model, Context> {
  readonly id: string;
  readonly label: string;
  readonly preferences?: readonly RegisteredProductViewPreference[];
  renderContent(model: Model, context: Context): string | Promise<string>;
}

export interface ProductViewResolution<Model, Context> {
  readonly provider: RegisteredProductViewProvider<Model, Context>;
  readonly recoveredFrom?: string;
}

const VIEW_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const PREFERENCE_KEY = /^[a-z][A-Za-z0-9]{0,39}$/;
const PREFERENCE_VALUE = /^[a-z][a-z0-9_-]{0,39}$/;

/** Registry for trusted presentation providers. Authority remains in the Host and Hub. */
export class ProductViewRegistry<Model, Context> {
  private readonly providers = new Map<string, RegisteredProductViewProvider<Model, Context>>();
  private readonly dynamicIds = new Set<string>();

  constructor(
    providers: readonly RegisteredProductViewProvider<Model, Context>[],
    readonly fallbackId: string,
  ) {
    for (const provider of providers) {
      validateProvider(provider);
      if (this.providers.has(provider.id)) throw new TypeError(`Duplicate product view provider: ${provider.id}`);
      this.providers.set(provider.id, snapshotProvider(provider));
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
    return Object.freeze([...this.providers.values()].map(({ id, label }) => Object.freeze({ id, label })));
  }

  /** Adds or replaces a Host-rendered publication while preserving static ids. */
  upsertDynamic(provider: RegisteredProductViewProvider<Model, Context>): void {
    validateProvider(provider);
    if (this.providers.has(provider.id) && !this.dynamicIds.has(provider.id)) {
      throw new TypeError("Product view static provider ownership is reserved");
    }
    const snapshot = snapshotProvider(provider);
    this.providers.set(provider.id, snapshot);
    this.dynamicIds.add(provider.id);
  }

  /** Reports whether a publication id is free or already publication-owned. */
  acceptsDynamic(id: string): boolean {
    return VIEW_ID.test(id) && id.length <= 120 && (!this.providers.has(id) || this.dynamicIds.has(id));
  }

  /** Removes one published provider. Static and fallback providers remain registered. */
  removeDynamic(id: string): boolean {
    if (!this.dynamicIds.delete(id)) return false;
    return this.providers.delete(id);
  }
}

function validateProvider<Model, Context>(provider: RegisteredProductViewProvider<Model, Context>): void {
  if (!VIEW_ID.test(provider.id) || provider.id.length > 120) throw new TypeError("Product view provider id is invalid");
  if (provider.label.trim() !== provider.label || provider.label.length === 0 || provider.label.length > 80) {
    throw new TypeError("Product view provider label is invalid");
  }
  validatePreferences(provider.preferences ?? []);
}

function snapshotProvider<Model, Context>(
  provider: RegisteredProductViewProvider<Model, Context>,
): RegisteredProductViewProvider<Model, Context> {
  const preferences = provider.preferences === undefined
    ? undefined
    : Object.freeze(provider.preferences.map((preference) => Object.freeze({
        key: preference.key,
        label: preference.label,
        description: preference.description,
        defaultValue: preference.defaultValue,
        choices: Object.freeze(preference.choices.map((choice) => Object.freeze({
          value: choice.value,
          label: choice.label,
        }))),
      })));
  return Object.freeze({
    id: provider.id,
    label: provider.label,
    ...(preferences === undefined ? {} : { preferences }),
    renderContent(model: Model, context: Context) {
      return provider.renderContent(model, context);
    },
  });
}

function validatePreferences(preferences: readonly RegisteredProductViewPreference[]): void {
  if (preferences.length > 8) throw new TypeError("Product view provider has too many preferences");
  const keys = new Set<string>();
  for (const preference of preferences) {
    if (!PREFERENCE_KEY.test(preference.key)) throw new TypeError("Product view preference key is invalid");
    if (keys.has(preference.key)) throw new TypeError("Product view preference key is duplicated");
    keys.add(preference.key);
    if (preference.label.trim() !== preference.label || preference.label.length === 0 || preference.label.length > 80) {
      throw new TypeError("Product view preference label is invalid");
    }
    if (preference.description.trim() !== preference.description || preference.description.length === 0 || preference.description.length > 200) {
      throw new TypeError("Product view preference description is invalid");
    }
    if (preference.choices.length < 2 || preference.choices.length > 8) {
      throw new TypeError("Product view preference requires 2 to 8 choices");
    }
    const values = new Set<string>();
    for (const choice of preference.choices) {
      if (!PREFERENCE_VALUE.test(choice.value)) throw new TypeError("Product view preference choice value is invalid");
      if (values.has(choice.value)) throw new TypeError("Product view preference choice is duplicated");
      values.add(choice.value);
      if (choice.label.trim() !== choice.label || choice.label.length === 0 || choice.label.length > 80) {
        throw new TypeError("Product view preference choice label is invalid");
      }
    }
    if (!values.has(preference.defaultValue)) throw new TypeError("Product view preference default choice is missing");
  }
}
