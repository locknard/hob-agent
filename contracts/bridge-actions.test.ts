import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIONS_EXTENSION,
  bridgeActionDescriptorRequestSchema,
  bridgeActionDescriptorSchema,
  bridgeActionRequestSchema,
  bridgeActionResultSchema,
  type ActionsExtension,
  type ExtensionHandleRegistry,
} from "./index.js";

test("defines one strict neutral actions extension handle", () => {
  assert.deepEqual(ACTIONS_EXTENSION, { id: "actions", version: "1.0.0" });
  const request = bridgeActionRequestSchema.parse({
    requestId: "action-1",
    action: {
      kind: "set_boolean",
      target: {
        hwCapabilityId: "cap-light",
        binding: {
          bridgeId: "bridge-ha",
          nativeId: "light.living",
          nativeInstanceId: "light.living",
        },
      },
      value: true,
    },
  });
  assert.equal(request.action.kind, "set_boolean");
  assert.deepEqual(bridgeActionResultSchema.parse({ status: "acknowledged" }), { status: "acknowledged" });
  const stopMedia = bridgeActionRequestSchema.parse({
    requestId: "stop-media-1",
    action: {
      kind: "stop_media",
      target: {
        hwCapabilityId: "cap-player",
        binding: {
          bridgeId: "bridge-ha",
          nativeId: "media_player.living",
          nativeInstanceId: "media_player.living:main",
        },
      },
    },
  });
  assert.equal(stopMedia.action.kind, "stop_media");
  assert.throws(() => bridgeActionRequestSchema.parse({
    ...request,
    action: { ...request.action, shell: "rm -rf" },
  }));

  const handle: ActionsExtension = {
    describe: () => undefined,
    execute: async () => ({ status: "acknowledged" }),
  };
  const typed: ExtensionHandleRegistry["actions@1"] = handle;
  assert.equal(typeof typed.execute, "function");
});

test("bounds levels and prepared media references at the bridge boundary", () => {
  const target = {
    hwCapabilityId: "cap-player",
    binding: { bridgeId: "bridge-ha", nativeId: "media_player.den", nativeInstanceId: "media_player.den" },
  };
  assert.equal(bridgeActionRequestSchema.safeParse({
    requestId: "level",
    action: { kind: "set_level", target, level: 1.1 },
  }).success, false);
  assert.equal(bridgeActionRequestSchema.safeParse({
    requestId: "media",
    action: { kind: "play_media", target, mediaRef: "plain text", queueMode: "replace_and_play" },
  }).success, false);
});

test("describes one adapter-owned concrete intent for an exact binding", () => {
  const request = bridgeActionDescriptorRequestSchema.parse({
    target: {
      hwCapabilityId: "cap-light",
      binding: {
        bridgeId: "bridge-ha",
        nativeId: "device-living",
        nativeInstanceId: "entity-light",
      },
    },
    current: {
      state: "on",
      available: true,
    },
  });
  assert.equal(request.current.state, "on");
  assert.deepEqual(bridgeActionDescriptorSchema.parse({
    action: { kind: "set_boolean", value: false },
    reversible: true,
    actionLabel: "关闭",
  }), {
    action: { kind: "set_boolean", value: false },
    reversible: true,
    actionLabel: "关闭",
  });
  assert.equal(bridgeActionDescriptorSchema.safeParse({
    action: { kind: "set_boolean", value: false },
    reversible: true,
    semanticKind: "light",
  }).success, false);
  assert.equal(bridgeActionDescriptorRequestSchema.safeParse({
    ...request,
    target: { ...request.target, name: "living room light" },
  }).success, false);
});
