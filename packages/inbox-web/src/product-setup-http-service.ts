import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Context, Service } from "@deepseek-ai/cordis";

import { ProductHttpHost, type ProductHttpHandler } from "./product-http-host.js";

const LOOPBACK_HOST = "127.0.0.1";
const SESSION_COOKIE = "hob_product_session";
const MAX_FORM_BYTES = 8_192;
const MAX_PAIRING_FAILURES = 5;
const PAIRING_FAILURE_WINDOW_MS = 60_000;
const DEFAULT_RECOVERY_PAIRING_TTL_MS = 10 * 60 * 1_000;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** The durable bridge projection retains a compact, household-readable review only. */
export const MAX_PRODUCT_SETUP_MAP_REVIEW_AREAS = 64;
export const MAX_PRODUCT_SETUP_MAP_REVIEW_LABEL_LENGTH = 80;
export const MAX_PRODUCT_SETUP_MAP_REVIEW_DEVICE_COUNT = 100_000;

export interface ProductSetupHttpOptions {
  /** Port 0 is accepted only as a test/embedding seam. */
  readonly port?: number;
  /** An already-listening product host whose active surface is selected explicitly. */
  readonly host?: ProductHttpHost;
  readonly pairingCode: string;
  readonly pairingExpiresAt: Date;
  readonly now?: () => Date;
  readonly createSessionToken: () => string;
  /** Creates a short-lived code that the expired paired browser can use to resume its durable draft. */
  readonly createRecoveryPairingCode?: () => string;
  readonly recoveryPairingTtlMs?: number;
  /** Creates the opaque token that becomes the operational HttpOnly cookie after activation. */
  readonly createOperationalSessionToken?: () => string;
  readonly setupDrafts: ProductSetupDraftPort;
  readonly activation?: ProductSetupActivationPort;
  readonly sessionTtlMs?: number;
}

export type ProductSetupActivationResult =
  | {
    readonly status: "activated";
    /** Non-secret cookie lifetime receipt returned by the durable session owner. */
    readonly sessionExpiresAt?: Date;
  }
  | { readonly status: "busy" | "conflict" | "unavailable" };

export interface ProductSetupActivationPort {
  activate(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly operationalSessionToken?: string;
  }): Promise<ProductSetupActivationResult>;
}

export interface ProductSetupDraftProjection {
  readonly draftId: string;
  readonly revision: number;
  readonly stage: "identity" | "model" | "bridge" | "voice" | "map";
  readonly householdName?: string;
  readonly agentName?: string;
  readonly model?: {
    readonly provider: string;
    readonly modelId: string;
    readonly baseURL?: string;
  };
  readonly bridge?: {
    readonly adapterType: string;
    readonly label: string;
    /** Adapter-projected endpoint safe to show in the household setup summary. */
    readonly endpoint?: string;
    readonly summary: { readonly states: number; readonly entities: number; readonly devices: number; readonly areas: number };
    /** A bounded, household-readable read-only snapshot that supports map review before activation. */
    readonly review?: ProductSetupMapReview;
  };
  /** Verified voice settings deliberately omit credential references. */
  readonly voice?: {
    readonly asr?: {
      readonly transport: "wyoming" | "openai_http";
      readonly endpoint: string;
      readonly model?: string;
      readonly probeLatencyMs: number;
    };
    readonly tts?: {
      readonly transport: "wyoming" | "openai_http";
      readonly endpoint: string;
      readonly locale: string;
      readonly voice?: string;
      readonly model?: string;
      readonly probeLatencyMs: number;
    };
  };
  readonly voiceSkipped?: true;
}

export interface ProductSetupMapReview {
  readonly areas: readonly ProductSetupMapReviewArea[];
  /** Devices outside the listed areas, retained as a count so no raw identifiers enter setup state. */
  readonly unassignedDeviceCount: number;
  /** The bridge has enumerated the complete room structure for this read-only snapshot. */
  readonly complete: boolean;
}

export interface ProductSetupMapReviewArea {
  readonly name: string;
  readonly deviceCount: number;
}

export type ProductSetupModelProbeResult =
  | { readonly status: "ready"; readonly draft: ProductSetupDraftProjection }
  | { readonly status: "missing"; readonly field: "apiKey" | "modelId" | "baseURL" }
  | { readonly status: "rejected" | "timeout" | "unavailable" | "conflict" };

export type ProductSetupBridgeProbeResult =
  | { readonly status: "ready"; readonly draft: ProductSetupDraftProjection }
  | { readonly status: "missing"; readonly field: "credential" }
  | { readonly status: "credential_rejected" | "endpoint_unreachable" | "incompatible" | "timed_out" | "conflict" };

export type ProductSetupVoiceVerifyResult =
  | { readonly status: "ready"; readonly draft: ProductSetupDraftProjection }
  | { readonly status: "missing"; readonly field: "endpoint" | "locale" }
  | { readonly status: "credential_rejected" | "endpoint_unreachable" | "timed_out" | "incompatible" | "unavailable" | "conflict" };

export interface ProductSetupDraftPort {
  establishSession(input: {
    readonly sessionToken: string;
    readonly sessionExpiresAt: Date;
  }): Promise<ProductSetupDraftProjection>;
  loadForSession(sessionToken: string): Promise<ProductSetupDraftProjection | undefined>;
  saveIdentity(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly householdName: string;
    readonly agentName: string;
  }): Promise<ProductSetupDraftProjection>;
  probeModel(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly provider: string;
    readonly modelId: string;
    readonly baseURL?: string;
    readonly apiKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ProductSetupModelProbeResult>;
  probeBridge(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly adapterType: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly credential: string;
    readonly signal?: AbortSignal;
  }): Promise<ProductSetupBridgeProbeResult>;
  probeVoice(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly track:
      | {
        readonly kind: "asr";
        readonly transport: "wyoming" | "openai_http";
        readonly endpoint: string;
        readonly credential?: string;
        readonly model?: string;
      }
      | {
        readonly kind: "tts";
        readonly transport: "wyoming" | "openai_http";
        readonly endpoint: string;
        readonly credential?: string;
        readonly locale: string;
        readonly voice?: string;
        readonly model?: string;
      };
    readonly signal?: AbortSignal;
  }): Promise<ProductSetupVoiceVerifyResult>;
  skipVoice(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
  }): Promise<ProductSetupDraftProjection>;
}

type SetupProbeKind = "model" | "bridge" | "voice-asr" | "voice-tts";
type SetupProbeTask = {
  readonly id: string;
  readonly sessionToken: string;
  readonly kind: SetupProbeKind;
  readonly controller: AbortController;
  cancelRequested: boolean;
};
type SetupProbePresentation = { readonly taskId: string; readonly kind: SetupProbeKind; readonly stopping: boolean };
type RecoveryPairing = { readonly digest: Buffer; readonly code: string; readonly expiresAt: Date };
type SetupSession = { readonly digest: Buffer; readonly expiresAt: Date };

/** HTTP-owned scheduling only; the setup controller owns probe cancellation and exact credential cleanup. */
class ProductSetupProbeTasks {
  private task: SetupProbeTask | undefined;
  private readonly completions = new Map<string, { readonly at: number; readonly notice: string }>();
  private readonly work = new Set<Promise<void>>();

  presentation(sessionToken: string | undefined): SetupProbePresentation | undefined {
    const task = this.task;
    return task === undefined || task.sessionToken !== sessionToken
      ? undefined
      : { taskId: task.id, kind: task.kind, stopping: task.cancelRequested };
  }

  consumeNotice(sessionToken: string | undefined): string | undefined {
    if (sessionToken === undefined) return undefined;
    const completion = this.completions.get(sessionToken);
    if (completion === undefined) return undefined;
    this.completions.delete(sessionToken);
    return Date.now() - completion.at <= 5 * 60_000 ? completion.notice : undefined;
  }

  start(
    sessionToken: string,
    kind: SetupProbeKind,
    execute: (signal: AbortSignal) => Promise<unknown>,
    resultNotice: (result: unknown) => string,
  ): boolean {
    if (this.task !== undefined) return false;
    const task: SetupProbeTask = {
      id: randomBytes(16).toString("hex"),
      sessionToken,
      kind,
      controller: new AbortController(),
      cancelRequested: false,
    };
    this.task = task;
    const work = (async () => {
      let result: unknown;
      try {
        result = await execute(task.controller.signal);
      } catch {
        result = undefined;
      } finally {
        if (this.task === task) this.task = undefined;
        this.completions.set(task.sessionToken, {
          at: Date.now(),
          notice: task.cancelRequested ? `已停止这次${probeLabel(task.kind)}检查。` : resultNotice(result),
        });
      }
    })();
    const settled = work.catch(() => undefined).finally(() => this.work.delete(settled));
    this.work.add(settled);
    return true;
  }

  cancel(sessionToken: string, taskId: string): boolean {
    const task = this.task;
    if (task === undefined || task.sessionToken !== sessionToken || task.id !== taskId) return false;
    task.cancelRequested = true;
    task.controller.abort();
    return true;
  }

  status(sessionToken: string): { readonly status: "pending"; readonly taskId: string; readonly kind: "model" | "bridge" | "voice" } | { readonly status: "completed" | "idle" } {
    const task = this.presentation(sessionToken);
    if (task !== undefined) {
      const kind = task.kind === "voice-asr" || task.kind === "voice-tts" ? "voice" : task.kind;
      return { status: "pending", taskId: task.taskId, kind };
    }
    return this.completions.has(sessionToken) ? { status: "completed" } : { status: "idle" };
  }

  async dispose(): Promise<void> {
    this.task?.controller.abort();
    await Promise.all([...this.work]);
  }
}

function probeLabel(kind: SetupProbeKind): string {
  if (kind === "model") return "模型服务";
  if (kind === "bridge") return "家庭连接";
  return kind === "voice-asr" ? "语音输入" : "语音输出";
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    productSetupHttp: ProductSetupHttpService;
  }
}

/** Local, pre-operational product shell used to establish one private setup session. */
export class ProductSetupHttpService extends Service {
  origin = "";
  private readonly server: Server | undefined;
  private readonly host: ProductHttpHost | undefined;
  private readonly hostHandler: ProductHttpHandler = (request, response) => this.handle(request, response);
  private readonly expectedPairingDigest: Buffer;
  private readonly now: () => Date;
  private pairingConsumed = false;
  private recoveryPairing: RecoveryPairing | undefined;
  private setupSession: SetupSession | undefined;
  private incorrectPairingAttempts: number[] = [];
  private readonly probeTasks = new ProductSetupProbeTasks();

  constructor(ctx: Context, private readonly options: ProductSetupHttpOptions) {
    super(ctx, "productSetupHttp");
    if (options.host === undefined && (!Number.isSafeInteger(options.port) || options.port === undefined || options.port < 0 || options.port > 65_535)) {
      throw new TypeError("Setup HTTP port must be an integer from 0 to 65535");
    }
    if (options.host !== undefined && options.port !== undefined) {
      throw new TypeError("Setup HTTP accepts either a port or an external product host");
    }
    const pairingCode = normalizePairingCode(options.pairingCode);
    if (pairingCode.length < 6 || pairingCode.length > 32) {
      throw new TypeError("Setup pairing code must contain 6 to 32 characters");
    }
    if (!Number.isFinite(options.pairingExpiresAt.getTime())) {
      throw new TypeError("Setup pairing expiry is invalid");
    }
    if (typeof options.createSessionToken !== "function") {
      throw new TypeError("Setup session token generator is required");
    }
    if (options.createRecoveryPairingCode !== undefined && typeof options.createRecoveryPairingCode !== "function") {
      throw new TypeError("Setup recovery pairing code generator is invalid");
    }
    recoveryPairingTtlMs(options.recoveryPairingTtlMs);
    if (options.setupDrafts === undefined) throw new TypeError("Setup draft owner is required");
    this.expectedPairingDigest = digest(pairingCode);
    this.now = options.now ?? (() => new Date());
    this.host = options.host;
    this.server = this.host === undefined ? createServer(this.hostHandler) : undefined;
  }

  protected async [Service.init](): Promise<void> {
    this.ctx.effect(() => () => this.probeTasks.dispose(), "product-setup-http.probe-tasks");
    if (this.host !== undefined) {
      if (this.host.origin === "") throw new Error("External product HTTP host must listen before setup initializes");
      this.origin = this.host.origin;
      this.ctx.effect(() => () => this.host?.detach(this.hostHandler), "product-setup-http.detach");
      return;
    }
    const server = this.server;
    if (server === undefined) throw new Error("Setup HTTP listener is unavailable");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(this.options.port, LOOPBACK_HOST, () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Setup HTTP listener has no TCP address");
    this.origin = `http://${LOOPBACK_HOST}:${address.port}`;
    this.ctx.effect(() => async () => {
      server.closeIdleConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }, "product-setup-http.close");
  }

  /** Makes this initialized setup surface the active handler on its external host. */
  attach(): void {
    if (this.host === undefined) throw new Error("Setup HTTP service owns its listener and cannot attach to an external host");
    this.host.switchTo(this.hostHandler);
  }

  /** Removes this setup surface when a product runtime takes over the shared host. */
  detach(): void {
    this.host?.detach(this.hostHandler);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applyResponseHeaders(response);
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", this.origin);
      if ((method === "GET" || method === "HEAD") && url.pathname === "/setup/assets/setup.css") {
        response.statusCode = 200;
        response.setHeader("content-type", "text/css; charset=utf-8");
        response.end(method === "HEAD" ? undefined : SETUP_CSS);
        return;
      }
      if ((method === "GET" || method === "HEAD") && url.pathname === "/setup/assets/setup.js") {
        response.statusCode = 200;
        response.setHeader("content-type", "text/javascript; charset=utf-8");
        response.end(method === "HEAD" ? undefined : SETUP_SCRIPT);
        return;
      }
      if ((method === "GET" || method === "HEAD") && url.pathname === "/setup") {
        if (method === "HEAD") {
          return sendHtml(response, 200, "");
        }
        const sessionToken = cookieValue(request.headers.cookie, SESSION_COOKIE);
        const draft = sessionToken === undefined ? undefined : await this.options.setupDrafts.loadForSession(sessionToken);
        const task = this.probeTasks.presentation(sessionToken);
        const notice = this.probeTasks.consumeNotice(sessionToken);
        const recovery = draft === undefined ? this.recoveryForExpiredSession(sessionToken) : undefined;
        const html = draft === undefined
          ? renderPairingPage(recovery === undefined ? this.pairingState() : "recovery", recovery?.code)
          : renderSetupWorkspace(draft, notice, this.options.activation !== undefined, task);
        return sendHtml(response, 200, html);
      }
      if ((method === "GET" || method === "HEAD") && url.pathname === "/setup/probe-status") {
        return this.sendProbeStatus(request, response, method === "HEAD");
      }
      if (method === "POST" && url.pathname === "/setup/pair") {
        return await this.pair(request, response);
      }
      if (method === "POST" && url.pathname === "/setup/identity") {
        return await this.saveIdentity(request, response);
      }
      if (method === "POST" && url.pathname === "/setup/model/probe") {
        return await this.probeModel(request, response);
      }
      if (method === "POST" && url.pathname === "/setup/probe/cancel") {
        return await this.cancelProbe(request, response);
      }
      if (method === "POST" && url.pathname === "/setup/bridge/probe") {
        return await this.probeBridge(request, response);
      }
      if (method === "POST" && url.pathname === "/setup/voice/asr/verify") {
        return await this.verifyVoice(request, response, "asr");
      }
      if (method === "POST" && url.pathname === "/setup/voice/tts/verify") {
        return await this.verifyVoice(request, response, "tts");
      }
      if (method === "POST" && url.pathname === "/setup/voice/skip") {
        return await this.skipVoice(request, response);
      }
      if (method === "POST" && url.pathname === "/setup/activate") {
        return await this.activate(request, response);
      }
      sendText(response, 404, "页面不存在");
    } catch (error) {
      if (error instanceof SetupHttpError) {
        return sendHtml(response, error.status, renderSetupProblem(error.message));
      }
      sendText(response, 500, "设置暂时没有完成，请稍后再试。");
    }
  }

  private async pair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin !== this.origin) {
      return sendText(response, 403, "请从这台设备上的设置页面继续。");
    }
    if (!isFormContentType(request.headers["content-type"])) {
      return sendHtml(response, 415, renderSetupProblem("请从设置页面提交配对码。"));
    }
    const retryAfterSeconds = this.pairingRetryAfterSeconds();
    if (retryAfterSeconds > 0) {
      response.setHeader("retry-after", String(retryAfterSeconds));
      return sendHtml(response, 429, renderSetupProblem(`尝试次数有点多，请在 ${retryAfterSeconds} 秒后再试。`));
    }
    const form = new URLSearchParams(await readBoundedBody(request));
    const available = this.availablePairing();
    if (available === undefined) {
      const state = this.pairingState();
      return sendHtml(response, state === "expired" ? 410 : 409, renderPairingPage(state));
    }
    const submitted = normalizePairingCode(form.get("code") ?? "");
    if (!safeDigestEqual(available.digest, digest(submitted))) {
      this.incorrectPairingAttempts.push(this.now().getTime());
      return sendHtml(response, 400, renderPairingPage("incorrect"));
    }

    // Claim the selected code before the next await. Node's event loop makes
    // this the single winner when two devices submit it together.
    if (available.kind === "initial") this.pairingConsumed = true;
    else this.recoveryPairing = undefined;
    this.incorrectPairingAttempts = [];

    const token = this.options.createSessionToken();
    if (typeof token !== "string" || token.length < 32 || token.length > 512) {
      throw new TypeError("Setup session token must contain 32 to 512 characters");
    }
    const ttlMs = this.options.sessionTtlMs ?? 12 * 60 * 60 * 1_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60 * 1_000) {
      throw new TypeError("Setup session lifetime must be between one minute and one day");
    }
    const sessionExpiresAt = new Date(this.now().getTime() + ttlMs);
    try {
      await this.options.setupDrafts.establishSession({
        sessionToken: token,
        sessionExpiresAt,
      });
    } catch (error) {
      if (available.kind === "initial") this.pairingConsumed = false;
      else this.recoveryPairing = available.recovery;
      throw error;
    }
    this.setupSession = Object.freeze({ digest: digest(token), expiresAt: sessionExpiresAt });
    response.statusCode = 303;
    response.setHeader("location", "/setup");
    response.setHeader(
      "set-cookie",
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttlMs / 1_000)}`,
    );
    response.end();
  }

  private async saveIdentity(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin !== this.origin) {
      return sendText(response, 403, "请从这台设备上的设置页面继续。");
    }
    const sessionToken = cookieValue(request.headers.cookie, SESSION_COOKIE);
    if (sessionToken === undefined || await this.options.setupDrafts.loadForSession(sessionToken) === undefined) {
      return sendHtml(response, 401, renderPairingPage(this.pairingState()));
    }
    if (!isFormContentType(request.headers["content-type"])) {
      return sendHtml(response, 415, renderSetupProblem("请从设置页面保存家庭名称。"));
    }
    const form = new URLSearchParams(await readBoundedBody(request));
    const revision = boundedRevision(form.get("revision"));
    const householdName = boundedHouseholdName(form.get("householdName"));
    const agentName = boundedHouseholdName(form.get("agentName"));
    try {
      await this.options.setupDrafts.saveIdentity({
        sessionToken,
        expectedRevision: revision,
        householdName,
        agentName,
      });
    } catch (error) {
      if (error instanceof Error && /revision conflict/u.test(error.message)) {
        const current = await this.options.setupDrafts.loadForSession(sessionToken);
        return sendHtml(response, 409, current === undefined
          ? renderPairingPage(this.pairingState())
          : renderSetupWorkspace(current, "设置已经在另一页更新，请核对后再保存。"));
      }
      throw error;
    }
    response.statusCode = 303;
    response.setHeader("location", "/setup");
    response.end();
  }

  private async probeModel(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin !== this.origin) {
      return sendText(response, 403, "请从这台设备上的设置页面继续。");
    }
    const sessionToken = cookieValue(request.headers.cookie, SESSION_COOKIE);
    const current = sessionToken === undefined ? undefined : await this.options.setupDrafts.loadForSession(sessionToken);
    if (sessionToken === undefined || current === undefined) {
      return sendHtml(response, 401, renderPairingPage(this.pairingState()));
    }
    if (current.stage !== "model") {
      return sendHtml(response, 409, renderSetupWorkspace(current, "模型设置已经更新，请核对当前步骤。"));
    }
    if (!isFormContentType(request.headers["content-type"])) {
      return sendHtml(response, 415, renderSetupWorkspace(current, "请从模型设置页面开始连接检查。"));
    }
    const form = new URLSearchParams(await readBoundedBody(request));
    const revision = boundedRevision(form.get("revision"));
    const provider = boundedIdentifier(form.get("provider"));
    const modelId = boundedModelValue(form.get("modelId"), 256, "模型名称");
    const rawBaseURL = form.get("baseURL")?.trim() ?? "";
    const apiKey = boundedModelValue(form.get("apiKey"), 512, "API 密钥");
    const started = this.probeTasks.start(sessionToken, "model", (signal) => this.options.setupDrafts.probeModel({
      sessionToken,
      expectedRevision: revision,
      provider,
      modelId,
      ...(rawBaseURL === "" ? {} : { baseURL: rawBaseURL }),
      apiKey,
      signal,
    }), (result) => modelProbeNotice(result));
    if (!started) return sendHtml(response, 409, renderSetupWorkspace(current, "正在完成上一项检查，请稍后查看。"));
    response.statusCode = 303;
    response.setHeader("location", "/setup");
    response.end();
  }

  private async probeBridge(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin !== this.origin) {
      return sendText(response, 403, "请从这台设备上的设置页面继续。");
    }
    const sessionToken = cookieValue(request.headers.cookie, SESSION_COOKIE);
    const current = sessionToken === undefined ? undefined : await this.options.setupDrafts.loadForSession(sessionToken);
    if (sessionToken === undefined || current === undefined) {
      return sendHtml(response, 401, renderPairingPage(this.pairingState()));
    }
    if (current.stage !== "bridge") {
      return sendHtml(response, 409, renderSetupWorkspace(current, "家庭连接已经更新，请核对当前步骤。"));
    }
    if (!isFormContentType(request.headers["content-type"])) {
      return sendHtml(response, 415, renderSetupWorkspace(current, "请从家庭连接页面开始检查。"));
    }
    const form = new URLSearchParams(await readBoundedBody(request));
    const baseUrl = boundedModelValue(form.get("baseUrl"), 2_048, "家庭系统地址");
    const credential = boundedModelValue(form.get("accessToken"), 512, "访问令牌");
    const expectedRevision = boundedRevision(form.get("revision"));
    const adapterType = boundedIdentifier(form.get("adapterType"));
    const started = this.probeTasks.start(sessionToken, "bridge", (signal) => this.options.setupDrafts.probeBridge({
      sessionToken,
      expectedRevision,
      adapterType,
      config: { baseUrl },
      credential,
      signal,
    }), (result) => bridgeProbeNotice(result));
    if (!started) return sendHtml(response, 409, renderSetupWorkspace(current, "正在完成上一项检查，请稍后查看。"));
    response.statusCode = 303;
    response.setHeader("location", "/setup");
    response.end();
  }

  private async verifyVoice(request: IncomingMessage, response: ServerResponse, kind: "asr" | "tts"): Promise<void> {
    if (request.headers.origin !== this.origin) return sendText(response, 403, "请从这台设备上的设置页面继续。");
    const sessionToken = cookieValue(request.headers.cookie, SESSION_COOKIE);
    const current = sessionToken === undefined ? undefined : await this.options.setupDrafts.loadForSession(sessionToken);
    if (sessionToken === undefined || current === undefined) return sendHtml(response, 401, renderPairingPage(this.pairingState()));
    if (current.stage !== "voice") return sendHtml(response, 409, renderSetupWorkspace(current, "语音设置已经更新，请核对当前步骤。"));
    if (!isFormContentType(request.headers["content-type"])) return sendHtml(response, 415, renderVoiceStep(current, "请从语音设置页面开始验证。"));
    let revision: number;
    let track: Parameters<ProductSetupDraftPort["probeVoice"]>[0]["track"];
    try {
      const form = new URLSearchParams(await readBoundedBody(request));
      revision = boundedRevision(singleFormValue(form, "revision"));
      track = voiceTrackFromForm(form, kind);
    } catch {
      return sendHtml(response, 400, renderVoiceStep(current, "请检查语音服务信息后再验证。"));
    }
    const started = this.probeTasks.start(sessionToken, kind === "asr" ? "voice-asr" : "voice-tts", (signal) => this.options.setupDrafts.probeVoice({
      sessionToken,
      expectedRevision: revision,
      track,
      signal,
    }), (result) => voiceProbeNotice(result));
    if (!started) return sendHtml(response, 409, renderVoiceStep(current, "正在完成上一项检查，请稍后查看。"));
    response.statusCode = 303;
    response.setHeader("location", "/setup");
    response.end();
  }

  private async cancelProbe(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin !== this.origin) return sendText(response, 403, "请从这台设备上的设置页面继续。");
    const sessionToken = cookieValue(request.headers.cookie, SESSION_COOKIE);
    if (sessionToken === undefined || await this.options.setupDrafts.loadForSession(sessionToken) === undefined) {
      return sendHtml(response, 401, renderPairingPage(this.pairingState()));
    }
    if (!isFormContentType(request.headers["content-type"])) return sendHtml(response, 415, renderSetupProblem("请从设置页面停止这次检查。"));
    const form = new URLSearchParams(await readBoundedBody(request));
    const taskId = singleSetupTaskId(form);
    if (taskId === undefined) return sendHtml(response, 400, renderSetupProblem("这次检查已经结束，请查看当前步骤。"));
    this.probeTasks.cancel(sessionToken, taskId);
    response.statusCode = 303;
    response.setHeader("location", "/setup");
    response.end();
  }

  private async sendProbeStatus(request: IncomingMessage, response: ServerResponse, head: boolean): Promise<void> {
    if (request.headers.origin !== undefined && request.headers.origin !== this.origin) return sendText(response, 403, "请从这台设备上的设置页面继续。");
    const sessionToken = cookieValue(request.headers.cookie, SESSION_COOKIE);
    if (sessionToken === undefined || await this.options.setupDrafts.loadForSession(sessionToken) === undefined) {
      return sendText(response, 401, "请先连接这台设备。");
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(head ? undefined : JSON.stringify(this.probeTasks.status(sessionToken)));
  }

  private async skipVoice(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin !== this.origin) return sendText(response, 403, "请从这台设备上的设置页面继续。");
    const sessionToken = cookieValue(request.headers.cookie, SESSION_COOKIE);
    const current = sessionToken === undefined ? undefined : await this.options.setupDrafts.loadForSession(sessionToken);
    if (sessionToken === undefined || current === undefined) return sendHtml(response, 401, renderPairingPage(this.pairingState()));
    if (current.stage !== "voice") return sendHtml(response, 409, renderSetupWorkspace(current, "语音设置已经更新，请核对当前步骤。"));
    if (!isFormContentType(request.headers["content-type"])) return sendHtml(response, 415, renderVoiceStep(current, "请从语音设置页面继续。"));
    let revision: number;
    try {
      const form = new URLSearchParams(await readBoundedBody(request));
      assertAllowedFormFields(form, ["revision"]);
      revision = boundedRevision(singleFormValue(form, "revision"));
    } catch {
      return sendHtml(response, 400, renderVoiceStep(current, "请重新确认后继续。"));
    }
    try {
      await this.options.setupDrafts.skipVoice({ sessionToken, expectedRevision: revision });
    } catch {
      const latest = await this.options.setupDrafts.loadForSession(sessionToken);
      return sendHtml(response, 409, latest === undefined
        ? renderPairingPage(this.pairingState())
        : renderSetupWorkspace(latest, "语音设置已经更新，请核对当前步骤。"));
    }
    response.statusCode = 303;
    response.setHeader("location", "/setup");
    response.end();
  }

  private async activate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin !== this.origin) {
      return sendText(response, 403, "请从这台设备上的设置页面继续。");
    }
    const activation = this.options.activation;
    if (activation === undefined) return sendHtml(response, 503, renderSetupProblem("暂时无法完成启用，请稍后再试。"));
    const sessionToken = cookieValue(request.headers.cookie, SESSION_COOKIE);
    const current = sessionToken === undefined ? undefined : await this.options.setupDrafts.loadForSession(sessionToken);
    if (sessionToken === undefined || current === undefined) {
      return sendHtml(response, 401, renderPairingPage(this.pairingState()));
    }
    if (current.stage !== "map") {
      return sendHtml(response, 409, renderSetupWorkspace(current, "家庭设置已经更新，请核对当前步骤。", true));
    }
    if (mapReviewForDisplay(current.bridge?.review, current.bridge?.summary) === undefined) {
      return sendHtml(response, 409, renderMapStep(current, "家庭地图尚未准备好，暂时不能启用。"));
    }
    if (!isFormContentType(request.headers["content-type"])) {
      return sendHtml(response, 415, renderSetupWorkspace(current, "请从家庭地图页面继续。", true));
    }
    let revision: number;
    try {
      const form = new URLSearchParams(await readBoundedBody(request));
      assertAllowedFormFields(form, ["revision", "mapReviewed"]);
      revision = boundedRevision(singleFormValue(form, "revision"));
      if (singleFormValue(form, "mapReviewed") !== "confirmed") throw new TypeError("Map review must be confirmed");
    } catch {
      return sendHtml(response, 400, renderMapStep(current, "请先核对家庭地图，再确认继续。", true));
    }
    const operationalSessionToken = this.options.createOperationalSessionToken?.();
    if (operationalSessionToken !== undefined && (typeof operationalSessionToken !== "string"
      || operationalSessionToken.length < 32 || operationalSessionToken.length > 512)) {
      throw new Error("Activated product session is invalid");
    }
    const result = await activation.activate({
      sessionToken,
      expectedRevision: revision,
      ...(operationalSessionToken === undefined ? {} : { operationalSessionToken }),
    });
    if (result.status === "activated") {
      if ((operationalSessionToken === undefined) !== (result.sessionExpiresAt === undefined)) {
        throw new Error("Activated product session is incomplete");
      }
      response.statusCode = 303;
      response.setHeader("location", "/onboarding");
      if (operationalSessionToken !== undefined && result.sessionExpiresAt !== undefined) {
        const remainingMs = result.sessionExpiresAt.getTime() - this.now().getTime();
        if (!Number.isFinite(result.sessionExpiresAt.getTime()) || remainingMs <= 0) {
          throw new Error("Activated product session is invalid");
        }
        response.setHeader(
          "set-cookie",
          `${SESSION_COOKIE}=${encodeURIComponent(operationalSessionToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(remainingMs / 1_000)}`,
        );
      }
      response.end();
      return;
    }
    const notice = result.status === "busy"
      ? "家庭正在启动，请稍等片刻。"
      : result.status === "conflict"
        ? "家庭设置已经更新，请核对后继续。"
        : "这次没有启动完成，已验证的设置仍然保留，可以直接再试。";
    return sendHtml(
      response,
      result.status === "unavailable" ? 503 : 409,
      renderSetupWorkspace(current, notice, true),
    );
  }

  private pairingState(): "ready" | "expired" | "used" {
    if (this.availableRecoveryPairing() !== undefined) return "used";
    if (this.pairingConsumed) return "used";
    return this.now().getTime() >= this.options.pairingExpiresAt.getTime() ? "expired" : "ready";
  }

  /** Gives only the previously paired, now-expired browser a fresh local recovery code. */
  private recoveryForExpiredSession(sessionToken: string | undefined): RecoveryPairing | undefined {
    const session = this.setupSession;
    if (sessionToken === undefined || session === undefined || this.now().getTime() < session.expiresAt.getTime()) return undefined;
    const submitted = digest(sessionToken);
    if (!safeDigestEqual(session.digest, submitted)) return undefined;
    const existing = this.availableRecoveryPairing();
    if (existing !== undefined) return existing;
    const code = normalizePairingCode((this.options.createRecoveryPairingCode ?? createRecoveryPairingCode)());
    if (code.length < 6 || code.length > 32) throw new TypeError("Setup recovery pairing code must contain 6 to 32 characters");
    const recovery: RecoveryPairing = Object.freeze({
      digest: digest(code),
      code,
      expiresAt: new Date(this.now().getTime() + recoveryPairingTtlMs(this.options.recoveryPairingTtlMs)),
    });
    this.recoveryPairing = recovery;
    return recovery;
  }

  private availablePairing():
    | { readonly kind: "initial"; readonly digest: Buffer }
    | { readonly kind: "recovery"; readonly digest: Buffer; readonly recovery: RecoveryPairing }
    | undefined {
    const recovery = this.availableRecoveryPairing();
    if (recovery !== undefined) return { kind: "recovery", digest: recovery.digest, recovery };
    if (!this.pairingConsumed && this.now().getTime() < this.options.pairingExpiresAt.getTime()) {
      return { kind: "initial", digest: this.expectedPairingDigest };
    }
    return undefined;
  }

  private availableRecoveryPairing(): RecoveryPairing | undefined {
    const recovery = this.recoveryPairing;
    if (recovery === undefined) return undefined;
    if (this.now().getTime() < recovery.expiresAt.getTime()) return recovery;
    this.recoveryPairing = undefined;
    return undefined;
  }

  private pairingRetryAfterSeconds(): number {
    const nowMs = this.now().getTime();
    this.incorrectPairingAttempts = this.incorrectPairingAttempts.filter(
      (attemptedAt) => nowMs - attemptedAt < PAIRING_FAILURE_WINDOW_MS,
    );
    if (this.incorrectPairingAttempts.length < MAX_PAIRING_FAILURES) return 0;
    return Math.max(1, Math.ceil((this.incorrectPairingAttempts[0]! + PAIRING_FAILURE_WINDOW_MS - nowMs) / 1_000));
  }

}

function normalizePairingCode(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function createRecoveryPairingCode(): string {
  const bytes = randomBytes(8);
  const characters = Array.from(bytes, (byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]);
  return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
}

function recoveryPairingTtlMs(value: number | undefined): number {
  const ttl = value ?? DEFAULT_RECOVERY_PAIRING_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > 24 * 60 * 60 * 1_000) {
    throw new TypeError("Setup recovery pairing lifetime must be between one minute and one day");
  }
  return ttl;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeDigestEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try { return decodeURIComponent(rest.join("=")); } catch { return undefined; }
    }
  }
  return undefined;
}

function isFormContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

function boundedRevision(value: string | null): number {
  if (value === null || !/^\d{1,9}$/u.test(value)) throw new TypeError("Setup revision is invalid");
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError("Setup revision is invalid");
  return revision;
}

function boundedHouseholdName(value: string | null): string {
  if (value === null) throw new TypeError("Setup name is invalid");
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < 1 || normalized.length > 40 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError("Setup name is invalid");
  }
  return normalized;
}

function boundedIdentifier(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value)) throw new TypeError("Setup provider is invalid");
  return value;
}

function boundedModelValue(value: string | null, max: number, label: string): string {
  if (value === null || value.trim() === "" || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label}无效`);
  }
  return value.trim();
}

function singleFormValue(form: URLSearchParams, name: string): string {
  const values = form.getAll(name);
  if (values.length !== 1) throw new TypeError("Setup form field must have one value");
  return values[0]!;
}

function optionalSingleFormValue(form: URLSearchParams, name: string): string | undefined {
  const values = form.getAll(name);
  if (values.length > 1) throw new TypeError("Setup form field must have one value");
  const value = values[0];
  return value === undefined || value === "" ? undefined : value;
}

function voiceTrackFromForm(
  form: URLSearchParams,
  kind: "asr" | "tts",
): Parameters<ProductSetupDraftPort["probeVoice"]>[0]["track"] {
  assertAllowedFormFields(form, kind === "asr"
    ? ["revision", "service", "endpoint", "credential", "model"]
    : ["revision", "service", "endpoint", "credential", "locale", "voice", "model"]);
  const transport = boundedVoiceService(singleFormValue(form, "service"));
  const endpoint = boundedVoiceValue(singleFormValue(form, "endpoint"), 2_048);
  const credential = optionalSingleFormValue(form, "credential");
  const model = optionalSingleFormValue(form, "model");
  const boundedCredential = credential === undefined ? undefined : boundedVoiceValue(credential, 4_096);
  const boundedModel = model === undefined ? undefined : boundedVoiceValue(model, 128);
  if (kind === "asr") {
    return {
      kind,
      transport,
      endpoint,
      ...(boundedCredential === undefined ? {} : { credential: boundedCredential }),
      ...(boundedModel === undefined ? {} : { model: boundedModel }),
    };
  }
  const locale = boundedVoiceValue(singleFormValue(form, "locale"), 35);
  const voice = optionalSingleFormValue(form, "voice");
  const boundedVoice = voice === undefined ? undefined : boundedVoiceValue(voice, 128);
  return {
    kind,
    transport,
    endpoint,
    locale,
    ...(boundedCredential === undefined ? {} : { credential: boundedCredential }),
    ...(boundedVoice === undefined ? {} : { voice: boundedVoice }),
    ...(boundedModel === undefined ? {} : { model: boundedModel }),
  };
}

function assertAllowedFormFields(form: URLSearchParams, allowed: readonly string[]): void {
  const names = new Set(allowed);
  for (const [name] of form) {
    if (!names.has(name)) throw new TypeError("Setup form field is invalid");
  }
}

function singleSetupTaskId(form: URLSearchParams): string | undefined {
  if ([...form.keys()].some((key) => key !== "taskId") || form.getAll("taskId").length !== 1) return undefined;
  const taskId = form.get("taskId");
  return taskId !== null && /^[a-f0-9]{32}$/u.test(taskId) ? taskId : undefined;
}

function boundedVoiceService(value: string): "wyoming" | "openai_http" {
  if (value === "wyoming" || value === "openai_http") return value;
  throw new TypeError("Voice service is invalid");
}

function boundedVoiceValue(value: string, max: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError("Voice form value is invalid");
  }
  return normalized;
}

function voiceVerificationNotice(result: Exclude<ProductSetupVoiceVerifyResult, { readonly status: "ready" }>): string {
  if (result.status === "missing") return result.field === "locale"
    ? "请填写语音语言后再验证。"
    : "请填写语音服务地址后再验证。";
  switch (result.status) {
    case "credential_rejected": return "这项密钥没有通过验证，请检查后重试。";
    case "endpoint_unreachable": return "暂时无法连接这项语音服务，请检查地址和家庭网络后重试。";
    case "timed_out": return "验证等待时间已到，请确认服务正在运行后重试。";
    case "incompatible": return "这项服务不能用于语音输入或输出，请调整设置后重试。";
    case "unavailable": return "语音服务暂时不可用，稍后可以再次验证。";
    case "conflict": return "语音设置已经更新，请核对当前步骤。";
  }
}

function modelProbeNotice(result: unknown): string {
  const status = probeStatus(result);
  if (status === "ready") return "模型检查已完成，请查看当前步骤。";
  if (status === "missing") return "模型信息还不完整，请补齐后再检查。";
  if (status === "rejected") return "模型没有接受这组信息，请核对服务、模型名称和密钥。";
  if (status === "timeout") return "模型响应超时了。家庭配置保持不变，可以直接再试一次。";
  if (status === "conflict") return "模型设置已经在另一页更新，请核对后再试。";
  return "暂时连不上模型。家庭配置保持不变，请检查网络后再试。";
}

function bridgeProbeNotice(result: unknown): string {
  const status = probeStatus(result);
  if (status === "ready") return "家庭连接检查已完成，请查看当前步骤。";
  if (status === "missing") return "家庭连接信息还不完整，请补齐后再检查。";
  if (status === "credential_rejected") return "Home Assistant 没有接受这个令牌，请重新复制长期访问令牌。";
  if (status === "timed_out") return "家庭系统响应超时了。正式配置保持不变，可以直接再试一次。";
  if (status === "incompatible") return "这个地址没有返回兼容的 Home Assistant 数据。";
  if (status === "conflict") return "家庭连接已经在另一页更新，请核对后再试。";
  return "暂时连不上家庭系统。正式配置保持不变，请检查地址和网络。";
}

function voiceProbeNotice(result: unknown): string {
  if (!isProbeResult(result) || result.status === "ready") return result !== undefined ? "语音检查已完成，请查看当前步骤。" : "语音服务暂时不可用，稍后可以再次验证。";
  return voiceVerificationNotice(result as Exclude<ProductSetupVoiceVerifyResult, { readonly status: "ready" }>);
}

function probeStatus(result: unknown): string | undefined {
  return isProbeResult(result) ? result.status : undefined;
}

function isProbeResult(result: unknown): result is { readonly status: string } {
  return typeof result === "object" && result !== null && typeof (result as { readonly status?: unknown }).status === "string";
}

async function readBoundedBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_FORM_BYTES) throw new SetupHttpError(413, "提交的内容太长，请缩短后再试。");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

class SetupHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function applyResponseHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(body);
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
}

function documentShell(title: string, content: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${title} · hob</title>
  <link rel="stylesheet" href="/setup/assets/setup.css">
  <script src="/setup/assets/setup.js" defer></script>
</head>
<body><main class="setup-shell">${content}</main></body>
</html>`;
}

function renderPairingPage(state: "ready" | "incorrect" | "expired" | "used" | "recovery", recoveryCode?: string): string {
  const feedback = state === "incorrect"
    ? '<p class="notice" role="alert">配对码没有对上，请看一眼启动 hob 的终端。</p>'
    : state === "expired"
      ? '<p class="notice" role="alert">配对码已过期。重新启动 hob 后，会生成一个新码。</p>'
      : state === "used"
        ? '<p class="notice" role="status">这枚配对码已经用过。请回到刚才连接的设备继续。</p>'
        : state === "recovery"
          ? `<p class="notice" role="status">这台设备可以继续此前设置。使用这枚新的恢复码：<strong>${escapeHtml(recoveryCode ?? "")}</strong></p>`
        : "";
  const form = state === "ready" || state === "incorrect" || state === "recovery"
    ? `<form method="post" action="/setup/pair" class="pairing-form">
        <label for="pairing-code">配对码</label>
        <input id="pairing-code" name="code" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="32"${state === "recovery" ? ` value="${escapeHtml(recoveryCode ?? "")}"` : ""} required autofocus>
        <button type="submit">${state === "recovery" ? "继续此前设置" : "连接这台设备"}</button>
      </form>`
    : "";
  return documentShell("开始设置", `
    <section class="welcome-card" aria-labelledby="setup-title">
      <div class="hob-mark" aria-hidden="true">h</div>
      <p class="eyebrow">欢迎回家</p>
      <h1 id="setup-title">先连接你的私人设备</h1>
      <p class="lead">${state === "recovery" ? "这台设备已确认此前的设置。输入新的恢复码后继续。" : "在启动 hob 的终端里找到配对码，输入后即可继续设置。配对码只在本机显示一次。"}</p>
      ${feedback}${form}
      <p class="privacy-note">连接只发生在这台电脑上。模型密钥和家庭凭据会在后续步骤单独安全保存。</p>
    </section>`);
}

function renderSetupProblem(message: string): string {
  return documentShell("继续设置", `
    <section class="welcome-card" aria-labelledby="problem-title">
      <div class="hob-mark" aria-hidden="true">h</div>
      <p class="eyebrow">设置需要确认</p>
      <h1 id="problem-title">这一步还没有完成</h1>
      <p class="notice" role="alert">${escapeHtml(message)}</p>
      <p class="privacy-note"><a href="/setup">返回设置页</a></p>
    </section>`);
}

function renderSetupWorkspace(
  draft: ProductSetupDraftProjection,
  notice?: string,
  canActivate = false,
  task?: SetupProbePresentation,
): string {
  if (draft.stage === "map") return renderMapStep(draft, notice, canActivate);
  if (draft.stage === "voice") return renderVoiceStep(draft, notice, task);
  if (draft.stage === "bridge") return renderBridgeStep(draft, notice, task);
  if (draft.stage === "model") return renderModelStep(draft, notice, task);
  return documentShell("给家起名字", `
    <section class="workspace" aria-labelledby="workspace-title">
      <header>
        <div class="hob-mark" aria-hidden="true">h</div>
        <div><p class="eyebrow success">这台设备已连接</p><h1 id="workspace-title">给家和助手起个名字</h1></div>
      </header>
      <p class="lead">这是 hob 第一次认识你们。名字会出现在对话、提醒和家庭地图里，以后随时可以修改。</p>
      ${notice === undefined ? "" : `<p class="notice" role="alert">${escapeHtml(notice)}</p>`}
      <form method="post" action="/setup/identity" class="pairing-form">
        <input type="hidden" name="revision" value="${draft.revision}">
        <label for="household-name">这个家叫什么</label>
        <input id="household-name" name="householdName" autocomplete="organization" maxlength="40" value="${escapeHtml(draft.householdName ?? "我的家")}" required>
        <label for="agent-name">你的家庭助手叫什么</label>
        <input id="agent-name" name="agentName" autocomplete="off" maxlength="40" value="${escapeHtml(draft.agentName ?? "hob")}" required>
        <button type="submit">记住这些名字</button>
      </form>
      <p class="privacy-note">名字保存在这台电脑的私人数据目录中。</p>
    </section>`);
}

function renderModelStep(draft: ProductSetupDraftProjection, notice?: string, task?: SetupProbePresentation): string {
  return documentShell("连接模型", `
    <section class="workspace" aria-labelledby="workspace-title">
      <header>
        <div class="hob-mark" aria-hidden="true">h</div>
        <div><p class="eyebrow success">身份已保存</p><h1 id="workspace-title">连接模型</h1></div>
      </header>
      <p class="lead">${escapeHtml(draft.agentName ?? "hob")}已经记住${escapeHtml(draft.householdName ?? "这个家")}。下一步选择模型服务并完成一次真实连接检查。</p>
      ${notice === undefined ? "" : `<p class="notice" role="alert">${escapeHtml(notice)}</p>`}
      ${task === undefined ? "" : renderProbeTask(task)}
      <form method="post" action="/setup/model/probe" class="pairing-form" data-model-probe>
        <input type="hidden" name="revision" value="${draft.revision}">
        <label for="model-provider">模型服务</label>
        <select id="model-provider" name="provider" required>
          <option value="deepseek">DeepSeek</option>
          <option value="gpt">OpenAI</option>
          <option value="claude">Anthropic</option>
          <option value="kimi">Moonshot</option>
          <option value="glm">智谱</option>
          <option value="custom">自定义 OpenAI 兼容服务</option>
        </select>
        <label for="model-id">模型名称</label>
        <input id="model-id" name="modelId" autocomplete="off" maxlength="256" placeholder="例如 deepseek-chat" required>
        <label for="model-base-url">自定义服务地址 <small>仅自定义服务需要</small></label>
        <input id="model-base-url" name="baseURL" inputmode="url" autocomplete="url" maxlength="2048" placeholder="https://example.com/v1">
        <label for="model-api-key">API 密钥</label>
        <input id="model-api-key" name="apiKey" type="password" autocomplete="new-password" maxlength="512" required>
        <p class="privacy-note">密钥只交给系统凭据保险箱，不会写入设置草稿或页面。</p>
        <p class="probe-status" data-probe-status aria-live="polite"></p>
        <button type="submit">连接并验证</button>
      </form>
    </section>`);
}

function renderBridgeStep(draft: ProductSetupDraftProjection, notice?: string, task?: SetupProbePresentation): string {
  return documentShell("接入家庭", `
    <section class="workspace" aria-labelledby="workspace-title">
      <header>
        <div class="hob-mark" aria-hidden="true">h</div>
        <div><p class="eyebrow success">模型已连接</p><h1 id="workspace-title">接入家庭</h1></div>
      </header>
      <p class="lead">${escapeHtml(draft.agentName ?? "hob")}已经通过 ${escapeHtml(draft.model?.modelId ?? "所选模型")} 完成连接检查。现在连接现有的家庭系统，先做只读核对。</p>
      ${notice === undefined ? "" : `<p class="notice" role="alert">${escapeHtml(notice)}</p>`}
      ${task === undefined ? "" : renderProbeTask(task)}
      <form method="post" action="/setup/bridge/probe" class="pairing-form" data-bridge-probe>
        <input type="hidden" name="revision" value="${draft.revision}">
        <input type="hidden" name="adapterType" value="home-assistant">
        <label for="ha-base-url">Home Assistant 地址</label>
        <input id="ha-base-url" name="baseUrl" inputmode="url" autocomplete="url" maxlength="2048" placeholder="http://homeassistant.local:8123" required>
        <label for="ha-access-token">长期访问令牌</label>
        <input id="ha-access-token" name="accessToken" type="password" autocomplete="new-password" maxlength="512" required>
        <p class="privacy-note">先进行一次只读检查：读取状态、设备和空间，不订阅事件，也不控制设备。</p>
        <p class="probe-status" data-probe-status aria-live="polite"></p>
        <button type="submit">只读连接并核对</button>
      </form>
    </section>`);
}

function renderVoiceStep(draft: ProductSetupDraftProjection, notice?: string, task?: SetupProbePresentation): string {
  const asr = draft.voice?.asr;
  const tts = draft.voice?.tts;
  return documentShell("设置私人语音", `
    <section class="workspace" aria-labelledby="workspace-title">
      <header>
        <div class="hob-mark" aria-hidden="true">h</div>
        <div><p class="eyebrow success">家庭连接已验证</p><h1 id="workspace-title">设置私人语音</h1></div>
      </header>
      <p class="lead">分别确认语音输入和语音输出。它们只会在你启用产品后开始使用。</p>
      ${notice === undefined ? "" : `<p class="notice" role="alert">${escapeHtml(notice)}</p>`}
      ${task === undefined ? "" : renderProbeTask(task)}
      ${renderVoiceTrack("asr", draft.revision, asr)}
      ${renderVoiceTrack("tts", draft.revision, tts)}
      <form method="post" action="/setup/voice/skip" class="quiet-action">
        <input type="hidden" name="revision" value="${draft.revision}">
        <button type="submit" class="secondary-action">本次跳过</button>
      </form>
      <p class="privacy-note">密钥写入本机凭据保险箱，页面不会回显；运行语音服务时由 Hob 读取。</p>
    </section>`);
}

type VoiceAsrProjection = NonNullable<ProductSetupDraftProjection["voice"]>["asr"];
type VoiceTtsProjection = NonNullable<ProductSetupDraftProjection["voice"]>["tts"];

function renderVoiceTrack(
  kind: "asr" | "tts",
  revision: number,
  saved: VoiceAsrProjection | VoiceTtsProjection | undefined,
): string {
  const isTts = kind === "tts";
  const track = saved;
  const status = track === undefined
    ? `<p class="voice-status" role="status">${isTts ? "语音输出尚未验证" : "语音输入尚未验证"}</p>`
    : `<p class="voice-status verified" role="status">${isTts ? "语音输出" : "语音输入"}已验证，启用产品时生效</p>`;
  const endpoint = track?.endpoint ?? "";
  const model = track?.model ?? "";
  const service = track?.transport ?? "openai_http";
  const ttsTrack = isTts ? track as VoiceTtsProjection | undefined : undefined;
  const locale = ttsTrack?.locale ?? "zh-CN";
  const voice = ttsTrack?.voice ?? "";
  return `<section class="voice-track" aria-labelledby="voice-${kind}-title">
      <div class="voice-track-heading"><h2 id="voice-${kind}-title">${isTts ? "语音输出" : "语音输入"}</h2>${status}</div>
      <form method="post" action="/setup/voice/${kind}/verify" class="pairing-form" data-voice-check>
        <input type="hidden" name="revision" value="${revision}">
        <label for="voice-${kind}-service">语音服务</label>
        <select id="voice-${kind}-service" name="service" required>
          <option value="openai_http"${service === "openai_http" ? " selected" : ""}>兼容语音服务</option>
          <option value="wyoming"${service === "wyoming" ? " selected" : ""}>本地语音服务（Wyoming）</option>
        </select>
        <label for="voice-${kind}-endpoint">服务地址</label>
        <input id="voice-${kind}-endpoint" name="endpoint" inputmode="url" autocomplete="url" maxlength="2048" value="${escapeHtml(endpoint)}" required>
        <label for="voice-${kind}-credential">密钥 <small>本地语音服务通常不需要</small></label>
        <input id="voice-${kind}-credential" name="credential" type="password" autocomplete="new-password" maxlength="4096">
        ${isTts ? `<label for="voice-${kind}-locale">语音语言</label>
        <input id="voice-${kind}-locale" name="locale" autocomplete="language" maxlength="35" value="${escapeHtml(locale)}" required>
        <label for="voice-${kind}-voice">声音名称 <small>可选</small></label>
        <input id="voice-${kind}-voice" name="voice" autocomplete="off" maxlength="128" value="${escapeHtml(voice)}">` : ""}
        <label for="voice-${kind}-model">服务中的模型 <small>可选</small></label>
        <input id="voice-${kind}-model" name="model" autocomplete="off" maxlength="128" value="${escapeHtml(model)}">
        <p class="voice-check-status" data-voice-status aria-live="polite"></p>
        <button type="submit">${track === undefined ? `验证${isTts ? "语音输出" : "语音输入"}` : `重新验证${isTts ? "语音输出" : "语音输入"}`}</button>
      </form>
    </section>`;
}

function renderProbeTask(task: SetupProbePresentation): string {
  const action = task.stopping ? "正在停止" : "正在检查";
  return `<section class="probe-task" data-setup-probe-task aria-live="polite">
    <p>${escapeHtml(`${action}${probeLabel(task.kind)}。可以离开这个页面，检查会继续完成。`)}</p>
    ${task.stopping ? "" : `<form method="post" action="/setup/probe/cancel" class="quiet-action">
      <input type="hidden" name="taskId" value="${task.taskId}">
      <button type="submit" class="secondary-action">停止这次检查</button>
    </form>`}
    <a class="secondary-action probe-result-link" href="/setup">查看检查结果</a>
  </section>`;
}

function renderMapStep(draft: ProductSetupDraftProjection, notice?: string, canActivate = false): string {
  const review = mapReviewForDisplay(draft.bridge?.review, draft.bridge?.summary);
  const summary = draft.bridge?.summary;
  const voiceSummary = draft.voice !== undefined
    ? "私人语音已验证，将和家庭助手一起启用。"
    : draft.voiceSkipped === true
      ? "本次不连接私人语音；文字对话仍可使用。"
      : "";
  if (review === undefined) return documentShell("家庭地图尚未准备好", `
    <section class="workspace" aria-labelledby="workspace-title">
      <header>
        <div class="hob-mark" aria-hidden="true">h</div>
        <div><p class="eyebrow success">家庭连接已验证</p><h1 id="workspace-title">家庭地图尚未准备好</h1></div>
      </header>
      <p class="lead">${escapeHtml(draft.agentName ?? "hob")}已经完成一次只读同步。这次连接尚未提供可核对的空间结构。</p>
      ${notice === undefined ? "" : `<p class="notice" role="alert">${escapeHtml(notice)}</p>`}
      <section class="map-summary" aria-labelledby="connection-summary-title">
        <h2 id="connection-summary-title">连接摘要</h2>
        <div><strong>${summary?.devices ?? 0}</strong><span>个设备</span></div>
        <div><strong>${summary?.areas ?? 0}</strong><span>个空间</span></div>
        <div><strong>${summary?.states ?? 0}</strong><span>条当前状态</span></div>
      </section>
      <p class="privacy-note">家庭地图准备好后即可继续。你的已验证连接设置会保留在这台电脑上。</p>
      ${voiceSummary === "" ? "" : `<p class="privacy-note" role="status">${voiceSummary}</p>`}
    </section>`);
  return documentShell("核对家庭地图", `
    <section class="workspace" aria-labelledby="workspace-title">
      <header>
        <div class="hob-mark" aria-hidden="true">h</div>
        <div><p class="eyebrow success">家庭连接已验证</p><h1 id="workspace-title">核对家庭地图</h1></div>
      </header>
      <p class="lead">${escapeHtml(draft.agentName ?? "hob")}已经从 ${escapeHtml(draft.bridge?.label ?? "家庭系统")} 完成一次只读同步。请核对下面的空间结构与设备数量，再继续设置家庭。</p>
      ${notice === undefined ? "" : `<p class="notice" role="alert">${escapeHtml(notice)}</p>`}
      <section class="map-review" aria-label="家庭地图核对">
        ${review.areas.length === 0 ? `<section class="map-area"><h2>尚未创建空间</h2><p>当前设备都显示在未分配区域中。</p></section>` : review.areas.map((area) => `<section class="map-area">
          <h2>${escapeHtml(area.name)}</h2>
          <p>${area.deviceCount === 0 ? "这次同步没有发现设备。" : `已同步 ${area.deviceCount} 个设备。`}</p>
        </section>`).join("")}
      </section>
      <section class="map-summary" aria-labelledby="connection-summary-title">
        <h2 id="connection-summary-title">连接摘要</h2>
        <div><strong>${summary?.devices ?? 0}</strong><span>个设备</span></div>
        <div><strong>${summary?.areas ?? 0}</strong><span>个空间</span></div>
        <div><strong>${summary?.states ?? 0}</strong><span>条当前状态</span></div>
      </section>
      ${review.complete ? "" : `<p class="notice" role="status">这次只读同步展示了当前可确认的空间结构；连接摘要保留了完整数量。</p>`}
      ${review.unassignedDeviceCount === 0 ? "" : `<p class="privacy-note">另有 ${review.unassignedDeviceCount} 个设备暂未归入空间。</p>`}
      ${voiceSummary === "" ? "" : `<p class="privacy-note" role="status">${voiceSummary}</p>`}
      ${canActivate ? `<form method="post" action="/setup/activate" class="pairing-form" data-activation>
        <input type="hidden" name="revision" value="${draft.revision}">
        <label class="map-confirmation"><input type="checkbox" name="mapReviewed" value="confirmed" required> 我已核对当前空间结构与设备数量</label>
        <p class="probe-status" data-activation-status aria-live="polite"></p>
        <button type="submit">继续设置家庭</button>
      </form>` : ""}
    </section>`);
}

function mapReviewForDisplay(
  value: ProductSetupMapReview | undefined,
  summary?: { readonly devices: number; readonly areas: number },
): ProductSetupMapReview | undefined {
  if (value === undefined || typeof value.complete !== "boolean" || !Array.isArray(value.areas)
    || value.areas.length > MAX_PRODUCT_SETUP_MAP_REVIEW_AREAS
    || !Number.isSafeInteger(value.unassignedDeviceCount) || value.unassignedDeviceCount < 0
    || value.unassignedDeviceCount > MAX_PRODUCT_SETUP_MAP_REVIEW_DEVICE_COUNT) return undefined;
  const areas: ProductSetupMapReviewArea[] = [];
  const names = new Set<string>();
  for (const candidate of value.areas) {
    const name = mapReviewLabel(candidate?.name);
    if (name === undefined || !Number.isSafeInteger(candidate?.deviceCount) || candidate.deviceCount < 0
      || candidate.deviceCount > MAX_PRODUCT_SETUP_MAP_REVIEW_DEVICE_COUNT || names.has(name)) return undefined;
    names.add(name);
    areas.push({ name, deviceCount: candidate.deviceCount });
  }
  if (value.complete && summary !== undefined) {
    const reviewedDeviceCount = areas.reduce((total, area) => total + area.deviceCount, 0) + value.unassignedDeviceCount;
    if (areas.length !== summary.areas || reviewedDeviceCount !== summary.devices) return undefined;
  }
  return { areas, unassignedDeviceCount: value.unassignedDeviceCount, complete: value.complete };
}

function mapReviewLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.normalize("NFKC").trim();
  return label.length > 0 && label.length <= MAX_PRODUCT_SETUP_MAP_REVIEW_LABEL_LENGTH && !/[\u0000-\u001f\u007f]/u.test(label)
    ? label
    : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

const SETUP_CSS = `
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;background:#f5f5f7;color:#1d1d1f;font-synthesis:none}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f5f5f7}.setup-shell{width:100%;min-height:100vh;display:grid;place-items:center;padding:clamp(1rem,4vw,3rem)}
.welcome-card,.workspace{width:min(100%,46rem);background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:2rem;padding:clamp(1.5rem,5vw,3.5rem);box-shadow:0 1.5rem 4rem rgba(0,0,0,.08)}
.hob-mark{display:grid;place-items:center;width:3rem;height:3rem;border-radius:1rem;background:#1d1d1f;color:#fff;font-size:1.6rem;font-weight:650;letter-spacing:-.06em;margin-bottom:2rem}
.workspace header{display:flex;gap:1rem;align-items:center}.workspace header .hob-mark{margin:0}.eyebrow{margin:0 0 .45rem;font-size:.82rem;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:#6e6e73}.eyebrow.success{color:#237a45}
h1{margin:0;font-size:clamp(2rem,7vw,3.5rem);line-height:1.04;letter-spacing:-.045em;font-weight:650;text-wrap:balance}.workspace h1{font-size:clamp(1.8rem,5vw,3rem)}
.lead{margin:1.25rem 0 2rem;color:#515154;font-size:1.08rem;line-height:1.6;max-width:38rem}.pairing-form{display:grid;gap:.75rem;margin-top:1.5rem}.pairing-form label{font-weight:600}
input,select{width:100%;min-height:3.5rem;border:1px solid #a1a1a6;border-radius:.9rem;background:#fff;color:#1d1d1f;padding:.8rem 1rem;font:inherit;font-size:1rem;outline:none}#pairing-code{text-transform:uppercase;letter-spacing:.06em}input:focus-visible,select:focus-visible{border-color:#0066cc;box-shadow:0 0 0 .25rem rgba(0,102,204,.18)}label small{font-weight:400;color:#6e6e73}.probe-status:empty{display:none}
a{color:#0066cc;text-underline-offset:.18em}
button{min-height:3.5rem;border:0;border-radius:999px;background:#0071e3;color:#fff;padding:.8rem 1.25rem;font:inherit;font-weight:650;cursor:pointer}button:hover{background:#0077ed}button:active{transform:scale(.985)}button:focus-visible{outline:.2rem solid #0066cc;outline-offset:.2rem}
	.notice{border-radius:1rem;background:#fff3cd;color:#654d03;padding:1rem;line-height:1.45}.privacy-note,.handoff-note{margin:1.5rem 0 0;color:#6e6e73;font-size:.88rem;line-height:1.5}
	.probe-task{margin:1.25rem 0;padding:1rem;border-radius:1rem;background:#f5faff;border:1px solid rgba(0,113,227,.25);line-height:1.5}.probe-task p{margin:0}
.model-intro{padding:1.15rem;border-radius:1.15rem;background:#f5faff;border:1px solid rgba(0,113,227,.25);line-height:1.5}.model-intro p{margin:.4rem 0 0;color:#515154}.quiet-action{margin-top:1rem}
.voice-track{margin-top:2rem;padding-top:1.5rem;border-top:1px solid rgba(0,0,0,.12)}.voice-track-heading{display:flex;gap:.75rem;align-items:baseline;justify-content:space-between;flex-wrap:wrap}.voice-track h2{margin:0;font-size:1.25rem;letter-spacing:-.02em}.voice-status{margin:0;color:#6e6e73;font-size:.9rem}.voice-status.verified{color:#237a45;font-weight:600}.secondary-action{background:transparent;border:1px solid #a1a1a6;color:#1d1d1f}.secondary-action:hover{background:#f5f5f7}.probe-result-link{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:.65rem 1rem;border-radius:999px;font-weight:650;text-decoration:none}.voice-check-status:empty{display:none}
.map-review{display:grid;gap:.75rem}.map-area{padding:1rem 1.15rem;border-radius:1rem;background:#f5f5f7}.map-area h2,.map-summary h2{margin:0;font-size:1.05rem;letter-spacing:-.01em}.map-area ul{display:grid;gap:.5rem;list-style:none;padding:0;margin:1rem 0 0}.map-area li{display:flex;justify-content:space-between;gap:1rem;align-items:baseline}.map-area li small{color:#6e6e73;font-size:.85rem}.map-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-top:1rem}.map-summary h2{grid-column:1/-1}.map-summary div{display:grid;gap:.25rem;padding:1rem;border-radius:1rem;background:#f5f5f7}.map-summary strong{font-size:1.8rem;letter-spacing:-.04em}.map-summary span{color:#6e6e73;font-size:.85rem}.map-confirmation{display:flex;align-items:center;gap:.75rem;min-height:44px;padding:.5rem 0}.map-confirmation input{width:1.25rem;min-height:1.25rem;margin:0;padding:0}
.setup-steps{display:grid;gap:.75rem;list-style:none;padding:0;margin:0}.setup-steps li{display:grid;grid-template-columns:2.25rem 1fr auto;gap:1rem;align-items:start;padding:1rem;border:1px solid rgba(0,0,0,.08);border-radius:1.15rem;color:#6e6e73}.setup-steps li>span{display:grid;place-items:center;width:2.25rem;height:2.25rem;border-radius:50%;background:#e8e8ed;color:#515154;font-weight:650}.setup-steps strong{color:#1d1d1f}.setup-steps p{margin:.25rem 0 0;font-size:.9rem;line-height:1.4}.setup-steps b{font-size:.78rem;color:#0066cc}.setup-steps .current{border-color:rgba(0,113,227,.35);background:#f5faff}.setup-steps .current>span{background:#0071e3;color:#fff}
@media(max-width:35rem){.setup-shell{place-items:start center;padding:0}.welcome-card,.workspace{min-height:100vh;border:0;border-radius:0;padding:2rem 1.25rem;box-shadow:none}.setup-steps li{grid-template-columns:2.25rem 1fr}.setup-steps b{grid-column:2}.map-summary{grid-template-columns:1fr}}
@media(prefers-reduced-motion:no-preference){button{transition:background-color .2s ease,transform .12s ease}}
@media(prefers-contrast:more){.welcome-card,.workspace,.setup-steps li,input{border-width:2px;border-color:currentColor}}
@media(prefers-reduced-transparency:reduce){.welcome-card,.workspace{box-shadow:none}}
	@media(prefers-color-scheme:dark){:root,body{background:#000;color:#f5f5f7}.welcome-card,.workspace{background:#1c1c1e;border-color:#3a3a3c}.hob-mark{background:#f5f5f7;color:#1d1d1f}.lead,.privacy-note,.handoff-note,.setup-steps li,.voice-status{color:#aeaeb2}.setup-steps strong,h1,.voice-track h2,.map-area h2,.map-summary h2{color:#f5f5f7}.setup-steps li,.voice-track{border-color:#3a3a3c}.setup-steps .current{background:#101c29;border-color:#0a84ff}.setup-steps li>span{background:#3a3a3c;color:#f5f5f7}input,select{background:#2c2c2e;color:#f5f5f7;border-color:#636366}.notice{background:#493b14;color:#ffdf7e}.model-intro,.probe-task{background:#101c29}.model-intro p{color:#aeaeb2}.map-area,.map-summary div{background:#2c2c2e}.map-area li small,.map-summary span{color:#aeaeb2}.voice-status.verified,.eyebrow.success{color:#75d59a}a{color:#6eb4ff}.secondary-action{border-color:#636366;color:#f5f5f7}.secondary-action:hover{background:#2c2c2e}}
`;

const SETUP_SCRIPT = `
for (const form of document.querySelectorAll('[data-model-probe], [data-bridge-probe]')) {
  form.addEventListener('submit', () => {
    const button = form.querySelector('button[type="submit"]');
    const status = form.querySelector('[data-probe-status]');
    if (button) { button.disabled = true; button.textContent = '正在验证…'; }
    if (status) status.textContent = '正在进行一次真实连接检查，通常只需要几秒。';
  });
}
for (const form of document.querySelectorAll('[data-activation]')) {
  form.addEventListener('submit', () => {
    const button = form.querySelector('button[type="submit"]');
    const status = form.querySelector('[data-activation-status]');
    if (button) { button.disabled = true; button.textContent = '正在准备家庭…'; }
    if (status) status.textContent = '正在连接真实家庭状态并准备对话。';
  });
}
for (const form of document.querySelectorAll('[data-voice-check]')) {
  form.addEventListener('submit', () => {
    const button = form.querySelector('button[type="submit"]');
    const status = form.querySelector('[data-voice-status]');
    if (button) { button.disabled = true; button.textContent = '正在验证…'; }
    if (status) status.textContent = '正在进行一次真实验证，通常只需要几秒。';
  });
}
if (document.querySelector('[data-setup-probe-task]')) {
  const poll = async () => {
    try {
      const response = await fetch('/setup/probe-status', { credentials: 'same-origin' });
      const status = response.ok ? await response.json() : { status: 'idle' };
      if (status.status === 'completed' || status.status === 'idle') location.reload();
      else setTimeout(poll, 1200);
    } catch { setTimeout(poll, 2000); }
  };
  setTimeout(poll, 1200);
}
`;
