import assert from "node:assert/strict";
import test from "node:test";

import { projectHomeValidation } from "./home-validation.js";

test("projects only aggregate neutral readiness without household identities or values", () => {
  const report = projectHomeValidation({
    configuredBridgeCount: 1,
    snapshot: {
      bridges: { "secret-bridge-id": {} },
      bridgeWatermarks: [{ bridgeId: "secret-bridge-id", epochId: "secret-epoch", lastSeq: 8 }],
      diagnostics: [{ bridgeId: "secret-bridge-id", connectionState: "ready" }],
      spaces: [
        { hwSpaceId: "secret-space", name: "Private room" },
        { hwSpaceId: "secret-space-2", name: "Other private room" },
      ],
      devices: [{
        hwId: "secret-device",
        name: "Private lamp",
        bindings: [{ hwSpaceId: "secret-space" }],
        capabilities: [
          { hwCapabilityId: "secret-cap-1", semanticKind: "light" },
          { hwCapabilityId: "secret-cap-2" },
        ],
        states: [{ attrs: { state: "private-value" } }],
      }, {
        hwId: "secret-device-stale-space",
        bindings: [{ hwSpaceId: "missing-space" }],
        capabilities: [{ semanticKind: "sensor" }],
        states: [],
      }, {
        hwId: "secret-device-ambiguous",
        bindings: [{ hwSpaceId: "secret-space" }, { hwSpaceId: "secret-space-2" }],
        capabilities: [{ semanticKind: "switch" }],
        states: [],
      }],
    },
    ruleCatalogs: [{
      bridgeId: "secret-bridge-id",
      status: "available",
      rules: [{ ruleRef: "secret-rule", name: "Private automation" }],
    }],
  });

  assert.deepEqual(report, {
    status: "ready",
    configuredBridges: 1,
    representedBridges: 1,
    bridgeStates: { ready: 1 },
    spaces: 2,
    devices: 3,
    devicesWithSingleSpace: 1,
    devicesWithoutSpace: 1,
    devicesWithMultipleSpaces: 1,
    capabilities: 4,
    states: 1,
    semanticKinds: { light: 1, sensor: 1, switch: 1, unclassified: 1 },
    ruleCatalogs: { available: 1, unavailable: 0, totalRules: 1 },
  });
  const serialized = JSON.stringify(report);
  for (const secret of ["secret", "Private", "private-value"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("reports not ready until every configured bridge has ready diagnostics and a watermark", () => {
  assert.equal(projectHomeValidation({
    configuredBridgeCount: 2,
    snapshot: {
      bridges: { a: {}, b: {} },
      bridgeWatermarks: [{ bridgeId: "a" }],
      diagnostics: [
        { bridgeId: "a", connectionState: "ready" },
        { bridgeId: "b", connectionState: "degraded" },
      ],
      spaces: [],
      devices: [],
    },
  }).status, "not_ready");
});
