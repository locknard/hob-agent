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

interface Harness {
  root: Element;
  start: Button;
  stop: Button;
  cancel: Button;
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
  const restart = new Button();
  const speechStop = new Button();
  root.nodes.set("[data-voice-start]", start);
  root.nodes.set("[data-voice-stop]", stop);
  root.nodes.set("[data-voice-cancel]", cancel);
  root.nodes.set("[data-voice-restart]", restart);
  root.nodes.set("[data-voice-speech-stop]", speechStop);
  const recovery = new Anchor();
  root.nodes.set("[data-voice-recovery]", recovery);
  const conversation = new Anchor();
  root.nodes.set("[data-voice-conversation]", conversation);
  const streams: FakeStream[] = [];
  const calls: Array<{ url: string; init: any }> = [];
  const timers: Handler[] = [];
  const result = options.response ?? {
    status: "accepted",
    adviceId: "turn_1",
    transcript: "打开客厅灯",
  };
  const fetch = async (url: string, init: any = {}) => {
    calls.push({ url, init });
    if (options.fetch) return options.fetch(url, init);
    return url.startsWith("/voice/transcribe")
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
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => {} },
    setTimeout: (handler: Handler) => {
      timers.push(handler);
      return timers.length;
    },
    clearTimeout: () => {},
  });
  return {
    root,
    start,
    stop,
    cancel,
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
  };
}
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

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

test("records encoded audio once, transcribes through the private route, streams progress, and plays private speech", async () => {
  const h = createHarness();
  h.start.click();
  await flush();
  assert.equal(h.root.dataset.voiceState, "listening");
  FakeRecorder.instances[0]!.emit();
  h.stop.click();
  await flush();
  assert.equal(h.calls[0]?.url, "/voice/transcribe");
  assert.equal(h.calls[0]?.init.method, "POST");
  assert.equal(h.calls[0]?.init.headers["Content-Type"], "audio/webm");
  assert.equal(h.transcript.textContent, "打开客厅灯");
  assert.equal(FakeEvents.instances[0]?.url, "/conversation/turn_1/events");
  FakeEvents.instances[0]?.emit("completed");
  await flush();
  assert.equal(h.calls[1]?.url, "/voice/speech/turn_1");
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
  const sent = h.calls[0]!;
  assert.equal(sent.url, "/voice/transcribe");
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
      if (url === "/voice/transcribe") {
        return {
          ok: true,
          json: async () => ({ status: "accepted", adviceId: "turn_playback", transcript: "客厅现在怎么样？" }),
        };
      }
      if (url === "/voice/speech/turn_playback") {
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
  assert.equal(h.calls.filter((call) => call.url === "/voice/transcribe").length, 1,
    "playback recovery does not start a new household request");
});

test("respects an ASR retry window while keeping the text exit visible", async () => {
  const h = createHarness({
    fetch: (url) => {
      if (url === "/voice/transcribe") {
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
  const sent = h.calls[0]!;
  assert.equal(sent.init.headers["X-Audio-Rate"], "96000");
  assert.equal((sent.init.body as Blob).size, 2_880_000);
});

test("ignores an old completed event after a newer voice turn starts", async () => {
  let turn = 0;
  const h = createHarness({
    fetch: (url) => {
      if (url === "/voice/transcribe") {
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
  assert.equal(h.calls.some((call) => call.url === "/voice/speech/turn_1"), false);

  FakeEvents.instances[1]!.emit("completed");
  await flush();
  assert.equal(h.calls.some((call) => call.url === "/voice/speech/turn_2"), true);
});

test("keeps the current upload controller when an older upload settles", async () => {
  const first = deferred<any>();
  const second = deferred<any>();
  let uploads = 0;
  const h = createHarness({
    fetch: (url) => {
      if (url !== "/voice/transcribe")
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
  assert.equal(h.calls[1]!.init.signal.aborted, true);
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

  assert.equal(h.calls.length, 0);
  assert.equal(h.root.dataset.voiceState, "listening");
});

test("confirms a committed turn cancellation with the service before showing cancelled", async () => {
  const stopped = deferred<any>();
  const h = createHarness({
    fetch: (url) => {
      if (url === "/voice/transcribe")
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
  assert.equal(request.init.redirect, "manual");
  assert.equal(h.root.dataset.voiceState, "thinking");

  stopped.resolve({ status: 303, ok: false });
  await flush();
  assert.equal(h.root.dataset.voiceState, "cancelled");
});

test("keeps a committed turn visibly running when its cancellation cannot be confirmed", async () => {
  const h = createHarness({
    fetch: (url) => {
      if (url === "/voice/transcribe")
        return {
          ok: true,
          json: async () => ({ status: "active", adviceId: "turn_background" }),
        };
      if (url === "/conversation/turn_background/stop") return { status: 500, ok: false };
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
  assert.match(h.detail.textContent, /处理仍在后台继续/);
  assert.equal(h.recovery.href, "/conversation/turn_background");
});

test("stopping speech aborts synthesis before any delayed audio can start", async () => {
  const speech = deferred<any>();
  const h = createHarness({
    fetch: (url) => {
      if (url === "/voice/transcribe") {
        return {
          ok: true,
          json: async () => ({ status: "accepted", adviceId: "turn_speech_stop", transcript: "测试播报" }),
        };
      }
      if (url === "/voice/speech/turn_speech_stop") return speech.promise;
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

  const speechRequest = h.calls.find((call) => call.url === "/voice/speech/turn_speech_stop");
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
  const cancelled = createHarness();
  cancelled.start.click();
  await flush();
  cancelled.cancel.click();
  assert.equal(cancelled.root.dataset.voiceState, "cancelled");
  assert.equal(cancelled.streams[0]?.stopped, true);
  assert.equal(cancelled.calls.length, 0);
  const timed = createHarness();
  timed.start.click();
  await flush();
  FakeRecorder.instances[0]!.emit();
  timed.timers[0]!();
  await flush();
  assert.equal(timed.calls[0]?.url, "/voice/transcribe");
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
  assert.equal(h.calls.length, 0);
});
