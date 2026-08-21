export const VOICE_SURFACE_STATES = Object.freeze([
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
] as const);

export type VoiceSurfaceState = typeof VOICE_SURFACE_STATES[number];

interface StateCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly status: string;
}

const STATE_COPY: Readonly<Record<VoiceSurfaceState, StateCopy>> = Object.freeze({
  idle: { eyebrow: "Ready when you are", heading: "The home is listening for you—not to you", status: "Idle" },
  listening: { eyebrow: "Microphone preview", heading: "Listening", status: "Listening for one household request" },
  transcribing: { eyebrow: "Turning voice into words", heading: "Checking what was heard", status: "Transcribing" },
  thinking: { eyebrow: "One household Agent", heading: "Understanding the room, music, and intent", status: "Thinking" },
  presenting_choice: { eyebrow: "A choice is needed", heading: "Which version feels right?", status: "Presenting choices" },
  awaiting_confirmation: { eyebrow: "Nothing changes yet", heading: "Review the exact action", status: "Waiting for confirmation" },
  acting: { eyebrow: "Exact action only", heading: "Sending the reviewed request", status: "Acting" },
  verifying: { eyebrow: "Trust, then verify", heading: "Checking what happened at home", status: "Verifying playback" },
  speaking: { eyebrow: "Answering out loud", heading: "The result is also shown here", status: "Speaking" },
  cancelled: { eyebrow: "Stopped by the household", heading: "The request was cancelled", status: "Cancelled" },
  failed: { eyebrow: "No hidden retry", heading: "The request did not complete", status: "Failed" },
  indeterminate: { eyebrow: "Honest uncertainty", heading: "The outcome could not be verified", status: "Result uncertain" },
});

export function renderVoiceSurface(requestedState = "idle"): string | undefined {
  if (!isVoiceSurfaceState(requestedState)) return undefined;
  const copy = STATE_COPY[requestedState];
  const stateLinks = VOICE_SURFACE_STATES.map((state) => {
    const current = state === requestedState ? ` aria-current="true"` : "";
    return `<a href="/voice-preview?state=${state}"${current}>${displayState(state)}</a>`;
  }).join("");

  return `<main id="main-content" class="voice-preview" data-voice-state="${requestedState}">
    <header class="voice-preview-header">
      <p class="eyebrow">Visual prototype · no live services</p>
      <h1>A quieter way to talk with your home</h1>
      <p class="muted">No microphone, model request, music search, or home control is connected to this page.</p>
    </header>
    <section class="voice-stage" aria-labelledby="voice-stage-heading">
      <div class="home-pulse" aria-hidden="true">
        <span class="home-pulse-ring home-pulse-room"></span>
        <span class="home-pulse-ring home-pulse-source"></span>
        <span class="home-pulse-ring home-pulse-action"></span>
        <span class="home-pulse-core"></span>
      </div>
      <div class="voice-stage-copy">
        <p class="eyebrow">${copy.eyebrow}</p>
        <h2 id="voice-stage-heading">${copy.heading}</h2>
        <p class="voice-live-status" role="status" aria-live="polite">${copy.status}</p>
      </div>
    </section>
    <section class="voice-turn" aria-label="Simulated household request">
      <p class="voice-speaker">You</p>
      <blockquote lang="zh-CN">帮我在多媒体室放一部爵士音乐。</blockquote>
      <div class="voice-intent-ledger" aria-label="Inert action context">
        <div><span>Room</span><strong>多媒体室</strong></div>
        <div><span>Selection</span><strong>晚间爵士</strong></div>
        <div><span>Queue</span><strong>Replace queue and play</strong></div>
      </div>
      <p class="voice-boundary"><strong>Preview only.</strong> A real version must resolve one neutral player, revalidate a short-lived catalog selection, obtain policy confirmation, and verify playback before saying it succeeded.</p>
    </section>
    <nav class="voice-state-picker" aria-label="Preview voice states">${stateLinks}</nav>
  </main>`;
}

function isVoiceSurfaceState(value: string): value is VoiceSurfaceState {
  return (VOICE_SURFACE_STATES as readonly string[]).includes(value);
}

function displayState(value: VoiceSurfaceState): string {
  return value.split("_").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}
