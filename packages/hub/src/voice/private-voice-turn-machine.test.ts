import assert from "node:assert/strict";
import test from "node:test";

import {
  activePrivateVoicePhase,
  initialPrivateVoiceRuntimeState,
  reducePrivateVoiceTurn,
  type PrivateVoiceRuntimeState,
} from "./private-voice-turn-machine.js";

function transition(state: PrivateVoiceRuntimeState, event: Parameters<typeof reducePrivateVoiceTurn>[1]) {
  return reducePrivateVoiceTurn(state, event);
}

function begin(turnId = "turn-a") {
  return transition(initialPrivateVoiceRuntimeState(), { type: "begin", turnId });
}

function listening(turnId = "turn-a") {
  const started = begin(turnId);
  return transition(started.state, { type: "microphone_granted", turnId });
}

function understanding(turnId = "turn-a") {
  const heard = listening(turnId);
  const finalizing = transition(heard.state, { type: "endpoint", turnId });
  return transition(finalizing.state, { type: "final", turnId, text: "播放爵士乐" });
}

test("accepts one final transcript only after an endpoint and submits it once", () => {
  const heard = listening();
  const partial = transition(heard.state, { type: "partial", turnId: "turn-a", text: "播放爵士" });
  assert.equal(activePrivateVoicePhase(partial.state), "partial");
  assert.deepEqual(partial.effects, []);

  const finalizing = transition(partial.state, { type: "endpoint", turnId: "turn-a" });
  assert.equal(activePrivateVoicePhase(finalizing.state), "finalizing");
  assert.deepEqual(finalizing.effects, [{ type: "stop_capture", turnId: "turn-a" }]);

  const firstFinal = transition(finalizing.state, { type: "final", turnId: "turn-a", text: "播放爵士乐" });
  assert.equal(activePrivateVoicePhase(firstFinal.state), "understanding");
  assert.deepEqual(firstFinal.effects, [{ type: "submit_final", turnId: "turn-a", text: "播放爵士乐" }]);

  const duplicate = transition(firstFinal.state, { type: "final", turnId: "turn-a", text: "关闭灯" });
  assert.equal(activePrivateVoicePhase(duplicate.state), "understanding");
  assert.deepEqual(duplicate.effects, []);
});

test("keeps partial recognition out of the Agent and ignores stale turn events", () => {
  const heard = listening("turn-a");
  const stale = transition(heard.state, { type: "partial", turnId: "turn-b", text: "关闭门锁" });
  assert.equal(activePrivateVoicePhase(stale.state), "listening");
  assert.deepEqual(stale.effects, []);

  const partial = transition(stale.state, { type: "partial", turnId: "turn-a", text: "关闭门锁" });
  assert.equal(partial.state.turns["turn-a"]?.partialTranscript, "关闭门锁");
  assert.equal(partial.state.turns["turn-a"]?.finalTranscript, undefined);
});

test("submits one fresh clarification answer after the earlier final has already reached the Agent", () => {
  const first = understanding();
  const clarification = transition(first.state, { type: "agent_clarification", turnId: "turn-a" });
  const listeningAgain = transition(clarification.state, { type: "listen_again", turnId: "turn-a" });
  assert.equal(listeningAgain.state.turns["turn-a"]?.finalTranscript, undefined);
  assert.equal(listeningAgain.state.turns["turn-a"]?.partialTranscript, undefined);

  const finalizingAgain = transition(listeningAgain.state, { type: "endpoint", turnId: "turn-a" });
  const secondFinal = transition(finalizingAgain.state, { type: "final", turnId: "turn-a", text: "在多媒体室播放" });
  assert.equal(activePrivateVoicePhase(secondFinal.state), "understanding");
  assert.deepEqual(secondFinal.effects, [{ type: "submit_final", turnId: "turn-a", text: "在多媒体室播放" }]);

  const duplicate = transition(secondFinal.state, { type: "final", turnId: "turn-a", text: "重复提交" });
  assert.deepEqual(duplicate.effects, []);
});

test("uses the progressive three-no-input recovery ladder and preserves the text exit", () => {
  const first = transition(listening().state, { type: "no_input", turnId: "turn-a" });
  assert.equal(activePrivateVoicePhase(first.state), "clarifying");
  assert.deepEqual(first.effects, [
    { type: "abort_asr", turnId: "turn-a" },
    { type: "reprompt", turnId: "turn-a", level: "shorter" },
  ]);

  const secondListening = transition(first.state, { type: "listen_again", turnId: "turn-a" });
  const second = transition(secondListening.state, { type: "no_input", turnId: "turn-a" });
  assert.deepEqual(second.effects, [
    { type: "abort_asr", turnId: "turn-a" },
    { type: "reprompt", turnId: "turn-a", level: "example" },
  ]);

  const thirdListening = transition(second.state, { type: "listen_again", turnId: "turn-a" });
  const third = transition(thirdListening.state, { type: "no_input", turnId: "turn-a" });
  assert.equal(activePrivateVoicePhase(third.state), "text_mode");
  assert.deepEqual(third.effects, [
    { type: "abort_asr", turnId: "turn-a" },
    { type: "offer_text_mode", turnId: "turn-a" },
  ]);
});

test("moves permission denial to a stable text exit without requesting the microphone again", () => {
  const started = begin();
  const denied = transition(started.state, { type: "microphone_denied", turnId: "turn-a" });
  assert.equal(activePrivateVoicePhase(denied.state), "permission_denied");
  assert.deepEqual(denied.effects, []);

  const text = transition(denied.state, { type: "open_text_mode", turnId: "turn-a" });
  assert.equal(activePrivateVoicePhase(text.state), "text_mode");
  assert.deepEqual(text.effects, [{ type: "offer_text_mode", turnId: "turn-a" }]);
});

test("requires a bound, active confirmation before the Hub request starts", () => {
  const ready = transition(understanding().state, { type: "agent_confirmation", turnId: "turn-a", ticketId: "ticket-a" });
  assert.equal(activePrivateVoicePhase(ready.state), "confirming");

  const rejected = transition(ready.state, {
    type: "confirm",
    turnId: "turn-a",
    ticketId: "ticket-a",
    ticketActive: true,
    privateDeviceBound: false,
  });
  assert.equal(activePrivateVoicePhase(rejected.state), "clarifying");
  assert.deepEqual(rejected.effects, [{ type: "request_screen_confirmation", turnId: "turn-a", ticketId: "ticket-a" }]);

  const readyAgain = transition(understanding().state, { type: "agent_confirmation", turnId: "turn-a", ticketId: "ticket-a" });
  const accepted = transition(readyAgain.state, {
    type: "confirm",
    turnId: "turn-a",
    ticketId: "ticket-a",
    ticketActive: true,
    privateDeviceBound: true,
  });
  assert.equal(activePrivateVoicePhase(accepted.state), "executing");
  assert.deepEqual(accepted.effects, [{ type: "confirm_hub_ticket", turnId: "turn-a", ticketId: "ticket-a" }]);
});

test("lets the Hub result alone decide verified, failed, and unknown action outcomes", () => {
  const confirming = transition(understanding().state, { type: "agent_confirmation", turnId: "turn-a", ticketId: "ticket-a" });
  const executing = transition(confirming.state, {
    type: "confirm", turnId: "turn-a", ticketId: "ticket-a", ticketActive: true, privateDeviceBound: true,
  });
  const claimed = transition(executing.state, { type: "hub_claimed", turnId: "turn-a", ticketId: "ticket-a" });
  const verifying = transition(claimed.state, { type: "hub_result", turnId: "turn-a", result: "verifying" });
  assert.equal(activePrivateVoicePhase(verifying.state), "verifying");

  const verified = transition(verifying.state, { type: "hub_result", turnId: "turn-a", result: "verified", spokenSummary: "客厅灯已经关了" });
  assert.equal(activePrivateVoicePhase(verified.state), "speaking");
  assert.deepEqual(verified.effects, [{ type: "start_tts", turnId: "turn-a", text: "客厅灯已经关了" }]);

  const unknown = transition(verifying.state, { type: "hub_result", turnId: "turn-a", result: "unknown" });
  assert.equal(activePrivateVoicePhase(unknown.state), "indeterminate");
  assert.deepEqual(unknown.effects, []);
});

test("rejects impossible action results before the Hub claims and verifies the action", () => {
  const confirming = transition(understanding().state, { type: "agent_confirmation", turnId: "turn-a", ticketId: "ticket-a" });
  const executing = transition(confirming.state, {
    type: "confirm", turnId: "turn-a", ticketId: "ticket-a", ticketActive: true, privateDeviceBound: true,
  });
  const unclaimed = transition(executing.state, { type: "hub_result", turnId: "turn-a", result: "verified", spokenSummary: "完成了" });
  assert.equal(activePrivateVoicePhase(unclaimed.state), "executing");
  assert.deepEqual(unclaimed.effects, []);

  const claimed = transition(executing.state, { type: "hub_claimed", turnId: "turn-a", ticketId: "ticket-a" });
  const earlyVerified = transition(claimed.state, { type: "hub_result", turnId: "turn-a", result: "verified", spokenSummary: "完成了" });
  assert.equal(activePrivateVoicePhase(earlyVerified.state), "executing");
  assert.deepEqual(earlyVerified.effects, []);
});

test("cancels local ASR, DSH, and TTS work while preserving a Hub-claimed action", () => {
  const hearing = transition(listening().state, { type: "cancel", turnId: "turn-a" });
  assert.equal(activePrivateVoicePhase(hearing.state), "interrupted");
  assert.deepEqual(hearing.effects, [{ type: "abort_asr", turnId: "turn-a" }]);

  const waiting = understanding();
  const interrupted = transition(waiting.state, { type: "cancel", turnId: "turn-a" });
  assert.equal(activePrivateVoicePhase(interrupted.state), "interrupted");
  assert.deepEqual(interrupted.effects, [{ type: "abort_dsh", turnId: "turn-a" }]);

  const answer = transition(understanding().state, { type: "agent_answer", turnId: "turn-a", text: "客厅温度是二十四度" });
  const stoppedSpeech = transition(answer.state, { type: "cancel", turnId: "turn-a" });
  assert.equal(activePrivateVoicePhase(stoppedSpeech.state), "interrupted");
  assert.deepEqual(stoppedSpeech.effects, [{ type: "abort_tts", turnId: "turn-a" }]);

  const confirming = transition(understanding().state, { type: "agent_confirmation", turnId: "turn-a", ticketId: "ticket-a" });
  const executing = transition(confirming.state, {
    type: "confirm", turnId: "turn-a", ticketId: "ticket-a", ticketActive: true, privateDeviceBound: true,
  });
  const claimed = transition(executing.state, { type: "hub_claimed", turnId: "turn-a", ticketId: "ticket-a" });
  const backgrounded = transition(claimed.state, { type: "cancel", turnId: "turn-a" });
  assert.equal(activePrivateVoicePhase(backgrounded.state), "idle");
  assert.equal(backgrounded.state.turns["turn-a"]?.phase, "executing");
  assert.equal(backgrounded.state.turns["turn-a"]?.foreground, false);
  assert.deepEqual(backgrounded.effects, [{ type: "detach_local_wait", turnId: "turn-a" }]);
});

test("barge-in starts an isolated new turn and never cancels a Hub-claimed action", () => {
  const confirming = transition(understanding("turn-a").state, { type: "agent_confirmation", turnId: "turn-a", ticketId: "ticket-a" });
  const executing = transition(confirming.state, {
    type: "confirm", turnId: "turn-a", ticketId: "ticket-a", ticketActive: true, privateDeviceBound: true,
  });
  const claimed = transition(executing.state, { type: "hub_claimed", turnId: "turn-a", ticketId: "ticket-a" });
  const barged = transition(claimed.state, { type: "barge_in", turnId: "turn-b" });

  assert.equal(activePrivateVoicePhase(barged.state), "listening");
  assert.equal(barged.state.turns["turn-a"]?.phase, "executing");
  assert.equal(barged.state.turns["turn-a"]?.foreground, false);
  assert.deepEqual(barged.effects, [
    { type: "detach_local_wait", turnId: "turn-a" },
    { type: "start_capture", turnId: "turn-b" },
  ]);

  const oldResult = transition(barged.state, { type: "hub_result", turnId: "turn-a", result: "unknown" });
  assert.equal(oldResult.state.turns["turn-a"]?.phase, "indeterminate");
  assert.equal(activePrivateVoicePhase(oldResult.state), "listening");
});

test("requires an explicit retry after permission, text, and failure states", () => {
  const permissionDenied = transition(begin().state, { type: "microphone_denied", turnId: "turn-a" });
  const deniedBargeIn = transition(permissionDenied.state, { type: "barge_in", turnId: "turn-b" });
  assert.equal(activePrivateVoicePhase(deniedBargeIn.state), "permission_denied");
  assert.equal(deniedBargeIn.state.turns["turn-b"], undefined);

  const textMode = transition(permissionDenied.state, { type: "open_text_mode", turnId: "turn-a" });
  const textBargeIn = transition(textMode.state, { type: "barge_in", turnId: "turn-b" });
  assert.equal(activePrivateVoicePhase(textBargeIn.state), "text_mode");
  assert.equal(textBargeIn.state.turns["turn-b"], undefined);

  const failed = transition(understanding().state, { type: "agent_failed", turnId: "turn-a" });
  const failedBargeIn = transition(failed.state, { type: "barge_in", turnId: "turn-b" });
  assert.equal(activePrivateVoicePhase(failedBargeIn.state), "failed");
  assert.equal(failedBargeIn.state.turns["turn-b"], undefined);

  const explicitRetry = transition(failedBargeIn.state, { type: "begin", turnId: "turn-b" });
  assert.equal(activePrivateVoicePhase(explicitRetry.state), "wake_detected");
});

test("does not let begin or pre-permission barge-in bypass the active turn lifecycle", () => {
  const waitingForPermission = begin("turn-a");
  const earlyBargeIn = transition(waitingForPermission.state, { type: "barge_in", turnId: "turn-b" });
  assert.equal(activePrivateVoicePhase(earlyBargeIn.state), "wake_detected");
  assert.equal(earlyBargeIn.state.turns["turn-b"], undefined);
  assert.deepEqual(earlyBargeIn.effects, []);

  const confirming = transition(understanding("turn-a").state, { type: "agent_confirmation", turnId: "turn-a", ticketId: "ticket-a" });
  const executing = transition(confirming.state, {
    type: "confirm", turnId: "turn-a", ticketId: "ticket-a", ticketActive: true, privateDeviceBound: true,
  });
  const claimed = transition(executing.state, { type: "hub_claimed", turnId: "turn-a", ticketId: "ticket-a" });
  const bypass = transition(claimed.state, { type: "begin", turnId: "turn-b" });
  assert.equal(bypass.state.activeTurnId, "turn-a");
  assert.equal(bypass.state.turns["turn-b"], undefined);
  assert.deepEqual(bypass.effects, []);
});

test("turn timeouts retain an honest unknown status once the Hub owns execution", () => {
  const confirming = transition(understanding().state, { type: "agent_confirmation", turnId: "turn-a", ticketId: "ticket-a" });
  const executing = transition(confirming.state, {
    type: "confirm", turnId: "turn-a", ticketId: "ticket-a", ticketActive: true, privateDeviceBound: true,
  });
  const claimed = transition(executing.state, { type: "hub_claimed", turnId: "turn-a", ticketId: "ticket-a" });
  const timedOut = transition(claimed.state, { type: "timeout", turnId: "turn-a", scope: "hub" });
  assert.equal(activePrivateVoicePhase(timedOut.state), "indeterminate");
  assert.deepEqual(timedOut.effects, []);
});
