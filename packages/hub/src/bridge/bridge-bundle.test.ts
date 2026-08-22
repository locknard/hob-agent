import assert from "node:assert/strict";
import test from "node:test";

import { createBuiltinBridgeCatalog, createBuiltinBridgeProductBundle } from "./bridge-bundle.js";
import type { XiaomiHomeTransportPlugin } from "./xiaomi-home-bridge.js";

test("builtin product bundle registers adapters through the neutral catalog", () => {
  const catalog = createBuiltinBridgeCatalog();
  const registration = catalog.requireAdapter("home-assistant");

  assert.equal(registration.adapterType, "home-assistant");
  assert.ok(registration.capabilitySchemas.some((schema) => schema.schema === "ha.entity"));
  assert.ok(registration.capabilitySchemas.some((schema) => schema.schema === "ha.cover"));
  assert.equal(catalog.schema("ha.entity", 1)?.schema, "ha.entity");
  assert.equal(catalog.schema("ha.cover", 1)?.schema, "ha.cover");
});

test("registers Xiaomi beside HA only when an authorized transport is supplied", () => {
  const xiaomi: XiaomiHomeTransportPlugin = {
    credentialRequirements: [],
    create: () => ({
      connect: async () => ({ installationId: "fixture", devices: [] }),
      changes: async function* () {},
      resync: async () => ({ installationId: "fixture", devices: [] }),
      dispose: async () => {},
    }),
  };
  const catalog = createBuiltinBridgeCatalog(createBuiltinBridgeProductBundle({ xiaomi }));

  assert.deepEqual(catalog.listAdapters().map((entry) => entry.adapterType), [
    "home-assistant",
    "xiaomi-home",
  ]);
  assert.equal(catalog.ownsNamespace("ha", "home-assistant"), true);
  assert.equal(catalog.ownsNamespace("miot", "xiaomi-home"), true);
});

test("does not claim Xiaomi support without an authorized transport", () => {
  assert.equal(createBuiltinBridgeCatalog().hasAdapter("xiaomi-home"), false);
});
