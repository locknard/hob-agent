import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Context, Service } from "@deepseek-ai/cordis";

import { ProductHttpHost, type ProductHttpHandler } from "./product-http-host.js";

const LOOPBACK_HOST = "127.0.0.1";
const SESSION_COOKIE = "hob_product_session";
const MAX_FORM_BYTES = 8_192;
const MAX_PAIRING_FAILURES = 5;
const PAIRING_FAILURE_WINDOW_MS = 60_000;

export interface ProductSetupHttpOptions {
  /** Port 0 is accepted only as a test/embedding seam. */
  readonly port?: number;
  /** An already-listening product host whose active surface is selected explicitly. */
  readonly host?: ProductHttpHost;
  readonly pairingCode: string;
  readonly pairingExpiresAt: Date;
  readonly now?: () => Date;
  readonly createSessionToken: () => string;
  readonly setupDrafts: ProductSetupDraftPort;
  readonly sessionTtlMs?: number;
}

export interface ProductSetupDraftProjection {
  readonly draftId: string;
  readonly revision: number;
  readonly stage: "identity" | "model" | "bridge" | "map";
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
  };
}

export type ProductSetupModelProbeResult =
  | { readonly status: "ready"; readonly draft: ProductSetupDraftProjection }
  | { readonly status: "missing"; readonly field: "apiKey" | "modelId" | "baseURL" }
  | { readonly status: "rejected" | "timeout" | "unavailable" | "conflict" };

export type ProductSetupBridgeProbeResult =
  | { readonly status: "ready"; readonly draft: ProductSetupDraftProjection }
  | { readonly status: "missing"; readonly field: "credential" }
  | { readonly status: "credential_rejected" | "endpoint_unreachable" | "incompatible" | "timed_out" | "conflict" };

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
  }): Promise<ProductSetupModelProbeResult>;
  probeBridge(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly adapterType: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly credential: string;
  }): Promise<ProductSetupBridgeProbeResult>;
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
  private incorrectPairingAttempts: number[] = [];

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
    if (options.setupDrafts === undefined) throw new TypeError("Setup draft owner is required");
    this.expectedPairingDigest = digest(pairingCode);
    this.now = options.now ?? (() => new Date());
    this.host = options.host;
    this.server = this.host === undefined ? createServer(this.hostHandler) : undefined;
  }

  protected async [Service.init](): Promise<void> {
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
        const sessionToken = cookieValue(request.headers.cookie, SESSION_COOKIE);
        const draft = sessionToken === undefined ? undefined : await this.options.setupDrafts.loadForSession(sessionToken);
        const html = draft === undefined
          ? renderPairingPage(this.pairingState())
          : renderSetupWorkspace(draft);
        return sendHtml(response, 200, method === "HEAD" ? "" : html);
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
      if (method === "POST" && url.pathname === "/setup/bridge/probe") {
        return await this.probeBridge(request, response);
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
    if (this.pairingConsumed) {
      return sendHtml(response, 409, renderPairingPage("used"));
    }
    if (this.pairingState() === "expired") {
      return sendHtml(response, 410, renderPairingPage("expired"));
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
    const submitted = normalizePairingCode(form.get("code") ?? "");
    if (!safeDigestEqual(this.expectedPairingDigest, digest(submitted))) {
      this.incorrectPairingAttempts.push(this.now().getTime());
      return sendHtml(response, 400, renderPairingPage("incorrect"));
    }

    // Claim the one-time code before the next await. Node's event loop makes
    // this the single winner when two devices submit the correct code together.
    if (this.pairingState() !== "ready") {
      return sendHtml(response, 409, renderPairingPage(this.pairingState()));
    }
    this.pairingConsumed = true;
    this.incorrectPairingAttempts = [];

    const token = this.options.createSessionToken();
    if (typeof token !== "string" || token.length < 32 || token.length > 512) {
      throw new TypeError("Setup session token must contain 32 to 512 characters");
    }
    const ttlMs = this.options.sessionTtlMs ?? 12 * 60 * 60 * 1_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60 * 1_000) {
      throw new TypeError("Setup session lifetime must be between one minute and one day");
    }
    try {
      await this.options.setupDrafts.establishSession({
        sessionToken: token,
        sessionExpiresAt: new Date(this.now().getTime() + ttlMs),
      });
    } catch (error) {
      this.pairingConsumed = false;
      throw error;
    }
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
    const result = await this.options.setupDrafts.probeModel({
      sessionToken,
      expectedRevision: revision,
      provider,
      modelId,
      ...(rawBaseURL === "" ? {} : { baseURL: rawBaseURL }),
      apiKey,
    });
    if (result.status === "ready") {
      response.statusCode = 303;
      response.setHeader("location", "/setup");
      response.end();
      return;
    }
    const notice = result.status === "missing"
      ? "模型信息还不完整，请补齐后再检查。"
      : result.status === "rejected"
        ? "模型没有接受这组信息，请核对服务、模型名称和密钥。"
        : result.status === "timeout"
          ? "模型响应超时了。家庭配置没有改变，可以直接再试一次。"
          : result.status === "conflict"
            ? "模型设置已经在另一页更新，请核对后再试。"
          : "暂时连不上模型。家庭配置没有改变，请检查网络后再试。";
    return sendHtml(response, result.status === "rejected" || result.status === "missing" ? 400 : 503, renderSetupWorkspace(current, notice));
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
    const result = await this.options.setupDrafts.probeBridge({
      sessionToken,
      expectedRevision: boundedRevision(form.get("revision")),
      adapterType: boundedIdentifier(form.get("adapterType")),
      config: { baseUrl },
      credential,
    });
    if (result.status === "ready") {
      response.statusCode = 303;
      response.setHeader("location", "/setup");
      response.end();
      return;
    }
    const notice = result.status === "missing"
      ? "家庭连接信息还不完整，请补齐后再检查。"
      : result.status === "credential_rejected"
        ? "Home Assistant 没有接受这个令牌，请重新复制长期访问令牌。"
        : result.status === "timed_out"
          ? "家庭系统响应超时了。正式配置没有改变，可以直接再试一次。"
          : result.status === "incompatible"
            ? "这个地址没有返回兼容的 Home Assistant 数据。"
            : result.status === "conflict"
              ? "家庭连接已经在另一页更新，请核对后再试。"
              : "暂时连不上家庭系统。正式配置没有改变，请检查地址和网络。";
    return sendHtml(response, result.status === "credential_rejected" || result.status === "missing" || result.status === "incompatible" ? 400 : 503, renderSetupWorkspace(current, notice));
  }

  private pairingState(): "ready" | "expired" | "used" {
    if (this.pairingConsumed) return "used";
    return this.now().getTime() >= this.options.pairingExpiresAt.getTime() ? "expired" : "ready";
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

function renderPairingPage(state: "ready" | "incorrect" | "expired" | "used"): string {
  const feedback = state === "incorrect"
    ? '<p class="notice" role="alert">配对码没有对上，请看一眼启动 hob 的终端。</p>'
    : state === "expired"
      ? '<p class="notice" role="alert">配对码已过期。重新启动 hob 后，会生成一个新码。</p>'
      : state === "used"
        ? '<p class="notice" role="status">这枚配对码已经用过。请回到刚才连接的设备继续。</p>'
        : "";
  const form = state === "ready" || state === "incorrect"
    ? `<form method="post" action="/setup/pair" class="pairing-form">
        <label for="pairing-code">配对码</label>
        <input id="pairing-code" name="code" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="32" required autofocus>
        <button type="submit">连接这台设备</button>
      </form>`
    : "";
  return documentShell("开始设置", `
    <section class="welcome-card" aria-labelledby="setup-title">
      <div class="hob-mark" aria-hidden="true">h</div>
      <p class="eyebrow">欢迎回家</p>
      <h1 id="setup-title">先连接你的私人设备</h1>
      <p class="lead">在启动 hob 的终端里找到配对码，输入后即可继续设置。配对码只在本机显示一次。</p>
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

function renderSetupWorkspace(draft: ProductSetupDraftProjection, notice?: string): string {
  if (draft.stage === "map") return renderMapStep(draft, notice);
  if (draft.stage === "bridge") return renderBridgeStep(draft, notice);
  if (draft.stage === "model") return renderModelStep(draft, notice);
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

function renderModelStep(draft: ProductSetupDraftProjection, notice?: string): string {
  return documentShell("连接模型", `
    <section class="workspace" aria-labelledby="workspace-title">
      <header>
        <div class="hob-mark" aria-hidden="true">h</div>
        <div><p class="eyebrow success">身份已保存</p><h1 id="workspace-title">连接模型</h1></div>
      </header>
      <p class="lead">${escapeHtml(draft.agentName ?? "hob")}已经记住${escapeHtml(draft.householdName ?? "这个家")}。下一步选择模型服务并完成一次真实连接检查。</p>
      ${notice === undefined ? "" : `<p class="notice" role="alert">${escapeHtml(notice)}</p>`}
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

function renderBridgeStep(draft: ProductSetupDraftProjection, notice?: string): string {
  return documentShell("接入家庭", `
    <section class="workspace" aria-labelledby="workspace-title">
      <header>
        <div class="hob-mark" aria-hidden="true">h</div>
        <div><p class="eyebrow success">模型已连接</p><h1 id="workspace-title">接入家庭</h1></div>
      </header>
      <p class="lead">${escapeHtml(draft.agentName ?? "hob")}已经通过 ${escapeHtml(draft.model?.modelId ?? "所选模型")} 完成连接检查。现在连接现有的家庭系统，先做只读核对。</p>
      ${notice === undefined ? "" : `<p class="notice" role="alert">${escapeHtml(notice)}</p>`}
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

function renderMapStep(draft: ProductSetupDraftProjection, notice?: string): string {
  const summary = draft.bridge?.summary;
  return documentShell("确认家庭地图", `
    <section class="workspace" aria-labelledby="workspace-title">
      <header>
        <div class="hob-mark" aria-hidden="true">h</div>
        <div><p class="eyebrow success">家庭连接已验证</p><h1 id="workspace-title">确认家庭地图</h1></div>
      </header>
      <p class="lead">${escapeHtml(draft.agentName ?? "hob")}已经从 ${escapeHtml(draft.bridge?.label ?? "家庭系统")} 完成一次只读同步。</p>
      ${notice === undefined ? "" : `<p class="notice" role="alert">${escapeHtml(notice)}</p>`}
      <div class="map-summary" role="status">
        <div><strong>${summary?.devices ?? 0}</strong><span>个设备</span></div>
        <div><strong>${summary?.areas ?? 0}</strong><span>个空间</span></div>
        <div><strong>${summary?.states ?? 0}</strong><span>条当前状态</span></div>
      </div>
      <p class="privacy-note">这只是连接摘要。下一步会用真实设备与空间生成可核对的家庭地图，再由你决定是否启用。</p>
    </section>`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

const SETUP_CSS = `
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;background:#f5f5f7;color:#1d1d1f;font-synthesis:none}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f5f5f7}.setup-shell{min-height:100vh;display:grid;place-items:center;padding:clamp(1rem,4vw,3rem)}
.welcome-card,.workspace{width:min(100%,46rem);background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:2rem;padding:clamp(1.5rem,5vw,3.5rem);box-shadow:0 1.5rem 4rem rgba(0,0,0,.08)}
.hob-mark{display:grid;place-items:center;width:3rem;height:3rem;border-radius:1rem;background:#1d1d1f;color:#fff;font-size:1.6rem;font-weight:650;letter-spacing:-.06em;margin-bottom:2rem}
.workspace header{display:flex;gap:1rem;align-items:center}.workspace header .hob-mark{margin:0}.eyebrow{margin:0 0 .45rem;font-size:.82rem;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:#6e6e73}.eyebrow.success{color:#237a45}
h1{margin:0;font-size:clamp(2rem,7vw,3.5rem);line-height:1.04;letter-spacing:-.045em;font-weight:650;text-wrap:balance}.workspace h1{font-size:clamp(1.8rem,5vw,3rem)}
.lead{margin:1.25rem 0 2rem;color:#515154;font-size:1.08rem;line-height:1.6;max-width:38rem}.pairing-form{display:grid;gap:.75rem;margin-top:1.5rem}.pairing-form label{font-weight:600}
input,select{width:100%;min-height:3.5rem;border:1px solid #a1a1a6;border-radius:.9rem;background:#fff;color:#1d1d1f;padding:.8rem 1rem;font:inherit;font-size:1rem;outline:none}#pairing-code{text-transform:uppercase;letter-spacing:.06em}input:focus-visible,select:focus-visible{border-color:#0066cc;box-shadow:0 0 0 .25rem rgba(0,102,204,.18)}label small{font-weight:400;color:#6e6e73}.probe-status:empty{display:none}
a{color:#0066cc;text-underline-offset:.18em}
button{min-height:3.5rem;border:0;border-radius:999px;background:#0071e3;color:#fff;padding:.8rem 1.25rem;font:inherit;font-weight:650;cursor:pointer}button:hover{background:#0077ed}button:active{transform:scale(.985)}button:focus-visible{outline:.2rem solid #0066cc;outline-offset:.2rem}
.notice{border-radius:1rem;background:#fff3cd;color:#654d03;padding:1rem;line-height:1.45}.privacy-note,.handoff-note{margin:1.5rem 0 0;color:#6e6e73;font-size:.88rem;line-height:1.5}
.model-intro{padding:1.15rem;border-radius:1.15rem;background:#f5faff;border:1px solid rgba(0,113,227,.25);line-height:1.5}.model-intro p{margin:.4rem 0 0;color:#515154}.quiet-action{margin-top:1rem}
.map-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem}.map-summary div{display:grid;gap:.25rem;padding:1rem;border-radius:1rem;background:#f5f5f7}.map-summary strong{font-size:1.8rem;letter-spacing:-.04em}.map-summary span{color:#6e6e73;font-size:.85rem}
.setup-steps{display:grid;gap:.75rem;list-style:none;padding:0;margin:0}.setup-steps li{display:grid;grid-template-columns:2.25rem 1fr auto;gap:1rem;align-items:start;padding:1rem;border:1px solid rgba(0,0,0,.08);border-radius:1.15rem;color:#6e6e73}.setup-steps li>span{display:grid;place-items:center;width:2.25rem;height:2.25rem;border-radius:50%;background:#e8e8ed;color:#515154;font-weight:650}.setup-steps strong{color:#1d1d1f}.setup-steps p{margin:.25rem 0 0;font-size:.9rem;line-height:1.4}.setup-steps b{font-size:.78rem;color:#0066cc}.setup-steps .current{border-color:rgba(0,113,227,.35);background:#f5faff}.setup-steps .current>span{background:#0071e3;color:#fff}
@media(max-width:35rem){.setup-shell{place-items:start center;padding:0}.welcome-card,.workspace{min-height:100vh;border:0;border-radius:0;padding:2rem 1.25rem;box-shadow:none}.setup-steps li{grid-template-columns:2.25rem 1fr}.setup-steps b{grid-column:2}.map-summary{grid-template-columns:1fr}}
@media(prefers-reduced-motion:no-preference){button{transition:background-color .2s ease,transform .12s ease}}
@media(prefers-contrast:more){.welcome-card,.workspace,.setup-steps li,input{border-width:2px;border-color:currentColor}}
@media(prefers-color-scheme:dark){:root,body{background:#000;color:#f5f5f7}.welcome-card,.workspace{background:#1c1c1e;border-color:#3a3a3c}.hob-mark{background:#f5f5f7;color:#1d1d1f}.lead,.privacy-note,.handoff-note,.setup-steps li{color:#aeaeb2}.setup-steps strong,h1{color:#f5f5f7}.setup-steps li{border-color:#3a3a3c}.setup-steps .current{background:#101c29;border-color:#0a84ff}.setup-steps li>span{background:#3a3a3c;color:#f5f5f7}input,select{background:#2c2c2e;color:#f5f5f7;border-color:#636366}.notice{background:#493b14;color:#ffdf7e}.model-intro{background:#101c29}.model-intro p{color:#aeaeb2}.map-summary div{background:#2c2c2e}.map-summary span{color:#aeaeb2}}
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
`;
