import assert from "node:assert/strict";
import test from "node:test";

type Availability = "available" | "unavailable" | "unknown";

type PlaybackState =
  | "playing"
  | "paused"
  | "buffering"
  | "idle"
  | "stopped"
  | "unknown";

interface MediaPlayerInventoryEntry {
  readonly hwCapabilityId: string;
  readonly hwId: string;
  readonly spaces: readonly {
    readonly hwSpaceId: string;
    readonly name?: string;
  }[];
  readonly displayLabel: string;
  readonly availability: Availability;
  readonly playbackState: PlaybackState;
  readonly volume: {
    /** A reported level is state evidence, not permission to set volume. */
    readonly reported: boolean;
    readonly level?: number;
  };
}

interface MediaPlayerInventory {
  readonly players: readonly MediaPlayerInventoryEntry[];
}

interface MediaPlayerInventoryModule {
  readonly projectMediaPlayerInventory: (snapshot: unknown) => MediaPlayerInventory;
}

let modulePromise: Promise<MediaPlayerInventoryModule> | undefined;

async function loadMediaPlayerInventoryModule(): Promise<MediaPlayerInventoryModule> {
  if (modulePromise !== undefined) return modulePromise;
  modulePromise = (async () => {
    try {
      const loaded = await import("./media-player-inventory.js") as unknown as Partial<MediaPlayerInventoryModule>;
      if (typeof loaded.projectMediaPlayerInventory !== "function") {
        throw new Error("projectMediaPlayerInventory export is missing");
      }
      return loaded as MediaPlayerInventoryModule;
    } catch (error) {
      assert.fail(
        `mediaPlayer@1 implementation is missing: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
  return modulePromise;
}

function acceptedMediaSnapshot(): Record<string, unknown> {
  const binding = {
    bridgeId: "bridge-ha",
    nativeId: "ha-device-private",
    nativeInstanceId: "ha-entity-private",
    hwSpaceId: "hws-media-room",
  };
  return {
    spaces: [{
      hwSpaceId: "hws-media-room",
      name: "多媒体室",
      bindings: [{ bridgeId: "bridge-ha", nativeSpaceId: "ha-area-private" }],
    }],
    devices: [{
      bridgeId: "bridge-ha",
      hwId: "hw-media-speaker",
      nativeId: binding.nativeId,
      bindings: [binding],
      name: "多媒体室音响",
      capabilities: [{
        hwCapabilityId: "hwc-media-speaker",
        hwId: "hw-media-speaker",
        schema: "ha.entity",
        schemaVersion: "1.0.0",
        semanticKind: "media",
        bindings: [binding],
      }],
      states: [{
        nativeId: binding.nativeId,
        nativeInstanceId: binding.nativeInstanceId,
        attrs: {
          state: "playing",
          available: true,
          volumeLevel: 0.25,
          // These values model hostile adapter-shaped additions and must not
          // become part of the neutral media-player projection.
          entity_id: "media_player.private_room",
          service: "media_player.play_media",
          uri: "spotify://track/private",
        },
        time: { sourceTsQuality: "platform" },
        origin: "observed",
      }],
      health: "reachable",
      validity: "valid",
      // HomeWorld's descriptor is Hub-internal; the projector must not read
      // or copy its adapter/native fields into the inventory.
      descriptor: {
        nativeId: binding.nativeId,
        name: "HA native display name",
        entity_id: "media_player.private_room",
        service: "media_player.play_media",
        uri: "spotify://track/private",
      },
    }],
  };
}

test("projects an accepted media capability and state into neutral mediaPlayer@1 inventory", async () => {
  const { projectMediaPlayerInventory } = await loadMediaPlayerInventoryModule();

  const projected = projectMediaPlayerInventory(acceptedMediaSnapshot());

  assert.deepEqual(projected, {
    players: [{
      hwCapabilityId: "hwc-media-speaker",
      hwId: "hw-media-speaker",
      spaces: [{ hwSpaceId: "hws-media-room", name: "多媒体室" }],
      displayLabel: "多媒体室音响",
      availability: "available",
      playbackState: "playing",
      volume: { reported: true, level: 0.25 },
    }],
  });
  assert.deepEqual(Object.keys(projected.players[0]!).sort(), [
    "availability",
    "displayLabel",
    "hwCapabilityId",
    "hwId",
    "playbackState",
    "spaces",
    "volume",
  ]);
});

test("keeps media-player inventory neutral and honest when state is unavailable or absent", async () => {
  const { projectMediaPlayerInventory } = await loadMediaPlayerInventoryModule();
  const snapshot = acceptedMediaSnapshot();
  const devices = snapshot.devices as Record<string, unknown>[];
  const unavailable = structuredClone(devices[0]!);
  const unavailableState = (unavailable.states as Record<string, unknown>[])[0]!;
  unavailableState.attrs = { state: "unavailable", available: false };
  unavailable.health = "unreachable";
  unavailable.hwId = "hw-media-unavailable";
  const unavailableCapability = (unavailable.capabilities as Record<string, unknown>[])[0]!;
  unavailableCapability.hwCapabilityId = "hwc-media-unavailable";
  unavailableCapability.hwId = "hw-media-unavailable";

  const noState = structuredClone(devices[0]!);
  noState.hwId = "hw-media-no-state";
  noState.name = "未报告状态的音响";
  noState.states = [];
  const noStateCapability = (noState.capabilities as Record<string, unknown>[])[0]!;
  noStateCapability.hwCapabilityId = "hwc-media-no-state";
  noStateCapability.hwId = "hw-media-no-state";

  const nonMedia = structuredClone(devices[0]!);
  nonMedia.hwId = "hw-light-not-player";
  nonMedia.name = "不应进入播放器清单的灯";
  const nonMediaCapability = (nonMedia.capabilities as Record<string, unknown>[])[0]!;
  nonMediaCapability.hwCapabilityId = "hwc-light-not-player";
  nonMediaCapability.hwId = "hw-light-not-player";
  nonMediaCapability.semanticKind = "light";

  snapshot.devices = [unavailable, noState, nonMedia];
  const projected = projectMediaPlayerInventory(snapshot);

  assert.deepEqual(projected.players, [
    {
      hwCapabilityId: "hwc-media-no-state",
      hwId: "hw-media-no-state",
      spaces: [{ hwSpaceId: "hws-media-room", name: "多媒体室" }],
      displayLabel: "未报告状态的音响",
      availability: "unknown",
      playbackState: "unknown",
      volume: { reported: false },
    },
    {
      hwCapabilityId: "hwc-media-unavailable",
      hwId: "hw-media-unavailable",
      spaces: [{ hwSpaceId: "hws-media-room", name: "多媒体室" }],
      displayLabel: "多媒体室音响",
      availability: "unavailable",
      playbackState: "unknown",
      volume: { reported: false },
    },
  ]);
  const serialized = JSON.stringify(projected);
  for (const forbidden of [
    "ha-device-private",
    "ha-entity-private",
    "ha-area-private",
    "media_player.private_room",
    "media_player.play_media",
    "spotify://track/private",
    "ha.entity",
    "light-not-player",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `projection leaked ${forbidden}`);
  }
});

test("does not present stale media state or volume as currently available", async () => {
  const { projectMediaPlayerInventory } = await loadMediaPlayerInventoryModule();
  const snapshot = acceptedMediaSnapshot();
  const device = (snapshot.devices as Record<string, unknown>[])[0]!;
  device.validity = "stale";

  const projected = projectMediaPlayerInventory(snapshot);

  assert.deepEqual(projected.players[0], {
    hwCapabilityId: "hwc-media-speaker",
    hwId: "hw-media-speaker",
    spaces: [{ hwSpaceId: "hws-media-room", name: "多媒体室" }],
    displayLabel: "多媒体室音响",
    availability: "unknown",
    playbackState: "unknown",
    volume: { reported: false },
  });
});

test("fails closed when an explicit available flag conflicts with unknown playback state", async () => {
  const { projectMediaPlayerInventory } = await loadMediaPlayerInventoryModule();
  const snapshot = acceptedMediaSnapshot();
  const device = (snapshot.devices as Record<string, unknown>[])[0]!;
  const state = (device.states as Record<string, unknown>[])[0]!;
  state.attrs = { state: "unknown", available: true, volumeLevel: 0.25 };

  const projected = projectMediaPlayerInventory(snapshot);

  assert.equal(projected.players[0]?.availability, "unknown");
  assert.equal(projected.players[0]?.playbackState, "unknown");
  assert.deepEqual(projected.players[0]?.volume, { reported: false });
});

test("does not reuse a playing state when device health is unreachable", async () => {
  const { projectMediaPlayerInventory } = await loadMediaPlayerInventoryModule();
  const snapshot = acceptedMediaSnapshot();
  const device = (snapshot.devices as Record<string, unknown>[])[0]!;
  device.health = "unreachable";

  const projected = projectMediaPlayerInventory(snapshot);

  assert.equal(projected.players[0]?.availability, "unavailable");
  assert.equal(projected.players[0]?.playbackState, "unknown");
  assert.deepEqual(projected.players[0]?.volume, { reported: false });
});

test("does not reuse a playing state from a disconnected bridge", async () => {
  const { projectMediaPlayerInventory } = await loadMediaPlayerInventoryModule();
  const snapshot = acceptedMediaSnapshot();
  snapshot.bridges = {
    "bridge-ha": { metrics: { connection: "down" } },
  };

  const projected = projectMediaPlayerInventory(snapshot);

  assert.equal(projected.players[0]?.availability, "unknown");
  assert.equal(projected.players[0]?.playbackState, "unknown");
  assert.deepEqual(projected.players[0]?.volume, { reported: false });
});

test("fails closed when equal native state keys occur on multiple bridges", async () => {
  const { projectMediaPlayerInventory } = await loadMediaPlayerInventoryModule();
  const snapshot = acceptedMediaSnapshot();
  const device = (snapshot.devices as Record<string, unknown>[])[0]!;
  const capability = (device.capabilities as Record<string, unknown>[])[0]!;
  const bindings = capability.bindings as Record<string, unknown>[];
  bindings.push({ ...bindings[0], bridgeId: "bridge-second" });

  const projected = projectMediaPlayerInventory(snapshot);

  assert.equal(projected.players[0]?.availability, "unknown");
  assert.equal(projected.players[0]?.playbackState, "unknown");
  assert.deepEqual(projected.players[0]?.volume, { reported: false });
});
