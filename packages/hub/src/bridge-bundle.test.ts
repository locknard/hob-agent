import assert from "node:assert/strict";
import test from "node:test";

import { createBuiltinBridgeCatalog } from "./bridge-bundle.js";

test("builtin product bundle registers adapters through the neutral catalog", () => {
  const catalog = createBuiltinBridgeCatalog();
  const registration = catalog.requireAdapter("home-assistant");

  assert.equal(registration.adapterType, "home-assistant");
  assert.ok(registration.capabilitySchemas.some((schema) => schema.schema === "ha.entity"));
});
