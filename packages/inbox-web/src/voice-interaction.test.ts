import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";

import { VOICE_INTERACTION_JS } from "./voice-surface.js";

type Handler = (...args: any[]) => void;

class Element {
  readonly attributes = new Map<string, string>();
  readonly nodes = new Map<string, Element>();
  readonly listeners = new Map<string, Handler>();
  readonly dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  textContent = "";
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  querySelector(selector: string): Element | null {
    return this.nodes.get(selector) ?? null;
  }
  addEventListener(name: string, handler: Handler): void {
    this.listeners.set(name, handler);
  }
  click(): void {
    this.listeners.get("click")?.({});
  }
}
class Button extends Element {}
class Anchor extends Element {
  href = "";
}
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static stopImmediately = true;
  mimeType = "audio/webm";
  ondataavailable?: Handler;
  onstop?: Handler;
  stopped = false;
  constructor(readonly stream: FakeStream) {
    FakeRecorder.instances.push(this);
  }
  start(): void {
    /* capture begins */
  }
  emit(bytes = [1, 2]): void {
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }),
    });
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (FakeRecorder.stopImmediately) this.finish();
  }
  finish(): void {
    this.onstop?.();
  }
}
class FakeStream {
  stopped = false;
  getTracks(): Array<{ stop: () => void }> {
    return [
      {
        stop: () => {
          this.stopped = true;
        },
      },
    ];
  }
}
class FakeProcessor {
  onaudioprocess?: Handler;
  connect(): void {}
  disconnect(): void {}
  emit(samples: ArrayLike<number>): void {
    this.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(samples) },
    });
  }
}
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static nextSampleRate = 16_000;
  sampleRate = FakeAudioContext.nextSampleRate;
  destination = {};
  processor = new FakeProcessor();
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect() {}, disconnect() {} };
  }
  createScriptProcessor(): FakeProcessor {
    return this.processor;
  }
  close(): void {}
}
class FakeEvents {
  static instances: FakeEvents[] = [];
  static CONNECTING = 0;
  readonly listeners = new Map<string, Handler>();
  readyState = 1;
  closed = false;
  constructor(readonly url: string) {
    FakeEvents.instances.push(this);
  }
  addEventListener(name: string, handler: Handler): void {
    this.listeners.set(name, handler);
  }
  emit(name: string, data = "{}") {
    this.listeners.get(name)?.({ data });
  }
  close(): void {
    this.closed = true;
  }
}
class FakeAudio {
  static instances: FakeAudio[] = [];
  onended?: Handler;
  onerror?: Handler;
  paused = false;
  constructor(readonly url: string) {
    FakeAudio.instances.push(this);
  }
  async play(): Promise<void> {}
  pause(): void {
    this.paused = true;
  }
}
class FakeWindow {
  readonly listeners = new Map<string, Handler>();
  readonly location = { href: "http://localhost/voice" };
  addEventListener(name: string, handler: Handler): void {
    this.listeners.set(name, handler);
  }
  dispatch(name: string): void {
    this.listeners.get(name)?.({});
  }
}
class HarnessUrl extends globalThis.URL {
  static createObjectURL(): string { return "blob:test"; }
  static revokeObjectURL(): void {}
}
class FakeSessionStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

interface Harness {
  root: Element;
  start: Button;
  stop: Button;
  cancel: Button;
  background: Button;
  restart: Button;
  speechStop: Button;
  transcript: Element;
  answer: Element;
  conversation: Anchor;
  detail: Element;
  recovery: Anchor;
  calls: Array<{ url: string; init: any }>;
  streams: FakeStream[];
  timers: Array<Handler>;
  clearedTimers: unknown[];
  storage: FakeSessionStorage;
  pagehide(): void;
}
function createHarness(
  options: {
    mode?: "encoded_audio" | "pcm_s16le";
    available?: boolean;
    permission?: "allow" | "deny";
    response?: unknown;
    fetch?: (url: string, init: any) => Promise<any> | any;
    sampleRate?: number;
    permissionRequest?: Promise<FakeStream>;
    leaseRequest?: (init: any) => Promise<any> | any;
    now?: () => number;
    sessionStorage?: unknown;
    setTimeout?: (handler: Handler, delay?: number) => unknown;
  } = {},
): Harness {
  FakeRecorder.instances = [];
  FakeRecorder.stopImmediately = true;
  FakeAudioContext.instances = [];
  FakeAudioContext.nextSampleRate = options.sampleRate ?? 16_000;
  FakeEvents.instances = [];
  FakeAudio.instances = [];
  const root = new Element();
  root.setAttribute("data-voice-state", "idle");
  root.setAttribute(
    "data-private-voice-status",
    options.available === false ? "unavailable" : "active",
  );
  if (options.available !== false)
    root.setAttribute(
      "data-private-voice-capture-mode",
      options.mode ?? "encoded_audio",
    );
  const names = [
    "[data-voice-eyebrow]",
    "[data-voice-heading]",
    "[data-voice-status]",
    "[data-voice-detail]",
    "[data-voice-transcript]",
    "[data-voice-fallback]",
    "[data-voice-answer]",
  ];
  for (const name of names) root.nodes.set(name, new Element());
  const start = new Button();
  const stop = new Button();
  const cancel = new Button();
  const background = new Button();
  background.hidden = true;
  const restart = new Button();
  const speechStop = new Button();
  root.nodes.set("[data-voice-start]", start);
  root.nodes.set("[data-voice-stop]", stop);
  root.nodes.set("[data-voice-cancel]", cancel);
  root.nodes.set("[data-voice-background]", background);
  root.nodes.set("[data-voice-restart]", restart);
  root.nodes.set("[data-voice-speech-stop]", speechStop);
  const recovery = new Anchor();
  root.nodes.set("[data-voice-recovery]", recovery);
  const conversation = new Anchor();
  conversation.hidden = true;
  root.nodes.set("[data-voice-conversation]", conversation);
  const streams: FakeStream[] = [];
  const calls: Array<{ url: string; init: any }> = [];
  let adviceId = "";
  const timers: Handler[] = [];
  const clearedTimers: unknown[] = [];
  const storage = new FakeSessionStorage();
  const window = new FakeWindow();
  const result = options.response ?? {
    status: "accepted",
    adviceId: "turn_1",
    transcript: "打开客厅灯",
  };
  const fetch = async (url: string, init: any = {}) => {
    calls.push({ url, init });
    if (url === "/voice/turns") {
      if (options.leaseRequest !== undefined) return options.leaseRequest(init);
      return {
        ok: true,
        json: async () => ({
          status: "leased",
          voiceTurnId: "lease_turn_000000",
          captureMode: options.mode ?? "encoded_audio",
        }),
      };
    }
    if (options.fetch) {
      const isTranscription = /\/voice\/turns\/[^/]+\/transcribe$/.test(url);
      const legacyUrl = isTranscription
        ? "/test/transcribe"
        : /\/voice\/turns\/[^/]+\/speech$/.test(url)
          ? "/test/speech/" + adviceId
          : url;
      const response = await options.fetch(legacyUrl, init);
      if (isTranscription && response?.json instanceof Function) {
        const json = response.json.bind(response);
        response.json = async () => {
          const result = await json();
          if (typeof result?.adviceId === "string") adviceId = result.adviceId;
          return result;
        };
      }
      return response;
    }
    return url.includes("/transcribe")
      ? { ok: true, json: async () => result }
      : {
          ok: true,
          blob: async () =>
            new Blob([new Uint8Array([1])], { type: "audio/wav" }),
        };
  };
  const navigator = {
    mediaDevices: {
      getUserMedia: async () => {
        if (options.permissionRequest !== undefined) {
          const stream = await options.permissionRequest;
          streams.push(stream);
          return stream;
        }
        if (options.permission === "deny") {
          const error = new Error("denied");
          error.name = "NotAllowedError";
          throw error;
        }
        const stream = new FakeStream();
        streams.push(stream);
        return stream;
      },
    },
  };
  runInNewContext(VOICE_INTERACTION_JS, {
    document: { querySelectorAll: () => [root] },
    HTMLElement: Element,
    HTMLButtonElement: Button,
    HTMLAnchorElement: Anchor,
    navigator,
    MediaRecorder: FakeRecorder,
    AudioContext: FakeAudioContext,
    EventSource: FakeEvents,
    Audio: FakeAudio,
    fetch,
    Blob,
    Uint8Array,
    DataView,
    AbortController,
    URL: HarnessUrl,
    window,
    sessionStorage: options.sessionStorage ?? storage,
    Date: { now: options.now ?? (() => 0) },
    setTimeout: (handler: Handler, delay?: number) => options.setTimeout !== undefined
      ? options.setTimeout(handler, delay)
      : (() => {
          timers.push(handler);
          return timers.length;
        })(),
    clearTimeout: (handle: unknown) => {
      clearedTimers.push(handle);
    },
  });
  return {
    root,
    start,
    stop,
    cancel,
    background,
    restart,
    speechStop,
    transcript: root.nodes.get("[data-voice-transcript]")!,
    answer: root.nodes.get("[data-voice-answer]")!,
    conversation,
    detail: root.nodes.get("[data-voice-detail]")!,
    recovery,
    calls,
    streams,
    timers,
    clearedTimers,
    storage,
    pagehide: () => window.dispatch("pagehide"),
  };
}
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

test("pauses private voice for ten minutes after three consecutive no-input turns while keeping text available and recovering after expiry", async () => {
  let now = 1_000;
  const h = createHarness({ now: () => now });
  const noInput = async () => {
    h.start.click();
    await flush();
    h.stop.click();
    await flush();
    assert.equal(h.root.dataset.voiceState, "no_input");
  };
  await noInput();
  assert.equal(h.recovery.hidden, false);
  assert.equal(h.detail.textContent, "没有听清。再说一次就好。");
  h.restart.click();
  await flush();
  h.stop.click();
  await flush();
  assert.equal(h.detail.textContent, "可以说‘客厅现在怎么样’，也可以改用文字。");
  h.restart.click();
  await flush();
  h.stop.click();
  await flush();

  assert.match(h.detail.textContent, /连续三次.*10 分钟/);
  assert.equal(h.start.disabled, true);
  assert.equal(h.restart.disabled, true);
  assert.equal(h.recovery.href, "/conversation");
  const leasesBeforeBlockedRetry = h.calls.filter((call) => call.url === "/voice/turns").length;
  h.restart.click();
  await flush();
  assert.equal(h.calls.filter((call) => call.url === "/voice/turns").length, leasesBeforeBlockedRetry);

  now += 10 * 60_000 + 1;
  h.restart.click();
  await flush();
  assert.equal(h.start.disabled, false);
  assert.equal(h.root.dataset.voiceState, "listening");
  assert.equal(h.calls.filter((call) => call.url === "/voice/turns").length, leasesBeforeBlockedRetry + 1);
});

test("rebuilds one session no-input recovery timer after a page reload", async () => {
  let now = 1_000;
  const storage = new FakeSessionStorage();
  const until = now + 10 * 60_000;
  storage.setItem("hob.private-voice.no-input.v1", JSON.stringify({ count: 3, until }));
  const timers: Handler[] = [];
  const h = createHarness({
    now: () => now,
    sessionStorage: storage,
    setTimeout(handler) { timers.push(handler); return timers.length; },
  });

  assert.equal(h.root.dataset.voiceState, "idle");
  h.start.click();
  await flush();
  assert.equal(h.root.dataset.voiceState, "no_input");
  assert.equal(h.start.disabled, true);
  assert.equal(h.restart.disabled, true);
  assert.equal(timers.length, 1);

  now = until + 1;
  timers[0]!();
  await flush();
  assert.equal(h.root.dataset.voiceState, "idle");
  assert.equal(h.start.disabled, false);
  assert.equal(h.restart.disabled, false);
  assert.equal(storage.getItem("hob.private-voice.no-input.v1"), null);
});

test("a successful private transcription clears the session no-input count", async () => {
  const h = createHarness();
  const noInput = async () => {
    h.start.click();
    await flush();
    h.stop.click();
    await flush();
    assert.equal(h.root.dataset.voiceState, "no_input");
  };
  await noInput();
  h.restart.click();
  await flush();
  h.stop.click();
  await flush();
  h.restart.click();
  await flush();
  FakeRecorder.instances.at(-1)!.emit();
  h.stop.click();
  await flush();

  h.start.click();
  await flush();
  h.stop.click();
  await flush();
  h.restart.click();
  await flush();
  h.stop.click();
  await flush();
  assert.equal(h.start.disabled, false, "two no-input turns after a transcription remain retryable");
});

test("fails open to text and a recoverable voice retry when session backoff persistence or its timer is unavailable", async () => {
  const throwingStorage = {
    getItem() { throw new Error("storage unavailable"); },
    setItem() { throw new Error("storage unavailable"); },
    removeItem() { throw new Error("storage unavailable"); },
  };
  let timers = 0;
  const h = createHarness({
    sessionStorage: throwingStorage,
    setTimeout(handler) {
      timers += 1;
      if (timers === 4) throw new Error("timer unavailable");
      return timers;
    },
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    h.start.click();
    await flush();
    h.stop.click();
    await flush();
    if (attempt < 2) h.restart.click();
  }
  assert.equal(h.root.dataset.voiceState, "no_input");
  assert.equal(h.start.disabled, false);
  assert.equal(h.restart.disabled, false);
  assert.equal(h.recovery.href, "/conversation");
  assert.equal([...h.storage.values.values()].some((value) => /音频|转写|问题/.test(value)), false);

  let timerCalls = 0;
  const timerFailure = createHarness({
    setTimeout() {
      timerCalls += 1;
      if (timerCalls === 4) throw new Error("timer unavailable");
      return timerCalls;
    },
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    timerFailure.start.click();
    await flush();
    timerFailure.stop.click();
    await flush();
    if (attempt < 2) timerFailure.restart.click();
  }
  assert.equal(timerFailure.start.disabled, false);
  assert.equal(timerFailure.restart.disabled, false);
  assert.equal(timerFailure.recovery.href, "/conversation");
});

test("fails open when the no-input recovery timer does not return a handle", async () => {
  const h = createHarness({ setTimeout: () => undefined });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    h.start.click();
    await flush();
    h.stop.click();
    await flush();
    if (attempt < 2) h.restart.click();
  }

  assert.equal(h.root.dataset.voiceState, "no_input");
  assert.equal(h.start.disabled, false);
  assert.equal(h.restart.disabled, false);
  assert.equal(h.recovery.href, "/conversation");
  assert.match(h.detail.textContent, /可以再试一次|改用文字/);
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test("acquires a private voice turn before microphone permission, then uses and releases that opaque lease", async () => {
  const h = createHarness();
  h.start.click();
  await flush();
  assert.equal(h.calls[0]?.url, "/voice/turns");
  assert.equal(h.calls[0]?.init.method, "POST");
  assert.equal(h.root.dataset.voiceState, "listening");
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();
  assert.equal(h.calls[1]?.url, "/voice/turns/lease_turn_000000/transcribe");
  assert.equal(h.calls[1]?.init.method, "POST");
  assert.equal(h.calls[1]?.init.headers["Content-Type"], "audio/webm");
  assert.equal(h.transcript.textContent, "打开客厅灯");
  assert.equal(FakeEvents.instances[0]?.url, "/conversation/turn_1/events");
  FakeEvents.instances[0]?.emit("completed");
  await flush();
  assert.equal(h.calls[2]?.url, "/voice/turns/lease_turn_000000/speech");
  assert.equal(h.root.dataset.voiceState, "speaking");
  h.start.click();
  await flush();
  assert.equal(FakeAudio.instances[0]?.paused, true);
  assert.equal(h.root.dataset.voiceState, "listening");
  FakeAudio.instances[0]?.onended?.();
  assert.equal(h.root.dataset.voiceState, "listening");
  h.speechStop.click();
  assert.equal(FakeAudio.instances[0]?.paused, true);
});

test("encodes bounded mono PCM16 with actual audio headers", async () => {
  const h = createHarness({
    mode: "pcm_s16le",
    response: { status: "active", adviceId: "turn_pcm" },
  });
  h.start.click();
  await flush();
  FakeAudioContext.instances[0]!.processor.emit([-1, 0, 1]);
  h.stop.click();
  await flush();
  const sent = h.calls.find((call) => call.url.endsWith("/transcribe"))!;
  assert.match(sent.url, /^\/voice\/turns\//);
  assert.equal(sent.init.headers["Content-Type"], "audio/l16");
  assert.deepEqual(sent.init.headers["X-Audio-Rate"], "16000");
  assert.deepEqual(sent.init.headers["X-Audio-Width"], "2");
  assert.deepEqual(sent.init.headers["X-Audio-Channels"], "1");
  assert.equal((sent.init.body as Blob).size, 6);
  assert.equal(FakeEvents.instances[0]?.url, "/conversation/turn_pcm/events");
});

test("keeps the canonical answer visible as its stream arrives and links to its exact conversation", async () => {
  const h = createHarness();
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();

  FakeEvents.instances[0]!.emit("answer_delta", JSON.stringify({ text: "客厅现在很舒适。" }));
  await flush();

  assert.equal(h.answer.textContent, "客厅现在很舒适。");
  assert.equal(h.answer.hidden, false);
  assert.equal(h.conversation.href, "/conversation/turn_1");
  assert.equal(h.conversation.hidden, false);

  FakeEvents.instances[0]!.emit("answer", JSON.stringify({ text: "客厅现在舒适，窗帘也已关闭。" }));
  await flush();
  assert.equal(h.answer.textContent, "客厅现在舒适，窗帘也已关闭。");
});

test("keeps the completed answer and retries only playback when speech is unavailable", async () => {
  let speechAttempts = 0;
  const h = createHarness({
    fetch: (url) => {
      if (url === "/test/transcribe") {
        return {
          ok: true,
          json: async () => ({ status: "accepted", adviceId: "turn_playback", transcript: "客厅现在怎么样？" }),
        };
      }
      if (url === "/test/speech/turn_playback") {
        speechAttempts += 1;
        return speechAttempts === 1
          ? { ok: false, status: 503 }
          : { ok: true, blob: async () => new Blob([new Uint8Array([1])], { type: "audio/wav" }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();
  FakeEvents.instances[0]!.emit("answer", JSON.stringify({ text: "客厅舒适，窗帘已经关闭。" }));
  FakeEvents.instances[0]!.emit("completed");
  await flush();

  assert.equal(h.root.dataset.voiceState, "playback_failed");
  assert.equal(h.answer.textContent, "客厅舒适，窗帘已经关闭。");
  assert.equal(h.answer.hidden, false);
  assert.equal(h.conversation.href, "/conversation/turn_playback");
  assert.equal(h.conversation.hidden, false);
  assert.equal(h.restart.textContent, "重新播报");
  assert.equal(h.restart.hidden, false);
  assert.match(h.detail.textContent, /文字回答已经保留/);

  h.restart.click();
  await flush();
  assert.equal(speechAttempts, 2);
  assert.equal(h.calls.filter((call) => call.url.endsWith("/transcribe")).length, 1,
    "playback recovery does not start a new household request");
});

test("respects an ASR retry window while keeping the text exit visible", async () => {
  const h = createHarness({
    fetch: (url) => {
      if (url === "/test/transcribe") {
        return {
          ok: false,
          status: 429,
          headers: { get: (name: string) => name.toLowerCase() === "retry-after" ? "7" : null },
          json: async () => ({ status: "unavailable" }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();

  assert.equal(h.root.dataset.voiceState, "failed");
  assert.match(h.detail.textContent, /7 秒后/);
  assert.equal(h.recovery.href, "/conversation");
});

test("routes a recovered transcript to model settings when the household model is unavailable", async () => {
  const h = createHarness({
    fetch: (url) => {
      if (url === "/test/transcribe") {
        return {
          ok: false,
          status: 503,
          headers: { get: () => null },
          json: async () => ({ status: "model_unavailable" }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();

  assert.equal(h.root.dataset.voiceState, "model_unavailable");
  assert.match(h.detail.textContent, /家庭助手模型正在恢复/);
  assert.equal(h.recovery.href, "/settings#operational-model");
  assert.equal(h.recovery.textContent, "检查模型连接");
  assert.equal(h.start.hidden, true);
});

test("preserves a full fifteen-second PCM turn at 96 kHz", async () => {
  const h = createHarness({
    mode: "pcm_s16le",
    sampleRate: 96_000,
    response: { status: "active", adviceId: "turn_96k" },
  });
  h.start.click();
  await flush();
  FakeAudioContext.instances[0]!.processor.emit(new Float32Array(1_500_000));
  h.stop.click();
  await flush();
  const sent = h.calls.find((call) => call.url.endsWith("/transcribe"))!;
  assert.equal(sent.init.headers["X-Audio-Rate"], "96000");
  assert.equal((sent.init.body as Blob).size, 2_880_000);
});

test("ignores an old completed event after a newer voice turn starts", async () => {
  let turn = 0;
  const h = createHarness({
    fetch: (url) => {
      if (url === "/test/transcribe") {
        turn += 1;
        return {
          ok: true,
          json: async () => ({
            status: "accepted",
            adviceId: `turn_${turn}`,
            transcript: `请求 ${turn}`,
          }),
        };
      }
      return {
        ok: true,
        blob: async () => new Blob([new Uint8Array([1])]),
      };
    },
  });
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();
  h.start.click();
  await flush();
  FakeRecorder.instances[1]!.emit();
  h.stop.click();
  await flush();

  FakeEvents.instances[0]!.emit("completed");
  await flush();
  assert.equal(h.root.dataset.voiceState, "thinking");
  assert.equal(h.calls.some((call) => call.url.endsWith("/speech")), false);

  FakeEvents.instances[1]!.emit("completed");
  await flush();
  assert.equal(h.calls.some((call) => call.url.endsWith("/speech")), true);
});

test("keeps the current upload controller when an older upload settles", async () => {
  const first = deferred<any>();
  const second = deferred<any>();
  let uploads = 0;
  const h = createHarness({
    fetch: (url) => {
      if (url !== "/test/transcribe")
        return { ok: true, blob: async () => new Blob([new Uint8Array([1])]) };
      uploads += 1;
      return uploads === 1 ? first.promise : second.promise;
    },
  });
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();
  h.start.click();
  await flush();
  FakeRecorder.instances[1]!.emit();
  h.stop.click();
  await flush();

  first.resolve({ ok: true, json: async () => ({ status: "no_input" }) });
  await flush();
  h.cancel.click();
  assert.equal(h.calls.filter((call) => call.url.endsWith("/transcribe")).at(-1)!.init.signal.aborted, true);
});

test("ignores a delayed recorder stop from a replaced voice turn", async () => {
  const h = createHarness();
  FakeRecorder.stopImmediately = false;
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.finish();
  await flush();

  assert.equal(h.calls.filter((call) => call.url.endsWith("/transcribe")).length, 0);
  assert.equal(h.root.dataset.voiceState, "listening");
});

test("confirms a committed turn cancellation with the service before showing cancelled", async () => {
  const stopped = deferred<any>();
  const h = createHarness({
    fetch: (url) => {
      if (url === "/test/transcribe")
        return {
          ok: true,
          json: async () => ({ status: "active", adviceId: "turn_stop" }),
        };
      if (url === "/conversation/turn_stop/stop") return stopped.promise;
      return { ok: true, blob: async () => new Blob([new Uint8Array([1])]) };
    },
  });
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();
  h.cancel.click();
  await flush();

  const request = h.calls.find((call) => call.url === "/conversation/turn_stop/stop")!;
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(request.init.body, "");
  assert.equal(request.init.redirect, "follow");
  assert.equal(h.root.dataset.voiceState, "thinking");

  stopped.resolve({
    status: 200,
    ok: true,
    redirected: true,
    url: "http://localhost/conversation/turn_stop",
  });
  await flush();
  assert.equal(h.root.dataset.voiceState, "cancelled");
  assert.match(
    h.detail.textContent,
    /这次对话已停止。已经开始的动作会继续在活动记录中显示结果。/,
  );
});

test("keeps a committed turn visibly running when its cancellation cannot be confirmed", async () => {
  const h = createHarness({
    fetch: (url) => {
      if (url === "/test/transcribe")
        return {
          ok: true,
          json: async () => ({ status: "active", adviceId: "turn_background" }),
        };
      if (url === "/conversation/turn_background/stop") {
        return {
          status: 200,
          ok: true,
          redirected: true,
          url: "http://localhost/login",
        };
      }
      return { ok: true, blob: async () => new Blob([new Uint8Array([1])]) };
    },
  });
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();
  h.cancel.click();
  await flush();

  assert.equal(h.root.dataset.voiceState, "thinking");
  assert.match(h.detail.textContent, /这次请求仍在继续处理/);
  assert.equal(h.recovery.href, "/conversation/turn_background");
});

test("reveals background continuation and cancellation together after a ten-second wait", async () => {
  const scheduled: Array<{ handler: Handler; delay?: number }> = [];
  const h = createHarness({
    sessionStorage: {
      getItem() { throw new Error("storage unavailable"); },
      setItem() { throw new Error("storage unavailable"); },
      removeItem() { throw new Error("storage unavailable"); },
    },
    setTimeout(handler, delay) {
      scheduled.push({ handler, delay });
      return scheduled.length;
    },
  });
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();

  assert.equal(h.root.dataset.voiceState, "thinking");
  assert.equal(h.background.hidden, true);
  const waitTimer = scheduled.find((entry) => entry.delay === 10_000);
  assert.ok(waitTimer, "thinking should schedule a ten-second wait timer");

  waitTimer!.handler();
  await flush();
  assert.equal(h.background.hidden, false);
  assert.equal(h.cancel.hidden, false);
  assert.equal(h.recovery.hidden, true);
  assert.equal(h.conversation.hidden, false);
  assert.match(h.detail.textContent, /稍后处理/);
});

test("continues one advice in the background, closes voice events, and releases its lease", async () => {
  const scheduled: Array<{ handler: Handler; delay?: number }> = [];
  const h = createHarness({
    fetch: (url) => {
      if (url === "/test/transcribe") {
        return {
          ok: true,
          json: async () => ({
            status: "accepted",
            adviceId: "turn_background_continue",
            transcript: "客厅现在怎么样",
          }),
        };
      }
      if (url === "/conversation/turn_background_continue/background")
        return { status: 200, ok: true, redirected: true, url: "http://localhost/home" };
      return { ok: true, blob: async () => new Blob([new Uint8Array([1])]) };
    },
    setTimeout(handler, delay) {
      scheduled.push({ handler, delay });
      return scheduled.length;
    },
  });
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();
  const waitTimer = scheduled.find((entry) => entry.delay === 10_000);
  assert.ok(waitTimer);
  waitTimer!.handler();
  await flush();

  h.background.click();
  await flush();
  assert.equal(h.root.dataset.voiceState, "thinking");
  assert.match(h.detail.textContent, /已转到后台/);
  assert.equal(h.recovery.href, "/conversation/turn_background_continue");
  assert.equal(h.conversation.href, "/conversation/turn_background_continue");
  const backgroundRequest = h.calls.find(
    (call) => call.url === "/conversation/turn_background_continue/background",
  )!;
  assert.equal(backgroundRequest.init.method, "POST");
  assert.equal(backgroundRequest.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(backgroundRequest.init.body, "");
  assert.equal(backgroundRequest.init.redirect, "follow");
  assert.equal(FakeEvents.instances[0]?.closed, true);
  assert.equal(h.calls.filter((call) => call.url.endsWith("/transcribe")).length, 1);
  assert.equal(h.calls.filter((call) => call.url.endsWith("/release")).length, 1);
  assert.equal(
    h.calls.filter((call) => call.url === "/conversation/turn_background_continue/background").length,
    1,
  );
  assert.equal(h.background.hidden, true);
  assert.equal(h.cancel.hidden, true);
  assert.equal(h.recovery.hidden, true);
  assert.equal(h.conversation.hidden, false);
});

test("keeps both long-wait exits when background continuation is not confirmed", async () => {
  const scheduled: Array<{ handler: Handler; delay?: number }> = [];
  const h = createHarness({
    fetch: (url) => {
      if (url === "/test/transcribe")
        return {
          ok: true,
          json: async () => ({ status: "accepted", adviceId: "turn_background_retry", transcript: "查看客厅" }),
        };
      if (url === "/conversation/turn_background_retry/background")
        return {
          status: 200,
          ok: true,
          redirected: true,
          url: "http://localhost/conversation/turn_background_retry",
        };
      return { ok: true, blob: async () => new Blob([new Uint8Array([1])]) };
    },
    setTimeout(handler, delay) {
      scheduled.push({ handler, delay });
      return scheduled.length;
    },
  });
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();
  scheduled.find((entry) => entry.delay === 10_000)!.handler();
  await flush();
  h.background.click();
  await flush();

  assert.equal(h.root.dataset.voiceState, "thinking");
  assert.match(h.detail.textContent, /暂时无法转到后台/);
  assert.equal(h.background.hidden, false);
  assert.equal(h.cancel.hidden, false);
  assert.equal(h.recovery.hidden, true);
  assert.equal(h.conversation.hidden, false);
  assert.equal(h.conversation.href, "/conversation/turn_background_retry");
});

test("ignores a stale long-wait timer after a newer voice turn starts", async () => {
  const scheduled: Array<{ handler: Handler; delay?: number }> = [];
  let turn = 0;
  const h = createHarness({
    fetch: (url) => {
      if (url === "/test/transcribe") {
        turn += 1;
        const adviceId = turn === 1 ? "turn_old_wait" : "turn_new_wait";
        return {
          ok: true,
          json: async () => ({ status: "accepted", adviceId, transcript: adviceId }),
        };
      }
      return { ok: true, blob: async () => new Blob([new Uint8Array([1])]) };
    },
    setTimeout(handler, delay) {
      scheduled.push({ handler, delay });
      return scheduled.length;
    },
  });
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();
  const oldTimer = scheduled.find((entry) => entry.delay === 10_000)!;
  h.start.click();
  await flush();
  FakeRecorder.instances[1]!.emit();
  h.stop.click();
  await flush();

  oldTimer.handler();
  await flush();
  assert.equal(h.background.hidden, true);
  const newTimer = scheduled.filter((entry) => entry.delay === 10_000).at(-1)!;
  newTimer.handler();
  await flush();
  assert.equal(h.background.hidden, false);
});

test("ignores a late background response after a newer voice turn starts", async () => {
  const scheduled: Array<{ handler: Handler; delay?: number }> = [];
  const background = deferred<any>();
  let turn = 0;
  const h = createHarness({
    fetch: (url) => {
      if (url === "/test/transcribe") {
        turn += 1;
        return {
          ok: true,
          json: async () => ({
            status: "accepted",
            adviceId: turn === 1 ? "turn_old_request" : "turn_new_request",
            transcript: "查看客厅",
          }),
        };
      }
      if (url === "/conversation/turn_old_request/background") return background.promise;
      return { ok: true, blob: async () => new Blob([new Uint8Array([1])]) };
    },
    setTimeout(handler, delay) {
      scheduled.push({ handler, delay });
      return scheduled.length;
    },
  });
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();
  scheduled.find((entry) => entry.delay === 10_000)!.handler();
  await flush();
  h.background.click();
  await flush();

  h.start.click();
  await flush();
  FakeRecorder.instances[1]!.emit();
  h.stop.click();
  await flush();
  assert.equal(h.root.dataset.voiceState, "thinking");
  assert.equal(h.background.hidden, true);

  background.resolve({ status: 200, ok: true, redirected: true });
  await flush();
  assert.equal(h.root.dataset.voiceState, "thinking");
  assert.equal(h.background.hidden, true);
  assert.equal(FakeEvents.instances[1]?.closed, false);
});

test("keeps the exact advice link when a long-wait cancellation is not confirmed", async () => {
  const scheduled: Array<{ handler: Handler; delay?: number }> = [];
  const h = createHarness({
    fetch: (url) => {
      if (url === "/test/transcribe")
        return {
          ok: true,
          json: async () => ({ status: "accepted", adviceId: "turn_long_cancel", transcript: "查看客厅" }),
        };
      if (url === "/conversation/turn_long_cancel/stop") return { status: 500, ok: false };
      return { ok: true, blob: async () => new Blob([new Uint8Array([1])]) };
    },
    setTimeout(handler, delay) {
      scheduled.push({ handler, delay });
      return scheduled.length;
    },
  });
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();
  scheduled.find((entry) => entry.delay === 10_000)!.handler();
  await flush();

  h.cancel.click();
  await flush();
  assert.equal(h.root.dataset.voiceState, "thinking");
  assert.match(h.detail.textContent, /仍在继续处理/);
  assert.equal(h.recovery.hidden, true);
  assert.equal(h.conversation.hidden, false);
  assert.equal(h.conversation.href, "/conversation/turn_long_cancel");
  assert.equal(h.calls.filter((call) => call.url.endsWith("/release")).length, 1);
});

test("clears the ten-second wait timer when the voice surface is destroyed", async () => {
  const scheduled: Array<{ handler: Handler; delay?: number }> = [];
  const h = createHarness({
    setTimeout(handler, delay) {
      scheduled.push({ handler, delay });
      return scheduled.length;
    },
  });
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();
  const waitTimer = scheduled.find((entry) => entry.delay === 10_000);
  assert.ok(waitTimer);
  const waitHandle = scheduled.indexOf(waitTimer!) + 1;

  h.pagehide();
  await flush();
  assert.equal(h.clearedTimers.includes(waitHandle), true);
  waitTimer!.handler();
  await flush();
  assert.equal(h.background.hidden, true);
});

test("stopping speech aborts synthesis before any delayed audio can start", async () => {
  const speech = deferred<any>();
  const h = createHarness({
    fetch: (url) => {
      if (url === "/test/transcribe") {
        return {
          ok: true,
          json: async () => ({ status: "accepted", adviceId: "turn_speech_stop", transcript: "测试播报" }),
        };
      }
      if (url === "/test/speech/turn_speech_stop") return speech.promise;
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  h.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();
  FakeEvents.instances[0]!.emit("completed");
  await flush();

  const speechRequest = h.calls.find((call) => call.url.endsWith("/speech"));
  assert.ok(speechRequest);
  h.speechStop.click();
  assert.equal(speechRequest.init.signal.aborted, true);
  speech.resolve({ ok: true, blob: async () => new Blob([new Uint8Array([1])], { type: "audio/wav" }) });
  await flush();
  assert.equal(FakeAudio.instances.length, 0);
  assert.equal(h.root.dataset.voiceState, "idle");
});

test("keeps permission, cancellation, timeout, and unavailable recovery local and reversible", async () => {
  const denied = createHarness({ permission: "deny" });
  denied.start.click();
  await flush();
  assert.equal(denied.root.dataset.voiceState, "permission_denied");
  assert.equal(denied.recovery.hidden, false);
  const cancelled = createHarness();
  cancelled.start.click();
  await flush();
  cancelled.cancel.click();
  assert.equal(cancelled.root.dataset.voiceState, "cancelled");
  assert.equal(cancelled.streams[0]?.stopped, true);
  assert.equal(cancelled.calls.filter((call) => call.url.endsWith("/transcribe")).length, 0);
  const timed = createHarness();
  timed.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  timed.timers[0]!();
  await flush();
  assert.ok(timed.calls.some((call) => call.url.endsWith("/transcribe")));
  const unavailable = createHarness({ available: false });
  assert.equal(unavailable.root.dataset.voiceState, "text_mode");
  assert.equal(unavailable.start.hidden, true);
});

test("stops a pending microphone request before a late permission grant can record", async () => {
  const permission = deferred<FakeStream>();
  const h = createHarness({ permissionRequest: permission.promise });

  h.start.click();
  await flush();
  assert.equal(h.root.dataset.voiceState, "requesting_permission");
  assert.equal(h.stop.hidden, false);

  h.stop.click();
  assert.equal(h.root.dataset.voiceState, "cancelled");

  const lateStream = new FakeStream();
  permission.resolve(lateStream);
  await flush();
  assert.equal(lateStream.stopped, true);
  assert.equal(FakeRecorder.instances.length, 0);
  assert.equal(h.calls.filter((call) => call.url.endsWith("/transcribe")).length, 0);
});

test("cancels a pending lease acquisition and releases its late lease without disturbing the next turn", async () => {
  const firstLease = deferred<any>();
  let leaseAttempt = 0;
  const h = createHarness({
    leaseRequest: () => {
      leaseAttempt += 1;
      return leaseAttempt === 1
        ? firstLease.promise
        : {
            ok: true,
            json: async () => ({
              status: "leased",
              voiceTurnId: "lease_turn_second_000000",
              captureMode: "encoded_audio",
            }),
          };
    },
  });

  h.start.click();
  await flush();
  assert.equal(h.root.dataset.voiceState, "requesting_permission");
  assert.equal(h.calls[0]?.url, "/voice/turns");

  h.stop.click();
  assert.equal(h.root.dataset.voiceState, "cancelled");
  assert.equal(h.calls[0]?.init.signal.aborted, true);

  h.start.click();
  await flush();
  assert.equal(h.root.dataset.voiceState, "listening");
  assert.equal(FakeRecorder.instances.length, 1);

  firstLease.resolve({
    ok: true,
    json: async () => ({
      status: "leased",
      voiceTurnId: "lease_turn_first_000000",
      captureMode: "encoded_audio",
    }),
  });
  await flush();

  assert.ok(h.calls.some((call) => call.url === "/voice/turns/lease_turn_first_000000/release"));
  assert.equal(h.calls.some((call) => call.url === "/voice/turns/lease_turn_second_000000/release"), false);
  assert.equal(h.root.dataset.voiceState, "listening");
  assert.equal(FakeRecorder.instances.length, 1);
});

test("releases a late lease when the voice surface is disposed during acquisition", async () => {
  const lease = deferred<any>();
  const h = createHarness({ leaseRequest: () => lease.promise });

  h.start.click();
  await flush();
  assert.equal(h.root.dataset.voiceState, "requesting_permission");

  h.pagehide();
  assert.equal(h.calls[0]?.init.signal.aborted, true);
  lease.resolve({
    ok: true,
    json: async () => ({
      status: "leased",
      voiceTurnId: "lease_turn_disposed_000000",
      captureMode: "encoded_audio",
    }),
  });
  await flush();

  assert.ok(h.calls.some((call) => call.url === "/voice/turns/lease_turn_disposed_000000/release"));
  assert.equal(FakeRecorder.instances.length, 0);
});

test("releases an active lease with a keepalive request when the voice surface closes", async () => {
  const h = createHarness();
  h.start.click();
  await flush();
  assert.equal(h.root.dataset.voiceState, "listening");

  h.pagehide();

  const release = h.calls.find((call) => call.url === "/voice/turns/lease_turn_000000/release");
  assert.ok(release);
  assert.equal(release.init.keepalive, true);
  assert.equal(h.streams[0]?.stopped, true);
});

test("releases a lease parsed after cancellation without clearing a later generation", async () => {
  const firstPayload = deferred<any>();
  let leaseAttempt = 0;
  const h = createHarness({
    leaseRequest: () => {
      leaseAttempt += 1;
      if (leaseAttempt === 1) {
        return {
          ok: true,
          json: async () => firstPayload.promise,
        };
      }
      return {
        ok: true,
        json: async () => ({
          status: "leased",
          voiceTurnId: "lease_turn_json_second_000000",
          captureMode: "encoded_audio",
        }),
      };
    },
  });

  h.start.click();
  await flush();
  h.stop.click();
  h.start.click();
  await flush();
  assert.equal(h.root.dataset.voiceState, "listening");

  firstPayload.resolve({
    status: "leased",
    voiceTurnId: "lease_turn_json_first_000000",
    captureMode: "encoded_audio",
  });
  await flush();

  assert.ok(h.calls.some((call) => call.url === "/voice/turns/lease_turn_json_first_000000/release"));
  assert.equal(h.calls.some((call) => call.url === "/voice/turns/lease_turn_json_second_000000/release"), false);
  assert.equal(h.root.dataset.voiceState, "listening");
});
