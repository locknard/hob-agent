import type { HomeWorldSnapshot } from "../home-world-service.js";

export type MediaPlayerAvailability = "available" | "unavailable" | "unknown";
export type MediaPlayerPlaybackState =
  | "playing"
  | "paused"
  | "buffering"
  | "idle"
  | "stopped"
  | "unknown";

export interface MediaPlayerInventoryEntry {
  readonly hwCapabilityId: string;
  readonly hwId: string;
  readonly spaces: readonly {
    readonly hwSpaceId: string;
    readonly name?: string;
  }[];
  readonly displayLabel: string;
  readonly availability: MediaPlayerAvailability;
  readonly playbackState: MediaPlayerPlaybackState;
  /** Reported read-side state only; it grants no volume-control authority. */
  readonly volume: {
    readonly reported: boolean;
    readonly level?: number;
  };
}

export interface MediaPlayerInventory {
  readonly players: readonly MediaPlayerInventoryEntry[];
}

interface Binding {
  readonly bridgeId: string;
  readonly nativeId: string;
  readonly nativeInstanceId: string;
  readonly hwSpaceId?: string;
}

/**
 * Projects the authority-selected HomeWorld read model to mediaPlayer@1.
 * Adapter identities are used only for the internal state join and are never
 * copied into the returned inventory.
 */
export function projectMediaPlayerInventory(
  snapshot: HomeWorldSnapshot | unknown,
): MediaPlayerInventory {
  if (!isRecord(snapshot)) return Object.freeze({ players: Object.freeze([]) });
  const spaces = projectSpaces(snapshot.spaces);
  const players: MediaPlayerInventoryEntry[] = [];
  for (const device of arrayOfRecords(snapshot.devices)) {
    const hwId = safeId(device.hwId);
    if (hwId === undefined) continue;
    const displayLabel = safeDisplayText(device.name) ?? "Media player";
    const states = arrayOfRecords(device.states);
    for (const capability of arrayOfRecords(device.capabilities)) {
      if (capability.semanticKind !== "media") continue;
      const hwCapabilityId = safeId(capability.hwCapabilityId);
      if (hwCapabilityId === undefined || safeId(capability.hwId) !== hwId) continue;
      const bindings = projectBindings(capability.bindings);
      if (bindings.length === 0) continue;
      const matchingStates = states.filter((state) => bindings.some((binding) => (
        state.nativeId === binding.nativeId
          && state.nativeInstanceId === binding.nativeInstanceId
      )));
      const matchingBindings = matchingStates.length === 1
        ? bindings.filter((binding) => matchingStates[0]?.nativeId === binding.nativeId
          && matchingStates[0]?.nativeInstanceId === binding.nativeInstanceId)
        : [];
      const selectedBinding = matchingBindings.length === 1 ? matchingBindings[0] : undefined;
      const state = device.health === "unreachable"
        ? unavailableState()
        : device.validity === "valid"
          && device.health !== "unknown"
          && matchingStates.length === 1
          && selectedBinding !== undefined
          && bridgeConnectionUp(snapshot, selectedBinding.bridgeId) === true
          ? projectState(matchingStates[0])
          : emptyState();
      players.push(Object.freeze({
        hwCapabilityId,
        hwId,
        spaces: Object.freeze(projectPlayerSpaces(bindings, spaces)),
        displayLabel,
        availability: state.availability,
        playbackState: state.playbackState,
        volume: Object.freeze(state.volume),
      }));
    }
  }
  players.sort((left, right) => left.hwCapabilityId.localeCompare(right.hwCapabilityId));
  return Object.freeze({ players: Object.freeze(players) });
}

function projectSpaces(value: unknown): ReadonlyMap<string, string | undefined> {
  const spaces = new Map<string, string | undefined>();
  for (const item of arrayOfRecords(value)) {
    const hwSpaceId = safeId(item.hwSpaceId);
    if (hwSpaceId !== undefined && !spaces.has(hwSpaceId)) {
      spaces.set(hwSpaceId, safeDisplayText(item.name));
    }
  }
  return spaces;
}

function projectBindings(value: unknown): Binding[] {
  const bindings: Binding[] = [];
  const seen = new Set<string>();
  for (const item of arrayOfRecords(value)) {
    const bridgeId = safeInternalId(item.bridgeId);
    const nativeId = safeInternalId(item.nativeId);
    const nativeInstanceId = safeInternalId(item.nativeInstanceId);
    const hwSpaceId = safeId(item.hwSpaceId);
    if (bridgeId === undefined || nativeId === undefined || nativeInstanceId === undefined) continue;
    const key = `${bridgeId}\u0000${nativeId}\u0000${nativeInstanceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push({ bridgeId, nativeId, nativeInstanceId, ...(hwSpaceId === undefined ? {} : { hwSpaceId }) });
  }
  return bindings;
}

function projectPlayerSpaces(
  bindings: readonly Binding[],
  spaces: ReadonlyMap<string, string | undefined>,
): Array<{ readonly hwSpaceId: string; readonly name?: string }> {
  const ids = [...new Set(bindings.flatMap((binding) => (
    binding.hwSpaceId === undefined ? [] : [binding.hwSpaceId]
  )))].sort((left, right) => left.localeCompare(right));
  return ids.map((hwSpaceId) => {
    const name = spaces.get(hwSpaceId);
    return { hwSpaceId, ...(name === undefined ? {} : { name }) };
  });
}

function projectState(state: Record<string, unknown> | undefined): {
  readonly availability: MediaPlayerAvailability;
  readonly playbackState: MediaPlayerPlaybackState;
  readonly volume: { readonly reported: boolean; readonly level?: number };
} {
  if (state === undefined || !isRecord(state.attrs)) return emptyState();
  const rawState = typeof state.attrs.state === "string" ? state.attrs.state.trim().toLowerCase() : undefined;
  const available = state.attrs.available;
  const availability: MediaPlayerAvailability = available === false || rawState === "unavailable"
    ? "unavailable"
    : rawState === undefined || rawState === "unknown"
      ? "unknown"
      : "available";
  const level = state.attrs.volumeLevel;
  const volume = availability === "available"
    && typeof level === "number"
    && Number.isFinite(level)
    && level >= 0
    && level <= 1
    ? { reported: true as const, level }
    : { reported: false as const };
  return {
    availability,
    playbackState: availability === "available" ? playbackState(rawState) : "unknown",
    volume,
  };
}

function playbackState(value: string | undefined): MediaPlayerPlaybackState {
  if (value === "playing" || value === "paused" || value === "buffering" || value === "idle" || value === "stopped") {
    return value;
  }
  if (value === "off" || value === "standby") return "stopped";
  return "unknown";
}

function emptyState() {
  return {
    availability: "unknown" as const,
    playbackState: "unknown" as const,
    volume: { reported: false as const },
  };
}

function unavailableState() {
  return {
    availability: "unavailable" as const,
    playbackState: "unknown" as const,
    volume: { reported: false as const },
  };
}

function bridgeConnectionUp(snapshot: Record<string, unknown>, bridgeId: string): boolean | undefined {
  if (!isRecord(snapshot.bridges)) return undefined;
  const bridge = snapshot.bridges[bridgeId];
  if (!isRecord(bridge) || !isRecord(bridge.metrics)) return undefined;
  return bridge.metrics.connection === "up";
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !hasControl(value)
    ? value
    : undefined;
}

function safeInternalId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : undefined;
}

function safeDisplayText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !hasControl(value)
    ? value
    : undefined;
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001F\u007F]/u.test(value);
}
