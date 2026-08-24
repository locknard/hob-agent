import assert from "node:assert/strict";
import test from "node:test";

import { PRODUCT_SHELL_STYLES } from "./product-shell-styles.js";

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
  "playback_failed",
  "cancelled",
  "failed",
  "indeterminate",
  "model_unavailable",
  "text_mode",
] as const;

interface VoiceSurfaceModule {
  readonly VOICE_SURFACE_STATES: readonly string[];
  readonly renderVoiceSurface: (
    state?: string,
    options?: VoiceSurfaceRenderOptions,
  ) => string | undefined;
  readonly VOICE_INTERACTION_JS: string;
}

interface VoiceSurfaceRenderOptions {
  readonly transcript?: string;
  readonly transcriptKind?: "partial" | "final";
  readonly privateVoice?:
    | {
        readonly status: "active";
        readonly captureMode: "encoded_audio" | "pcm_s16le";
      }
    | { readonly status: "retryable" | "unavailable" };
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
    return (await import("./voice-surface.js")) as VoiceSurfaceModule;
  } catch (error) {
    assert.fail(
      `voice surface implementation is missing: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

test("renders every governed voice state with an honest availability boundary", async () => {
  const { VOICE_SURFACE_STATES, renderVoiceSurface } = await loadVoiceSurface();

  assert.deepEqual(VOICE_SURFACE_STATES, ACTIVE_STATES);
  for (const state of ACTIVE_STATES) {
    const html = renderVoiceSurface(state, {
      privateVoice: { status: "active", captureMode: "encoded_audio" },
    });
    assert.ok(html);
    assert.match(html, new RegExp(`data-voice-state="${state}"`));
    assert.match(html, /aria-live="polite"/);
    assert.match(
      html,
      state === "text_mode"
        ? /打开文字对话/
        : state === "model_unavailable"
          ? /检查模型连接/
          : /改用文字/,
    );
    assert.doesNotMatch(
      html,
      /Visual prototype|Preview only|no live services/i,
    );
    for (const forbidden of [
      "getUserMedia",
      "MediaRecorder",
      "WebSocket",
      "fetch(",
      "play_media",
      "mediaRef",
    ]) {
      assert.equal(
        html.includes(forbidden),
        false,
        `${state} leaked active capability ${forbidden}`,
      );
    }
  }
});

test("uses household action language for active, cancelled, and unconfirmed results", async () => {
  const { VOICE_INTERACTION_JS, renderVoiceSurface } = await loadVoiceSurface();
  const acting = renderVoiceSurface("acting") ?? "";
  const cancelled = renderVoiceSurface("cancelled") ?? "";
  const indeterminate = renderVoiceSurface("indeterminate") ?? "";

  assert.match(acting, /这项已确认的动作正在进行。完成后会显示结果。/);
  assert.match(cancelled, /这次对话已停止。已经开始的动作会继续在活动记录中显示结果。/);
  assert.match(indeterminate, /结果尚未确认/);
  assert.match(indeterminate, /结果会显示在活动记录中。/);

  for (const html of [acting, cancelled, indeterminate]) {
    assert.doesNotMatch(html, /\bHub\b/);
  }
  assert.doesNotMatch(VOICE_INTERACTION_JS, /\bHub\b/);
});

test("gives unavailable private voice one clear text continuation", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();
  const html =
    renderVoiceSurface("idle", { privateVoice: { status: "unavailable" } }) ??
    "";

  assert.match(html, /data-voice-state="text_mode"/);
  assert.match(html, /私人语音暂时不可用。文字对话现在就能继续。/);
  assert.match(html, /data-voice-text-exit[^>]* hidden/);
  assert.match(html, /data-voice-recovery[^>]*>打开文字对话</);
  assert.equal(html.match(/>打开文字对话</g)?.length, 1);
  assert.doesNotMatch(html, /data-voice-transcript/);
  assert.doesNotMatch(html, /data-voice-fallback/);
  assert.match(html, /原始录音不写入磁盘/);
  assert.match(html, /请求结束后从内存丢弃/);
  assert.match(html, /回答播报音频只在本机内存中保留最多 30 秒/);
  assert.match(html, /当前对话重播/);
  assert.match(html, /当前语音只用于家庭问答/);
  assert.match(html, /不会直接发起设备或媒体动作/);
  assert.doesNotMatch(html, /结果会保留在活动记录中/);
});

test("describes the shipped voice path as read-only advice rather than an action surface", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();
  const listening = renderVoiceSurface("listening", { privateVoice: { status: "active" } }) ?? "";
  assert.match(listening, /说出你想问家里的事/);
  assert.doesNotMatch(listening, /想让家里做的事|房间、内容和动作/);

  const modelUnavailable = renderVoiceSurface("model_unavailable", { privateVoice: { status: "active" } }) ?? "";
  assert.match(modelUnavailable, /本次语音尚未转写/);
  assert.doesNotMatch(modelUnavailable, /已经完成转写/);
});

test("keeps a working private voice distinct from a recovering household model", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();
  const html = renderVoiceSurface("model_unavailable", {
    privateVoice: { status: "active", captureMode: "encoded_audio" },
  }) ?? "";

  assert.match(html, /家庭助手模型正在恢复/);
  assert.match(html, /href="\/settings#operational-model"/);
  assert.match(html, /data-voice-start hidden/);
  assert.doesNotMatch(html, /私人语音暂时不可用/);
  assert.doesNotMatch(html, /打开文字对话/);
});

test("describes the input recording and short answer replay cache as separate private audio lifecycles", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();
  const html = renderVoiceSurface("transcribing", {
    privateVoice: { status: "active", captureMode: "encoded_audio" },
  }) ?? "";

  assert.match(html, /原始录音只用于这次转写，请求结束后从内存丢弃。/);
  const detail = html.match(/data-voice-detail>([^<]*)</)?.[1] ?? "";
  assert.equal(detail, "原始录音只用于这次转写，请求结束后从内存丢弃。");
  assert.doesNotMatch(html, /录音已完成，正在转成文字；完成后显示全文。/);
  assert.match(html, /data-voice-capture-progress[^>]*hidden/);
  assert.match(html, /回答播报音频只在本机内存中保留最多 30 秒/);
  assert.doesNotMatch(html, /音频只用于这次转写，不会留存。/);
});

test("keeps reconnect alongside the single text exit while private voice recovers", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();
  const html =
    renderVoiceSurface("idle", { privateVoice: { status: "retryable" } }) ??
    "";

  assert.match(html, /data-voice-state="text_mode"/);
  assert.match(html, /data-voice-text-exit[^>]* hidden/);
  assert.match(html, />重新连接私人语音</);
  assert.equal(html.match(/>打开文字对话</g)?.length, 1);
  assert.doesNotMatch(html, /data-voice-transcript/);
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
  assert.match(
    html,
    /<blockquote lang="zh-CN"[^>]*>帮我在多媒体室放一部爵士音乐。<\/blockquote>/,
  );
  assert.match(html, /多媒体室/);
  assert.match(html, /晚间爵士/);
  assert.match(html, /替换当前队列并播放/);
  assert.match(html, /等待确认/);
  assert.match(html, /href="\/conversation"/);
});

test("does not invent a current intent before a real transcript or intent arrives", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();
  const statesWithoutIntent = [
    "idle",
    "requesting_permission",
    "permission_denied",
    "no_input",
    "partial_transcript",
  ];

  for (const state of statesWithoutIntent) {
    const html =
      renderVoiceSurface(state, {
        privateVoice: { status: "active", captureMode: "encoded_audio" },
      }) ?? "";
    assert.doesNotMatch(
      html,
      /帮我在多媒体室放一部爵士音乐|多媒体室|晚间爵士|替换当前队列并播放/,
    );
  }

  assert.match(renderVoiceSurface("idle") ?? "", /开始聆听|一次要说的话/);
});

test("renders current understanding only from explicit transcript or structured intent", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();
  const empty = renderVoiceSurface("awaiting_confirmation") ?? "";
  const withTranscript =
    renderVoiceSurface("partial_transcript", {
      transcript: "帮我在书房",
      transcriptKind: "partial",
    }) ?? "";
  const withIntent =
    renderVoiceSurface("awaiting_confirmation", {
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

  assert.match(
    renderVoiceSurface("permission_denied") ?? "",
    /打开麦克风权限|浏览器设置/,
  );
  assert.match(renderVoiceSurface("no_input") ?? "", /没有听清。再说一次就好。/);
  assert.match(renderVoiceSurface("partial_transcript") ?? "", /正在听|继续说/);
  assert.match(renderVoiceSurface("text_mode") ?? "", /用文字继续/);
});

test("rejects unknown preview state instead of reflecting it into markup", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();

  assert.equal(renderVoiceSurface("<script>alert(1)</script>"), undefined);
  assert.equal(renderVoiceSurface("playing"), undefined);
});

test("renders a private push-to-talk seam only when the configured voice pair is active", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();
  const html = renderVoiceSurface("idle", {
    privateVoice: { status: "active", captureMode: "encoded_audio" },
  });

  assert.ok(html);
  assert.equal(html.match(/data-voice-text-exit/g)?.length, 1);
  assert.match(html, /data-voice-surface/);
  assert.match(html, /data-voice-start/);
  assert.match(html, /data-voice-stop/);
  assert.match(html, /data-voice-transcript/);
  assert.match(html, /data-voice-background/);
  assert.match(html, /稍后处理/);
  assert.match(html, /data-private-voice-status="active"/);
  assert.doesNotMatch(html, /data-private-voice-capture-mode/);
  assert.match(html, /data-voice-cancel/);
  assert.match(html, /data-voice-speech-stop/);
  assert.match(html, /浏览器不支持语音|改用文字/);
  assert.doesNotMatch(html, /Visual prototype|Preview only|状态选择/);
});

test("uses only bounded private ASR and TTS routes, never browser speech recognition", async () => {
  const { VOICE_INTERACTION_JS, renderVoiceSurface } = await loadVoiceSurface();

  assert.doesNotMatch(
    VOICE_INTERACTION_JS,
    /SpeechRecognition|webkitSpeechRecognition|speechSynthesis/,
  );
  assert.match(VOICE_INTERACTION_JS, /getUserMedia/);
  assert.match(VOICE_INTERACTION_JS, /MediaRecorder/);
  assert.match(VOICE_INTERACTION_JS, /AudioContext/);
  assert.match(VOICE_INTERACTION_JS, /\/voice\/turns/);
  assert.match(VOICE_INTERACTION_JS, /\/transcribe/);
  assert.match(VOICE_INTERACTION_JS, /\/speech/);
  assert.match(VOICE_INTERACTION_JS, /\/release/);
  assert.match(VOICE_INTERACTION_JS, /EventSource/);
  assert.match(VOICE_INTERACTION_JS, /X-Audio-Rate/);
  assert.match(VOICE_INTERACTION_JS, /X-Audio-Width/);
  assert.match(VOICE_INTERACTION_JS, /X-Audio-Channels/);
  assert.doesNotMatch(VOICE_INTERACTION_JS, /play_media|mediaRef/);

  const unavailable =
    renderVoiceSurface("idle", { privateVoice: { status: "unavailable" } }) ??
    "";
  assert.match(unavailable, /data-private-voice-status="unavailable"/);
  assert.match(unavailable, /data-voice-state="text_mode"/);
  assert.match(unavailable, /私人语音暂时不可用|改用文字/);
  assert.match(unavailable, /data-voice-start hidden/);

  const retryable =
    renderVoiceSurface("idle", { privateVoice: { status: "retryable" } }) ??
    "";
  assert.match(retryable, /data-private-voice-status="retryable"/);
  assert.match(retryable, /action="\/voice\/retry"/);
  assert.match(retryable, />重新连接私人语音</);
  assert.match(retryable, /data-voice-start hidden/);

  const recovering =
    renderVoiceSurface("idle", { privateVoice: { status: "recovering" } }) ??
    "";
  assert.match(recovering, /data-private-voice-status="recovering"/);
  assert.match(recovering, /正在恢复私人语音/);
  assert.match(recovering, /action="\/voice\/cancel-retry"/);
  assert.match(recovering, /href="\/conversation"/);
});

test("animates the voice indicator only while a household member is speaking", () => {
  assert.match(PRODUCT_SHELL_STYLES, /\.product-voice-indicator[^}]*animation-play-state:\s*paused/u);
  assert.match(PRODUCT_SHELL_STYLES, /data-voice-state="listening"[^}]*animation-play-state:\s*running/u);
  assert.match(PRODUCT_SHELL_STYLES, /data-voice-state="partial_transcript"[^}]*animation-play-state:\s*running/u);
});
