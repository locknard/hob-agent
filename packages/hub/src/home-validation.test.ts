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
      spaces: [{ hwSpaceId: "secret-space", name: "Private room" }],
      devices: [{
        hwId: "secret-device",
        name: "Private lamp",
        bindings: [{ hwSpaceId: "secret-space" }],
        capabilities: [
          { hwCapabilityId: "secret-cap-1", semanticKind: "light" },
          { hwCapabilityId: "secret-cap-2" },
        ],
        states: [{ attrs: { state: "private-value" } }],
      }],
    },
  });

  assert.deepEqual(report, {
    status: "ready",
    configuredBridges: 1,
    representedBridges: 1,
    bridgeStates: { ready: 1 },
    spaces: 1,
    devices: 1,
    devicesWithSpace: 1,
    devicesWithoutSpace: 0,
    capabilities: 2,
    states: 1,
    semanticKinds: { light: 1, unclassified: 1 },
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
