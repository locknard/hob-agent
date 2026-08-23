import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import {
  ProductVoiceSetup,
  ProductVoiceSetupService,
  type ProductVoiceProbeOutcome,
  type ProductVoiceTrackInput,
} from "./product-voice-setup.js";

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
    track: { kind: "asr", transport: "wyoming", endpoint: "tcp://127.0.0.1:10300", model: "whisper-large-v3" },
  });
  const tts = await probeCredentialed(setup, {
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

test("accepts an OpenAI-compatible /v1 base URL and stages the canonical service root", async () => {
  const endpoints: string[] = [];
  const setup = new ProductVoiceSetup({
    vault: new MemoryVault(),
    probe: async ({ track }) => {
      endpoints.push(track.endpoint);
      return { status: "ready", latencyMs: 1 };
    },
  });

  const result = await setup.probe({
    setupId: "family-openai-v1",
    track: {
      kind: "asr",
      transport: "openai_http",
      endpoint: "http://127.0.0.1:9880/v1/",
    },
  });

  assert.deepEqual(result, {
    status: "ready",
    latencyMs: 1,
    staged: {
      kind: "asr",
      transport: "openai_http",
      endpoint: "http://127.0.0.1:9880",
    },
  });
  assert.deepEqual(endpoints, ["http://127.0.0.1:9880"]);
});

test("rejects a Wyoming TTS model before it can produce a non-runnable ready stage", async () => {
  const vault = new MemoryVault();
  let probed = false;
  const setup = new ProductVoiceSetup({
    vault,
    probe: async () => { probed = true; return { status: "ready", latencyMs: 1 }; },
  });

  assert.deepEqual(await setup.probe({
    setupId: "family-wyoming-tts-model",
    track: {
      kind: "tts",
      transport: "wyoming",
      endpoint: "wyoming://127.0.0.1:10301",
      locale: "zh-CN",
      model: "unsupported-model-field",
    },
  }), { status: "incompatible" });
  assert.equal(probed, false);
  assert.equal(vault.values.size, 0);
});

test("accepts credentialed HTTPS hostnames and requires literal private addresses for plaintext credentials", async () => {
  const endpoints: string[] = [];
  const setup = new ProductVoiceSetup({
    vault: new MemoryVault(),
    probe: async ({ track }) => {
      endpoints.push(track.endpoint);
      return { status: "ready", latencyMs: 1 };
    },
  });

  const secure = await probeCredentialed(setup, {
    setupId: "family-secure-host",
    track: {
      kind: "asr",
      transport: "openai_http",
      endpoint: "https://voice.example.test/v1/",
      credential: "private-token",
    },
  });
  assert.equal(secure.status, "ready");
  assert.deepEqual(endpoints, ["https://voice.example.test"]);

  assert.deepEqual(await probeCredentialed(setup, {
    setupId: "family-plaintext-host",
    track: {
      kind: "asr",
      transport: "openai_http",
      endpoint: "http://voice.local",
      credential: "private-token",
    },
  }), { status: "incompatible" });
});

test("requires a durable lease before the direct setup API writes a credential", async () => {
  const vault = new MemoryVault();
  const setup = new ProductVoiceSetup({ vault, probe: async () => ({ status: "ready", latencyMs: 1 }) });

  await assert.rejects(
    setup.probe({
      setupId: "family-direct-credential",
      track: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9880", credential: "private" },
    }),
    /durable staging lease/,
  );
  assert.equal(vault.values.size, 0);
});

test("waits for a credential write to settle before a cancelled execute returns and never starts its probe", async () => {
  const values = new Map<string, string>();
  let releaseWrite: (() => void) | undefined;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let signalWriteStarted: (() => void) | undefined;
  const writeStarted = new Promise<void>((resolve) => { signalWriteStarted = resolve; });
  const vault = {
    read: async (reference: string) => values.get(reference),
    write: async (reference: string, value: string) => {
      signalWriteStarted?.();
      await writeGate;
      values.set(reference, value);
    },
    delete: async (reference: string) => { values.delete(reference); },
  };
  let probeCalls = 0;
  const setup = new ProductVoiceSetup({
    vault,
    createStageNonce: () => "cancelled_write",
    probe: async () => {
      probeCalls += 1;
      return { status: "ready", latencyMs: 1 };
    },
  });
  const preparation = setup.prepare({
    setupId: "family-cancelled-write",
    track: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:9880", credential: "candidate-secret" },
  });
  if (preparation.status !== "prepared") assert.fail("expected a prepared credential stage");
  const controller = new AbortController();

  const execution = setup.execute({
    prepared: preparation.prepared,
    credentialLease: { stage: preparation.prepared.stage },
    signal: controller.signal,
  });
  await writeStarted;
  controller.abort();
  releaseWrite?.();

  assert.deepEqual(await execution, { status: "unavailable" });
  assert.equal(probeCalls, 0);
  assert.equal(values.get("keychain:hob-agent/voice:asr:family-cancelled-write:cancelled_write"), "candidate-secret");
});

test("passes a private cancellation signal into the selected provider probe", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const setup = new ProductVoiceSetup({
    vault: new MemoryVault(),
    probe: async ({ signal }) => {
      receivedSignal = signal;
      return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ status: "unavailable" }), { once: true }));
    },
  });
  const probe = setup.probe({
    setupId: "family-probe-cancel",
    track: { kind: "asr", transport: "wyoming", endpoint: "wyoming://127.0.0.1:10300" },
    signal: controller.signal,
  });
  controller.abort();

  assert.deepEqual(await probe, { status: "unavailable" });
  assert.equal(receivedSignal, controller.signal);
});

test("rejects a Wyoming credential because the protocol transport cannot send one", async () => {
  const vault = new MemoryVault();
  const setup = new ProductVoiceSetup({ vault, probe: async () => ({ status: "ready", latencyMs: 1 }) });
  assert.deepEqual(await probeCredentialed(setup, {
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

test("settles the built-in Wyoming capability probe when its private signal is cancelled", async () => {
  const server = createTcpServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const controller = new AbortController();
  try {
    const probe = new ProductVoiceSetup({ vault: new MemoryVault() }).probe({
      setupId: "family-wyoming-cancel",
      track: { kind: "asr", transport: "wyoming", endpoint: `wyoming://127.0.0.1:${address.port}` },
      signal: controller.signal,
    });
    controller.abort();
    assert.deepEqual(await probe, { status: "unavailable" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("returns a rejected credential probe while its durable lease remains available for its owner", async () => {
  const vault = new MemoryVault();
  const setup = new ProductVoiceSetup({
    vault,
    createStageNonce: () => "rejected",
    probe: async () => ({ status: "credential_rejected" }),
  });

  assert.deepEqual(await probeCredentialed(setup, {
    setupId: "family-b",
    track: { kind: "asr", transport: "openai_http", endpoint: "https://192.168.1.20", credential: "wrong" },
  }), { status: "credential_rejected" });
  assert.deepEqual(vault.deleted, []);
  assert.equal(vault.values.get("keychain:hob-agent/voice:asr:family-b:rejected"), "wrong");
});

test("returns an invalid transport result while its durable lease remains available for its owner", async () => {
  const vault = new MemoryVault();
  const setup = new ProductVoiceSetup({
    vault,
    createStageNonce: () => "invalid-result",
    probe: async () => ({ status: "ready", latencyMs: Number.NaN }),
  });

  assert.deepEqual(await probeCredentialed(setup, {
    setupId: "family-invalid-result",
    track: { kind: "asr", transport: "openai_http", endpoint: "http://127.0.0.1:10300", credential: "private" },
  }), { status: "incompatible" });
  assert.deepEqual(vault.deleted, []);
  assert.equal(vault.values.get("keychain:hob-agent/voice:asr:family-invalid-result:invalid-result"), "private");
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

async function probeCredentialed(
  setup: ProductVoiceSetup,
  input: { readonly setupId: string; readonly track: ProductVoiceTrackInput },
): Promise<ProductVoiceProbeOutcome> {
  const preparation = setup.prepare(input);
  if (preparation.status !== "prepared") return preparation;
  return setup.execute({
    prepared: preparation.prepared,
    credentialLease: { stage: preparation.prepared.stage },
  });
}
