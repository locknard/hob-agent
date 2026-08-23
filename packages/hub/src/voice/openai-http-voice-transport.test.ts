import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

interface VoiceTransportModule {
  readonly OpenAiHttpVoiceTransport: new (options: Record<string, unknown>) => {
    transcribe(input: Record<string, unknown>): Promise<unknown>;
    synthesize(input: Record<string, unknown>): Promise<unknown>;
    probe(input: Record<string, unknown>): Promise<unknown>;
  };
}

async function loadTransport(): Promise<VoiceTransportModule> {
  try {
    const loaded = await import("./openai-http-voice-transport.js") as Partial<VoiceTransportModule>;
    if (typeof loaded.OpenAiHttpVoiceTransport !== "function") throw new Error("OpenAI HTTP voice transport export is missing");
    return loaded as VoiceTransportModule;
  } catch (error) {
    assert.fail(`OpenAI HTTP voice transport is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface FakeVoiceServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

async function startFakeVoiceServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<FakeVoiceServer> {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}

async function requestBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("posts bounded audio only to the stable transcription endpoint and returns a bounded final transcript", async () => {
  const { OpenAiHttpVoiceTransport } = await loadTransport();
  let received: { path?: string; authorization?: string; body?: string } = {};
  const server = await startFakeVoiceServer(async (request, response) => {
    received = {
      path: request.url,
      authorization: request.headers.authorization,
      body: (await requestBody(request)).toString("utf8"),
    };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ text: "在多媒体室播放爵士乐" }));
  });
  try {
    const transport = new OpenAiHttpVoiceTransport({ baseUrl: server.baseUrl, credential: "private-asr-token" });
    assert.deepEqual(await transport.transcribe({
      audio: new Uint8Array([82, 73, 70, 70]),
      mimeType: "audio/wav",
      locale: "zh-CN",
    }), { status: "transcribed", text: "在多媒体室播放爵士乐" });
    assert.equal(received.path, "/v1/audio/transcriptions");
    assert.equal(received.authorization, "Bearer private-asr-token");
    assert.match(received.body ?? "", /name="model"\r\n\r\nwhisper-1/);
    assert.match(received.body ?? "", /name="language"\r\n\r\nzh-CN/);
    assert.match(received.body ?? "", /name="file"; filename="voice\.wav"/);
  } finally {
    await server.close();
  }
});

test("posts bounded plain speech text and returns only an allowed bounded audio response", async () => {
  const { OpenAiHttpVoiceTransport } = await loadTransport();
  let received: { path?: string; body?: unknown } = {};
  const server = await startFakeVoiceServer(async (request, response) => {
    received = { path: request.url, body: JSON.parse((await requestBody(request)).toString("utf8")) };
    response.setHeader("content-type", "audio/wav");
    response.end(Buffer.from([82, 73, 70, 70]));
  });
  try {
    const transport = new OpenAiHttpVoiceTransport({ baseUrl: server.baseUrl });
    assert.deepEqual(await transport.synthesize({
      text: "客厅灯已关闭。",
      voice: "alloy",
      locale: "zh-CN",
    }), {
      status: "synthesized",
      audio: new Uint8Array([82, 73, 70, 70]),
      mimeType: "audio/wav",
    });
    assert.equal(received.path, "/v1/audio/speech");
    assert.deepEqual(received.body, {
      model: "tts-1",
      input: "客厅灯已关闭。",
      voice: "alloy",
      response_format: "wav",
    });
  } finally {
    await server.close();
  }
});

test("classifies credential rejection and a missing OpenAI audio route without retaining provider details", async () => {
  const { OpenAiHttpVoiceTransport } = await loadTransport();
  const server = await startFakeVoiceServer((request, response) => {
    response.statusCode = request.url === "/v1/audio/transcriptions" ? 401 : 404;
    response.end("private response body");
  });
  try {
    const transport = new OpenAiHttpVoiceTransport({ baseUrl: server.baseUrl, credential: "private-token-that-must-not-escape" });
    assert.deepEqual(await transport.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" }), {
      status: "failed",
      reason: "credential_rejected",
    });
    assert.deepEqual(await transport.synthesize({ text: "你好", voice: "alloy", locale: "zh-CN" }), {
      status: "failed",
      reason: "incompatible",
    });
  } finally {
    await server.close();
  }
});

test("gives timeout and explicit cancellation their distinct closed results", async () => {
  const { OpenAiHttpVoiceTransport } = await loadTransport();
  const server = await startFakeVoiceServer(() => undefined);
  try {
    const timed = new OpenAiHttpVoiceTransport({ baseUrl: server.baseUrl, timeoutMs: 20 });
    assert.deepEqual(await timed.synthesize({ text: "等待", voice: "alloy", locale: "zh-CN" }), {
      status: "failed",
      reason: "timed_out",
    });
    const cancelled = new AbortController();
    const pending = timed.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav", signal: cancelled.signal });
    cancelled.abort();
    assert.deepEqual(await pending, { status: "failed", reason: "cancelled" });
  } finally {
    await server.close();
  }
});

test("rejects oversized input and oversized provider output before it becomes a voice turn", async () => {
  const { OpenAiHttpVoiceTransport } = await loadTransport();
  const server = await startFakeVoiceServer((_request, response) => {
    response.setHeader("content-type", "audio/wav");
    response.setHeader("content-length", "9");
    response.end(Buffer.alloc(9));
  });
  try {
    const transport = new OpenAiHttpVoiceTransport({ baseUrl: server.baseUrl, maxAudioBytes: 8 });
    assert.deepEqual(await transport.transcribe({ audio: new Uint8Array(9), mimeType: "audio/wav" }), {
      status: "failed",
      reason: "invalid_input",
    });
    assert.deepEqual(await transport.synthesize({ text: "简短回答", voice: "alloy", locale: "zh-CN" }), {
      status: "failed",
      reason: "incompatible",
    });
  } finally {
    await server.close();
  }
});

test("rejects malformed JSON, unexpected audio MIME, and exposes a reusable capability probe", async () => {
  const { OpenAiHttpVoiceTransport } = await loadTransport();
  let requests = 0;
  const server = await startFakeVoiceServer((request, response) => {
    requests += 1;
    if (requests === 1) {
      response.setHeader("content-type", "application/json");
      response.end("{");
      return;
    }
    if (requests === 2) {
      response.setHeader("content-type", "text/html");
      response.end("not audio");
      return;
    }
    if (request.url === "/v1/audio/transcriptions") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ text: "连接正常" }));
      return;
    }
    response.setHeader("content-type", "audio/wav");
    response.end(Buffer.from([82, 73, 70, 70]));
  });
  try {
    const transport = new OpenAiHttpVoiceTransport({ baseUrl: server.baseUrl });
    assert.deepEqual(await transport.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" }), {
      status: "failed",
      reason: "incompatible",
    });
    assert.deepEqual(await transport.synthesize({ text: "你好", voice: "alloy", locale: "zh-CN" }), {
      status: "failed",
      reason: "incompatible",
    });
    const asrProbe = await transport.probe({ kind: "asr", locale: "zh-CN" });
    assert.equal(asrProbe.status, "ready");
    const ttsProbe = await transport.probe({ kind: "tts", locale: "zh-CN", voice: "alloy" });
    assert.equal(ttsProbe.status, "ready");
  } finally {
    await server.close();
  }
});
