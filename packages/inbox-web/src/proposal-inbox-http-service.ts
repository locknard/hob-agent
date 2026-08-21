import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Context, Service } from "@deepseek-ai/cordis";

import type { InboxRejectionFeedbackCode, InboxReviewInput } from "./proposal-inbox.js";
import {
  renderProductContent,
  renderProductHost,
  renderProductViewRecipeContent,
  type ProductOnboardingChoices,
  type ProductOnboardingCapabilityChoice,
  type ProductOnboardingBridgeChoice,
  type ProductOnboardingState,
  type ProductShellModel,
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
const MAX_BATCH_CONTROL_FORM_BYTES = 8 * 1024;
// application/x-www-form-urlencoded expands a 1,000-character CJK question to roughly 9 KiB.
const MAX_ADVICE_FORM_BYTES = 12 * 1024;
const MAX_CORRECTION_FORM_BYTES = 24 * 1024;
const MAX_ADVICE_EVENT_TEXT = 4 * 1024;
const MAX_ADVICE_EVENT_ID = 64;
const ADVICE_SSE_HEARTBEAT_MS = 15_000;
const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

export type InboxAuthenticator = (authorization: string | undefined) => boolean;

/** Stable V4 destinations owned by the product shell. */
export type ProductRoute =
  | "home"
  | "conversation"
  | "review-center"
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
  readonly household?: ProductShellModel["household"];
  readonly view?: ProductShellModel["view"];
}

/**
 * Product view provider seam. The HTTP service owns transport and policy
 * checks; providers render ordinary markup from the canonical shell projection.
 */
export type ProductViewProvider = RegisteredProductViewProvider<ProductShellModel, ProductRouteRenderContext>;

/** Static assets served alongside the fixed Host Shell and registered providers. */
export const PRODUCT_CSS = PRODUCT_SHELL_STYLES;
export const PRODUCT_JS = String.raw`// EventSource reconnects with Last-Event-ID for the active household turn.
const hostViewScroll = document.querySelector("[data-host-view-scroll]");
const activeHostView = hostViewScroll?.querySelector('a[aria-current="true"]');
if (hostViewScroll instanceof HTMLElement && activeHostView instanceof HTMLElement) {
  const scrollBounds = hostViewScroll.getBoundingClientRect();
  const activeBounds = activeHostView.getBoundingClientRect();
  const targetLeft = hostViewScroll.scrollLeft + activeBounds.left - scrollBounds.left - (hostViewScroll.clientWidth - activeBounds.width) / 2;
  hostViewScroll.scrollLeft = Math.max(0, targetLeft);
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
      node.textContent = "已到期";
      const card = node.closest("[data-review-kind=\"runtime\"]");
      for (const button of card?.querySelectorAll("button") || []) button.disabled = true;
      continue;
    }
    if (seconds < 60) node.textContent = seconds + " 秒";
    else if (seconds < 3600) node.textContent = Math.ceil(seconds / 60) + " 分钟";
    else node.textContent = Math.ceil(seconds / 3600) + " 小时";
  }
};
if (runtimeCountdowns.length > 0) {
  updateRuntimeCountdowns();
  const runtimeCountdownTimer = window.setInterval(updateRuntimeCountdowns, 1000);
  window.addEventListener("beforeunload", () => window.clearInterval(runtimeCountdownTimer), { once: true });
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
` + `\n${VOICE_INTERACTION_JS}`;

/**
 * The bundled providers share one presentation kernel and the fixed HTTP
 * contract. The registry supplies deterministic selection and recovery.
 */
const PRODUCT_HREFS: Partial<Record<ProductShellRoute, string>> = {
  overview: "/home",
  conversation: "/conversation",
  reviews: "/review-center",
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
  readonly port: number;
  readonly authenticate: InboxAuthenticator;
  /** Explicit household identity for every review mutation. */
  readonly principal?: InboxReviewActor;
  readonly reviewer?: string;
  /** Hub-owned typed onboarding coordinator. */
  readonly onboarding?: OnboardingPort;
  /** Trusted in-process presentation providers registered beside the built-in views. */
  readonly viewProviders?: readonly ProductViewProvider[];
  /** Explicit data-only layout contributions checked before the listener opens. */
  readonly viewRecipes?: readonly unknown[];
  /** Initial provider used before this browser saves a device-local preference. */
  readonly defaultViewId?: string;
}

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
  snoozeProposal?(input: { readonly proposalId: string; readonly until: ProposalInboxSnoozeTarget }): unknown | Promise<unknown>;
  canRejectProposal?(): boolean;
  rejectProposal?(input: { readonly proposalId: string; readonly expectedRevision: number; readonly reviewer: string }): unknown | Promise<unknown>;
  canLatchProposal?(): boolean;
  latchProposal?(input: { readonly proposalId: string; readonly expectedRevision: number; readonly reviewer: string }): unknown | Promise<unknown>;
  canEnableProposal?(): boolean;
  enableProposal?(input: { readonly proposalId: string; readonly expectedRevision: number; readonly reviewer: string }): unknown | Promise<unknown>;
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
  private readonly server: Server;
  private readonly inbox: InboxHttpPort;
  private readonly reviewer: string;
  private readonly principal: InboxReviewActor | undefined;
  private readonly views: ProductViewRegistry<ProductShellModel, ProductRouteRenderContext>;
  private readonly defaultViewId: string;
  private readonly onboarding: OnboardingPort;

  constructor(ctx: Context, private readonly options: ProposalInboxHttpOptions) {
    super(ctx, "homeInboxHttp");
    if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new TypeError("Inbox HTTP port must be an integer from 0 to 65535");
    }
    if (typeof options.authenticate !== "function") throw new TypeError("Inbox HTTP authenticator is required");
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
    this.onboarding = options.onboarding ?? new UnavailableOnboardingService();
    this.server = createServer((request, response) => { void this.handle(request, response); });
  }

  protected async [Service.init](): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.options.port, LOOPBACK_HOST, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("Inbox HTTP listener has no TCP address");
    this.origin = `http://${LOOPBACK_HOST}:${address.port}`;
    this.ctx.effect(() => async () => {
      this.server.closeIdleConnections?.();
      await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
      this.onboarding.close?.();
    }, "home-inbox-http.close");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.options.authenticate(request.headers.authorization)) {
        response.setHeader("www-authenticate", 'Basic realm="hob-agent Inbox", charset="UTF-8"');
        return send(response, 401, "Authentication required");
      }
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", this.origin);
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
        return send(response, 403, "This action requires the local household origin");
      }
      if ((method === "GET" || method === "HEAD") && url.pathname === "/assets/product.css") {
        return this.sendProductAsset(response, "css", method === "HEAD");
      }
      if ((method === "GET" || method === "HEAD") && url.pathname === "/assets/product.js") {
        return this.sendProductAsset(response, "js", method === "HEAD");
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
        return this.sendProductRoute(response, productRoute, url.pathname, method === "HEAD", undefined, proposalId, actionTicketId, batchRequestId, requestedViewId, storedDefaultViewId, request.headers.cookie, persistViewPreference);
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
      if ((method === "GET" || method === "HEAD") && url.pathname === "/voice-preview") {
        if (url.search.length > 0) return redirect(response, "/voice-preview");
        const content = renderVoiceSurface("idle");
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
          return send(response, 403, "Household correction requires a present adult household member on a bound private device");
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
          return send(response, 403, "Runtime review requires a present adult household member");
        }
        const decide = runtimeDecision[2] === "approve"
          ? this.inbox.approveRuntimeConfirmation
          : this.inbox.rejectRuntimeConfirmation;
        if (decide === undefined) return send(response, 404, "Runtime confirmation review unavailable");
        if (this.inbox.canApproveRuntimeConfirmation?.(this.principal, confirmationId) === false) {
          return send(response, 403, "This confirmation requires an eligible present household member on an authorized device");
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
        const until = proposalSnoozeInput(body);
        if (until === undefined) return send(response, 400, "Invalid proposal snooze");
        try {
          await this.inbox.snoozeProposal({ proposalId, until });
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
          return send(response, proposalMutationErrorStatus(error), proposalMutationErrorText(error));
        }
        return redirect(response, `/review-center/proposals/${encodeURIComponent(proposalId)}`);
      }
      const detail = /^\/review-center\/proposals\/([^/]+)$/.exec(url.pathname);
      if ((method === "GET" || method === "HEAD") && detail) {
        const proposalId = safeDecode(detail[1]!);
        if (proposalId === undefined) return send(response, 404, "Proposal not found");
        return this.sendProductRoute(response, "review-center", url.pathname, method === "HEAD", undefined, proposalId, undefined, undefined, requestedViewId, storedDefaultViewId, request.headers.cookie, persistViewPreference);
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
      household: hostProjection.household,
    };
    try {
      let resolution = this.views.resolve(requestedViewId);
      let presentation = productViewPresentation(resolution.provider.id, resolution.provider.preferences ?? [], presentationCookie);
      let context: ProductRouteRenderContext = {
        ...baseContext,
        view: productViewState(path, resolution.provider.id, this.views.choices(), storedDefaultViewId, canManageProductViewDefault(this.principal), presentation, resolution.recoveredFrom),
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
          view: productViewState(path, resolution.provider.id, this.views.choices(), storedDefaultViewId, canManageProductViewDefault(this.principal), presentation, failedProviderId),
        };
        model = productShellModel(route, context);
        content = await renderRegisteredProductView(resolution.provider, model, context);
      }
      const host = renderProductHost(model, content, { includeStyles: false, hrefs: PRODUCT_HREFS });
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
      path: "/voice-preview",
      reviewCounts: hostProjection.reviewCounts,
      household: hostProjection.household,
      view: productViewState("/voice-preview", resolution.provider.id, this.views.choices(), storedDefaultViewId, canManageProductViewDefault(this.principal), presentation, resolution.recoveredFrom),
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
    const queued: AdviceProgressEvent[] = [];
    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let finish: (() => void) | undefined;

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
      finish?.();
    };

    const writeEvent = (raw: AdviceProgressEvent) => {
      const event = safeAdviceEvent(raw);
      if (event === undefined || closed) return;
      const eventId = String(event.id);
      if (lastSent !== undefined && eventId === lastSent) return;
      const sequence = adviceEventSequence(eventId);
      if (sequence !== undefined && highestSentSequence !== undefined && sequence <= highestSentSequence) return;
      if (response.destroyed) {
        cleanup();
        return;
      }
      response.write(formatSseEvent(event));
      lastSent = eventId;
      if (sequence !== undefined) highestSentSequence = sequence;
      if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") terminal = true;
    };

    function onAdviceEvent(event: AdviceProgressEvent): void {
      if (replaying) queued.push(event);
      else writeEvent(event);
      if (!replaying && terminal) {
        cleanup();
        response.end();
      }
    }

    try {
      const after = lastEventId(request.headers["last-event-id"]);
      if (subscribeAdvice !== undefined) {
        unsubscribe = subscribeAdvice.call(this.inbox, adviceId, onAdviceEvent) ?? undefined;
      }
      const replay = readEvents === undefined ? [] : await readEvents.call(this.inbox, adviceId, after);
      for (const event of replay) writeEvent(event);
      replaying = false;
      for (const event of queued) writeEvent(event);
      queued.length = 0;
      if (terminal) {
        cleanup();
        response.end();
        return;
      }
      heartbeat = setInterval(() => {
        if (closed || response.destroyed) {
          cleanup();
          return;
        }
        response.write(": heartbeat\n\n");
      }, ADVICE_SSE_HEARTBEAT_MS);
      await new Promise<void>((resolve) => {
        finish = resolve;
        response.once("close", cleanup);
        request.once("aborted", cleanup);
        if (response.destroyed) cleanup();
      });
    } catch {
      cleanup();
      if (!response.writableEnded) response.end();
    }
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
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

function productRouteForPath(path: string): ProductRoute | undefined {
  if (path === "/home") return "home";
  if (path === "/conversation") return "conversation";
  if (path === "/review-center") return "review-center";
  if (path === "/activity") return "activity";
  if (path === "/control") return "control";
  if (path === "/settings") return "settings";
  if (path === "/onboarding") return "onboarding";
  return undefined;
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
    ...(principal === undefined ? {} : { memberName: principal.principalId, memberRole: principalRoleLabel(principal.role) }),
  };
}

function principalRoleLabel(role: InboxReviewActor["role"]): string {
  switch (role) {
    case "admin": return "管理员";
    case "adult_member": return "成年成员";
    case "member": return "成员";
    case "child": return "孩子";
    case "guest": return "访客";
  }
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
  if (!canUsePresentHouseholdPrincipal(actor)
    || (actor.role !== "admin" && actor.role !== "adult_member")
    || actor.device.kind !== "private") return false;
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
  if (rawType === "delta" || rawType === "answer_delta") {
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

function mediaType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
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
    && (actor.role === "admin" || actor.role === "adult_member")
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
      return memberName === undefined || one("memberRole") !== "adult_admin" ? undefined : { step: 4, kind: "bind_private_device", memberName, role: "adult_admin" };
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
  4: ["memberName", "memberRole"],
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
  memberRole: ["adult_admin"],
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
    case "permission_denied": return "This onboarding step requires an adult member on a bound private device";
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

function proposalSnoozeInput(body: string): ProposalInboxSnoozeTarget | undefined {
  const form = new URLSearchParams(body);
  if (form.getAll("until").length !== 1 || [...form.keys()].some((key) => key !== "until")) return undefined;
  const until = form.get("until");
  if (until === "tomorrow" || until === "weekend" || until === "next_week") return until;
  return undefined;
}

function proposalDecisionInput(body: string): number | undefined {
  const form = new URLSearchParams(body);
  if (form.getAll("expectedRevision").length !== 1 || [...form.keys()].some((key) => key !== "expectedRevision")) return undefined;
  return positiveInteger(form.get("expectedRevision"));
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

class PayloadTooLargeError extends Error {}

function isPayloadTooLarge(error: unknown): boolean {
  return error instanceof PayloadTooLargeError;
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
