import { createHash } from "node:crypto";

import {
  MacOSKeychainSecretVault,
  type WritableSecretVault,
} from "@hob-agent/agent-layer/model-credentials";

import {
  createBuiltinProductBridgeSetupCatalog,
  type ProductBridgeSetupMapReview,
  type ProductBridgeSetupProbeResult,
  type ProductBridgeSetupRegistration,
} from "./bridge/bridge-bundle.js";
import { ProductSetupBridgeCredentialLease } from "./product-setup-draft-store.js";

const SETUP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const STAGE_NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export type ProductBridgeProbeOutcome =
  | {
      readonly status: "ready";
      readonly latencyMs: number;
      readonly summary: { readonly states: number; readonly entities: number; readonly devices: number; readonly areas: number };
      readonly review?: ProductBridgeSetupMapReview;
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

/** Request-local bridge material. Its credential never enters a durable draft. */
export interface ProductBridgePreparedProbe {
  readonly adapterType: string;
  readonly label: string;
  readonly endpoint?: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly credentialAlias: string;
  readonly credential: string;
}

export type ProductBridgePrepareOutcome =
  | { readonly status: "prepared"; readonly prepared: ProductBridgePreparedProbe }
  | Exclude<ProductBridgeProbeOutcome, { readonly status: "ready" }>;

interface ProductBridgeSetupOptions {
  readonly vault?: WritableSecretVault;
  readonly registrations?: readonly ProductBridgeSetupRegistration[];
  readonly createStageNonce?: () => string;
}

/** Validates and probes one catalog-selected bridge through a durable credential lease. */
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

  /** Validates request-local material without writing a bridge credential. */
  prepare(input: {
    readonly setupId: string;
    readonly adapterType: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly credential: string;
  }): ProductBridgePrepareOutcome {
    validateSetupId(input.setupId);
    const registration = this.registrations.get(input.adapterType);
    if (registration === undefined) return { status: "incompatible" };
    if (typeof input.credential !== "string" || input.credential.trim() === "") return { status: "missing", field: "credential" };
    try {
      const config = registration.normalizeConfig(input.config);
      const endpoint = registration.displayEndpoint === undefined
        ? undefined
        : normalizeDisplayEndpoint(registration.displayEndpoint(config));
      return Object.freeze({
        status: "prepared",
        prepared: Object.freeze({
          adapterType: registration.adapterType,
          label: registration.label,
          ...(endpoint === undefined ? {} : { endpoint }),
          config,
          credentialAlias: registration.credentialAlias,
          credential: input.credential,
        }),
      });
    } catch {
      return { status: "incompatible" };
    }
  }

  /** Creates metadata-only bridge evidence for the draft to reserve. */
  stageSetup(prepared: ProductBridgePreparedProbe, setupId: string): ProductBridgeSetupStage {
    validateSetupId(setupId);
    validatePrepared(prepared);
    const nonce = this.createStageNonce();
    if (!STAGE_NONCE.test(nonce)) throw new TypeError("Bridge setup staging nonce is invalid");
    const bridgeId = `bridge-${createHash("sha256").update(`${setupId}:${prepared.adapterType}:${nonce}`).digest("hex").slice(0, 16)}`;
    return Object.freeze({
      bridgeId,
      adapterType: prepared.adapterType,
      label: prepared.label,
      ...(prepared.endpoint === undefined ? {} : { endpoint: prepared.endpoint }),
      config: prepared.config,
      credentialRefs: Object.freeze({ [prepared.credentialAlias]: `keychain:hob-agent/bridge:${bridgeId}:${prepared.credentialAlias}` }),
    });
  }

  /** Executes a probe after the exact staged locator has been durably reserved. */
  async execute(input: {
    readonly prepared: ProductBridgePreparedProbe;
    readonly stage: ProductBridgeSetupStage;
    readonly credentialLease: ProductSetupBridgeCredentialLease;
    readonly signal?: AbortSignal;
  }): Promise<ProductBridgeProbeOutcome> {
    validatePrepared(input.prepared);
    validateStage(input.stage);
    if (!(input.credentialLease instanceof ProductSetupBridgeCredentialLease)) {
      throw new TypeError("Bridge credential execution requires a durable staging lease");
    }
    input.credentialLease.consume(input.stage);
    const reference = input.stage.credentialRefs[input.prepared.credentialAlias];
    if (reference === undefined || input.stage.adapterType !== input.prepared.adapterType
      || input.stage.label !== input.prepared.label || input.stage.endpoint !== input.prepared.endpoint
      || input.stage.config !== input.prepared.config) {
      throw new TypeError("Bridge credential stage does not match its prepared candidate");
    }
    const registration = this.registrations.get(input.prepared.adapterType);
    if (registration === undefined || registration.credentialAlias !== input.prepared.credentialAlias) {
      throw new TypeError("Bridge setup registration is unavailable");
    }
    if (isCancelled(input.signal)) return { status: "endpoint_unreachable" };
    try {
      await this.vault.write(reference, input.prepared.credential);
    } catch {
      return { status: "endpoint_unreachable" };
    }
    if (isCancelled(input.signal)) return { status: "endpoint_unreachable" };
    try {
      const result: ProductBridgeSetupProbeResult = await registration.probe({
        config: input.prepared.config,
        credential: input.prepared.credential,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (isCancelled(input.signal)) return { status: "endpoint_unreachable" };
      if (result.status !== "connected") return result;
      return {
        status: "ready",
        latencyMs: result.latencyMs,
        summary: result.summary,
        ...(result.review === undefined ? {} : { review: result.review }),
        stage: input.stage,
      };
    } catch {
      return { status: "endpoint_unreachable" };
    }
  }

  /** Deletes only one explicit staged bridge credential. */
  async discard(stage: ProductBridgeSetupStage): Promise<void> {
    validateStage(stage);
    const [reference] = Object.values(stage.credentialRefs);
    await this.vault.delete(reference!);
  }
}

function validatePrepared(prepared: ProductBridgePreparedProbe): void {
  if (typeof prepared.adapterType !== "string" || typeof prepared.label !== "string"
    || typeof prepared.credentialAlias !== "string" || typeof prepared.credential !== "string"
    || prepared.credential.trim() === "" || !STAGE_NONCE.test(prepared.adapterType)
    || !STAGE_NONCE.test(prepared.credentialAlias) || prepared.label.trim() === "") {
    throw new TypeError("Prepared bridge candidate is invalid");
  }
  if (prepared.endpoint !== undefined) normalizeDisplayEndpoint(prepared.endpoint);
}

function validateStage(stage: ProductBridgeSetupStage): void {
  if (typeof stage.bridgeId !== "string" || !/^bridge-[a-f0-9]{16}$/u.test(stage.bridgeId)
    || typeof stage.adapterType !== "string" || !STAGE_NONCE.test(stage.adapterType)
    || typeof stage.label !== "string" || stage.label.trim() === "") {
    throw new TypeError("Bridge setup stage is invalid");
  }
  if (stage.endpoint !== undefined) normalizeDisplayEndpoint(stage.endpoint);
  const entries = Object.entries(stage.credentialRefs);
  if (entries.length !== 1) throw new TypeError("Bridge setup stage is invalid");
  const [alias, reference] = entries[0]!;
  if (!STAGE_NONCE.test(alias) || reference !== `keychain:hob-agent/bridge:${stage.bridgeId}:${alias}`) {
    throw new TypeError("Bridge setup stage is invalid");
  }
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
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
