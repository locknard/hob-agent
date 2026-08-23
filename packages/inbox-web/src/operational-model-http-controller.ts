import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { InboxReviewActor } from "./proposal-inbox-service.js";
import type { ProductOperationalModel, ProductOperationalModelNotice } from "./product-shell.js";

export type OperationalModelStatus = "active" | "degraded" | "retrying" | "switching";

/** Narrow local port: the Hub owns credential retention, probe, CAS, and activation. */
export interface OperationalModelSettingsPort {
  projection(): Promise<{
    readonly status: OperationalModelStatus;
    readonly generation: number;
    readonly configured: true;
    readonly modelReference: string;
    readonly modelBaseURL?: string;
    readonly credentialConfigured: boolean;
  }>;
  configure(input: {
    readonly expectedGeneration: number;
    readonly provider: "custom";
    readonly modelId: string;
    readonly apiKey: string;
    readonly baseURL: string;
    readonly signal?: AbortSignal;
  }): Promise<
    | { readonly status: "configured"; readonly generation: number }
    | { readonly status: "cancelled" | "busy" | "conflict" | "unavailable" }
    | { readonly status: "probe_failed"; readonly reason: "missing_api_key" | "missing_model_id" | "missing_base_url" | "rejected" | "timed_out" | "unavailable" }
  >;
  retry(): Promise<OperationalModelStatus>;
  cancelRetry(): void;
}

export interface OperationalModelHttpControllerOptions {
  readonly settings?: OperationalModelSettingsPort;
  readonly principal?: InboxReviewActor;
  readonly origin?: () => string;
}

type SettingsAction = "configure" | "cancel-configure" | "retry" | "cancel-retry";
type ConfigurationTask = { readonly id: string; readonly startedAt: number; readonly controller: AbortController };
type RecoveryTask = { readonly id: string; readonly startedAt: number; readonly controller: AbortController; cancelRequested: boolean };
type Receipt = { readonly at: number; readonly notice: ProductOperationalModelNotice };
type CompletedTask = { readonly id: string; readonly receipt: string; readonly at: number };
type StatusTask = { readonly kind: "configuration" | "recovery"; readonly id: string };

const FORM_LIMIT = 8 * 1024;
const RECEIPT_TTL_MS = 300_000;
const MAX_COMPLETED_TASKS = 32;
const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

/** Browser transport owner for one operational-model candidate. It never stores a credential beyond the submitted task. */
export class OperationalModelHttpController {
  private configurationTask: ConfigurationTask | undefined;
  private readonly configurationCompletions = new Map<string, CompletedTask>();
  private recoveryTask: RecoveryTask | undefined;
  private readonly recoveryCompletions = new Map<string, CompletedTask>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly backgroundWork = new Set<Promise<void>>();
  private readonly activeSettingsActions = new Set<Promise<void>>();
  private disposed = false;

  constructor(private readonly options: OperationalModelHttpControllerOptions) {}

  static settingsAction(value: string | undefined): SettingsAction | undefined {
    return value === "configure" || value === "cancel-configure" || value === "retry" || value === "cancel-retry" ? value : undefined;
  }

  async settingsContext(notice?: ProductOperationalModelNotice): Promise<ProductOperationalModel | undefined> {
    const settings = this.options.settings;
    if (settings === undefined) return undefined;
    try {
      const projection = normalizeProjection(await settings.projection());
      if (projection === undefined) return undefined;
      const configurationPending = this.configurationTask;
      const recoveryPending = this.recoveryTask;
      return {
        ...projection,
        ...(notice === undefined ? {} : { notice }),
        ...(configurationPending === undefined ? {} : { configurationPending: { id: configurationPending.id, startedAt: configurationPending.startedAt } }),
        ...(recoveryPending === undefined ? {} : { recoveryPending: { id: recoveryPending.id, startedAt: recoveryPending.startedAt } }),
      };
    } catch {
      return undefined;
    }
  }

  consumeSettingsReceipt(token: string | null): ProductOperationalModelNotice | undefined {
    if (token === null || !/^[a-f0-9]{32}$/u.test(token)) return undefined;
    const receipt = this.receipts.get(token);
    if (receipt === undefined) return undefined;
    this.receipts.delete(token);
    return Date.now() - receipt.at <= RECEIPT_TTL_MS ? receipt.notice : undefined;
  }

  cancelConfigurationForDispose(): void {
    void this.dispose();
  }

  /** Stops HTTP-owned work and waits for the Hub operation to reach a terminal result. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.configurationTask?.controller.abort();
    if (this.recoveryTask !== undefined) {
      this.recoveryTask.cancelRequested = true;
      this.recoveryTask.controller.abort();
    }
    try {
      this.options.settings?.cancelRetry();
    } catch {
      // The Hub remains authoritative for a failed cancellation.
    }
    await Promise.all([...this.activeSettingsActions]);
    await Promise.all([...this.backgroundWork]);
    this.configurationCompletions.clear();
    this.recoveryCompletions.clear();
    this.receipts.clear();
  }

  async handleSettingsAction(request: IncomingMessage, response: ServerResponse, action: SettingsAction): Promise<void> {
    if (this.disposed) {
      request.resume();
      return send(response, 503, "家庭助手模型设置已停止，请重新打开家庭控制台后继续。");
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

  private async performSettingsAction(request: IncomingMessage, response: ServerResponse, action: SettingsAction): Promise<void> {
    const settings = this.options.settings;
    if (settings === undefined) return send(response, 503, "家庭助手模型设置暂时不可用。家庭状态、活动记录和设置仍然可用。");
    if (!canConfigure(this.options.principal)) return send(response, 403, "家庭助手模型设置需要通过已绑定的私人设备打开。");
    if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") return send(response, 415, "请使用设置页面提交家庭助手模型设置。");
    let body: string;
    try {
      body = await readBody(request);
    } catch {
      return send(response, 400, "家庭助手模型设置请求无效。");
    }
    if (this.disposed) return send(response, 503, "家庭助手模型设置已停止，请重新打开家庭控制台后继续。");
    if (action === "cancel-configure") {
      const id = configurationId(body);
      if (id === undefined) return send(response, 400, "家庭助手模型设置请求无效。");
      const task = this.configurationTask;
      if (task === undefined || task.id !== id) return this.redirectReceipt(response, statusNotice("这次检查已经结束，请查看当前设置。"));
      task.controller.abort();
      return redirect(response, "/settings#operational-model");
    }
    if (this.configurationTask !== undefined || (this.recoveryTask !== undefined && action !== "cancel-retry")) return this.redirectReceipt(response, statusNotice("家庭助手模型正在处理设置，请稍候再查看。"));
    if (action === "configure") {
      const input = configureInput(body);
      if (input === undefined) return send(response, 400, "家庭助手模型设置请求无效。");
      this.startConfiguration(settings, input);
      return redirect(response, "/settings#operational-model");
    }
    const expectedGeneration = expectedGenerationInput(body);
    if (expectedGeneration === undefined) return send(response, 400, "家庭助手模型设置请求无效。");
    const projection = await this.projection(settings);
    if (projection === undefined) return this.redirectReceipt(response, statusNotice("家庭助手模型暂时不可用。家庭状态和历史记录仍然可用。"));
    if (projection.generation !== expectedGeneration) return this.redirectReceipt(response, configurationAttention("模型设置已经更新，请查看当前设置后再继续。"));
    if (action === "retry") {
      this.startRecovery(settings);
      return redirect(response, "/settings#operational-model");
    }
    const recovery = this.recoveryTask;
    if (recovery === undefined) return this.redirectReceipt(response, statusNotice("这次恢复已经结束，请查看当前设置。"));
    recovery.cancelRequested = true;
    recovery.controller.abort();
    try {
      settings.cancelRetry();
    } catch {
      return this.redirectReceipt(response, statusNotice("家庭助手模型暂时不可用。家庭状态和历史记录仍然可用。"));
    }
    return redirect(response, "/settings#operational-model");
  }

  sendConfigurationStatus(request: IncomingMessage, response: ServerResponse): void {
    if (this.options.settings === undefined) return send(response, 503, "家庭助手模型设置暂时不可用。");
    if (!canConfigure(this.options.principal)) return send(response, 403, "家庭助手模型设置需要通过已绑定的私人设备打开。");
    if (request.headers.origin !== undefined && request.headers.origin !== this.options.origin?.()) return send(response, 403, "请从家庭控制台继续查看模型设置。");
    const requested = statusTaskFromRequest(request);
    if (requested === undefined) return send(response, 400, "家庭助手模型设置请求无效。");
    this.pruneCompletions();
    const task = this.configurationTask;
    if (requested.kind === "configuration" && task?.id === requested.id) {
      return sendJson(response, 200, { status: "pending", configurationId: task.id });
    }
    const recovery = this.recoveryTask;
    if (requested.kind === "recovery" && recovery?.id === requested.id) {
      return sendJson(response, 200, { status: "pending", recoveryId: recovery.id });
    }
    const completion = (requested.kind === "configuration" ? this.configurationCompletions : this.recoveryCompletions).get(requested.id);
    if (completion !== undefined) {
      return sendJson(response, 200, requested.kind === "configuration"
        ? { status: "completed", configurationId: completion.id, receipt: completion.receipt }
        : { status: "completed", recoveryId: completion.id, receipt: completion.receipt });
    }
    return sendJson(response, 200, requested.kind === "configuration"
      ? { status: "idle", configurationId: requested.id }
      : { status: "idle", recoveryId: requested.id });
  }

  private startConfiguration(settings: OperationalModelSettingsPort, input: Omit<Parameters<OperationalModelSettingsPort["configure"]>[0], "signal">): void {
    const task: ConfigurationTask = { id: randomBytes(16).toString("hex"), startedAt: Date.now(), controller: new AbortController() };
    this.configurationTask = task;
    const work = (async () => {
      let result: Awaited<ReturnType<OperationalModelSettingsPort["configure"]>>;
      try {
        result = await settings.configure({ ...input, signal: task.controller.signal });
      } catch {
        result = { status: "unavailable" };
      }
      if (this.configurationTask !== task || this.disposed) return;
      this.configurationTask = undefined;
      const receipt = this.createReceipt(configureNotice(result));
      this.recordCompletion(this.configurationCompletions, { id: task.id, receipt, at: Date.now() });
    })();
    this.trackBackgroundWork(work);
  }

  private startRecovery(settings: OperationalModelSettingsPort): void {
    const task: RecoveryTask = { id: randomBytes(16).toString("hex"), startedAt: Date.now(), controller: new AbortController(), cancelRequested: false };
    this.recoveryTask = task;
    const work = this.completeRecovery(settings, task);
    this.trackBackgroundWork(work);
  }

  private async completeRecovery(settings: OperationalModelSettingsPort, task: RecoveryTask): Promise<void> {
    let status: OperationalModelStatus;
    try {
      status = await settings.retry();
    } catch {
      status = "degraded";
    }
    status = await this.waitForTerminalRecovery(settings, task, status);
    if (this.recoveryTask !== task || this.disposed) return;
    this.recoveryTask = undefined;
    const receipt = this.createReceipt(recoveryNotice(status, task.cancelRequested));
    this.recordCompletion(this.recoveryCompletions, { id: task.id, receipt, at: Date.now() });
  }

  private async waitForTerminalRecovery(settings: OperationalModelSettingsPort, task: RecoveryTask, status: OperationalModelStatus): Promise<OperationalModelStatus> {
    while (status === "retrying" || status === "switching") {
      if (task.controller.signal.aborted) return "degraded";
      try {
        const projection = await this.projection(settings);
        status = projection?.status ?? "degraded";
      } catch {
        return "degraded";
      }
      if (status === "retrying" || status === "switching") await waitForRecoveryPoll(task.controller.signal);
    }
    return status;
  }

  private async projection(settings: OperationalModelSettingsPort): Promise<ProductOperationalModel | undefined> {
    try {
      return normalizeProjection(await settings.projection());
    } catch {
      return undefined;
    }
  }

  private redirectReceipt(response: ServerResponse, notice: ProductOperationalModelNotice): void {
    redirect(response, `/settings?model=${this.createReceipt(notice)}#operational-model`);
  }

  private createReceipt(notice: ProductOperationalModelNotice): string {
    this.pruneReceipts();
    const token = randomBytes(16).toString("hex");
    this.receipts.set(token, { at: Date.now(), notice });
    return token;
  }

  private pruneReceipts(): void {
    const now = Date.now();
    for (const [token, receipt] of this.receipts) if (now - receipt.at > RECEIPT_TTL_MS) this.receipts.delete(token);
    while (this.receipts.size > 32) {
      const token = this.receipts.keys().next().value;
      if (token === undefined) break;
      this.receipts.delete(token);
    }
  }

  private recordCompletion(target: Map<string, CompletedTask>, completion: CompletedTask): void {
    this.pruneCompletions();
    target.set(completion.id, completion);
    while (target.size > MAX_COMPLETED_TASKS) {
      const oldest = target.keys().next().value;
      if (oldest === undefined) return;
      target.delete(oldest);
    }
  }

  private pruneCompletions(): void {
    const cutoff = Date.now() - RECEIPT_TTL_MS;
    for (const target of [this.configurationCompletions, this.recoveryCompletions]) {
      for (const [id, completion] of target) if (completion.at < cutoff) target.delete(id);
    }
  }

  private trackBackgroundWork(work: Promise<void>): void {
    const settled = work.catch(() => undefined).finally(() => this.backgroundWork.delete(settled));
    this.backgroundWork.add(settled);
  }
}

function canConfigure(principal: InboxReviewActor | undefined): principal is InboxReviewActor {
  return principal?.present === true && principal.device.kind === "private" && principal.device.boundPrincipalId === principal.principalId;
}
function mediaType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > FORM_LIMIT) throw new Error("too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function expectedGenerationInput(body: string): number | undefined {
  const form = new URLSearchParams(body);
  return [...form.keys()].some((key) => key !== "expectedGeneration") || form.getAll("expectedGeneration").length !== 1 ? undefined : positiveInteger(form.get("expectedGeneration"));
}
function configurationId(body: string): string | undefined {
  const form = new URLSearchParams(body);
  const value = form.get("configurationId");
  return [...form.keys()].some((key) => key !== "configurationId") || form.getAll("configurationId").length !== 1 || value === null || !/^[a-f0-9]{32}$/u.test(value) ? undefined : value;
}
function statusTaskFromRequest(request: IncomingMessage): StatusTask | undefined {
  const query = new URL(request.url ?? "/", "http://localhost").searchParams;
  const configurationId = query.get("configurationId");
  const recoveryId = query.get("recoveryId");
  if (configurationId !== null && recoveryId === null && query.size === 1 && isTaskId(configurationId)) {
    return { kind: "configuration", id: configurationId };
  }
  if (recoveryId !== null && configurationId === null && query.size === 1 && isTaskId(recoveryId)) {
    return { kind: "recovery", id: recoveryId };
  }
  return undefined;
}
function isTaskId(value: string): boolean {
  return /^[a-f0-9]{32}$/u.test(value);
}
function configureInput(body: string): Omit<Parameters<OperationalModelSettingsPort["configure"]>[0], "signal"> | undefined {
  const form = new URLSearchParams(body);
  const keys = ["expectedGeneration", "provider", "modelId", "baseURL", "apiKey"];
  if ([...form.keys()].some((key) => !keys.includes(key)) || keys.some((key) => form.getAll(key).length !== 1)) return undefined;
  const expectedGeneration = positiveInteger(form.get("expectedGeneration"));
  const modelId = requiredText(form.get("modelId"), 256);
  const baseURL = requiredText(form.get("baseURL"), 2_048);
  const apiKey = password(form.get("apiKey"));
  return expectedGeneration === undefined || form.get("provider") !== "custom" || modelId === undefined || baseURL === undefined || apiKey === undefined ? undefined : { expectedGeneration, provider: "custom", modelId, baseURL, apiKey };
}
function positiveInteger(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}
function requiredText(value: string | null, maximum: number): string | undefined {
  return value === null || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)
    ? undefined
    : value;
}
function password(value: string | null): string | undefined {
  return value === null || value.length > 16_384 || value.includes("\u0000") ? undefined : value;
}
function normalizeProjection(value: unknown): ProductOperationalModel | undefined {
  if (!record(value) || !validStatus(value.status) || value.configured !== true || !positiveNumber(value.generation) || typeof value.modelReference !== "string" || typeof value.credentialConfigured !== "boolean") return undefined;
  const match = /^(custom|gpt|claude|deepseek|kimi|glm)\/([^\u0000-\u001f\u007f]{1,256})$/u.exec(value.modelReference);
  if (match === null || (value.modelBaseURL !== undefined && (typeof value.modelBaseURL !== "string" || value.modelBaseURL.length === 0 || value.modelBaseURL.length > 2_048))) return undefined;
  return {
    status: value.status,
    generation: value.generation,
    configured: true,
    provider: match[1]!,
    modelId: match[2]!,
    ...(value.modelBaseURL === undefined ? {} : { baseURL: value.modelBaseURL }),
    credentialConfigured: value.credentialConfigured,
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function validStatus(value: unknown): value is OperationalModelStatus {
  return value === "active" || value === "degraded" || value === "retrying" || value === "switching";
}
function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
function statusNotice(message: string): ProductOperationalModelNotice {
  return { kind: "status", message };
}
function configurationAttention(message: string): ProductOperationalModelNotice {
  return { kind: "configuration_attention", message };
}
function configureNotice(result: Awaited<ReturnType<OperationalModelSettingsPort["configure"]>>): ProductOperationalModelNotice {
  if (result.status === "configured") return statusNotice("家庭助手模型已检查并启用。");
  if (result.status === "cancelled") return statusNotice("已停止这次检查，原来的家庭助手模型保持不变。");
  if (result.status === "busy") return statusNotice("家庭助手模型正在检查，请稍候再查看。");
  if (result.status === "conflict") return configurationAttention("模型设置已经更新，请查看当前设置后再继续。");
  if (result.status === "probe_failed" && result.reason === "missing_api_key") return configurationAttention("请填写访问密钥，或在相同地址下留空以保留现有密钥。");
  if (result.status === "probe_failed" && result.reason === "missing_model_id") return configurationAttention("请填写要使用的模型名称。");
  if (result.status === "probe_failed" && result.reason === "missing_base_url") return configurationAttention("请填写 OpenAI 兼容接口地址。");
  if (result.status === "probe_failed" && result.reason === "rejected") return configurationAttention("模型服务未接受访问密钥，请更新后再试。");
  if (result.status === "probe_failed" && result.reason === "timed_out") return configurationAttention("模型服务响应较慢，请稍后再试。");
  return configurationAttention("家庭助手模型暂时不可用。家庭状态、活动记录和设置仍然可用。");
}
function recoveryNotice(status: OperationalModelStatus, cancelled: boolean): ProductOperationalModelNotice {
  if (cancelled) return statusNotice("已停止这次恢复。原来的家庭助手模型保持不变。");
  if (status === "active") return statusNotice("家庭助手模型已恢复。现在可以继续提问和查看建议。");
  if (status === "retrying" || status === "switching") return statusNotice("家庭助手模型仍在恢复。家庭状态、活动记录和设置仍然可用。");
  return statusNotice("家庭助手模型仍不可用。家庭状态、活动记录和设置仍然可用。");
}
function waitForRecoveryPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, 100);
    signal.addEventListener("abort", finish, { once: true });
  });
}
function applyHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
}
function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 303;
  applyHeaders(response);
  response.setHeader("location", location);
  response.end();
}
function send(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  applyHeaders(response);
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
}
function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.statusCode = status;
  applyHeaders(response);
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
