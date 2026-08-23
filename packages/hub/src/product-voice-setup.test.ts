import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { ProductVoiceSetup, ProductVoiceSetupService } from "./product-voice-setup.js";

class MemoryVault {
  readonly values = new Map<string, string>();
  readonly deleted: string[] = [];

  read(reference: string): Promise<string | undefined> { return Promise.resolve(this.values.get(reference)); }
  write(reference: string, value: string): Promise<void> { this.values.set(reference, value); return Promise.resolve(); }
  delete(reference: string): Promise<void> { this.deleted.push(reference); this.values.delete(reference); return Promise.resolve(); }
}

test("stages independent Wyoming ASR and HTTP TTS settings without selecting a primary", async () => {
  const vault = new MemoryVault();
  const calls: Array<{ kind: string; transport: string; endpoint: string; credential?: string; model?: string }> = [];
  const setup = new ProductVoiceSetup({
    vault,
    createStageNonce: () => "voice-stage",
    probe: async (input) => {
      calls.push({
        kind: input.track.kind,
        transport: input.track.transport,
        endpoint: input.track.endpoint,
        credential: input.credential,
        model: input.track.model,
      });
      return { status: "ready", latencyMs: 31 };
    },
  });

  const asr = await setup.probe({
    setupId: "family-a",
    track: { kind: "asr", transport: "wyoming", endpoint: "wyoming://127.0.0.1:10300", model: "whisper-large-v3" },
  });
  const tts = await setup.probe({
    setupId: "family-a",
    track: { kind: "tts", transport: "openai_http", endpoint: "http://127.0.0.1:9880", credential: "tts-secret", locale: "zh-CN", voice: "warm" },
  });

  assert.deepEqual(asr, {
    status: "ready",
    latencyMs: 31,
    staged: {
      kind: "asr",
      transport: "wyoming",
      endpoint: "wyoming://127.0.0.1:10300",
      model: "whisper-large-v3",
    },
  });
  assert.deepEqual(tts, {
    status: "ready",
    latencyMs: 31,
    staged: {
      kind: "tts",
      transport: "openai_http",
      endpoint: "http://127.0.0.1:9880",
      credentialRef: "keychain:hob-agent/voice:tts:family-a:voice-stage",
      locale: "zh-CN",
      voice: "warm",
    },
  });
  assert.deepEqual(calls, [
    { kind: "asr", transport: "wyoming", endpoint: "wyoming://127.0.0.1:10300", credential: undefined, model: "whisper-large-v3" },
    { kind: "tts", transport: "openai_http", endpoint: "http://127.0.0.1:9880", credential: "tts-secret", model: undefined },
  ]);
  assert.equal(vault.values.has("keychain:hob-agent/voice:asr:family-a:voice-stage"), false);
  assert.equal(vault.values.has("keychain:hob-agent/voice:tts:family-a:voice-stage"), true);
  assert.equal([...vault.values.keys()].some((reference) => reference.includes(":primary")), false);
});

test("rejects a Wyoming credential because the protocol transport cannot send one", async () => {
  const vault = new MemoryVault();
  const setup = new ProductVoiceSetup({ vault, probe: async () => ({ status: "ready", latencyMs: 1 }) });
  assert.deepEqual(await setup.probe({
    setupId: "family-wyoming-secret",
    track: {
      kind: "asr",
      transport: "wyoming",
      endpoint: "wyoming://127.0.0.1:10300",
      credential: "unused-secret",
    },
  }), { status: "incompatible" });
  assert.equal(vault.values.size, 0);
});

test("uses the built-in OpenAI-compatible probe when no plugin overrides it", async () => {
  const server = createHttpServer((request, response) => {
    if (request.url === "/v1/audio/transcriptions") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ text: "" }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    const result = await new ProductVoiceSetup({ vault: new MemoryVault() }).probe({
      setupId: "family-http",
      track: {
        kind: "asr",
        transport: "openai_http",
        endpoint: `http://127.0.0.1:${address.port}`,
        model: "private-whisper",
      },
    });
    assert.equal(result.status, "ready");
    if (result.status === "ready") assert.equal(result.staged.model, "private-whisper");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("uses the built-in Wyoming capability probe for the selected track", async () => {
  const server = createTcpServer((socket) => {
    socket.once("data", () => socket.end(`${JSON.stringify({ type: "info", data: { asr: [{}], tts: [] } })}\n`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    const result = await new ProductVoiceSetup({ vault: new MemoryVault() }).probe({
      setupId: "family-wyoming",
      track: { kind: "asr", transport: "wyoming", endpoint: `wyoming://127.0.0.1:${address.port}` },
    });
    assert.equal(result.status, "ready");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("cleans a staged ASR credential when the neutral probe rejects it", async () => {
  const vault = new MemoryVault();
  const setup = new ProductVoiceSetup({
    vault,
    createStageNonce: () => "rejected",
    probe: async () => ({ status: "credential_rejected" }),
  });

  assert.deepEqual(await setup.probe({
    setupId: "family-b",
    track: { kind: "asr", transport: "openai_http", endpoint: "https://192.168.1.20", credential: "wrong" },
  }), { status: "credential_rejected" });
  assert.deepEqual(vault.deleted, ["keychain:hob-agent/voice:asr:family-b:rejected"]);
  assert.equal(vault.values.size, 0);
});

test("fails closed and cleans the staged credential when a transport reports an invalid latency", async () => {
  const vault = new MemoryVault();
  const setup = new ProductVoiceSetup({
    vault,
    createStageNonce: () => "invalid-result",
    probe: async () => ({ status: "ready", latencyMs: Number.NaN }),
  });

  assert.deepEqual(await setup.probe({
    setupId: "family-invalid-result",
    track: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:10300", credential: "private" },
  }), { status: "incompatible" });
  assert.deepEqual(vault.deleted, ["keychain:hob-agent/voice:asr:family-invalid-result:invalid-result"]);
  assert.equal(vault.values.size, 0);
});

test("rejects secret-shaped endpoints before any credential reaches the vault", async () => {
  const vault = new MemoryVault();
  const setup = new ProductVoiceSetup({ vault, probe: async () => ({ status: "ready", latencyMs: 1 }) });

  assert.deepEqual(await setup.probe({
    setupId: "family-c",
    track: { kind: "tts", transport: "wyoming", endpoint: "wyoming://user:token@127.0.0.1:10301/path?key=secret", credential: "also-secret", locale: "zh-CN" },
  }), { status: "incompatible" });
  assert.equal(vault.values.size, 0);
});

test("rejects header-breaking credentials before they reach the vault or transport", async () => {
  const vault = new MemoryVault();
  let probed = false;
  const setup = new ProductVoiceSetup({
    vault,
    probe: async () => { probed = true; return { status: "ready", latencyMs: 1 }; },
  });

  assert.deepEqual(await setup.probe({
    setupId: "family-header",
    track: {
      kind: "asr",
      transport: "openai_http",
      endpoint: "http://127.0.0.1:8090",
      credential: "token\r\nextra-header: value",
    },
  }), { status: "incompatible" });
  assert.equal(vault.values.size, 0);
  assert.equal(probed, false);
});

test("keeps a credential-free TTS stage free of secret locators and discards an exact staged locator", async () => {
  const vault = new MemoryVault();
  const setup = new ProductVoiceSetup({
    vault,
    createStageNonce: () => "discardable",
    probe: async () => ({ status: "ready", latencyMs: 9 }),
  });
  const result = await setup.probe({
    setupId: "family-d",
    track: { kind: "tts", transport: "wyoming", endpoint: "wyoming://localhost:10301", locale: "en-US" },
  });
  assert.deepEqual(result, {
    status: "ready",
    latencyMs: 9,
    staged: { kind: "tts", transport: "wyoming", endpoint: "wyoming://localhost:10301", locale: "en-US" },
  });
  if (result.status !== "ready") assert.fail("expected a staged voice track");
  await setup.discard(result.staged);
  assert.deepEqual(vault.deleted, []);
});

test("mounts the private voice setup owner as a Cordis capability without starting audio", async () => {
  const context = new Context();
  const calls: string[] = [];
  const fiber = await context.plugin(ProductVoiceSetupService, {
    probe: async ({ track }) => {
      calls.push(`${track.kind}:${track.transport}`);
      return { status: "ready", latencyMs: 12 };
    },
  });
  try {
    const result = await context.productVoiceSetup.probe({
      setupId: "family-cordis",
      track: {
        kind: "asr",
        transport: "wyoming",
        endpoint: "wyoming://127.0.0.1:10300",
      },
    });
    assert.equal(result.status, "ready");
    assert.deepEqual(calls, ["asr:wyoming"]);
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});
