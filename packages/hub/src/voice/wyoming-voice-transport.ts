import { createConnection, type Socket } from "node:net";

/**
 * Bounded TCP client for the Wyoming JSONL + binary voice protocol.
 *
 * The adapter accepts one trusted `wyoming://host:port` endpoint and returns
 * a closed result vocabulary. It deliberately keeps endpoint, payload and
 * upstream error details inside this transport boundary.
 */
export const WYOMING_VOICE_TRANSPORT_VERSION = 1;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_LIMITS: WyomingVoiceTransportLimits = {
  maxHeaderBytes: 16_384,
  maxEventDataBytes: 65_536,
  maxFramePayloadBytes: 1_048_576,
  maxAudioBytes: 8_388_608,
  maxTextChars: 8_192,
  maxEvents: 128,
};
const EVENT_TYPE = /^[a-z][a-z0-9-]{0,127}$/u;
const TIMEOUT_REASON = Symbol("wyoming-timeout");

export interface WyomingAudioFormat {
  readonly rate: number;
  readonly width: number;
  readonly channels: number;
}

export interface WyomingVoiceTransportLimits {
  readonly maxHeaderBytes: number;
  readonly maxEventDataBytes: number;
  readonly maxFramePayloadBytes: number;
  readonly maxAudioBytes: number;
  readonly maxTextChars: number;
  readonly maxEvents: number;
}

export type WyomingVoiceTransportFailure = {
  readonly status: "unavailable" | "timed_out" | "cancelled" | "incompatible" | "limit_exceeded";
};

export type WyomingVoiceDescribeResult =
  | { readonly status: "ready"; readonly services: { readonly asr: boolean; readonly tts: boolean } }
  | WyomingVoiceTransportFailure;

export type WyomingVoiceTranscribeResult =
  | { readonly status: "transcript"; readonly text: string; readonly language?: string }
  | WyomingVoiceTransportFailure;

export type WyomingVoiceSynthesizeResult =
  | { readonly status: "audio"; readonly format: WyomingAudioFormat; readonly audio: Uint8Array }
  | WyomingVoiceTransportFailure;

export interface WyomingVoiceTransportOptions {
  /** A trusted provider setting in the form `wyoming://host:port`. */
  readonly endpoint: string;
  readonly timeoutMs?: number;
  readonly limits?: Partial<WyomingVoiceTransportLimits>;
}

export interface WyomingVoiceDescribeInput {
  readonly signal?: AbortSignal;
}

export interface WyomingVoiceTranscribeInput {
  readonly audio: Uint8Array;
  readonly format: WyomingAudioFormat;
  readonly language?: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface WyomingVoiceSynthesizeInput {
  readonly text: string;
  readonly voice?: { readonly name?: string; readonly language?: string; readonly speaker?: string };
  readonly signal?: AbortSignal;
}

interface WyomingFrame {
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly payload: Uint8Array;
}

class WyomingTransportFault extends Error {
  constructor(readonly status: WyomingVoiceTransportFailure["status"]) {
    super("Wyoming voice transport operation did not complete");
  }
}

/** Encodes one protocol frame for a trusted Wyoming peer. */
export function encodeWyomingFrame(input: {
  readonly type: string;
  readonly data?: Record<string, unknown>;
  readonly payload?: Uint8Array;
}): Uint8Array {
  if (!EVENT_TYPE.test(input.type) || !isPlainObject(input.data ?? {})) throw new TypeError("Wyoming event is invalid");
  const payload = input.payload ?? new Uint8Array();
  if (!(payload instanceof Uint8Array)) throw new TypeError("Wyoming payload is invalid");
  const header = {
    type: input.type,
    ...(input.data === undefined ? {} : { data: input.data }),
    ...(payload.byteLength === 0 ? {} : { payload_length: payload.byteLength }),
  };
  const headerBytes = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  return payload.byteLength === 0 ? headerBytes : Buffer.concat([headerBytes, payload]);
}

export class WyomingVoiceTransport {
  private readonly endpoint: { readonly host: string; readonly port: number };
  private readonly timeoutMs: number;
  private readonly limits: WyomingVoiceTransportLimits;

  constructor(options: WyomingVoiceTransportOptions) {
    this.endpoint = parseEndpoint(options.endpoint);
    this.timeoutMs = boundedPositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000, "Wyoming timeout is invalid");
    this.limits = normalizeLimits(options.limits);
  }

  async describe(input: WyomingVoiceDescribeInput = {}): Promise<WyomingVoiceDescribeResult> {
    return this.run(input.signal, async (session) => {
      await session.send({ type: "describe" });
      const frame = await session.next();
      if (frame.type !== "info") throw incompatible();
      return {
        status: "ready",
        services: { asr: Array.isArray(frame.data.asr), tts: Array.isArray(frame.data.tts) },
      };
    });
  }

  async transcribe(input: WyomingVoiceTranscribeInput): Promise<WyomingVoiceTranscribeResult> {
    return this.run(input.signal, async (session) => {
      const audio = normalizeAudio(input.audio, this.limits);
      const format = normalizeAudioFormat(input.format);
      const language = optionalText(input.language, 64);
      const model = optionalText(input.model, 128);
      await session.send({ type: "transcribe", data: { ...(model === undefined ? {} : { name: model }), ...(language === undefined ? {} : { language }) } });
      await session.send({ type: "audio-start", data: formatData(format) });
      for (let offset = 0; offset < audio.byteLength; offset += this.limits.maxFramePayloadBytes) {
        await session.send({
          type: "audio-chunk",
          data: formatData(format),
          payload: audio.subarray(offset, Math.min(audio.byteLength, offset + this.limits.maxFramePayloadBytes)),
        });
      }
      await session.send({ type: "audio-stop" });

      for (;;) {
        const frame = await session.next();
        if (frame.type === "transcript") {
          const text = requiredText(frame.data.text, this.limits.maxTextChars);
          const transcriptLanguage = optionalText(frame.data.language, 64);
          return { status: "transcript", text, ...(transcriptLanguage === undefined ? {} : { language: transcriptLanguage }) };
        }
      }
    });
  }

  async synthesize(input: WyomingVoiceSynthesizeInput): Promise<WyomingVoiceSynthesizeResult> {
    return this.run(input.signal, async (session) => {
      const text = requiredText(input.text, this.limits.maxTextChars);
      const voice = normalizeVoice(input.voice);
      await session.send({ type: "synthesize", data: { text, ...(voice === undefined ? {} : { voice }) } });

      let format: WyomingAudioFormat | undefined;
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const frame = await session.next();
        if (frame.type === "audio-start") {
          if (format !== undefined) throw incompatible();
          format = normalizeAudioFormat(frame.data);
          continue;
        }
        if (frame.type === "audio-chunk") {
          if (format === undefined || !sameFormat(format, normalizeAudioFormat(frame.data))) throw incompatible();
          total += frame.payload.byteLength;
          if (total > this.limits.maxAudioBytes) throw limitExceeded();
          chunks.push(frame.payload);
          continue;
        }
        if (frame.type === "audio-stop") {
          if (format === undefined) throw incompatible();
          await session.send({ type: "synthesize-stopped" });
          return { status: "audio", format, audio: joinChunks(chunks, total) };
        }
        throw incompatible();
      }
    });
  }

  private async run<T extends WyomingVoiceDescribeResult | WyomingVoiceTranscribeResult | WyomingVoiceSynthesizeResult>(
    signal: AbortSignal | undefined,
    operation: (session: WyomingSession) => Promise<T>,
  ): Promise<T> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(TIMEOUT_REASON), this.timeoutMs);
    const combined = combineSignals(signal, deadline.signal);
    let session: WyomingSession | undefined;
    try {
      session = await WyomingSession.open(this.endpoint, this.limits, combined, deadline.signal);
      return await operation(session);
    } catch (error) {
      return { status: faultStatus(error, combined, deadline.signal) } as T;
    } finally {
      clearTimeout(timer);
      session?.close();
    }
  }
}

class WyomingSession {
  private readonly queue: WyomingFrame[] = [];
  private waiting: (() => void) | undefined;
  private fault: WyomingTransportFault | undefined;
  private events = 0;

  private constructor(
    private readonly socket: Socket,
    private readonly limits: WyomingVoiceTransportLimits,
    private readonly signal: AbortSignal,
    private readonly deadline: AbortSignal,
  ) {
    const decoder = new WyomingFrameDecoder(limits);
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) this.push(frame);
      } catch (error) {
        this.fail(error instanceof WyomingTransportFault ? error : incompatible());
      }
    });
    socket.on("error", () => this.fail(unavailable()));
    socket.on("close", () => {
      if (this.queue.length === 0) this.fail(this.abortFault() ?? unavailable());
    });
    signal.addEventListener("abort", () => this.fail(this.abortFault() ?? cancelled()), { once: true });
  }

  static async open(
    endpoint: { readonly host: string; readonly port: number },
    limits: WyomingVoiceTransportLimits,
    signal: AbortSignal,
    deadline: AbortSignal,
  ): Promise<WyomingSession> {
    if (signal.aborted) throw abortFault(signal, deadline);
    return new Promise<WyomingSession>((resolve, reject) => {
      const socket = createConnection({ host: endpoint.host, port: endpoint.port });
      let settled = false;
      const settle = (value: WyomingSession | WyomingTransportFault): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (value instanceof WyomingTransportFault) {
          socket.destroy();
          reject(value);
        } else resolve(value);
      };
      const onAbort = (): void => settle(abortFault(signal, deadline));
      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", () => settle(new WyomingSession(socket, limits, signal, deadline)));
      socket.once("error", () => settle(unavailable()));
    });
  }

  async send(frame: { readonly type: string; readonly data?: Record<string, unknown>; readonly payload?: Uint8Array }): Promise<void> {
    this.throwIfFault();
    if (this.signal.aborted) throw this.abortFault() ?? cancelled();
    const encoded = encodeWyomingFrame(frame);
    await new Promise<void>((resolve, reject) => this.socket.write(encoded, (error) => {
      if (error === undefined || error === null) resolve();
      else reject(unavailable());
    }));
    this.throwIfFault();
  }

  async next(): Promise<WyomingFrame> {
    this.throwIfFault();
    const available = this.queue.shift();
    if (available !== undefined) return available;
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.signal.removeEventListener("abort", onAbort);
        reject(this.abortFault() ?? cancelled());
      };
      this.waiting = (): void => {
        this.signal.removeEventListener("abort", onAbort);
        resolve();
      };
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
    this.throwIfFault();
    const frame = this.queue.shift();
    if (frame === undefined) throw unavailable();
    return frame;
  }

  close(): void { this.socket.destroy(); }

  private push(frame: WyomingFrame): void {
    this.events += 1;
    if (this.events > this.limits.maxEvents) {
      this.fail(limitExceeded());
      return;
    }
    this.queue.push(frame);
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
  }

  private fail(fault: WyomingTransportFault): void {
    if (this.fault !== undefined) return;
    this.fault = fault;
    this.socket.destroy();
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
  }

  private throwIfFault(): void {
    if (this.fault !== undefined) throw this.fault;
  }

  private abortFault(): WyomingTransportFault | undefined {
    return this.signal.aborted ? abortFault(this.signal, this.deadline) : undefined;
  }
}

class WyomingFrameDecoder {
  private buffered = Buffer.alloc(0);

  constructor(private readonly limits: WyomingVoiceTransportLimits) {}

  push(chunk: Uint8Array): readonly WyomingFrame[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const frames: WyomingFrame[] = [];
    for (;;) {
      const newline = this.buffered.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffered.byteLength > this.limits.maxHeaderBytes) throw limitExceeded();
        return frames;
      }
      if (newline > this.limits.maxHeaderBytes) throw limitExceeded();
      let header: unknown;
      try {
        header = JSON.parse(this.buffered.subarray(0, newline).toString("utf8"));
      } catch {
        throw incompatible();
      }
      if (!isPlainObject(header)) throw incompatible();
      const type = stringField(header.type);
      if (!EVENT_TYPE.test(type)) throw incompatible();
      const dataLength = boundedLength(header.data_length, this.limits.maxEventDataBytes);
      const payloadLength = boundedLength(header.payload_length, this.limits.maxFramePayloadBytes);
      const total = newline + 1 + dataLength + payloadLength;
      if (this.buffered.byteLength < total) return frames;
      const headerData = header.data === undefined ? {} : objectField(header.data);
      const rawData = this.buffered.subarray(newline + 1, newline + 1 + dataLength);
      const extraData = dataLength === 0 ? {} : parseAdditionalData(rawData);
      const payload = this.buffered.subarray(newline + 1 + dataLength, total);
      this.buffered = this.buffered.subarray(total);
      frames.push({ type, data: { ...headerData, ...extraData }, payload });
    }
  }
}

function parseEndpoint(value: string): { readonly host: string; readonly port: number } {
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "wyoming:" || endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== ""
      || (endpoint.pathname !== "" && endpoint.pathname !== "/") || endpoint.hostname === "" || endpoint.port === "") throw new Error();
    const port = Number(endpoint.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error();
    return { host: endpoint.hostname, port };
  } catch {
    throw new TypeError("Wyoming endpoint is invalid");
  }
}

function normalizeLimits(input: Partial<WyomingVoiceTransportLimits> | undefined): WyomingVoiceTransportLimits {
  const merged = { ...DEFAULT_LIMITS, ...input };
  return {
    maxHeaderBytes: boundedPositiveInteger(merged.maxHeaderBytes, 1_048_576, "Wyoming limits are invalid"),
    maxEventDataBytes: boundedPositiveInteger(merged.maxEventDataBytes, 8_388_608, "Wyoming limits are invalid"),
    maxFramePayloadBytes: boundedPositiveInteger(merged.maxFramePayloadBytes, 8_388_608, "Wyoming limits are invalid"),
    maxAudioBytes: boundedPositiveInteger(merged.maxAudioBytes, 64 * 1_048_576, "Wyoming limits are invalid"),
    maxTextChars: boundedPositiveInteger(merged.maxTextChars, 65_536, "Wyoming limits are invalid"),
    maxEvents: boundedPositiveInteger(merged.maxEvents, 4_096, "Wyoming limits are invalid"),
  };
}

function normalizeAudio(audio: unknown, limits: WyomingVoiceTransportLimits): Uint8Array {
  if (!(audio instanceof Uint8Array) || audio.byteLength === 0) throw incompatible();
  if (audio.byteLength > limits.maxAudioBytes) throw limitExceeded();
  return audio;
}

function normalizeAudioFormat(value: unknown): WyomingAudioFormat {
  if (!isPlainObject(value)) throw incompatible();
  const rate = numberField(value.rate);
  const width = numberField(value.width);
  const channels = numberField(value.channels);
  if (!Number.isSafeInteger(rate) || rate < 1 || rate > 384_000 || !Number.isSafeInteger(width) || width < 1 || width > 8
    || !Number.isSafeInteger(channels) || channels < 1 || channels > 8) throw incompatible();
  return { rate, width, channels };
}

function normalizeVoice(value: WyomingVoiceSynthesizeInput["voice"]): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw incompatible();
  const name = optionalText(value.name, 128);
  const language = optionalText(value.language, 64);
  const speaker = optionalText(value.speaker, 128);
  if (name === undefined && language === undefined && speaker === undefined) throw incompatible();
  return { ...(name === undefined ? {} : { name }), ...(language === undefined ? {} : { language }), ...(speaker === undefined ? {} : { speaker }) };
}

function requiredText(value: unknown, maxChars: number): string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw incompatible();
  if (value.length > maxChars) throw limitExceeded();
  return value;
}

function optionalText(value: unknown, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, maxChars);
}

function sameFormat(first: WyomingAudioFormat, second: WyomingAudioFormat): boolean {
  return first.rate === second.rate && first.width === second.width && first.channels === second.channels;
}

function formatData(format: WyomingAudioFormat): Record<string, number> {
  return { rate: format.rate, width: format.width, channels: format.channels };
}

function joinChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const audio = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return audio;
}

function boundedLength(value: unknown, maximum: number): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw incompatible();
  if (value > maximum) throw limitExceeded();
  return value;
}

function parseAdditionalData(raw: Uint8Array): Record<string, unknown> {
  try {
    return objectField(JSON.parse(Buffer.from(raw).toString("utf8")));
  } catch (error) {
    if (error instanceof WyomingTransportFault) throw error;
    throw incompatible();
  }
}

function objectField(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw incompatible();
  return value;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedPositiveInteger(value: unknown, maximum: number, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(message);
  return value;
}

function combineSignals(caller: AbortSignal | undefined, deadline: AbortSignal): AbortSignal {
  if (caller === undefined) return deadline;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([caller, deadline]);
  const controller = new AbortController();
  const abort = (signal: AbortSignal): void => controller.abort(signal.reason);
  if (caller.aborted) abort(caller);
  else caller.addEventListener("abort", () => abort(caller), { once: true });
  if (deadline.aborted) abort(deadline);
  else deadline.addEventListener("abort", () => abort(deadline), { once: true });
  return controller.signal;
}

function abortFault(signal: AbortSignal, deadline: AbortSignal): WyomingTransportFault {
  return deadline.aborted || signal.reason === TIMEOUT_REASON ? timedOut() : cancelled();
}

function faultStatus(error: unknown, signal: AbortSignal, deadline: AbortSignal): WyomingVoiceTransportFailure["status"] {
  if (error instanceof WyomingTransportFault) return error.status;
  if (signal.aborted) return abortFault(signal, deadline).status;
  return "unavailable";
}

function unavailable(): WyomingTransportFault { return new WyomingTransportFault("unavailable"); }
function timedOut(): WyomingTransportFault { return new WyomingTransportFault("timed_out"); }
function cancelled(): WyomingTransportFault { return new WyomingTransportFault("cancelled"); }
function incompatible(): WyomingTransportFault { return new WyomingTransportFault("incompatible"); }
function limitExceeded(): WyomingTransportFault { return new WyomingTransportFault("limit_exceeded"); }
