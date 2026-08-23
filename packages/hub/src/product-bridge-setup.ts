import { createHash } from "node:crypto";

import {
  MacOSKeychainSecretVault,
  type WritableSecretVault,
} from "@hob-agent/agent-layer/model-credentials";

import {
  createBuiltinProductBridgeSetupCatalog,
  type ProductBridgeSetupProbeResult,
  type ProductBridgeSetupRegistration,
} from "./bridge/bridge-bundle.js";

const SETUP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const STAGE_NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export type ProductBridgeProbeOutcome =
  | {
      readonly status: "ready";
      readonly latencyMs: number;
      readonly summary: { readonly states: number; readonly entities: number; readonly devices: number; readonly areas: number };
      readonly stage: ProductBridgeSetupStage;
    }
  | { readonly status: "missing"; readonly field: "credential" }
  | { readonly status: "credential_rejected" | "endpoint_unreachable" | "incompatible" | "timed_out" };

export interface ProductBridgeSetupStage {
  readonly bridgeId: string;
  readonly adapterType: string;
  readonly label: string;
  readonly endpoint?: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly credentialRefs: Readonly<Record<string, string>>;
}

interface ProductBridgeSetupOptions {
  readonly vault?: WritableSecretVault;
  readonly registrations?: readonly ProductBridgeSetupRegistration[];
  readonly createStageNonce?: () => string;
}

/** Stages one catalog-selected bridge credential and retains it only after a read probe. */
export class ProductBridgeSetup {
  private readonly vault: WritableSecretVault;
  private readonly registrations: ReadonlyMap<string, ProductBridgeSetupRegistration>;
  private readonly createStageNonce: () => string;

  constructor(options: ProductBridgeSetupOptions = {}) {
    this.vault = options.vault ?? new MacOSKeychainSecretVault();
    const registrations = options.registrations ?? createBuiltinProductBridgeSetupCatalog();
    this.registrations = new Map(registrations.map((registration) => [registration.adapterType, registration]));
    this.createStageNonce = options.createStageNonce ?? (() => globalThis.crypto.randomUUID().replace(/-/gu, ""));
  }

  async probe(input: {
    readonly setupId: string;
    readonly adapterType: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly credential: string;
  }): Promise<ProductBridgeProbeOutcome> {
    validateSetupId(input.setupId);
    const registration = this.registrations.get(input.adapterType);
    if (registration === undefined) return { status: "incompatible" };
    if (typeof input.credential !== "string" || input.credential.trim() === "") return { status: "missing", field: "credential" };
    let config: Readonly<Record<string, unknown>>;
    let endpoint: string | undefined;
    try {
      config = registration.normalizeConfig(input.config);
      endpoint = registration.displayEndpoint === undefined
        ? undefined
        : normalizeDisplayEndpoint(registration.displayEndpoint(config));
    } catch {
      return { status: "incompatible" };
    }
    const nonce = this.createStageNonce();
    if (!STAGE_NONCE.test(nonce)) throw new TypeError("Bridge setup staging nonce is invalid");
    const bridgeId = `bridge-${createHash("sha256").update(`${input.setupId}:${input.adapterType}:${nonce}`).digest("hex").slice(0, 16)}`;
    const credentialRef = `keychain:hob-agent/bridge:${bridgeId}:${registration.credentialAlias}`;
    const stage: ProductBridgeSetupStage = Object.freeze({
      bridgeId,
      adapterType: registration.adapterType,
      label: registration.label,
      ...(endpoint === undefined ? {} : { endpoint }),
      config,
      credentialRefs: Object.freeze({ [registration.credentialAlias]: credentialRef }),
    });
    try {
      await this.vault.write(credentialRef, input.credential);
      const stagedCredential = await this.vault.read(credentialRef);
      if (stagedCredential === undefined) throw new Error("Staged bridge credential is unavailable");
      const result: ProductBridgeSetupProbeResult = await registration.probe({ config, credential: stagedCredential });
      if (result.status !== "connected") {
        await this.discard(stage);
        return result;
      }
      return { status: "ready", latencyMs: result.latencyMs, summary: result.summary, stage };
    } catch {
      await this.discard(stage).catch(() => undefined);
      return { status: "endpoint_unreachable" };
    }
  }

  async discard(stage: ProductBridgeSetupStage): Promise<void> {
    const refs = Object.values(stage.credentialRefs);
    if (refs.length !== 1 || !refs[0]?.startsWith(`keychain:hob-agent/bridge:${stage.bridgeId}:`)) {
      throw new TypeError("Bridge setup stage is invalid");
    }
    await this.vault.delete(refs[0]);
  }
}

function validateSetupId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SETUP_ID.test(value)) throw new TypeError("Bridge setup draft id is invalid");
}

function normalizeDisplayEndpoint(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Bridge display endpoint is invalid");
  const endpoint = value.trim();
  if (endpoint.length === 0 || endpoint.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(endpoint)) {
    throw new TypeError("Bridge display endpoint is invalid");
  }
  return endpoint;
}
