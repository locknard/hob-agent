import assert from "node:assert/strict";
import test from "node:test";

import type { MediaCatalogCandidate } from "./media-catalog.js";
import type { MediaPlayerInventory } from "./media-player-inventory.js";

interface MediaPlayIntentModule {
  readonly MEDIA_QUEUE_MODES: readonly string[];
  readonly parseMediaPlayIntent: (value: unknown) => unknown;
  readonly prepareMediaPlayIntent: (input: {
    readonly intent: unknown;
    readonly tenantId: string;
    readonly now: number;
    readonly catalog: { resolveMediaRef(input: { tenantId: string; mediaRef: string; now: number }): MediaCatalogCandidate | undefined };
    readonly inventory: MediaPlayerInventory;
  }) => unknown;
}

async function loadIntent(): Promise<MediaPlayIntentModule> {
  try {
    return await import("./media-play-intent.js") as MediaPlayIntentModule;
  } catch (error) {
    assert.fail(`media play intent implementation is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const intent = Object.freeze({
  kind: "play_media",
  playerHwCapabilityId: "hwc-media-room",
  mediaRef: "opaqueMusicRef0001",
  queueMode: "replace_and_play",
});

function candidate(overrides: Partial<MediaCatalogCandidate> = {}): MediaCatalogCandidate {
  return Object.freeze({
    mediaRef: intent.mediaRef,
    title: "晚间爵士",
    kind: "playlist",
    sourceLabel: "Music Assistant",
    playable: true,
    creator: "家庭音乐库",
    durationSeconds: 3_600,
    expiresAt: "2026-08-21T12:01:00.000Z",
    ...overrides,
  });
}

function inventory(overrides: Partial<MediaPlayerInventory["players"][number]> = {}): MediaPlayerInventory {
  return Object.freeze({
    players: Object.freeze([Object.freeze({
      hwCapabilityId: intent.playerHwCapabilityId,
      hwId: "hw-media-room",
      spaces: Object.freeze([{ hwSpaceId: "hws-media-room", name: "多媒体室" }]),
      displayLabel: "多媒体室音响",
      availability: "available" as const,
      playbackState: "idle" as const,
      volume: Object.freeze({ reported: true as const, level: 0.2 }),
      ...overrides,
    })]),
  });
}

test("accepts only one explicit neutral media intent and freezes it", async () => {
  const { MEDIA_QUEUE_MODES, parseMediaPlayIntent } = await loadIntent();

  assert.deepEqual(MEDIA_QUEUE_MODES, ["replace_and_play", "play_next", "add_to_queue"]);
  for (const queueMode of MEDIA_QUEUE_MODES) {
    const parsed = parseMediaPlayIntent({ ...intent, queueMode });
    assert.deepEqual(parsed, { ...intent, queueMode });
    assert.equal(Object.isFrozen(parsed), true);
  }
});

test("rejects native routing, provider locators, credentials, and hidden volume authority without echoing them", async () => {
  const { parseMediaPlayIntent } = await loadIntent();
  const secret = "must-not-echo-secret-token";
  const forbidden = [
    { entity_id: "media_player.cinema" },
    { nativeId: "media_player.cinema" },
    { nativeInstanceId: "ha-main" },
    { service: "media_player.play_media" },
    { uri: "library://track/1" },
    { url: "https://provider.invalid/track/1" },
    { providerItemId: "spotify://track/1" },
    { queueId: "native-queue" },
    { token: secret },
    { volume: 0.8 },
  ];

  for (const extra of forbidden) {
    let thrown: unknown;
    try { parseMediaPlayIntent({ ...intent, ...extra }); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof Error);
    assert.match(thrown.message, /invalid media play intent/i);
    assert.equal(thrown.message.includes(secret), false);
    assert.equal(JSON.stringify(thrown).includes(secret), false);
  }
  for (const invalid of [
    { ...intent, queueMode: undefined },
    { ...intent, queueMode: "play" },
    { ...intent, playerHwCapabilityId: "" },
    { ...intent, mediaRef: "short" },
    { ...intent, mediaRef: "https://provider.invalid/track" },
  ]) {
    assert.throws(() => parseMediaPlayIntent(invalid), /invalid media play intent/i);
  }
});

test("prepares one exact fresh playable candidate for confirmation without execution authority", async () => {
  const { prepareMediaPlayIntent } = await loadIntent();
  const resolutions: unknown[] = [];
  const result = prepareMediaPlayIntent({
    intent,
    tenantId: "household",
    now: Date.parse("2026-08-21T12:00:00.000Z"),
    catalog: {
      resolveMediaRef(input) {
        resolutions.push(input);
        return candidate();
      },
    },
    inventory: inventory(),
  });

  assert.deepEqual(resolutions, [{
    tenantId: "household",
    mediaRef: intent.mediaRef,
    now: Date.parse("2026-08-21T12:00:00.000Z"),
  }]);
  assert.deepEqual(result, {
    status: "requires_confirmation",
    intent,
    player: {
      hwCapabilityId: "hwc-media-room",
      displayLabel: "多媒体室音响",
      spaces: [{ hwSpaceId: "hws-media-room", name: "多媒体室" }],
      playbackState: "idle",
      volume: { reported: true, level: 0.2 },
    },
    media: {
      title: "晚间爵士",
      kind: "playlist",
      sourceLabel: "Music Assistant",
      playable: true,
      creator: "家庭音乐库",
      durationSeconds: 3_600,
    },
  });
  const encoded = JSON.stringify(result);
  for (const forbidden of ["expiresAt", "providerItemId", "nativeId", "entity_id", "service", "uri", "token", "applied", "success", "execute", "ticket"]) {
    assert.equal(encoded.includes(forbidden), false, `preparation leaked ${forbidden}`);
  }
  assert.equal(Object.isFrozen(result), true);
});

test("fails closed for invalid intent, unavailable media, and unproven player state", async () => {
  const { prepareMediaPlayIntent } = await loadIntent();
  const run = (options: {
    readonly value?: unknown;
    readonly resolved?: MediaCatalogCandidate;
    readonly players?: MediaPlayerInventory;
  }) => prepareMediaPlayIntent({
    intent: options.value ?? intent,
    tenantId: "household",
    now: Date.parse("2026-08-21T12:00:00.000Z"),
    catalog: { resolveMediaRef: () => options.resolved },
    inventory: options.players ?? inventory(),
  });

  assert.deepEqual(run({ value: { ...intent, queueMode: "play" } }), { status: "blocked", reason: "invalid_intent" });
  assert.deepEqual(run({}), { status: "blocked", reason: "media_ref_unavailable" });
  assert.deepEqual(run({
    resolved: candidate({ expiresAt: "2026-08-21T11:59:59.999Z" }),
  }), { status: "blocked", reason: "media_ref_unavailable" });
  assert.deepEqual(run({ resolved: candidate({ playable: false }) }), { status: "blocked", reason: "media_not_playable" });
  assert.deepEqual(run({ resolved: candidate(), players: { players: [] } }), { status: "blocked", reason: "player_not_found" });
  assert.deepEqual(run({ resolved: candidate(), players: inventory({ availability: "unavailable" }) }), { status: "blocked", reason: "player_unavailable" });
  assert.deepEqual(run({ resolved: candidate(), players: inventory({ availability: "unknown" }) }), { status: "blocked", reason: "player_state_unknown" });
  assert.deepEqual(run({
    resolved: candidate(),
    players: { players: [inventory().players[0]!, inventory().players[0]!] },
  }), { status: "blocked", reason: "player_ambiguous" });
});

test("rejects invalid trusted preparation configuration with one redacted error", async () => {
  const { prepareMediaPlayIntent } = await loadIntent();
  const base = {
    intent,
    tenantId: "household",
    now: Date.parse("2026-08-21T12:00:00.000Z"),
    catalog: { resolveMediaRef: () => candidate() },
    inventory: inventory(),
  };

  for (const invalid of [
    { ...base, tenantId: "" },
    { ...base, tenantId: " household" },
    { ...base, now: Number.NaN },
    { ...base, catalog: {} },
    { ...base, inventory: undefined },
  ]) {
    assert.throws(() => prepareMediaPlayIntent(invalid as never), /media playback preparation is invalid/i);
  }
});
