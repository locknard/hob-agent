const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 4_096;
const DEFAULT_MAX_TEXT_CHARS = 4_096;
const MAX_RESPONSE_METADATA_BYTES = 64 * 1024;
const ALLOWED_AUDIO_MIME_TYPES = new Set([
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
]);

export type OpenAiHttpVoiceFailureReason =
  | "cancelled"
  | "credential_rejected"
  | "endpoint_unreachable"
  | "incompatible"
  | "invalid_input"
  | "timed_out"
  | "unavailable";

export type OpenAiHttpVoiceFailure = {
  readonly status: "failed";
  readonly reason: OpenAiHttpVoiceFailureReason;
};

export type OpenAiHttpVoiceTranscript =
  | { readonly status: "transcribed"; readonly text: string }
  | OpenAiHttpVoiceFailure;

export type OpenAiHttpVoiceAudio =
  | { readonly status: "synthesized"; readonly mimeType: string; readonly audio: Uint8Array }
  | OpenAiHttpVoiceFailure;

export type OpenAiHttpVoiceProbe =
  | { readonly status: "ready"; readonly latencyMs: number }
  | OpenAiHttpVoiceFailure;

export interface OpenAiHttpVoiceTransportOptions {
  /** A verified local/private deployment root. This transport adds the only two allowed paths. */
  readonly baseUrl: string;
  /** Held only by this transport instance and sent only as a bearer credential. */
  readonly credential?: string;
  readonly timeoutMs?: number;
  readonly maxAudioBytes?: number;
  readonly maxTranscriptChars?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => number;
}

export interface OpenAiHttpTranscriptionInput {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly locale?: string;
  readonly signal?: AbortSignal;
}

export interface OpenAiHttpSpeechInput {
  readonly text: string;
  readonly voice: string;
  readonly locale: string;
  readonly signal?: AbortSignal;
}

/**
 * Narrow OpenAI-compatible ASR/TTS transport for a verified private endpoint.
 * It owns fixed audio paths, fixed request shapes, bounded payloads, and closed
 * outcomes; provider responses never become product-facing error content.
 */
export class OpenAiHttpVoiceTransport {
  private readonly root: URL;
  private readonly credential: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxAudioBytes: number;
  private readonly maxTranscriptChars: number;
  private readonly fetch: typeof globalThis.fetch;
  private readonly clock: () => number;

  constructor(options: OpenAiHttpVoiceTransportOptions) {
    this.root = normalizeRootUrl(options.baseUrl);
    this.credential = normalizeCredential(options.credential);
    this.timeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10, 120_000, "Voice timeout");
    this.maxAudioBytes = boundedInteger(options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES, 1, 32 * 1024 * 1024, "Voice audio limit");
    this.maxTranscriptChars = boundedInteger(options.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS, 1, 16_384, "Voice transcript limit");
    const fetch = options.fetch ?? globalThis.fetch;
    if (typeof fetch !== "function") throw new TypeError("Voice fetch implementation is invalid");
    this.fetch = fetch;
    this.clock = options.clock ?? Date.now;
  }

  async transcribe(input: OpenAiHttpTranscriptionInput): Promise<OpenAiHttpVoiceTranscript> {
    let prepared: { readonly audio: Uint8Array; readonly mimeType: string; readonly locale?: string };
    try {
      prepared = prepareTranscription(input, this.maxAudioBytes);
    } catch {
      return failure("invalid_input");
    }

    const form = new FormData();
    form.set("model", "whisper-1");
    if (prepared.locale !== undefined) form.set("language", prepared.locale);
    form.set("file", new Blob([Buffer.from(prepared.audio)], { type: prepared.mimeType }), `voice.${extensionForMime(prepared.mimeType)}`);
    return this.request(input.signal, "/v1/audio/transcriptions", {
      method: "POST",
      headers: { accept: "application/json" },
      body: form,
    }, async (response, signal) => {
      const contentType = response.headers.get("content-type");
      if (normalizedMimeType(contentType) !== "application/json") throw new IncompatibleResponse();
      const bytes = await readBoundedResponse(response, Math.min(MAX_RESPONSE_METADATA_BYTES, this.maxAudioBytes), signal);
      const parsed = parseJsonRecord(bytes);
      const text = boundedTranscript(parsed.text, this.maxTranscriptChars);
      if (text === undefined) throw new IncompatibleResponse();
      return { status: "transcribed", text };
    });
  }

  async synthesize(input: OpenAiHttpSpeechInput): Promise<OpenAiHttpVoiceAudio> {
    let prepared: { readonly text: string; readonly voice: string; readonly locale: string };
    try {
      prepared = prepareSpeech(input);
    } catch {
      return failure("invalid_input");
    }
    return this.request(input.signal, "/v1/audio/speech", {
      method: "POST",
      headers: { accept: "audio/wav", "content-type": "application/json" },
      body: JSON.stringify({
        model: "tts-1",
        input: prepared.text,
        voice: prepared.voice,
        response_format: "wav",
      }),
    }, async (response, signal) => {
      const mimeType = normalizedMimeType(response.headers.get("content-type"));
      if (mimeType === undefined || !ALLOWED_AUDIO_MIME_TYPES.has(mimeType)) throw new IncompatibleResponse();
      const audio = await readBoundedResponse(response, this.maxAudioBytes, signal);
      if (audio.byteLength === 0) throw new IncompatibleResponse();
      return { status: "synthesized", mimeType, audio };
    });
  }

  /** A setup probe exercises the same limited endpoint and response contract as a real turn. */
  async probe(input: {
    readonly kind: "asr" | "tts";
    readonly locale?: string;
    readonly voice?: string;
    readonly signal?: AbortSignal;
  }): Promise<OpenAiHttpVoiceProbe> {
    const startedAt = this.clock();
    const outcome = input.kind === "asr"
      ? await this.transcribe({ audio: PROBE_WAV, mimeType: "audio/wav", ...(input.locale === undefined ? {} : { locale: input.locale }), ...(input.signal === undefined ? {} : { signal: input.signal }) })
      : await this.synthesize({ text: "语音服务连接正常。", voice: input.voice ?? "alloy", locale: input.locale ?? "zh-CN", ...(input.signal === undefined ? {} : { signal: input.signal }) });
    if (outcome.status === "failed") return outcome;
    const latencyMs = this.clock() - startedAt;
    return Number.isSafeInteger(latencyMs) && latencyMs >= 0 && latencyMs <= 120_000
      ? { status: "ready", latencyMs }
      : failure("unavailable");
  }

  private async request<T extends { readonly status: string }>(
    parentSignal: AbortSignal | undefined,
    path: "/v1/audio/transcriptions" | "/v1/audio/speech",
    init: RequestInit,
    read: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T | OpenAiHttpVoiceFailure> {
    if (parentSignal?.aborted) return failure("cancelled");
    const controller = new AbortController();
    let stoppedBy: "cancelled" | "timed_out" | undefined;
    const onParentAbort = () => {
      stoppedBy = "cancelled";
      controller.abort();
    };
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    const timeout = setTimeout(() => {
      stoppedBy = "timed_out";
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetch(new URL(path, this.root), {
        ...init,
        headers: { ...this.headers(), ...init.headers },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return failure(classifyHttpStatus(response.status));
      }
      return await read(response, controller.signal);
    } catch (error) {
      if (stoppedBy !== undefined) return failure(stoppedBy);
      if (error instanceof IncompatibleResponse) return failure("incompatible");
      return failure("endpoint_unreachable");
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }

  private headers(): Record<string, string> {
    return this.credential === undefined ? {} : { authorization: `Bearer ${this.credential}` };
  }
}

const PROBE_WAV = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
  0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
  0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
]);

class IncompatibleResponse extends Error {}

function failure(reason: OpenAiHttpVoiceFailureReason): OpenAiHttpVoiceFailure {
  return { status: "failed", reason };
}

function normalizeRootUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) throw new TypeError("Voice endpoint is invalid");
  const root = new URL(value);
  if ((root.protocol !== "http:" && root.protocol !== "https:")
    || root.username !== ""
    || root.password !== ""
    || root.search !== ""
    || root.hash !== ""
    || (root.pathname !== "" && root.pathname !== "/")) {
    throw new TypeError("Voice endpoint is invalid");
  }
  return root;
}

function normalizeCredential(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Voice credential is invalid");
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${label} is invalid`);
  return value;
}

function prepareTranscription(input: OpenAiHttpTranscriptionInput, maxAudioBytes: number): {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly locale?: string;
} {
  if (!(input.audio instanceof Uint8Array) || input.audio.byteLength === 0 || input.audio.byteLength > maxAudioBytes) {
    throw new TypeError("Voice audio is invalid");
  }
  const mimeType = normalizedMimeType(input.mimeType);
  if (mimeType === undefined || !ALLOWED_AUDIO_MIME_TYPES.has(mimeType)) throw new TypeError("Voice audio MIME type is invalid");
  const locale = input.locale === undefined ? undefined : normalizeLocale(input.locale);
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw new TypeError("Voice cancellation signal is invalid");
  return { audio: new Uint8Array(input.audio), mimeType, ...(locale === undefined ? {} : { locale }) };
}

function prepareSpeech(input: OpenAiHttpSpeechInput): { readonly text: string; readonly voice: string; readonly locale: string } {
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw new TypeError("Voice cancellation signal is invalid");
  return {
    text: normalizePlainText(input.text, DEFAULT_MAX_TEXT_CHARS),
    voice: normalizeLabel(input.voice, 128),
    locale: normalizeLocale(input.locale),
  };
}

function normalizePlainText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") throw new TypeError("Voice text is invalid");
  const text = value.trim();
  if (text.length === 0 || text.length > maxLength || /[\u0000-\u001f\u007f<>]/u.test(text)) throw new TypeError("Voice text is invalid");
  return text;
}

function normalizeLabel(value: unknown, maxLength: number): string {
  if (typeof value !== "string") throw new TypeError("Voice label is invalid");
  const label = value.trim();
  if (label.length === 0 || label.length > maxLength || /[\u0000-\u001f\u007f<>]/u.test(label)) throw new TypeError("Voice label is invalid");
  return label;
}

function normalizeLocale(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 35) throw new TypeError("Voice locale is invalid");
  const [locale] = Intl.getCanonicalLocales(value.trim());
  if (locale === undefined || locale.length > 35) throw new TypeError("Voice locale is invalid");
  return locale;
}

function normalizedMimeType(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return undefined;
  const [mimeType] = value.split(";", 1);
  const normalized = mimeType?.trim().toLowerCase();
  return normalized === undefined || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized) ? undefined : normalized;
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case "audio/flac": return "flac";
    case "audio/mp4": return "m4a";
    case "audio/mpeg": return "mp3";
    case "audio/ogg": return "ogg";
    case "audio/wav": return "wav";
    case "audio/webm": return "webm";
    default: throw new TypeError("Voice audio MIME type is invalid");
  }
}

function classifyHttpStatus(status: number): OpenAiHttpVoiceFailureReason {
  if (status === 401 || status === 403) return "credential_rejected";
  if (status === 400 || status === 404 || status === 405 || status === 415 || status === 422) return "incompatible";
  return "unavailable";
}

async function readBoundedResponse(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximum)) {
    await response.body?.cancel().catch(() => undefined);
    throw new IncompatibleResponse();
  }
  if (response.body === null) throw new IncompatibleResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("Voice request stopped");
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw new IncompatibleResponse();
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseJsonRecord(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new IncompatibleResponse();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof IncompatibleResponse) throw error;
    throw new IncompatibleResponse();
  }
}

function boundedTranscript(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const transcript = value.trim();
  return transcript.length > 0 && transcript.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(transcript)
    ? transcript
    : undefined;
}
