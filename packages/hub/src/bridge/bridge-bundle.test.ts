import assert from "node:assert/strict";
import test from "node:test";

import {
  createBridgeProductBundle,
  createBuiltinBridgeCatalog,
  createBuiltinBridgeProductBundle,
  productBridgeAdapterRegistration,
} from "./bridge-bundle.js";
import { HOME_ASSISTANT_ADAPTER_REGISTRATION } from "./home-assistant-bridge.js";
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

test("keeps setup peers as a bounded subset of the same runtime product bundle", () => {
  const builtin = createBuiltinBridgeProductBundle();
  const setup = builtin.setupRegistrations[0];
  assert.ok(setup);
  assert.deepEqual(builtin.setupRegistrations.map((registration) => registration.adapterType), ["home-assistant"]);

  assert.throws(() => createBridgeProductBundle({
    adapterRegistrations: [productBridgeAdapterRegistration(HOME_ASSISTANT_ADAPTER_REGISTRATION)],
    setupRegistrations: [{ ...setup, adapterType: "unregistered-peer" }],
  }), /requires a runtime adapter/);
});

test("requires each setup peer to use its runtime adapter's one secret-text credential", () => {
  const setup = createBuiltinBridgeProductBundle().setupRegistrations[0];
  assert.ok(setup);
  const withCredentials = (credentialRequirements: typeof HOME_ASSISTANT_ADAPTER_REGISTRATION.credentialRequirements) => (
    productBridgeAdapterRegistration({ ...HOME_ASSISTANT_ADAPTER_REGISTRATION, credentialRequirements })
  );

  assert.throws(() => createBridgeProductBundle({
    adapterRegistrations: [withCredentials([{ alias: "different-token", kind: "secret_text" }])],
    setupRegistrations: [setup],
  }), /requires exactly one secret_text credential "access-token"/);
  assert.throws(() => createBridgeProductBundle({
    adapterRegistrations: [withCredentials([])],
    setupRegistrations: [setup],
  }), /requires exactly one secret_text credential "access-token"/);
  assert.throws(() => createBridgeProductBundle({
    adapterRegistrations: [withCredentials([
      { alias: "access-token", kind: "secret_text" },
      { alias: "extra-token", kind: "secret_text" },
    ])],
    setupRegistrations: [setup],
  }), /requires exactly one secret_text credential "access-token"/);
  assert.throws(() => createBridgeProductBundle({
    adapterRegistrations: [withCredentials([{ alias: "access-token", kind: "oauth" }])],
    setupRegistrations: [setup],
  }), /requires exactly one secret_text credential "access-token"/);
});

test("rejects repeated setup peers for one runtime adapter", () => {
  const setup = createBuiltinBridgeProductBundle().setupRegistrations[0];
  assert.ok(setup);

  assert.throws(() => createBridgeProductBundle({
    adapterRegistrations: [productBridgeAdapterRegistration(HOME_ASSISTANT_ADAPTER_REGISTRATION)],
    setupRegistrations: [setup, setup],
  }), /repeats setup peer/);
});
