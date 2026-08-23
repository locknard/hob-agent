import { createHash, timingSafeEqual , randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Context, Service } from "@deepseek-ai/cordis";

import { ProductHttpHost, type ProductHttpHandler } from "./product-http-host.js";

import type { InboxRejectionFeedbackCode, InboxReviewInput } from "./proposal-inbox.js";
import {
  renderProductContent,
  renderProductHost,
  renderProductViewRecipeContent,
  PRODUCT_PRIVATE_VOICE_JS,
  type ProductOnboardingChoices,
  type ProductOnboardingCapabilityChoice,
  type ProductOnboardingBridgeChoice,
  type ProductOnboardingState,
  type ProductShellModel,
  type ProductPrivateVoice,
  type ProductShellRoute,
  type ProductTurn,
  type ProductControlFeedback,
  type ProductViewPreferenceState,
} from "./product-shell.js";
import { PRODUCT_SHELL_STYLES } from "./product-shell-styles.js";
import {
  ProductViewRegistry,
  type RegisteredProductViewPreference,
  type RegisteredProductViewProvider,
} from "./product-view-registry.js";
import { runProductViewRecipeConformance } from "./product-view-recipe-conformance.js";
import { compileProductViewRecipe, type ProductViewRecipeV1 } from "./product-view-recipe.js";
import {
  productViewRecipePublicationCandidate,
  renderProductLayoutAuthoring,
  type LayoutDraftNotice,
  type ProductViewRecipeDraft,
  type ProductViewRecipeDraftPort,
  type ProductViewRecipePublication,
} from "./product-layout-authoring.js";
import { renderVoiceSurface, VOICE_INTERACTION_JS } from "./voice-surface.js";
import {
  UnavailableOnboardingService,
  type OnboardingActor,
  type OnboardingCommand,
  type OnboardingPort,
} from "./onboarding-service.js";
import type {
  InboxProductReviewProjection,
  InboxProductShellProjection,
  InboxControlResult,
  InboxReviewActor,
  InboxRuntimeDecisionRequest,
  ProposalInboxSnoozeTarget,
  InboxConversationCorrectionResult,
  InboxConversationCorrectionType,
  ProposalInboxBatchActionResult,
} from "./proposal-inbox-service.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_FORM_BYTES = 4 * 1024;
const MAX_SESSION_RECOVERY_FORM_BYTES = 256;
const MAX_SESSION_RECOVERY_FAILURES = 5;
const SESSION_RECOVERY_FAILURE_WINDOW_MS = 60_000;
const MAX_BATCH_CONTROL_FORM_BYTES = 8 * 1024;
// application/x-www-form-urlencoded expands a 1,000-character CJK question to roughly 9 KiB.
const MAX_ADVICE_FORM_BYTES = 12 * 1024;
const MAX_CORRECTION_FORM_BYTES = 24 * 1024;
const MAX_LAYOUT_DRAFT_FORM_BYTES = 196 * 1024;
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
const MAX_ADVICE_EVENT_TEXT = 4 * 1024;
const MAX_ADVICE_EVENT_ID = 64;
const MAX_ADVICE_SSE_QUEUED_EVENTS = 64;
const MAX_ADVICE_SSE_QUEUED_BYTES = 128 * 1024;
const ADVICE_SSE_HEARTBEAT_MS = 15_000;
const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

export type InboxAuthenticator = (authorization: string | undefined) => boolean;

/** Narrow request metadata a product-session owner may use to restore a local session. */
export interface InboxAuthenticationRequest {
  readonly authorization: string | undefined;
  readonly cookie: string | undefined;
  readonly origin: string | undefined;
}

/** Optional asynchronous authentication seam for a supervisor-owned product session. */
export type InboxRequestAuthenticator = (request: InboxAuthenticationRequest) => boolean | Promise<boolean>;

/** Supervisor-owned one-time local code redemption. The Inbox never receives a code or token at construction. */
export interface ProductSessionRecoveryPort {
  recover(code: string): Promise<
    | { readonly status: "recovered"; readonly sessionToken: string; readonly expiresAt: Date }
    | { readonly status: "invalid" | "unavailable" }
  >;
}

/** Stable V4 destinations owned by the product shell. */
export type ProductRoute =
  | "home"
  | "conversation"
  | "review-center"
  | "automations"
  | "activity"
  | "control"
  | "settings"
  | "onboarding";

/** Independent queues stay independent all the way to the browser shell. */
export interface ProductReviewCounts {
  readonly runtimeConfirmations: number;
  readonly persistentProposals: number;
}

export interface ProductRouteRenderContext {
  readonly route: ProductRoute;
  readonly path: string;
  readonly adviceId?: string;
  readonly proposalId?: string;
  readonly reviewCounts?: ProductReviewCounts;
  readonly reviewProjection?: InboxProductReviewProjection;
  readonly availability?: AdviceAvailability;
  readonly activeTurn?: ProductTurn;
  readonly shellProjection?: InboxProductShellProjection;
  readonly controlFeedback?: ProductControlFeedback;
  readonly onboarding?: ProductOnboardingState;
  /** One-shot household feedback shown inside the selected proposal detail. */
  readonly proposalNotice?: string;
  readonly actionPolicy?: ProductShellModel["actionPolicy"];
  readonly privateVoice?: ProductShellModel["privateVoice"];
  readonly household?: ProductShellModel["household"];
  readonly view?: ProductShellModel["view"];
}

export type PrivateVoiceCaptureMode = "encoded_audio" | "pcm_s16le";

export interface PrivateVoiceAudioFormat {
  readonly rate: number;
  readonly width: number;
  readonly channels: number;
}

export type PrivateVoiceProductPortStatus = "active" | "degraded" | "disabled" | "retrying" | "switching";

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
    | { readonly status: "transcribed"; readonly text: string; readonly locale?: string }
    | { readonly status: "failed"; readonly reason: PrivateVoiceFailureReason }
  >;
  synthesize(input: {
    readonly text: string;
    readonly signal?: AbortSignal;
  }): Promise<
    | { readonly status: "synthesized"; readonly mimeType: string; readonly audio: Uint8Array; readonly format?: PrivateVoiceAudioFormat }
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

type OperationalPrivateVoiceStatus = "disabled" | "active" | "degraded" | "retrying" | "switching";
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

type OperationalPrivateVoiceConfigureResult =
  | { readonly status: "configured"; readonly generation: number }
  | { readonly status: "cancelled" }
  | {
      readonly status: "probe_failed";
      readonly track: "asr" | "tts";
      readonly reason: "missing_endpoint" | "missing_locale" | "credential_rejected" | "endpoint_unreachable" | "timed_out" | "incompatible" | "unavailable";
    }
  | { readonly status: "busy" | "conflict" | "unavailable" };

type OperationalPrivateVoiceDisableResult =
  | { readonly status: "disabled"; readonly generation: number }
  | { readonly status: "busy" | "conflict" | "unavailable" };

type OperationalPrivateVoiceConfigureInput = {
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
  configure(input: OperationalPrivateVoiceConfigureInput): Promise<OperationalPrivateVoiceConfigureResult>;
  disable(input: { readonly expectedGeneration: number }): Promise<OperationalPrivateVoiceDisableResult>;
  retry(): Promise<OperationalPrivateVoiceStatus>;
  cancelRetry(): void;
}

/** Server-owned candidate task metadata. The request credentials stay only in its short-lived call frame. */
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

type PrivateVoiceHttpTurn = {
  readonly token: string;
  readonly sessionKey: string;
  readonly lease: PrivateVoiceTurnLease;
  phase: "capturing" | "transcribing" | "awaiting_advice" | "completed";
  uploadUsed: boolean;
  adviceId: string | undefined;
  expiresAt: number;
};

/**
 * Product view provider seam. The HTTP service owns transport and policy
 * checks; providers render ordinary markup from the canonical shell projection.
 */
export type ProductViewProvider = RegisteredProductViewProvider<ProductShellModel, ProductRouteRenderContext>;

/** Static assets served alongside the fixed Host Shell and registered providers. */
export const PRODUCT_CSS = PRODUCT_SHELL_STYLES;
export const PRODUCT_JS = String.raw`// EventSource reconnects with Last-Event-ID for the active household turn.
// The confirmation-method save button waits for a real change; the server
// still answers an unchanged submission honestly for clients without script.
for (const policyForm of document.querySelectorAll("[data-policy-form]")) {
  if (!(policyForm instanceof HTMLFormElement)) continue;
  const submit = policyForm.querySelector('button[type="submit"]');
  if (!(submit instanceof HTMLButtonElement)) continue;
  submit.disabled = true;
  policyForm.addEventListener("change", () => {
    submit.disabled = false;
  }, { once: true });
}

// A one-shot notice cleans its query parameter after display, so a refresh
// or a shared link never replays it. Runs from this asset because the page
// CSP (script-src 'self') forbids inline scripts.
if (document.querySelector("[data-one-shot-notice]") !== null) {
  const cleaned = new URL(location.href);
  if (cleaned.searchParams.has("notice") || cleaned.searchParams.has("policy") || cleaned.searchParams.has("voice")) {
    cleaned.searchParams.delete("notice");
    cleaned.searchParams.delete("policy");
    cleaned.searchParams.delete("voice");
    history.replaceState(null, "", cleaned.pathname + cleaned.search + cleaned.hash);
  }
}

for (const hostViewMenu of document.querySelectorAll("[data-host-view-menu]")) {
  if (!(hostViewMenu instanceof HTMLDetailsElement)) continue;
  document.addEventListener("pointerdown", (event) => {
    if (hostViewMenu.open && event.target instanceof Node && !hostViewMenu.contains(event.target)) hostViewMenu.open = false;
  });
  hostViewMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && hostViewMenu.open) {
      hostViewMenu.open = false;
      const trigger = hostViewMenu.querySelector("[data-host-view-menu-trigger]");
      if (trigger instanceof HTMLElement) trigger.focus();
    }
  });
}

const runtimeCountdowns = Array.from(document.querySelectorAll("[data-runtime-countdown][data-expires-at]"));
const updateRuntimeCountdowns = () => {
  const now = Date.now();
  for (const node of runtimeCountdowns) {
    if (!(node instanceof HTMLElement)) continue;
    const expiry = Date.parse(node.getAttribute("data-expires-at") || "");
    if (!Number.isFinite(expiry)) continue;
    const seconds = Math.max(0, Math.ceil((expiry - now) / 1000));
    if (seconds === 0) {
      node.textContent = "已到期 · 未执行";
      const card = node.closest("[data-review-kind=\"runtime\"]");
      for (const button of card?.querySelectorAll("button") || []) button.disabled = true;
      continue;
    }
    if (seconds < 60) node.textContent = seconds + " 秒后自动取消";
    else if (seconds < 3600) node.textContent = Math.ceil(seconds / 60) + " 分钟后自动取消";
    else node.textContent = Math.ceil(seconds / 3600) + " 小时后自动取消";
  }
};
if (runtimeCountdowns.length > 0) {
  updateRuntimeCountdowns();
  const runtimeCountdownTimer = window.setInterval(updateRuntimeCountdowns, 1000);
  window.addEventListener("beforeunload", () => window.clearInterval(runtimeCountdownTimer), { once: true });
}

const activityFilters = document.querySelector("[data-activity-filters]");
if (activityFilters instanceof HTMLElement) {
  activityFilters.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-activity-filter]") : null;
    if (!(button instanceof HTMLElement)) return;
    const filter = button.getAttribute("data-activity-filter") || "all";
    for (const other of activityFilters.querySelectorAll("[data-activity-filter]")) {
      other.setAttribute("aria-pressed", other === button ? "true" : "false");
    }
    for (const item of document.querySelectorAll("[data-activity-attribution]")) {
      if (!(item instanceof HTMLElement)) continue;
      item.hidden = filter !== "all" && item.getAttribute("data-activity-attribution") !== filter;
    }
  });
}

const turn = document.querySelector("[data-advice-stream=\"sse\"]");
if (turn instanceof HTMLElement) {
  const eventsUrl = turn.getAttribute("data-advice-events");
  const status = turn.querySelector("[data-advice-status]");
  const answer = turn.querySelector("[data-advice-answer]");
  const setStatus = (message) => { if (status instanceof HTMLElement && typeof message === "string") status.textContent = message; };
  const stream = typeof eventsUrl === "string" && eventsUrl.startsWith("/") ? new EventSource(eventsUrl) : undefined;
  const payload = (event) => { try { const value = JSON.parse(event.data); return value && typeof value === "object" ? value : {}; } catch { return {}; } };
  const terminal = (name) => name === "completed" || name === "cancelled" || name === "failed";
  const stages = {
    inspecting_home: "正在查看家里的当前状态。",
    reading_inventory: "正在查看房间和设备。",
    checking_rules: "正在确认家里已有的安排。",
    evaluating_evidence: "正在核对相关记录。",
    composing_answer: "正在整理回答。",
  };
  const handle = (name, event) => {
    const value = payload(event);
    if (name === "accepted") setStatus("已收到，正在查看家里的信息。");
    if (name === "progress") setStatus(typeof value.stage === "string" && stages[value.stage] ? stages[value.stage] : "正在处理。");
    if (stages[name]) setStatus(stages[name]);
    if ((name === "delta" || name === "answer_delta") && answer instanceof HTMLElement && typeof value.text === "string") answer.textContent += value.text;
    if (name === "completed") setStatus("已完成。");
    if (name === "cancelled") setStatus("已停止，家里的状态保持原样。");
    if (name === "failed") setStatus("这次处理需要重新开始。");
    if (terminal(name)) stream?.close();
  };
  if (stream) {
    for (const name of ["accepted", "progress", "inspecting_home", "reading_inventory", "checking_rules", "evaluating_evidence", "composing_answer", "delta", "answer_delta", "completed", "cancelled", "failed"]) stream.addEventListener(name, (event) => handle(name, event));
    stream.addEventListener("error", () => { if (stream.readyState === EventSource.CONNECTING) setStatus("连接正在恢复，答案会继续更新。"); });
    window.addEventListener("beforeunload", () => stream.close(), { once: true });
  }
}
const batchControl = document.querySelector("[data-batch-control]");
if (batchControl instanceof HTMLElement) {
  const checkboxes = Array.from(batchControl.querySelectorAll("input[name=capabilityId][data-batch-policy-class]"));
  const submit = batchControl.querySelector("[data-batch-submit]");
  const updateBatchPreview = () => {
    const selected = checkboxes.filter((node) => node instanceof HTMLInputElement && node.checked).slice(0, 32);
    const counts = { total: selected.length, direct: 0, confirmation: 0, administrator: 0 };
    for (const node of selected) {
      const policy = node.getAttribute("data-batch-policy-class");
      if (policy === "direct" || policy === "confirmation" || policy === "administrator") counts[policy] += 1;
    }
    for (const [key, value] of Object.entries(counts)) {
      const target = batchControl.querySelector("[data-batch-count=\"" + key + "\"]");
      if (target instanceof HTMLElement) target.textContent = String(value);
    }
    if (submit instanceof HTMLButtonElement) submit.disabled = selected.length === 0;
  };
  for (const checkbox of checkboxes) checkbox.addEventListener("change", updateBatchPreview);
  updateBatchPreview();
}
` + `\n${VOICE_INTERACTION_JS}\n${PRODUCT_PRIVATE_VOICE_JS}`;

/**
 * The bundled providers share one presentation kernel and the fixed HTTP
 * contract. The registry supplies deterministic selection and recovery.
 */
const PRODUCT_HREFS: Partial<Record<ProductShellRoute, string>> = {
  overview: "/home",
  conversation: "/conversation",
  reviews: "/review-center",
  automations: "/automations",
  activity: "/activity",
  control: "/control",
  settings: "/settings",
};

function renderBundledView(
  model: ProductShellModel,
  context: ProductRouteRenderContext,
  recipe?: ProductViewRecipeV1,
): string {
  const hrefs: Partial<Record<ProductShellRoute, string>> = {
    ...PRODUCT_HREFS,
    control: "/home?view=builtin.control",
    ...((context.route === "home" && context.view?.activeId === "builtin.control") || context.route === "control"
      ? { overview: "/home?view=builtin.life" }
      : {}),
  };
  const rendered = recipe === undefined
    ? renderProductContent(model, { includeStyles: false, hrefs })
    : renderProductViewRecipeContent(recipe, model, { includeStyles: false, hrefs });
  if (
    context.route !== "conversation"
    || context.adviceId === undefined
    || context.activeTurn === undefined
    || !streamsAdviceTurn(context.activeTurn)
  ) return rendered;
  return `<section data-advice-stream="sse" data-advice-events="/conversation/${encodeURIComponent(context.adviceId)}/events"><p data-advice-status>${escapeTransportHtml(context.activeTurn.statusMessage ?? "正在处理。")}</p><p data-advice-answer></p>${rendered}</section>`;
}

/** Creates a Host-rendered provider from a strict data-only layout recipe. */
export function createDeclarativeProductViewProvider(recipeInput: unknown): ProductViewProvider {
  const recipe = compileProductViewRecipe(recipeInput);
  return productViewProviderFromRecipe(recipe);
}

function productViewProviderFromRecipe(recipe: ProductViewRecipeV1): ProductViewProvider {
  return {
    id: recipe.id,
    label: recipe.title,
    renderContent(model, context) {
      return renderBundledView(model, context, recipe);
    },
  };
}

function productViewProviderFromPublication(publication: ProductViewRecipePublication): ProductViewProvider {
  try {
    const input = JSON.parse(publication.source);
    const recipe = compileProductViewRecipe(input);
    const report = runProductViewRecipeConformance(input);
    if (
      !report.passed
      || report.recipeId !== publication.recipeId
      || report.recipeDigest !== publication.recipeDigest
      || recipe.id !== publication.recipeId
      || recipe.title !== publication.title
    ) throw new TypeError();
    return productViewProviderFromRecipe(recipe);
  } catch {
    throw new TypeError("Published product view is invalid");
  }
}

function conformantRecipeProviders(inputs: readonly unknown[] | undefined): readonly ProductViewProvider[] {
  if (inputs === undefined) return [];
  let length: number;
  try {
    if (!Array.isArray(inputs)) throw new TypeError();
    length = inputs.length;
  } catch {
    throw new TypeError("Product view recipe contributions are invalid");
  }
  if (length > 16) throw new TypeError("Product view accepts at most 16 recipe contributions");
  const providers: ProductViewProvider[] = [];
  try {
    for (let index = 0; index < length; index += 1) {
      const recipe = compileProductViewRecipe(inputs[index]);
      const report = runProductViewRecipeConformance(recipe);
      if (!report.passed) throw new TypeError();
      providers.push(productViewProviderFromRecipe(recipe));
    }
  } catch {
    throw new TypeError("Product view recipe conformance failed");
  }
  return Object.freeze(providers);
}

async function renderRegisteredProductView(
  provider: ProductViewProvider,
  model: ProductShellModel,
  context: ProductRouteRenderContext,
): Promise<string> {
  const input = immutableProviderInput({ model, context });
  return provider.renderContent(input.model, input.context);
}

function immutableProviderInput<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(object)) deepFreeze(child, seen);
  return Object.freeze(value);
}

const BUILTIN_LIFE_VIEW: ProductViewProvider = {
  id: "builtin.life",
  label: "生活视图",
  preferences: [{
    key: "overviewFocus",
    label: "首页信息",
    description: "选择首页展示的信息量。",
    defaultValue: "focused",
    choices: [
      { value: "focused", label: "只看重点" },
      { value: "expanded", label: "展示更多" },
    ],
  }],
  renderContent(model, context) {
    const focus = model.view?.preferences?.find((preference) => preference.key === "overviewFocus")?.value;
    const presented = context.route === "home" && focus !== "expanded"
      ? {
          ...model,
          ...(model.spaces === undefined ? {} : { spaces: model.spaces.slice(0, 4) }),
          ...(model.proposals === undefined ? {} : { proposals: model.proposals.slice(0, 1) }),
        }
      : model;
    return renderBundledView(presented, context);
  },
};

const BUILTIN_CONTROL_VIEW: ProductViewProvider = {
  id: "builtin.control",
  label: "控制视图",
  preferences: [{
    key: "rowDensity",
    label: "设备行距",
    description: "选择控制列表的行距。",
    defaultValue: "comfortable",
    choices: [
      { value: "comfortable", label: "舒展" },
      { value: "compact", label: "紧凑" },
    ],
  }],
  renderContent(model, context) {
    return renderBundledView(context.route === "home" ? { ...model, route: "control" } : model, context);
  },
};

export interface ProposalInboxHttpOptions {
  /** Port 0 is accepted only as a test/embedding seam. */
  readonly port?: number;
  /** An already-listening product host whose active surface is selected explicitly. */
  readonly host?: ProductHttpHost;
  /** Legacy HTTP Basic authenticator retained for local embedding compatibility. */
  readonly authenticate?: InboxAuthenticator;
  /** Supervisor-owned product session authenticator, evaluated instead of HTTP Basic when configured. */
  readonly requestAuthenticator?: InboxRequestAuthenticator;
  /** Supervisor-owned one-time recovery code owner for an activated local household. */
  readonly sessionRecovery?: ProductSessionRecoveryPort;
  /** Explicit household identity for every review mutation. */
  readonly principal?: InboxReviewActor;
  readonly reviewer?: string;
  /** Hub-owned typed onboarding coordinator. */
  readonly onboarding?: OnboardingPort;
  /** Active private voice bridge. Its provider details remain outside product HTTP. */
  readonly privateVoice?: PrivateVoiceProductPort;
  /** Operational settings owner for the same private voice gateway. */
  readonly voiceSettings?: OperationalPrivateVoiceSettingsPort;
  /** Total time allowed to receive one private voice turn. The product uses the fixed 30-second default. */
  readonly privateVoiceReadDeadlineMs?: number;
  /** Test seam. Returns a base64url 256-bit browser capability. */
  readonly privateVoiceTurnToken?: () => string;
  /** Trusted in-process presentation providers registered beside the built-in views. */
  readonly viewProviders?: readonly ProductViewProvider[];
  /** Explicit data-only layout contributions checked before the listener opens. */
  readonly viewRecipes?: readonly unknown[];
  /** Hub-owned durable source drafts for private-device administrator authoring. */
  readonly viewRecipeDrafts?: ProductViewRecipeDraftPort;
  /** Initial provider used before this browser saves a device-local preference. */
  readonly defaultViewId?: string;
}

export type {
  ProductViewRecipeDraft,
  ProductViewRecipeDraftPort,
  ProductViewRecipeDraftSummary,
  ProductViewRecipePublication,
  ProductViewRecipePublicationEvent,
} from "./product-layout-authoring.js";

/**
 * The small, neutral availability vocabulary exposed by the Inbox boundary.
 * The HTTP layer intentionally does not know about DSH, HA, or provider
 * implementation details.
 */
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

export type AdviceProgressEventType =
  | "accepted"
  | "progress"
  | "inspecting_home"
  | "reading_inventory"
  | "checking_rules"
  | "evaluating_evidence"
  | "composing_answer"
  | "delta"
  | "answer_delta"
  | "answer"
  | "completed"
  | "failed"
  | "cancelled";

/** Untrusted input from the agent layer; it is narrowed before SSE delivery. */
export interface AdviceProgressEvent {
  readonly id: string | number;
  readonly type: AdviceProgressEventType;
  readonly data?: unknown;
  readonly text?: unknown;
}

export interface AdviceStartResult {
  readonly id?: string;
  readonly status?: "accepted" | "active_request" | "already_active";
  readonly activeAdviceId?: string;
}

type AdviceEventListener = (event: AdviceProgressEvent) => void;

interface InboxHttpPort {
  review(input: InboxReviewInput): Promise<unknown>;
  canRetryPreparation?(): boolean;
  retryPreparation?(input: {
    proposalId: string;
    expectedRevision: number;
    expectedVersion: number;
  }): Promise<unknown>;
  canObserveNow(): boolean;
  observeNow(): Promise<unknown>;
  getAdviceAvailability?(): AdviceAvailability | Promise<AdviceAvailability>;
  startAdvice?(question: string, actor?: InboxReviewActor): Promise<AdviceStartResult>;
  readAdviceEvents?(
    id: string,
    after?: string,
  ): readonly AdviceProgressEvent[] | Promise<readonly AdviceProgressEvent[]>;
  subscribeAdvice?(id: string, listener: AdviceEventListener): void | (() => void);
  unsubscribeAdvice?(id: string, listener: AdviceEventListener): void;
  cancelAdvice?(id: string): Promise<unknown> | unknown;
  backgroundAdvice?(id: string): Promise<unknown> | unknown;
  retryAdvice?(id: string): Promise<unknown> | unknown;
  getProductAdviceTurn?(id: string, actor?: InboxReviewActor): ProductTurn | Promise<ProductTurn | undefined>;
  submitConversationCorrection?(input: {
    readonly adviceId: string;
    readonly actor: InboxReviewActor;
    readonly correctionType: InboxConversationCorrectionType;
    readonly correction: string;
    readonly idempotencyKey: string;
  }): Promise<InboxConversationCorrectionResult>;
  getProductReviewProjection?(actor?: InboxReviewActor, selectedProposalId?: string): InboxProductReviewProjection | Promise<InboxProductReviewProjection>;
  getProductShellProjection?(actor?: InboxReviewActor, batchRequestId?: string): InboxProductShellProjection | Promise<InboxProductShellProjection>;
  acknowledgeCompletionNotification?(adviceId: string): boolean;
  acknowledgeSafety?(input: { readonly alertId: string; readonly actor: InboxReviewActor }): unknown | Promise<unknown>;
  canControl?(): boolean;
  requestControl?(input: { readonly capabilityId: string; readonly actor: InboxReviewActor }): InboxControlResult | Promise<InboxControlResult>;
  canBatchControl?(): boolean;
  requestBatchControl?(input: { readonly capabilityIds: readonly string[]; readonly actor: InboxReviewActor }): ProposalInboxBatchActionResult | Promise<ProposalInboxBatchActionResult>;
  getProductControlFeedback?(ticketId: string): ProductControlFeedback | Promise<ProductControlFeedback | undefined>;
  undoAction?(input: { readonly ticketId: string; readonly actor: InboxReviewActor }): InboxControlResult | Promise<InboxControlResult>;
  getProductReviewCounts?(): ProductReviewCounts | Promise<ProductReviewCounts>;
  canApproveRuntimeConfirmation?(actor: InboxReviewActor, confirmationId?: string): boolean;
  approveRuntimeConfirmation?(request: InboxRuntimeDecisionRequest): unknown | Promise<unknown>;
  rejectRuntimeConfirmation?(request: InboxRuntimeDecisionRequest): unknown | Promise<unknown>;
  canSnoozeProposal?(): boolean;
  snoozeProposal?(input: { readonly proposalId: string; readonly until: ProposalInboxSnoozeTarget | "later"; readonly expectedRevision?: number }): unknown | Promise<unknown>;
  canRejectProposal?(): boolean;
  rejectProposal?(input: { readonly proposalId: string; readonly expectedRevision: number; readonly reviewer: string }): unknown | Promise<unknown>;
  canLatchProposal?(): boolean;
  latchProposal?(input: { readonly proposalId: string; readonly expectedRevision: number; readonly reviewer: string }): unknown | Promise<unknown>;
  canEnableProposal?(): boolean;
  /** Settings saved a new confirmation configuration: recheck blocked plans. */
  recheckBlockedProposals?(): { readonly rechecked: number; readonly cleared: number };
  enableProposal?(input: { readonly proposalId: string; readonly expectedRevision: number; readonly reviewer: string }): unknown | Promise<unknown>;
  canControlAutomation?(): boolean;
  controlAutomation?(input: { readonly proposalId: string; readonly command: "pause" | "resume" | "close" | "retry"; readonly actor: string }): unknown | Promise<unknown>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeInboxHttp: ProposalInboxHttpService;
  }
}

/** Creates a constant-time HTTP Basic verifier without retaining the raw token. */
export function createInboxBasicAuthenticator(token: string): InboxAuthenticator {
  if (typeof token !== "string" || token.length < 32 || token.length > 512) {
    throw new TypeError("Inbox authentication token must be at least 32 and at most 512 characters");
  }
  const expected = digest(`Basic ${Buffer.from(`home:${token}`).toString("base64")}`);
  return (authorization) => timingSafeEqual(expected, digest(authorization ?? ""));
}

/** Optional localhost-only HTTP delivery for the same-root Inbox controller. */
export class ProposalInboxHttpService extends Service {
  static inject = ["homeInbox"];

  origin = "";
  private readonly server: Server | undefined;
  private readonly host: ProductHttpHost | undefined;
  private readonly hostHandler: ProductHttpHandler = (request, response) => this.handle(request, response);
  private readonly inbox: InboxHttpPort;
  private readonly reviewer: string;
  private readonly principal: InboxReviewActor | undefined;
  private readonly views: ProductViewRegistry<ProductShellModel, ProductRouteRenderContext>;
  private readonly defaultViewId: string;
  private readonly onboarding: OnboardingPort;
  private readonly viewRecipeDrafts: ProductViewRecipeDraftPort | undefined;
  private readonly privateVoiceReadDeadlineMs: number;
  private readonly privateVoiceTurnToken: () => string;
  private readonly privateVoiceTurns = new Map<string, PrivateVoiceHttpTurn>();
  private privateVoiceExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  private voiceTranscriptionInFlight = false;
  private readonly voiceTranscriptionAttempts: number[] = [];
  private voiceSpeechInFlight: VoiceSpeechInFlight | undefined;
  private readonly voiceSpeechAttempts: number[] = [];
  private readonly voiceSpeechCache = new Map<string, {
    readonly answer: string;
    readonly at: number;
    readonly audio: BrowserVoiceAudio;
  }>();
  private sessionRecoveryFailures: number[] = [];
  private sessionRecoveryInFlight = false;
  private readonly privateVoiceSettingsReceipts = new Map<string, {
    readonly at: number;
    readonly notice: string;
  }>();
  private privateVoiceConfigurationTask: PrivateVoiceConfigurationTask | undefined;
  private privateVoiceConfigurationCompletion: PrivateVoiceConfigurationCompletion | undefined;
  private privateVoiceConfigurationDisposed = false;

  constructor(ctx: Context, private readonly options: ProposalInboxHttpOptions) {
    super(ctx, "homeInboxHttp");
    if (options.host === undefined && (!Number.isSafeInteger(options.port) || options.port === undefined || options.port < 0 || options.port > 65_535)) {
      throw new TypeError("Inbox HTTP port must be an integer from 0 to 65535");
    }
    if (options.host !== undefined && options.port !== undefined) {
      throw new TypeError("Inbox HTTP accepts either a port or an external product host");
    }
    if (options.authenticate !== undefined && typeof options.authenticate !== "function") {
      throw new TypeError("Inbox HTTP authenticator is required");
    }
    if (options.requestAuthenticator !== undefined && typeof options.requestAuthenticator !== "function") {
      throw new TypeError("Inbox HTTP request authenticator is invalid");
    }
    if (options.sessionRecovery !== undefined && typeof options.sessionRecovery.recover !== "function") {
      throw new TypeError("Inbox HTTP session recovery owner is invalid");
    }
    if (options.authenticate === undefined && options.requestAuthenticator === undefined) {
      throw new TypeError("Inbox HTTP authenticator is required");
    }
    this.principal = options.principal === undefined ? undefined : normalizeReviewActor(options.principal);
    this.reviewer = this.principal?.principalId ?? (options.reviewer?.trim() || "local-household-reviewer");
    if (this.reviewer.length > 200) throw new TypeError("Inbox reviewer identity is too long");
    this.inbox = ctx.homeInbox as unknown as InboxHttpPort;
    if (this.principal === undefined) {
      throw new TypeError("Inbox runtime review requires an explicit principal role and device binding");
    }
    const recipeProviders = conformantRecipeProviders(options.viewRecipes);
    this.views = new ProductViewRegistry([
      BUILTIN_LIFE_VIEW,
      BUILTIN_CONTROL_VIEW,
      ...(options.viewProviders ?? []),
      ...recipeProviders,
    ], BUILTIN_LIFE_VIEW.id);
    this.defaultViewId = options.defaultViewId ?? BUILTIN_LIFE_VIEW.id;
    if (this.views.resolve(this.defaultViewId).recoveredFrom !== undefined) {
      throw new TypeError("Default product view provider is not registered");
    }
    this.viewRecipeDrafts = options.viewRecipeDrafts;
    this.privateVoiceReadDeadlineMs = boundedPrivateVoiceReadDeadline(options.privateVoiceReadDeadlineMs);
    if (options.privateVoiceTurnToken !== undefined && typeof options.privateVoiceTurnToken !== "function") {
      throw new TypeError("Private voice turn token source is invalid");
    }
    this.privateVoiceTurnToken = options.privateVoiceTurnToken ?? privateVoiceTurnToken;
    this.hydratePublishedProductViews();
    this.onboarding = options.onboarding ?? new UnavailableOnboardingService();
    this.host = options.host;
    this.server = this.host === undefined ? createServer(this.hostHandler) : undefined;
  }

  private hydratePublishedProductViews(): void {
    const publications = this.viewRecipeDrafts?.listActivePublications?.() ?? [];
    try {
      for (const publication of publications) {
        const provider = productViewProviderFromPublication(publication);
        if (!this.views.acceptsDynamic(provider.id)) throw new TypeError();
        this.views.upsertDynamic(provider);
      }
    } catch {
      throw new TypeError("Published product view registry conflict");
    }
  }

  protected async [Service.init](): Promise<void> {
    if (this.host !== undefined) {
      if (this.host.origin === "") throw new Error("External product HTTP host must listen before Inbox initializes");
      this.origin = this.host.origin;
      this.ctx.effect(() => {
        return () => {
          this.host?.detach(this.hostHandler);
          this.cancelPrivateVoiceConfigurationForDispose();
          void this.releaseAllPrivateVoiceTurns();
          this.onboarding.close?.();
        };
      }, "home-inbox-http.detach");
      return;
    }
    const server = this.server;
    if (server === undefined) throw new Error("Inbox HTTP listener is unavailable");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(this.options.port, LOOPBACK_HOST, () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Inbox HTTP listener has no TCP address");
    this.origin = `http://${LOOPBACK_HOST}:${address.port}`;
    this.ctx.effect(() => async () => {
      server.closeIdleConnections?.();
      this.cancelPrivateVoiceConfigurationForDispose();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await this.releaseAllPrivateVoiceTurns();
      this.onboarding.close?.();
    }, "home-inbox-http.close");
  }

  /** Makes this initialized Inbox surface the active handler on its external host. */
  attach(): void {
    if (this.host === undefined) throw new Error("Inbox HTTP service owns its listener and cannot attach to an external host");
    this.host.switchTo(this.hostHandler);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", this.origin);
      if (this.options.sessionRecovery !== undefined && url.pathname === "/pair") {
        return this.handleSessionRecovery(request, response, method, url);
      }
      if (this.options.sessionRecovery !== undefined
        && (method === "GET" || method === "HEAD")
        && url.pathname === "/assets/product.css") {
        return this.sendProductAsset(response, "css", method === "HEAD");
      }
      if (!(await this.authenticateRequest(request))) {
        if (this.options.requestAuthenticator === undefined) {
          response.setHeader("www-authenticate", 'Basic realm="hob-agent Inbox", charset="UTF-8"');
          return send(response, 401, "Authentication required");
        }
        if (this.options.sessionRecovery !== undefined && (method === "GET" || method === "HEAD")) {
          return redirect(response, "/pair");
        }
        return send(response, 401, "请重新打开家庭控制台以恢复本地会话");
      }
      const viewPreference = productViewPreference(
        url.searchParams.get("view"),
        request.headers.cookie,
        this.defaultViewId,
      );
      const requestedViewId = viewPreference.activeId;
      const storedDefaultViewId = viewPreference.defaultId !== undefined
        && this.views.resolve(viewPreference.defaultId).recoveredFrom === undefined
        ? viewPreference.defaultId
        : undefined;
      const persistViewPreference = url.searchParams.has("view");
      if (isMutationMethod(method) && request.headers.origin !== this.origin) {
        return send(response, 403, "请从家庭控制台继续此操作。");
      }
      if ((method === "GET" || method === "HEAD") && url.pathname === "/assets/product.css") {
        return this.sendProductAsset(response, "css", method === "HEAD");
      }
      if ((method === "GET" || method === "HEAD") && url.pathname === "/assets/product.js") {
        return this.sendProductAsset(response, "js", method === "HEAD");
      }
      if (method === "GET" && url.pathname === "/settings/private-voice/configuration-status") {
        if (url.search.length > 0) return send(response, 400, "私有语音设置请求无效。");
        return this.sendPrivateVoiceConfigurationStatus(request, response);
      }
      if ((method === "GET" || method === "HEAD") && url.pathname === "/") {
        return redirect(response, "/home");
      }
      const productRoute = productRouteForPath(url.pathname);
      if ((method === "GET" || method === "HEAD") && productRoute !== undefined) {
        const proposalId = productRoute === "review-center"
          ? selectedProposalId(url.searchParams.get("proposal"))
          : undefined;
        const actionTicketId = productRoute === "control"
          ? selectedActionTicketId(url.searchParams.get("action"))
          : undefined;
        const batchRequestId = productRoute === "control"
          ? selectedBatchRequestId(url.searchParams.get("batch"))
          : undefined;
        return this.sendProductRoute(
          response,
          productRoute,
          url.pathname,
          method === "HEAD",
          undefined,
          proposalId,
          actionTicketId,
          batchRequestId,
          requestedViewId,
          storedDefaultViewId,
          request.headers.cookie,
          persistViewPreference,
          productRoute === "settings" ? boundedLayoutDraftId(url.searchParams.get("layout")) : undefined,
          productRoute === "settings" && url.searchParams.get("preview") === "1",
          productRoute === "settings" ? boundedLayoutDraftNotice(url.searchParams.get("layoutNotice")) : undefined,
          undefined,
          productRoute === "settings" && method === "GET" ? this.consumeActionPolicyReceipt(url.searchParams.get("policy")) : undefined,
          productRoute === "settings" && method === "GET" ? this.consumePrivateVoiceSettingsReceipt(url.searchParams.get("voice")) : undefined,
        );
      }
      if (method === "POST" && url.pathname === "/onboarding/continue") {
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported onboarding content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid onboarding continuation");
        }
        const input = onboardingContinueInput(body);
        if (input === undefined) return send(response, 400, "Invalid onboarding continuation");
        try {
          const result = await this.onboarding.submit(input, this.principal as OnboardingActor | undefined);
          const state = normalizeOnboardingState(resultState(result));
          if (state === undefined) return send(response, 500, "Onboarding continuation failed");
          const adviceId = onboardingAdviceId(result);
          if (state.complete && adviceId !== undefined) return redirectAdvice(response, adviceId);
          return redirect(response, state.complete ? "/conversation" : "/onboarding");
        } catch (error) {
          return send(response, onboardingErrorStatus(error), onboardingErrorText(error));
        }
      }
      if (method === "POST" && url.pathname === "/settings/action-policy") {
        if (this.principal === undefined || !canUsePrivateProposalReviewPrincipal(this.principal)) {
          return send(response, 403, "Confirmation settings require a present member on their own bound private phone");
        }
        const configure = this.onboarding.configureActionPolicy?.bind(this.onboarding);
        if (configure === undefined) return send(response, 404, "Confirmation settings unavailable");
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported confirmation settings content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid confirmation settings");
        }
        const selection = actionPolicySelectionInput(body);
        if (selection === undefined) return send(response, 400, "Invalid confirmation settings");
        let changedCount: number;
        try {
          const configured = await configure(selection, this.principal as OnboardingActor | undefined);
          if (configured.status !== "configured") return send(response, 409, "Confirmation settings were not saved");
          changedCount = configured.changedCount;
        } catch (error) {
          return send(response, onboardingErrorStatus(error), onboardingErrorText(error));
        }
        // A save that changed nothing writes nothing, rechecks nothing, and
        // says so. A real change immediately rechecks every blocked plan, so
        // the card the household came from recovers without another step. The
        // redirect carries an opaque single-use receipt — the page can never
        // be talked into a success message by a crafted URL. A recheck failure
        // never undoes the save; the receipt states it plainly.
        const noChange = changedCount === 0;
        let recheck: { readonly rechecked: number; readonly cleared: number } | undefined;
        let recheckFailed = false;
        if (!noChange) {
          try {
            recheck = this.inbox.recheckBlockedProposals?.();
          } catch {
            recheckFailed = true;
          }
        }
        const receipt = randomBytes(16).toString("hex");
        this.pruneActionPolicyReceipts();
        this.actionPolicyReceipts.set(receipt, {
          at: Date.now(),
          ...(noChange ? { noChange: true } : {}),
          ...(recheck === undefined ? {} : { recheck }),
          ...(recheckFailed ? { recheckFailed: true } : {}),
        });
        return redirect(response, `/settings?policy=${receipt}#action-policy`);
      }
      const privateVoiceSettingsRoute = /^\/settings\/private-voice\/(configure|disable|retry|cancel-retry|cancel-configure)$/.exec(url.pathname);
      if (method === "POST" && privateVoiceSettingsRoute !== null) {
        if (url.search.length > 0) return send(response, 400, "私有语音设置请求无效。");
        const action = privateVoiceSettingsAction(privateVoiceSettingsRoute[1]);
        return action === undefined
          ? send(response, 404, "私有语音设置操作不存在。")
          : this.handleOperationalPrivateVoiceSettings(request, response, action);
      }
      if (method === "POST" && url.pathname === "/settings/view-default") {
        if (!canManageProductViewDefault(this.principal)) {
          return send(response, 403, "Device view preference requires an eligible household member");
        }
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported view preference content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid view preference");
        }
        const command = productViewDefaultCommand(body);
        if (command === undefined) return send(response, 400, "Invalid view preference");
        if (command.mode === "reset") clearProductViewDefault(response);
        else {
          const resolution = this.views.resolve(command.viewId);
          if (resolution.recoveredFrom !== undefined) return send(response, 400, "Unknown product view provider");
          setProductViewDefault(response, resolution.provider.id);
        }
        return redirect(response, "/settings");
      }
      if (method === "POST" && url.pathname === "/settings/view-presentation") {
        if (!canManageProductViewDefault(this.principal)) {
          return send(response, 403, "View presentation preference requires an eligible household member");
        }
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported view presentation content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid view presentation preference");
        }
        const command = productViewPresentationCommand(body);
        if (command === undefined) return send(response, 400, "Invalid view presentation preference");
        const resolution = this.views.resolve(command.providerId);
        if (resolution.recoveredFrom !== undefined) return send(response, 400, "Unknown product view provider");
        const preferences = resolution.provider.preferences ?? [];
        if (command.mode === "reset") {
          if (preferences.length === 0) return send(response, 400, "Product view provider has no presentation preferences");
          clearProductViewPresentation(response, resolution.provider.id, preferences);
        } else {
          const preference = preferences.find((candidate) => candidate.key === command.key);
          if (preference === undefined || !preference.choices.some((choice) => choice.value === command.value)) {
            return send(response, 400, "Unknown product view presentation choice");
          }
          setProductViewPresentation(response, resolution.provider.id, preference.key, command.value);
        }
        return redirect(response, `/settings?view=${encodeURIComponent(resolution.provider.id)}`);
      }
      if (method === "POST" && url.pathname === "/settings/layout-drafts") {
        if (!canAuthorProductViewRecipe(this.principal) || this.viewRecipeDrafts === undefined) {
          return send(response, 403, "Layout authoring requires the household owner's bound private phone");
        }
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported layout draft content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request, MAX_LAYOUT_DRAFT_FORM_BYTES);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid layout draft");
        }
        const input = layoutDraftCreateInput(body);
        if (input === undefined) return send(response, 400, "Invalid layout draft");
        try {
          const draft = this.viewRecipeDrafts.create({ ...input, ownerPrincipalId: this.principal.principalId });
          return redirect(response, `/settings?layout=${encodeURIComponent(draft.draftId)}`);
        } catch (error) {
          return redirect(response, `/settings?layoutNotice=${layoutDraftNoticeForError(error)}`);
        }
      }
      const layoutDraftUpdate = /^\/settings\/layout-drafts\/([^/]+)$/.exec(url.pathname);
      if (method === "POST" && layoutDraftUpdate) {
        if (!canAuthorProductViewRecipe(this.principal) || this.viewRecipeDrafts === undefined) {
          return send(response, 403, "Layout authoring requires the household owner's bound private phone");
        }
        const draftId = boundedLayoutDraftId(safeDecode(layoutDraftUpdate[1]!) ?? null);
        if (draftId === undefined) return send(response, 400, "Invalid layout draft");
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported layout draft content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request, MAX_LAYOUT_DRAFT_FORM_BYTES);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid layout draft");
        }
        const input = layoutDraftUpdateInput(body);
        if (input === undefined) return send(response, 400, "Invalid layout draft");
        try {
          const draft = this.viewRecipeDrafts.update({
            ...input,
            draftId,
            ownerPrincipalId: this.principal.principalId,
          });
          return redirect(response, `/settings?layout=${encodeURIComponent(draft.draftId)}`);
        } catch (error) {
          return redirect(response, `/settings?layout=${encodeURIComponent(draftId)}&layoutNotice=${layoutDraftNoticeForError(error)}`);
        }
      }
      const layoutDraftDelete = /^\/settings\/layout-drafts\/([^/]+)\/delete$/.exec(url.pathname);
      if (method === "POST" && layoutDraftDelete) {
        if (!canAuthorProductViewRecipe(this.principal) || this.viewRecipeDrafts === undefined) {
          return send(response, 403, "Layout authoring requires the household owner's bound private phone");
        }
        const draftId = boundedLayoutDraftId(safeDecode(layoutDraftDelete[1]!) ?? null);
        if (draftId === undefined) return send(response, 400, "Invalid layout draft deletion");
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported layout draft deletion content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid layout draft deletion");
        }
        const expectedRevision = layoutDraftDeleteInput(body);
        if (expectedRevision === undefined) return send(response, 400, "Invalid layout draft deletion");
        try {
          this.viewRecipeDrafts.remove({ draftId, ownerPrincipalId: this.principal.principalId, expectedRevision });
          return redirect(response, "/settings");
        } catch (error) {
          return redirect(response, `/settings?layout=${encodeURIComponent(draftId)}&layoutNotice=${layoutDraftNoticeForError(error)}`);
        }
      }
      const layoutDraftPublish = /^\/settings\/layout-drafts\/([^/]+)\/publish$/.exec(url.pathname);
      if (method === "POST" && layoutDraftPublish) {
        if (!canAuthorProductViewRecipe(this.principal) || this.viewRecipeDrafts?.publish === undefined) {
          return send(response, 403, "Layout publication requires the household owner's bound private phone");
        }
        const draftId = boundedLayoutDraftId(safeDecode(layoutDraftPublish[1]!) ?? null);
        if (draftId === undefined) return send(response, 400, "Invalid layout publication");
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported layout publication content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid layout publication");
        }
        const expectedRevision = layoutDraftDeleteInput(body);
        if (expectedRevision === undefined) return send(response, 400, "Invalid layout publication");
        const draft = this.viewRecipeDrafts.read(draftId, this.principal.principalId);
        const candidate = draft === undefined ? undefined : productViewRecipePublicationCandidate(draft);
        if (draft === undefined) return redirect(response, "/settings?layoutNotice=missing");
        if (candidate === undefined) return redirect(response, `/settings?layout=${encodeURIComponent(draftId)}&layoutNotice=input`);
        if (!this.views.acceptsDynamic(candidate.recipeId)) {
          return redirect(response, `/settings?layout=${encodeURIComponent(draftId)}&layoutNotice=provider`);
        }
        try {
          const published = this.viewRecipeDrafts.publish({
            draftId,
            ownerPrincipalId: this.principal.principalId,
            expectedRevision,
            actorPrincipalId: this.principal.principalId,
          });
          this.views.upsertDynamic(productViewProviderFromPublication(published));
          return redirect(response, `/settings?layout=${encodeURIComponent(draftId)}&layoutNotice=published`);
        } catch (error) {
          return redirect(response, `/settings?layout=${encodeURIComponent(draftId)}&layoutNotice=${layoutPublicationNoticeForError(error)}`);
        }
      }
      const layoutPublicationRollback = /^\/settings\/layout-publications\/([^/]+)\/rollback$/.exec(url.pathname);
      if (method === "POST" && layoutPublicationRollback) {
        if (!canAuthorProductViewRecipe(this.principal) || this.viewRecipeDrafts?.rollbackPublication === undefined) {
          return send(response, 403, "Layout rollback requires the household owner's bound private phone");
        }
        const recipeId = boundedLayoutDraftId(safeDecode(layoutPublicationRollback[1]!) ?? null);
        if (recipeId === undefined) return send(response, 400, "Invalid layout rollback");
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported layout rollback content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid layout rollback");
        }
        const expectedGenerationId = layoutPublicationGenerationInput(body);
        if (expectedGenerationId === undefined) return send(response, 400, "Invalid layout rollback");
        try {
          const restored = this.viewRecipeDrafts.rollbackPublication({
            recipeId,
            expectedGenerationId,
            actorPrincipalId: this.principal.principalId,
          });
          this.views.upsertDynamic(productViewProviderFromPublication(restored));
          return redirect(response, "/settings?layoutNotice=rolled_back");
        } catch (error) {
          return redirect(response, `/settings?layoutNotice=${layoutPublicationNoticeForError(error)}`);
        }
      }
      const layoutPublicationDeactivate = /^\/settings\/layout-publications\/([^/]+)\/deactivate$/.exec(url.pathname);
      if (method === "POST" && layoutPublicationDeactivate) {
        if (!canAuthorProductViewRecipe(this.principal) || this.viewRecipeDrafts?.deactivatePublication === undefined) {
          return send(response, 403, "Layout deactivation requires the household owner's bound private phone");
        }
        const recipeId = boundedLayoutDraftId(safeDecode(layoutPublicationDeactivate[1]!) ?? null);
        if (recipeId === undefined) return send(response, 400, "Invalid layout deactivation");
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported layout deactivation content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid layout deactivation");
        }
        const expectedGenerationId = layoutPublicationGenerationInput(body);
        if (expectedGenerationId === undefined) return send(response, 400, "Invalid layout deactivation");
        try {
          this.viewRecipeDrafts.deactivatePublication({
            recipeId,
            expectedGenerationId,
            actorPrincipalId: this.principal.principalId,
          });
          this.views.removeDynamic(recipeId);
          return redirect(response, "/settings?layoutNotice=deactivated");
        } catch (error) {
          return redirect(response, `/settings?layoutNotice=${layoutPublicationNoticeForError(error)}`);
        }
      }
      const safetyAcknowledge = /^\/safety\/([^/]+)\/acknowledge$/.exec(url.pathname);
      if (method === "POST" && safetyAcknowledge) {
        const alertId = safeDecode(safetyAcknowledge[1]!);
        if (alertId === undefined) return send(response, 400, "Invalid safety alert");
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported safety acknowledgement content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid safety acknowledgement");
        }
        if (body.length !== 0) return send(response, 400, "Invalid safety acknowledgement");
        if (this.principal === undefined || this.inbox.acknowledgeSafety === undefined) {
          return send(response, 503, "Safety acknowledgement unavailable");
        }
        try {
          await this.inbox.acknowledgeSafety({ alertId, actor: this.principal });
        } catch (error) {
          const code = errorCode(error);
          if (code === "unauthorized") return send(response, 403, "Safety acknowledgement is unauthorized");
          if (code === "home_safety_alert_not_found") return send(response, 404, "Safety alert not found");
          return send(response, 409, "Safety alert is no longer active");
        }
        return redirect(response, "/home");
      }
      if (method === "POST" && url.pathname === "/voice/turns") {
        if (url.search.length > 0) return send(response, 400, "Invalid private voice request");
        return this.handleVoiceTurnStart(request, response);
      }
      if (method === "POST" && url.pathname === "/voice/retry") {
        if (url.search.length > 0) return send(response, 400, "Invalid private voice request");
        return this.handlePrivateVoiceRetry(request, response);
      }
      const voiceTurn = /^\/voice\/turns\/([^/]+)\/(transcribe|speech|release)$/.exec(url.pathname);
      if (voiceTurn) {
        if (url.search.length > 0) return send(response, 400, "Invalid private voice request");
        const turnId = safeDecode(voiceTurn[1]!);
        if (turnId === undefined) return send(response, 404, "Private voice turn not found");
        if (voiceTurn[2] === "transcribe" && method === "POST") {
          return this.handleVoiceTranscription(request, response, turnId);
        }
        if (voiceTurn[2] === "speech" && method === "GET") {
          return this.handleVoiceSpeech(request, response, turnId);
        }
        if (voiceTurn[2] === "release" && method === "POST") {
          return this.handlePrivateVoiceTurnRelease(request, response, turnId);
        }
        if (voiceTurn[2] === "speech" && method === "HEAD") {
          response.setHeader("allow", "GET");
          return send(response, 405, "Private voice speech requires GET");
        }
        return send(response, 405, "Private voice request uses a different method");
      }
      if ((method === "GET" || method === "HEAD") && url.pathname === "/voice") {
        const retryNotice = url.search.length === 0
          ? false
          : url.search === "?notice=voice_retry_result";
        if (retryNotice === false && url.search.length > 0) return redirect(response, "/voice");
        const privateVoice = this.privateVoiceRenderState();
        const content = renderVoiceSurface("idle", {
          privateVoice,
          ...(retryNotice
            ? { notice: privateVoice.status === "active" ? "recovered" as const : "unavailable" as const }
            : {}),
        } as Parameters<typeof renderVoiceSurface>[1]);
        if (content === undefined) return send(response, 500, "Voice surface unavailable");
        return this.sendVoiceRoute(response, content, method === "HEAD", requestedViewId, storedDefaultViewId, request.headers.cookie);
      }
      const adviceEvents = /^\/conversation\/([^/]+)\/events$/.exec(url.pathname);
      if (method === "GET" && adviceEvents) {
        const adviceId = safeDecode(adviceEvents[1]!);
        return adviceId === undefined
          ? send(response, 404, "Household advice not found")
          : this.handleAdviceEvents(request, response, adviceId);
      }
      const adviceCancel = /^\/conversation\/([^/]+)\/stop$/.exec(url.pathname);
      if (method === "POST" && adviceCancel) {
        const adviceId = safeDecode(adviceCancel[1]!);
        if (adviceId === undefined) return send(response, 400, "Invalid household advice cancellation");
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported household advice content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid household advice cancellation");
        }
        if (body.length !== 0) return send(response, 400, "Invalid household advice cancellation");
        const cancelAdvice = this.inbox.cancelAdvice;
        if (cancelAdvice === undefined) return send(response, 404, "Household advice cancellation unavailable");
        try {
          const result = await cancelAdvice.call(this.inbox, adviceId);
          const status = adviceCancelStatus(result);
          if (status === "not_found") return send(response, 404, "Household advice not found");
          if (status === "terminal_status") return send(response, 409, "Household advice is no longer running");
        } catch (error) {
          const code = errorCode(error);
          if (code === "not_found") return send(response, 404, "Household advice not found");
          if (code === "terminal_status") return send(response, 409, "Household advice is no longer running");
          return send(response, 500, "Household advice cancellation failed");
        }
        response.statusCode = 303;
        applySecurityHeaders(response);
        response.setHeader("location", `/conversation/${encodeURIComponent(adviceId)}`);
        response.end();
        return;
      }
      const adviceBackground = /^\/conversation\/([^/]+)\/background$/.exec(url.pathname);
      if (method === "POST" && adviceBackground) {
        const adviceId = safeDecode(adviceBackground[1]!);
        if (adviceId === undefined) return send(response, 400, "Invalid household advice request");
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported household advice content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid household advice request");
        }
        if (body.length !== 0) return send(response, 400, "Invalid household advice request");
        const backgroundAdvice = this.inbox.backgroundAdvice;
        if (backgroundAdvice === undefined) return send(response, 404, "Household advice background continuation unavailable");
        let result: unknown;
        try {
          result = await backgroundAdvice.call(this.inbox, adviceId);
        } catch {
          return send(response, 500, "Household advice background continuation failed");
        }
        const status = adviceBackgroundStatus(result);
        if (status === "not_found") return send(response, 404, "Household advice not found");
        if (status === "terminal_status") return send(response, 409, "Household advice is complete");
        if (status !== "background") return send(response, 503, "Household advice background continuation unavailable");
        return redirect(response, "/home");
      }
      const adviceRetry = /^\/conversation\/([^/]+)\/retry$/.exec(url.pathname);
      if (method === "POST" && adviceRetry) {
        const adviceId = safeDecode(adviceRetry[1]!);
        if (adviceId === undefined) return send(response, 400, "Invalid household advice request");
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported household advice content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid household advice request");
        }
        if (body.length !== 0) return send(response, 400, "Invalid household advice request");
        const retryAdvice = this.inbox.retryAdvice;
        if (retryAdvice === undefined) return send(response, 404, "Household advice retry unavailable");
        let result: unknown;
        try {
          result = await retryAdvice.call(this.inbox, adviceId);
        } catch {
          return send(response, 500, "Household advice retry failed");
        }
        const status = adviceRetryStatus(result);
        if (status === "not_found") return send(response, 404, "Household advice not found");
        if (status === "terminal_status" || status === "unavailable") {
          return send(response, 409, "Household advice retry is waiting for the home connection");
        }
        const retriedId = isRecord(result) && typeof result.id === "string" ? result.id : undefined;
        if (retriedId === undefined || safeDecode(retriedId) === undefined) {
          return send(response, 500, "Household advice retry failed");
        }
        return redirectAdvice(response, retriedId);
      }
      const adviceCorrection = /^\/conversation\/([^/]+)\/correction$/.exec(url.pathname);
      if (method === "POST" && adviceCorrection) {
        const adviceId = safeDecode(adviceCorrection[1]!);
        if (adviceId === undefined) return send(response, 400, "Invalid household correction");
        if (this.principal === undefined || !canUsePrivateCorrectionPrincipal(this.principal)) {
          return send(response, 403, "Household correction requires a present member on a private device bound to themselves");
        }
        if (this.inbox.submitConversationCorrection === undefined) {
          return send(response, 503, "Household correction is unavailable");
        }
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported household correction content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request, MAX_CORRECTION_FORM_BYTES);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid household correction");
        }
        const input = correctionInput(body);
        if (input === undefined) return send(response, 400, "Invalid household correction");
        const turn = await this.productAdviceTurn(adviceId);
        if (turn === undefined) return send(response, 404, "Household advice not found");
        if (turn.status !== "completed") return send(response, 409, "Household correction requires a completed conversation");
        let result: InboxConversationCorrectionResult;
        try {
          result = await this.inbox.submitConversationCorrection({
            adviceId,
            actor: this.principal,
            correctionType: input.correctionType,
            correction: input.correction,
            idempotencyKey: input.idempotencyKey,
          });
        } catch (error) {
          return send(response, correctionErrorStatus(error), correctionErrorText(error));
        }
        if (result.status !== "updated" && result.status !== "proposal_created") {
          return send(response, 500, "Household correction did not complete");
        }
        return redirectAdvice(response, adviceId);
      }
      const adviceDetail = /^\/conversation\/([^/]+)$/.exec(url.pathname);
      if ((method === "GET" || method === "HEAD") && adviceDetail) {
        const adviceId = safeDecode(adviceDetail[1]!);
        if (adviceId === undefined) return send(response, 404, "Household advice not found");
        return this.sendProductRoute(response, "conversation", url.pathname, method === "HEAD", adviceId, undefined, undefined, undefined, requestedViewId, storedDefaultViewId, request.headers.cookie, persistViewPreference);
      }
      if (method === "POST" && url.pathname === "/conversation") {
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported household advice content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request, MAX_ADVICE_FORM_BYTES);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid household advice request");
        }
        const question = adviceQuestion(body);
        if (question === undefined) return send(response, 400, "Invalid household advice request");
        const availability = await this.adviceAvailability();
        if (availability.status !== "ready") {
          if (availability.status === "active_request" && availability.activeAdviceId !== undefined) {
            return redirectAdvice(response, availability.activeAdviceId);
          }
          return redirectAdviceAvailability(response);
        }
        let advice: AdviceStartResult;
        try {
          advice = await this.startAdvice(question);
        } catch (error) {
          const code = errorCode(error);
          const activeAdviceId = adviceActiveId(error);
          if ((code === "active_request" || code === "already_active") && activeAdviceId !== undefined) {
            return redirectAdvice(response, activeAdviceId);
          }
          if (isAdviceAvailabilityStatus(code)) {
            return redirectAdviceAvailability(response);
          }
          return send(response, 500, "Household advice request failed");
        }
        if (advice.id === undefined || safeDecode(advice.id) === undefined) {
          if ((advice.status === "active_request" || advice.status === "already_active")
            && advice.activeAdviceId !== undefined) return redirectAdvice(response, advice.activeAdviceId);
          return send(response, 500, "Household advice request failed");
        }
        if ((advice.status === "active_request" || advice.status === "already_active")
          && advice.activeAdviceId !== undefined) {
          return redirectAdvice(response, advice.activeAdviceId);
        }
        return redirectAdvice(response, advice.id);
      }
      const control = /^\/control\/([^/]+)$/.exec(url.pathname);
      if (method === "POST" && url.pathname === "/control/batch") {
        if (this.principal === undefined || !canUsePresentHouseholdPrincipal(this.principal)) {
          return send(response, 403, "Household batch control requires a present household member");
        }
        if (this.inbox.requestBatchControl === undefined || this.inbox.canBatchControl?.() === false) {
          return send(response, 404, "Household batch control unavailable");
        }
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported household batch control content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request, MAX_BATCH_CONTROL_FORM_BYTES);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid household batch control");
        }
        const capabilityIds = batchCapabilityIds(body);
        if (capabilityIds === undefined) return send(response, 400, "Invalid household batch control");
        let result: ProposalInboxBatchActionResult;
        try {
          result = await this.inbox.requestBatchControl({ capabilityIds, actor: this.principal });
        } catch (error) {
          return send(response, batchControlErrorStatus(error), batchControlErrorText(error));
        }
        if (selectedBatchRequestId(result.requestId) === undefined) return send(response, 500, "Household batch control did not create a request");
        return redirect(response, `/control?batch=${encodeURIComponent(result.requestId)}`);
      }
      if (method === "POST" && control) {
        const capabilityId = safeDecode(control[1]!);
        if (capabilityId === undefined || selectedActionTicketId(capabilityId) === undefined) {
          return send(response, 400, "Invalid household control");
        }
        if (this.principal === undefined || !canUsePresentHouseholdPrincipal(this.principal)) {
          return send(response, 403, "Household control requires a present household member");
        }
        if (this.inbox.requestControl === undefined || this.inbox.canControl?.() === false) {
          return send(response, 404, "Household control unavailable");
        }
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported household control content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid household control");
        }
        if (body.length !== 0) return send(response, 400, "Invalid household control");
        let result: InboxControlResult;
        try {
          result = await this.inbox.requestControl({ capabilityId, actor: this.principal });
        } catch (error) {
          return send(response, controlErrorStatus(error), controlErrorText(error));
        }
        if (result.ticketId === undefined) return send(response, 500, "Household control did not create a ticket");
        return redirect(response, `/control?action=${encodeURIComponent(result.ticketId)}`);
      }
      const undo = /^\/actions\/([^/]+)\/undo$/.exec(url.pathname);
      if (method === "POST" && undo) {
        const ticketId = safeDecode(undo[1]!);
        if (ticketId === undefined || selectedActionTicketId(ticketId) === undefined) {
          return send(response, 400, "Invalid action undo");
        }
        if (this.principal === undefined || !canUsePresentHouseholdPrincipal(this.principal)) {
          return send(response, 403, "Action undo requires a present household member");
        }
        if (this.inbox.undoAction === undefined) return send(response, 404, "Action undo unavailable");
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported action undo content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid action undo");
        }
        if (body.length !== 0) return send(response, 400, "Invalid action undo");
        let result: InboxControlResult;
        try {
          result = await this.inbox.undoAction({ ticketId, actor: this.principal });
        } catch (error) {
          return send(response, controlErrorStatus(error), controlErrorText(error));
        }
        if (result.ticketId === undefined) return send(response, 500, "Action undo did not create a ticket");
        return redirect(response, `/control?action=${encodeURIComponent(result.ticketId)}`);
      }
      const runtimeDecision = /^\/runtime-confirmations\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
      if (method === "POST" && runtimeDecision) {
        const confirmationId = safeDecode(runtimeDecision[1]!);
        if (confirmationId === undefined) return send(response, 400, "Invalid runtime confirmation");
        if (this.principal === undefined || !canUsePresentHouseholdPrincipal(this.principal)) {
          return send(response, 403, "Runtime review requires a present household member");
        }
        const decide = runtimeDecision[2] === "approve"
          ? this.inbox.approveRuntimeConfirmation
          : this.inbox.rejectRuntimeConfirmation;
        if (decide === undefined) return send(response, 404, "Runtime confirmation review unavailable");
        if (runtimeDecision[2] === "approve"
          && this.inbox.canApproveRuntimeConfirmation?.(this.principal, confirmationId) === false) {
          return send(response, 403, "Approval requires a present member on a private device bound to themselves");
        }
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported runtime confirmation content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid runtime confirmation request");
        }
        if (body.length !== 0) return send(response, 400, "Invalid runtime confirmation request");
        let result: unknown;
        try {
          result = await decide.call(this.inbox, { confirmationId, actor: this.principal });
        } catch (error) {
          return send(response, runtimeDecisionErrorStatus(error), runtimeDecisionErrorText(error));
        }
        const status = runtimeDecisionStatus(result);
        if (status !== "approved" && status !== "rejected") {
          return send(response, runtimeDecisionResultStatus(result), runtimeDecisionResultText(result));
        }
        return redirect(response, "/review-center");
      }
      const proposalSnooze = /^\/review-center\/proposals\/([^/]+)\/snooze$/.exec(url.pathname);
      if (method === "POST" && proposalSnooze) {
        const proposalId = safeDecode(proposalSnooze[1]!);
        if (proposalId === undefined) return send(response, 400, "Invalid proposal snooze");
        if (this.principal === undefined || !canUsePrivateProposalReviewPrincipal(this.principal)) {
          return send(response, 403, "Proposal review is read-only on this device; use a bound private device");
        }
        if (!(this.inbox.canSnoozeProposal?.() ?? false) || this.inbox.snoozeProposal === undefined) {
          return send(response, 404, "Proposal snooze unavailable");
        }
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported proposal snooze content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid proposal snooze");
        }
        const snoozeInput = proposalSnoozeInput(body);
        if (snoozeInput === undefined) return send(response, 400, "Invalid proposal snooze");
        try {
          await this.inbox.snoozeProposal({ proposalId, ...snoozeInput });
        } catch (error) {
          return send(response, proposalMutationErrorStatus(error), proposalMutationErrorText(error));
        }
        return redirect(response, `/review-center/proposals/${encodeURIComponent(proposalId)}`);
      }
      const proposalDecision = /^\/review-center\/proposals\/([^/]+)\/(reject|reject-latch)$/.exec(url.pathname);
      if (method === "POST" && proposalDecision) {
        const proposalId = safeDecode(proposalDecision[1]!);
        if (proposalId === undefined) return send(response, 400, "Invalid proposal decision");
        if (this.principal === undefined || !canUsePrivateProposalReviewPrincipal(this.principal)) {
          return send(response, 403, "Proposal review is read-only on this device; use a bound private device");
        }
        const latch = proposalDecision[2] === "reject-latch";
        const available = latch ? this.inbox.canLatchProposal?.() : this.inbox.canRejectProposal?.();
        const decide = latch ? this.inbox.latchProposal : this.inbox.rejectProposal;
        if (!(available ?? false) || decide === undefined) {
          return send(response, 404, latch ? "Proposal latch unavailable" : "Proposal rejection unavailable");
        }
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported proposal decision content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid proposal decision");
        }
        const expectedRevision = proposalDecisionInput(body);
        if (expectedRevision === undefined) return send(response, 400, "Invalid proposal decision");
        try {
          await decide.call(this.inbox, { proposalId, expectedRevision, reviewer: this.reviewer });
        } catch (error) {
          return send(response, proposalMutationErrorStatus(error), proposalMutationErrorText(error));
        }
        return redirect(response, `/review-center/proposals/${encodeURIComponent(proposalId)}`);
      }
      const proposalEnable = /^\/review-center\/proposals\/([^/]+)\/enable$/.exec(url.pathname);
      if (method === "POST" && proposalEnable) {
        const proposalId = safeDecode(proposalEnable[1]!);
        if (proposalId === undefined) return send(response, 400, "Invalid proposal enablement");
        if (this.principal === undefined || !canUsePrivateProposalReviewPrincipal(this.principal)) {
          return send(response, 403, "Proposal review is read-only on this device; use a bound private device");
        }
        if (!(this.inbox.canEnableProposal?.() ?? false) || this.inbox.enableProposal === undefined) {
          return send(response, 404, "Proposal enablement unavailable");
        }
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported proposal enablement content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid proposal enablement");
        }
        const expectedRevision = proposalDecisionInput(body);
        if (expectedRevision === undefined) return send(response, 400, "Invalid proposal enablement");
        try {
          await this.inbox.enableProposal({ proposalId, expectedRevision, reviewer: this.reviewer });
        } catch (error) {
          // A retryable failure stays inside the product: the URL carries only
          // a closed product code, never raw error text, and the card returns
          // with every entry intact instead of an error page.
          if (errorCode(error) === "enable_temporarily_unavailable") {
            return redirect(response, `/review-center/proposals/${encodeURIComponent(proposalId)}?notice=enable_temporarily_unavailable`);
          }
          return send(response, proposalMutationErrorStatus(error), proposalMutationErrorText(error));
        }
        return redirect(response, `/review-center/proposals/${encodeURIComponent(proposalId)}`);
      }
      const automationControl = /^\/automations\/([^/]+)\/(pause|resume|close|retry)$/.exec(url.pathname);
      if (method === "POST" && automationControl) {
        const proposalId = safeDecode(automationControl[1]!);
        const command = automationControl[2] as "pause" | "resume" | "close" | "retry";
        if (proposalId === undefined) return send(response, 400, "Invalid automation command");
        if (this.principal === undefined || !canUsePrivateProposalReviewPrincipal(this.principal)) {
          return send(response, 403, "Automation control needs a bound private device");
        }
        if (!(this.inbox.canControlAutomation?.() ?? false) || this.inbox.controlAutomation === undefined) {
          return send(response, 404, "Automation control unavailable");
        }
        try {
          await this.inbox.controlAutomation({ proposalId, command, actor: this.reviewer });
        } catch (error) {
          return send(response, proposalMutationErrorStatus(error), proposalMutationErrorText(error));
        }
        return redirect(response, "/automations");
      }
      const detail = /^\/review-center\/proposals\/([^/]+)$/.exec(url.pathname);
      if ((method === "GET" || method === "HEAD") && detail) {
        const proposalId = safeDecode(detail[1]!);
        if (proposalId === undefined) return send(response, 404, "Proposal not found");
        return this.sendProductRoute(response, "review-center", url.pathname, method === "HEAD", undefined, proposalId, undefined, undefined, requestedViewId, storedDefaultViewId, request.headers.cookie, persistViewPreference, undefined, false, undefined, productNoticeCopy(url.searchParams.get("notice")));
      }
      if (method === "POST" && url.pathname === "/observations/run") {
        if (request.headers.origin !== this.origin) return send(response, 403, "Observation origin rejected");
        if (!this.inbox.canObserveNow()) return send(response, 404, "Observation unavailable");
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported observation content type");
        }
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid observation request");
        }
        if (body.length !== 0) return send(response, 400, "Invalid observation request");
        try {
          await this.inbox.observeNow();
        } catch {
          return send(response, 500, "Observation failed");
        }
        response.statusCode = 303;
        applySecurityHeaders(response);
        response.setHeader("location", "/home");
        response.end();
        return;
      }
      const preparationRetry = /^\/review-center\/proposals\/([^/]+)\/preparation\/retry$/.exec(url.pathname);
      if (method === "POST" && preparationRetry) {
        if (request.headers.origin !== this.origin) return send(response, 403, "Preparation retry origin rejected");
        if (!(this.inbox.canRetryPreparation?.() ?? false) || this.inbox.retryPreparation === undefined) {
          return send(response, 404, "Preparation retry unavailable");
        }
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported preparation retry content type");
        }
        const proposalId = safeDecode(preparationRetry[1]!);
        if (proposalId === undefined) return send(response, 400, "Invalid preparation retry");
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid preparation retry");
        }
        const input = preparationRetryInput(proposalId, body);
        if (input === undefined) return send(response, 400, "Invalid preparation retry");
        try {
          await this.inbox.retryPreparation(input);
        } catch (error) {
          const code = errorCode(error);
          if (code === "job_transition_conflict" || code === "revision_conflict") {
            return send(response, 409, "Preparation retry conflict");
          }
          if (code === "not_found") return send(response, 404, "Preparation job not found");
          return send(response, 500, "Preparation retry failed");
        }
        response.statusCode = 303;
        applySecurityHeaders(response);
        response.setHeader("location", `/review-center/proposals/${encodeURIComponent(proposalId)}`);
        response.end();
        return;
      }
      const review = /^\/review-center\/proposals\/([^/]+)\/review$/.exec(url.pathname);
      if (method === "POST" && review) {
        if (this.principal === undefined || !canUsePrivateProposalReviewPrincipal(this.principal)) {
          return send(response, 403, "Proposal approval requires a bound private device");
        }
        if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
          return send(response, 415, "Unsupported review content type");
        }
        const proposalId = safeDecode(review[1]!);
        if (proposalId === undefined) return send(response, 400, "Invalid proposal review");
        let body: string;
        try {
          body = await readBoundedBody(request);
        } catch (error) {
          return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid proposal review");
        }
        const input = reviewInput(proposalId, body, this.reviewer);
        if (input === undefined) return send(response, 400, "Invalid proposal review");
        try {
          await this.inbox.review(input);
        } catch (error) {
          const code = errorCode(error);
          if (code === "revision_conflict" || code === "terminal_status") {
            return send(response, 409, "Proposal review conflict");
          }
          if (code === "not_found") return send(response, 404, "Proposal not found");
          return send(response, 500, "Proposal review failed");
        }
        response.statusCode = 303;
        applySecurityHeaders(response);
        response.setHeader("location", `/review-center/proposals/${encodeURIComponent(proposalId)}`);
        response.end();
        return;
      }
      if (!["GET", "HEAD", "POST"].includes(method)) {
        response.setHeader("allow", "GET, HEAD, POST");
        return send(response, 405, "Method not allowed");
      }
      return send(response, 404, "Not found");
    } catch {
      return send(response, 500, "Inbox request failed");
    }
  }

  private async authenticateRequest(request: IncomingMessage): Promise<boolean> {
    const requestAuthenticator = this.options.requestAuthenticator;
    if (requestAuthenticator === undefined) return this.options.authenticate!(request.headers.authorization);
    try {
      return (await requestAuthenticator(Object.freeze({
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        origin: request.headers.origin,
      }))) === true;
    } catch {
      return false;
    }
  }

  private async handleSessionRecovery(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    url: URL,
  ): Promise<void> {
    if (url.search !== "") return send(response, 404, "Not found");
    if (method === "GET" || method === "HEAD") {
      return sendHtml(response, 200, renderSessionRecoveryPage(), method === "HEAD");
    }
    if (method !== "POST") return send(response, 405, "Method not allowed");
    if (request.headers.origin !== this.origin) return send(response, 403, "This action requires the local household origin");
    if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
      return send(response, 415, "Unsupported recovery content type");
    }
    const retryAfter = this.sessionRecoveryRetryAfterSeconds();
    if (retryAfter > 0) {
      response.setHeader("retry-after", String(retryAfter));
      return sendHtml(response, 429, renderSessionRecoveryPage("limited"), false);
    }
    if (this.sessionRecoveryInFlight) {
      response.setHeader("retry-after", "1");
      request.resume();
      return sendHtml(response, 429, renderSessionRecoveryPage("busy"), false);
    }
    this.sessionRecoveryInFlight = true;
    try {
      let body: string;
      try {
        body = await readBoundedBody(request, MAX_SESSION_RECOVERY_FORM_BYTES);
      } catch (error) {
        if (isPayloadTooLarge(error)) return send(response, 413, "Invalid recovery request");
        body = "";
      }
      const code = sessionRecoveryCode(body);
      const recovered: Awaited<ReturnType<ProductSessionRecoveryPort["recover"]>> = code === undefined
        ? { status: "invalid" as const }
        : await this.options.sessionRecovery!.recover(code).catch(() => ({ status: "unavailable" as const }));
      if (recovered.status !== "recovered") {
        if (recovered.status === "invalid") {
          this.sessionRecoveryFailures.push(Date.now());
          return sendHtml(response, 401, renderSessionRecoveryPage("invalid"), false);
        }
        return sendHtml(response, 503, renderSessionRecoveryPage("unavailable"), false);
      }
      setOperationalSessionCookie(response, recovered.sessionToken, recovered.expiresAt);
      return redirect(response, "/home");
    } finally {
      this.sessionRecoveryInFlight = false;
    }
  }

  private sessionRecoveryRetryAfterSeconds(): number {
    const now = Date.now();
    this.sessionRecoveryFailures = this.sessionRecoveryFailures.filter(
      (attemptedAt) => now - attemptedAt < SESSION_RECOVERY_FAILURE_WINDOW_MS,
    );
    if (this.sessionRecoveryFailures.length < MAX_SESSION_RECOVERY_FAILURES) return 0;
    return Math.max(1, Math.ceil((this.sessionRecoveryFailures[0]! + SESSION_RECOVERY_FAILURE_WINDOW_MS - now) / 1_000));
  }

  private async sendProductAsset(
    response: ServerResponse,
    asset: "css" | "js",
    head: boolean,
  ): Promise<void> {
    const value = asset === "css" ? PRODUCT_CSS : PRODUCT_JS;
    if (asset === "css") sendCss(response, 200, value, head);
    else sendJavaScript(response, 200, value, head);
  }

  private async sendProductRoute(
    response: ServerResponse,
    route: ProductRoute,
    path: string,
    head: boolean,
    adviceId?: string,
    proposalId?: string,
    actionTicketId?: string,
    batchRequestId?: string,
    requestedViewId?: string,
    storedDefaultViewId?: string,
    presentationCookie?: string,
    persistViewPreference = false,
    selectedLayoutDraftId?: string,
    previewLayoutDraft = false,
    layoutDraftNotice?: LayoutDraftNotice,
    proposalNotice?: string,
    actionPolicySavedNotice?: string,
    privateVoiceSavedNotice?: string,
  ): Promise<void> {
    const showsReviewSummary = route === "home" || route === "review-center";
    const reviewProjection = showsReviewSummary ? await this.productReviewProjection(proposalId) : undefined;
    const availability = route === "home" || route === "conversation"
      ? await this.adviceAvailability()
      : undefined;
    const effectiveAdviceId = adviceId
      ?? (availability?.status === "active_request" ? availability.activeAdviceId : undefined);
    const activeTurn = (route === "home" || route === "conversation") && effectiveAdviceId !== undefined
      ? await this.productAdviceTurn(effectiveAdviceId)
      : undefined;
    const hostProjection = await this.productHostProjection(reviewProjection);
    const onboarding = route === "onboarding" ? hostProjection.onboardingState : undefined;
    const controlFeedback = route === "control" && actionTicketId !== undefined
      ? await this.productControlFeedback(actionTicketId)
      : undefined;
    const shellProjection = await this.productShellProjection(batchRequestId);
    const privateVoice = route === "settings"
      ? await this.privateVoiceSettingsContext(privateVoiceSavedNotice)
      : undefined;
    const baseContext: ProductRouteRenderContext = {
      route,
      path,
      ...(route !== "conversation" || effectiveAdviceId === undefined ? {} : { adviceId: effectiveAdviceId }),
      ...(proposalId === undefined ? {} : { proposalId }),
      reviewCounts: hostProjection.reviewCounts,
      ...(reviewProjection === undefined ? {} : { reviewProjection }),
      ...(route === "conversation" && availability !== undefined ? { availability } : {}),
      ...(activeTurn === undefined ? {} : { activeTurn }),
      ...(shellProjection === undefined ? {} : { shellProjection }),
      ...(controlFeedback === undefined ? {} : { controlFeedback }),
      ...(onboarding === undefined ? {} : { onboarding }),
      ...(proposalNotice === undefined ? {} : { proposalNotice }),
      ...(route === "settings" ? this.actionPolicyEditorContext(actionPolicySavedNotice) : {}),
      ...(privateVoice === undefined ? {} : { privateVoice }),
      household: hostProjection.household,
    };
    const viewCurrentPath = productViewCurrentPath(path, route, proposalId, actionTicketId, batchRequestId);
    try {
      let resolution = this.views.resolve(requestedViewId);
      let presentation = productViewPresentation(resolution.provider.id, resolution.provider.preferences ?? [], presentationCookie);
      let context: ProductRouteRenderContext = {
        ...baseContext,
        view: productViewState(viewCurrentPath, resolution.provider.id, this.views.choices(), storedDefaultViewId, canManageProductViewDefault(this.principal), presentation, resolution.recoveredFrom),
      };
      let model = productShellModel(route, context);
      let content: string;
      try {
        content = await renderRegisteredProductView(resolution.provider, model, context);
      } catch (error) {
        if (resolution.provider.id === this.views.fallbackId) throw error;
        const failedProviderId = resolution.provider.id;
        resolution = this.views.resolve();
        presentation = productViewPresentation(resolution.provider.id, resolution.provider.preferences ?? [], presentationCookie);
        context = {
          ...baseContext,
          view: productViewState(viewCurrentPath, resolution.provider.id, this.views.choices(), storedDefaultViewId, canManageProductViewDefault(this.principal), presentation, failedProviderId),
        };
        model = productShellModel(route, context);
        content = await renderRegisteredProductView(resolution.provider, model, context);
      }
      const layoutAuthoring = route === "settings"
        ? this.renderLayoutAuthoring(model, selectedLayoutDraftId, previewLayoutDraft, layoutDraftNotice)
        : "";
      const host = renderProductHost(model, `${content}${layoutAuthoring}`, { includeStyles: false, hrefs: PRODUCT_HREFS });
      const html = productDocument(host, route);
      if (persistViewPreference || context.view?.recoveryMessage !== undefined) {
        setProductViewSession(response, resolution.provider.id);
      }
      if (head) {
        applySecurityHeaders(response);
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end();
      } else {
        sendHtml(response, 200, html, false);
        const completion = shellProjection?.completionNotification;
        if (completion !== undefined) this.inbox.acknowledgeCompletionNotification?.(completion.adviceId);
      }
    } catch {
      send(response, 500, "Product page unavailable");
    }
  }

  private async sendVoiceRoute(
    response: ServerResponse,
    content: string,
    head: boolean,
    requestedViewId?: string,
    storedDefaultViewId?: string,
    presentationCookie?: string,
  ): Promise<void> {
    const [shellProjection, hostProjection] = await Promise.all([
      this.productShellProjection(),
      this.productHostProjection(),
    ]);
    const resolution = this.views.resolve(requestedViewId);
    const presentation = productViewPresentation(resolution.provider.id, resolution.provider.preferences ?? [], presentationCookie);
    const context: ProductRouteRenderContext = {
      route: "conversation",
      path: "/voice",
      reviewCounts: hostProjection.reviewCounts,
      household: hostProjection.household,
      view: productViewState("/voice", resolution.provider.id, this.views.choices(), storedDefaultViewId, canManageProductViewDefault(this.principal), presentation, resolution.recoveredFrom),
      ...(shellProjection === undefined ? {} : { shellProjection }),
    };
    const model = productShellModel("conversation", context);
    const host = renderProductHost(model, content, { includeStyles: false, hrefs: PRODUCT_HREFS });
    const html = productDocument(host, "conversation");
    if (resolution.recoveredFrom !== undefined) setProductViewSession(response, resolution.provider.id);
    if (head) {
      applySecurityHeaders(response);
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end();
      return;
    }
    sendHtml(response, 200, html, false);
  }

  private renderLayoutAuthoring(
    model: ProductShellModel,
    selectedDraftId?: string,
    preview = false,
    notice?: LayoutDraftNotice,
  ): string {
    if (!canAuthorProductViewRecipe(this.principal) || this.viewRecipeDrafts === undefined) return "";
    return renderProductLayoutAuthoring({
      model,
      ownerPrincipalId: this.principal.principalId,
      drafts: this.viewRecipeDrafts,
      acceptsDynamic: (providerId) => this.views.acceptsDynamic(providerId),
      ...(selectedDraftId === undefined ? {} : { selectedDraftId }),
      preview,
      ...(notice === undefined ? {} : { notice }),
    });
  }
  private readonly actionPolicyReceipts = new Map<string, { readonly at: number; readonly noChange?: boolean; readonly recheck?: { readonly rechecked: number; readonly cleared: number }; readonly recheckFailed?: boolean }>();

  private async handleOperationalPrivateVoiceSettings(
    request: IncomingMessage,
    response: ServerResponse,
    action: "configure" | "disable" | "retry" | "cancel-retry" | "cancel-configure",
  ): Promise<void> {
    const settings = this.options.voiceSettings;
    if (settings === undefined) return send(response, 503, "私有语音设置暂时不可用，请继续使用文字对话。");
    if (!canConfigurePrivateVoice(this.principal)) {
      return send(response, 403, "私有语音设置需要通过已绑定的私人设备打开。");
    }
    if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
      return send(response, 415, "请使用设置页面提交语音设置。");
    }
    let body: string;
    try {
      body = await readBoundedBody(request);
    } catch (error) {
      return send(response, isPayloadTooLarge(error) ? 413 : 400, "私有语音设置未能读取。");
    }
    if (action === "cancel-configure") {
      const configurationId = operationalPrivateVoiceCancelConfigureInput(body);
      if (configurationId === undefined) return send(response, 400, "私有语音设置请求无效。");
      const task = this.privateVoiceConfigurationTask;
      if (task === undefined || task.id !== configurationId) {
        return this.redirectPrivateVoiceSettingsReceipt(response, "这次检查已经结束，请查看当前设置。");
      }
      task.controller.abort();
      return redirect(response, "/settings#private-voice");
    }
    if (this.privateVoiceConfigurationTask !== undefined) {
      return this.redirectPrivateVoiceSettingsReceipt(response, "语音设置正在处理中，请稍候再查看。");
    }
    if (action === "configure") {
      const input = operationalPrivateVoiceConfigureInput(body);
      if (input === undefined) return send(response, 400, "私有语音设置请求无效。");
      this.startPrivateVoiceConfiguration(settings, input);
      return redirect(response, "/settings#private-voice");
    }
    if (action === "disable") {
      const input = operationalPrivateVoiceDisableInput(body);
      if (input === undefined) return send(response, 400, "私有语音设置请求无效。");
      let result: OperationalPrivateVoiceDisableResult;
      try {
        result = await settings.disable(input);
      } catch {
        result = { status: "unavailable" };
      }
      return this.redirectPrivateVoiceSettingsReceipt(response, privateVoiceDisableNotice(result));
    }
    const expectedGeneration = operationalPrivateVoiceRetryInput(body);
    if (expectedGeneration === undefined) return send(response, 400, "私有语音设置请求无效。");
    const generation = await this.operationalPrivateVoiceGeneration(settings);
    if (generation === undefined) {
      return this.redirectPrivateVoiceSettingsReceipt(response, "私有语音暂时不可用，请继续使用文字对话或检查设置。");
    }
    if (generation !== expectedGeneration) {
      return this.redirectPrivateVoiceSettingsReceipt(response, "语音设置已经更新，请查看当前设置后再继续。");
    }
    if (action === "retry") {
      let status: OperationalPrivateVoiceStatus;
      try {
        status = await settings.retry();
      } catch {
        status = "degraded";
      }
      return this.redirectPrivateVoiceSettingsReceipt(response, privateVoiceRetryNotice(status));
    }
    try {
      settings.cancelRetry();
      return this.redirectPrivateVoiceSettingsReceipt(response, "已停止这次连接，文字对话仍然可用。");
    } catch {
      return this.redirectPrivateVoiceSettingsReceipt(response, "私有语音暂时不可用，请继续使用文字对话或检查设置。");
    }
  }

  /** Starts one HTTP-owned candidate check and lets its request body become collectible as soon as the port receives it. */
  private startPrivateVoiceConfiguration(
    settings: OperationalPrivateVoiceSettingsPort,
    input: Omit<OperationalPrivateVoiceConfigureInput, "signal">,
  ): void {
    const task: PrivateVoiceConfigurationTask = {
      id: randomBytes(16).toString("hex"),
      startedAt: Date.now(),
      controller: new AbortController(),
    };
    this.privateVoiceConfigurationTask = task;
    let submitted: Omit<OperationalPrivateVoiceConfigureInput, "signal"> | undefined = input;
    void (async () => {
      const candidate = submitted;
      submitted = undefined;
      let result: OperationalPrivateVoiceConfigureResult;
      try {
        result = candidate === undefined
          ? { status: "unavailable" }
          : normalizeOperationalPrivateVoiceConfigureResult(await settings.configure({ ...candidate, signal: task.controller.signal }));
      } catch {
        result = { status: "unavailable" };
      }
      if (this.privateVoiceConfigurationTask !== task || this.privateVoiceConfigurationDisposed) return;
      this.privateVoiceConfigurationTask = undefined;
      const receipt = this.createPrivateVoiceSettingsReceipt(privateVoiceConfigureNotice(result));
      this.privateVoiceConfigurationCompletion = { id: task.id, receipt, at: Date.now() };
    })();
  }

  private sendPrivateVoiceConfigurationStatus(request: IncomingMessage, response: ServerResponse): void {
    if (this.options.voiceSettings === undefined) {
      return send(response, 503, "私有语音设置暂时不可用，请继续使用文字对话。");
    }
    if (!canConfigurePrivateVoice(this.principal)) {
      return send(response, 403, "私有语音设置需要通过已绑定的私人设备打开。");
    }
    if (request.headers.origin !== undefined && request.headers.origin !== this.origin) {
      return send(response, 403, "请从家庭控制台继续查看语音设置。");
    }
    const task = this.privateVoiceConfigurationTask;
    if (task !== undefined) return sendPrivateVoiceConfigurationStatusJson(response, {
      status: "pending",
      configurationId: task.id,
    });
    const completion = this.privateVoiceConfigurationCompletion;
    if (completion !== undefined && Date.now() - completion.at <= 300_000) {
      this.privateVoiceConfigurationCompletion = undefined;
      return sendPrivateVoiceConfigurationStatusJson(response, {
        status: "completed",
        configurationId: completion.id,
        receipt: completion.receipt,
      });
    }
    this.privateVoiceConfigurationCompletion = undefined;
    return sendPrivateVoiceConfigurationStatusJson(response, { status: "idle" });
  }

  private redirectPrivateVoiceSettingsReceipt(response: ServerResponse, notice: string): void {
    const receipt = this.createPrivateVoiceSettingsReceipt(notice);
    redirect(response, `/settings?voice=${receipt}#private-voice`);
  }

  private createPrivateVoiceSettingsReceipt(notice: string): string {
    this.prunePrivateVoiceSettingsReceipts();
    const receipt = randomBytes(16).toString("hex");
    this.privateVoiceSettingsReceipts.set(receipt, { at: Date.now(), notice });
    return receipt;
  }

  private cancelPrivateVoiceConfigurationForDispose(): void {
    this.privateVoiceConfigurationDisposed = true;
    const task = this.privateVoiceConfigurationTask;
    this.privateVoiceConfigurationTask = undefined;
    this.privateVoiceConfigurationCompletion = undefined;
    task?.controller.abort();
  }

  private prunePrivateVoiceSettingsReceipts(): void {
    const now = Date.now();
    for (const [key, value] of this.privateVoiceSettingsReceipts) {
      if (now - value.at > 300_000) this.privateVoiceSettingsReceipts.delete(key);
    }
    while (this.privateVoiceSettingsReceipts.size > 32) {
      const oldest = this.privateVoiceSettingsReceipts.keys().next().value;
      if (oldest === undefined) break;
      this.privateVoiceSettingsReceipts.delete(oldest);
    }
  }

  /** A settings receipt is opaque and renders once only after an ordinary GET. */
  private consumePrivateVoiceSettingsReceipt(token: string | null): string | undefined {
    if (token === null || !/^[a-f0-9]{32}$/.test(token)) return undefined;
    const receipt = this.privateVoiceSettingsReceipts.get(token);
    if (receipt === undefined) return undefined;
    this.privateVoiceSettingsReceipts.delete(token);
    return Date.now() - receipt.at <= 300_000 ? receipt.notice : undefined;
  }

  private async privateVoiceSettingsContext(notice: string | undefined): Promise<ProductShellModel["privateVoice"] | undefined> {
    const settings = this.options.voiceSettings;
    if (settings === undefined) return undefined;
    try {
      const projection = normalizeOperationalPrivateVoiceProjection(await settings.projection());
      if (projection === undefined) return undefined;
      const settledNotice = notice ?? this.consumePrivateVoiceConfigurationCompletion();
      const task = this.privateVoiceConfigurationTask;
      return {
        ...projection,
        ...(settledNotice === undefined ? {} : { notice: settledNotice }),
        ...(task === undefined ? {} : { configurationPending: { id: task.id, startedAt: task.startedAt } }),
      };
    } catch {
      return undefined;
    }
  }

  /** A fast candidate may settle before the redirected page loads; the next authenticated Settings render still receives its one notice. */
  private consumePrivateVoiceConfigurationCompletion(): string | undefined {
    const completion = this.privateVoiceConfigurationCompletion;
    if (completion === undefined) return undefined;
    this.privateVoiceConfigurationCompletion = undefined;
    if (Date.now() - completion.at > 300_000) return undefined;
    return this.consumePrivateVoiceSettingsReceipt(completion.receipt);
  }

  private async operationalPrivateVoiceGeneration(settings: OperationalPrivateVoiceSettingsPort): Promise<number | undefined> {
    try {
      return normalizeOperationalPrivateVoiceProjection(await settings.projection())?.generation;
    } catch {
      return undefined;
    }
  }

  private pruneActionPolicyReceipts(): void {
    const now = Date.now();
    for (const [key, value] of this.actionPolicyReceipts) {
      if (now - value.at > 300_000) this.actionPolicyReceipts.delete(key);
    }
    while (this.actionPolicyReceipts.size > 32) {
      const oldest = this.actionPolicyReceipts.keys().next().value;
      if (oldest === undefined) break;
      this.actionPolicyReceipts.delete(oldest);
    }
  }

  /** A receipt reads exactly once; a forged or replayed token reads nothing. */
  private consumeActionPolicyReceipt(token: string | null): string | undefined {
    if (token === null || !/^[a-f0-9]{32}$/.test(token)) return undefined;
    const receipt = this.actionPolicyReceipts.get(token);
    if (receipt === undefined) return undefined;
    this.actionPolicyReceipts.delete(token);
    if (Date.now() - receipt.at > 300_000) return undefined;
    if (receipt.noChange === true) return "确认方式没有变化。";
    if (receipt.recheckFailed === true) return "已保存确认方式，建议状态稍后重新检查。";
    if (receipt.recheck === undefined) return "已保存确认方式。";
    return receipt.recheck.rechecked === 0
      ? "已保存确认方式，没有受影响的建议。"
      : `已保存确认方式，已重新检查 ${receipt.recheck.rechecked} 条受阻建议${receipt.recheck.cleared > 0 ? `，其中 ${receipt.recheck.cleared} 条已恢复可启用` : ""}。`;
  }

  private actionPolicyEditorContext(savedNotice: string | undefined): { readonly actionPolicy?: ProductShellModel["actionPolicy"] } {
    const read = this.onboarding.actionPolicyChoices?.bind(this.onboarding);
    if (read === undefined || this.onboarding.configureActionPolicy === undefined) return {};
    let choices: ReturnType<NonNullable<OnboardingPort["actionPolicyChoices"]>> | undefined;
    try {
      choices = read();
    } catch {
      return {};
    }
    if (choices === undefined) return {};
    if (choices.status !== "available" || choices.capabilities.length === 0) return {};
    return {
      actionPolicy: {
        capabilities: choices.capabilities.slice(0, 200).map((capability) => ({
          id: capability.id,
          label: capability.label,
          bridgeLabel: capability.bridgeLabel,
          // The saved configuration wins; the type-based suggestion is only a
          // labeled hint on rows the household never configured.
          policyClass: capability.currentPolicyClass ?? capability.suggestedPolicyClass,
          state: capability.configurationState
            ?? (capability.currentPolicyClass !== undefined ? "active" as const : "unconfigured" as const),
        })),
        ...(savedNotice === undefined ? {} : { savedNotice }),
      },
    };
  }

  private async productHostProjection(reviewProjection?: InboxProductReviewProjection): Promise<{
    readonly reviewCounts: ProductReviewCounts;
    readonly onboardingState?: ProductOnboardingState;
    readonly household: ProductShellModel["household"];
  }> {
    const [reviewCounts, onboardingState] = await Promise.all([
      reviewProjection === undefined
        ? this.productReviewCounts()
        : Promise.resolve(productReviewCountsFromProjection(reviewProjection)),
      this.productOnboardingState(),
    ]);
    return {
      reviewCounts,
      ...(onboardingState === undefined ? {} : { onboardingState }),
      household: productHouseholdFromIdentity(onboardingState?.household, this.principal),
    };
  }

  private async productAdviceTurn(id: string): Promise<ProductTurn | undefined> {
    const readTurn = this.inbox.getProductAdviceTurn;
    if (readTurn === undefined) return undefined;
    try {
      return await readTurn.call(this.inbox, id, this.principal);
    } catch {
      return undefined;
    }
  }

  private async productShellProjection(batchRequestId?: string): Promise<InboxProductShellProjection | undefined> {
    const readProjection = this.inbox.getProductShellProjection;
    if (readProjection === undefined) return undefined;
    try {
      return await readProjection.call(this.inbox, this.principal, batchRequestId);
    } catch {
      return undefined;
    }
  }

  private async productControlFeedback(ticketId: string): Promise<ProductControlFeedback | undefined> {
    const readFeedback = this.inbox.getProductControlFeedback;
    if (readFeedback === undefined) return undefined;
    try {
      return await readFeedback.call(this.inbox, ticketId);
    } catch {
      return undefined;
    }
  }

  private async productReviewCounts(): Promise<ProductReviewCounts> {
    const readCounts = this.inbox.getProductReviewCounts;
    if (readCounts === undefined) return { runtimeConfirmations: 0, persistentProposals: 0 };
    try {
      return normalizeProductReviewCounts(await readCounts.call(this.inbox));
    } catch {
      return { runtimeConfirmations: 0, persistentProposals: 0 };
    }
  }

  private async productReviewProjection(selectedProposalId?: string): Promise<InboxProductReviewProjection | undefined> {
    const readProjection = this.inbox.getProductReviewProjection;
    if (readProjection === undefined) return undefined;
    try {
      const value = await readProjection.call(this.inbox, this.principal, selectedProposalId);
      return normalizeProductReviewProjection(value, this.principal);
    } catch {
      return undefined;
    }
  }

  private async productOnboardingState(): Promise<ProductOnboardingState | undefined> {
    try {
      return normalizeOnboardingState(await this.onboarding.getState());
    } catch {
      return undefined;
    }
  }

  private async adviceAvailability(): Promise<AdviceAvailability> {
    const getAvailability = this.inbox.getAdviceAvailability;
    if (getAvailability !== undefined) {
      try {
        return normalizeAdviceAvailability(await getAvailability.call(this.inbox));
      } catch {
        return { status: "stopped" };
      }
    }
    return { status: "unavailable" };
  }

  private async startAdvice(question: string): Promise<AdviceStartResult> {
    const start = this.inbox.startAdvice;
    if (start !== undefined) {
      return normalizeAdviceStart(await start.call(this.inbox, question, this.principal));
    }
    throw new Error("advice_unavailable");
  }

  private privateVoiceRenderState():
    | { readonly status: "active" }
    | { readonly status: "retryable" | "unavailable" } {
    const voice = this.activePrivateVoice();
    if (voice !== undefined) return { status: "active" };
    return this.options.privateVoice?.status === "degraded"
      && typeof this.options.privateVoice.retry === "function"
      ? { status: "retryable" }
      : { status: "unavailable" };
  }

  private activePrivateVoice(): PrivateVoiceProductPort | undefined {
    const voice = this.options.privateVoice;
    return voice?.status === "active"
      && typeof voice.beginTurn === "function"
      ? voice
      : undefined;
  }

  private async handleVoiceTurnStart(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
      return send(response, 415, "Unsupported private voice request content type");
    }
    let body: string;
    try { body = await readBoundedBody(request); } catch (error) {
      return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid private voice request");
    }
    if (body.length !== 0) return send(response, 400, "Invalid private voice request");
    this.expirePrivateVoiceTurns();
    if (this.privateVoiceTurns.size >= MAX_PRIVATE_VOICE_TURNS) return sendVoiceBackoff(response, 1);
    const voice = this.activePrivateVoice();
    const lease = voice?.beginTurn();
    if (lease === undefined || (lease.captureMode !== "encoded_audio" && lease.captureMode !== "pcm_s16le")) {
      return sendVoiceJson(response, 503, { status: "unavailable" });
    }
    const token = this.privateVoiceTurnToken();
    if (!isPrivateVoiceTurnToken(token) || this.privateVoiceTurns.has(token)) {
      await lease.release().catch(() => undefined);
      return sendVoiceJson(response, 503, { status: "unavailable" });
    }
    this.privateVoiceTurns.set(token, {
      token,
      sessionKey: this.privateVoiceSessionKey(request),
      lease,
      phase: "capturing",
      uploadUsed: false,
      adviceId: undefined,
      expiresAt: Date.now() + PRIVATE_VOICE_CAPTURE_OR_TRANSCRIBE_LEASE_MS,
    });
    this.schedulePrivateVoiceExpiry();
    return sendVoiceJson(response, 201, { status: "leased", voiceTurnId: token, captureMode: lease.captureMode });
  }

  private async handleVoiceTranscription(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    const turn = this.privateVoiceTurn(request, token);
    if (turn === undefined) { request.resume(); return send(response, 404, "Private voice turn not found"); }
    if (turn.phase !== "capturing" || turn.uploadUsed) { request.resume(); return send(response, 409, "Private voice turn is no longer accepting audio"); }
    turn.uploadUsed = true;
    turn.phase = "transcribing";
    const voice = turn.lease;
    const mimeType = mediaType(request.headers["content-type"]);
    const format = privateVoiceInputFormat(voice.captureMode, mimeType, request.headers);
    if (mimeType === undefined || format === undefined) {
      void this.releasePrivateVoiceTurn(turn.token);
      return send(response, mimeType === undefined || !isPrivateVoiceMimeType(mimeType) ? 415 : 400, "Invalid private voice audio");
    }
    const initialAvailability = await this.adviceAvailability();
    if (initialAvailability.status === "active_request" && initialAvailability.activeAdviceId !== undefined) {
      request.resume();
      void this.releasePrivateVoiceTurn(turn.token);
      return sendVoiceJson(response, 409, { status: "active", adviceId: initialAvailability.activeAdviceId });
    }
    if (initialAvailability.status !== "ready") {
      request.resume();
      void this.releasePrivateVoiceTurn(turn.token);
      return sendVoiceJson(response, 503, { status: "unavailable" });
    }
    const retryAfter = this.reservePrivateVoiceTranscription();
    if (retryAfter !== undefined) {
      request.resume();
      void this.releasePrivateVoiceTurn(turn.token);
      return sendVoiceBackoff(response, retryAfter);
    }
    try {
      let audio: Uint8Array;
      try {
        audio = await readBoundedBytes(request, MAX_PRIVATE_VOICE_AUDIO_BYTES, this.privateVoiceReadDeadlineMs);
      } catch (error) {
        if (isPrivateVoiceReadTimedOut(error)) {
          request.resume();
          return sendVoiceBackoff(response, 1);
        }
        return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid private voice audio");
      }
      if (audio.byteLength === 0) return sendVoiceJson(response, 422, { status: "no_input" });
      if (format !== NO_PRIVATE_VOICE_FORMAT
        && audio.byteLength % (format.width * format.channels) !== 0) {
        return send(response, 400, "Invalid private voice audio");
      }

      const cancellation = abortOnDisconnect(request, response);
      let transcription: Awaited<ReturnType<PrivateVoiceTurnLease["transcribe"]>>;
      try {
        transcription = await voice.transcribe({
          audio,
          mimeType,
          ...(format === NO_PRIVATE_VOICE_FORMAT ? {} : { format }),
          signal: cancellation.signal,
        });
      } catch {
        return sendVoiceJson(response, 502, { status: "failed" });
      } finally {
        cancellation.cleanup();
      }
      if (transcription.status !== "transcribed") {
        return sendVoiceJson(response, privateVoiceUnavailable(transcription.reason) ? 503 : 502, {
          status: privateVoiceUnavailable(transcription.reason) ? "unavailable" : "failed",
        });
      }
      const transcript = boundedVoiceText(transcription.text, MAX_PRIVATE_VOICE_TRANSCRIPT_CHARS);
      if (transcript === undefined || transcript.length === 0) return sendVoiceJson(response, 422, { status: "no_input" });

      const availability = await this.adviceAvailability();
      if (availability.status === "active_request" && availability.activeAdviceId !== undefined) {
        return sendVoiceJson(response, 409, { status: "active", adviceId: availability.activeAdviceId });
      }
      if (availability.status !== "ready") return sendVoiceJson(response, 503, { status: "unavailable" });
      let advice: AdviceStartResult;
      try {
        advice = await this.startAdvice(transcript);
      } catch (error) {
        const activeAdviceId = adviceActiveId(error);
        if ((errorCode(error) === "active_request" || errorCode(error) === "already_active") && activeAdviceId !== undefined) {
          return sendVoiceJson(response, 409, { status: "active", adviceId: activeAdviceId });
        }
        return sendVoiceJson(response, 503, { status: "unavailable" });
      }
      if ((advice.status === "active_request" || advice.status === "already_active") && advice.activeAdviceId !== undefined) {
        return sendVoiceJson(response, 409, { status: "active", adviceId: advice.activeAdviceId });
      }
      if (advice.id === undefined || safeDecode(advice.id) === undefined) return sendVoiceJson(response, 502, { status: "failed" });
      turn.phase = "awaiting_advice";
      turn.adviceId = advice.id;
      turn.expiresAt = Date.now() + PRIVATE_VOICE_POST_BIND_LEASE_MS;
      this.schedulePrivateVoiceExpiry();
      return sendVoiceJson(response, 202, { status: "accepted", adviceId: advice.id, transcript });
    } finally {
      this.releasePrivateVoiceTranscription();
      if (turn.adviceId === undefined) await this.releasePrivateVoiceTurn(turn.token);
    }
  }

  private reservePrivateVoiceTranscription(now = Date.now()): number | undefined {
    if (this.voiceTranscriptionInFlight) return 1;
    while (this.voiceTranscriptionAttempts[0] !== undefined
      && this.voiceTranscriptionAttempts[0] <= now - PRIVATE_VOICE_TRANSCRIPTION_WINDOW_MS) {
      this.voiceTranscriptionAttempts.shift();
    }
    if (this.voiceTranscriptionAttempts.length >= MAX_PRIVATE_VOICE_TRANSCRIPTIONS_PER_WINDOW) {
      const oldest = this.voiceTranscriptionAttempts[0] ?? now;
      return Math.max(1, Math.ceil((oldest + PRIVATE_VOICE_TRANSCRIPTION_WINDOW_MS - now) / 1_000));
    }
    this.voiceTranscriptionAttempts.push(now);
    this.voiceTranscriptionInFlight = true;
    return undefined;
  }

  private releasePrivateVoiceTranscription(): void {
    this.voiceTranscriptionInFlight = false;
  }

  private privateVoiceSessionKey(request: IncomingMessage): string {
    return digest(`${request.headers.authorization ?? ""}\u0000${request.headers.cookie ?? ""}`).toString("base64");
  }

  private privateVoiceTurn(request: IncomingMessage, token: string): PrivateVoiceHttpTurn | undefined {
    this.expirePrivateVoiceTurns();
    const turn = this.privateVoiceTurns.get(token);
    return turn !== undefined && timingSafeEqual(Buffer.from(turn.sessionKey), Buffer.from(this.privateVoiceSessionKey(request)))
      ? turn
      : undefined;
  }

  private expirePrivateVoiceTurns(now = Date.now()): void {
    const expired: string[] = [];
    for (const turn of this.privateVoiceTurns.values()) {
      if (turn.expiresAt <= now) expired.push(turn.token);
    }
    if (expired.length > 0) void Promise.all(expired.map((token) => this.releasePrivateVoiceTurn(token))).finally(() => this.schedulePrivateVoiceExpiry());
  }

  private schedulePrivateVoiceExpiry(): void {
    if (this.privateVoiceExpiryTimer !== undefined) clearTimeout(this.privateVoiceExpiryTimer);
    this.privateVoiceExpiryTimer = undefined;
    let earliest: number | undefined;
    for (const turn of this.privateVoiceTurns.values()) {
      earliest = earliest === undefined ? turn.expiresAt : Math.min(earliest, turn.expiresAt);
    }
    if (earliest === undefined) return;
    const delay = Math.max(0, earliest - Date.now());
    const timer = setTimeout(() => {
      if (this.privateVoiceExpiryTimer === timer) this.privateVoiceExpiryTimer = undefined;
      this.expirePrivateVoiceTurns();
      this.schedulePrivateVoiceExpiry();
    }, delay);
    timer.unref?.();
    this.privateVoiceExpiryTimer = timer;
  }

  private async releasePrivateVoiceTurn(token: string): Promise<void> {
    const turn = this.privateVoiceTurns.get(token);
    if (turn === undefined) return;
    this.privateVoiceTurns.delete(token);
    this.voiceSpeechCache.delete(token);
    await turn.lease.release().catch(() => undefined);
    this.schedulePrivateVoiceExpiry();
  }

  private async releaseAllPrivateVoiceTurns(): Promise<void> {
    if (this.privateVoiceExpiryTimer !== undefined) clearTimeout(this.privateVoiceExpiryTimer);
    this.privateVoiceExpiryTimer = undefined;
    await Promise.all([...this.privateVoiceTurns.keys()].map((token) => this.releasePrivateVoiceTurn(token)));
  }

  private async handlePrivateVoiceTurnRelease(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
  ): Promise<void> {
    if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
      return send(response, 415, "Unsupported private voice release content type");
    }
    let body: string;
    try { body = await readBoundedBody(request); } catch (error) {
      return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid private voice release");
    }
    if (body.length !== 0) return send(response, 400, "Invalid private voice release");
    const turn = this.privateVoiceTurn(request, token);
    if (turn !== undefined) await this.releasePrivateVoiceTurn(turn.token);
    return send(response, 204, "");
  }

  private async handlePrivateVoiceRetry(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const voice = this.options.privateVoice;
    if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
      return send(response, 415, "Unsupported private voice retry content type");
    }
    let body: string;
    try {
      body = await readBoundedBody(request);
    } catch (error) {
      return send(response, isPayloadTooLarge(error) ? 413 : 400, "Invalid private voice retry");
    }
    if (body.length !== 0) return send(response, 400, "Invalid private voice retry");
    if (voice?.status === "degraded" && typeof voice.retry === "function") {
      try {
        await voice.retry();
      } catch {}
    }
    return redirect(response, "/voice?notice=voice_retry_result");
  }

  private async handleVoiceSpeech(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
  ): Promise<void> {
    const httpTurn = this.privateVoiceTurn(request, token);
    if (httpTurn === undefined || httpTurn.adviceId === undefined) return send(response, 404, "Private voice turn not found");
    const productTurn = await this.productAdviceTurn(httpTurn.adviceId);
    if (productTurn === undefined) return send(response, 404, "Household advice not found");
    if (productTurn.status !== "completed") return send(response, 409, "Household advice is not complete");
    httpTurn.phase = "completed";
    httpTurn.expiresAt = Date.now() + PRIVATE_VOICE_POST_COMPLETION_TTS_LEASE_MS;
    this.schedulePrivateVoiceExpiry();
    const answer = boundedVoiceText(productTurn.answer, MAX_PRIVATE_VOICE_SPEECH_CHARS);
    if (answer === undefined || answer.length === 0) return sendVoiceJson(response, 502, { status: "failed" });
    const cached = this.cachedVoiceSpeech(token, answer);
    if (cached !== undefined) return sendVoiceAudio(response, cached.mimeType, cached.audio);

    let inFlight = this.voiceSpeechInFlight;
    if (inFlight !== undefined && inFlight.turnId !== token) {
      return sendVoiceBackoff(response, 1);
    }
    const retryAfter = inFlight === undefined ? this.reservePrivateVoiceSpeech() : undefined;
    if (retryAfter !== undefined) return sendVoiceBackoff(response, retryAfter);
    inFlight ??= this.startVoiceSpeech(httpTurn.lease, token, answer);
    const waiter = this.trackVoiceSpeechWaiter(request, response, inFlight);
    let browserAudio: VoiceSpeechResult;
    try {
      browserAudio = await inFlight.promise;
    } finally {
      waiter.release();
    }
    if (waiter.disconnected() || response.destroyed || response.writableEnded) return;
    if (browserAudio === "unavailable") return sendVoiceJson(response, 503, { status: "unavailable" });
    if (browserAudio === undefined) return sendVoiceJson(response, 502, { status: "failed" });
    sendVoiceAudio(response, browserAudio.mimeType, browserAudio.audio);
  }

  private cachedVoiceSpeech(token: string, answer: string, now = Date.now()): BrowserVoiceAudio | undefined {
    const cached = this.voiceSpeechCache.get(token);
    if (cached === undefined) return undefined;
    if (cached.answer !== answer || cached.at + PRIVATE_VOICE_SPEECH_CACHE_MS <= now) {
      this.voiceSpeechCache.delete(token);
      return undefined;
    }
    return cached.audio;
  }

  private reservePrivateVoiceSpeech(now = Date.now()): number | undefined {
    while (this.voiceSpeechAttempts[0] !== undefined
      && this.voiceSpeechAttempts[0] <= now - PRIVATE_VOICE_SPEECH_WINDOW_MS) {
      this.voiceSpeechAttempts.shift();
    }
    if (this.voiceSpeechAttempts.length >= MAX_PRIVATE_VOICE_SYNTHESIS_PER_WINDOW) {
      const oldest = this.voiceSpeechAttempts[0] ?? now;
      return Math.max(1, Math.ceil((oldest + PRIVATE_VOICE_SPEECH_WINDOW_MS - now) / 1_000));
    }
    this.voiceSpeechAttempts.push(now);
    return undefined;
  }

  private startVoiceSpeech(voice: PrivateVoiceTurnLease, token: string, answer: string): VoiceSpeechInFlight {
    const controller = new AbortController();
    let inFlight!: VoiceSpeechInFlight;
    const promise = this.synthesizeBrowserVoiceAudio(voice, answer, controller.signal).then((audio) => {
      if (controller.signal.aborted || audio === undefined || audio === "unavailable") return audio;
      this.voiceSpeechCache.set(token, { answer, at: Date.now(), audio });
      while (this.voiceSpeechCache.size > MAX_PRIVATE_VOICE_SPEECH_CACHE_ENTRIES) {
        const oldest = this.voiceSpeechCache.keys().next().value;
        if (typeof oldest !== "string") break;
        this.voiceSpeechCache.delete(oldest);
      }
      return audio;
    }).finally(() => {
      if (this.voiceSpeechInFlight === inFlight) this.voiceSpeechInFlight = undefined;
    });
    inFlight = { turnId: token, promise, controller, activeWaiters: 0 };
    this.voiceSpeechInFlight = inFlight;
    return inFlight;
  }

  private trackVoiceSpeechWaiter(
    request: IncomingMessage,
    response: ServerResponse,
    inFlight: VoiceSpeechInFlight,
  ): { readonly disconnected: () => boolean; readonly release: () => void } {
    let active = true;
    let disconnected = false;
    inFlight.activeWaiters += 1;
    const release = (connectionClosed: boolean) => {
      if (!active) return;
      active = false;
      disconnected ||= connectionClosed;
      request.off("aborted", onDisconnect);
      response.off("close", onDisconnect);
      inFlight.activeWaiters -= 1;
      if (inFlight.activeWaiters === 0 && this.voiceSpeechInFlight === inFlight) {
        this.voiceSpeechInFlight = undefined;
        inFlight.controller.abort();
      }
    };
    const onDisconnect = () => release(true);
    request.once("aborted", onDisconnect);
    response.once("close", onDisconnect);
    if (response.destroyed) onDisconnect();
    return {
      disconnected: () => disconnected,
      release: () => release(false),
    };
  }

  private async synthesizeBrowserVoiceAudio(
    voice: PrivateVoiceTurnLease,
    answer: string,
    signal: AbortSignal,
  ): Promise<VoiceSpeechResult> {
    let synthesis: Awaited<ReturnType<PrivateVoiceTurnLease["synthesize"]>>;
    try {
      synthesis = await voice.synthesize({ text: answer, signal });
    } catch {
      return undefined;
    }
    if (synthesis.status !== "synthesized") {
      return privateVoiceUnavailable(synthesis.reason) ? "unavailable" : undefined;
    }
    if (!isPrivateVoiceOutputMimeType(synthesis.mimeType)
      || !(synthesis.audio instanceof Uint8Array)
      || synthesis.audio.byteLength === 0
      || synthesis.audio.byteLength > MAX_PRIVATE_VOICE_AUDIO_BYTES) {
      return undefined;
    }
    return browserPlayableVoiceAudio(synthesis);
  }

  private async handleAdviceEvents(
    request: IncomingMessage,
    response: ServerResponse,
    adviceId: string,
  ): Promise<void> {
    const readEvents = this.inbox.readAdviceEvents;
    const subscribeAdvice = this.inbox.subscribeAdvice;
    if (readEvents === undefined && subscribeAdvice === undefined) {
      return send(response, 404, "Household advice progress unavailable");
    }

    applySseHeaders(response);
    response.flushHeaders();
    let closed = false;
    let replaying = true;
    let terminal = false;
    let lastSent: string | undefined;
    let highestSentSequence: number | undefined = adviceEventSequence(lastEventId(request.headers["last-event-id"]));
    const queued: Array<{ readonly event: SafeAdviceEvent; readonly bytes: number }> = [];
    const queuedIds = new Set<string>();
    let queuedBytes = 0;
    let flushing = false;
    let transportDrain: Promise<boolean> | undefined;
    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (unsubscribe !== undefined) {
        try { unsubscribe(); } catch { /* adapter cleanup must not affect the client */ }
      } else {
        const remove = this.inbox.unsubscribeAdvice;
        if (remove !== undefined) {
          try { remove.call(this.inbox, adviceId, onAdviceEvent); } catch { /* best effort */ }
        }
      }
      finish();
    };

    const closeStream = () => {
      cleanup();
      if (!response.writableEnded) response.end();
    };

    const waitForDrain = (): Promise<boolean> => {
      if (transportDrain !== undefined) return transportDrain;
      transportDrain = new Promise<boolean>((resolve) => {
        const settle = (writable: boolean) => {
          response.removeListener("drain", onDrain);
          response.removeListener("close", onClose);
          response.removeListener("error", onClose);
          resolve(writable);
        };
        const onDrain = () => settle(true);
        const onClose = () => settle(false);
        response.once("drain", onDrain);
        response.once("close", onClose);
        response.once("error", onClose);
      });
      void transportDrain.finally(() => {
        transportDrain = undefined;
        if (!closed && queued.length > 0) void flushQueued();
      });
      return transportDrain;
    };

    const writeEvent = async (entry: { readonly event: SafeAdviceEvent; readonly bytes: number }): Promise<boolean> => {
      if (closed || response.destroyed || response.writableEnded) {
        cleanup();
        return false;
      }
      if (transportDrain !== undefined && !await transportDrain) return false;
      const eventId = String(entry.event.id);
      if (lastSent !== undefined && eventId === lastSent) return true;
      const sequence = adviceEventSequence(eventId);
      if (sequence !== undefined && highestSentSequence !== undefined && sequence <= highestSentSequence) return true;
      let writable: boolean;
      try {
        writable = response.write(formatSseEvent(entry.event));
      } catch {
        closeStream();
        return false;
      }
      lastSent = eventId;
      if (sequence !== undefined) highestSentSequence = sequence;
      return writable || await waitForDrain();
    };

    const flushQueued = async (): Promise<void> => {
      if (flushing || closed) return;
      flushing = true;
      try {
        while (!closed && queued.length > 0) {
          const entry = queued.shift()!;
          queuedBytes -= entry.bytes;
          queuedIds.delete(String(entry.event.id));
          if (!await writeEvent(entry)) return;
        }
      } finally {
        flushing = false;
        if (!closed && terminal && queued.length === 0) closeStream();
      }
    };

    const enqueue = (raw: AdviceProgressEvent): void => {
      if (closed || terminal) return;
      const event = safeAdviceEvent(raw);
      if (event === undefined) return;
      const eventId = String(event.id);
      const sequence = adviceEventSequence(eventId);
      if (eventId === lastSent || queuedIds.has(eventId)
        || (sequence !== undefined && highestSentSequence !== undefined && sequence <= highestSentSequence)) return;
      const bytes = Buffer.byteLength(formatSseEvent(event), "utf8");
      if (queued.length >= MAX_ADVICE_SSE_QUEUED_EVENTS || queuedBytes + bytes > MAX_ADVICE_SSE_QUEUED_BYTES) {
        closeStream();
        return;
      }
      queued.push({ event, bytes });
      queuedIds.add(eventId);
      queuedBytes += bytes;
      if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") terminal = true;
      if (!replaying) void flushQueued();
    };

    function onAdviceEvent(event: AdviceProgressEvent): void { enqueue(event); }

    try {
      response.once("close", cleanup);
      response.once("error", cleanup);
      request.once("aborted", cleanup);
      const after = lastEventId(request.headers["last-event-id"]);
      if (subscribeAdvice !== undefined) {
        unsubscribe = subscribeAdvice.call(this.inbox, adviceId, onAdviceEvent) ?? undefined;
      }
      const replay = readEvents === undefined ? [] : await readEvents.call(this.inbox, adviceId, after);
      for (const event of replay) enqueue(event);
      replaying = false;
      await flushQueued();
      if (closed) return;
      heartbeat = setInterval(() => {
        if (closed || response.destroyed) {
          cleanup();
          return;
        }
        if (flushing || queued.length > 0 || transportDrain !== undefined) return;
        try {
          if (!response.write(": heartbeat\n\n")) void waitForDrain();
        } catch {
          closeStream();
        }
      }, ADVICE_SSE_HEARTBEAT_MS);
      if (response.destroyed) cleanup();
      await finished;
    } catch {
      closeStream();
    }
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function privateVoiceTurnToken(): string {
  return randomBytes(32).toString("base64url");
}

function isPrivateVoiceTurnToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function applySecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
}

function applySseHeaders(response: ServerResponse): void {
  applySecurityHeaders(response);
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
}

function isMutationMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 303;
  applySecurityHeaders(response);
  response.setHeader("location", location);
  response.end();
}

function setOperationalSessionCookie(response: ServerResponse, token: string, expiresAt: Date): void {
  const expiresAtMs = expiresAt.getTime();
  if (!Number.isFinite(expiresAtMs)) throw new TypeError("Recovered product session expiry is invalid");
  const maxAge = Math.max(1, Math.floor((expiresAtMs - Date.now()) / 1_000));
  response.setHeader("set-cookie", `hob_product_session=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict`);
}

function sessionRecoveryCode(body: string): string | undefined {
  const form = new URLSearchParams(body);
  if ([...form.keys()].length !== 1 || form.getAll("code").length !== 1) return undefined;
  const code = form.get("code")?.normalize("NFKC").toUpperCase();
  return code !== undefined && /^[A-Z2-9]{4,16}(?:-[A-Z2-9]{4,16})?$/u.test(code) ? code : undefined;
}

function renderSessionRecoveryPage(
  state: "ready" | "invalid" | "unavailable" | "limited" | "busy" = "ready",
): string {
  const notice = state === "invalid"
    ? '<p class="product-notice" role="alert">配对码没有对上。请查看这台电脑上的家庭服务提示后再试。</p>'
    : state === "unavailable"
      ? '<p class="product-notice" role="alert">家庭服务暂时没有完成恢复。原来的连接保持不变，请稍后再试。</p>'
      : state === "limited"
        ? '<p class="product-notice" role="alert">尝试次数较多，请稍等片刻再试。</p>'
        : state === "busy"
          ? '<p class="product-notice" role="status">正在检查另一条恢复请求，请稍后再试。</p>'
          : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>恢复家庭控制台</title><link rel="stylesheet" href="/assets/product.css"></head><body><div class="product-shell"><div class="product-content"><main class="product-main" id="product-main"><section class="product-onboarding" aria-labelledby="recovery-heading"><header class="product-page-header"><div><p class="product-kicker">家庭控制台</p><h1 id="recovery-heading">恢复家庭控制台</h1></div></header><section class="product-card"><p class="product-muted">这台设备的连接已失效。请输入这台电脑上显示的一次性配对码。</p>${notice}<form method="post" action="/pair" class="product-onboarding-form"><label class="product-onboarding-field" for="pairing-code"><span>配对码</span><input id="pairing-code" name="code" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="33" required autofocus></label><button class="product-primary-action product-onboarding-submit" type="submit">恢复连接</button></form></section></section></main></div></div></body></html>`;
}

function productRouteForPath(path: string): ProductRoute | undefined {
  if (path === "/home") return "home";
  if (path === "/conversation") return "conversation";
  if (path === "/review-center") return "review-center";
  if (path === "/automations") return "automations";
  if (path === "/activity") return "activity";
  if (path === "/control") return "control";
  if (path === "/settings") return "settings";
  if (path === "/onboarding") return "onboarding";
  return undefined;
}

/**
 * The notice query parameter is a closed set of product codes. The household
 * copy renders server-side; arbitrary query text never reaches the page.
 */
function productNoticeCopy(code: string | null): string | undefined {
  return code === "enable_temporarily_unavailable"
    ? "这次启用暂时没能完成，家里的设置保持原样；稍后再试一次。"
    : undefined;
}

function actionPolicySelectionInput(body: string): {
  readonly directCapabilityIds: readonly string[];
  readonly confirmationCapabilityIds: readonly string[];
  readonly administratorCapabilityIds: readonly string[];
} | undefined {
  let fields: URLSearchParams;
  try {
    fields = new URLSearchParams(body);
  } catch {
    return undefined;
  }
  const direct: string[] = [];
  const confirmation: string[] = [];
  const administrator: string[] = [];
  let total = 0;
  for (const [name, value] of fields) {
    if (!name.startsWith("capability:")) return undefined;
    const id = name.slice("capability:".length);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) return undefined;
    if (value === "direct") direct.push(id);
    else if (value === "confirmation") confirmation.push(id);
    else if (value === "administrator") administrator.push(id);
    else return undefined;
    total += 1;
    if (total > 200) return undefined;
  }
  return { directCapabilityIds: direct, confirmationCapabilityIds: confirmation, administratorCapabilityIds: administrator };
}

function selectedProposalId(value: string | null): string | undefined {
  if (value === null) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : undefined;
}

function selectedActionTicketId(value: string | null): string | undefined {
  if (value === null) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) ? value : undefined;
}

function selectedBatchRequestId(value: string | null): string | undefined {
  if (value === null) return undefined;
  return /^batch-[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) ? value : undefined;
}

function batchCapabilityIds(body: string): readonly string[] | undefined {
  const form = new URLSearchParams(body);
  const keys = [...form.keys()];
  if (keys.length < 1 || keys.some((key) => key !== "capabilityId")) return undefined;
  const values = form.getAll("capabilityId");
  if (values.length < 1 || values.length > 32) return undefined;
  const seen = new Set<string>();
  for (const capabilityId of values) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(capabilityId) || seen.has(capabilityId)) return undefined;
    seen.add(capabilityId);
  }
  return [...seen];
}

function controlErrorStatus(error: unknown): number {
  const code = controlErrorCode(error);
  if (code === "control_unavailable" || code === "control_undo_unavailable") return 503;
  if (code === "not_found") return 404;
  if (code === "unauthorized") return 403;
  return 500;
}

function controlErrorText(error: unknown): string {
  const code = controlErrorCode(error);
  if (code === "control_unavailable") return "Household control is unavailable";
  if (code === "control_undo_unavailable") return "Action undo is unavailable";
  if (code === "not_found") return "Action ticket not found";
  if (code === "unauthorized") return "Household control is unauthorized";
  return "Household control failed";
}

function controlErrorCode(error: unknown): unknown {
  const code = errorCode(error);
  return code ?? (error instanceof Error ? error.message : undefined);
}

function batchControlErrorStatus(error: unknown): number {
  const code = errorCode(error) ?? (error instanceof Error ? error.message : undefined);
  if (code === "batch_control_invalid") return 400;
  if (code === "batch_control_unavailable") return 503;
  return 500;
}

function batchControlErrorText(error: unknown): string {
  const code = errorCode(error) ?? (error instanceof Error ? error.message : undefined);
  if (code === "batch_control_invalid") return "Invalid household batch control";
  if (code === "batch_control_unavailable") return "Household batch control unavailable";
  return "Household batch control failed";
}

function productViewPreference(query: string | null, cookie: string | undefined, fallbackId: string): {
  readonly activeId: string;
  readonly defaultId?: string;
} {
  const queryId = boundedProductViewId(query);
  let sessionId: string | undefined;
  let defaultId: string | undefined;
  for (const part of cookie?.split(";") ?? []) {
    const [name, value] = part.trim().split("=", 2);
    const cookieId = boundedProductViewId(value ?? null);
    if (cookieId === undefined) continue;
    if (name === "hob_view_session") sessionId = cookieId;
    if (name === "hob_view_default") defaultId = cookieId;
  }
  return {
    activeId: queryId ?? sessionId ?? defaultId ?? fallbackId,
    ...(defaultId === undefined ? {} : { defaultId }),
  };
}

function boundedProductViewId(value: string | null): string | undefined {
  if (value === null || value.length === 0 || value.length > 120) return undefined;
  return /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value) ? value : undefined;
}

function productViewDefaultCommand(body: string):
  | { readonly mode: "set"; readonly viewId: string }
  | { readonly mode: "reset" }
  | undefined {
  const form = new URLSearchParams(body);
  const keys = [...form.keys()];
  const mode = form.get("mode");
  if (mode === "reset" && keys.length === 1) return { mode };
  if (mode !== "set" || keys.length !== 2 || !keys.includes("viewId")) return undefined;
  const viewId = boundedProductViewId(form.get("viewId"));
  return viewId === undefined ? undefined : { mode, viewId };
}

function productViewPresentationCommand(body: string):
  | { readonly mode: "set"; readonly providerId: string; readonly key: string; readonly value: string }
  | { readonly mode: "reset"; readonly providerId: string }
  | undefined {
  const form = new URLSearchParams(body);
  const mode = form.get("mode");
  const providerId = boundedProductViewId(form.get("providerId"));
  if (providerId === undefined || form.getAll("mode").length !== 1 || form.getAll("providerId").length !== 1) {
    return undefined;
  }
  if (mode === "reset") {
    return [...form.keys()].length === 2 ? { mode, providerId } : undefined;
  }
  if (mode !== "set" || [...form.keys()].length !== 4) return undefined;
  if (form.getAll("key").length !== 1 || form.getAll("value").length !== 1) return undefined;
  const key = form.get("key");
  const value = form.get("value");
  if (key === null || !/^[a-z][A-Za-z0-9]{0,39}$/.test(key)) return undefined;
  if (value === null || !/^[a-z][a-z0-9_-]{0,39}$/.test(value)) return undefined;
  return { mode, providerId, key, value };
}

function canManageProductViewDefault(principal: InboxReviewActor | undefined): boolean {
  if (principal === undefined || !principal.present) return false;
  if (principal.device.kind === "private") {
    return principal.device.boundPrincipalId === principal.principalId;
  }
  return principal.role === "admin";
}

function canAuthorProductViewRecipe(principal: InboxReviewActor | undefined): principal is InboxReviewActor {
  return principal?.present === true
    && principal.role === "admin"
    && principal.device.kind === "private"
    && principal.device.boundPrincipalId === principal.principalId;
}

/** Any present household member may manage their voice pair from their own bound private device. */
function canConfigurePrivateVoice(principal: InboxReviewActor | undefined): principal is InboxReviewActor {
  return principal?.present === true
    && principal.device.kind === "private"
    && principal.device.boundPrincipalId === principal.principalId;
}

function boundedLayoutDraftId(value: string | null): string | undefined {
  return value !== null && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value) ? value : undefined;
}

function layoutDraftCreateInput(body: string): {
  readonly label: string;
  readonly source: string;
  readonly idempotencyKey: string;
} | undefined {
  const form = new URLSearchParams(body);
  if ([...form.keys()].some((key) => !["label", "source", "idempotencyKey"].includes(key))) return undefined;
  if (form.getAll("label").length !== 1 || form.getAll("source").length !== 1 || form.getAll("idempotencyKey").length !== 1) return undefined;
  const label = boundedLayoutDraftLabel(form.get("label"));
  const source = boundedLayoutDraftSource(form.get("source"));
  const idempotencyKey = boundedLayoutDraftId(form.get("idempotencyKey"));
  return label === undefined || source === undefined || idempotencyKey === undefined
    ? undefined
    : { label, source, idempotencyKey };
}

function layoutDraftUpdateInput(body: string): {
  readonly expectedRevision: number;
  readonly label: string;
  readonly source: string;
} | undefined {
  const form = new URLSearchParams(body);
  if ([...form.keys()].some((key) => !["expectedRevision", "label", "source"].includes(key))) return undefined;
  if (form.getAll("expectedRevision").length !== 1 || form.getAll("label").length !== 1 || form.getAll("source").length !== 1) return undefined;
  const expectedRevision = positiveInteger(form.get("expectedRevision"));
  const label = boundedLayoutDraftLabel(form.get("label"));
  const source = boundedLayoutDraftSource(form.get("source"));
  return expectedRevision === undefined || label === undefined || source === undefined
    ? undefined
    : { expectedRevision, label, source };
}

function layoutDraftDeleteInput(body: string): number | undefined {
  const form = new URLSearchParams(body);
  if ([...form.keys()].some((key) => key !== "expectedRevision") || form.getAll("expectedRevision").length !== 1) return undefined;
  return positiveInteger(form.get("expectedRevision"));
}

function layoutPublicationGenerationInput(body: string): string | undefined {
  const form = new URLSearchParams(body);
  if ([...form.keys()].some((key) => key !== "expectedGenerationId") || form.getAll("expectedGenerationId").length !== 1) return undefined;
  return boundedLayoutDraftId(form.get("expectedGenerationId"));
}

function boundedLayoutDraftLabel(value: string | null): string | undefined {
  return value !== null
    && value.length >= 1
    && value.length <= 80
    && value.trim() === value
    && !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value)
    ? value
    : undefined;
}

function boundedLayoutDraftSource(value: string | null): string | undefined {
  return value !== null && Buffer.byteLength(value, "utf8") <= 65_536 && !value.includes("\u0000")
    ? value
    : undefined;
}

function layoutDraftNoticeForError(error: unknown): LayoutDraftNotice {
  const code = errorCode(error);
  if (code === "invalid_input") return "input";
  if (code === "not_found") return "missing";
  if (code === "revision_conflict") return "revision";
  if (code === "capacity_full") return "capacity";
  if (code === "idempotency_conflict") return "creation";
  return "storage";
}

function boundedLayoutDraftNotice(value: string | null): LayoutDraftNotice | undefined {
  return value === "input" || value === "capacity" || value === "creation" || value === "revision" || value === "missing" || value === "storage"
    || value === "publication_capacity" || value === "publication_conflict" || value === "provider"
    || value === "published" || value === "rolled_back" || value === "deactivated"
    ? value
    : undefined;
}

function layoutPublicationNoticeForError(error: unknown): LayoutDraftNotice {
  const code = errorCode(error);
  if (code === "recipe_invalid" || code === "invalid_input") return "input";
  if (code === "revision_conflict") return "revision";
  if (code === "publication_capacity_full") return "publication_capacity";
  if (code === "publication_conflict") return "publication_conflict";
  if (code === "not_found") return "missing";
  return "storage";
}

function setProductViewSession(response: ServerResponse, viewId: string): void {
  response.setHeader("set-cookie", `hob_view_session=${viewId}; Path=/; HttpOnly; SameSite=Strict`);
}

function setProductViewDefault(response: ServerResponse, viewId: string): void {
  response.setHeader("set-cookie", [
    `hob_view_default=${viewId}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`,
    "hob_view_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict",
  ]);
}

function clearProductViewDefault(response: ServerResponse): void {
  response.setHeader("set-cookie", [
    "hob_view_default=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict",
    "hob_view_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict",
  ]);
}

function productViewPresentation(
  providerId: string,
  declarations: readonly RegisteredProductViewPreference[],
  cookie: string | undefined,
): readonly ProductViewPreferenceState[] {
  const cookieValues = new Map<string, string>();
  for (const part of cookie?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookieValues.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return declarations.map((declaration) => {
    const stored = cookieValues.get(productViewPresentationCookieName(providerId, declaration.key));
    const value = declaration.choices.some((choice) => choice.value === stored)
      ? stored!
      : declaration.defaultValue;
    return {
      key: declaration.key,
      label: declaration.label,
      description: declaration.description,
      value,
      choices: declaration.choices,
    };
  });
}

function productViewPresentationCookieName(providerId: string, key: string): string {
  return `hob_view_pref_${providerId}_${key}`;
}

function setProductViewPresentation(
  response: ServerResponse,
  providerId: string,
  key: string,
  value: string,
): void {
  response.setHeader(
    "set-cookie",
    `${productViewPresentationCookieName(providerId, key)}=${value}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`,
  );
}

function clearProductViewPresentation(
  response: ServerResponse,
  providerId: string,
  declarations: readonly RegisteredProductViewPreference[],
): void {
  response.setHeader(
    "set-cookie",
    declarations.map((declaration) =>
      `${productViewPresentationCookieName(providerId, declaration.key)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`,
    ),
  );
}

function productViewCurrentPath(
  path: string,
  route: ProductRoute,
  proposalId?: string,
  actionTicketId?: string,
  batchRequestId?: string,
): string {
  const parameters = new URLSearchParams();
  if (route === "review-center" && proposalId !== undefined) parameters.set("proposal", proposalId);
  if (route === "control" && actionTicketId !== undefined) parameters.set("action", actionTicketId);
  if (route === "control" && batchRequestId !== undefined) parameters.set("batch", batchRequestId);
  const query = parameters.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

function productViewState(
  currentPath: string,
  activeId: string,
  choices: readonly { readonly id: string; readonly label: string }[],
  defaultId: string | undefined,
  canSetDeviceDefault: boolean,
  preferences: readonly ProductViewPreferenceState[],
  recoveredFrom?: string,
): NonNullable<ProductShellModel["view"]> {
  return {
    activeId,
    ...(defaultId === undefined ? {} : { defaultId }),
    currentPath,
    choices,
    canSetDeviceDefault,
    ...(preferences.length === 0 ? {} : { preferences }),
    ...(recoveredFrom === undefined
      ? {}
      : { recoveryMessage: "这个视图当前不可用，已恢复生活视图。" }),
  };
}

function productHouseholdFromIdentity(
  identity: ProductOnboardingState["household"] | undefined,
  principal: InboxReviewActor | undefined,
): ProductShellModel["household"] {
  return {
    ...(identity?.householdName === undefined ? {} : { name: identity.householdName }),
    ...(identity?.agentName === undefined ? {} : { agentName: identity.agentName }),
    ...(principal === undefined ? {} : { memberName: principal.principalId }),
  };
}

function productShellModel(route: ProductRoute, context: ProductRouteRenderContext): ProductShellModel {
  return {
    ...(context.shellProjection ?? {}),
    household: context.household ?? {},
    ...(context.view === undefined ? {} : { view: context.view }),
    route: defaultProductShellRoute(route),
    runtimeConfirmations: context.reviewProjection?.runtimeConfirmations ?? [],
    runtimeConfirmationCount: context.reviewCounts?.runtimeConfirmations
      ?? context.reviewProjection?.runtimeConfirmations.length
      ?? 0,
    proposals: context.reviewProjection?.proposals ?? [],
    proposalCapacityUsed: context.reviewProjection?.proposalCapacityUsed
      ?? context.reviewCounts?.persistentProposals
      ?? 0,
    proposalCapacity: context.reviewProjection?.proposalCapacity ?? 5,
    ...(context.proposalId === undefined ? {} : { selectedProposalId: context.proposalId }),
    ...(context.reviewProjection?.selectedProposal === undefined
      ? {}
      : { selectedProposal: context.reviewProjection.selectedProposal }),
    ...(context.reviewProjection?.expiredSummary === undefined
      ? {}
      : { expiredSummary: context.reviewProjection.expiredSummary }),
    ...(context.activeTurn === undefined ? {} : { activeTurn: context.activeTurn }),
    ...(context.controlFeedback === undefined ? {} : { controlFeedback: context.controlFeedback }),
    ...(context.proposalNotice === undefined ? {} : { proposalNotice: context.proposalNotice }),
    ...(context.actionPolicy === undefined ? {} : { actionPolicy: context.actionPolicy }),
    ...(context.privateVoice === undefined ? {} : { privateVoice: context.privateVoice }),
    ...(context.onboarding === undefined ? {} : { onboarding: context.onboarding }),
  };
}

function defaultProductShellRoute(route: ProductRoute): ProductShellRoute {
  return route === "home" ? "overview" : route === "review-center" ? "reviews" : route;
}

function redirectAdvice(response: ServerResponse, adviceId: string, basePath = "/conversation"): void {
  if (safeDecode(adviceId) === undefined) {
    send(response, 500, "Household advice request failed");
    return;
  }
  response.statusCode = 303;
  applySecurityHeaders(response);
  response.setHeader("location", `${basePath}/${encodeURIComponent(adviceId)}`);
  response.end();
}

function redirectAdviceAvailability(response: ServerResponse): void {
  response.statusCode = 303;
  applySecurityHeaders(response);
  response.setHeader("location", "/conversation");
  response.end();
}

function normalizeProductReviewCounts(value: unknown): ProductReviewCounts {
  if (!isRecord(value)) return { runtimeConfirmations: 0, persistentProposals: 0 };
  return {
    runtimeConfirmations: boundedCount(value.runtimeConfirmations),
    persistentProposals: boundedCount(value.persistentProposals),
  };
}

function productReviewCountsFromProjection(projection: InboxProductReviewProjection): ProductReviewCounts {
  return {
    runtimeConfirmations: projection.runtimeConfirmations.length,
    persistentProposals: projection.proposalCapacityUsed,
  };
}

function normalizeProductReviewProjection(value: unknown, actor?: InboxReviewActor): InboxProductReviewProjection | undefined {
  if (!isRecord(value)
    || !Array.isArray(value.runtimeConfirmations)
    || !Array.isArray(value.proposals)) return undefined;
  const proposalCapacity = boundedCount(value.proposalCapacity) || 5;
  const proposalCapacityUsed = boundedCount(value.proposalCapacityUsed);
  return {
    runtimeConfirmations: value.runtimeConfirmations.map((item) => isRecord(item)
      ? {
          ...item,
          canApprove: item.canApprove === true,
        }
      : item) as InboxProductReviewProjection["runtimeConfirmations"],
    proposals: value.proposals as InboxProductReviewProjection["proposals"],
    ...(isRecord(value.selectedProposal)
      ? { selectedProposal: value.selectedProposal as unknown as InboxProductReviewProjection["selectedProposal"] }
      : {}),
    proposalCapacityUsed: Math.min(proposalCapacityUsed, proposalCapacity),
    proposalCapacity,
    ...(typeof value.expiredSummary === "string" && value.expiredSummary.length > 0
      ? { expiredSummary: value.expiredSummary.slice(0, 1_000) }
      : {}),
  };
}

function boundedCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function hasRuntimeDecisionPort(value: InboxHttpPort): boolean {
  return typeof value.approveRuntimeConfirmation === "function"
    && typeof value.rejectRuntimeConfirmation === "function";
}

function normalizeReviewActor(value: InboxReviewActor): InboxReviewActor {
  if (!isRecord(value)
    || typeof value.principalId !== "string"
    || value.principalId.trim().length === 0
    || (value.role !== "admin" && value.role !== "adult_member" && value.role !== "member" && value.role !== "child" && value.role !== "guest")
    || typeof value.present !== "boolean"
    || !isRecord(value.device)
    || (value.device.kind !== "private" && value.device.kind !== "shared")) {
    throw new TypeError("Inbox principal must provide principalId, role, presence, and device binding");
  }
  const boundPrincipalId = value.device.boundPrincipalId;
  if (value.device.kind === "private" && (typeof boundPrincipalId !== "string" || boundPrincipalId.trim().length === 0)) {
    throw new TypeError("Private Inbox principal devices require an explicit principal binding");
  }
  return {
    principalId: value.principalId.trim(),
    role: value.role,
    present: value.present,
    device: {
      kind: value.device.kind,
      ...(typeof boundPrincipalId === "string" && boundPrincipalId.trim().length > 0
        ? { boundPrincipalId: boundPrincipalId.trim() }
        : {}),
    },
  };
}

function canUsePresentHouseholdPrincipal(actor: InboxReviewActor): boolean {
  if (actor.present !== true) return false;
  return typeof actor.principalId === "string" && actor.principalId.trim().length > 0;
}

function canUsePrivateProposalReviewPrincipal(actor: InboxReviewActor): boolean {
  // The household shares one trust domain: any present member decides from a
  // private device bound to themselves. Safety lives on the action's
  // consequence class, not on a member rank.
  if (!canUsePresentHouseholdPrincipal(actor) || actor.device.kind !== "private") return false;
  return actor.device.boundPrincipalId === actor.principalId;
}

function runtimeDecisionStatus(value: unknown): "approved" | "rejected" | undefined {
  if (!isRecord(value)) return undefined;
  return value.status === "approved" || value.status === "rejected" ? value.status : undefined;
}

function runtimeDecisionResultStatus(value: unknown): number {
  if (!isRecord(value)) return 500;
  switch (value.reason) {
    case "unauthorized": return 403;
    case "expired":
    case "already_decided": return 409;
    case "unavailable": return 503;
    case "not_found": return 404;
    default: return 500;
  }
}

function runtimeDecisionResultText(value: unknown): string {
  if (!isRecord(value)) return "Runtime confirmation decision failed";
  switch (value.reason) {
    case "unauthorized": return "Runtime confirmation decision is unauthorized";
    case "expired": return "Runtime confirmation has expired and was not executed";
    case "already_decided": return "Runtime confirmation has already been decided";
    case "unavailable": return "Household action execution is unavailable";
    case "not_found": return "Runtime confirmation not found";
    default: return "Runtime confirmation decision failed";
  }
}

function runtimeDecisionErrorStatus(error: unknown): number {
  const code = errorCode(error);
  return code === "unauthorized" ? 403 : code === "expired" || code === "already_decided" ? 409 : code === "not_found" ? 404 : code === "unavailable" ? 503 : 500;
}

function runtimeDecisionErrorText(error: unknown): string {
  const code = errorCode(error);
  return code === "unauthorized"
    ? "Runtime confirmation decision is unauthorized"
    : code === "expired"
      ? "Runtime confirmation has expired and was not executed"
      : code === "already_decided"
        ? "Runtime confirmation has already been decided"
        : code === "unavailable"
          ? "Household action execution is unavailable"
        : code === "not_found"
          ? "Runtime confirmation not found"
          : "Runtime confirmation decision failed";
}

function proposalMutationErrorStatus(error: unknown): number {
  const code = errorCode(error);
  return code === "unauthorized" ? 403 : code === "not_found" || code === "proposal_snooze_unavailable" || code === "proposal_reject_unavailable" || code === "proposal_latch_unavailable" || code === "proposal_enable_unavailable"
    ? 404
    : code === "enable_temporarily_unavailable"
      ? 503
      : code === "revision_conflict" || code === "terminal_status" || code === "conflict" || code === "trial_not_complete" || code === "rollout_state_invalid" ? 409 : 500;
}

function proposalMutationErrorText(error: unknown): string {
  const code = errorCode(error);
  return code === "unauthorized"
    ? "Proposal decision is unauthorized"
    : code === "not_found"
      ? "Proposal not found"
      : code === "revision_conflict" || code === "terminal_status" || code === "conflict" || code === "trial_not_complete" || code === "rollout_state_invalid"
        ? "Proposal decision conflict"
        : code === "proposal_snooze_unavailable"
          ? "Proposal snooze unavailable"
          : code === "proposal_reject_unavailable"
            ? "Proposal rejection unavailable"
            : code === "proposal_latch_unavailable"
              ? "Proposal latch unavailable"
              : code === "proposal_enable_unavailable"
                ? "Proposal enablement unavailable"
              : "Proposal mutation failed";
}

function productDocument(content: string, current: ProductRoute): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f7f5f0"><title>${productRouteTitle(current)} · 家庭助手</title><link rel="stylesheet" href="/assets/product.css"></head><body>${content}<script src="/assets/product.js" defer></script></body></html>`;
}

function productRouteTitle(route: ProductRoute): string {
  switch (route) {
    case "home": return "总览";
    case "conversation": return "对话";
    case "review-center": return "处理中心";
    case "automations": return "自动化";
    case "activity": return "活动";
    case "control": return "控制";
    case "settings": return "设置";
    case "onboarding": return "首次设置";
  }
}

function streamsAdviceTurn(turn: ProductTurn): boolean {
  return turn.status === "accepted"
    || turn.status === "inspecting"
    || turn.status === "streaming"
    || turn.status === "background";
}

function escapeTransportHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeAdviceAvailability(value: unknown): AdviceAvailability {
  if (!isRecord(value)) return { status: "unavailable" };
  const rawStatus = typeof value.status === "string" ? value.status : value.state;
  const status = isAdviceAvailabilityStatus(rawStatus) ? rawStatus : "unavailable";
  const activeAdviceId = typeof value.activeAdviceId === "string" && safeDecode(value.activeAdviceId) !== undefined
    ? value.activeAdviceId
    : undefined;
  return activeAdviceId === undefined ? { status } : { status, activeAdviceId };
}

function normalizeAdviceStart(value: unknown): AdviceStartResult {
  if (!isRecord(value)) throw new Error("advice_start_invalid");
  const status = value.status === "active_request" || value.status === "already_active" || value.status === "accepted"
    ? value.status
    : undefined;
  const activeAdviceId = typeof value.activeAdviceId === "string" && safeDecode(value.activeAdviceId) !== undefined
    ? value.activeAdviceId
    : undefined;
  const id = typeof value.id === "string" ? value.id : activeAdviceId;
  if (id === undefined) throw new Error("advice_start_invalid");
  return status === undefined && activeAdviceId === undefined
    ? { id }
    : { id, ...(status === undefined ? {} : { status }), ...(activeAdviceId === undefined ? {} : { activeAdviceId }) };
}

function isAdviceAvailabilityStatus(value: unknown): value is AdviceAvailabilityStatus {
  return value === "ready" || value === "active_request" || value === "setup_required"
    || value === "home_connecting" || value === "agent_busy" || value === "model_unavailable"
    || value === "stopped" || value === "unavailable";
}

function adviceCancelStatus(value: unknown): "cancelled" | "not_found" | "terminal_status" | undefined {
  if (value === true) return "cancelled";
  if (value === false) return "terminal_status";
  if (!isRecord(value) || typeof value.status !== "string") return undefined;
  return value.status === "cancelled" || value.status === "not_found" || value.status === "terminal_status"
    ? value.status
    : undefined;
}

function adviceBackgroundStatus(
  value: unknown,
): "background" | "not_found" | "terminal_status" | "unavailable" | undefined {
  if (!isRecord(value) || typeof value.status !== "string") return undefined;
  return value.status === "background" || value.status === "not_found"
    || value.status === "terminal_status" || value.status === "unavailable"
    ? value.status
    : undefined;
}

function adviceRetryStatus(value: unknown): "not_found" | "terminal_status" | "unavailable" | undefined {
  if (!isRecord(value) || typeof value.status !== "string") return undefined;
  return value.status === "not_found" || value.status === "terminal_status" || value.status === "unavailable"
    ? value.status
    : undefined;
}

function adviceActiveId(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const value = error.activeAdviceId;
  return typeof value === "string" && safeDecode(value) !== undefined ? value : undefined;
}

type SafeAdviceEvent = {
  readonly id: string | number;
  readonly type: AdviceProgressEventType;
  readonly data: Record<string, string>;
};

function safeAdviceEvent(value: AdviceProgressEvent): SafeAdviceEvent | undefined {
  if (!isRecord(value)) return undefined;
  const id = safeEventId(value.id);
  if (id === undefined) return undefined;
  const data = isRecord(value.data) ? value.data : {};
  const rawType = typeof value.type === "string" ? value.type : undefined;
  if (rawType === "progress") {
    const stage = safeProgressStage(data.phase ?? data.stage);
    return stage === undefined
      ? { id, type: "progress", data: {} }
      : { id, type: "progress", data: { stage } };
  }
  if (rawType === "accepted" || rawType === "inspecting_home" || rawType === "reading_inventory"
    || rawType === "checking_rules" || rawType === "evaluating_evidence" || rawType === "composing_answer") {
    return { id, type: rawType, data: {} };
  }
  if (rawType === "delta" || rawType === "answer_delta" || rawType === "answer") {
    const rawText = typeof data.text === "string" ? data.text : value.text;
    const text = boundedEventText(rawText);
    return text === undefined ? undefined : { id, type: rawType, data: { text } };
  }
  if (rawType === "completed") return { id, type: rawType, data: {} };
  if (rawType === "failed") return { id, type: rawType, data: { reason: "advice_failed" } };
  if (rawType === "cancelled") return { id, type: rawType, data: {} };
  return undefined;
}

function safeProgressStage(value: unknown): string | undefined {
  return value === "inspecting_home" || value === "reading_inventory"
    || value === "checking_rules" || value === "evaluating_evidence"
    || value === "composing_answer" ? value : undefined;
}

function safeEventId(value: unknown): string | number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ADVICE_EVENT_ID) return undefined;
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined;
}

function boundedEventText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, MAX_ADVICE_EVENT_TEXT);
  return text.length === 0 ? undefined : text;
}

function formatSseEvent(event: SafeAdviceEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function lastEventId(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return undefined;
  if (value === undefined || value.length === 0 || value.length > MAX_ADVICE_EVENT_ID) return undefined;
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined;
}

function adviceEventSequence(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function send(response: ServerResponse, status: number, text: string): void {
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(text);
}

function sendHtml(response: ServerResponse, status: number, html: string, head: boolean): void {
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(head ? undefined : html);
}

function sendCss(response: ServerResponse, status: number, css: string, head: boolean): void {
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "text/css; charset=utf-8");
  response.end(head ? undefined : css);
}

function sendJavaScript(response: ServerResponse, status: number, script: string, head: boolean): void {
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "text/javascript; charset=utf-8");
  response.end(head ? undefined : script);
}

function sendPrivateVoiceConfigurationStatusJson(
  response: ServerResponse,
  body:
    | { readonly status: "idle" }
    | { readonly status: "pending"; readonly configurationId: string }
    | { readonly status: "completed"; readonly configurationId: string; readonly receipt: string },
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
  body: { readonly status: "accepted"; readonly adviceId: string; readonly transcript: string }
    | { readonly status: "active"; readonly adviceId: string }
    | { readonly status: "leased"; readonly voiceTurnId: string; readonly captureMode: PrivateVoiceCaptureMode }
    | { readonly status: "no_input" | "unavailable" | "failed" },
): void {
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function sendVoiceBackoff(response: ServerResponse, retryAfterSeconds: number): void {
  response.setHeader("retry-after", String(retryAfterSeconds));
  sendVoiceJson(response, 429, { status: "unavailable" });
}

function sendVoiceAudio(response: ServerResponse, mimeType: string, audio: Uint8Array): void {
  applySecurityHeaders(response);
  response.statusCode = 200;
  response.setHeader("content-type", mimeType);
  response.setHeader("content-length", String(audio.byteLength));
  response.end(audio);
}

function mediaType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}

const NO_PRIVATE_VOICE_FORMAT = Symbol("no-private-voice-format");
const PRIVATE_VOICE_ENCODED_MIME_TYPES = new Set(["audio/wav", "audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg", "audio/flac"]);
const PRIVATE_VOICE_PCM_MIME_TYPE = "audio/l16";
const PRIVATE_VOICE_PCM_RATES = new Set([8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000]);
const PRIVATE_VOICE_PCM_CHANNELS = new Set([1, 2]);
const PRIVATE_VOICE_BROWSER_OUTPUT_MIME_TYPES = new Set(["audio/wav", "audio/mpeg", "audio/mp4"]);

function privateVoiceInputFormat(
  captureMode: PrivateVoiceCaptureMode,
  mimeType: string | undefined,
  headers: Readonly<Record<string, string | string[] | undefined>>,
): PrivateVoiceAudioFormat | typeof NO_PRIVATE_VOICE_FORMAT | undefined {
  const rate = exactHeader(headers, "x-audio-rate");
  const width = exactHeader(headers, "x-audio-width");
  const channels = exactHeader(headers, "x-audio-channels");
  if (captureMode === "encoded_audio") {
    return mimeType !== undefined && PRIVATE_VOICE_ENCODED_MIME_TYPES.has(mimeType)
      && rate === undefined && width === undefined && channels === undefined
      ? NO_PRIVATE_VOICE_FORMAT
      : undefined;
  }
  if (mimeType !== PRIVATE_VOICE_PCM_MIME_TYPE || rate === undefined || width !== "2" || channels === undefined) return undefined;
  const parsedRate = boundedPcmHeader(rate, PRIVATE_VOICE_PCM_RATES);
  const parsedChannels = boundedPcmHeader(channels, PRIVATE_VOICE_PCM_CHANNELS);
  return parsedRate === undefined || parsedChannels === undefined
    ? undefined
    : { rate: parsedRate, width: 2, channels: parsedChannels };
}

function exactHeader(headers: Readonly<Record<string, string | string[] | undefined>>, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" && value.length > 0 && value.length <= 16 ? value : undefined;
}

function boundedPcmHeader(value: string, allowed: ReadonlySet<number>): number | undefined {
  if (!/^[1-9]\d{0,5}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && allowed.has(parsed) ? parsed : undefined;
}

function isPrivateVoiceMimeType(mimeType: string): boolean {
  return PRIVATE_VOICE_ENCODED_MIME_TYPES.has(mimeType) || mimeType === PRIVATE_VOICE_PCM_MIME_TYPE;
}

function isPrivateVoiceOutputMimeType(mimeType: unknown): mimeType is string {
  return typeof mimeType === "string"
    && (mimeType === PRIVATE_VOICE_PCM_MIME_TYPE || PRIVATE_VOICE_BROWSER_OUTPUT_MIME_TYPES.has(mimeType));
}

function browserPlayableVoiceAudio(
  synthesis: Extract<Awaited<ReturnType<PrivateVoiceTurnLease["synthesize"]>>, { readonly status: "synthesized" }>,
): BrowserVoiceAudio | undefined {
  if (synthesis.mimeType !== PRIVATE_VOICE_PCM_MIME_TYPE) {
    return { mimeType: synthesis.mimeType, audio: synthesis.audio };
  }
  const format = synthesis.format;
  if (format === undefined
    || format.width !== 2
    || !PRIVATE_VOICE_PCM_RATES.has(format.rate)
    || !PRIVATE_VOICE_PCM_CHANNELS.has(format.channels)
    || synthesis.audio.byteLength % (format.width * format.channels) !== 0) {
    return undefined;
  }
  return {
    mimeType: "audio/wav",
    audio: pcmS16LeWav(synthesis.audio, format.rate, format.channels),
  };
}

function pcmS16LeWav(pcm: Uint8Array, rate: number, channels: number): Uint8Array {
  const headerBytes = 44;
  const wav = new Uint8Array(headerBytes + pcm.byteLength);
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
  wav.set(pcm, headerBytes);
  return wav;
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    target[offset + index] = value.charCodeAt(index);
  }
}

function boundedVoiceText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(text) ? text : undefined;
}

function privateVoiceUnavailable(reason: unknown): boolean {
  return reason === "unavailable" || reason === "disabled" || reason === "degraded" || reason === "endpoint_unreachable";
}

function abortOnDisconnect(request: IncomingMessage, response: ServerResponse): { readonly signal: AbortSignal; cleanup(): void } {
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

function safeDecode(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 200 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function adviceQuestion(body: string): string | undefined {
  const params = new URLSearchParams(body);
  if ([...params.keys()].some((key) => key !== "question") || params.getAll("question").length !== 1) return undefined;
  const question = params.get("question")?.trim();
  return question !== undefined && question.length >= 1 && question.length <= 1_000 ? question : undefined;
}

function correctionInput(body: string): {
  readonly correctionType: InboxConversationCorrectionType;
  readonly correction: string;
  readonly idempotencyKey: string;
} | undefined {
  const form = new URLSearchParams(body);
  const allowed = new Set(["correctionType", "correction", "idempotencyKey"]);
  if ([...form.keys()].some((key) => !allowed.has(key))) return undefined;
  if (form.getAll("correctionType").length !== 1
    || form.getAll("correction").length !== 1
    || form.getAll("idempotencyKey").length !== 1) return undefined;
  const correctionType = form.get("correctionType");
  const correction = form.get("correction")?.trim();
  const idempotencyKey = form.get("idempotencyKey")?.trim();
  if (!isCorrectionType(correctionType)
    || correction === undefined || correction.length < 1 || correction.length > 2_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(correction)
    || idempotencyKey === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(idempotencyKey)) return undefined;
  return { correctionType, correction, idempotencyKey };
}

function isCorrectionType(value: unknown): value is InboxConversationCorrectionType {
  return value === "household_fact" || value === "household_preference" || value === "future_behavior";
}

function canUsePrivateCorrectionPrincipal(actor: InboxReviewActor): boolean {
  return actor.present === true
    && actor.device.kind === "private"
    && actor.device.boundPrincipalId === actor.principalId;
}

function correctionErrorStatus(error: unknown): number {
  switch (errorCode(error)) {
    case "invalid_input":
    case "invalid_type": return 400;
    case "not_found": return 404;
    case "not_completed":
    case "conflict": return 409;
    case "permission_denied": return 403;
    case "workspace_unavailable":
    case "proposal_unavailable": return 503;
    case "persistence_failed": return 500;
    default: return 500;
  }
}

function correctionErrorText(error: unknown): string {
  switch (errorCode(error)) {
    case "invalid_input":
    case "invalid_type": return "请选择一种纠正类型并填写说明";
    case "not_found": return "Household advice not found";
    case "not_completed": return "Household correction requires a completed conversation";
    case "conflict": return "Household correction idempotency conflict";
    case "permission_denied": return "Household correction is unauthorized";
    case "workspace_unavailable": return "Household knowledge workspace is unavailable";
    case "proposal_unavailable": return "Household proposal is unavailable; no behavior changed";
    case "persistence_failed": return "Household correction was not saved";
    default: return "Household correction failed";
  }
}

function onboardingContinueInput(body: string): OnboardingCommand | undefined {
  const form = new URLSearchParams(body);
  if (form.getAll("step").length > 1) return undefined;
  if (form.getAll("step").length === 0) return undefined;
  const raw = form.get("step");
  if (raw === null || !/^[1-8]$/.test(raw)) return undefined;
  const step = Number(raw);
  const fieldsByName: Record<string, readonly string[]> = {};
  for (const key of new Set(form.keys())) {
    if (key === "step") continue;
    if (!onboardingFieldAllowed(step, key)) return undefined;
    const rawValues = form.getAll(key);
    const multi = ONBOARDING_MULTI_FIELDS.has(key);
    if ((!multi && rawValues.length !== 1) || (multi && rawValues.length < 1)) return undefined;
    if (rawValues.some((value) => onboardingFieldValue(key, value) === undefined)) return undefined;
    const present = rawValues.map((value) => value.trim()).filter((value) => value.length > 0);
    if (present.length === 0 && !ONBOARDING_OPTIONAL_FIELDS.has(key)) return undefined;
    if (new Set(present).size !== present.length) return undefined;
    fieldsByName[key] = present;
  }
  const one = (name: string): string | undefined => fieldsByName[name]?.[0];
  switch (step) {
    case 1: {
      const agentName = one("agentName");
      const householdName = one("householdName");
      return agentName === undefined || householdName === undefined ? undefined : { step: 1, kind: "name_household", agentName, householdName };
    }
    case 2: {
      const bridgeId = one("bridgeId");
      return bridgeId === undefined || one("bridgeMode") !== "read_only" ? undefined : { step: 2, kind: "preflight_bridge", bridgeId };
    }
    case 3:
      return one("mapConfirmed") !== "confirmed" ? undefined : { step: 3, kind: "confirm_map", confirmed: true, ...(one("mapCorrection") === undefined ? {} : { correction: one("mapCorrection") }) };
    case 4: {
      const memberName = one("memberName");
      // The binding has exactly one shape, so the server supplies the
      // compatibility command value instead of asking the household to pick it.
      return memberName === undefined ? undefined : { step: 4, kind: "bind_private_device", memberName, role: "adult_admin" };
    }
    case 5: {
      const selections = Object.entries(fieldsByName)
        .filter(([name]) => name.startsWith("capability:"))
        .map(([name, values]) => ({ id: name.slice("capability:".length), policy: values[0] }));
      if (selections.length === 0 || selections.some((selection) => selection.policy === undefined)) return undefined;
      return {
        step: 5,
        kind: "set_action_policy",
        directCapabilityIds: selections.filter((selection) => selection.policy === "direct").map((selection) => selection.id),
        confirmationCapabilityIds: selections.filter((selection) => selection.policy === "confirmation").map((selection) => selection.id),
        administratorCapabilityIds: selections.filter((selection) => selection.policy === "administrator").map((selection) => selection.id),
      };
    }
    case 6:
      return one("safetyAcknowledged") !== "understood" ? undefined : { step: 6, kind: "acknowledge_safety_rules", acknowledged: true };
    case 7: {
      const interval = one("observationInterval");
      const quietHoursStart = one("quietHoursStart");
      const quietHoursEnd = one("quietHoursEnd");
      if (one("observationEnabled") !== "enabled" || interval === undefined || !/^\d+$/.test(interval)) return undefined;
      const intervalMinutes = Number(interval);
      if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 60 || intervalMinutes > 10_080) return undefined;
      if ((quietHoursStart === undefined) !== (quietHoursEnd === undefined)) return undefined;
      return {
        step: 7,
        kind: "set_observation_schedule",
        enabled: true,
        intervalMinutes,
        ...(quietHoursStart === undefined || quietHoursEnd === undefined ? {} : { quietHours: { start: quietHoursStart, end: quietHoursEnd } }),
      };
    }
    case 8: {
      const question = one("firstQuestion");
      return question === undefined ? undefined : { step: 8, kind: "ask_first_question", question };
    }
  }
}

const ONBOARDING_FIELDS_BY_STEP: Readonly<Record<number, readonly string[]>> = {
  1: ["agentName", "householdName"],
  2: ["bridgeId", "bridgeMode"],
  3: ["mapConfirmed", "mapCorrection"],
  4: ["memberName"],
  5: [],
  6: ["safetyAcknowledged"],
  7: ["observationEnabled", "observationInterval", "quietHoursStart", "quietHoursEnd"],
  8: ["firstQuestion"],
};

const ONBOARDING_MULTI_FIELDS = new Set([
  "mapConfirmed",
  "safetyAcknowledged",
]);

const ONBOARDING_OPTIONAL_FIELDS = new Set([
  "householdName",
  "mapCorrection",
  "memberName",
  "quietHoursStart",
  "quietHoursEnd",
]);

const ONBOARDING_FIELD_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  bridgeMode: ["read_only"],
  mapConfirmed: ["confirmed"],
  safetyAcknowledged: ["understood"],
  observationEnabled: ["enabled"],
};

function onboardingFieldAllowed(step: number, name: string): boolean {
  if (ONBOARDING_FIELDS_BY_STEP[step]?.includes(name) === true) return true;
  return step === 5 && /^capability:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(name);
}

function onboardingFieldValue(name: string, raw: string): string | null | undefined {
  const value = raw.trim();
  const maximum = name === "firstQuestion" || name === "mapCorrection" ? 2_000 : 200;
  if (value.length === 0) return ONBOARDING_OPTIONAL_FIELDS.has(name) ? null : undefined;
  if (value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  if (name === "bridgeId" || name.startsWith("capability:")) {
    if (name.startsWith("capability:") && !/^capability:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(name)) return undefined;
    if (name.startsWith("capability:") && !["direct", "confirmation", "administrator"].includes(value)) return undefined;
    return name === "bridgeId" && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) ? undefined : value;
  }
  if (name === "observationInterval" && (!/^\d+$/.test(value) || Number(value) < 60 || Number(value) > 10_080)) return undefined;
  if ((name === "quietHoursStart" || name === "quietHoursEnd") && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return undefined;
  const allowed = ONBOARDING_FIELD_OPTIONS[name];
  return allowed !== undefined && !allowed.includes(value) ? undefined : value;
}

function resultState(value: unknown): unknown {
  return isRecord(value) && "state" in value ? value.state : value;
}

function onboardingAdviceId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.adviceId !== "string" || safeDecode(value.adviceId) === undefined) return undefined;
  return value.adviceId;
}

function normalizeOnboardingState(value: unknown): ProductOnboardingState | undefined {
  const step = isRecord(value) ? value.step : undefined;
  if (!isRecord(value)
    || typeof step !== "number"
    || !Number.isSafeInteger(step)
    || step < 1
    || step > 8
    || typeof value.complete !== "boolean"
    || typeof value.title !== "string"
    || typeof value.body !== "string") return undefined;
  const title = value.title.trim();
  const body = value.body.trim();
  const status = value.status === undefined ? undefined : value.status;
  if (status !== undefined && status !== "ready" && status !== "blocked" && status !== "complete") return undefined;
  const blockedReason = value.blockedReason;
  if (blockedReason !== undefined && (typeof blockedReason !== "string" || blockedReason.trim() !== blockedReason || blockedReason.length === 0 || blockedReason.length > 2_000)) return undefined;
  if (title.length === 0 || title.length > 200 || body.length === 0 || body.length > 2_000) return undefined;
  const household = value.household === undefined ? undefined : normalizeOnboardingIdentity(value.household);
  if (value.household !== undefined && household === undefined) return undefined;
  const choices = value.choices === undefined ? undefined : normalizeOnboardingChoices(value.choices);
  return {
    step,
    complete: value.complete,
    ...(status === undefined ? {} : { status }),
    ...(blockedReason === undefined ? {} : { blockedReason }),
    title,
    body,
    ...(household === undefined ? {} : { household }),
    ...(choices === undefined ? {} : { choices }),
  };
}

function normalizeOnboardingIdentity(value: unknown): ProductOnboardingState["household"] | undefined {
  if (!isRecord(value) || !boundedOnboardingText(value.householdName, 200) || !boundedOnboardingText(value.agentName, 200)) return undefined;
  return { householdName: value.householdName, agentName: value.agentName };
}

function normalizeOnboardingChoices(value: unknown): ProductOnboardingChoices {
  if (!isRecord(value) || (value.status !== "available" && value.status !== "unavailable")
    || !Array.isArray(value.bridges) || !Array.isArray(value.capabilities)
    || value.bridges.length > 128 || value.capabilities.length > 512) {
    return { status: "unavailable", reason: "invalid_projection", bridges: [], capabilities: [] };
  }
  const bridges: ProductOnboardingBridgeChoice[] = [];
  const bridgeIds = new Set<string>();
  for (const candidate of value.bridges) {
    if (!isRecord(candidate)
      || !boundedOnboardingId(candidate.id)
      || bridgeIds.has(candidate.id)
      || !boundedOnboardingText(candidate.label, 200)
      || typeof candidate.selectable !== "boolean"
      || (candidate.description !== undefined && !boundedOnboardingText(candidate.description, 500))) {
      return { status: "unavailable", reason: "invalid_projection", bridges: [], capabilities: [] };
    }
    bridgeIds.add(candidate.id);
    bridges.push({
      id: candidate.id,
      label: candidate.label,
      selectable: candidate.selectable,
      ...(candidate.description === undefined ? {} : { description: candidate.description }),
    });
  }
  const capabilities: ProductOnboardingCapabilityChoice[] = [];
  const capabilityIds = new Set<string>();
  for (const candidate of value.capabilities) {
    if (!isRecord(candidate)
      || !boundedOnboardingId(candidate.id)
      || capabilityIds.has(candidate.id)
      || !boundedOnboardingText(candidate.label, 300)
      || !boundedOnboardingId(candidate.bridgeId)
      || !bridgeIds.has(candidate.bridgeId)
      || !boundedOnboardingText(candidate.bridgeLabel, 200)
      || !isOnboardingPolicySuggestion(candidate.suggestedPolicyClass)
      || (candidate.schema !== undefined && !boundedOnboardingText(candidate.schema, 200))) {
      return { status: "unavailable", reason: "invalid_projection", bridges: [], capabilities: [] };
    }
    capabilityIds.add(candidate.id);
    capabilities.push({
      id: candidate.id,
      label: candidate.label,
      bridgeId: candidate.bridgeId,
      bridgeLabel: candidate.bridgeLabel,
      suggestedPolicyClass: candidate.suggestedPolicyClass,
      ...(candidate.schema === undefined ? {} : { schema: candidate.schema }),
    });
  }
  if (value.status === "unavailable") return { status: "unavailable", reason: boundedOnboardingText(value.reason, 100) ? value.reason : "world_unavailable", bridges: [], capabilities: [] };
  return {
    status: "available",
    bridges,
    capabilities,
  };
}

function boundedOnboardingText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function boundedOnboardingId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function isOnboardingPolicySuggestion(value: unknown): value is "direct" | "confirmation" | "administrator" {
  return value === "direct" || value === "confirmation" || value === "administrator";
}

function onboardingErrorStatus(error: unknown): number {
  switch (errorCode(error)) {
    case "invalid_input":
    case "invalid_step": return 400;
    case "stale_step":
    case "already_complete": return 409;
    case "permission_denied": return 403;
    case "unavailable": return 503;
    case "onboarding_unavailable": return 503;
    default: return 500;
  }
}

function onboardingErrorText(error: unknown): string {
  switch (errorCode(error)) {
    case "invalid_input":
    case "invalid_step": return "Invalid onboarding continuation";
    case "stale_step": return "Onboarding step is no longer current";
    case "already_complete": return "Onboarding is already complete";
    case "permission_denied": return "This onboarding step requires a present member on their own bound private phone";
    case "unavailable": return "家庭设置正在准备，连接完成后从这里继续。";
    case "onboarding_unavailable": return "家庭设置正在准备，连接完成后从这里继续。";
    default: return "Onboarding continuation failed";
  }
}

function preparationRetryInput(
  proposalId: string,
  body: string,
): { proposalId: string; expectedRevision: number; expectedVersion: number } | undefined {
  const params = new URLSearchParams(body);
  if ([...params.keys()].some((key) => !["expectedRevision", "expectedVersion"].includes(key))
    || params.getAll("expectedRevision").length !== 1
    || params.getAll("expectedVersion").length !== 1) return undefined;
  const expectedRevision = positiveInteger(params.get("expectedRevision"));
  const expectedVersion = positiveInteger(params.get("expectedVersion"));
  return expectedRevision === undefined || expectedVersion === undefined
    ? undefined
    : { proposalId, expectedRevision, expectedVersion };
}

function proposalSnoozeInput(body: string): { readonly until: ProposalInboxSnoozeTarget | "later"; readonly expectedRevision?: number } | undefined {
  const form = new URLSearchParams(body);
  if (form.getAll("until").length !== 1
    || [...form.keys()].some((key) => key !== "until" && key !== "expectedRevision")) return undefined;
  const until = form.get("until");
  if (until !== "later" && until !== "tomorrow" && until !== "weekend" && until !== "next_week") return undefined;
  const revisionRaw = form.get("expectedRevision");
  if (revisionRaw === null) return { until };
  const expectedRevision = Number.parseInt(revisionRaw, 10);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return undefined;
  return { until, expectedRevision };
}

function proposalDecisionInput(body: string): number | undefined {
  const form = new URLSearchParams(body);
  if (form.getAll("expectedRevision").length !== 1 || [...form.keys()].some((key) => key !== "expectedRevision")) return undefined;
  return positiveInteger(form.get("expectedRevision"));
}

function operationalPrivateVoiceConfigureInput(body: string): Omit<OperationalPrivateVoiceConfigureInput, "signal"> | undefined {
  const form = new URLSearchParams(body);
  const keys = [
    "expectedGeneration", "asrTransport", "asrEndpoint", "asrModel", "asrCredential",
    "ttsTransport", "ttsEndpoint", "ttsModel", "ttsLocale", "ttsVoice", "ttsCredential",
  ];
  if ([...form.keys()].some((key) => !keys.includes(key)) || keys.some((key) => form.getAll(key).length !== 1)) return undefined;
  const expectedGeneration = positiveInteger(form.get("expectedGeneration"));
  const asrTransport = operationalPrivateVoiceTransport(form.get("asrTransport"));
  const ttsTransport = operationalPrivateVoiceTransport(form.get("ttsTransport"));
  const asrEndpoint = operationalPrivateVoiceEndpoint(form.get("asrEndpoint"));
  const ttsEndpoint = operationalPrivateVoiceEndpoint(form.get("ttsEndpoint"));
  const ttsLocale = operationalPrivateVoiceRequiredText(form.get("ttsLocale"), 64);
  const asrModel = operationalPrivateVoiceText(form.get("asrModel"), 256, true);
  const ttsModel = operationalPrivateVoiceText(form.get("ttsModel"), 256, true);
  const ttsVoice = operationalPrivateVoiceText(form.get("ttsVoice"), 256, true);
  const asrCredential = operationalPrivateVoiceCredential(form.get("asrCredential"));
  const ttsCredential = operationalPrivateVoiceCredential(form.get("ttsCredential"));
  if (expectedGeneration === undefined || asrTransport === undefined || ttsTransport === undefined
    || asrEndpoint === undefined || ttsEndpoint === undefined || ttsLocale === undefined
    || asrModel === null || ttsModel === null || ttsVoice === null || asrCredential === null || ttsCredential === null) return undefined;
  return {
    expectedGeneration,
    asr: { kind: "asr", transport: asrTransport, endpoint: asrEndpoint, ...(asrModel === undefined ? {} : { model: asrModel }), ...(asrCredential === undefined ? {} : { credential: asrCredential }) },
    tts: { kind: "tts", transport: ttsTransport, endpoint: ttsEndpoint, locale: ttsLocale, ...(ttsModel === undefined ? {} : { model: ttsModel }), ...(ttsVoice === undefined ? {} : { voice: ttsVoice }), ...(ttsCredential === undefined ? {} : { credential: ttsCredential }) },
  };
}

function operationalPrivateVoiceDisableInput(body: string): { readonly expectedGeneration: number } | undefined {
  const form = new URLSearchParams(body);
  if ([...form.keys()].some((key) => key !== "expectedGeneration" && key !== "confirmDisable")
    || form.getAll("expectedGeneration").length !== 1 || form.getAll("confirmDisable").length !== 1
    || form.get("confirmDisable") !== "confirmed") return undefined;
  const expectedGeneration = positiveInteger(form.get("expectedGeneration"));
  return expectedGeneration === undefined ? undefined : { expectedGeneration };
}

function operationalPrivateVoiceRetryInput(body: string): number | undefined {
  const form = new URLSearchParams(body);
  if ([...form.keys()].some((key) => key !== "expectedGeneration") || form.getAll("expectedGeneration").length !== 1) return undefined;
  return positiveInteger(form.get("expectedGeneration"));
}

function operationalPrivateVoiceCancelConfigureInput(body: string): string | undefined {
  const form = new URLSearchParams(body);
  if ([...form.keys()].some((key) => key !== "configurationId") || form.getAll("configurationId").length !== 1) return undefined;
  const id = form.get("configurationId");
  return id !== null && /^[a-f0-9]{32}$/u.test(id) ? id : undefined;
}

function privateVoiceSettingsAction(value: string | undefined): "configure" | "disable" | "retry" | "cancel-retry" | "cancel-configure" | undefined {
  return value === "configure" || value === "disable" || value === "retry" || value === "cancel-retry" || value === "cancel-configure"
    ? value
    : undefined;
}

function operationalPrivateVoiceTransport(value: string | null): OperationalPrivateVoiceTransport | undefined {
  return value === "wyoming" || value === "openai_http" ? value : undefined;
}

function operationalPrivateVoiceEndpoint(value: string | null): string | undefined {
  return operationalPrivateVoiceRequiredText(value, 2_048);
}

function operationalPrivateVoiceRequiredText(value: string | null, maximum: number): string | undefined {
  const text = operationalPrivateVoiceText(value, maximum, false);
  return typeof text === "string" ? text : undefined;
}

/** `undefined` is an intentional blank; `null` is malformed input. */
function operationalPrivateVoiceText(value: string | null, maximum: number, optional: boolean): string | undefined | null {
  if (value === null || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  if (optional && value.length === 0) return undefined;
  return value.length === 0 ? null : value;
}

function operationalPrivateVoiceCredential(value: string | null): string | undefined | null {
  if (value === null || value.length > 2_048 || value.includes("\u0000")) return null;
  return value.length === 0 ? undefined : value;
}

function privateVoiceConfigureNotice(result: OperationalPrivateVoiceConfigureResult): string {
  if (result.status === "configured") return "语音服务已检查并保存。";
  if (result.status === "cancelled") return "已停止这次检查，原来的语音设置保持不变。";
  if (result.status === "busy") return "语音设置正在处理中，请稍候再查看。";
  if (result.status === "conflict") return "语音设置已经更新，请查看当前设置后再继续。";
  if (result.status === "unavailable") return "私有语音暂时不可用，请继续使用文字对话或检查设置。";
  if (result.status !== "probe_failed") return "私有语音暂时不可用，请继续使用文字对话或检查设置。";
  if (result.reason === "missing_endpoint" || result.reason === "endpoint_unreachable") return "语音服务暂时无法连接，请检查服务地址后再试。";
  if (result.reason === "missing_locale") return "请先填写语音回复使用的语言。";
  if (result.reason === "credential_rejected") return "语音服务未接受凭据，请更新后再试。";
  if (result.reason === "incompatible") return "语音服务不兼容，请检查设置后再试。";
  if (result.reason === "timed_out") return "语音服务响应较慢，请稍后再试。";
  return "私有语音暂时不可用，请继续使用文字对话或检查设置。";
}

/** A trusted in-process port still receives a closed result gate before it reaches household copy. */
function normalizeOperationalPrivateVoiceConfigureResult(value: unknown): OperationalPrivateVoiceConfigureResult {
  if (!isRecord(value) || typeof value.status !== "string") return { status: "unavailable" };
  if (value.status === "configured") {
    return typeof value.generation === "number" && Number.isSafeInteger(value.generation) && value.generation >= 1
      ? { status: "configured", generation: value.generation }
      : { status: "unavailable" };
  }
  if (value.status === "cancelled" || value.status === "busy" || value.status === "conflict" || value.status === "unavailable") {
    return { status: value.status };
  }
  if (value.status !== "probe_failed" || (value.track !== "asr" && value.track !== "tts")) return { status: "unavailable" };
  const reason = value.reason;
  return reason === "missing_endpoint" || reason === "missing_locale" || reason === "credential_rejected"
    || reason === "endpoint_unreachable" || reason === "timed_out" || reason === "incompatible" || reason === "unavailable"
    ? { status: "probe_failed", track: value.track, reason }
    : { status: "unavailable" };
}

function privateVoiceDisableNotice(result: OperationalPrivateVoiceDisableResult): string {
  if (result.status === "disabled") return "语音已关闭，随时可以再次设置。";
  if (result.status === "busy") return "语音设置正在处理中，请稍候再查看。";
  if (result.status === "conflict") return "语音设置已经更新，请查看当前设置后再继续。";
  return "私有语音暂时不可用，请继续使用文字对话或检查设置。";
}

function privateVoiceRetryNotice(status: OperationalPrivateVoiceStatus): string {
  if (status === "active") return "语音已经恢复，可以继续使用。";
  if (status === "retrying" || status === "switching") return "正在重新连接语音，你可以继续使用文字对话。";
  if (status === "disabled") return "语音当前未开启，你可以随时设置。";
  return "私有语音暂时不可用，请继续使用文字对话或检查设置。";
}

/**
 * The operational owner is trusted in-process, but HTTP still reconstructs a
 * finite public projection. Unknown runtime values fail closed and no secret
 * or provider-owned properties can cross into the shell.
 */
function normalizeOperationalPrivateVoiceProjection(value: unknown): ProductPrivateVoice | undefined {
  if (!isRecord(value)) return undefined;
  const generation = value.generation;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) return undefined;
  if (value.status === "disabled" && value.configured === false && value.asr === undefined && value.tts === undefined) {
    return { status: "disabled", generation, configured: false };
  }
  if ((value.status !== "active" && value.status !== "degraded" && value.status !== "retrying" && value.status !== "switching")
    || value.configured !== true) return undefined;
  const asr = normalizeOperationalPrivateVoiceAsr(value.asr);
  const tts = normalizeOperationalPrivateVoiceTts(value.tts);
  return asr === undefined || tts === undefined
    ? undefined
    : { status: value.status, generation, configured: true, asr, tts };
}

function normalizeOperationalPrivateVoiceAsr(value: unknown): NonNullable<Extract<ProductPrivateVoice, { readonly configured: true }>["asr"]> | undefined {
  if (!isRecord(value) || !isOperationalPrivateVoiceTransport(value.transport)
    || !isProjectionText(value.endpoint, 2_048) || typeof value.credentialConfigured !== "boolean") return undefined;
  const model = optionalProjectionText(value.model, 256);
  return model === null ? undefined : {
    transport: value.transport,
    endpoint: value.endpoint,
    credentialConfigured: value.credentialConfigured,
    ...(model === undefined ? {} : { model }),
  };
}

function normalizeOperationalPrivateVoiceTts(value: unknown): NonNullable<Extract<ProductPrivateVoice, { readonly configured: true }>["tts"]> | undefined {
  if (!isRecord(value) || !isOperationalPrivateVoiceTransport(value.transport)
    || !isProjectionText(value.endpoint, 2_048) || !isProjectionText(value.locale, 64)
    || typeof value.credentialConfigured !== "boolean") return undefined;
  const model = optionalProjectionText(value.model, 256);
  const voice = optionalProjectionText(value.voice, 256);
  return model === null || voice === null ? undefined : {
    transport: value.transport,
    endpoint: value.endpoint,
    locale: value.locale,
    credentialConfigured: value.credentialConfigured,
    ...(model === undefined ? {} : { model }),
    ...(voice === undefined ? {} : { voice }),
  };
}

function isOperationalPrivateVoiceTransport(value: unknown): value is OperationalPrivateVoiceTransport {
  return value === "wyoming" || value === "openai_http";
}

function isProjectionText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

function optionalProjectionText(value: unknown, maximum: number): string | undefined | null {
  return value === undefined ? undefined : isProjectionText(value, maximum) ? value : null;
}

function positiveInteger(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readBoundedBody(request: IncomingMessage, maximumBytes = MAX_FORM_BYTES): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new PayloadTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) overflow = true;
    else chunks.push(buffer);
  }
  if (overflow) throw new PayloadTooLargeError();
  return Buffer.concat(chunks).toString("utf8");
}

function boundedPrivateVoiceReadDeadline(value: number | undefined): number {
  if (value === undefined) return PRIVATE_VOICE_READ_DEADLINE_MS;
  if (!Number.isSafeInteger(value) || value < 10 || value > PRIVATE_VOICE_READ_DEADLINE_MS) {
    throw new TypeError("Private voice read deadline must be an integer from 10 to 30000 milliseconds");
  }
  return value;
}

async function readBoundedBytes(
  request: IncomingMessage,
  maximumBytes: number,
  deadlineMs: number,
): Promise<Uint8Array> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new PayloadTooLargeError();
  return new Promise<Uint8Array>((resolve, reject) => {
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
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onData = (chunk: Buffer | Uint8Array | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maximumBytes) {
        finish(new PayloadTooLargeError());
        request.resume();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish(new Uint8Array(Buffer.concat(chunks)));
    const onAborted = () => finish(new Error("Private voice request was aborted"));
    const deadline = setTimeout(() => {
      finish(new PrivateVoiceReadTimedOutError());
    }, deadlineMs);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
  });
}

class PayloadTooLargeError extends Error {}

class PrivateVoiceReadTimedOutError extends Error {}

function isPayloadTooLarge(error: unknown): boolean {
  return error instanceof PayloadTooLargeError;
}

function isPrivateVoiceReadTimedOut(error: unknown): boolean {
  return error instanceof PrivateVoiceReadTimedOutError;
}

function reviewInput(proposalId: string, body: string, reviewer: string): InboxReviewInput | undefined {
  const form = new URLSearchParams(body);
  if ([...form.keys()].some((key) => !["expectedRevision", "decision", "feedbackCode", "note"].includes(key))) return undefined;
  if (form.getAll("expectedRevision").length !== 1 || form.getAll("decision").length !== 1
    || form.getAll("feedbackCode").length !== 1 || form.getAll("note").length > 1) {
    return undefined;
  }
  const revisionRaw = form.get("expectedRevision") ?? "";
  if (!/^[1-9]\d*$/.test(revisionRaw)) return undefined;
  const expectedRevision = Number(revisionRaw);
  if (!Number.isSafeInteger(expectedRevision)) return undefined;
  const decision = form.get("decision");
  if (decision !== "approved" && decision !== "rejected") return undefined;
  const feedbackCode = form.get("feedbackCode");
  const note = form.get("note")?.trim();
  if (note !== undefined && note.length > 1_000) return undefined;
  if (feedbackCode === "other" && !note) return undefined;
  const base = {
    proposalId,
    expectedRevision,
    reviewer,
    ...(note ? { note } : {}),
  };
  if (decision === "approved") {
    return feedbackCode === "useful_as_is"
      ? { ...base, decision, feedbackCode }
      : undefined;
  }
  return isRejectionFeedbackCode(feedbackCode)
    ? { ...base, decision, feedbackCode }
    : undefined;
}

function isRejectionFeedbackCode(value: string | null): value is InboxRejectionFeedbackCode {
  return value !== null && [
    "already_covered",
    "not_useful",
    "incorrect_assumption",
    "insufficient_evidence",
    "household_preference",
    "too_risky",
    "other",
  ].includes(value);
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}
