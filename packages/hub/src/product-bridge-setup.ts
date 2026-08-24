import { createHash } from "node:crypto";

import {
  formatDurableSecretRef,
  MacOSKeychainSecretVault,
  type DurableSecretRefSource,
  type WritableSecretVault,
} from "@hob-agent/agent-layer/model-credentials";

import {
  builtinBridgeProductBundle,
  type BridgeProductBundle,
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
      readonly review: ProductBridgeSetupMapReview;
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

export interface ProductBridgeSetupOptions {
  readonly vault?: WritableSecretVault;
  /** Source for newly staged durable locators; macOS compatibility defaults to keychain. */
  readonly credentialRefSource?: DurableSecretRefSource;
  /** The product-owned bundle is the source of setup peers for an executable runtime. */
  readonly bundle?: BridgeProductBundle;
  /** Narrow test seam for isolated setup behavior. */
  readonly registrations?: readonly ProductBridgeSetupRegistration[];
  readonly createStageNonce?: () => string;
}

/** Validates and probes one catalog-selected bridge through a durable credential lease. */
export class ProductBridgeSetup {
  private readonly vault: WritableSecretVault;
  private readonly registrations: ReadonlyMap<string, ProductBridgeSetupRegistration>;
  private readonly createStageNonce: () => string;
  private readonly credentialRefSource: DurableSecretRefSource;

  constructor(options: ProductBridgeSetupOptions = {}) {
    this.vault = options.vault ?? new MacOSKeychainSecretVault();
    this.credentialRefSource = options.credentialRefSource ?? "keychain";
    if (options.bundle !== undefined && options.registrations !== undefined) {
      throw new TypeError("Bridge setup accepts either a product bundle or isolated registrations");
    }
    const registrations = options.registrations
      ?? options.bundle?.setupRegistrations
      ?? builtinBridgeProductBundle.setupRegistrations;
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
      credentialRefs: Object.freeze({
        [prepared.credentialAlias]: formatDurableSecretRef(
          this.credentialRefSource,
          `hob-agent/bridge:${bridgeId}:${prepared.credentialAlias}`,
        ),
      }),
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
      if (!isCompleteBoundedMapReview(result.review)) return { status: "incompatible" };
      return {
        status: "ready",
        latencyMs: result.latencyMs,
        summary: result.summary,
        review: result.review,
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
  if (!STAGE_NONCE.test(alias) || !new RegExp(`^(?:keychain|vault):hob-agent/bridge:${stage.bridgeId}:${alias}$`, "u").test(reference)) {
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

/** Holds setup success to the same compact, complete map contract activation consumes. */
function isCompleteBoundedMapReview(value: unknown): value is ProductBridgeSetupMapReview {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.complete !== true || !Array.isArray(record.areas) || record.areas.length > 64
    || !Number.isSafeInteger(record.unassignedDeviceCount) || Number(record.unassignedDeviceCount) < 0
    || Number(record.unassignedDeviceCount) > 100_000) return false;
  const names = new Set<string>();
  return record.areas.every((area) => {
    if (area === null || typeof area !== "object") return false;
    const candidate = area as Record<string, unknown>;
    if (typeof candidate.name !== "string" || candidate.name.trim() === ""
      || Array.from(candidate.name).length > 80 || /[\u0000-\u001f\u007f]/u.test(candidate.name)
      || names.has(candidate.name)
      || !Number.isSafeInteger(candidate.deviceCount) || Number(candidate.deviceCount) < 0
      || Number(candidate.deviceCount) > 100_000) return false;
    names.add(candidate.name);
    return true;
  });
}
