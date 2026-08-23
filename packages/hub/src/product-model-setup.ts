import {
  MacOSKeychainSecretVault,
  type AuthProfile,
  type WritableSecretVault,
} from "@hob-agent/agent-layer/model-credentials";
import {
  probeDshApiKeyProfile,
  type ProviderProbeResult,
} from "@hob-agent/agent-layer/model-credential-probe";
import {
  providerSetup,
  type SupportedModelProvider,
} from "@hob-agent/agent-layer/model-providers";
import { ProductModelCredentialLease as ProductOperationalModelCredentialLease } from "./product-model-cleanup-ledger.js";
import { ProductSetupModelCredentialLease } from "./product-setup-draft-store.js";

const SETUP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MODEL_ID = /^\S{1,256}$/u;

export type ProductModelProbeOutcome =
  | ProductModelProbeReady
  | { readonly status: "missing"; readonly field: "apiKey" | "modelId" | "baseURL" }
  | { readonly status: "rejected" }
  | { readonly status: "timeout" }
  | { readonly status: "unavailable" };

export interface ProductModelProbeReady {
  readonly status: "ready";
  readonly latencyMs: number;
  /** Only locators and deployment metadata leave this boundary. */
  readonly staged: ProductModelSetupStage;
}

/** Non-secret deployment data retained by the setup draft until activation. */
export interface ProductModelSetupStage {
  readonly profile: AuthProfile;
  readonly modelId: string;
  readonly baseURL?: string;
}

/** Request-local validated material; the API key never enters a durable draft. */
export interface ProductModelPreparedProbe {
  readonly provider: SupportedModelProvider;
  readonly modelId: string;
  readonly apiKey: string;
  readonly baseURL?: string;
}

export type ProductModelPrepareOutcome =
  | { readonly status: "prepared"; readonly prepared: ProductModelPreparedProbe }
  | Exclude<ProductModelProbeOutcome, ProductModelProbeReady>;

export interface ProductModelSetupInput {
  /** A durable, non-secret draft identifier; never pass the session token here. */
  readonly setupId: string;
  readonly provider: SupportedModelProvider;
  readonly modelId: string;
  readonly apiKey: string;
  /** Required for custom OpenAI-compatible deployments and forbidden otherwise. */
  readonly baseURL?: string;
}

type ProductModelLiveProbe = (input: {
  readonly profile: AuthProfile;
  readonly vault: WritableSecretVault;
  readonly modelId: string;
  readonly baseURL?: string;
  readonly signal?: AbortSignal;
}) => Promise<ProviderProbeResult>;

export interface ProductModelSetupOptions {
  readonly vault?: WritableSecretVault;
  readonly probe?: ProductModelLiveProbe;
  /** Injected only to make locator lifecycle tests deterministic. */
  readonly createStageNonce?: () => string;
}

/**
 * Prepares and tests a model credential for one setup draft.
 *
 * This owner never publishes AuthProfile metadata or writes a `*:primary`
 * locator. A successful probe leaves its staged key in the vault so activation
 * can mount the exact tested profile; callers must call discard when a draft
 * is abandoned or superseded.
 */
export class ProductModelSetup {
  private readonly vault: WritableSecretVault;
  private readonly liveProbe: ProductModelLiveProbe;
  private readonly createStageNonce: () => string;

  constructor(options: ProductModelSetupOptions = {}) {
    this.vault = options.vault ?? new MacOSKeychainSecretVault();
    this.liveProbe = options.probe ?? probeDshApiKeyProfile;
    this.createStageNonce = options.createStageNonce ?? cryptoRandomStageNonce;
  }

  /** Validates request-local model material without writing its credential. */
  prepare(input: ProductModelSetupInput): ProductModelPrepareOutcome {
    const prepared = prepareInput(input);
    if ("status" in prepared) return prepared;
    const { setupId: _setupId, ...candidate } = prepared;
    return Object.freeze({ status: "prepared", prepared: Object.freeze(candidate) });
  }

  /** Creates the metadata-only setup locator that the draft must reserve before execution. */
  stageSetup(prepared: ProductModelPreparedProbe, setupId: string): ProductModelSetupStage {
    validatePrepared(prepared);
    validateSetupId(setupId);
    return createSetupStage(setupId, prepared, this.createStageNonce());
  }

  /** Creates the strict metadata-only profile that operational settings can reserve before writing. */
  stageOperational(prepared: ProductModelPreparedProbe, candidateId: string): ProductModelSetupStage {
    validatePrepared(prepared);
    const nonce = this.createStageNonce();
    if (!SETUP_ID.test(candidateId) || !SETUP_ID.test(nonce)) throw new TypeError("Operational model staging identity is invalid");
    return Object.freeze({
      profile: Object.freeze({
        id: `${prepared.provider}:operational:${candidateId}`,
        provider: prepared.provider,
        kind: "api_key",
        secretRef: `keychain:hob-agent/model:${candidateId}:${nonce}`,
      }),
      modelId: prepared.modelId,
      ...(prepared.baseURL === undefined ? {} : { baseURL: prepared.baseURL }),
    });
  }

  /** Executes a prepared model probe after its exact staged credential lease has been persisted. */
  async execute(input: {
    readonly prepared: ProductModelPreparedProbe;
    readonly stage: ProductModelSetupStage;
    readonly credentialLease: ProductSetupModelCredentialLease | ProductOperationalModelCredentialLease;
    readonly signal?: AbortSignal;
  }): Promise<ProductModelProbeOutcome> {
    validatePrepared(input.prepared);
    validateStage(input.stage);
    if (input.credentialLease instanceof ProductOperationalModelCredentialLease) {
      input.credentialLease.consume(input.stage.profile.secretRef!);
    } else if (input.credentialLease instanceof ProductSetupModelCredentialLease) {
      input.credentialLease.consume(input.stage);
    } else {
      throw new TypeError("Model credential execution requires a durable staging lease");
    }
    if (input.stage.profile.provider !== input.prepared.provider || input.stage.modelId !== input.prepared.modelId || input.stage.baseURL !== input.prepared.baseURL) {
      throw new TypeError("Model credential stage does not match its prepared candidate");
    }
    if (isCancelled(input.signal)) return { status: "unavailable" };
    try {
      await this.vault.write(input.stage.profile.secretRef!, input.prepared.apiKey);
    } catch {
      return { status: "unavailable" };
    }
    if (isCancelled(input.signal)) return { status: "unavailable" };

    let result: ProviderProbeResult;
    try {
      result = await this.liveProbe({
        profile: input.stage.profile,
        vault: this.vault,
        modelId: input.stage.modelId,
        ...(input.stage.baseURL === undefined ? {} : { baseURL: input.stage.baseURL }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch {
      return { status: "unavailable" };
    }

    const failure = probeFailure(result.status);
    if (failure !== undefined) return failure;

    return { status: "ready", latencyMs: result.latencyMs, staged: input.stage };
  }

  /** Deletes one explicit staged credential after cancel or failed persistence. */
  async discard(stage: ProductModelSetupStage): Promise<void> {
    validateStage(stage);
    await deleteStagedCredential(this.vault, stage.profile.secretRef!);
  }
}

function validateStage(stage: ProductModelSetupStage): void {
  const reference = stage.profile.secretRef;
  if (stage.profile.kind !== "api_key" || reference === undefined) throw new TypeError("Setup model stage is invalid");
  const setup = /^keychain:hob-agent\/setup-model:([^:]+):[A-Za-z0-9_-]+$/u.exec(reference);
  const operational = /^keychain:hob-agent\/model:([^:]+):[A-Za-z0-9_-]+$/u.exec(reference);
  const validSetup = setup !== null && stage.profile.id === `${stage.profile.provider}:setup:${setup[1]}`;
  const validOperational = operational !== null && stage.profile.id === `${stage.profile.provider}:operational:${operational[1]}`;
  if (!validSetup && !validOperational) {
    throw new TypeError("Setup model stage is invalid");
  }
  validateSetupId((setup ?? operational)![1]);
  validatePrepared({ provider: stage.profile.provider as SupportedModelProvider, modelId: stage.modelId, apiKey: "validated", ...(stage.baseURL === undefined ? {} : { baseURL: stage.baseURL }) });
}

function prepareInput(input: ProductModelSetupInput): ProductModelSetupInput | Exclude<ProductModelProbeOutcome, ProductModelProbeReady> {
  validateSetupId(input.setupId);
  if (typeof input.apiKey !== "string" || input.apiKey.trim().length === 0) {
    return { status: "missing", field: "apiKey" };
  }
  if (typeof input.modelId !== "string" || input.modelId.trim().length === 0) {
    return { status: "missing", field: "modelId" };
  }
  if (!MODEL_ID.test(input.modelId)) return { status: "rejected" };

  try {
    if (input.provider === "custom") {
      if (typeof input.baseURL !== "string" || input.baseURL.trim().length === 0) {
        return { status: "missing", field: "baseURL" };
      }
      return { ...input, baseURL: providerSetup("custom", { baseURL: input.baseURL }).baseURL };
    }
    providerSetup(input.provider, input.baseURL === undefined ? undefined : { baseURL: input.baseURL });
    return input;
  } catch {
    return { status: "rejected" };
  }
}

function createSetupStage(setupId: string, input: ProductModelPreparedProbe, nonce: string): ProductModelSetupStage {
  if (!SETUP_ID.test(nonce)) throw new TypeError("Setup model staging nonce is invalid");
  const secretRef = `keychain:hob-agent/setup-model:${setupId}:${nonce}`;
  return Object.freeze({
    profile: Object.freeze({
      id: `${input.provider}:setup:${setupId}`,
      provider: input.provider,
      kind: "api_key",
      secretRef,
    }),
    modelId: input.modelId,
    ...(input.baseURL === undefined ? {} : { baseURL: input.baseURL }),
  });
}

function validatePrepared(input: ProductModelPreparedProbe): void {
  const outcome = prepareInput({ setupId: "prepared-model", ...input });
  if ("status" in outcome) throw new TypeError("Prepared model candidate is invalid");
}

function probeFailure(status: ProviderProbeResult["status"]): Exclude<ProductModelProbeOutcome, ProductModelProbeReady> | undefined {
  if (status === "ok") return undefined;
  if (status === "auth" || status === "billing" || status === "format") return { status: "rejected" };
  if (status === "timeout") return { status: "timeout" };
  return { status: "unavailable" };
}

async function deleteStagedCredential(vault: WritableSecretVault, reference: string): Promise<void> {
  try {
    await vault.delete(reference);
  } catch {
    throw new Error("Staged model credential cleanup failed");
  }
}

function validateSetupId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SETUP_ID.test(value)) throw new TypeError("Setup model draft id is invalid");
}

function cryptoRandomStageNonce(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
