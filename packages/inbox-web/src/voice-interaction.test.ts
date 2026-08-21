import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";

import { VOICE_INTERACTION_JS, renderVoiceSurface } from "./voice-surface.js";

type EventHandler = (...args: any[]) => void;

class FakeHTMLElement {
  readonly attributes = new Map<string, string>();
  readonly nodes = new Map<string, FakeHTMLElement | null>();
  readonly listeners = new Map<string, EventHandler>();
  readonly dataset: Record<string, string> = {};
  textContent = "";
  hidden = false;
  value = "";

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  querySelector(selector: string): FakeHTMLElement | null {
    return this.nodes.get(selector) ?? null;
  }

  addEventListener(name: string, handler: EventHandler): void {
    this.listeners.set(name, handler);
  }

  click(): void {
    this.listeners.get("click")?.({ type: "click" });
  }
}

class FakeHTMLButtonElement extends FakeHTMLElement {}
class FakeHTMLAnchorElement extends FakeHTMLElement {}
class FakeHTMLInputElement extends FakeHTMLElement {}
class FakeHTMLFormElement extends FakeHTMLElement {
  submitted = false;

  requestSubmit(): void {
    this.submitted = true;
  }
}

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = "";
  interimResults = false;
  continuous = false;
  maxAlternatives = 0;
  started = false;
  aborted = false;
  onstart?: () => void;
  onresult?: (event: { resultIndex: number; results: Array<{ 0: { transcript: string }; isFinal: boolean }> }) => void;
  onerror?: (event: { error: string }) => void;
  onend?: () => void;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start(): void {
    this.started = true;
    this.onstart?.();
  }

  abort(): void {
    this.aborted = true;
  }

  emitResult(transcript: string, isFinal: boolean): void {
    this.onresult?.({ resultIndex: 0, results: [{ 0: { transcript }, isFinal }] });
  }

  emitError(error: string): void {
    this.onerror?.({ error });
  }

  emitEnd(): void {
    this.onend?.();
  }
}

interface VoiceHarness {
  readonly root: FakeHTMLElement;
  readonly start: FakeHTMLButtonElement;
  readonly stop: FakeHTMLButtonElement;
  readonly restart: FakeHTMLButtonElement;
  readonly submit: FakeHTMLButtonElement;
  readonly transcript: FakeHTMLElement;
  readonly intentTranscript?: FakeHTMLElement;
  readonly transcriptInput: FakeHTMLInputElement;
  readonly form: FakeHTMLFormElement;
}

function createHarness(options: { readonly supportsSpeech?: boolean; readonly action?: string; readonly state?: string; readonly includeIntentNode?: boolean } = {}): VoiceHarness {
  FakeRecognition.instances = [];

  const root = new FakeHTMLElement();
  root.setAttribute("data-voice-state", options.state ?? "idle");
  root.setAttribute("data-voice-submit-action", options.action ?? "/conversation");
  root.setAttribute("data-voice-failure-limit", "3");
  root.setAttribute("data-voice-language", "zh-CN");

  const eyebrow = new FakeHTMLElement();
  const heading = new FakeHTMLElement();
  const status = new FakeHTMLElement();
  const detail = new FakeHTMLElement();
  const transcript = new FakeHTMLElement();
  const intentTranscript = options.includeIntentNode ? new FakeHTMLElement() : undefined;
  const start = new FakeHTMLButtonElement();
  const stop = new FakeHTMLButtonElement();
  const submit = new FakeHTMLButtonElement();
  const restart = new FakeHTMLButtonElement();
  const recovery = new FakeHTMLAnchorElement();
  const fallback = new FakeHTMLElement();
  const transcriptInput = new FakeHTMLInputElement();
  const form = new FakeHTMLFormElement();

  root.nodes.set("[data-voice-eyebrow]", eyebrow);
  root.nodes.set("[data-voice-heading]", heading);
  root.nodes.set("[data-voice-status]", status);
  root.nodes.set("[data-voice-detail]", detail);
  root.nodes.set("[data-voice-transcript]", transcript);
  if (intentTranscript) root.nodes.set("[data-voice-intent-transcript]", intentTranscript);
  root.nodes.set("[data-voice-start]", start);
  root.nodes.set("[data-voice-stop]", stop);
  root.nodes.set("[data-voice-submit]", submit);
  root.nodes.set("[data-voice-restart]", restart);
  root.nodes.set("[data-voice-recovery]", recovery);
  root.nodes.set("[data-voice-fallback]", fallback);
  root.nodes.set("[data-voice-transcript-input]", transcriptInput);
  root.nodes.set("[data-voice-submit-form]", form);

  const window = options.supportsSpeech === false
    ? { SpeechRecognition: undefined, webkitSpeechRecognition: undefined }
    : { SpeechRecognition: FakeRecognition, webkitSpeechRecognition: undefined };
  const document = { querySelectorAll: (selector: string) => selector === "[data-voice-surface]" ? [root] : [] };
  runInNewContext(VOICE_INTERACTION_JS, {
    window,
    document,
    HTMLElement: FakeHTMLElement,
    HTMLButtonElement: FakeHTMLButtonElement,
    HTMLAnchorElement: FakeHTMLAnchorElement,
    HTMLInputElement: FakeHTMLInputElement,
    HTMLFormElement: FakeHTMLFormElement,
  });

  return { root, start, stop, restart, submit, transcript, intentTranscript, transcriptInput, form };
}

test("executes the production adapter from listening through partial and final submission", () => {
  const idleMarkup = renderVoiceSurface("idle") ?? "";
  assert.doesNotMatch(idleMarkup, /data-voice-intent-transcript/);
  const harness = createHarness({ includeIntentNode: idleMarkup.includes("data-voice-intent-transcript") });

  harness.start.click();
  assert.equal(harness.root.dataset.voiceState, "listening");
  const recognition = FakeRecognition.instances.at(-1);
  assert.ok(recognition);

  recognition.emitResult("帮我在书房", false);
  assert.equal(harness.root.dataset.voiceState, "partial_transcript");
  assert.equal(harness.transcript.textContent, "帮我在书房");
  assert.equal(harness.intentTranscript, undefined);
  assert.equal(harness.submit.hidden, true);

  recognition.emitResult("帮我在书房播放音乐", true);
  assert.equal(harness.root.dataset.voiceState, "transcribing");
  assert.equal(harness.transcript.textContent, "帮我在书房播放音乐");
  assert.equal(harness.intentTranscript, undefined);
  assert.equal(harness.submit.hidden, false);

  harness.submit.click();
  assert.equal(harness.root.dataset.voiceState, "thinking");
  assert.equal(harness.transcriptInput.value, "帮我在书房播放音乐");
  assert.equal(harness.form.submitted, true);
  assert.equal(harness.root.getAttribute("data-voice-submit-action"), "/conversation");
});

test("updates the real SSR intent transcript when an explicit transcript exists", () => {
  const seededMarkup = renderVoiceSurface("partial_transcript", {
    transcript: "帮我在书房",
    transcriptKind: "partial",
  }) ?? "";
  assert.match(seededMarkup, /data-voice-intent-transcript/);
  const state = seededMarkup.match(/data-voice-state="([^"]+)"/)?.[1];
  const harness = createHarness({ state, includeIntentNode: seededMarkup.includes("data-voice-intent-transcript") });

  harness.start.click();
  const recognition = FakeRecognition.instances.at(-1);
  assert.ok(recognition);
  recognition.emitResult("帮我在书房", false);
  assert.equal(harness.intentTranscript?.textContent, "帮我在书房");
  recognition.emitResult("帮我在书房播放音乐", true);
  assert.equal(harness.intentTranscript?.textContent, "帮我在书房播放音乐");
});

test("executes permission denial, three no-input failures, stop, and text fallback", () => {
  const denied = createHarness();
  denied.start.click();
  FakeRecognition.instances.at(-1)?.emitError("not-allowed");
  assert.equal(denied.root.dataset.voiceState, "permission_denied");
  assert.equal(denied.root.getAttribute("data-voice-failure-count"), "0");

  const noInput = createHarness();
  noInput.start.click();
  FakeRecognition.instances.at(-1)?.emitEnd();
  assert.equal(noInput.root.dataset.voiceState, "no_input");
  noInput.restart.click();
  FakeRecognition.instances.at(-1)?.emitEnd();
  assert.equal(noInput.root.dataset.voiceState, "no_input");
  noInput.restart.click();
  FakeRecognition.instances.at(-1)?.emitEnd();
  assert.equal(noInput.root.dataset.voiceState, "failed");
  assert.equal(noInput.root.getAttribute("data-voice-failure-count"), "3");

  const stopped = createHarness();
  stopped.start.click();
  const activeRecognition = FakeRecognition.instances.at(-1);
  stopped.stop.click();
  assert.equal(stopped.root.dataset.voiceState, "cancelled");
  assert.equal(activeRecognition?.aborted, true);

  const unsupported = createHarness({ supportsSpeech: false });
  assert.equal(unsupported.root.dataset.voiceState, "text_mode");
  assert.equal(unsupported.start.hidden, true);
  assert.equal(unsupported.form.submitted, false);
});
