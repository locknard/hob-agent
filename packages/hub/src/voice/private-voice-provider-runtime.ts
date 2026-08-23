import {
  parseSecretRef,
  type SecretVault,
} from "@hob-agent/agent-layer/model-credentials";

import {
  OpenAiHttpVoiceTransport,
  type OpenAiHttpVoiceFailureReason,
} from "./openai-http-voice-transport.js";
import {
  WyomingVoiceTransport,
  type WyomingAudioFormat,
  type WyomingVoiceTransportFailure,
} from "./wyoming-voice-transport.js";
import { normalizePrivateVoiceEndpoint } from "./private-voice-endpoint.js";
import type { ProductVoiceRuntimeConfig } from "../product-bootstrap-config-store.js";

export type { ProductVoiceRuntimeConfig } from "../product-bootstrap-config-store.js";

const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 4_096;
const AUDIO_MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
const VOICE_CREDENTIAL_REF = /^keychain:hob-agent\/voice:(asr|tts):[A-Za-z0-9][A-Za-z0-9_-]{0,127}:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export type PrivateVoiceProviderRuntimeStatus =
  | { readonly status: "active" }
  | { readonly status: "degraded"; readonly reason: PrivateVoiceProviderFailureReason }
  | { readonly status: "disabled" };

/** Closed, provider-detail-free outcomes for setup and turn operations. */
export type PrivateVoiceProviderFailureReason =
  | "cancelled"
  | "credential_missing"
  | "credential_rejected"
  | "degraded"
  | "disabled"
  | "endpoint_unreachable"
  | "incompatible"
  | "invalid_input"
  | "limit_exceeded"
  | "timed_out"
  | "unavailable";

export interface PrivateVoiceProviderRuntimeOptions {
  readonly config: ProductVoiceRuntimeConfig;
  /** Read only at activation, for the exact configured OpenAI-compatible locator. */
  readonly vault: SecretVault;
}

export interface PrivateVoiceTranscriptionInput {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  /** Required only when the selected ASR provider uses Wyoming audio frames. */
  readonly format?: WyomingAudioFormat;
  readonly signal?: AbortSignal;
}

export interface PrivateVoiceSynthesisInput {
  readonly text: string;
  readonly signal?: AbortSignal;
}

export type PrivateVoiceTranscriptionResult =
  | { readonly status: "transcribed"; readonly text: string; readonly locale?: string }
  | { readonly status: "failed"; readonly reason: PrivateVoiceProviderFailureReason };

export type PrivateVoiceSynthesisResult =
  | { readonly status: "synthesized"; readonly mimeType: string; readonly audio: Uint8Array; readonly format?: WyomingAudioFormat }
  | { readonly status: "failed"; readonly reason: PrivateVoiceProviderFailureReason };

type ActiveAsrProvider =
  | { readonly transport: "openai_http"; readonly provider: OpenAiHttpVoiceTransport }
  | { readonly transport: "wyoming"; readonly provider: WyomingVoiceTransport; readonly model?: string };

type ActiveTtsProvider =
  | { readonly transport: "openai_http"; readonly provider: OpenAiHttpVoiceTransport; readonly locale: string; readonly voice: string }
  | { readonly transport: "wyoming"; readonly provider: WyomingVoiceTransport; readonly locale: string; readonly voice?: string };

/**
 * Activates exactly one configured ASR provider and one configured TTS provider.
 * It never captures microphone audio or plays synthesized audio. The caller owns
 * both boundaries and supplies each bounded turn payload explicitly.
 */
export class PrivateVoiceProviderRuntime {
  private statusValue: PrivateVoiceProviderRuntimeStatus = { status: "disabled" };
  private asr: ActiveAsrProvider | undefined;
  private tts: ActiveTtsProvider | undefined;
  private activationTask: Promise<PrivateVoiceProviderRuntimeStatus> | undefined;
  private startController: AbortController | undefined;
  private readonly operations = new Set<AbortController>();
  private disposed = false;

  constructor(private readonly options: PrivateVoiceProviderRuntimeOptions) {}

  get status(): PrivateVoiceProviderRuntimeStatus { return this.statusValue; }
  get captureMode(): "encoded_audio" | "pcm_s16le" {
    return this.options.config.asr.transport === "wyoming" ? "pcm_s16le" : "encoded_audio";
  }

  /** Resolves each exact secret locator once, probes both tracks, then becomes active atomically. */
  start(): Promise<PrivateVoiceProviderRuntimeStatus> {
    if (this.disposed) return Promise.resolve(this.statusValue);
    if (this.activationTask !== undefined) return this.activationTask;
    if (this.statusValue.status !== "disabled") return Promise.resolve(this.statusValue);
    return this.activateNow();
  }

  /** Rechecks a degraded provider pair without granting calls until both probes succeed. */
  retry(): Promise<PrivateVoiceProviderRuntimeStatus> {
    if (this.disposed || this.statusValue.status === "disabled") return Promise.resolve(this.statusValue);
    if (this.statusValue.status === "active") return Promise.resolve(this.statusValue);
    if (this.activationTask !== undefined) return this.activationTask;
    return this.activateNow();
  }

  private activateNow(): Promise<PrivateVoiceProviderRuntimeStatus> {
    this.startController = new AbortController();
    const task = this.activate(this.startController.signal).finally(() => {
      if (this.activationTask === task) this.activationTask = undefined;
    });
    this.activationTask = task;
    return task;
  }

  async transcribe(input: PrivateVoiceTranscriptionInput): Promise<PrivateVoiceTranscriptionResult> {
    const inactive = this.inactiveFailure();
    if (inactive !== undefined) return inactive;
    if (!validAudioInput(input)) return failed("invalid_input");
    return this.runOperation(input.signal, async (signal) => {
      const provider = this.asr;
      if (provider === undefined) return failed("degraded");
      if (provider.transport === "openai_http") {
        const result = await provider.provider.transcribe({
          audio: input.audio,
          mimeType: input.mimeType,
          signal,
        });
        if (result.status === "failed") return this.providerFailure(result.reason);
        return {
          status: "transcribed",
          text: result.text,
        };
      }
      if (!validWyomingFormat(input.format)) return failed("invalid_input");
      const result = await provider.provider.transcribe({
        audio: input.audio,
        format: input.format,
        ...(provider.model === undefined ? {} : { model: provider.model }),
        signal,
      });
      if (result.status !== "transcript") return this.providerFailure(mapWyomingFailure(result));
      return {
        status: "transcribed",
        text: result.text,
        ...(result.language === undefined ? {} : { locale: result.language }),
      };
    });
  }

  async synthesize(input: PrivateVoiceSynthesisInput): Promise<PrivateVoiceSynthesisResult> {
    const inactive = this.inactiveFailure();
    if (inactive !== undefined) return inactive;
    if (!validText(input.text) || !validSignal(input.signal)) return failed("invalid_input");
    return this.runOperation(input.signal, async (signal) => {
      const provider = this.tts;
      if (provider === undefined) return failed("degraded");
      if (provider.transport === "openai_http") {
        const result = await provider.provider.synthesize({ text: input.text, voice: provider.voice, locale: provider.locale, signal });
        return result.status === "failed"
          ? this.providerFailure(result.reason)
          : { status: "synthesized", mimeType: result.mimeType, audio: result.audio };
      }
      const result = await provider.provider.synthesize({
        text: input.text,
        ...(provider.voice === undefined ? { voice: { language: provider.locale } } : { voice: { name: provider.voice, language: provider.locale } }),
        signal,
      });
      return result.status === "audio"
        ? { status: "synthesized", mimeType: "audio/l16", audio: result.audio, format: result.format }
        : this.providerFailure(mapWyomingFailure(result));
    });
  }

  /** Cancels only currently running probes or turn calls. Repeating it has no additional effect. */
  cancel(): void {
    this.startController?.abort();
    for (const controller of this.operations) controller.abort();
  }

  /** Disables future calls and cancels in-flight work. Repeating disposal is safe. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.asr = undefined;
    this.tts = undefined;
    this.statusValue = { status: "disabled" };
    await this.activationTask?.catch(() => undefined);
  }

  private async activate(signal: AbortSignal): Promise<PrivateVoiceProviderRuntimeStatus> {
    try {
      const [asr, tts] = await Promise.all([
        this.createAsr(signal),
        this.createTts(signal),
      ]);
      if (this.disposed) return this.statusValue;
      if ("reason" in asr) return this.degrade(asr.reason);
      if ("reason" in tts) return this.degrade(tts.reason);
      const [asrProbe, ttsProbe] = await Promise.all([probeAsr(asr, signal), probeTts(tts, signal)]);
      if (this.disposed) return this.statusValue;
      if (asrProbe !== undefined) return this.degrade(asrProbe);
      if (ttsProbe !== undefined) return this.degrade(ttsProbe);
      this.asr = asr;
      this.tts = tts;
      this.statusValue = { status: "active" };
      return this.statusValue;
    } catch {
      return this.disposed ? this.statusValue : this.degrade("unavailable");
    } finally {
      this.startController = undefined;
    }
  }

  private async createAsr(signal: AbortSignal): Promise<ActiveAsrProvider | { readonly reason: PrivateVoiceProviderFailureReason }> {
    const config = this.options.config.asr;
    if (config.transport === "wyoming") {
      try {
        if (config.credentialRef !== undefined) return { reason: "incompatible" };
        const endpoint = normalizePrivateVoiceEndpoint("wyoming", config.endpoint);
        const model = config.model === undefined ? undefined : cleanLabel(config.model, 128);
        return {
          transport: "wyoming",
          provider: new WyomingVoiceTransport({ endpoint }),
          ...(model === undefined ? {} : { model }),
        };
      } catch {
        return { reason: "incompatible" };
      }
    }
    const credential = await this.credential("asr", config.credentialRef, signal);
    if ("reason" in credential) return credential;
    try {
      const endpoint = normalizePrivateVoiceEndpoint("openai_http", config.endpoint, { hasCredential: credential.value !== undefined });
      return {
        transport: "openai_http",
        provider: new OpenAiHttpVoiceTransport({
          baseUrl: endpoint,
          ...(credential.value === undefined ? {} : { credential: credential.value }),
          ...(config.model === undefined ? {} : { asrModel: config.model }),
        }),
      };
    } catch {
      return { reason: "incompatible" };
    }
  }

  private async createTts(signal: AbortSignal): Promise<ActiveTtsProvider | { readonly reason: PrivateVoiceProviderFailureReason }> {
    const config = this.options.config.tts;
    if (config.transport === "wyoming") {
      try {
        if (config.credentialRef !== undefined || config.model !== undefined) {
          return { reason: "incompatible" };
        }
        const endpoint = normalizePrivateVoiceEndpoint("wyoming", config.endpoint);
        return {
          transport: "wyoming",
          provider: new WyomingVoiceTransport({ endpoint }),
          locale: canonicalLocale(config.locale),
          ...(config.voice === undefined ? {} : { voice: cleanLabel(config.voice, 128) }),
        };
      } catch {
        return { reason: "incompatible" };
      }
    }
    const credential = await this.credential("tts", config.credentialRef, signal);
    if ("reason" in credential) return credential;
    try {
      const endpoint = normalizePrivateVoiceEndpoint("openai_http", config.endpoint, { hasCredential: credential.value !== undefined });
      return {
        transport: "openai_http",
        provider: new OpenAiHttpVoiceTransport({
          baseUrl: endpoint,
          ...(credential.value === undefined ? {} : { credential: credential.value }),
          ...(config.model === undefined ? {} : { ttsModel: config.model }),
        }),
        locale: canonicalLocale(config.locale),
        voice: config.voice === undefined ? "alloy" : cleanLabel(config.voice, 128),
      };
    } catch {
      return { reason: "incompatible" };
    }
  }

  private async credential(
    kind: "asr" | "tts",
    reference: string | undefined,
    signal: AbortSignal,
  ): Promise<{ readonly value: string | undefined } | { readonly reason: PrivateVoiceProviderFailureReason }> {
    if (reference === undefined) return { value: undefined };
    try {
      const parsed = parseSecretRef(reference);
      if (`${parsed.source}:${parsed.id}` !== reference || !VOICE_CREDENTIAL_REF.test(reference) || !reference.includes(`voice:${kind}:`)) {
        return { reason: "incompatible" };
      }
      if (signal.aborted) return { reason: "cancelled" };
      const value = await awaitWithSignal(this.options.vault.read(reference), signal);
      if (signal.aborted) return { reason: "cancelled" };
      if (typeof value !== "string" || value.length === 0) return { reason: "credential_missing" };
      return { value };
    } catch {
      return { reason: signal.aborted ? "cancelled" : "unavailable" };
    }
  }

  private inactiveFailure(): { readonly status: "failed"; readonly reason: PrivateVoiceProviderFailureReason } | undefined {
    if (this.disposed || this.statusValue.status === "disabled") return failed("disabled");
    if (this.statusValue.status === "degraded") return failed("degraded");
    return undefined;
  }

  private async runOperation<T extends PrivateVoiceTranscriptionResult | PrivateVoiceSynthesisResult>(
    callerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    this.operations.add(controller);
    try {
      return await operation(combineSignals(callerSignal, controller.signal));
    } finally {
      this.operations.delete(controller);
    }
  }

  private providerFailure(reason: PrivateVoiceProviderFailureReason): { readonly status: "failed"; readonly reason: PrivateVoiceProviderFailureReason } {
    if (reason !== "cancelled" && reason !== "invalid_input") this.degrade(reason);
    return failed(reason);
  }

  private degrade(reason: PrivateVoiceProviderFailureReason): PrivateVoiceProviderRuntimeStatus {
    this.asr = undefined;
    this.tts = undefined;
    this.statusValue = { status: "degraded", reason };
    return this.statusValue;
  }
}

async function probeAsr(provider: ActiveAsrProvider, signal: AbortSignal): Promise<PrivateVoiceProviderFailureReason | undefined> {
  if (provider.transport === "openai_http") {
    const result = await provider.provider.probe({ kind: "asr", signal });
    return result.status === "ready" ? undefined : mapOpenAiFailure(result.reason);
  }
  const result = await provider.provider.describe({ signal });
  return result.status === "ready" && result.services.asr ? undefined : result.status === "ready" ? "incompatible" : mapWyomingFailure(result);
}

async function probeTts(provider: ActiveTtsProvider, signal: AbortSignal): Promise<PrivateVoiceProviderFailureReason | undefined> {
  if (provider.transport === "openai_http") {
    const result = await provider.provider.probe({ kind: "tts", locale: provider.locale, voice: provider.voice, signal });
    return result.status === "ready" ? undefined : mapOpenAiFailure(result.reason);
  }
  const result = await provider.provider.describe({ signal });
  return result.status === "ready" && result.services.tts ? undefined : result.status === "ready" ? "incompatible" : mapWyomingFailure(result);
}

function mapOpenAiFailure(reason: OpenAiHttpVoiceFailureReason): PrivateVoiceProviderFailureReason {
  return reason;
}

function mapWyomingFailure(result: WyomingVoiceTransportFailure): PrivateVoiceProviderFailureReason {
  switch (result.status) {
    case "unavailable": return "endpoint_unreachable";
    case "timed_out": return "timed_out";
    case "cancelled": return "cancelled";
    case "incompatible": return "incompatible";
    case "limit_exceeded": return "limit_exceeded";
  }
}

function failed(reason: PrivateVoiceProviderFailureReason): { readonly status: "failed"; readonly reason: PrivateVoiceProviderFailureReason } {
  return { status: "failed", reason };
}

function validAudioInput(input: PrivateVoiceTranscriptionInput): boolean {
  return input.audio instanceof Uint8Array
    && input.audio.byteLength > 0
    && input.audio.byteLength <= MAX_AUDIO_BYTES
    && typeof input.mimeType === "string"
    && input.mimeType.length <= 128
    && AUDIO_MIME_TYPE.test(input.mimeType.toLowerCase())
    && validSignal(input.signal);
}

function validWyomingFormat(value: WyomingAudioFormat | undefined): value is WyomingAudioFormat {
  return value !== undefined
    && Number.isSafeInteger(value.rate) && value.rate >= 1 && value.rate <= 384_000
    && Number.isSafeInteger(value.width) && value.width >= 1 && value.width <= 8
    && Number.isSafeInteger(value.channels) && value.channels >= 1 && value.channels <= 8;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT_CHARS && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validSignal(value: unknown): value is AbortSignal | undefined {
  return value === undefined || value instanceof AbortSignal;
}

function validOptionalText(value: unknown, maximum: number): value is string {
  return value === undefined || (typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum && !/[\u0000-\u001f\u007f<>]/u.test(value));
}

function cleanLabel(value: unknown, maximum: number): string {
  if (!validOptionalText(value, maximum) || value === undefined) throw new TypeError("Voice label is invalid");
  return value.trim();
}

function canonicalLocale(value: unknown): string {
  if (!validOptionalText(value, 35) || value === undefined) throw new TypeError("Voice locale is invalid");
  const [locale] = Intl.getCanonicalLocales(value.trim());
  if (locale === undefined || locale.length > 35) throw new TypeError("Voice locale is invalid");
  return locale;
}

function combineSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  if (first === undefined) return second;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([first, second]);
  const controller = new AbortController();
  const abort = (signal: AbortSignal): void => controller.abort(signal.reason);
  if (first.aborted) abort(first);
  else first.addEventListener("abort", () => abort(first), { once: true });
  if (second.aborted) abort(second);
  else second.addEventListener("abort", () => abort(second), { once: true });
  return controller.signal;
}

function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Voice operation cancelled"));
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => settle(() => reject(new Error("Voice operation cancelled")));
    const settle = (complete: () => void): void => {
      signal.removeEventListener("abort", cancel);
      complete();
    };
    signal.addEventListener("abort", cancel, { once: true });
    operation.then((value) => settle(() => resolve(value)), (error: unknown) => settle(() => reject(error)));
  });
}
