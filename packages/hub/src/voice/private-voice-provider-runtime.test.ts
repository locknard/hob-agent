import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Server } from "node:net";
import test from "node:test";

import {
  PrivateVoiceProviderRuntime,
  type PrivateVoiceProviderRuntimeStatus,
} from "./private-voice-provider-runtime.js";

async function withVoiceServer(
  operation: (baseUrl: string, requests: Array<{ readonly path: string; readonly authorization?: string; readonly body: string }>) => Promise<void>,
): Promise<void> {
  const requests: Array<{ readonly path: string; readonly authorization?: string; readonly body: string }> = [];
  const server = createServer((request, response) => { void handle(request, response, requests); });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", (error?: Error) => error === undefined ? resolve() : reject(error)));
  const address = server.address() as AddressInfo;
  try {
    await operation(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  requests: Array<{ readonly path: string; readonly authorization?: string; readonly body: string }>,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push({ path: request.url ?? "", authorization: request.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
  if (request.url === "/v1/audio/transcriptions") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ text: "打开客厅灯" }));
    return;
  }
  response.setHeader("content-type", "audio/wav");
  response.end(Buffer.from([82, 73, 70, 70]));
}

test("activates only after exact ASR and TTS OpenAI probes, then uses their selected settings", async () => {
  await withVoiceServer(async (endpoint, requests) => {
    const configuredEndpoint = `${endpoint}/v1/`;
    const reads: string[] = [];
    const runtime = new PrivateVoiceProviderRuntime({
      config: {
        asr: {
          transport: "openai_http",
          endpoint: configuredEndpoint,
          credentialRef: "keychain:hob-agent/voice:asr:runtime-test:stage-a",
          model: "whisper-local",
        },
        tts: {
          transport: "openai_http",
          endpoint: configuredEndpoint,
          credentialRef: "keychain:hob-agent/voice:tts:runtime-test:stage-a",
          model: "qwen-tts-local",
          locale: "zh-CN",
          voice: "warm",
        },
      },
      vault: {
        read: async (reference: string) => {
          reads.push(reference);
          return reference === "keychain:hob-agent/voice:asr:runtime-test:stage-a" ? "asr-private-token" : "tts-private-token";
        },
      },
    });
    try {
      const activated: PrivateVoiceProviderRuntimeStatus = await runtime.start();
      assert.deepEqual(activated, { status: "active" });
      assert.deepEqual(runtime.status, { status: "active" });
      assert.equal(runtime.captureMode, "encoded_audio");
      assert.deepEqual(reads, ["keychain:hob-agent/voice:asr:runtime-test:stage-a", "keychain:hob-agent/voice:tts:runtime-test:stage-a"]);
      assert.deepEqual(await runtime.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" }), {
        status: "transcribed",
        text: "打开客厅灯",
      });
      assert.deepEqual(await runtime.synthesize({ text: "客厅灯已打开。" }), {
        status: "synthesized",
        mimeType: "audio/wav",
        audio: new Uint8Array([82, 73, 70, 70]),
      });
      assert.equal(requests.length, 4);
      assert.deepEqual(requests.map((request) => request.authorization), [
        "Bearer asr-private-token",
        "Bearer tts-private-token",
        "Bearer asr-private-token",
        "Bearer tts-private-token",
      ]);
      assert.deepEqual(requests.map((request) => request.path), [
        "/v1/audio/transcriptions",
        "/v1/audio/speech",
        "/v1/audio/transcriptions",
        "/v1/audio/speech",
      ]);
      assert.match(requests[0]?.body ?? "", /name="model"\r\n\r\nwhisper-local/);
      assert.match(requests[1]?.body ?? "", /"model":"qwen-tts-local"/);
      assert.match(requests[1]?.body ?? "", /"voice":"warm"/);
    } finally {
      await runtime.dispose();
    }
  });
});

test("keeps an unavailable exact credential out of status and blocks turn calls", async () => {
  const exactLocator = "keychain:hob-agent/voice:asr:runtime-test:stage-a";
  const runtime = new PrivateVoiceProviderRuntime({
    config: {
      asr: { transport: "openai_http", endpoint: "http://127.0.0.1:9911", credentialRef: exactLocator },
      tts: { transport: "openai_http", endpoint: "http://127.0.0.1:9912", locale: "zh-CN" },
    },
    vault: { read: async () => undefined },
  });
  try {
    assert.deepEqual(await runtime.start(), { status: "degraded", reason: "credential_missing" });
    assert.equal(JSON.stringify(runtime.status).includes(exactLocator), false);
    assert.deepEqual(await runtime.synthesize({ text: "不会发送" }), { status: "failed", reason: "degraded" });
  } finally {
    await runtime.dispose();
  }
});

test("cancels a running provider call without disabling an otherwise active runtime", async () => {
  let transcriptionCalls = 0;
  let operationStarted: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume bounded request input */ }
    if (request.url === "/v1/audio/transcriptions") {
      transcriptionCalls += 1;
      if (transcriptionCalls === 1) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ text: "" }));
      } else {
        operationStarted?.();
      }
      return;
    }
    response.setHeader("content-type", "audio/wav");
    response.end(Buffer.from([82, 73, 70, 70]));
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", (error?: Error) => error === undefined ? resolve() : reject(error)));
  const address = server.address() as AddressInfo;
  const runtime = new PrivateVoiceProviderRuntime({
    config: {
      asr: { transport: "openai_http", endpoint: `http://127.0.0.1:${address.port}` },
      tts: { transport: "openai_http", endpoint: `http://127.0.0.1:${address.port}`, locale: "zh-CN" },
    },
    vault: { read: async () => assert.fail("Credential-free providers must not read the vault") },
  });
  try {
    assert.deepEqual(await runtime.start(), { status: "active" });
    const started = new Promise<void>((resolve) => { operationStarted = resolve; });
    const pending = runtime.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" });
    await started;
    runtime.cancel();
    runtime.cancel();
    assert.deepEqual(await pending, { status: "failed", reason: "cancelled" });
    assert.deepEqual(runtime.status, { status: "active" });
    await runtime.dispose();
    await runtime.dispose();
  } finally {
    await runtime.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("recovers a degraded provider pair through one explicit retry after its endpoint returns", async () => {
  let reachable = false;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume bounded request input */ }
    if (request.url === "/v1/audio/transcriptions") {
      if (!reachable) {
        request.socket.destroy();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ text: "恢复后的指令" }));
      return;
    }
    response.setHeader("content-type", "audio/wav");
    response.end(Buffer.from([82, 73, 70, 70]));
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", (error?: Error) => error === undefined ? resolve() : reject(error)));
  const address = server.address() as AddressInfo;
  const runtime = new PrivateVoiceProviderRuntime({
    config: {
      asr: { transport: "openai_http", endpoint: `http://127.0.0.1:${address.port}` },
      tts: { transport: "openai_http", endpoint: `http://127.0.0.1:${address.port}`, locale: "zh-CN" },
    },
    vault: { read: async () => assert.fail("Credential-free providers must not read the vault") },
  });
  try {
    assert.deepEqual(await runtime.start(), { status: "degraded", reason: "endpoint_unreachable" });
    reachable = true;
    assert.deepEqual(await runtime.retry(), { status: "active" });
    assert.deepEqual(await runtime.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" }), {
      status: "transcribed",
      text: "恢复后的指令",
    });
  } finally {
    await runtime.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("cancelling a retry preserves an active turn and permits a later retry", async () => {
  let transcriptionCalls = 0;
  let speechCalls = 0;
  let turnStarted: (() => void) | undefined;
  let retryProbeStarted: (() => void) | undefined;
  let heldTurnResponse: ServerResponse | undefined;
  let heldRetryProbeResponse: ServerResponse | undefined;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume bounded request input */ }
    if (request.url === "/v1/audio/transcriptions") {
      transcriptionCalls += 1;
      if (transcriptionCalls === 1 || transcriptionCalls >= 4) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ text: "已完成" }));
        return;
      }
      if (transcriptionCalls === 2) {
        heldTurnResponse = response;
        turnStarted?.();
        return;
      }
      heldRetryProbeResponse = response;
      retryProbeStarted?.();
      return;
    }
    speechCalls += 1;
    if (speechCalls === 2) {
      request.socket.destroy();
      return;
    }
    response.setHeader("content-type", "audio/wav");
    response.end(Buffer.from([82, 73, 70, 70]));
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", (error?: Error) => error === undefined ? resolve() : reject(error)));
  const address = server.address() as AddressInfo;
  const runtime = new PrivateVoiceProviderRuntime({
    config: {
      asr: { transport: "openai_http", endpoint: `http://127.0.0.1:${address.port}` },
      tts: { transport: "openai_http", endpoint: `http://127.0.0.1:${address.port}`, locale: "zh-CN" },
    },
    vault: { read: async () => assert.fail("Credential-free providers must not read the vault") },
  });
  try {
    assert.deepEqual(await runtime.start(), { status: "active" });
    const turnReady = new Promise<void>((resolve) => { turnStarted = resolve; });
    const activeTurn = runtime.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" });
    let activeTurnSettled = false;
    void activeTurn.finally(() => { activeTurnSettled = true; });
    await turnReady;
    assert.deepEqual(await runtime.synthesize({ text: "触发重试" }), { status: "failed", reason: "endpoint_unreachable" });
    assert.deepEqual(runtime.status, { status: "degraded", reason: "endpoint_unreachable" });

    const retryReady = new Promise<void>((resolve) => { retryProbeStarted = resolve; });
    const retry = runtime.retry();
    await retryReady;
    runtime.cancelRetry();
    assert.deepEqual(await retry, { status: "degraded", reason: "cancelled" });
    assert.equal(activeTurnSettled, false);
    heldRetryProbeResponse?.end();

    assert.deepEqual(await runtime.retry(), { status: "active" });
    heldTurnResponse?.setHeader("content-type", "application/json");
    heldTurnResponse?.end(JSON.stringify({ text: "持续中的转写" }));
    assert.deepEqual(await activeTurn, { status: "transcribed", text: "持续中的转写" });
  } finally {
    await runtime.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("disposing aborts an active provider call", async () => {
  let transcriptionCalls = 0;
  let operationStarted: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume bounded request input */ }
    if (request.url === "/v1/audio/transcriptions") {
      transcriptionCalls += 1;
      if (transcriptionCalls === 1) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ text: "探测" }));
        return;
      }
      operationStarted?.();
      return;
    }
    response.setHeader("content-type", "audio/wav");
    response.end(Buffer.from([82, 73, 70, 70]));
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", (error?: Error) => error === undefined ? resolve() : reject(error)));
  const address = server.address() as AddressInfo;
  const runtime = new PrivateVoiceProviderRuntime({
    config: {
      asr: { transport: "openai_http", endpoint: `http://127.0.0.1:${address.port}` },
      tts: { transport: "openai_http", endpoint: `http://127.0.0.1:${address.port}`, locale: "zh-CN" },
    },
    vault: { read: async () => assert.fail("Credential-free providers must not read the vault") },
  });
  try {
    assert.deepEqual(await runtime.start(), { status: "active" });
    const started = new Promise<void>((resolve) => { operationStarted = resolve; });
    const pending = runtime.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" });
    await started;
    await runtime.dispose();
    assert.deepEqual(await pending, { status: "failed", reason: "cancelled" });
    assert.deepEqual(runtime.status, { status: "disabled" });
  } finally {
    await runtime.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("disposes a retry while a credential read is pending and leaves no active provider", async () => {
  let reads = 0;
  let retryReadStarted: (() => void) | undefined;
  const runtime = new PrivateVoiceProviderRuntime({
    config: {
      asr: {
        transport: "openai_http",
        endpoint: "http://127.0.0.1:9911",
        credentialRef: "keychain:hob-agent/voice:asr:runtime-test:stage-a",
      },
      tts: { transport: "openai_http", endpoint: "http://127.0.0.1:9912", locale: "zh-CN" },
    },
    vault: {
      read: async () => {
        reads += 1;
        if (reads === 1) return undefined;
        retryReadStarted?.();
        return new Promise<string>(() => undefined);
      },
    },
  });
  assert.deepEqual(await runtime.start(), { status: "degraded", reason: "credential_missing" });
  const readStarted = new Promise<void>((resolve) => { retryReadStarted = resolve; });
  const retry = runtime.retry();
  await readStarted;
  await runtime.dispose();
  assert.deepEqual(await retry, { status: "disabled" });
  assert.deepEqual(runtime.status, { status: "disabled" });
});

test("activates configured Wyoming ASR and TTS only after both describe probes", async () => {
  let describes = 0;
  const server = createNetServer((socket) => {
    socket.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes('"describe"')) {
        describes += 1;
        socket.write('{"type":"info","data":{"asr":[],"tts":[]}}\n');
      }
    });
  });
  await listen(server);
  const address = server.address() as AddressInfo;
  const runtime = new PrivateVoiceProviderRuntime({
    config: {
      asr: { transport: "wyoming", endpoint: `wyoming://127.0.0.1:${address.port}`, model: "whisper-local" },
      tts: { transport: "wyoming", endpoint: `wyoming://127.0.0.1:${address.port}`, locale: "zh-CN", voice: "warm" },
    },
    vault: { read: async () => assert.fail("Wyoming must not resolve credentials") },
  });
  try {
    assert.deepEqual(await runtime.start(), { status: "active" });
    assert.equal(runtime.captureMode, "pcm_s16le");
    assert.equal(describes, 2);
  } finally {
    await runtime.dispose();
    await close(server);
  }
});

test("maps a configured Wyoming TTS voice into one bounded synthesis result", async () => {
  let receivedVoice: unknown;
  const server = createNetServer((socket) => {
    socket.on("data", (chunk: Buffer) => {
      const source = chunk.toString("utf8");
      if (source.includes('"describe"')) {
        socket.write('{"type":"info","data":{"asr":[],"tts":[]}}\n');
        return;
      }
      if (source.includes('"synthesize"')) {
        const header = JSON.parse(source.slice(0, source.indexOf("\n"))) as { readonly data?: { readonly voice?: unknown } };
        receivedVoice = header.data?.voice;
        socket.write('{"type":"audio-start","data":{"rate":16000,"width":2,"channels":1}}\n');
        socket.write(Buffer.concat([
          Buffer.from('{"type":"audio-chunk","data":{"rate":16000,"width":2,"channels":1},"payload_length":2}\n'),
          Buffer.from([8, 9]),
        ]));
        socket.write('{"type":"audio-stop"}\n');
      }
    });
  });
  await listen(server);
  const address = server.address() as AddressInfo;
  const runtime = new PrivateVoiceProviderRuntime({
    config: {
      asr: { transport: "wyoming", endpoint: `wyoming://127.0.0.1:${address.port}` },
      tts: { transport: "wyoming", endpoint: `wyoming://127.0.0.1:${address.port}`, locale: "zh-CN", voice: "warm" },
    },
    vault: { read: async () => assert.fail("Wyoming must not resolve credentials") },
  });
  try {
    assert.deepEqual(await runtime.start(), { status: "active" });
    assert.deepEqual(await runtime.synthesize({ text: "晚上好" }), {
      status: "synthesized",
      mimeType: "audio/l16",
      audio: new Uint8Array([8, 9]),
      format: { rate: 16_000, width: 2, channels: 1 },
    });
    assert.deepEqual(receivedVoice, { name: "warm", language: "zh-CN" });
  } finally {
    await runtime.dispose();
    await close(server);
  }
});

test("fails closed when a Wyoming ASR configuration contains an invalid model label", async () => {
  const server = createNetServer((socket) => {
    socket.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes('"describe"')) {
        socket.write('{"type":"info","data":{"asr":[],"tts":[]}}\n');
      }
    });
  });
  await listen(server);
  const address = server.address() as AddressInfo;
  const endpoint = `wyoming://127.0.0.1:${address.port}`;
  const runtime = new PrivateVoiceProviderRuntime({
    config: {
      asr: { transport: "wyoming", endpoint, model: "<untrusted-model>" },
      tts: { transport: "wyoming", endpoint, locale: "zh-CN" },
    },
    vault: { read: async () => assert.fail("Wyoming must not resolve credentials") },
  });
  try {
    assert.deepEqual(await runtime.start(), { status: "degraded", reason: "incompatible" });
    assert.deepEqual(runtime.status, { status: "degraded", reason: "incompatible" });
    assert.deepEqual(await runtime.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" }), {
      status: "failed",
      reason: "degraded",
    });
    runtime.cancel();
    runtime.cancel();
    await runtime.dispose();
    await runtime.dispose();
    assert.deepEqual(runtime.status, { status: "disabled" });
  } finally {
    await runtime.dispose();
    await close(server);
  }
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error?: Error) => error === undefined ? resolve() : reject(error)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
