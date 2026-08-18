import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  BridgeCatalog,
  BridgeCatalogError,
  type BridgeAdapter,
  type AdapterRegistration,
} from "./bridge-catalog.js";

interface TestConfig {
  endpoint: string;
}

function registration(
  adapterType: string,
  schemas: AdapterRegistration<TestConfig>["capabilitySchemas"],
): AdapterRegistration<TestConfig> {
  return {
    adapterType,
    configSchema: z.object({ endpoint: z.string() }),
    credentialRequirements: [],
    capabilitySchemas: schemas,
    factory: () => testAdapter("unused-in-catalog-test"),
  };
}

test("rejects non-canonical adapter types and schema namespaces", () => {
  const catalog = new BridgeCatalog();

  assert.throws(
    () => catalog.register(registration("Home Assistant", [])),
    (error: unknown) => error instanceof BridgeCatalogError && error.code === "invalid_registration",
  );
  assert.throws(
    () => catalog.register(registration("home_assistant", [])),
    (error: unknown) => error instanceof BridgeCatalogError && error.code === "invalid_registration",
  );
  assert.throws(
    () => catalog.register(registration("home-assistant", [schema("ha", "hash-1")])),
    (error: unknown) => error instanceof BridgeCatalogError && error.code === "invalid_registration",
  );
  assert.throws(
    () => catalog.register(registration("home-assistant", [schema("HA.light", "hash-1")])),
    (error: unknown) => error instanceof BridgeCatalogError && error.code === "invalid_registration",
  );
  assert.throws(
    () => new BridgeCatalog({ namespaceOwners: { "HA.*": "home-assistant" } }),
    (error: unknown) => error instanceof BridgeCatalogError && error.code === "invalid_registration",
  );
  assert.throws(
    () => new BridgeCatalog({ coreAdapterType: "hub core" }),
    (error: unknown) => error instanceof BridgeCatalogError && error.code === "invalid_registration",
  );
});

function schema(schema: string, canonicalHash: string) {
  return {
    schema,
    majorVersion: 1,
    attrsSchema: z.record(z.string(), z.string()),
    canonicalHash,
  };
}

function testAdapter(bridgeId: string): BridgeAdapter {
  return {
    info: {
      bridgeId,
      coreVersion: "0",
      ecosystem: "test",
      heartbeatIntervalMs: 1_000,
      extensions: [],
    },
    events: async function* () {},
    control: {
      requestResync: async () => ({ status: "completed" as const }),
      dispose: async () => {},
    },
    extension: () => undefined,
  };
}

test("accepts an identical schema registration but rejects a hash collision atomically", () => {
  const catalog = new BridgeCatalog();
  const first = registration("home-assistant", [schema("ha.light", "hash-1")]);
  catalog.register(first);
  catalog.register(registration("home-assistant", [schema("ha.light", "hash-1")]));

  assert.throws(
    () => catalog.register(registration("home-assistant", [
      schema("other.light", "hash-other"),
      schema("ha.light", "hash-2"),
    ])),
    (error: unknown) => error instanceof BridgeCatalogError
      && error.code === "schema_collision",
  );
  assert.equal(catalog.schema("other.light", 1), undefined);
});

test("enforces namespace ownership and reserves hob schemas for the core", () => {
  const catalog = new BridgeCatalog({ coreAdapterType: "hub-core" });
  catalog.register(registration("home-assistant", [schema("ha.light", "hash-1")]));

  assert.throws(
    () => catalog.register(registration("other", [schema("ha.sensor", "hash-2")])),
    (error: unknown) => error instanceof BridgeCatalogError
      && error.code === "namespace_owner_conflict",
  );
  assert.throws(
    () => catalog.register(registration("home-assistant", [schema("hob.state", "hash-3")])),
    (error: unknown) => error instanceof BridgeCatalogError
      && error.code === "reserved_namespace",
  );
  catalog.register(registration("hub-core", [schema("hob.state", "hash-3")]));
});

test("requires a declared canonical schema hash instead of deriving one from Zod internals", () => {
  const catalog = new BridgeCatalog();
  const missingHash = schema("ha.light", "hash-1") as { schema: string; majorVersion: number; attrsSchema: unknown; canonicalHash?: string };
  delete missingHash.canonicalHash;

  assert.throws(
    () => catalog.register(registration("home-assistant", [missingHash as never])),
    (error: unknown) => error instanceof BridgeCatalogError
      && error.code === "invalid_registration",
  );
});

test("does not expose adapter registrations as a load-order mutable map", () => {
  const catalog = new BridgeCatalog();
  const original = registration("home-assistant", [schema("ha.light", "hash-1")]);
  catalog.register(original);

  const loaded = catalog.requireAdapter<TestConfig>("home-assistant");
  assert.equal(loaded.adapterType, "home-assistant");
  assert.deepEqual(catalog.listAdapters().map((entry) => entry.adapterType), ["home-assistant"]);
});
