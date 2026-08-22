import assert from "node:assert/strict";
import test from "node:test";

const ACTIVE_STATES = [
  "idle",
  "requesting_permission",
  "permission_denied",
  "listening",
  "no_input",
  "partial_transcript",
  "transcribing",
  "thinking",
  "presenting_choice",
  "awaiting_confirmation",
  "acting",
  "verifying",
  "speaking",
  "cancelled",
  "failed",
  "indeterminate",
  "text_mode",
] as const;

interface VoiceSurfaceModule {
  readonly VOICE_SURFACE_STATES: readonly string[];
  readonly renderVoiceSurface: (state?: string, options?: VoiceSurfaceRenderOptions) => string | undefined;
  readonly VOICE_INTERACTION_JS: string;
}

interface VoiceSurfaceRenderOptions {
  readonly transcript?: string;
  readonly transcriptKind?: "partial" | "final";
  readonly intent?: {
    readonly room?: string;
    readonly player?: string;
    readonly selection?: string;
    readonly queue?: string;
    readonly volume?: string;
  };
}

async function loadVoiceSurface(): Promise<VoiceSurfaceModule> {
  try {
    return await import("./voice-surface.js") as VoiceSurfaceModule;
  } catch (error) {
    assert.fail(`voice surface implementation is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

test("renders every governed voice state with an honest availability boundary", async () => {
  const { VOICE_SURFACE_STATES, renderVoiceSurface } = await loadVoiceSurface();

  assert.deepEqual(VOICE_SURFACE_STATES, ACTIVE_STATES);
  for (const state of ACTIVE_STATES) {
    const html = renderVoiceSurface(state);
    assert.ok(html);
    assert.match(html, new RegExp(`data-voice-state="${state}"`));
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /改用文字/);
    assert.doesNotMatch(html, /Visual prototype|Preview only|no live services/i);
    for (const forbidden of ["getUserMedia", "MediaRecorder", "WebSocket", "fetch(", "play_media", "mediaRef"]) {
      assert.equal(html.includes(forbidden), false, `${state} leaked active capability ${forbidden}`);
    }
  }
});

test("shows the representative media request with neutral, confirmable intent", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();
  const html = renderVoiceSurface("awaiting_confirmation", {
    transcript: "帮我在多媒体室放一部爵士音乐。",
    transcriptKind: "final",
    intent: {
      room: "多媒体室",
      selection: "晚间爵士",
      queue: "替换当前队列并播放",
    },
  });

  assert.ok(html);
  assert.match(html, /帮我在多媒体室放一部爵士音乐/);
  assert.match(html, /<blockquote lang="zh-CN"[^>]*>帮我在多媒体室放一部爵士音乐。<\/blockquote>/);
  assert.match(html, /多媒体室/);
  assert.match(html, /晚间爵士/);
  assert.match(html, /替换当前队列并播放/);
  assert.match(html, /等待确认/);
  assert.match(html, /href="\/conversation"/);
});

test("does not invent a current intent before a real transcript or intent arrives", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();
  const statesWithoutIntent = ["idle", "requesting_permission", "permission_denied", "no_input", "partial_transcript"];

  for (const state of statesWithoutIntent) {
    const html = renderVoiceSurface(state) ?? "";
    assert.doesNotMatch(html, /帮我在多媒体室放一部爵士音乐|多媒体室|晚间爵士|替换当前队列并播放/);
  }

  assert.match(renderVoiceSurface("idle") ?? "", /点击“开始聆听”|说出房间、内容和动作/);
});

test("renders current understanding only from explicit transcript or structured intent", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();
  const empty = renderVoiceSurface("awaiting_confirmation") ?? "";
  const withTranscript = renderVoiceSurface("partial_transcript", {
    transcript: "帮我在书房",
    transcriptKind: "partial",
  }) ?? "";
  const withIntent = renderVoiceSurface("awaiting_confirmation", {
    intent: { room: "书房", selection: "当前播放列表" },
  }) ?? "";

  assert.doesNotMatch(empty, /product-voice-intent/);
  assert.match(withTranscript, /data-voice-transcript-kind="partial"/);
  assert.match(withTranscript, /帮我在书房/);
  assert.match(withIntent, /aria-label="当前理解"/);
  assert.match(withIntent, /书房/);
});

test("provides permission, no-input, and text recovery exits", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();

  assert.match(renderVoiceSurface("permission_denied") ?? "", /打开麦克风权限|浏览器设置/);
  assert.match(renderVoiceSurface("no_input") ?? "", /没有听到|再试一次/);
  assert.match(renderVoiceSurface("partial_transcript") ?? "", /正在听|继续说/);
  assert.match(renderVoiceSurface("text_mode") ?? "", /输入文字/);
});

test("rejects unknown preview state instead of reflecting it into markup", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();

  assert.equal(renderVoiceSurface("<script>alert(1)</script>"), undefined);
  assert.equal(renderVoiceSurface("playing"), undefined);
});

test("renders a real push-to-talk seam with a canonical conversation form", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();
  const html = renderVoiceSurface("idle");

  assert.ok(html);
  assert.equal(html.match(/data-voice-text-exit/g)?.length, 1);
  assert.match(html, /data-voice-surface/);
  assert.match(html, /data-voice-start/);
  assert.match(html, /data-voice-stop/);
  assert.match(html, /data-voice-transcript/);
  assert.match(html, /data-voice-submit/);
  assert.match(html, /<form[^>]+method="post"[^>]+action="\/conversation"/);
  assert.match(html, /浏览器不支持语音|改用文字/);
  assert.doesNotMatch(html, /Visual prototype|Preview only|状态选择/);
});

test("ships only a local Web Speech adapter and leaves action authority in conversation", async () => {
  const { VOICE_INTERACTION_JS } = await loadVoiceSurface();

  assert.match(VOICE_INTERACTION_JS, /SpeechRecognition/);
  assert.match(VOICE_INTERACTION_JS, /webkitSpeechRecognition/);
  assert.match(VOICE_INTERACTION_JS, /\/conversation/);
  assert.match(VOICE_INTERACTION_JS, /requestSubmit/);
  assert.doesNotMatch(VOICE_INTERACTION_JS, /getUserMedia|MediaRecorder|fetch\(|WebSocket|play_media|mediaRef/);
});
