import assert from "node:assert/strict";
import test from "node:test";

import {
  ORG_HINTS_EXTENSION,
  orgHintPayloadSchema,
} from "./bridge-org-hints.js";

test("defines one bounded neutral non-spatial organization hint", () => {
  assert.deepEqual(ORG_HINTS_EXTENSION, { id: "orgHints", version: "1.0.0" });
  assert.deepEqual(orgHintPayloadSchema.parse({
    nativeId: "device-a",
    spatialDisposition: "non_spatial",
  }), {
    nativeId: "device-a",
    spatialDisposition: "non_spatial",
  });
  assert.equal(orgHintPayloadSchema.safeParse({
    nativeId: "device-a",
    spatialDisposition: "living-room",
  }).success, false);
  assert.equal(orgHintPayloadSchema.safeParse({
    nativeId: "device-a",
    spatialDisposition: "non_spatial",
    nativeServiceType: "addon",
  }).success, false);
});
