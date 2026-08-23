import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { OperationalModelHttpController, type OperationalModelSettingsPort } from "./operational-model-http-controller.js";

const privatePrincipal = {
  principalId: "member-1",
  present: true,
  device: { kind: "private" as const, boundPrincipalId: "member-1" },
};

class Settings implements OperationalModelSettingsPort {
  readonly inputs: unknown[] = [];
  configureResult: Awaited<ReturnType<OperationalModelSettingsPort["configure"]>> = { status: "configured", generation: 5 };
  projection() {
    return Promise.resolve({
      status: "active" as const,
      generation: 4,
      configured: true as const,
      modelReference: "custom/home-model",
      modelBaseURL: "https://models.example.test/v1",
      credentialConfigured: true,
    });
  }
  async configure(input: unknown) {
    this.inputs.push(input);
    return this.configureResult;
  }
  async retry() { return "active" as const; }
  cancelRetry() {}
}

async function withController(
  run: (origin: string, settings: Settings, controller: OperationalModelHttpController) => Promise<void>,
  settings = new Settings(),
): Promise<void> {
  let origin = "";
  const controller = new OperationalModelHttpController({ settings, principal: privatePrincipal, origin: () => origin });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/settings/model/configuration-status") return controller.sendConfigurationStatus(request, response);
    const match = /^\/settings\/model\/(configure|cancel-configure|retry|cancel-retry)$/.exec(url.pathname);
    if (request.method === "POST" && match !== null) return void controller.handleSettingsAction(request, response, OperationalModelHttpController.settingsAction(match[1])!);
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing listener address");
  origin = `http://127.0.0.1:${address.port}`;
  try { await run(origin, settings, controller); } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("starts a credential-private model check in the background and exposes a one-shot completion receipt", async () => {
  let complete: (() => void) | undefined;
  class DelayedSettings extends Settings {
    override configure(input: unknown): Promise<Awaited<ReturnType<OperationalModelSettingsPort["configure"]>>> {
      this.inputs.push(input);
      return new Promise((resolve) => { complete = () => resolve(this.configureResult); });
    }
    override cancelRetry() { complete?.(); }
  }
  await withController(async (origin, settings, controller) => {
    const apiKey = "do-not-reflect-this-key";
    const response = await fetch(`${origin}/settings/model/configure`, {
      method: "POST",
      redirect: "manual",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ expectedGeneration: "4", provider: "custom", modelId: "home-model", baseURL: "https://models.example.test/v1", apiKey }).toString(),
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/settings#operational-model");
    assert.doesNotMatch(await response.text(), new RegExp(apiKey));
    const configurationId = (await controller.settingsContext())?.configurationPending?.id;
    assert.match(configurationId ?? "", /^[a-f0-9]{32}$/);
    complete?.();

    let receipt: string | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await fetch(`${origin}/settings/model/configuration-status?configurationId=${configurationId}`, { headers: { origin } });
      const body = await status.json() as { status: string; receipt?: string };
      if (body.status === "completed") { receipt = body.receipt; break; }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    assert.match(receipt ?? "", /^[a-f0-9]{32}$/);
    assert.equal(settings.inputs.length, 1);
    assert.deepEqual({ ...(settings.inputs[0] as Record<string, unknown>), signal: undefined }, { expectedGeneration: 4, provider: "custom", modelId: "home-model", baseURL: "https://models.example.test/v1", apiKey, signal: undefined });
    assert.deepEqual(controller.consumeSettingsReceipt(receipt!), { kind: "status", message: "家庭助手模型已检查并启用。" });
    assert.equal(controller.consumeSettingsReceipt(receipt!), undefined);
  }, new DelayedSettings());
});

test("keeps a completed model task available to every tab that names its task id", async () => {
  let complete: ((value: { readonly status: "configured"; readonly generation: number }) => void) | undefined;
  class DelayedSettings extends Settings {
    override configure(): Promise<{ readonly status: "configured"; readonly generation: number }> {
      return new Promise((resolve) => { complete = resolve; });
    }
  }
  await withController(async (origin, _settings, controller) => {
    const response = await fetch(`${origin}/settings/model/configure`, {
      method: "POST",
      redirect: "manual",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        expectedGeneration: "4",
        provider: "custom",
        modelId: "home-model",
        baseURL: "https://models.example.test/v1",
        apiKey: "request-only-key",
      }).toString(),
    });
    assert.equal(response.status, 303);
    const taskId = (await controller.settingsContext())?.configurationPending?.id;
    assert.match(taskId ?? "", /^[a-f0-9]{32}$/);

    const unrelated = await fetch(`${origin}/settings/model/configuration-status?configurationId=${"f".repeat(32)}`, { headers: { origin } });
    assert.deepEqual(await unrelated.json(), { status: "idle", configurationId: "f".repeat(32) });

    const pending = await fetch(`${origin}/settings/model/configuration-status?configurationId=${taskId}`, { headers: { origin } });
    assert.deepEqual(await pending.json(), { status: "pending", configurationId: taskId });
    const duplicated = await fetch(
      `${origin}/settings/model/configuration-status?configurationId=${taskId}&configurationId=${taskId}`,
      { headers: { origin } },
    );
    assert.equal(duplicated.status, 400);
    complete?.({ status: "configured", generation: 5 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const first = await fetch(`${origin}/settings/model/configuration-status?configurationId=${taskId}`, { headers: { origin } });
    const second = await fetch(`${origin}/settings/model/configuration-status?configurationId=${taskId}`, { headers: { origin } });
    const firstResult = await first.json() as { readonly status: string; readonly configurationId?: string; readonly receipt?: string };
    const secondResult = await second.json() as { readonly status: string; readonly configurationId?: string; readonly receipt?: string };
    assert.equal(firstResult.status, "completed");
    assert.equal(secondResult.status, "completed");
    assert.equal(firstResult.configurationId, taskId);
    assert.equal(secondResult.configurationId, taskId);
    assert.equal(firstResult.receipt, secondResult.receipt);
    assert.deepEqual(controller.consumeSettingsReceipt(firstResult.receipt ?? null), { kind: "status", message: "家庭助手模型已检查并启用。" });
    assert.equal(controller.consumeSettingsReceipt(secondResult.receipt ?? null), undefined);
  }, new DelayedSettings());
});

test("marks a rejected candidate as configuration attention without using its copy as state", async () => {
  let complete: (() => void) | undefined;
  class DelayedSettings extends Settings {
    override configure(input: unknown): Promise<Awaited<ReturnType<OperationalModelSettingsPort["configure"]>>> {
      this.inputs.push(input);
      return new Promise((resolve) => { complete = () => resolve(this.configureResult); });
    }
    override cancelRetry() { complete?.(); }
  }
  await withController(async (origin, settings, controller) => {
    settings.configureResult = { status: "probe_failed", reason: "rejected" };
    const response = await fetch(`${origin}/settings/model/configure`, {
      method: "POST",
      redirect: "manual",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ expectedGeneration: "4", provider: "custom", modelId: "home-model", baseURL: "https://models.example.test/v1", apiKey: "rejected-key" }).toString(),
    });
    assert.equal(response.status, 303);
    const configurationId = (await controller.settingsContext())?.configurationPending?.id;
    assert.match(configurationId ?? "", /^[a-f0-9]{32}$/);
    complete?.();

    let receipt: string | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await fetch(`${origin}/settings/model/configuration-status?configurationId=${configurationId}`, { headers: { origin } });
      const body = await status.json() as { status: string; receipt?: string };
      if (body.status === "completed") { receipt = body.receipt; break; }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    assert.deepEqual(controller.consumeSettingsReceipt(receipt ?? null), {
      kind: "configuration_attention",
      message: "模型服务未接受访问密钥，请更新后再试。",
    });
  }, new DelayedSettings());
});

test("dispose aborts and waits for an in-flight configuration before releasing the controller", async () => {
  let resolveConfigure: ((value: { readonly status: "cancelled" }) => void) | undefined;
  class DelayedSettings extends Settings {
    aborted = false;
    override configure(input: unknown): Promise<{ readonly status: "cancelled" }> {
      const signal = (input as { readonly signal?: AbortSignal }).signal;
      signal?.addEventListener("abort", () => { this.aborted = true; });
      return new Promise((resolve) => { resolveConfigure = resolve; });
    }
  }
  const settings = new DelayedSettings();
  let origin = "";
  const controller = new OperationalModelHttpController({ settings, principal: privatePrincipal, origin: () => origin });
  const server = createServer((request, response) => controller.handleSettingsAction(request, response, "configure"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing listener address");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${origin}/settings/model/configure`, {
      method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ expectedGeneration: "4", provider: "custom", modelId: "home-model", baseURL: "https://models.example.test/v1", apiKey: "" }).toString(),
    });
    assert.equal(response.status, 303);
    let disposed = false;
    const disposal = controller.dispose().then(() => { disposed = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(settings.aborted, true);
    assert.equal(disposed, false);
    resolveConfigure?.({ status: "cancelled" });
    await disposal;
    assert.equal(disposed, true);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("dispose closes a settings request that is still reading its body before it can configure", async () => {
  const settings = new Settings();
  let origin = "";
  let acceptRequest: (() => void) | undefined;
  const accepted = new Promise<void>((resolve) => { acceptRequest = resolve; });
  const controller = new OperationalModelHttpController({ settings, principal: privatePrincipal, origin: () => origin });
  const server = createServer((request, response) => {
    acceptRequest?.();
    void controller.handleSettingsAction(request, response, "configure");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing listener address");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    let request!: ReturnType<typeof httpRequest>;
    const responseStatus = new Promise<number>((resolve, reject) => {
      request = httpRequest(`${origin}/settings/model/configure`, {
        method: "POST",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", reject);
      request.write("expectedGeneration=4&provider=custom&");
    });
    await accepted;
    const disposal = controller.dispose();
    request.end("modelId=home-model&baseURL=https%3A%2F%2Fmodels.example.test%2Fv1&apiKey=request-only");
    assert.equal(await responseStatus, 503);
    await disposal;
    assert.equal(settings.inputs.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("dispose waits for an in-flight retry after asking the Hub to cancel it", async () => {
  let resolveRetry: ((value: "degraded") => void) | undefined;
  class DelayedRetrySettings extends Settings {
    cancelCalls = 0;
    override retry(): Promise<"degraded"> { return new Promise((resolve) => { resolveRetry = resolve; }); }
    override cancelRetry() { this.cancelCalls += 1; }
  }
  const settings = new DelayedRetrySettings();
  let origin = "";
  const controller = new OperationalModelHttpController({ settings, principal: privatePrincipal, origin: () => origin });
  const server = createServer((request, response) => controller.handleSettingsAction(request, response, "retry"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing listener address");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${origin}/settings/model/retry`, { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "expectedGeneration=4" });
    assert.equal(response.status, 303);
    let disposed = false;
    const disposal = controller.dispose().then(() => { disposed = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(settings.cancelCalls, 1);
    assert.equal(disposed, false);
    resolveRetry?.("degraded");
    await disposal;
    assert.equal(disposed, true);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("keeps a retry visible until it completes with a one-shot recovery receipt", async () => {
  let resolveRetry: ((value: "active") => void) | undefined;
  class DelayedRetrySettings extends Settings {
    status: "active" | "retrying" = "active";
    override projection() {
      return Promise.resolve({
        status: this.status,
        generation: 4,
        configured: true as const,
        modelReference: "custom/home-model",
        modelBaseURL: "https://models.example.test/v1",
        credentialConfigured: true,
      });
    }
    override retry(): Promise<"active"> {
      this.status = "retrying";
      return new Promise((resolve) => { resolveRetry = (status) => { this.status = status; resolve(status); }; });
    }
  }
  const settings = new DelayedRetrySettings();
  let origin = "";
  const controller = new OperationalModelHttpController({ settings, principal: privatePrincipal, origin: () => origin });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/settings/model/configuration-status") return controller.sendConfigurationStatus(request, response);
    return void controller.handleSettingsAction(request, response, "retry");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing listener address");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    const started = await fetch(`${origin}/settings/model/retry`, {
      method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "expectedGeneration=4",
    });
    assert.equal(started.status, 303);
    const pending = await controller.settingsContext();
    assert.equal(pending?.status, "retrying");
    const recoveryId = pending?.recoveryPending?.id;
    const pendingStatus = await fetch(`${origin}/settings/model/configuration-status?recoveryId=${recoveryId}`, { headers: { origin } });
    const pendingBody = await pendingStatus.json();
    resolveRetry?.("active");
    assert.match(recoveryId ?? "", /^[a-f0-9]{32}$/);
    assert.deepEqual(pendingBody, { status: "pending", recoveryId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = await fetch(`${origin}/settings/model/configuration-status?recoveryId=${recoveryId}`, { headers: { origin } });
    const completion = await completed.json() as { status: string; recoveryId?: string; receipt?: string };
    assert.equal(completion.status, "completed");
    assert.equal(completion.recoveryId, recoveryId);
    assert.deepEqual(controller.consumeSettingsReceipt(completion.receipt ?? null), { kind: "status", message: "家庭助手模型已恢复。现在可以继续提问和查看建议。" });
  } finally {
    await controller.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("cancels the visible recovery and reports its terminal receipt", async () => {
  let resolveRetry: ((value: "degraded") => void) | undefined;
  class DelayedRetrySettings extends Settings {
    cancelCalls = 0;
    override retry(): Promise<"degraded"> { return new Promise((resolve) => { resolveRetry = resolve; }); }
    override cancelRetry() { this.cancelCalls += 1; }
  }
  const settings = new DelayedRetrySettings();
  let origin = "";
  const controller = new OperationalModelHttpController({ settings, principal: privatePrincipal, origin: () => origin });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/settings/model/configuration-status") return controller.sendConfigurationStatus(request, response);
    return void controller.handleSettingsAction(request, response, OperationalModelHttpController.settingsAction(url.pathname.split("/").at(-1))!);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing listener address");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/settings/model/retry`, { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "expectedGeneration=4" });
    const recoveryId = (await controller.settingsContext())?.recoveryPending?.id;
    assert.match(recoveryId ?? "", /^[a-f0-9]{32}$/);
    const cancellation = await fetch(`${origin}/settings/model/cancel-retry`, { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "expectedGeneration=4" });
    assert.equal(cancellation.status, 303);
    assert.equal(settings.cancelCalls, 1);
    resolveRetry?.("degraded");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = await fetch(`${origin}/settings/model/configuration-status?recoveryId=${recoveryId}`, { headers: { origin } });
    const completion = await completed.json() as { status: string; receipt?: string };
    assert.equal(completion.status, "completed");
    assert.deepEqual(controller.consumeSettingsReceipt(completion.receipt ?? null), { kind: "status", message: "已停止这次恢复。原来的家庭助手模型保持不变。" });
  } finally {
    await controller.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("continues polling an already-running recovery until the Hub reaches a terminal state", async () => {
  class InFlightSettings extends Settings {
    status: "active" | "retrying" = "active";
    override projection() {
      return Promise.resolve({
        status: this.status,
        generation: 4,
        configured: true as const,
        modelReference: "custom/home-model",
        modelBaseURL: "https://models.example.test/v1",
        credentialConfigured: true,
      });
    }
    override async retry() {
      this.status = "retrying";
      return "retrying" as const;
    }
  }
  const settings = new InFlightSettings();
  let origin = "";
  const controller = new OperationalModelHttpController({ settings, principal: privatePrincipal, origin: () => origin });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/settings/model/configuration-status") return controller.sendConfigurationStatus(request, response);
    return void controller.handleSettingsAction(request, response, "retry");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing listener address");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/settings/model/retry`, { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "expectedGeneration=4" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const recoveryId = (await controller.settingsContext())?.recoveryPending?.id;
    assert.match(recoveryId ?? "", /^[a-f0-9]{32}$/);
    settings.status = "active";
    let receipt: string | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await fetch(`${origin}/settings/model/configuration-status?recoveryId=${recoveryId}`, { headers: { origin } });
      const body = await status.json() as { readonly status: string; readonly receipt?: string };
      if (body.status === "completed") { receipt = body.receipt; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(controller.consumeSettingsReceipt(receipt ?? null), { kind: "status", message: "家庭助手模型已恢复。现在可以继续提问和查看建议。" });
  } finally {
    await controller.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("projects an existing non-custom active model while keeping custom as the only editable entry", async () => {
  const settings: OperationalModelSettingsPort = {
    async projection() { return { status: "active", generation: 4, configured: true, modelReference: "gpt/gpt-5", credentialConfigured: true }; },
    async configure() { return { status: "unavailable" }; },
    async retry() { return "active"; },
    cancelRetry() {},
  };
  const controller = new OperationalModelHttpController({ settings, principal: privatePrincipal });
  const projection = await controller.settingsContext();
  assert.deepEqual(projection, { status: "active", generation: 4, configured: true, provider: "gpt", modelId: "gpt-5", credentialConfigured: true });
});
