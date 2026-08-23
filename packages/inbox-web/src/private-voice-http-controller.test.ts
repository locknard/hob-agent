import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { PrivateVoiceHttpController } from "./private-voice-http-controller.js";

const privatePrincipal = {
  principalId: "member-1",
  present: true,
  device: { kind: "private" as const, boundPrincipalId: "member-1" },
};

class VoiceSettings {
  status: "active" | "degraded" | "retrying" = "degraded";

  projection() {
    return Promise.resolve({
      status: this.status,
      generation: 4,
      configured: true as const,
      asr: {
        transport: "wyoming" as const,
        endpoint: "tcp://127.0.0.1:10300",
        credentialConfigured: false,
      },
      tts: {
        transport: "wyoming" as const,
        endpoint: "tcp://127.0.0.1:10200",
        locale: "zh-CN",
        credentialConfigured: false,
      },
    });
  }

  async configure() { return { status: "unavailable" as const }; }
  async disable() { return { status: "unavailable" as const }; }
  async retry() { return "active" as const; }
  cancelRetry() {}
}

async function withSettingsController(
  settings: VoiceSettings,
  run: (
    origin: string,
    controller: PrivateVoiceHttpController,
  ) => Promise<void>,
): Promise<void> {
  let origin = "";
  const controller = new PrivateVoiceHttpController({
    voiceSettings: settings,
    principal: privatePrincipal,
    origin: () => origin,
    productAdviceTurn: async () => undefined,
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/settings/private-voice/configuration-status")
      return controller.sendConfigurationStatus(request, response);
    const match = /^\/settings\/private-voice\/(retry|cancel-retry)$/.exec(url.pathname);
    if (request.method === "POST" && match !== null)
      return void controller.handleSettingsAction(
        request,
        response,
        PrivateVoiceHttpController.settingsAction(match[1])!,
      );
    if (request.method === "POST" && url.pathname === "/voice/cancel-retry")
      return void controller.handleVoiceRetryCancel(request, response);
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("missing listener address");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    await run(origin, controller);
  } finally {
    await controller.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error)),
    );
  }
}

test("owns its contracts without importing the proposal inbox HTTP service", () => {
  const source = readFileSync(new URL("./private-voice-http-controller.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /proposal-inbox-http-service/);
});

test("leases an active private voice browser turn through the controller", async () => {
  const controller = new PrivateVoiceHttpController({
    privateVoice: {
      status: "active",
      beginTurn() {
        return {
          captureMode: "encoded_audio",
          async transcribe() { return { status: "failed" as const, reason: "unavailable" as const }; },
          async synthesize() { return { status: "failed" as const, reason: "unavailable" as const }; },
          async release() {},
        };
      },
    },
    productAdviceTurn: async () => undefined,
    privateVoiceTurnToken: () => "a".repeat(43),
  });
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/voice/turns") {
      void controller.handleVoiceTurnStart(request, response);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/voice/turns`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      status: "leased",
      voiceTurnId: "a".repeat(43),
      captureMode: "encoded_audio",
    });
  } finally {
    await controller.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("stops before ASR when the household model is unavailable and returns its own closed result", async () => {
  let transcribeCalls = 0;
  let releases = 0;
  const controller = new PrivateVoiceHttpController({
    privateVoice: {
      status: "active",
      beginTurn() {
        return {
          captureMode: "encoded_audio" as const,
          async transcribe() {
            transcribeCalls += 1;
            return { status: "transcribed" as const, text: "这句不应交给模型" };
          },
          async synthesize() { return { status: "failed" as const, reason: "unavailable" as const }; },
          async release() { releases += 1; },
        };
      },
    },
    adviceAvailability: async () => ({ status: "model_unavailable" }),
    startAdvice: async () => ({ id: "unreachable" }),
    productAdviceTurn: async () => undefined,
    privateVoiceTurnToken: () => "b".repeat(43),
  });
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/voice/turns") {
      void controller.handleVoiceTurnStart(request, response);
      return;
    }
    if (request.method === "POST" && request.url === `/voice/turns/${"b".repeat(43)}/transcribe`) {
      void controller.handleVoiceTranscription(request, response, "b".repeat(43));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const lease = await fetch(`${origin}/voice/turns`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(lease.status, 201);
    const response = await fetch(`${origin}/voice/turns/${"b".repeat(43)}/transcribe`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array([1, 2]),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "model_unavailable" });
    assert.equal(transcribeCalls, 0);
    assert.equal(releases, 1);
  } finally {
    await controller.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("runs private voice recovery in the background and publishes one completion receipt", async () => {
  let resolveRetry: ((status: "active") => void) | undefined;
  class DelayedRetrySettings extends VoiceSettings {
    override retry(): Promise<"active"> {
      this.status = "retrying";
      return new Promise((resolve) => {
        resolveRetry = (status) => {
          this.status = status;
          resolve(status);
        };
      });
    }
    override cancelRetry() { resolveRetry?.("active"); }
  }
  await withSettingsController(new DelayedRetrySettings(), async (origin, controller) => {
    const started = await fetch(`${origin}/settings/private-voice/retry`, {
      method: "POST",
      redirect: "manual",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: "expectedGeneration=4",
    });
    assert.equal(started.status, 303);
    assert.equal(started.headers.get("location"), "/settings#private-voice");

    const pending = await controller.settingsContext();
    const recoveryId = pending?.recoveryPending?.id;
    assert.match(recoveryId ?? "", /^[a-f0-9]{32}$/u);
    const status = await fetch(`${origin}/settings/private-voice/configuration-status?recoveryId=${recoveryId}`, {
      headers: { origin },
    });
    assert.deepEqual(await status.json(), { status: "pending", recoveryId });

    resolveRetry?.("active");
    let receipt: string | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const completed = await fetch(`${origin}/settings/private-voice/configuration-status?recoveryId=${recoveryId}`, {
        headers: { origin },
      });
      const body = await completed.json() as { readonly status: string; readonly receipt?: string };
      if (body.status === "completed") {
        receipt = body.receipt;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(
      controller.consumeSettingsReceipt(receipt ?? null),
      "语音已经恢复，可以继续使用。",
    );
    assert.equal(controller.consumeSettingsReceipt(receipt ?? null), undefined);
  });
});

test("keeps a completed private voice task available to every tab that names its task id", async () => {
  let resolveRetry: ((status: "active") => void) | undefined;
  class DelayedRetrySettings extends VoiceSettings {
    override retry(): Promise<"active"> {
      this.status = "retrying";
      return new Promise((resolve) => {
        resolveRetry = (status) => {
          this.status = status;
          resolve(status);
        };
      });
    }
    override cancelRetry() { resolveRetry?.("active"); }
  }
  await withSettingsController(new DelayedRetrySettings(), async (origin, controller) => {
    const started = await fetch(`${origin}/settings/private-voice/retry`, {
      method: "POST",
      redirect: "manual",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: "expectedGeneration=4",
    });
    assert.equal(started.status, 303);
    const taskId = (await controller.settingsContext())?.recoveryPending?.id;
    assert.match(taskId ?? "", /^[a-f0-9]{32}$/u);

    const unrelated = await fetch(`${origin}/settings/private-voice/configuration-status?recoveryId=${"f".repeat(32)}`, { headers: { origin } });
    assert.deepEqual(await unrelated.json(), { status: "idle", recoveryId: "f".repeat(32) });
    const pending = await fetch(`${origin}/settings/private-voice/configuration-status?recoveryId=${taskId}`, { headers: { origin } });
    assert.deepEqual(await pending.json(), { status: "pending", recoveryId: taskId });
    const duplicated = await fetch(
      `${origin}/settings/private-voice/configuration-status?recoveryId=${taskId}&recoveryId=${taskId}`,
      { headers: { origin } },
    );
    assert.equal(duplicated.status, 400);
    resolveRetry?.("active");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const first = await fetch(`${origin}/settings/private-voice/configuration-status?recoveryId=${taskId}`, { headers: { origin } });
    const second = await fetch(`${origin}/settings/private-voice/configuration-status?recoveryId=${taskId}`, { headers: { origin } });
    const firstResult = await first.json() as { readonly status: string; readonly recoveryId?: string; readonly receipt?: string };
    const secondResult = await second.json() as { readonly status: string; readonly recoveryId?: string; readonly receipt?: string };
    assert.equal(firstResult.status, "completed");
    assert.equal(secondResult.status, "completed");
    assert.equal(firstResult.recoveryId, taskId);
    assert.equal(secondResult.recoveryId, taskId);
    assert.equal(firstResult.receipt, secondResult.receipt);
    assert.equal(controller.consumeSettingsReceipt(firstResult.receipt ?? null), "语音已经恢复，可以继续使用。");
    assert.equal(controller.consumeSettingsReceipt(secondResult.receipt ?? null), undefined);
  });
});

test("cancels a visible private voice recovery and waits for it during disposal", async () => {
  let resolveRetry: ((status: "degraded") => void) | undefined;
  class DelayedRetrySettings extends VoiceSettings {
    cancelCalls = 0;

    override retry(): Promise<"degraded"> {
      return new Promise((resolve) => { resolveRetry = resolve; });
    }

    override cancelRetry() { this.cancelCalls += 1; }
  }
  const settings = new DelayedRetrySettings();
  await withSettingsController(settings, async (origin, controller) => {
    await fetch(`${origin}/settings/private-voice/retry`, {
      method: "POST",
      redirect: "manual",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: "expectedGeneration=4",
    });
    const cancelled = await fetch(`${origin}/voice/cancel-retry`, {
      method: "POST",
      redirect: "manual",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(cancelled.status, 303);
    assert.equal(settings.cancelCalls, 1);

    let disposed = false;
    const disposal = controller.dispose().then(() => { disposed = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(disposed, false);
    resolveRetry?.("degraded");
    await disposal;
    assert.equal(disposed, true);
  });
});

test("dispose waits for an accepted private voice disable before releasing the controller", async () => {
  let finishDisable: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  class DelayedDisableSettings extends VoiceSettings {
    override disable(): Promise<{ readonly status: "disabled"; readonly generation: number }> {
      markStarted?.();
      return new Promise((resolve) => {
        finishDisable = () => resolve({ status: "disabled", generation: 5 });
      });
    }
  }
  const settings = new DelayedDisableSettings();
  let origin = "";
  const controller = new PrivateVoiceHttpController({
    voiceSettings: settings,
    principal: privatePrincipal,
    origin: () => origin,
    productAdviceTurn: async () => undefined,
  });
  const server = createServer((request, response) => {
    void controller.handleSettingsAction(request, response, "disable");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing listener address");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = fetch(`${origin}/settings/private-voice/disable`, {
      method: "POST",
      redirect: "manual",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: "expectedGeneration=4&confirmDisable=confirmed",
    });
    await started;
    let disposed = false;
    const disposal = controller.dispose().then(() => { disposed = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(disposed, false);
    finishDisable?.();
    assert.equal((await response).status, 303);
    await disposal;
    assert.equal(disposed, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("dispose closes a private voice settings request still reading its body before it can configure", async () => {
  class CountingSettings extends VoiceSettings {
    configureCalls = 0;
    override async configure() {
      this.configureCalls += 1;
      return { status: "unavailable" as const };
    }
  }
  const settings = new CountingSettings();
  let origin = "";
  let acceptRequest: (() => void) | undefined;
  const accepted = new Promise<void>((resolve) => { acceptRequest = resolve; });
  const controller = new PrivateVoiceHttpController({
    voiceSettings: settings,
    principal: privatePrincipal,
    origin: () => origin,
    productAdviceTurn: async () => undefined,
  });
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
      request = httpRequest(`${origin}/settings/private-voice/configure`, {
        method: "POST",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", reject);
      request.write("expectedGeneration=4&asrTransport=wyoming&");
    });
    await accepted;
    const disposal = controller.dispose();
    request.end("asrEndpoint=wyoming%3A%2F%2F127.0.0.1%3A10300");
    assert.equal(await responseStatus, 503);
    await disposal;
    assert.equal(settings.configureCalls, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("shares one voice-page recovery with settings observation and cancellation", async () => {
  let status: "degraded" | "retrying" = "degraded";
  let resolveRetry: (() => void) | undefined;
  let voiceCancellations = 0;
  const settings = new VoiceSettings();
  let origin = "";
  const controller = new PrivateVoiceHttpController({
    voiceSettings: settings,
    principal: privatePrincipal,
    origin: () => origin,
    privateVoice: {
      get status() { return status; },
      beginTurn() { return undefined; },
      retry() {
        status = "retrying";
        return new Promise<void>((resolve) => { resolveRetry = resolve; });
      },
      cancelRetry() { voiceCancellations += 1; },
    },
    productAdviceTurn: async () => undefined,
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "POST" && url.pathname === "/voice/retry")
      return void controller.handleRetry(request, response);
    if (request.method === "POST" && url.pathname === "/settings/private-voice/cancel-retry")
      return void controller.handleSettingsAction(request, response, "cancel-retry");
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("missing listener address");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    const retry = await fetch(`${origin}/voice/retry`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(retry.headers.get("location"), "/voice");
    const pending = await controller.settingsContext();
    assert.match(pending?.recoveryPending?.id ?? "", /^[a-f0-9]{32}$/u);

    const cancelled = await fetch(`${origin}/settings/private-voice/cancel-retry`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "expectedGeneration=4",
    });
    assert.equal(cancelled.headers.get("location"), "/settings#private-voice");
    assert.equal(voiceCancellations, 1);
    resolveRetry?.();
  } finally {
    await controller.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error)),
    );
  }
});
