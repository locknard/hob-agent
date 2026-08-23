/**
 * Provider-neutral state reduction for one capture surface's private voice
 * turns. Effects describe work for the voice gateway; this module never opens
 * audio, calls DSH, or calls Hub.
 */
export type PrivateVoiceTurnPhase =
  | "wake_detected"
  | "listening"
  | "partial"
  | "finalizing"
  | "understanding"
  | "clarifying"
  | "confirming"
  | "executing"
  | "verifying"
  | "speaking"
  | "interrupted"
  | "failed"
  | "indeterminate"
  | "permission_denied"
  | "text_mode";

export type PrivateVoiceActivePhase = PrivateVoiceTurnPhase | "idle";

export interface PrivateVoiceTurn {
  readonly id: string;
  readonly phase: PrivateVoiceTurnPhase;
  readonly noInputCount: number;
  readonly foreground: boolean;
  readonly partialTranscript?: string;
  readonly finalTranscript?: string;
  readonly ticketId?: string;
  readonly hubClaimed: boolean;
}

/**
 * `activeTurnId` owns microphone interaction. Other turns may remain in
 * execution or verification after a barge-in, so their Hub results still have
 * a truthful destination.
 */
export interface PrivateVoiceRuntimeState {
  readonly activeTurnId?: string;
  readonly turns: Readonly<Record<string, PrivateVoiceTurn>>;
}

export type PrivateVoiceEffect =
  | { readonly type: "start_capture"; readonly turnId: string }
  | { readonly type: "stop_capture"; readonly turnId: string }
  | { readonly type: "abort_asr"; readonly turnId: string }
  | { readonly type: "abort_dsh"; readonly turnId: string }
  | { readonly type: "abort_tts"; readonly turnId: string }
  | { readonly type: "cancel_unclaimed_hub_request"; readonly turnId: string; readonly ticketId: string }
  | { readonly type: "detach_local_wait"; readonly turnId: string }
  | { readonly type: "submit_final"; readonly turnId: string; readonly text: string }
  | { readonly type: "reprompt"; readonly turnId: string; readonly level: "shorter" | "example" }
  | { readonly type: "offer_text_mode"; readonly turnId: string }
  | { readonly type: "request_screen_confirmation"; readonly turnId: string; readonly ticketId: string }
  | { readonly type: "confirm_hub_ticket"; readonly turnId: string; readonly ticketId: string }
  | { readonly type: "start_tts"; readonly turnId: string; readonly text: string };

export type PrivateVoiceTurnEvent =
  | { readonly type: "begin"; readonly turnId: string }
  | { readonly type: "microphone_granted"; readonly turnId: string }
  | { readonly type: "microphone_denied"; readonly turnId: string }
  | { readonly type: "partial"; readonly turnId: string; readonly text: string }
  | { readonly type: "endpoint"; readonly turnId: string }
  | { readonly type: "final"; readonly turnId: string; readonly text: string }
  | { readonly type: "no_input"; readonly turnId: string }
  | { readonly type: "asr_failed"; readonly turnId: string }
  | { readonly type: "listen_again"; readonly turnId: string }
  | { readonly type: "agent_clarification"; readonly turnId: string }
  | { readonly type: "agent_confirmation"; readonly turnId: string; readonly ticketId: string }
  | { readonly type: "agent_answer"; readonly turnId: string; readonly text: string }
  | { readonly type: "agent_failed"; readonly turnId: string }
  | { readonly type: "confirm"; readonly turnId: string; readonly ticketId: string; readonly ticketActive: boolean; readonly privateDeviceBound: boolean }
  | { readonly type: "hub_claimed"; readonly turnId: string; readonly ticketId: string }
  | { readonly type: "hub_result"; readonly turnId: string; readonly result: "verifying" | "verified" | "failed" | "unknown"; readonly spokenSummary?: string }
  | { readonly type: "audio_finished"; readonly turnId: string }
  | { readonly type: "cancel"; readonly turnId: string }
  | { readonly type: "barge_in"; readonly turnId: string }
  | { readonly type: "timeout"; readonly turnId: string; readonly scope: "asr" | "dsh" | "hub" | "tts" }
  | { readonly type: "open_text_mode"; readonly turnId: string };

export interface PrivateVoiceTransition {
  readonly state: PrivateVoiceRuntimeState;
  readonly effects: readonly PrivateVoiceEffect[];
}

const EMPTY_TURNS: Readonly<Record<string, PrivateVoiceTurn>> = Object.freeze({});

export function initialPrivateVoiceRuntimeState(): PrivateVoiceRuntimeState {
  return Object.freeze({ turns: EMPTY_TURNS });
}

export function activePrivateVoicePhase(state: PrivateVoiceRuntimeState): PrivateVoiceActivePhase {
  const active = state.activeTurnId === undefined ? undefined : state.turns[state.activeTurnId];
  return active?.phase ?? "idle";
}

export function reducePrivateVoiceTurn(
  state: PrivateVoiceRuntimeState,
  event: PrivateVoiceTurnEvent,
): PrivateVoiceTransition {
  if (event.type === "begin") return begin(state, event.turnId);
  if (event.type === "barge_in") return bargeIn(state, event.turnId);

  const turn = state.turns[event.turnId];
  if (turn === undefined) return unchanged(state);

  switch (event.type) {
    case "microphone_granted":
      return turn.phase === "wake_detected"
        ? update(state, event.turnId, { ...turn, phase: "listening" }, [{ type: "start_capture", turnId: event.turnId }])
        : unchanged(state);
    case "microphone_denied":
      return turn.phase === "wake_detected"
        ? update(state, event.turnId, { ...turn, phase: "permission_denied" })
        : unchanged(state);
    case "partial":
      return acceptPartial(state, turn, event);
    case "endpoint":
      return endpoint(state, turn);
    case "final":
      return acceptFinal(state, turn, event.text);
    case "no_input":
      return noInput(state, turn);
    case "asr_failed":
      return isAsrPhase(turn.phase)
        ? update(state, event.turnId, { ...turn, phase: "failed" }, [{ type: "abort_asr", turnId: event.turnId }])
        : unchanged(state);
    case "listen_again":
      return turn.phase === "clarifying"
        ? update(
          state,
          event.turnId,
          { ...turn, phase: "listening", partialTranscript: undefined, finalTranscript: undefined },
          [{ type: "start_capture", turnId: event.turnId }],
        )
        : unchanged(state);
    case "agent_clarification":
      return turn.phase === "understanding"
        ? update(state, event.turnId, { ...turn, phase: "clarifying" })
        : unchanged(state);
    case "agent_confirmation":
      return turn.phase === "understanding" && validIdentifier(event.ticketId)
        ? update(state, event.turnId, { ...turn, phase: "confirming", ticketId: event.ticketId })
        : unchanged(state);
    case "agent_answer":
      return agentAnswer(state, turn, event.text);
    case "agent_failed":
      return turn.phase === "understanding"
        ? update(state, event.turnId, { ...turn, phase: "failed" })
        : unchanged(state);
    case "confirm":
      return confirm(state, turn, event);
    case "hub_claimed":
      return turn.phase === "executing" && turn.ticketId === event.ticketId
        ? update(state, event.turnId, { ...turn, hubClaimed: true })
        : unchanged(state);
    case "hub_result":
      return hubResult(state, turn, event);
    case "audio_finished":
      return turn.phase === "speaking" ? removeActiveTurn(state, event.turnId) : unchanged(state);
    case "cancel":
      return cancel(state, turn);
    case "timeout":
      return timeout(state, turn, event.scope);
    case "open_text_mode":
      return textMode(state, turn);
  }
}

function begin(state: PrivateVoiceRuntimeState, turnId: string): PrivateVoiceTransition {
  if (!validIdentifier(turnId) || state.turns[turnId] !== undefined) return unchanged(state);
  const active = state.activeTurnId === undefined ? undefined : state.turns[state.activeTurnId];
  if (active !== undefined && (isCapturePhase(active.phase) || canBargeIn(active.phase))) return unchanged(state);
  const turn: PrivateVoiceTurn = Object.freeze({ id: turnId, phase: "wake_detected", noInputCount: 0, foreground: true, hubClaimed: false });
  return {
    state: freezeState({ activeTurnId: turnId, turns: { ...state.turns, [turnId]: turn } }),
    effects: [],
  };
}

function bargeIn(state: PrivateVoiceRuntimeState, nextTurnId: string): PrivateVoiceTransition {
  if (!validIdentifier(nextTurnId) || state.turns[nextTurnId] !== undefined) return unchanged(state);
  const current = state.activeTurnId === undefined ? undefined : state.turns[state.activeTurnId];
  if (current === undefined) return begin(state, nextTurnId);
  if (!canBargeIn(current.phase)) return unchanged(state);

  const interrupted = interruptTurn(current);
  const next: PrivateVoiceTurn = Object.freeze({ id: nextTurnId, phase: "listening", noInputCount: 0, foreground: true, hubClaimed: false });
  return {
    state: freezeState({
      activeTurnId: nextTurnId,
      turns: { ...state.turns, [current.id]: interrupted.turn, [nextTurnId]: next },
    }),
    effects: [...interrupted.effects, { type: "start_capture", turnId: nextTurnId }],
  };
}

function acceptPartial(state: PrivateVoiceRuntimeState, turn: PrivateVoiceTurn, event: Extract<PrivateVoiceTurnEvent, { type: "partial" }>): PrivateVoiceTransition {
  if (state.activeTurnId !== turn.id || !isNonEmptyText(event.text) || (turn.phase !== "listening" && turn.phase !== "partial")) return unchanged(state);
  return update(state, turn.id, { ...turn, phase: "partial", partialTranscript: event.text });
}

function endpoint(state: PrivateVoiceRuntimeState, turn: PrivateVoiceTurn): PrivateVoiceTransition {
  if (state.activeTurnId !== turn.id || (turn.phase !== "listening" && turn.phase !== "partial")) return unchanged(state);
  return update(state, turn.id, { ...turn, phase: "finalizing" }, [{ type: "stop_capture", turnId: turn.id }]);
}

function acceptFinal(state: PrivateVoiceRuntimeState, turn: PrivateVoiceTurn, text: string): PrivateVoiceTransition {
  if (state.activeTurnId !== turn.id || turn.phase !== "finalizing" || turn.finalTranscript !== undefined || !isNonEmptyText(text)) return unchanged(state);
  return update(state, turn.id, { ...turn, phase: "understanding", finalTranscript: text }, [{ type: "submit_final", turnId: turn.id, text }]);
}

function noInput(state: PrivateVoiceRuntimeState, turn: PrivateVoiceTurn): PrivateVoiceTransition {
  if (state.activeTurnId !== turn.id || !isAsrPhase(turn.phase)) return unchanged(state);
  const count = turn.noInputCount + 1;
  if (count >= 3) {
    return update(state, turn.id, { ...turn, phase: "text_mode", noInputCount: count }, [
      { type: "abort_asr", turnId: turn.id },
      { type: "offer_text_mode", turnId: turn.id },
    ]);
  }
  return update(state, turn.id, { ...turn, phase: "clarifying", noInputCount: count }, [
    { type: "abort_asr", turnId: turn.id },
    { type: "reprompt", turnId: turn.id, level: count === 1 ? "shorter" : "example" },
  ]);
}

function agentAnswer(state: PrivateVoiceRuntimeState, turn: PrivateVoiceTurn, text: string): PrivateVoiceTransition {
  if (turn.phase !== "understanding" || !isNonEmptyText(text)) return unchanged(state);
  const next = { ...turn, phase: "speaking" as const };
  return update(state, turn.id, next, turn.foreground ? [{ type: "start_tts", turnId: turn.id, text }] : []);
}

function confirm(state: PrivateVoiceRuntimeState, turn: PrivateVoiceTurn, event: Extract<PrivateVoiceTurnEvent, { type: "confirm" }>): PrivateVoiceTransition {
  if (turn.phase !== "confirming" || turn.ticketId !== event.ticketId) return unchanged(state);
  if (!event.ticketActive || !event.privateDeviceBound) {
    return update(state, turn.id, { ...turn, phase: "clarifying" }, [{ type: "request_screen_confirmation", turnId: turn.id, ticketId: event.ticketId }]);
  }
  return update(state, turn.id, { ...turn, phase: "executing" }, [{ type: "confirm_hub_ticket", turnId: turn.id, ticketId: event.ticketId }]);
}

function hubResult(state: PrivateVoiceRuntimeState, turn: PrivateVoiceTurn, event: Extract<PrivateVoiceTurnEvent, { type: "hub_result" }>): PrivateVoiceTransition {
  if (!turn.hubClaimed) return unchanged(state);
  if (event.result === "verifying" && turn.phase === "executing") return update(state, turn.id, { ...turn, phase: "verifying" });
  if (event.result === "failed" && (turn.phase === "executing" || turn.phase === "verifying")) return update(state, turn.id, { ...turn, phase: "failed" });
  if (event.result === "unknown" && (turn.phase === "executing" || turn.phase === "verifying")) return update(state, turn.id, { ...turn, phase: "indeterminate" });
  if (event.result === "verified" && turn.phase === "verifying" && isNonEmptyText(event.spokenSummary ?? "")) {
    return update(
      state,
      turn.id,
      { ...turn, phase: "speaking" },
      turn.foreground ? [{ type: "start_tts", turnId: turn.id, text: event.spokenSummary ?? "" }] : [],
    );
  }
  return unchanged(state);
}

function cancel(state: PrivateVoiceRuntimeState, turn: PrivateVoiceTurn): PrivateVoiceTransition {
  const result = interruptTurn(turn);
  return update(state, turn.id, result.turn, result.effects, result.turn.hubClaimed ? turn.id : undefined);
}

function timeout(state: PrivateVoiceRuntimeState, turn: PrivateVoiceTurn, scope: Extract<PrivateVoiceTurnEvent, { type: "timeout" }> ["scope"]): PrivateVoiceTransition {
  if (scope === "hub" && (turn.phase === "executing" || turn.phase === "verifying") && turn.hubClaimed) {
    return update(state, turn.id, { ...turn, phase: "indeterminate" });
  }
  if (scope === "asr" && isAsrPhase(turn.phase)) {
    return update(state, turn.id, { ...turn, phase: "failed" }, [{ type: "abort_asr", turnId: turn.id }]);
  }
  if (scope === "dsh" && turn.phase === "understanding") {
    return update(state, turn.id, { ...turn, phase: "failed" }, [{ type: "abort_dsh", turnId: turn.id }]);
  }
  if (scope === "tts" && turn.phase === "speaking") {
    return update(state, turn.id, { ...turn, phase: "interrupted" }, [{ type: "abort_tts", turnId: turn.id }], turn.id);
  }
  return unchanged(state);
}

function textMode(state: PrivateVoiceRuntimeState, turn: PrivateVoiceTurn): PrivateVoiceTransition {
  if (turn.hubClaimed && (turn.phase === "executing" || turn.phase === "verifying")) {
    return update(state, turn.id, { ...turn, foreground: false }, [{ type: "detach_local_wait", turnId: turn.id }], turn.id);
  }
  const result = interruptTurn(turn);
  return update(state, turn.id, { ...result.turn, phase: "text_mode" }, [...result.effects, { type: "offer_text_mode", turnId: turn.id }]);
}

function interruptTurn(turn: PrivateVoiceTurn): { readonly turn: PrivateVoiceTurn; readonly effects: readonly PrivateVoiceEffect[] } {
  if ((turn.phase === "executing" || turn.phase === "verifying") && turn.hubClaimed) {
    return { turn: { ...turn, foreground: false }, effects: [{ type: "detach_local_wait", turnId: turn.id }] };
  }
  const effects: PrivateVoiceEffect[] = [];
  if (isAsrPhase(turn.phase) || turn.phase === "wake_detected") effects.push({ type: "abort_asr", turnId: turn.id });
  if (turn.phase === "understanding") effects.push({ type: "abort_dsh", turnId: turn.id });
  if (turn.phase === "speaking") effects.push({ type: "abort_tts", turnId: turn.id });
  if (turn.phase === "executing" && !turn.hubClaimed && turn.ticketId !== undefined) {
    effects.push({ type: "cancel_unclaimed_hub_request", turnId: turn.id, ticketId: turn.ticketId });
  }
  return { turn: { ...turn, phase: "interrupted", foreground: false }, effects };
}

function update(
  state: PrivateVoiceRuntimeState,
  turnId: string,
  turn: PrivateVoiceTurn,
  effects: readonly PrivateVoiceEffect[] = [],
  clearActiveTurnId?: string,
): PrivateVoiceTransition {
  const activeTurnId = clearActiveTurnId === turnId ? undefined : state.activeTurnId;
  return {
    state: freezeState({ activeTurnId, turns: { ...state.turns, [turnId]: Object.freeze(turn) } }),
    effects,
  };
}

function removeActiveTurn(state: PrivateVoiceRuntimeState, turnId: string): PrivateVoiceTransition {
  const { [turnId]: _completed, ...turns } = state.turns;
  return { state: freezeState({ activeTurnId: state.activeTurnId === turnId ? undefined : state.activeTurnId, turns }), effects: [] };
}

function unchanged(state: PrivateVoiceRuntimeState): PrivateVoiceTransition {
  return { state, effects: [] };
}

function freezeState(state: PrivateVoiceRuntimeState): PrivateVoiceRuntimeState {
  return Object.freeze({ ...state, turns: Object.freeze(state.turns) });
}

function isAsrPhase(phase: PrivateVoiceTurnPhase): boolean {
  return phase === "wake_detected" || phase === "listening" || phase === "partial" || phase === "finalizing";
}

function isCapturePhase(phase: PrivateVoiceTurnPhase): boolean {
  return isAsrPhase(phase) || phase === "clarifying" || phase === "confirming" || phase === "understanding" || phase === "speaking";
}

function canBargeIn(phase: PrivateVoiceTurnPhase): boolean {
  return phase === "listening"
    || phase === "partial"
    || phase === "finalizing"
    || phase === "understanding"
    || phase === "clarifying"
    || phase === "confirming"
    || phase === "executing"
    || phase === "verifying"
    || phase === "speaking";
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
}

function isNonEmptyText(value: string): boolean {
  return value.trim().length > 0 && value.length <= 4_000 && !/[\u0000-\u001f\u007f]/u.test(value);
}
