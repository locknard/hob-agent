import assert from "node:assert/strict";
import test from "node:test";

const ACTIVE_STATES = [
  "idle",
  "listening",
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
] as const;

interface VoiceSurfaceModule {
  readonly VOICE_SURFACE_STATES: readonly string[];
  readonly renderVoiceSurface: (state?: string) => string | undefined;
}

async function loadVoiceSurface(): Promise<VoiceSurfaceModule> {
  try {
    return await import("./voice-surface.js") as VoiceSurfaceModule;
  } catch (error) {
    assert.fail(`voice surface implementation is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

test("renders every governed voice state without granting microphone, model, catalog, or action authority", async () => {
  const { VOICE_SURFACE_STATES, renderVoiceSurface } = await loadVoiceSurface();

  assert.deepEqual(VOICE_SURFACE_STATES, ACTIVE_STATES);
  for (const state of ACTIVE_STATES) {
    const html = renderVoiceSurface(state);
    assert.ok(html);
    assert.match(html, new RegExp(`data-voice-state="${state}"`));
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /Visual prototype/i);
    assert.match(html, /No microphone, model request, music search, or home control/i);
    for (const forbidden of ["getUserMedia", "MediaRecorder", "WebSocket", "fetch(", "play_media", "mediaRef"]) {
      assert.equal(html.includes(forbidden), false, `${state} leaked active capability ${forbidden}`);
    }
  }
});

test("shows the representative media request as inert household context", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();
  const html = renderVoiceSurface("awaiting_confirmation");

  assert.ok(html);
  assert.match(html, /帮我在多媒体室放一部爵士音乐/);
  assert.match(html, /<blockquote lang="zh-CN">帮我在多媒体室放一部爵士音乐。<\/blockquote>/);
  assert.match(html, /多媒体室/);
  assert.match(html, /晚间爵士/);
  assert.match(html, /Replace queue and play/i);
  assert.match(html, /Waiting for confirmation/i);
  assert.equal(/<(?:button|form)\b/iu.test(html), false);
});

test("rejects unknown preview state instead of reflecting it into markup", async () => {
  const { renderVoiceSurface } = await loadVoiceSurface();

  assert.equal(renderVoiceSurface("<script>alert(1)</script>"), undefined);
  assert.equal(renderVoiceSurface("playing"), undefined);
});
