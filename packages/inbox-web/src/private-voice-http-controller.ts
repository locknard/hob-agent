import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { InboxReviewActor } from "./proposal-inbox-service.js";
import type {
  ProductPrivateVoice,
  ProductPrivateVoiceHealth,
  ProductPrivateVoiceHealthTrack,
  ProductTurn,
} from "./product-shell.js";

export type PrivateVoiceCaptureMode = "encoded_audio" | "pcm_s16le";

export interface PrivateVoiceAudioFormat {
  readonly rate: number;
  readonly width: number;
  readonly channels: number;
}

export type PrivateVoiceProductPortStatus =
  | "active"
  | "degraded"
  | "disabled"
  | "retrying"
  | "switching";

export type PrivateVoiceFailureReason =
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

/** Frozen provider-generation capability; HTTP keeps it server-side behind an opaque browser turn id. */
export interface PrivateVoiceTurnLease {
  readonly captureMode: PrivateVoiceCaptureMode;
  transcribe(input: {
    readonly audio: Uint8Array;
    readonly mimeType: string;
    readonly format?: PrivateVoiceAudioFormat;
    readonly signal?: AbortSignal;
  }): Promise<
    | {
        readonly status: "transcribed";
        readonly text: string;
        readonly locale?: string;
      }
    | { readonly status: "failed"; readonly reason: PrivateVoiceFailureReason }
  >;
  synthesize(input: {
    readonly text: string;
    readonly signal?: AbortSignal;
  }): Promise<
    | {
        readonly status: "synthesized";
        readonly mimeType: string;
        readonly audio: Uint8Array;
        readonly format?: PrivateVoiceAudioFormat;
      }
    | { readonly status: "failed"; readonly reason: PrivateVoiceFailureReason }
  >;
  release(): Promise<void>;
}

/**
 * Product-facing voice seam. It accepts one bounded audio turn and returns
 * provider-detail-free results; HTTP owns browser input validation and output.
 */
export interface PrivateVoiceProductPort {
  readonly status: PrivateVoiceProductPortStatus;
  /** Issues an exact provider-generation lease while the local bridge is active. */
  beginTurn(): PrivateVoiceTurnLease | undefined;
  /** Reconnects a degraded local provider. The provider owns concurrent retry reuse. */
  retry?(): unknown | Promise<unknown>;
  cancelRetry?(): void;
}

export type OperationalPrivateVoiceStatus =
  | "disabled"
  | "active"
  | "degraded"
  | "retrying"
  | "switching";
type OperationalPrivateVoiceTransport = "wyoming" | "openai_http";

type OperationalPrivateVoiceProjection =
  | {
      readonly status: "disabled";
      readonly generation: number;
      readonly configured: false;
    }
  | {
      readonly status: Exclude<OperationalPrivateVoiceStatus, "disabled">;
      readonly generation: number;
      readonly configured: true;
      readonly asr: {
        readonly transport: OperationalPrivateVoiceTransport;
        readonly endpoint: string;
        readonly model?: string;
        readonly credentialConfigured: boolean;
      };
      readonly tts: {
        readonly transport: OperationalPrivateVoiceTransport;
        readonly endpoint: string;
        readonly model?: string;
        readonly locale: string;
        readonly voice?: string;
        readonly credentialConfigured: boolean;
      };
    };

export type OperationalPrivateVoiceConfigureResult =
  | { readonly status: "configured"; readonly generation: number }
  | { readonly status: "cancelled" }
  | {
      readonly status: "probe_failed";
      readonly track: "asr" | "tts";
      readonly reason:
        | "missing_endpoint"
        | "missing_locale"
        | "credential_rejected"
        | "endpoint_unreachable"
        | "timed_out"
        | "incompatible"
        | "unavailable";
    }
  | { readonly status: "busy" | "conflict" | "unavailable" };

export type OperationalPrivateVoiceDisableResult =
  | { readonly status: "disabled"; readonly generation: number }
  | { readonly status: "busy" | "conflict" | "unavailable" };

export type OperationalPrivateVoiceConfigureInput = {
  readonly expectedGeneration: number;
  readonly signal?: AbortSignal;
  readonly asr: {
    readonly kind: "asr";
    readonly transport: OperationalPrivateVoiceTransport;
    readonly endpoint: string;
    readonly model?: string;
    readonly credential?: string;
  };
  readonly tts: {
    readonly kind: "tts";
    readonly transport: OperationalPrivateVoiceTransport;
    readonly endpoint: string;
    readonly model?: string;
    readonly locale: string;
    readonly voice?: string;
    readonly credential?: string;
  };
};

/** Product settings boundary: it accepts request-local credentials but never projects them back to HTTP. */
export interface OperationalPrivateVoiceSettingsPort {
  projection(): Promise<OperationalPrivateVoiceProjection>;
  configure(
    input: OperationalPrivateVoiceConfigureInput,
  ): Promise<OperationalPrivateVoiceConfigureResult>;
  disable(input: {
    readonly expectedGeneration: number;
  }): Promise<OperationalPrivateVoiceDisableResult>;
  retry(): Promise<OperationalPrivateVoiceStatus>;
  cancelRetry(): void;
}

export type AdviceAvailabilityStatus =
  | "ready"
  | "active_request"
  | "setup_required"
  | "home_connecting"
  | "agent_busy"
  | "model_unavailable"
  | "stopped"
  | "unavailable";

export interface AdviceAvailability {
  readonly status: AdviceAvailabilityStatus;
  readonly activeAdviceId?: string;
}

export interface AdviceStartResult {
  readonly id?: string;
  readonly status?: "accepted" | "active_request" | "already_active";
  readonly activeAdviceId?: string;
}

const MAX_FORM_BYTES = 4 * 1024;
const MAX_PRIVATE_VOICE_AUDIO_BYTES = 5 * 1024 * 1024;
const PRIVATE_VOICE_READ_DEADLINE_MS = 30_000;
const PRIVATE_VOICE_CAPTURE_OR_TRANSCRIBE_LEASE_MS = 60_000;
const PRIVATE_VOICE_POST_BIND_LEASE_MS = 5 * 60_000;
const PRIVATE_VOICE_POST_COMPLETION_TTS_LEASE_MS = 30_000;
const MAX_PRIVATE_VOICE_TURNS = 8;
const MAX_PRIVATE_VOICE_TRANSCRIPT_CHARS = 1_000;
const MAX_PRIVATE_VOICE_SPEECH_CHARS = 4_096;
const PRIVATE_VOICE_TRANSCRIPTION_WINDOW_MS = 30_000;
const MAX_PRIVATE_VOICE_TRANSCRIPTIONS_PER_WINDOW = 6;
const PRIVATE_VOICE_SPEECH_WINDOW_MS = 30_000;
const MAX_PRIVATE_VOICE_SYNTHESIS_PER_WINDOW = 6;
const PRIVATE_VOICE_SPEECH_CACHE_MS = 30_000;
const MAX_PRIVATE_VOICE_SPEECH_CACHE_ENTRIES = 8;
const MAX_PRIVATE_VOICE_HEALTH_SAMPLES = 20;
const MAX_PRIVATE_VOICE_HEALTH_LATENCY_MS = 24 * 60 * 60 * 1_000;
const SETTINGS_RECEIPT_TTL_MS = 300_000;
const MAX_SETTINGS_COMPLETIONS = 32;
const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

type PrivateVoiceConfigurationAction =
  | "configure"
  | "disable"
  | "retry"
  | "cancel-retry"
  | "cancel-configure";
type BrowserVoiceAudio = {
  readonly mimeType: string;
  readonly audio: Uint8Array;
};
type VoiceSpeechResult = BrowserVoiceAudio | "unavailable" | undefined;
type VoiceSpeechInFlight = {
  readonly turnId: string;
  readonly promise: Promise<VoiceSpeechResult>;
  readonly controller: AbortController;
  activeWaiters: number;
};
type PrivateVoiceConfigurationTask = {
  readonly id: string;
  readonly startedAt: number;
  readonly controller: AbortController;
};
type PrivateVoiceConfigurationCompletion = {
  readonly id: string;
  readonly receipt: string;
  readonly at: number;
};
type PrivateVoiceStatusTask = {
  readonly kind: "configuration" | "recovery";
  readonly id: string;
};
type PrivateVoiceRecoveryTask = {
  readonly id: string;
  readonly startedAt: number;
  readonly controller: AbortController;
  readonly owner: "settings" | "voice";
  cancelRequested: boolean;
};
type PrivateVoiceRecoveryCompletion = {
  readonly id: string;
  readonly receipt: string;
  readonly at: number;
};
type PrivateVoiceHttpTurn = {
  readonly token: string;
  readonly sessionKey: string;
  readonly lease: PrivateVoiceTurnLease;
  phase: "capturing" | "transcribing" | "awaiting_advice" | "completed";
  uploadUsed: boolean;
  adviceId: string | undefined;
  expiresAt: number;
};
type PrivateVoiceHealthSample = {
  readonly success: boolean;
  readonly latencyMs: number;
  readonly measuredAt: number;
};

/** The private-voice HTTP boundary owns request parsing, ephemeral browser capability state, and provider calls. */
export interface PrivateVoiceHttpControllerOptions {
  readonly privateVoice?: PrivateVoiceProductPort;
  readonly voiceSettings?: OperationalPrivateVoiceSettingsPort;
  readonly principal?: InboxReviewActor;
  readonly origin?: () => string;
  readonly privateVoiceReadDeadlineMs?: number;
  readonly privateVoiceTurnToken?: () => string;
  readonly clock?: () => number;
  readonly adviceAvailability: () => Promise<AdviceAvailability>;
  readonly startAdvice: (question: string) => Promise<AdviceStartResult>;
  readonly productAdviceTurn: (id: string) => Promise<ProductTurn | undefined>;
}

export class PrivateVoiceHttpController {
  private readonly turns = new Map<string, PrivateVoiceHttpTurn>();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private transcriptionInFlight = false;
  private readonly transcriptionAttempts: number[] = [];
  private speechInFlight: VoiceSpeechInFlight | undefined;
  private readonly speechAttempts: number[] = [];
  private readonly speechCache = new Map<
    string,
    {
      readonly answer: string;
      readonly at: number;
      readonly audio: BrowserVoiceAudio;
    }
  >();
  private readonly settingsReceipts = new Map<
    string,
    { readonly at: number; readonly notice: string }
  >();
  private configurationTask: PrivateVoiceConfigurationTask | undefined;
  private readonly configurationCompletions = new Map<
    string,
    PrivateVoiceConfigurationCompletion
  >();
  private recoveryTask: PrivateVoiceRecoveryTask | undefined;
  private readonly recoveryCompletions = new Map<
    string,
    PrivateVoiceRecoveryCompletion
  >();
  private readonly backgroundWork = new Set<Promise<void>>();
  private readonly activeSettingsActions = new Set<Promise<void>>();
  private disposed = false;
  private readonly readDeadlineMs: number;
  private readonly turnToken: () => string;
  private readonly clock: () => number;
  private readonly asrHealth: PrivateVoiceHealthSample[] = [];
  private readonly ttsHealth: PrivateVoiceHealthSample[] = [];

  constructor(private readonly options: PrivateVoiceHttpControllerOptions) {
    this.readDeadlineMs = boundedReadDeadline(
      options.privateVoiceReadDeadlineMs,
    );
    if (
      options.privateVoiceTurnToken !== undefined &&
      typeof options.privateVoiceTurnToken !== "function"
    ) {
      throw new TypeError("Private voice turn token source is invalid");
    }
    this.turnToken = options.privateVoiceTurnToken ?? privateVoiceTurnToken;
    if (options.clock !== undefined && typeof options.clock !== "function") {
      throw new TypeError("Private voice clock source is invalid");
    }
    this.clock = options.clock ?? Date.now;
  }

  static settingsAction(
    value: string | undefined,
  ): PrivateVoiceConfigurationAction | undefined {
    return value === "configure" ||
      value === "disable" ||
      value === "retry" ||
      value === "cancel-retry" ||
      value === "cancel-configure"
      ? value
      : undefined;
  }

  renderState():
    | { readonly status: "active" }
    | { readonly status: "recovering" | "retryable" | "unavailable" } {
    if (this.recoveryTask !== undefined) return { status: "recovering" };
    if (this.activeVoice() !== undefined) return { status: "active" };
    return this.options.privateVoice?.status === "degraded" &&
      typeof this.options.privateVoice.retry === "function"
      ? { status: "retryable" }
      : { status: "unavailable" };
  }

  consumeSettingsReceipt(token: string | null): string | undefined {
    if (token === null || !/^[a-f0-9]{32}$/.test(token)) return undefined;
    const receipt = this.settingsReceipts.get(token);
    if (receipt === undefined) return undefined;
    this.settingsReceipts.delete(token);
    return Date.now() - receipt.at <= SETTINGS_RECEIPT_TTL_MS
      ? receipt.notice
      : undefined;
  }

  async settingsContext(
    notice: string | undefined,
  ): Promise<ProductShellModelPrivateVoice | undefined> {
    const settings = this.options.voiceSettings;
    if (settings === undefined) return undefined;
    try {
      const projection = normalizeProjection(await settings.projection());
      if (projection === undefined) return undefined;
      const health = projection.configured
        ? { health: this.healthProjection() }
        : {};
      const settledNotice =
        notice ?? this.consumeConfigurationCompletion() ?? this.consumeRecoveryCompletion();
      const task = this.configurationTask;
      const recovery = this.recoveryTask;
      return {
        ...projection,
        ...health,
        ...(settledNotice === undefined ? {} : { notice: settledNotice }),
        ...(task === undefined
          ? {}
          : {
              configurationPending: { id: task.id, startedAt: task.startedAt },
            }),
        ...(recovery === undefined
          ? {}
          : {
              recoveryPending: {
                id: recovery.id,
                startedAt: recovery.startedAt,
              },
            }),
      };
    } catch {
      return undefined;
    }
  }

  async handleSettingsAction(
    request: IncomingMessage,
    response: ServerResponse,
    action: PrivateVoiceConfigurationAction,
  ): Promise<void> {
    if (this.disposed) {
      request.resume();
      return send(response, 503, "私有语音设置已停止，请重新打开家庭控制台后继续。");
    }
    let release!: () => void;
    const active = new Promise<void>((resolve) => { release = resolve; });
    this.activeSettingsActions.add(active);
    try {
      return await this.performSettingsAction(request, response, action);
    } finally {
      release();
      this.activeSettingsActions.delete(active);
    }
  }

  private async performSettingsAction(
    request: IncomingMessage,
    response: ServerResponse,
    action: PrivateVoiceConfigurationAction,
  ): Promise<void> {
    const settings = this.options.voiceSettings;
    if (settings === undefined)
      return send(
        response,
        503,
        "私有语音设置暂时不可用，请继续使用文字对话。",
      );
    if (!canConfigure(this.options.principal))
      return send(response, 403, "私有语音设置需要通过已绑定的私人设备打开。");
    if (
      mediaType(request.headers["content-type"]) !==
      "application/x-www-form-urlencoded"
    )
      return send(response, 415, "请使用设置页面提交语音设置。");
    let body: string;
    try {
      body = await readBoundedBody(request);
    } catch (error) {
      return send(
        response,
        isPayloadTooLarge(error) ? 413 : 400,
        "私有语音设置未能读取。",
      );
    }
    if (this.disposed)
      return send(response, 503, "私有语音设置已停止，请重新打开家庭控制台后继续。");
    if (action === "cancel-configure") {
      const configurationId = cancelConfigureInput(body);
      if (configurationId === undefined)
        return send(response, 400, "私有语音设置请求无效。");
      const task = this.configurationTask;
      if (task === undefined || task.id !== configurationId)
        return this.redirectSettingsReceipt(
          response,
          "这次检查已经结束，请查看当前设置。",
        );
      task.controller.abort();
      return redirect(response, "/settings#private-voice");
    }
    if (
      this.configurationTask !== undefined ||
      (this.recoveryTask !== undefined && action !== "cancel-retry")
    )
      return this.redirectSettingsReceipt(
        response,
        "语音设置正在处理中，请稍候再查看。",
      );
    if (action === "configure") {
      const input = configureInput(body);
      if (input === undefined)
        return send(response, 400, "私有语音设置请求无效。");
      this.startConfiguration(settings, input);
      return redirect(response, "/settings#private-voice");
    }
    if (action === "disable") {
      const input = disableInput(body);
      if (input === undefined)
        return send(response, 400, "私有语音设置请求无效。");
      let result: OperationalPrivateVoiceDisableResult;
      try {
        result = await settings.disable(input);
      } catch {
        result = { status: "unavailable" };
      }
      return this.redirectSettingsReceipt(response, disableNotice(result));
    }
    const expectedGeneration = retryInput(body);
    if (expectedGeneration === undefined)
      return send(response, 400, "私有语音设置请求无效。");
    const generation = await this.generation(settings);
    if (generation === undefined)
      return this.redirectSettingsReceipt(
        response,
        "私有语音暂时不可用，请继续使用文字对话或检查设置。",
      );
    if (generation !== expectedGeneration)
      return this.redirectSettingsReceipt(
        response,
        "语音设置已经更新，请查看当前设置后再继续。",
      );
    if (action === "retry") {
      this.startSettingsRecovery(settings);
      return redirect(response, "/settings#private-voice");
    }
    if (!this.cancelRecovery())
      return this.redirectSettingsReceipt(
        response,
        "这次连接已经结束，请查看当前设置。",
      );
    return redirect(response, "/settings#private-voice");
  }

  sendConfigurationStatus(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (this.options.voiceSettings === undefined)
      return send(
        response,
        503,
        "私有语音设置暂时不可用，请继续使用文字对话。",
      );
    if (!canConfigure(this.options.principal))
      return send(response, 403, "私有语音设置需要通过已绑定的私人设备打开。");
    if (
      request.headers.origin !== undefined &&
      request.headers.origin !== this.options.origin?.()
    )
      return send(response, 403, "请从家庭控制台继续查看语音设置。");
    const requested = privateVoiceStatusTask(request);
    if (requested === undefined)
      return send(response, 400, "私有语音设置请求无效。");
    this.pruneSettingsCompletions();
    const task = this.configurationTask;
    if (requested.kind === "configuration" && task?.id === requested.id)
      return sendConfigurationStatus(response, {
        status: "pending",
        configurationId: task.id,
      });
    const recovery = this.recoveryTask;
    if (requested.kind === "recovery" && recovery?.id === requested.id)
      return sendConfigurationStatus(response, {
        status: "pending",
        recoveryId: recovery.id,
      });
    const completion = (requested.kind === "configuration"
      ? this.configurationCompletions
      : this.recoveryCompletions).get(requested.id);
    if (completion !== undefined) {
      return sendConfigurationStatus(response, {
        status: "completed",
        ...(requested.kind === "configuration"
          ? { configurationId: completion.id }
          : { recoveryId: completion.id }),
        receipt: completion.receipt,
      });
    }
    return sendConfigurationStatus(response, requested.kind === "configuration"
      ? { status: "idle", configurationId: requested.id }
      : { status: "idle", recoveryId: requested.id });
  }

  async handleVoiceTurnStart(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (
      mediaType(request.headers["content-type"]) !==
      "application/x-www-form-urlencoded"
    )
      return send(
        response,
        415,
        "Unsupported private voice request content type",
      );
    let body: string;
    try {
      body = await readBoundedBody(request);
    } catch (error) {
      return send(
        response,
        isPayloadTooLarge(error) ? 413 : 400,
        "Invalid private voice request",
      );
    }
    if (body.length !== 0)
      return send(response, 400, "Invalid private voice request");
    this.expireTurns();
    if (this.turns.size >= MAX_PRIVATE_VOICE_TURNS)
      return sendVoiceBackoff(response, 1);
    const lease = this.activeVoice()?.beginTurn();
    if (
      lease === undefined ||
      (lease.captureMode !== "encoded_audio" &&
        lease.captureMode !== "pcm_s16le")
    )
      return sendVoiceJson(response, 503, { status: "unavailable" });
    const token = this.turnToken();
    if (!isTurnToken(token) || this.turns.has(token)) {
      await lease.release().catch(() => undefined);
      return sendVoiceJson(response, 503, { status: "unavailable" });
    }
    this.turns.set(token, {
      token,
      sessionKey: this.sessionKey(request),
      lease,
      phase: "capturing",
      uploadUsed: false,
      adviceId: undefined,
      expiresAt: Date.now() + PRIVATE_VOICE_CAPTURE_OR_TRANSCRIBE_LEASE_MS,
    });
    this.scheduleExpiry();
    return sendVoiceJson(response, 201, {
      status: "leased",
      voiceTurnId: token,
      captureMode: lease.captureMode,
    });
  }

  async handleVoiceTranscription(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
  ): Promise<void> {
    const turn = this.turn(request, token);
    if (turn === undefined) {
      request.resume();
      return send(response, 404, "Private voice turn not found");
    }
    if (turn.phase !== "capturing" || turn.uploadUsed) {
      request.resume();
      return send(
        response,
        409,
        "Private voice turn is no longer accepting audio",
      );
    }
    turn.uploadUsed = true;
    turn.phase = "transcribing";
    const mimeType = mediaType(request.headers["content-type"]);
    const format = inputFormat(
      turn.lease.captureMode,
      mimeType,
      request.headers,
    );
    if (mimeType === undefined || format === undefined) {
      void this.releaseTurn(turn.token);
      return send(
        response,
        mimeType === undefined || !isVoiceMimeType(mimeType) ? 415 : 400,
        "Invalid private voice audio",
      );
    }
    const initial = await this.options.adviceAvailability();
    if (
      initial.status === "active_request" &&
      initial.activeAdviceId !== undefined
    ) {
      request.resume();
      void this.releaseTurn(turn.token);
      return sendVoiceJson(response, 409, {
        status: "active",
        adviceId: initial.activeAdviceId,
      });
    }
    if (initial.status !== "ready") {
      request.resume();
      void this.releaseTurn(turn.token);
      return sendVoiceJson(response, 503, { status: voiceAdviceUnavailableStatus(initial.status) });
    }
    const retryAfter = this.reserveTranscription();
    if (retryAfter !== undefined) {
      request.resume();
      void this.releaseTurn(turn.token);
      return sendVoiceBackoff(response, retryAfter);
    }
    try {
      let audio: Uint8Array;
      try {
        audio = await readBoundedBytes(
          request,
          MAX_PRIVATE_VOICE_AUDIO_BYTES,
          this.readDeadlineMs,
        );
      } catch (error) {
        if (isReadTimedOut(error)) {
          request.resume();
          return sendVoiceBackoff(response, 1);
        }
        return send(
          response,
          isPayloadTooLarge(error) ? 413 : 400,
          "Invalid private voice audio",
        );
      }
      if (audio.byteLength === 0)
        return sendVoiceJson(response, 422, { status: "no_input" });
      if (
        format !== NO_FORMAT &&
        audio.byteLength % (format.width * format.channels) !== 0
      )
        return send(response, 400, "Invalid private voice audio");
      if (!this.isLiveTranscribingTurn(turn))
        return sendVoiceJson(response, 409, { status: "unavailable" });
      const cancellation = abortOnDisconnect(request, response);
      const healthStartedAt = this.healthNow();
      let transcription: Awaited<
        ReturnType<PrivateVoiceTurnLease["transcribe"]>
      >;
      try {
        transcription = await turn.lease.transcribe({
          audio,
          mimeType,
          ...(format === NO_FORMAT ? {} : { format }),
          signal: cancellation.signal,
        });
      } catch {
        this.recordHealth("asr", false, healthStartedAt);
        return sendVoiceJson(response, 502, { status: "failed" });
      } finally {
        cancellation.cleanup();
      }
      this.recordHealth(
        "asr",
        transcription.status === "transcribed",
        healthStartedAt,
      );
      if (!this.isLiveTranscribingTurn(turn))
        return sendVoiceJson(response, 409, { status: "unavailable" });
      if (transcription.status !== "transcribed")
        return sendVoiceJson(
          response,
          unavailable(transcription.reason) ? 503 : 502,
          {
            status: unavailable(transcription.reason)
              ? "unavailable"
              : "failed",
          },
        );
      const transcript = boundedText(
        transcription.text,
        MAX_PRIVATE_VOICE_TRANSCRIPT_CHARS,
      );
      if (transcript === undefined || transcript.length === 0)
        return sendVoiceJson(response, 422, { status: "no_input" });
      const availability = await this.options.adviceAvailability();
      if (!this.isLiveTranscribingTurn(turn))
        return sendVoiceJson(response, 409, { status: "unavailable" });
      if (
        availability.status === "active_request" &&
        availability.activeAdviceId !== undefined
      )
        return sendVoiceJson(response, 409, {
          status: "active",
          adviceId: availability.activeAdviceId,
        });
      if (availability.status !== "ready")
        return sendVoiceJson(response, 503, { status: voiceAdviceUnavailableStatus(availability.status) });
      let advice: AdviceStartResult;
      try {
        advice = await this.options.startAdvice(transcript);
      } catch (error) {
        const activeId = activeAdviceId(error);
        if (
          (errorCode(error) === "active_request" ||
            errorCode(error) === "already_active") &&
          activeId !== undefined
        ) {
          return sendVoiceJson(response, 409, {
            status: "active",
            adviceId: activeId,
          });
        }
        return sendVoiceJson(response, 503, {
          status: errorCode(error) === "model_unavailable" ? "model_unavailable" : "unavailable",
        });
      }
      if (
        (advice.status === "active_request" ||
          advice.status === "already_active") &&
        advice.activeAdviceId !== undefined
      )
        return sendVoiceJson(response, 409, {
          status: "active",
          adviceId: advice.activeAdviceId,
        });
      if (advice.id === undefined || !safeAdviceId(advice.id))
        return sendVoiceJson(response, 502, { status: "failed" });
      turn.phase = "awaiting_advice";
      turn.adviceId = advice.id;
      turn.expiresAt = Date.now() + PRIVATE_VOICE_POST_BIND_LEASE_MS;
      this.scheduleExpiry();
      return sendVoiceJson(response, 202, {
        status: "accepted",
        adviceId: advice.id,
        transcript,
      });
    } finally {
      this.releaseTranscription();
      if (turn.adviceId === undefined) await this.releaseTurn(turn.token);
    }
  }

  async handleVoiceTurnRelease(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
  ): Promise<void> {
    if (
      mediaType(request.headers["content-type"]) !==
      "application/x-www-form-urlencoded"
    )
      return send(
        response,
        415,
        "Unsupported private voice release content type",
      );
    let body: string;
    try {
      body = await readBoundedBody(request);
    } catch (error) {
      return send(
        response,
        isPayloadTooLarge(error) ? 413 : 400,
        "Invalid private voice release",
      );
    }
    if (body.length !== 0)
      return send(response, 400, "Invalid private voice release");
    const turn = this.turn(request, token);
    if (turn !== undefined) await this.releaseTurn(turn.token);
    return send(response, 204, "");
  }

  async handleRetry(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (
      mediaType(request.headers["content-type"]) !==
      "application/x-www-form-urlencoded"
    )
      return send(
        response,
        415,
        "Unsupported private voice retry content type",
      );
    let body: string;
    try {
      body = await readBoundedBody(request);
    } catch (error) {
      return send(
        response,
        isPayloadTooLarge(error) ? 413 : 400,
        "Invalid private voice retry",
      );
    }
    if (body.length !== 0)
      return send(response, 400, "Invalid private voice retry");
    if (this.recoveryTask !== undefined) return redirect(response, "/voice");
    const voice = this.options.privateVoice;
    if (voice?.status === "degraded" && typeof voice.retry === "function")
      this.startVoiceRecovery(voice);
    return redirect(response, "/voice");
  }

  async handleVoiceRetryCancel(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (
      mediaType(request.headers["content-type"]) !==
      "application/x-www-form-urlencoded"
    )
      return send(
        response,
        415,
        "Unsupported private voice retry cancellation content type",
      );
    let body: string;
    try {
      body = await readBoundedBody(request);
    } catch (error) {
      return send(
        response,
        isPayloadTooLarge(error) ? 413 : 400,
        "Invalid private voice retry cancellation",
      );
    }
    if (body.length !== 0)
      return send(response, 400, "Invalid private voice retry cancellation");
    this.cancelRecovery();
    return redirect(response, "/voice");
  }

  async handleVoiceSpeech(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
  ): Promise<void> {
    const turn = this.turn(request, token);
    if (turn === undefined || turn.adviceId === undefined)
      return send(response, 404, "Private voice turn not found");
    const productTurn = await this.options.productAdviceTurn(turn.adviceId);
    if (productTurn === undefined)
      return send(response, 404, "Household advice not found");
    if (productTurn.status !== "completed")
      return send(response, 409, "Household advice is not complete");
    turn.phase = "completed";
    turn.expiresAt = Date.now() + PRIVATE_VOICE_POST_COMPLETION_TTS_LEASE_MS;
    this.scheduleExpiry();
    const answer = boundedText(
      productTurn.answer,
      MAX_PRIVATE_VOICE_SPEECH_CHARS,
    );
    if (answer === undefined || answer.length === 0)
      return sendVoiceJson(response, 502, { status: "failed" });
    const cached = this.cachedSpeech(token, answer);
    if (cached !== undefined)
      return sendVoiceAudio(response, cached.mimeType, cached.audio);
    let flight = this.speechInFlight;
    if (flight !== undefined && flight.turnId !== token)
      return sendVoiceBackoff(response, 1);
    const retryAfter = flight === undefined ? this.reserveSpeech() : undefined;
    if (retryAfter !== undefined) return sendVoiceBackoff(response, retryAfter);
    flight ??= this.startSpeech(turn.lease, token, answer);
    const waiter = this.trackSpeechWaiter(request, response, flight);
    let audio: VoiceSpeechResult;
    try {
      audio = await flight.promise;
    } finally {
      waiter.release();
    }
    if (waiter.disconnected() || response.destroyed || response.writableEnded)
      return;
    if (audio === "unavailable")
      return sendVoiceJson(response, 503, { status: "unavailable" });
    if (audio === undefined)
      return sendVoiceJson(response, 502, { status: "failed" });
    sendVoiceAudio(response, audio.mimeType, audio.audio);
  }

  async releaseAllTurns(): Promise<void> {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    await Promise.all(
      [...this.turns.keys()].map((token) => this.releaseTurn(token)),
    );
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.configurationTask?.controller.abort();
      this.cancelRecovery();
    }
    await Promise.all([...this.activeSettingsActions]);
    await Promise.all([...this.backgroundWork]);
    await this.releaseAllTurns();
    this.configurationCompletions.clear();
    this.recoveryCompletions.clear();
    this.settingsReceipts.clear();
  }

  private activeVoice(): PrivateVoiceProductPort | undefined {
    const voice = this.options.privateVoice;
    return voice?.status === "active" && typeof voice.beginTurn === "function"
      ? voice
      : undefined;
  }
  private healthNow(): number {
    const value = this.clock();
    return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
  }
  private recordHealth(
    track: "asr" | "tts",
    success: boolean,
    startedAt: number,
  ): void {
    if (this.disposed) return;
    const measuredAt = this.healthNow();
    const target = track === "asr" ? this.asrHealth : this.ttsHealth;
    target.push({
      success,
      latencyMs: boundedHealthLatency(measuredAt - startedAt),
      measuredAt,
    });
    while (target.length > MAX_PRIVATE_VOICE_HEALTH_SAMPLES) target.shift();
  }
  private healthProjection(): ProductPrivateVoiceHealth {
    return {
      scope: "current_process",
      asr: projectHealthTrack(this.asrHealth),
      tts: projectHealthTrack(this.ttsHealth),
    };
  }
  private reserveTranscription(now = this.healthNow()): number | undefined {
    if (this.transcriptionInFlight) return 1;
    trimAttempts(
      this.transcriptionAttempts,
      PRIVATE_VOICE_TRANSCRIPTION_WINDOW_MS,
      now,
    );
    if (
      this.transcriptionAttempts.length >=
      MAX_PRIVATE_VOICE_TRANSCRIPTIONS_PER_WINDOW
    )
      return retryAfter(
        this.transcriptionAttempts[0] ?? now,
        PRIVATE_VOICE_TRANSCRIPTION_WINDOW_MS,
        now,
      );
    this.transcriptionAttempts.push(now);
    this.transcriptionInFlight = true;
    return undefined;
  }
  private releaseTranscription(): void {
    this.transcriptionInFlight = false;
  }
  private sessionKey(request: IncomingMessage): string {
    return createHash("sha256")
      .update(
        `${request.headers.authorization ?? ""}\u0000${request.headers.cookie ?? ""}`,
      )
      .digest()
      .toString("base64");
  }
  private turn(
    request: IncomingMessage,
    token: string,
  ): PrivateVoiceHttpTurn | undefined {
    this.expireTurns();
    const turn = this.turns.get(token);
    return turn !== undefined &&
      timingSafeEqual(
        Buffer.from(turn.sessionKey),
        Buffer.from(this.sessionKey(request)),
      )
      ? turn
      : undefined;
  }
  private isLiveTranscribingTurn(turn: PrivateVoiceHttpTurn): boolean {
    return this.turns.get(turn.token) === turn && turn.phase === "transcribing";
  }
  private expireTurns(now = Date.now()): void {
    const expired = [...this.turns.values()]
      .filter((turn) => turn.expiresAt <= now)
      .map((turn) => turn.token);
    if (expired.length > 0)
      void Promise.all(expired.map((token) => this.releaseTurn(token))).finally(
        () => this.scheduleExpiry(),
      );
  }
  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const earliest = [...this.turns.values()].reduce<number | undefined>(
      (value, turn) =>
        value === undefined ? turn.expiresAt : Math.min(value, turn.expiresAt),
      undefined,
    );
    if (earliest === undefined) return;
    const timer = setTimeout(
      () => {
        if (this.expiryTimer === timer) this.expiryTimer = undefined;
        this.expireTurns();
        this.scheduleExpiry();
      },
      Math.max(0, earliest - Date.now()),
    );
    timer.unref?.();
    this.expiryTimer = timer;
  }
  private async releaseTurn(token: string): Promise<void> {
    const turn = this.turns.get(token);
    if (turn === undefined) return;
    this.turns.delete(token);
    this.speechCache.delete(token);
    await turn.lease.release().catch(() => undefined);
    this.scheduleExpiry();
  }
  private cachedSpeech(
    token: string,
    answer: string,
    now = Date.now(),
  ): BrowserVoiceAudio | undefined {
    const cached = this.speechCache.get(token);
    if (cached === undefined) return undefined;
    if (
      cached.answer !== answer ||
      cached.at + PRIVATE_VOICE_SPEECH_CACHE_MS <= now
    ) {
      this.speechCache.delete(token);
      return undefined;
    }
    return cached.audio;
  }
  private reserveSpeech(now = this.healthNow()): number | undefined {
    trimAttempts(this.speechAttempts, PRIVATE_VOICE_SPEECH_WINDOW_MS, now);
    if (this.speechAttempts.length >= MAX_PRIVATE_VOICE_SYNTHESIS_PER_WINDOW)
      return retryAfter(
        this.speechAttempts[0] ?? now,
        PRIVATE_VOICE_SPEECH_WINDOW_MS,
        now,
      );
    this.speechAttempts.push(now);
    return undefined;
  }
  private startSpeech(
    voice: PrivateVoiceTurnLease,
    token: string,
    answer: string,
  ): VoiceSpeechInFlight {
    const controller = new AbortController();
    let flight!: VoiceSpeechInFlight;
    const promise = this.synthesize(voice, answer, controller.signal)
      .then((audio) => {
        if (
          controller.signal.aborted ||
          audio === undefined ||
          audio === "unavailable"
        )
          return audio;
        this.speechCache.set(token, { answer, at: Date.now(), audio });
        while (this.speechCache.size > MAX_PRIVATE_VOICE_SPEECH_CACHE_ENTRIES) {
          const oldest = this.speechCache.keys().next().value;
          if (typeof oldest !== "string") break;
          this.speechCache.delete(oldest);
        }
        return audio;
      })
      .finally(() => {
        if (this.speechInFlight === flight) this.speechInFlight = undefined;
      });
    flight = { turnId: token, promise, controller, activeWaiters: 0 };
    this.speechInFlight = flight;
    return flight;
  }
  private trackSpeechWaiter(
    request: IncomingMessage,
    response: ServerResponse,
    flight: VoiceSpeechInFlight,
  ): { readonly disconnected: () => boolean; readonly release: () => void } {
    let active = true;
    let disconnected = false;
    flight.activeWaiters += 1;
    const release = (closed: boolean) => {
      if (!active) return;
      active = false;
      disconnected ||= closed;
      request.off("aborted", onDisconnect);
      response.off("close", onDisconnect);
      flight.activeWaiters -= 1;
      if (flight.activeWaiters === 0 && this.speechInFlight === flight) {
        this.speechInFlight = undefined;
        flight.controller.abort();
      }
    };
    const onDisconnect = () => release(true);
    request.once("aborted", onDisconnect);
    response.once("close", onDisconnect);
    if (response.destroyed) onDisconnect();
    return { disconnected: () => disconnected, release: () => release(false) };
  }
  private async synthesize(
    voice: PrivateVoiceTurnLease,
    answer: string,
    signal: AbortSignal,
  ): Promise<VoiceSpeechResult> {
    const healthStartedAt = this.healthNow();
    let result: Awaited<ReturnType<PrivateVoiceTurnLease["synthesize"]>>;
    try {
      result = await voice.synthesize({ text: answer, signal });
    } catch {
      this.recordHealth("tts", false, healthStartedAt);
      return undefined;
    }
    if (result.status !== "synthesized") {
      this.recordHealth("tts", false, healthStartedAt);
      return unavailable(result.reason) ? "unavailable" : undefined;
    }
    if (
      !isOutputMimeType(result.mimeType) ||
      !(result.audio instanceof Uint8Array) ||
      result.audio.byteLength === 0 ||
      result.audio.byteLength > MAX_PRIVATE_VOICE_AUDIO_BYTES
    ) {
      this.recordHealth("tts", false, healthStartedAt);
      return undefined;
    }
    const audio = browserAudio(result);
    this.recordHealth("tts", audio !== undefined, healthStartedAt);
    return audio;
  }
  private startConfiguration(
    settings: OperationalPrivateVoiceSettingsPort,
    input: Omit<OperationalPrivateVoiceConfigureInput, "signal">,
  ): void {
    const task = {
      id: randomBytes(16).toString("hex"),
      startedAt: Date.now(),
      controller: new AbortController(),
    };
    this.configurationTask = task;
    let submitted:
      | Omit<OperationalPrivateVoiceConfigureInput, "signal">
      | undefined = input;
    const work = (async () => {
      const candidate = submitted;
      submitted = undefined;
      let result: OperationalPrivateVoiceConfigureResult;
      try {
        result =
          candidate === undefined
            ? { status: "unavailable" }
            : normalizeConfigureResult(
                await settings.configure({
                  ...candidate,
                  signal: task.controller.signal,
                }),
              );
      } catch {
        result = { status: "unavailable" };
      }
      if (this.configurationTask !== task || this.disposed) return;
      this.configurationTask = undefined;
      const receipt = this.createSettingsReceipt(configureNotice(result));
      this.recordSettingsCompletion(this.configurationCompletions, {
        id: task.id,
        receipt,
        at: Date.now(),
      });
    })();
    this.trackBackgroundWork(work);
  }
  private startSettingsRecovery(
    settings: OperationalPrivateVoiceSettingsPort,
  ): void {
    const task: PrivateVoiceRecoveryTask = {
      id: randomBytes(16).toString("hex"),
      startedAt: Date.now(),
      controller: new AbortController(),
      owner: "settings",
      cancelRequested: false,
    };
    this.recoveryTask = task;
    this.trackBackgroundWork(this.completeRecovery(settings, task));
  }
  private async completeRecovery(
    settings: OperationalPrivateVoiceSettingsPort,
    task: PrivateVoiceRecoveryTask,
  ): Promise<void> {
    let status: OperationalPrivateVoiceStatus;
    try {
      status = await settings.retry();
    } catch {
      status = "degraded";
    }
    status = await this.waitForTerminalRecovery(settings, task, status);
    if (this.recoveryTask !== task || this.disposed) return;
    this.recoveryTask = undefined;
    const receipt = this.createSettingsReceipt(
      recoveryNotice(status, task.cancelRequested),
    );
    this.recordSettingsCompletion(this.recoveryCompletions, {
      id: task.id,
      receipt,
      at: Date.now(),
    });
  }
  private startVoiceRecovery(voice: PrivateVoiceProductPort): void {
    const task: PrivateVoiceRecoveryTask = {
      id: randomBytes(16).toString("hex"),
      startedAt: Date.now(),
      controller: new AbortController(),
      owner: "voice",
      cancelRequested: false,
    };
    this.recoveryTask = task;
    this.trackBackgroundWork(this.completeVoiceRecovery(voice, task));
  }
  private async completeVoiceRecovery(
    voice: PrivateVoiceProductPort,
    task: PrivateVoiceRecoveryTask,
  ): Promise<void> {
    try {
      await voice.retry?.();
    } catch {
      // The frozen gateway status remains the household-visible outcome.
    }
    let status = await this.waitForVoiceTerminalRecovery(voice, task);
    if (task.controller.signal.aborted) status = "degraded";
    if (this.recoveryTask !== task || this.disposed) return;
    this.recoveryTask = undefined;
    const receipt = this.createSettingsReceipt(
      recoveryNotice(status, task.cancelRequested),
    );
    this.recordSettingsCompletion(this.recoveryCompletions, {
      id: task.id,
      receipt,
      at: Date.now(),
    });
  }
  private async waitForTerminalRecovery(
    settings: OperationalPrivateVoiceSettingsPort,
    task: PrivateVoiceRecoveryTask,
    status: OperationalPrivateVoiceStatus,
  ): Promise<OperationalPrivateVoiceStatus> {
    while (status === "retrying" || status === "switching") {
      if (task.controller.signal.aborted) return "degraded";
      const projection = await this.projection(settings);
      if (projection === undefined) return "degraded";
      status = projection.status;
      if (status === "retrying" || status === "switching")
        await waitForRecoveryPoll(task.controller.signal);
    }
    return status;
  }
  private async waitForVoiceTerminalRecovery(
    voice: PrivateVoiceProductPort,
    task: PrivateVoiceRecoveryTask,
  ): Promise<OperationalPrivateVoiceStatus> {
    let status = voice.status;
    while (status === "retrying" || status === "switching") {
      if (task.controller.signal.aborted) return "degraded";
      await waitForRecoveryPoll(task.controller.signal);
      status = voice.status;
    }
    return status;
  }
  private cancelRecovery(): boolean {
    const task = this.recoveryTask;
    if (task === undefined) return false;
    task.cancelRequested = true;
    task.controller.abort();
    try {
      if (task.owner === "settings") this.options.voiceSettings?.cancelRetry();
      else this.options.privateVoice?.cancelRetry?.();
    } catch {
      // The task keeps its household-visible progress until the provider settles.
    }
    return true;
  }
  private async projection(
    settings: OperationalPrivateVoiceSettingsPort,
  ): Promise<ProductPrivateVoice | undefined> {
    try {
      return normalizeProjection(await settings.projection());
    } catch {
      return undefined;
    }
  }
  private trackBackgroundWork(work: Promise<void>): void {
    const settled = work
      .catch(() => undefined)
      .finally(() => this.backgroundWork.delete(settled));
    this.backgroundWork.add(settled);
  }
  private redirectSettingsReceipt(
    response: ServerResponse,
    notice: string,
  ): void {
    redirect(
      response,
      `/settings?voice=${this.createSettingsReceipt(notice)}#private-voice`,
    );
  }
  private createSettingsReceipt(notice: string): string {
    this.pruneSettingsReceipts();
    const receipt = randomBytes(16).toString("hex");
    this.settingsReceipts.set(receipt, { at: Date.now(), notice });
    return receipt;
  }
  private pruneSettingsReceipts(): void {
    const now = Date.now();
    for (const [key, value] of this.settingsReceipts)
      if (now - value.at > SETTINGS_RECEIPT_TTL_MS) this.settingsReceipts.delete(key);
    while (this.settingsReceipts.size > 32) {
      const oldest = this.settingsReceipts.keys().next().value;
      if (oldest === undefined) break;
      this.settingsReceipts.delete(oldest);
    }
  }
  private consumeConfigurationCompletion(): string | undefined {
    return this.consumeLatestSettingsCompletion(this.configurationCompletions);
  }
  private consumeRecoveryCompletion(): string | undefined {
    return this.consumeLatestSettingsCompletion(this.recoveryCompletions);
  }
  private recordSettingsCompletion<T extends PrivateVoiceConfigurationCompletion>(
    target: Map<string, T>,
    completion: T,
  ): void {
    this.pruneSettingsCompletions();
    target.set(completion.id, completion);
    while (target.size > MAX_SETTINGS_COMPLETIONS) {
      const oldest = target.keys().next().value;
      if (oldest === undefined) return;
      target.delete(oldest);
    }
  }
  private pruneSettingsCompletions(): void {
    const cutoff = Date.now() - SETTINGS_RECEIPT_TTL_MS;
    for (const target of [this.configurationCompletions, this.recoveryCompletions]) {
      for (const [id, completion] of target)
        if (completion.at < cutoff) target.delete(id);
    }
  }
  private consumeLatestSettingsCompletion(
    target: ReadonlyMap<string, PrivateVoiceConfigurationCompletion>,
  ): string | undefined {
    this.pruneSettingsCompletions();
    const completions = [...target.values()];
    for (let index = completions.length - 1; index >= 0; index -= 1) {
      const notice = this.consumeSettingsReceipt(completions[index]!.receipt);
      if (notice !== undefined) return notice;
    }
    return undefined;
  }
  private async generation(
    settings: OperationalPrivateVoiceSettingsPort,
  ): Promise<number | undefined> {
    try {
      return normalizeProjection(await settings.projection())?.generation;
    } catch {
      return undefined;
    }
  }
}

type ProductShellModelPrivateVoice = ProductPrivateVoice;
const NO_FORMAT = Symbol("no-private-voice-format");
const ENCODED_MIME_TYPES = new Set([
  "audio/wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/webm",
  "audio/ogg",
  "audio/flac",
]);
const PCM_RATES = new Set([
  8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000,
]);
const PCM_CHANNELS = new Set([1, 2]);
const BROWSER_OUTPUT_MIME_TYPES = new Set([
  "audio/wav",
  "audio/mpeg",
  "audio/mp4",
]);
function canConfigure(
  principal: InboxReviewActor | undefined,
): principal is InboxReviewActor {
  return (
    principal?.present === true &&
    principal.device.kind === "private" &&
    principal.device.boundPrincipalId === principal.principalId
  );
}
function privateVoiceTurnToken(): string {
  return randomBytes(32).toString("base64url");
}
function isTurnToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}
function mediaType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}
function inputFormat(
  captureMode: PrivateVoiceCaptureMode,
  mimeType: string | undefined,
  headers: Readonly<Record<string, string | string[] | undefined>>,
): PrivateVoiceAudioFormat | typeof NO_FORMAT | undefined {
  const rate = header(headers, "x-audio-rate");
  const width = header(headers, "x-audio-width");
  const channels = header(headers, "x-audio-channels");
  if (captureMode === "encoded_audio")
    return mimeType !== undefined &&
      ENCODED_MIME_TYPES.has(mimeType) &&
      rate === undefined &&
      width === undefined &&
      channels === undefined
      ? NO_FORMAT
      : undefined;
  if (
    mimeType !== "audio/l16" ||
    rate === undefined ||
    width !== "2" ||
    channels === undefined
  )
    return undefined;
  const parsedRate = boundedHeader(rate, PCM_RATES);
  const parsedChannels = boundedHeader(channels, PCM_CHANNELS);
  return parsedRate === undefined || parsedChannels === undefined
    ? undefined
    : { rate: parsedRate, width: 2, channels: parsedChannels };
}
function header(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name];
  return typeof value === "string" && value.length > 0 && value.length <= 16
    ? value
    : undefined;
}
function boundedHeader(
  value: string,
  allowed: ReadonlySet<number>,
): number | undefined {
  if (!/^[1-9]\d{0,5}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && allowed.has(parsed)
    ? parsed
    : undefined;
}
function isVoiceMimeType(mimeType: string): boolean {
  return ENCODED_MIME_TYPES.has(mimeType) || mimeType === "audio/l16";
}
function isOutputMimeType(mimeType: unknown): mimeType is string {
  return (
    typeof mimeType === "string" &&
    (mimeType === "audio/l16" || BROWSER_OUTPUT_MIME_TYPES.has(mimeType))
  );
}
function browserAudio(
  result: Extract<
    Awaited<ReturnType<PrivateVoiceTurnLease["synthesize"]>>,
    { readonly status: "synthesized" }
  >,
): BrowserVoiceAudio | undefined {
  if (result.mimeType !== "audio/l16")
    return { mimeType: result.mimeType, audio: result.audio };
  const format = result.format;
  if (
    format === undefined ||
    format.width !== 2 ||
    !PCM_RATES.has(format.rate) ||
    !PCM_CHANNELS.has(format.channels) ||
    result.audio.byteLength % (format.width * format.channels) !== 0
  )
    return undefined;
  return {
    mimeType: "audio/wav",
    audio: pcmWav(result.audio, format.rate, format.channels),
  };
}
function pcmWav(pcm: Uint8Array, rate: number, channels: number): Uint8Array {
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  writeAscii(wav, 0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(wav, 8, "WAVE");
  writeAscii(wav, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(wav, 36, "data");
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}
function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1)
    target[offset + index] = value.charCodeAt(index);
}
function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(text)
    ? text
    : undefined;
}
function boundedHealthLatency(value: number): number {
  return Number.isFinite(value) && value >= 0
    ? Math.min(MAX_PRIVATE_VOICE_HEALTH_LATENCY_MS, Math.floor(value))
    : 0;
}
function projectHealthTrack(
  samples: readonly PrivateVoiceHealthSample[],
): ProductPrivateVoiceHealthTrack {
  const bounded = samples.slice(-MAX_PRIVATE_VOICE_HEALTH_SAMPLES);
  const last = bounded.at(-1);
  const sampleCount = Math.min(MAX_PRIVATE_VOICE_HEALTH_SAMPLES, bounded.length);
  const successCount = Math.min(
    sampleCount,
    bounded.reduce((count, sample) => count + (sample.success ? 1 : 0), 0),
  );
  return {
    sampleCount,
    successCount,
    ...(last === undefined
      ? {}
      : {
          lastLatencyMs: boundedHealthLatency(last.latencyMs),
          lastMeasuredAt:
            Number.isSafeInteger(last.measuredAt) && last.measuredAt >= 0
              ? last.measuredAt
              : 0,
        }),
  };
}
function unavailable(reason: unknown): boolean {
  return (
    reason === "unavailable" ||
    reason === "disabled" ||
    reason === "degraded" ||
    reason === "endpoint_unreachable"
  );
}

function voiceAdviceUnavailableStatus(
  status: AdviceAvailabilityStatus,
): "model_unavailable" | "unavailable" {
  return status === "model_unavailable" ? "model_unavailable" : "unavailable";
}

function trimAttempts(attempts: number[], windowMs: number, now: number): void {
  while (attempts[0] !== undefined && attempts[0] <= now - windowMs)
    attempts.shift();
}
function retryAfter(oldest: number, windowMs: number, now: number): number {
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1_000));
}
function waitForRecoveryPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 100);
    signal.addEventListener("abort", finish, { once: true });
  });
}
function safeAdviceId(value: string): boolean {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 200;
  } catch {
    return false;
  }
}
function activeAdviceId(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const value = error.activeAdviceId;
  return typeof value === "string" && safeAdviceId(value) ? value : undefined;
}
function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}
function abortOnDisconnect(
  request: IncomingMessage,
  response: ServerResponse,
): { readonly signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.once("aborted", abort);
  response.once("close", abort);
  return {
    signal: controller.signal,
    cleanup() {
      request.off("aborted", abort);
      response.off("close", abort);
    },
  };
}
function applySecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    response.setHeader(name, value);
}
function send(response: ServerResponse, status: number, text: string): void {
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(text);
}
function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 303;
  applySecurityHeaders(response);
  response.setHeader("location", location);
  response.end();
}
function privateVoiceStatusTask(
  request: IncomingMessage,
): PrivateVoiceStatusTask | undefined {
  const query = new URL(request.url ?? "/", "http://localhost").searchParams;
  const configurationId = query.get("configurationId");
  const recoveryId = query.get("recoveryId");
  if (configurationId !== null && recoveryId === null && query.size === 1 && taskId(configurationId)) {
    return { kind: "configuration", id: configurationId };
  }
  if (recoveryId !== null && configurationId === null && query.size === 1 && taskId(recoveryId)) {
    return { kind: "recovery", id: recoveryId };
  }
  return undefined;
}
function sendConfigurationStatus(
  response: ServerResponse,
  body:
    | { readonly status: "idle"; readonly configurationId: string }
    | { readonly status: "idle"; readonly recoveryId: string }
    | { readonly status: "pending"; readonly configurationId: string }
    | { readonly status: "pending"; readonly recoveryId: string }
    | {
        readonly status: "completed";
        readonly configurationId: string;
        readonly receipt: string;
      }
    | {
        readonly status: "completed";
        readonly recoveryId: string;
        readonly receipt: string;
      },
): void {
  applySecurityHeaders(response);
  response.statusCode = 200;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
function sendVoiceJson(
  response: ServerResponse,
  status: number,
  body:
    | {
        readonly status: "accepted";
        readonly adviceId: string;
        readonly transcript: string;
      }
    | { readonly status: "active"; readonly adviceId: string }
    | {
        readonly status: "leased";
        readonly voiceTurnId: string;
        readonly captureMode: PrivateVoiceCaptureMode;
      }
    | { readonly status: "no_input" | "unavailable" | "model_unavailable" | "failed" },
): void {
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
function sendVoiceBackoff(response: ServerResponse, seconds: number): void {
  response.setHeader("retry-after", String(seconds));
  sendVoiceJson(response, 429, { status: "unavailable" });
}
function sendVoiceAudio(
  response: ServerResponse,
  mimeType: string,
  audio: Uint8Array,
): void {
  applySecurityHeaders(response);
  response.statusCode = 200;
  response.setHeader("content-type", mimeType);
  response.setHeader("content-length", String(audio.byteLength));
  response.end(audio);
}
class PayloadTooLargeError extends Error {}
class ReadTimedOutError extends Error {}
function isPayloadTooLarge(error: unknown): boolean {
  return error instanceof PayloadTooLargeError;
}
function isReadTimedOut(error: unknown): boolean {
  return error instanceof ReadTimedOutError;
}
async function readBoundedBody(
  request: IncomingMessage,
  maximum = MAX_FORM_BYTES,
): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maximum)
    throw new PayloadTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) overflow = true;
    else chunks.push(buffer);
  }
  if (overflow) throw new PayloadTooLargeError();
  return Buffer.concat(chunks).toString("utf8");
}
function boundedReadDeadline(value: number | undefined): number {
  if (value === undefined) return PRIVATE_VOICE_READ_DEADLINE_MS;
  if (
    !Number.isSafeInteger(value) ||
    value < 10 ||
    value > PRIVATE_VOICE_READ_DEADLINE_MS
  )
    throw new TypeError(
      "Private voice read deadline must be an integer from 10 to 30000 milliseconds",
    );
  return value;
}
async function readBoundedBytes(
  request: IncomingMessage,
  maximum: number,
  deadlineMs: number,
): Promise<Uint8Array> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maximum)
    throw new PayloadTooLargeError();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: Uint8Array | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("aborted", onAborted);
      result instanceof Error ? reject(result) : resolve(result);
    };
    const onData = (chunk: Buffer | Uint8Array | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maximum) {
        finish(new PayloadTooLargeError());
        request.resume();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish(new Uint8Array(Buffer.concat(chunks)));
    const onAborted = () =>
      finish(new Error("Private voice request was aborted"));
    const deadline = setTimeout(
      () => finish(new ReadTimedOutError()),
      deadlineMs,
    );
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
  });
}
function positiveInteger(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
function configureInput(
  body: string,
): Omit<OperationalPrivateVoiceConfigureInput, "signal"> | undefined {
  const form = new URLSearchParams(body);
  const keys = [
    "expectedGeneration",
    "asrTransport",
    "asrEndpoint",
    "asrModel",
    "asrCredential",
    "ttsTransport",
    "ttsEndpoint",
    "ttsModel",
    "ttsLocale",
    "ttsVoice",
    "ttsCredential",
  ];
  if (
    [...form.keys()].some((key) => !keys.includes(key)) ||
    keys.some((key) => form.getAll(key).length !== 1)
  )
    return undefined;
  const expectedGeneration = positiveInteger(form.get("expectedGeneration"));
  const asrTransport = transport(form.get("asrTransport"));
  const ttsTransport = transport(form.get("ttsTransport"));
  const asrEndpoint = requiredText(form.get("asrEndpoint"), 2_048);
  const ttsEndpoint = requiredText(form.get("ttsEndpoint"), 2_048);
  const ttsLocale = requiredText(form.get("ttsLocale"), 64);
  const asrModel = text(form.get("asrModel"), 256, true);
  const ttsModel = text(form.get("ttsModel"), 256, true);
  const ttsVoice = text(form.get("ttsVoice"), 256, true);
  const asrCredential = credential(form.get("asrCredential"));
  const ttsCredential = credential(form.get("ttsCredential"));
  if (
    expectedGeneration === undefined ||
    asrTransport === undefined ||
    ttsTransport === undefined ||
    asrEndpoint === undefined ||
    ttsEndpoint === undefined ||
    ttsLocale === undefined ||
    asrModel === null ||
    ttsModel === null ||
    ttsVoice === null ||
    asrCredential === null ||
    ttsCredential === null
  )
    return undefined;
  return {
    expectedGeneration,
    asr: {
      kind: "asr",
      transport: asrTransport,
      endpoint: asrEndpoint,
      ...(asrModel === undefined ? {} : { model: asrModel }),
      ...(asrCredential === undefined ? {} : { credential: asrCredential }),
    },
    tts: {
      kind: "tts",
      transport: ttsTransport,
      endpoint: ttsEndpoint,
      locale: ttsLocale,
      ...(ttsModel === undefined ? {} : { model: ttsModel }),
      ...(ttsVoice === undefined ? {} : { voice: ttsVoice }),
      ...(ttsCredential === undefined ? {} : { credential: ttsCredential }),
    },
  };
}
function disableInput(
  body: string,
): { readonly expectedGeneration: number } | undefined {
  const form = new URLSearchParams(body);
  if (
    [...form.keys()].some(
      (key) => key !== "expectedGeneration" && key !== "confirmDisable",
    ) ||
    form.getAll("expectedGeneration").length !== 1 ||
    form.getAll("confirmDisable").length !== 1 ||
    form.get("confirmDisable") !== "confirmed"
  )
    return undefined;
  const expectedGeneration = positiveInteger(form.get("expectedGeneration"));
  return expectedGeneration === undefined ? undefined : { expectedGeneration };
}
function retryInput(body: string): number | undefined {
  const form = new URLSearchParams(body);
  return [...form.keys()].some((key) => key !== "expectedGeneration") ||
    form.getAll("expectedGeneration").length !== 1
    ? undefined
    : positiveInteger(form.get("expectedGeneration"));
}
function cancelConfigureInput(body: string): string | undefined {
  const form = new URLSearchParams(body);
  const id = form.get("configurationId");
  return [...form.keys()].some((key) => key !== "configurationId") ||
    form.getAll("configurationId").length !== 1 ||
    id === null ||
    !taskId(id)
    ? undefined
    : id;
}
function taskId(value: string): boolean { return /^[a-f0-9]{32}$/u.test(value); }
function transport(
  value: string | null,
): "wyoming" | "openai_http" | undefined {
  return value === "wyoming" || value === "openai_http" ? value : undefined;
}
function requiredText(
  value: string | null,
  maximum: number,
): string | undefined {
  const candidate = text(value, maximum, false);
  return typeof candidate === "string" ? candidate : undefined;
}
function text(
  value: string | null,
  maximum: number,
  optional: boolean,
): string | undefined | null {
  if (
    value === null ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    return null;
  if (optional && value.length === 0) return undefined;
  return value.length === 0 ? null : value;
}
function credential(value: string | null): string | undefined | null {
  if (value === null || value.length > 2_048 || value.includes("\u0000"))
    return null;
  return value.length === 0 ? undefined : value;
}
function configureNotice(
  result: OperationalPrivateVoiceConfigureResult,
): string {
  if (result.status === "configured") return "语音服务已检查并保存。";
  if (result.status === "cancelled")
    return "已停止这次检查，原来的语音设置保持不变。";
  if (result.status === "busy") return "语音设置正在处理中，请稍候再查看。";
  if (result.status === "conflict")
    return "语音设置已经更新，请查看当前设置后再继续。";
  if (result.status === "unavailable")
    return "私有语音暂时不可用，请继续使用文字对话或检查设置。";
  if (result.status !== "probe_failed")
    return "私有语音暂时不可用，请继续使用文字对话或检查设置。";
  if (
    result.reason === "missing_endpoint" ||
    result.reason === "endpoint_unreachable"
  )
    return "语音服务暂时无法连接，请检查服务地址后再试。";
  if (result.reason === "missing_locale") return "请先填写语音回复使用的语言。";
  if (result.reason === "credential_rejected")
    return "语音服务未接受凭据，请更新后再试。";
  if (result.reason === "incompatible")
    return "语音服务不兼容，请检查设置后再试。";
  if (result.reason === "timed_out") return "语音服务响应较慢，请稍后再试。";
  return "私有语音暂时不可用，请继续使用文字对话或检查设置。";
}
function disableNotice(result: OperationalPrivateVoiceDisableResult): string {
  if (result.status === "disabled") return "语音已关闭，随时可以再次设置。";
  if (result.status === "busy") return "语音设置正在处理中，请稍候再查看。";
  if (result.status === "conflict")
    return "语音设置已经更新，请查看当前设置后再继续。";
  return "私有语音暂时不可用，请继续使用文字对话或检查设置。";
}
function recoveryNotice(
  status: OperationalPrivateVoiceStatus,
  cancelled: boolean,
): string {
  if (cancelled) return "已停止这次连接，文字对话、家庭状态和活动记录仍然可用。";
  if (status === "active") return "语音已经恢复，可以继续使用。";
  if (status === "retrying" || status === "switching")
    return "正在重新连接语音，你可以继续使用文字对话。";
  if (status === "disabled") return "语音当前未开启，你可以随时设置。";
  return "私有语音暂时不可用，请继续使用文字对话或检查设置。";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function normalizeConfigureResult(
  value: unknown,
): OperationalPrivateVoiceConfigureResult {
  if (!isRecord(value) || typeof value.status !== "string")
    return { status: "unavailable" };
  if (value.status === "configured")
    return typeof value.generation === "number" &&
      Number.isSafeInteger(value.generation) &&
      value.generation >= 1
      ? { status: "configured", generation: value.generation }
      : { status: "unavailable" };
  if (
    value.status === "cancelled" ||
    value.status === "busy" ||
    value.status === "conflict" ||
    value.status === "unavailable"
  )
    return { status: value.status };
  if (
    value.status !== "probe_failed" ||
    (value.track !== "asr" && value.track !== "tts")
  )
    return { status: "unavailable" };
  return value.reason === "missing_endpoint" ||
    value.reason === "missing_locale" ||
    value.reason === "credential_rejected" ||
    value.reason === "endpoint_unreachable" ||
    value.reason === "timed_out" ||
    value.reason === "incompatible" ||
    value.reason === "unavailable"
    ? { status: "probe_failed", track: value.track, reason: value.reason }
    : { status: "unavailable" };
}
function normalizeProjection(value: unknown): ProductPrivateVoice | undefined {
  if (
    !isRecord(value) ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1
  )
    return undefined;
  if (
    value.status === "disabled" &&
    value.configured === false &&
    value.asr === undefined &&
    value.tts === undefined
  )
    return {
      status: "disabled",
      generation: value.generation,
      configured: false,
    };
  if (
    (value.status !== "active" &&
      value.status !== "degraded" &&
      value.status !== "retrying" &&
      value.status !== "switching") ||
    value.configured !== true
  )
    return undefined;
  const asr = projectionAsr(value.asr);
  const tts = projectionTts(value.tts);
  return asr === undefined || tts === undefined
    ? undefined
    : {
        status: value.status,
        generation: value.generation,
        configured: true,
        asr,
        tts,
      };
}
function projectionAsr(
  value: unknown,
):
  | NonNullable<
      Extract<ProductPrivateVoice, { readonly configured: true }>["asr"]
    >
  | undefined {
  if (
    !isRecord(value) ||
    transport(typeof value.transport === "string" ? value.transport : null) ===
      undefined ||
    !projectionText(value.endpoint, 2_048) ||
    typeof value.credentialConfigured !== "boolean"
  )
    return undefined;
  const model = optionalProjectionText(value.model, 256);
  return model === null
    ? undefined
    : {
        transport: value.transport as "wyoming" | "openai_http",
        endpoint: value.endpoint,
        credentialConfigured: value.credentialConfigured,
        ...(model === undefined ? {} : { model }),
      };
}
function projectionTts(
  value: unknown,
):
  | NonNullable<
      Extract<ProductPrivateVoice, { readonly configured: true }>["tts"]
    >
  | undefined {
  if (
    !isRecord(value) ||
    transport(typeof value.transport === "string" ? value.transport : null) ===
      undefined ||
    !projectionText(value.endpoint, 2_048) ||
    !projectionText(value.locale, 64) ||
    typeof value.credentialConfigured !== "boolean"
  )
    return undefined;
  const model = optionalProjectionText(value.model, 256);
  const voice = optionalProjectionText(value.voice, 256);
  return model === null || voice === null
    ? undefined
    : {
        transport: value.transport as "wyoming" | "openai_http",
        endpoint: value.endpoint,
        locale: value.locale,
        credentialConfigured: value.credentialConfigured,
        ...(model === undefined ? {} : { model }),
        ...(voice === undefined ? {} : { voice }),
      };
}
function projectionText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
function optionalProjectionText(
  value: unknown,
  maximum: number,
): string | undefined | null {
  return value === undefined
    ? undefined
    : projectionText(value, maximum)
      ? value
      : null;
}
