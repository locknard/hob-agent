import { Context, Service } from "@deepseek-ai/cordis";

import {
  initialPrivateVoiceRuntimeState,
  reducePrivateVoiceTurn,
  type PrivateVoiceRuntimeState,
  type PrivateVoiceTransition,
  type PrivateVoiceTurnEvent,
} from "./private-voice-turn-machine.js";

const SURFACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_CAPTURE_SURFACES = 64;

declare module "@deepseek-ai/cordis" {
  interface Context {
    privateVoiceRuntime: PrivateVoiceRuntimeService;
  }
}

/**
 * One small owner for provider-neutral voice-turn state.
 *
 * A capture surface executes returned effects through its ASR/TTS/DSH/Hub
 * ports. This service only serializes state transitions; it owns no microphone,
 * provider connection, Agent authority, or device action.
 */
export class PrivateVoiceRuntimeService extends Service {
  private readonly surfaces = new Map<string, PrivateVoiceRuntimeState>();

  constructor(ctx: Context) {
    super(ctx, "privateVoiceRuntime");
  }

  snapshot(surfaceId: string): PrivateVoiceRuntimeState {
    validateSurfaceId(surfaceId);
    return this.surfaces.get(surfaceId) ?? initialPrivateVoiceRuntimeState();
  }

  dispatch(surfaceId: string, event: PrivateVoiceTurnEvent): PrivateVoiceTransition {
    validateSurfaceId(surfaceId);
    const current = this.surfaces.get(surfaceId);
    if (current === undefined && this.surfaces.size >= MAX_CAPTURE_SURFACES) {
      throw new RangeError("Private voice capture surface limit reached");
    }
    const transition = reducePrivateVoiceTurn(current ?? initialPrivateVoiceRuntimeState(), event);
    this.surfaces.set(surfaceId, transition.state);
    return transition;
  }

  /** Releases local state after a satellite disconnects, while Hub-owned work remains observable. */
  closeSurface(surfaceId: string): boolean {
    validateSurfaceId(surfaceId);
    const state = this.surfaces.get(surfaceId);
    if (state === undefined) return true;
    const hasHubOwnedWork = Object.values(state.turns).some((turn) => turn.hubClaimed
      && (turn.phase === "executing" || turn.phase === "verifying"));
    if (hasHubOwnedWork) return false;
    this.surfaces.delete(surfaceId);
    return true;
  }
}

function validateSurfaceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SURFACE_ID.test(value)) {
    throw new TypeError("Private voice capture surface id is invalid");
  }
}
