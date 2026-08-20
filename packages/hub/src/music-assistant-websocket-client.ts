import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

import WebSocket from "ws";

import type { MusicAssistantSearchClient } from "./music-assistant-media-provider.js";

export const MUSIC_ASSISTANT_CLIENT_SCHEMA_VERSION = 46;
export const MAX_MUSIC_ASSISTANT_MESSAGE_BYTES = 1_048_576;

const MIN_REVIEWED_SCHEMA_VERSION = 28;
const DEFAULT_TIMEOUT_MS = 7_500;
const MAX_UNRELATED_MESSAGES = 32;
const MAX_CONCURRENT_SEARCHES = 4;
const REVIEWED_MEDIA_TYPES = new Set([
  "album",
  "artist",
  "audiobook",
  "genre",
  "playlist",
  "podcast",
  "radio",
  "track",
]);

export interface MusicAssistantSocketLike {
  send(data: string): void;
  close(): void;
  onclose: (() => void) | undefined;
  onerror: ((error: Error) => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;
}

export type MusicAssistantSocketFactory = (url: string) => MusicAssistantSocketLike;

export interface MusicAssistantEndpointProbeResult {
  readonly status: "credential_required" | "setup_required" | "incompatible";
  readonly schemaVersion: number;
  readonly serverVersion?: string;
  readonly latencyMs: number;
}

export interface MusicAssistantEndpointProbeOptions {
  readonly baseUrl: string;
  readonly socketFactory?: MusicAssistantSocketFactory;
  readonly timeoutMs?: number;
  readonly clock?: () => number;
}

export interface MusicAssistantWebSocketSearchClientOptions {
  readonly baseUrl: string;
  readonly resolveToken: (signal: AbortSignal) => Promise<string | undefined>;
  readonly socketFactory?: MusicAssistantSocketFactory;
  readonly messageIdFactory?: () => string | undefined;
  readonly timeoutMs?: number;
}

interface ServerInfo {
  readonly schemaVersion: number;
  readonly minSupportedSchemaVersion: number;
  readonly serverVersion?: string;
  readonly onboardDone: boolean;
  readonly running: boolean;
}

/**
 * Converts a trusted product setting into the one reviewed MA WebSocket route.
 * Plain HTTP is limited to local/private endpoints; remote endpoints require TLS.
 */
export function toMusicAssistantWebSocketUrl(baseUrl: string): string {
  if (!boundedText(baseUrl, 2_048)) throw invalidUrl();
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw invalidUrl();
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw invalidUrl();
  }
  if (url.protocol === "http:") {
    if (!isLocalHostname(url.hostname)) throw invalidUrl();
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    throw invalidUrl();
  }
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith("/ws") ? path : `${path}/ws`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Reads only MA's bounded initial ServerInfo message and never resolves a token. */
export function probeMusicAssistantEndpoint(
  options: MusicAssistantEndpointProbeOptions,
): Promise<MusicAssistantEndpointProbeResult> {
  const socketFactory = options.socketFactory ?? createNodeSocket;
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const timeoutMs = validTimeout(options.timeoutMs);

  let socket: MusicAssistantSocketLike;
  try {
    socket = socketFactory(toMusicAssistantWebSocketUrl(options.baseUrl));
  } catch {
    return Promise.reject(new Error("Music Assistant preflight failed"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result?: MusicAssistantEndpointProbeResult, message?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (result !== undefined) resolve(Object.freeze(result));
      else reject(new Error(message ?? "Music Assistant preflight failed"));
    };
    const timer = setTimeout(() => finish(undefined, "Music Assistant preflight timed out"), timeoutMs);
    socket.onerror = () => finish(undefined, "Music Assistant preflight failed");
    socket.onclose = () => finish(undefined, "Music Assistant preflight failed");
    socket.onmessage = (event) => {
      const value = parseBoundedMessage(event.data);
      const info = projectServerInfo(value);
      if (info === undefined) {
        finish(undefined, "Music Assistant preflight failed");
        return;
      }
      finish({
        status: endpointStatus(info),
        schemaVersion: info.schemaVersion,
        ...(info.serverVersion === undefined ? {} : { serverVersion: info.serverVersion }),
        latencyMs: Math.max(0, clock() - startedAt),
      });
    };
  });
}

/**
 * Hub-private, fixed-command MA transport. Each search uses one short-lived
 * authenticated socket; no generic command, player, queue, or native URI API is exposed.
 */
export class MusicAssistantWebSocketSearchClient implements MusicAssistantSearchClient {
  private readonly webSocketUrl: string;
  private readonly resolveToken: MusicAssistantWebSocketSearchClientOptions["resolveToken"];
  private readonly socketFactory: MusicAssistantSocketFactory;
  private readonly messageIdFactory: () => string | undefined;
  private readonly timeoutMs: number;
  private readonly active = new Set<AbortController>();
  private disposed = false;

  constructor(options: MusicAssistantWebSocketSearchClientOptions) {
    this.webSocketUrl = toMusicAssistantWebSocketUrl(options.baseUrl);
    if (typeof options.resolveToken !== "function") throw new TypeError("Music Assistant credential resolver is invalid");
    if (options.socketFactory !== undefined && typeof options.socketFactory !== "function") {
      throw new TypeError("Music Assistant socket factory is invalid");
    }
    if (options.messageIdFactory !== undefined && typeof options.messageIdFactory !== "function") {
      throw new TypeError("Music Assistant message ID factory is invalid");
    }
    this.resolveToken = options.resolveToken;
    this.socketFactory = options.socketFactory ?? createNodeSocket;
    this.messageIdFactory = options.messageIdFactory ?? randomUUID;
    this.timeoutMs = validTimeout(options.timeoutMs);
  }

  search(input: {
    readonly query: string;
    readonly mediaTypes: readonly string[];
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<unknown> {
    if (this.disposed) return Promise.reject(searchFailure());
    validateSearchInput(input);
    if (input.signal.aborted || this.active.size >= MAX_CONCURRENT_SEARCHES) {
      return Promise.reject(searchFailure());
    }
    const operation = new AbortController();
    this.active.add(operation);
    const signal = combineSignals(input.signal, operation.signal);
    return this.runSearch(input, signal).finally(() => this.active.delete(operation));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const operation of this.active) operation.abort();
    this.active.clear();
  }

  private runSearch(
    input: { readonly query: string; readonly mediaTypes: readonly string[]; readonly limit: number },
    signal: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let socket: MusicAssistantSocketLike;
      try {
        socket = this.socketFactory(this.webSocketUrl);
      } catch {
        reject(searchFailure());
        return;
      }
      let settled = false;
      let state: "server_info" | "auth" | "search" = "server_info";
      let authMessageId: string | undefined;
      let searchMessageId: string | undefined;
      let unrelatedMessages = 0;

      const finish = (result?: unknown, succeeded = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        socket.close();
        if (succeeded) resolve(result);
        else reject(searchFailure());
      };
      const abort = () => finish();
      const timer = setTimeout(() => finish(), this.timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        finish();
        return;
      }
      socket.onerror = () => finish();
      socket.onclose = () => finish();
      socket.onmessage = (event) => {
        void (async () => {
          if (settled) return;
          const value = parseBoundedMessage(event.data);
          if (!isRecord(value)) {
            finish();
            return;
          }
          if (state === "server_info") {
            const info = projectServerInfo(value);
            if (info === undefined || endpointStatus(info) !== "credential_required") {
              finish();
              return;
            }
            state = "auth";
            let token: string | undefined;
            try {
              token = await this.resolveToken(signal);
            } catch {
              finish();
              return;
            }
            if (settled || signal.aborted || !validToken(token)) {
              finish();
              return;
            }
            authMessageId = this.nextMessageId();
            socket.send(JSON.stringify({ message_id: authMessageId, command: "auth", args: { token } }));
            return;
          }
          const messageId = boundedText(value.message_id, 128) ? value.message_id : undefined;
          if (state === "auth" && messageId === authMessageId) {
            if (!isRecord(value.result)
              || value.result.authenticated !== true
              || value.error_code !== undefined) {
              finish();
              return;
            }
            state = "search";
            searchMessageId = this.nextMessageId();
            socket.send(JSON.stringify({
              message_id: searchMessageId,
              command: "music/search",
              args: {
                search_query: input.query,
                media_types: [...input.mediaTypes],
                limit: input.limit,
                library_only: false,
              },
            }));
            return;
          }
          if (state === "search" && messageId === searchMessageId) {
            if (value.error_code !== undefined || !("result" in value)) {
              finish();
              return;
            }
            if (value.partial === true) return;
            finish(value.result, true);
            return;
          }
          unrelatedMessages += 1;
          if (unrelatedMessages > MAX_UNRELATED_MESSAGES) finish();
        })().catch(() => finish());
      };
    });
  }

  private nextMessageId(): string {
    const messageId = this.messageIdFactory();
    if (!boundedText(messageId, 128) || messageId.length < 8) throw searchFailure();
    return messageId;
  }
}

function validateSearchInput(input: {
  readonly query: string;
  readonly mediaTypes: readonly string[];
  readonly limit: number;
  readonly signal: AbortSignal;
}): void {
  if (!input || !boundedText(input.query, 1_000)) throw new TypeError("Music Assistant search input is invalid");
  if (!Array.isArray(input.mediaTypes)
    || input.mediaTypes.length < 1
    || input.mediaTypes.length > REVIEWED_MEDIA_TYPES.size
    || input.mediaTypes.some((type) => !REVIEWED_MEDIA_TYPES.has(type))) {
    throw new TypeError("Music Assistant search media types are invalid");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20) {
    throw new TypeError("Music Assistant search limit is invalid");
  }
  if (!(input.signal instanceof AbortSignal)) throw new TypeError("Music Assistant search signal is invalid");
}

function projectServerInfo(value: unknown): ServerInfo | undefined {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.schema_version)
    || (value.schema_version as number) < 1
    || !Number.isSafeInteger(value.min_supported_schema_version)
    || (value.min_supported_schema_version as number) < 1
    || typeof value.onboard_done !== "boolean") return undefined;
  return {
    schemaVersion: value.schema_version as number,
    minSupportedSchemaVersion: value.min_supported_schema_version as number,
    serverVersion: boundedText(value.server_version, 64) ? value.server_version : undefined,
    onboardDone: value.onboard_done,
    running: value.status === undefined || value.status === "running",
  };
}

function endpointStatus(info: ServerInfo): MusicAssistantEndpointProbeResult["status"] {
  if (!info.onboardDone) return "setup_required";
  if (!info.running
    || info.schemaVersion < MIN_REVIEWED_SCHEMA_VERSION
    || info.minSupportedSchemaVersion > MUSIC_ASSISTANT_CLIENT_SCHEMA_VERSION) return "incompatible";
  return "credential_required";
}

function parseBoundedMessage(data: string): unknown {
  if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > MAX_MUSIC_ASSISTANT_MESSAGE_BYTES) return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

function validToken(value: unknown): value is string {
  return boundedText(value, 4_096) && value.length >= 8;
}

function validTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) {
    throw new TypeError("Music Assistant timeout is invalid");
  }
  return timeout;
}

function combineSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any([first, second]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  first.addEventListener("abort", abort, { once: true });
  second.addEventListener("abort", abort, { once: true });
  if (first.aborted || second.aborted) controller.abort();
  return controller.signal;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) return true;
  const addressKind = isIP(normalized);
  if (addressKind === 4) {
    const octets = normalized.split(".").map(Number);
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  if (addressKind === 6) {
    return normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb");
  }
  return false;
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidUrl(): Error {
  return new Error("Music Assistant URL is invalid");
}

function searchFailure(): Error {
  return new Error("Music Assistant search failed");
}

function createNodeSocket(url: string): MusicAssistantSocketLike {
  const socket = new WebSocket(url);
  const wrapped: MusicAssistantSocketLike = {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
  };
  socket.on("close", () => wrapped.onclose?.());
  socket.on("error", (error) => wrapped.onerror?.(error));
  socket.on("message", (data) => wrapped.onmessage?.({ data: data.toString() }));
  return wrapped;
}
