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

  async probe(input: ProductModelSetupInput): Promise<ProductModelProbeOutcome> {
    const prepared = prepareInput(input);
    if ("status" in prepared) return prepared;

    const stage = createStage(prepared, this.createStageNonce());
    try {
      await this.vault.write(stage.profile.secretRef!, prepared.apiKey);
    } catch {
      await deleteStagedCredential(this.vault, stage.profile.secretRef!);
      return { status: "unavailable" };
    }

    let result: ProviderProbeResult;
    try {
      result = await this.liveProbe({
        profile: stage.profile,
        vault: this.vault,
        modelId: stage.modelId,
        ...(stage.baseURL === undefined ? {} : { baseURL: stage.baseURL }),
      });
    } catch {
      await deleteStagedCredential(this.vault, stage.profile.secretRef!);
      return { status: "unavailable" };
    }

    const failure = probeFailure(result.status);
    if (failure !== undefined) {
      await deleteStagedCredential(this.vault, stage.profile.secretRef!);
      return failure;
    }

    return { status: "ready", latencyMs: result.latencyMs, staged: stage };
  }

  /** Deletes one explicit staged credential after cancel or failed persistence. */
  async discard(stage: ProductModelSetupStage): Promise<void> {
    setupIdFromStage(stage);
    await deleteStagedCredential(this.vault, stage.profile.secretRef!);
  }
}

function setupIdFromStage(stage: ProductModelSetupStage): string {
  const reference = stage.profile.secretRef;
  if (stage.profile.kind !== "api_key" || reference === undefined) throw new TypeError("Setup model stage is invalid");
  const match = /^keychain:hob-agent\/setup-model:([^:]+):[A-Za-z0-9_-]+$/u.exec(reference);
  if (match === null || stage.profile.id !== `${stage.profile.provider}:setup:${match[1]}`) {
    throw new TypeError("Setup model stage is invalid");
  }
  validateSetupId(match[1]);
  return match[1];
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

function createStage(input: ProductModelSetupInput, nonce: string): ProductModelSetupStage {
  if (!SETUP_ID.test(nonce)) throw new TypeError("Setup model staging nonce is invalid");
  const secretRef = `keychain:hob-agent/setup-model:${input.setupId}:${nonce}`;
  return Object.freeze({
    profile: Object.freeze({
      id: `${input.provider}:setup:${input.setupId}`,
      provider: input.provider,
      kind: "api_key",
      secretRef,
    }),
    modelId: input.modelId,
    ...(input.baseURL === undefined ? {} : { baseURL: input.baseURL }),
  });
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
