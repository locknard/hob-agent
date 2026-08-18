import assert from "node:assert/strict";
import test from "node:test";

import { projectHomeSnapshot, type HomeWorldSnapshot } from "./dsh-home-snapshot-tool.js";

test("projects accepted world devices with hw ids and controlled provenance bindings", () => {
  const snapshot = {
    spaces: [{
      hwSpaceId: "hws-1",
      name: "Kitchen",
      bindings: [{ bridgeId: "bridge-a", nativeSpaceId: "area-kitchen" }],
    }],
    devices: [{
      hwId: "hw-1",
      name: "Kitchen lamp",
      bindings: [{
        bridgeId: "bridge-a",
        nativeId: "native-a",
        nativeInstanceId: "native-a:main",
        hwSpaceId: "hws-1",
      }],
      capabilities: [{
        hwCapabilityId: "hc-1",
        hwId: "hw-1",
        schema: "synthetic.light",
        schemaVersion: "1.0.0",
        semanticKind: "light",
        bindings: [{
          bridgeId: "bridge-a",
          nativeId: "native-a",
          nativeInstanceId: "native-a:main",
          hwSpaceId: "hws-1",
        }],
      }],
      states: [{
        nativeId: "native-a",
        nativeInstanceId: "native-a:main",
        attrs: { state: "on" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      }],
      validity: "valid",
    }],
    bridgeWatermarks: [],
    diagnostics: [],
  } as unknown as HomeWorldSnapshot;

  const value = projectHomeSnapshot(snapshot);
  assert.deepEqual(value.spaces, [{
    hwSpaceId: "hws-1",
    name: "Kitchen",
    bindings: [{ bridgeId: "bridge-a", nativeSpaceId: "area-kitchen" }],
  }]);
  assert.deepEqual(value.devices, [{
    hwId: "hw-1",
    name: "Kitchen lamp",
    validity: "valid",
    bindings: [{
      bridgeId: "bridge-a",
      nativeId: "native-a",
      nativeInstanceId: "native-a:main",
      hwSpaceId: "hws-1",
    }],
    capabilities: [{
      hwCapabilityId: "hc-1",
      hwId: "hw-1",
      schema: "synthetic.light",
      schemaVersion: "1.0.0",
      semanticKind: "light",
      bindings: [{
        bridgeId: "bridge-a",
        nativeId: "native-a",
        nativeInstanceId: "native-a:main",
        hwSpaceId: "hws-1",
      }],
    }],
    states: [{
      nativeId: "native-a",
      nativeInstanceId: "native-a:main",
      attrs: { state: "on" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    }],
  }]);
});

test("rejects native-only snapshot input at the agent boundary", () => {
  const value = projectHomeSnapshot({
    devices: [{
      nativeId: "native-only",
      capabilities: [{ nativeInstanceId: "cap-1", schema: "synthetic.light", schemaVersion: "1.0.0" }],
      states: [],
      validity: "valid",
    }],
    bridgeWatermarks: [],
    diagnostics: [],
  } as unknown as HomeWorldSnapshot);

  assert.deepEqual(value.devices, []);
});
