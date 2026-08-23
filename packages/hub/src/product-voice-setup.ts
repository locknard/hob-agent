import {
  MacOSKeychainSecretVault,
  type WritableSecretVault,
} from "@hob-agent/agent-layer/model-credentials";
import { Context, Service } from "@deepseek-ai/cordis";

const SETUP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const STAGE_NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const VOICE_LABEL = /^[^\u0000-\u001f\u007f]{1,128}$/u;

export type ProductVoiceTrackKind = "asr" | "tts";
export type ProductVoiceTransport = "wyoming" | "openai_http";

export type ProductVoiceTrackInput =
  | {
      readonly kind: "asr";
      readonly transport: ProductVoiceTransport;
      readonly endpoint: string;
      /** Request-local only. Successful probes retain only a secret locator. */
      readonly credential?: string;
    }
  | {
      readonly kind: "tts";
      readonly transport: ProductVoiceTransport;
      readonly endpoint: string;
      readonly credential?: string;
      readonly locale: string;
      readonly voice?: string;
    };

export type ProductVoiceSetupStage =
  | {
      readonly kind: "asr";
      readonly transport: ProductVoiceTransport;
      readonly endpoint: string;
      readonly credentialRef?: string;
    }
  | {
      readonly kind: "tts";
      readonly transport: ProductVoiceTransport;
      readonly endpoint: string;
      readonly credentialRef?: string;
      readonly locale: string;
      readonly voice?: string;
    };

export type ProductVoiceProbeFailure =
  | { readonly status: "credential_rejected" }
  | { readonly status: "endpoint_unreachable" }
  | { readonly status: "timed_out" }
  | { readonly status: "incompatible" }
  | { readonly status: "unavailable" };

export type ProductVoiceProbeOutcome =
  | { readonly status: "ready"; readonly latencyMs: number; readonly staged: ProductVoiceSetupStage }
  | { readonly status: "missing"; readonly field: "endpoint" | "locale" }
  | ProductVoiceProbeFailure;

/**
 * The transport adapter receives metadata plus a short-lived credential only
 * while probing. It exposes a deliberately small, provider-neutral result.
 */
export type ProductVoiceTransportProbe = (input: {
  readonly track: ProductVoiceSetupStage;
  readonly credential?: string;
}) => Promise<{ readonly status: "ready"; readonly latencyMs: number } | ProductVoiceProbeFailure>;

export interface ProductVoiceSetupOptions {
  readonly vault?: WritableSecretVault;
  readonly probe?: ProductVoiceTransportProbe;
  /** Injected only for deterministic staged-locator tests. */
  readonly createStageNonce?: () => string;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    productVoiceSetup: ProductVoiceSetupService;
  }
}

/**
 * Stages one independent ASR or TTS provider for a setup draft.
 *
 * It neither selects a runtime profile nor starts audio capture. The future
 * Wyoming and OpenAI-compatible adapters implement `probe`; this owner keeps
 * their configuration and credential lifecycle identical.
 */
export class ProductVoiceSetup {
  private readonly vault: WritableSecretVault;
  private readonly transportProbe: ProductVoiceTransportProbe;
  private readonly createStageNonce: () => string;

  constructor(options: ProductVoiceSetupOptions = {}) {
    this.vault = options.vault ?? new MacOSKeychainSecretVault();
    this.transportProbe = options.probe ?? unavailableProbe;
    this.createStageNonce = options.createStageNonce ?? (() => globalThis.crypto.randomUUID().replace(/-/gu, ""));
  }

  async probe(input: { readonly setupId: string; readonly track: ProductVoiceTrackInput }): Promise<ProductVoiceProbeOutcome> {
    const prepared = prepareInput(input);
    if ("status" in prepared) return prepared;

    const staged = createStage(prepared, this.createStageNonce());
    const credential = credentialValue(prepared.track.credential);
    if (credential !== undefined && staged.credentialRef !== undefined) {
      try {
        await this.vault.write(staged.credentialRef, credential);
      } catch {
        await this.discard(staged).catch(() => undefined);
        return { status: "unavailable" };
      }
    }

    try {
      const result = await this.transportProbe({ track: staged, ...(credential === undefined ? {} : { credential }) });
      if (result.status === "ready" && Number.isSafeInteger(result.latencyMs) && result.latencyMs >= 0 && result.latencyMs <= 120_000) {
        return { status: "ready", latencyMs: result.latencyMs, staged };
      }
      await this.discard(staged);
      return result.status === "ready" ? { status: "incompatible" } : result;
    } catch {
      await this.discard(staged).catch(() => undefined);
      return { status: "endpoint_unreachable" };
    }
  }

  /** Removes only the exact locator created for this staged voice track. */
  async discard(stage: ProductVoiceSetupStage): Promise<void> {
    const reference = stage.credentialRef;
    if (reference === undefined) {
      validateCredentialFreeStage(stage);
      return;
    }
    validateStagedCredentialReference(stage);
    await this.vault.delete(reference);
  }
}

/** Cordis-mounted owner for provider setup; mounting it never opens a microphone or audio stream. */
export class ProductVoiceSetupService extends Service {
  private readonly setup: ProductVoiceSetup;

  constructor(ctx: Context, options: ProductVoiceSetupOptions = {}) {
    super(ctx, "productVoiceSetup");
    this.setup = new ProductVoiceSetup(options);
  }

  probe(input: Parameters<ProductVoiceSetup["probe"]>[0]): ReturnType<ProductVoiceSetup["probe"]> {
    return this.setup.probe(input);
  }

  discard(stage: ProductVoiceSetupStage): Promise<void> {
    return this.setup.discard(stage);
  }
}

function prepareInput(input: { readonly setupId: string; readonly track: ProductVoiceTrackInput }):
  | { readonly setupId: string; readonly track: ProductVoiceTrackInput }
  | Exclude<ProductVoiceProbeOutcome, { readonly status: "ready" }> {
  validateSetupId(input.setupId);
  const track = input.track;
  if (typeof track.endpoint !== "string" || track.endpoint.trim().length === 0) return { status: "missing", field: "endpoint" };
  if (track.kind === "tts" && (typeof track.locale !== "string" || track.locale.trim().length === 0)) {
    return { status: "missing", field: "locale" };
  }
  try {
    const endpoint = normalizeEndpoint(track.transport, track.endpoint);
    const credential = credentialValue(track.credential);
    if (track.kind === "asr") return { setupId: input.setupId, track: { ...track, endpoint, ...(credential === undefined ? {} : { credential }) } };
    const locale = normalizeLocale(track.locale);
    const voice = normalizeOptionalLabel(track.voice);
    return {
      setupId: input.setupId,
      track: { ...track, endpoint, locale, ...(voice === undefined ? {} : { voice }), ...(credential === undefined ? {} : { credential }) },
    };
  } catch {
    return { status: "incompatible" };
  }
}

function createStage(input: { readonly setupId: string; readonly track: ProductVoiceTrackInput }, nonce: string): ProductVoiceSetupStage {
  if (!STAGE_NONCE.test(nonce)) throw new TypeError("Voice setup staging nonce is invalid");
  const credential = credentialValue(input.track.credential);
  const credentialRef = credential === undefined
    ? undefined
    : `keychain:hob-agent/voice:${input.track.kind}:${input.setupId}:${nonce}`;
  if (input.track.kind === "asr") {
    return Object.freeze({
      kind: "asr",
      transport: input.track.transport,
      endpoint: input.track.endpoint,
      ...(credentialRef === undefined ? {} : { credentialRef }),
    });
  }
  return Object.freeze({
    kind: "tts",
    transport: input.track.transport,
    endpoint: input.track.endpoint,
    ...(credentialRef === undefined ? {} : { credentialRef }),
    locale: input.track.locale,
    ...(input.track.voice === undefined ? {} : { voice: input.track.voice }),
  });
}

function normalizeEndpoint(transport: ProductVoiceTransport, value: string): string {
  if (transport !== "wyoming" && transport !== "openai_http") throw new TypeError("Voice endpoint transport is invalid");
  const endpoint = new URL(value.trim());
  const requiredProtocol = transport === "wyoming" ? "wyoming:" : undefined;
  if (requiredProtocol !== undefined && endpoint.protocol !== requiredProtocol) throw new TypeError("Voice endpoint transport is invalid");
  if (transport === "openai_http" && endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new TypeError("Voice endpoint transport is invalid");
  }
  if (endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "") {
    throw new TypeError("Voice endpoint credentials are invalid");
  }
  if (endpoint.pathname !== "" && endpoint.pathname !== "/") throw new TypeError("Voice endpoint path is invalid");
  if (transport === "wyoming" && endpoint.port === "") throw new TypeError("Wyoming endpoint port is required");
  if (!isLocalVoiceHost(endpoint.hostname)) throw new TypeError("Voice endpoint host is invalid");
  return endpoint.toString().replace(/\/$/u, "");
}

function isLocalVoiceHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]" || host.endsWith(".local") || host.endsWith(".lan")) return true;
  const octets = host.split(".").map((segment) => Number(segment));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31);
}

function normalizeLocale(value: string): string {
  const [locale] = Intl.getCanonicalLocales(value.trim());
  if (locale === undefined || locale.length > 35) throw new TypeError("Voice locale is invalid");
  return locale;
}

function normalizeOptionalLabel(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !VOICE_LABEL.test(value.trim())) throw new TypeError("Voice label is invalid");
  return value.trim();
}

function credentialValue(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 16_384) throw new TypeError("Voice credential is invalid");
  return value;
}

function validateSetupId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SETUP_ID.test(value)) throw new TypeError("Voice setup draft id is invalid");
}

function validateCredentialFreeStage(stage: ProductVoiceSetupStage): void {
  if (stage.kind !== "asr" && stage.kind !== "tts") throw new TypeError("Voice setup stage is invalid");
  normalizeEndpoint(stage.transport, stage.endpoint);
  if (stage.kind === "tts") {
    normalizeLocale(stage.locale);
    normalizeOptionalLabel(stage.voice);
  }
}

function validateStagedCredentialReference(stage: ProductVoiceSetupStage): void {
  validateCredentialFreeStage({ ...stage, credentialRef: undefined } as ProductVoiceSetupStage);
  const reference = stage.credentialRef;
  const match = typeof reference === "string"
    ? /^keychain:hob-agent\/voice:(asr|tts):([A-Za-z0-9][A-Za-z0-9_-]{0,127}):([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/u.exec(reference)
    : null;
  if (match === null || match[1] !== stage.kind) throw new TypeError("Voice setup stage is invalid");
}

async function unavailableProbe(): Promise<ProductVoiceProbeFailure> {
  return { status: "unavailable" };
}
