import assert from "node:assert/strict";
import test from "node:test";

import { projectHomeSnapshot, type HomeWorldSnapshot } from "./dsh-home-snapshot-tool.js";

test("projects accepted world devices with hw ids and controlled provenance bindings", () => {
  const snapshot = {
    devices: [{
      hwId: "hw-1",
      name: "Kitchen lamp",
      bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "native-a:main" }],
      capabilities: [{
        hwCapabilityId: "hc-1",
        hwId: "hw-1",
        schema: "synthetic.light",
        schemaVersion: "1.0.0",
        bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "native-a:main" }],
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
  assert.deepEqual(value.devices, [{
    hwId: "hw-1",
    name: "Kitchen lamp",
    validity: "valid",
    bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "native-a:main" }],
    capabilities: [{
      hwCapabilityId: "hc-1",
      hwId: "hw-1",
      schema: "synthetic.light",
      schemaVersion: "1.0.0",
      bindings: [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "native-a:main" }],
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
