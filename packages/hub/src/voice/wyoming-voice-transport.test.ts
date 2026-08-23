import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

interface WyomingModule {
  readonly WyomingVoiceTransport: new (options: Record<string, unknown>) => {
    describe(input?: { readonly signal?: AbortSignal }): Promise<unknown>;
    transcribe(input: Record<string, unknown>): Promise<unknown>;
    synthesize(input: Record<string, unknown>): Promise<unknown>;
  };
  readonly encodeWyomingFrame: (frame: { readonly type: string; readonly data?: Record<string, unknown>; readonly payload?: Uint8Array }) => Uint8Array;
}

async function loadTransport(): Promise<WyomingModule> {
  try {
    const loaded = await import("./wyoming-voice-transport.js") as Partial<WyomingModule>;
    if (typeof loaded.WyomingVoiceTransport !== "function" || typeof loaded.encodeWyomingFrame !== "function") {
      throw new Error("Wyoming voice transport exports are incomplete");
    }
    return loaded as WyomingModule;
  } catch (error) {
    assert.fail(`Wyoming voice transport is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface Frame {
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly payload: Uint8Array;
}

class FrameReader {
  private buffered = Buffer.alloc(0);
  private readonly pending: Frame[] = [];

  push(chunk: Uint8Array): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    for (;;) {
      const newline = this.buffered.indexOf(0x0a);
      if (newline < 0) return;
      const header = JSON.parse(this.buffered.subarray(0, newline).toString("utf8")) as {
        type: string;
        data?: Record<string, unknown>;
        data_length?: number;
        payload_length?: number;
      };
      const dataLength = header.data_length ?? 0;
      const payloadLength = header.payload_length ?? 0;
      const required = newline + 1 + dataLength + payloadLength;
      if (this.buffered.length < required) return;
      const rawData = this.buffered.subarray(newline + 1, newline + 1 + dataLength);
      const extra = dataLength === 0 ? {} : JSON.parse(rawData.toString("utf8")) as Record<string, unknown>;
      const payload = new Uint8Array(this.buffered.subarray(newline + 1 + dataLength, required));
      this.pending.push({ type: header.type, data: { ...(header.data ?? {}), ...extra }, payload });
      this.buffered = this.buffered.subarray(required);
    }
  }

  shift(): Frame | undefined { return this.pending.shift(); }
}

async function withServer(
  handler: (socket: Socket, reader: FrameReader) => void,
  operation: (endpoint: string) => Promise<void>,
): Promise<void> {
  const server = createServer((socket) => {
    const reader = new FrameReader();
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      reader.push(chunk);
      handler(socket, reader);
    });
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await operation(`wyoming://127.0.0.1:${address.port}`);
  } finally {
    await close(server);
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error?: Error) => error === undefined ? resolve() : reject(error)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

test("reads split and coalesced Wyoming describe/info frames", async () => {
  const { WyomingVoiceTransport, encodeWyomingFrame } = await loadTransport();
  await withServer((socket, reader) => {
    const request = reader.shift();
    if (request?.type !== "describe") return;
    const frame = encodeWyomingFrame({
      type: "info",
      data: {
        asr: [{ models: [{ name: "whisper", languages: ["zh-CN"], installed: true }] }],
        tts: [{ models: [{ name: "piper", languages: ["zh-CN"], installed: true }] }],
      },
    });
    socket.write(frame.subarray(0, 7));
    socket.write(frame.subarray(7));
  }, async (endpoint) => {
    const transport = new WyomingVoiceTransport({ endpoint, timeoutMs: 500 });
    assert.deepEqual(await transport.describe(), {
      status: "ready",
      services: { asr: true, tts: true },
    });
  });
});

test("accepts a tcp configuration alias and speaks the canonical Wyoming protocol", async () => {
  const { WyomingVoiceTransport, encodeWyomingFrame } = await loadTransport();
  await withServer((socket, reader) => {
    if (reader.shift()?.type === "describe") {
      socket.end(encodeWyomingFrame({ type: "info", data: { asr: [{}], tts: [{}] } }));
    }
  }, async (endpoint) => {
    const transport = new WyomingVoiceTransport({ endpoint: endpoint.replace("wyoming://", "tcp://") });
    assert.deepEqual(await transport.describe(), { status: "ready", services: { asr: true, tts: true } });
  });
});

test("sends an ASR stream and returns the bounded final transcript", async () => {
  const { WyomingVoiceTransport, encodeWyomingFrame } = await loadTransport();
  const received: Frame[] = [];
  await withServer((socket, reader) => {
    for (let frame = reader.shift(); frame !== undefined; frame = reader.shift()) received.push(frame);
    if (received.at(-1)?.type === "audio-stop") socket.write(encodeWyomingFrame({ type: "transcript", data: { text: "播放爵士乐", language: "zh-CN" } }));
  }, async (endpoint) => {
    const transport = new WyomingVoiceTransport({ endpoint, timeoutMs: 500 });
    assert.deepEqual(await transport.transcribe({
      audio: new Uint8Array([1, 2, 3, 4]),
      format: { rate: 16_000, width: 2, channels: 1 },
      language: "zh-CN",
    }), { status: "transcript", text: "播放爵士乐", language: "zh-CN" });
  });
  assert.deepEqual(received.map((frame) => frame.type), ["transcribe", "audio-start", "audio-chunk", "audio-stop"]);
  assert.deepEqual(received[2]?.payload, new Uint8Array([1, 2, 3, 4]));
});

test("collects a TTS audio stream without sending a non-protocol completion event", async () => {
  const { WyomingVoiceTransport, encodeWyomingFrame } = await loadTransport();
  const received: Frame[] = [];
  await withServer((socket, reader) => {
    for (let frame = reader.shift(); frame !== undefined; frame = reader.shift()) received.push(frame);
    if (received[0]?.type !== "synthesize") return;
    socket.write(Buffer.concat([
      encodeWyomingFrame({ type: "audio-start", data: { rate: 22_050, width: 2, channels: 1 } }),
      encodeWyomingFrame({ type: "audio-chunk", data: { rate: 22_050, width: 2, channels: 1 }, payload: new Uint8Array([8, 9]) }),
      encodeWyomingFrame({ type: "audio-stop" }),
    ]));
  }, async (endpoint) => {
    const transport = new WyomingVoiceTransport({ endpoint, timeoutMs: 500 });
    assert.deepEqual(await transport.synthesize({ text: "晚上好", voice: { name: "warm", language: "zh-CN" } }), {
      status: "audio",
      format: { rate: 22_050, width: 2, channels: 1 },
      audio: new Uint8Array([8, 9]),
    });
  });
  assert.deepEqual(received.map((frame) => frame.type), ["synthesize"]);
});

test("rejects a TTS response that finishes without producing audio", async () => {
  const { WyomingVoiceTransport, encodeWyomingFrame } = await loadTransport();
  await withServer((socket, reader) => {
    if (reader.shift()?.type !== "synthesize") return;
    socket.write(Buffer.concat([
      encodeWyomingFrame({ type: "audio-start", data: { rate: 24_000, width: 2, channels: 1 } }),
      encodeWyomingFrame({ type: "audio-stop" }),
    ]));
  }, async (endpoint) => {
    const transport = new WyomingVoiceTransport({ endpoint, timeoutMs: 500 });
    assert.deepEqual(await transport.synthesize({ text: "你好" }), { status: "incompatible" });
  });
});

test("closes malformed or oversized frames into closed transport results", async () => {
  const { WyomingVoiceTransport } = await loadTransport();
  await withServer((socket, reader) => {
    if (reader.shift()?.type === "describe") socket.write(`${JSON.stringify({ type: "info", payload_length: 65_537 })}\n`);
  }, async (endpoint) => {
    const transport = new WyomingVoiceTransport({ endpoint, timeoutMs: 500, limits: { maxFramePayloadBytes: 64 } });
    assert.deepEqual(await transport.describe(), { status: "limit_exceeded" });
  });
});

test("caps a peer header before waiting for its newline", async () => {
  const { WyomingVoiceTransport } = await loadTransport();
  await withServer((socket, reader) => {
    if (reader.shift()?.type === "describe") socket.write("x".repeat(65));
  }, async (endpoint) => {
    const transport = new WyomingVoiceTransport({ endpoint, timeoutMs: 500, limits: { maxHeaderBytes: 64 } });
    assert.deepEqual(await transport.describe(), { status: "limit_exceeded" });
  });
});

test("caps a peer audio stream across individually valid chunks", async () => {
  const { WyomingVoiceTransport, encodeWyomingFrame } = await loadTransport();
  await withServer((socket, reader) => {
    if (reader.shift()?.type !== "synthesize") return;
    socket.write(Buffer.concat([
      encodeWyomingFrame({ type: "audio-start", data: { rate: 16_000, width: 2, channels: 1 } }),
      encodeWyomingFrame({ type: "audio-chunk", data: { rate: 16_000, width: 2, channels: 1 }, payload: new Uint8Array([1, 2, 3, 4]) }),
      encodeWyomingFrame({ type: "audio-chunk", data: { rate: 16_000, width: 2, channels: 1 }, payload: new Uint8Array([5, 6, 7, 8]) }),
    ]));
  }, async (endpoint) => {
    const transport = new WyomingVoiceTransport({ endpoint, timeoutMs: 500, limits: { maxAudioBytes: 5 } });
    assert.deepEqual(await transport.synthesize({ text: "你好" }), { status: "limit_exceeded" });
  });
});

test("caps text before it enters a Wyoming synthesis request", async () => {
  const { WyomingVoiceTransport } = await loadTransport();
  await withServer(() => assert.fail("an oversized text request never reaches the peer"), async (endpoint) => {
    const transport = new WyomingVoiceTransport({ endpoint, timeoutMs: 500, limits: { maxTextChars: 2 } });
    assert.deepEqual(await transport.synthesize({ text: "晚上好" }), { status: "limit_exceeded" });
  });
});

test("caps the number of upstream events before accepting a final response", async () => {
  const { WyomingVoiceTransport, encodeWyomingFrame } = await loadTransport();
  await withServer((socket, reader) => {
    if (reader.shift()?.type !== "describe") return;
    socket.write(Buffer.concat([
      encodeWyomingFrame({ type: "ignored" }),
      encodeWyomingFrame({ type: "info", data: { asr: [], tts: [] } }),
    ]));
  }, async (endpoint) => {
    const transport = new WyomingVoiceTransport({ endpoint, timeoutMs: 500, limits: { maxEvents: 1 } });
    assert.deepEqual(await transport.describe(), { status: "limit_exceeded" });
  });
});

test("closes a quiet or cancelled operation without exposing private transport details", async () => {
  const { WyomingVoiceTransport } = await loadTransport();
  await withServer(() => undefined, async (endpoint) => {
    const transport = new WyomingVoiceTransport({ endpoint, timeoutMs: 20 });
    assert.deepEqual(await transport.describe(), { status: "timed_out" });
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await transport.describe({ signal: controller.signal }), { status: "cancelled" });
  });
});
