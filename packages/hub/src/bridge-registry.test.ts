import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";

import {
  BridgeRegistry,
  BridgeRegistryError,
  MemoryBridgeRegistryStore,
  SqliteBridgeRegistryStore,
  type BridgeConfigEntry,
} from "./bridge-registry.js";
import { BridgeCatalog, type AdapterRegistration, type BridgeAdapter } from "./bridge-catalog.js";

interface TestConfig {
  endpoint: string;
}

function makeRegistration(factory: AdapterRegistration<TestConfig>["factory"]): AdapterRegistration<TestConfig> {
  return {
    adapterType: "home-assistant",
    configSchema: z.object({ endpoint: z.string() }),
    credentialRequirements: [],
    capabilitySchemas: [],
    factory,
  };
}

function entry(overrides: Partial<BridgeConfigEntry<TestConfig>> = {}): BridgeConfigEntry<TestConfig> {
  return {
    bridgeId: "bridge-a",
    adapterType: "home-assistant",
    config: { endpoint: "http://ha.local" },
    ...overrides,
  };
}

function adapter(bridgeId: string, coreVersion = "6.3.0"): BridgeAdapter {
  return {
    info: {
      bridgeId,
      coreVersion,
      ecosystem: "home-assistant",
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

test("rejects an unsupported bridge core major immediately after factory construction", () => {
  const catalog = new BridgeCatalog();
  let eventsCalled = false;
  catalog.register(makeRegistration(() => ({
    ...adapter("bridge-a", "5.3.0"),
    events: async function* () {
      eventsCalled = true;
    },
  })));
  const registry = new BridgeRegistry({ catalog, store: new MemoryBridgeRegistryStore() });

  assert.throws(
    () => registry.load(entry()),
    (error: unknown) => error instanceof BridgeRegistryError && error.code === "unsupported_core_version",
  );
  assert.equal(eventsCalled, false);
});

test("rechecks the core major before an adapter event subscription", async () => {
  const catalog = new BridgeCatalog();
  let eventsCalled = false;
  const created = adapter("bridge-a");
  catalog.register(makeRegistration(() => ({
    ...created,
    events: async function* () {
      eventsCalled = true;
    },
  })));
  const registry = new BridgeRegistry({ catalog, store: new MemoryBridgeRegistryStore() });
  const loaded = registry.load(entry());
  (created.info as { coreVersion: string }).coreVersion = "5.3.0";

  assert.throws(
    () => loaded.events(new AbortController().signal),
    (error: unknown) => error instanceof BridgeRegistryError && error.code === "unsupported_core_version",
  );
  assert.equal(eventsCalled, false);
});

test("keeps a valid bridge loadable when one declared extension major is unsupported", () => {
  const catalog = new BridgeCatalog();
  const created = {
    ...adapter("bridge-a"),
    info: {
      ...adapter("bridge-a").info,
      extensions: [{ id: "actions", version: "99.0.0" }],
    },
  } satisfies BridgeAdapter;
  catalog.register(makeRegistration(() => created));
  const registry = new BridgeRegistry({ catalog, store: new MemoryBridgeRegistryStore() });

  const loaded = registry.load(entry());
  assert.equal(loaded.info.extensions[0]?.id, "actions");
});

test("requires catalog, config, and persisted adapterType to agree before factory invocation", () => {
  const catalog = new BridgeCatalog();
  let calls = 0;
  catalog.register(makeRegistration(() => {
    calls += 1;
    return adapter("bridge-a");
  }));
  const store = new MemoryBridgeRegistryStore([
    { bridgeId: "bridge-a", adapterType: "other", createdAt: "2026-01-01T00:00:00.000Z", generation: 1 },
  ]);
  const registry = new BridgeRegistry({ catalog, store, now: () => "2026-08-18T00:00:00.000Z" });

  assert.throws(
    () => registry.load(entry()),
    (error: unknown) => error instanceof BridgeRegistryError
      && error.code === "adapter_type_mismatch",
  );
  assert.equal(calls, 0);
});

test("persists the bridgeId type binding and binds remote identity only at sync-start", () => {
  const catalog = new BridgeCatalog();
  catalog.register(makeRegistration(() => adapter("bridge-a")));
  const store = new MemoryBridgeRegistryStore();
  const registry = new BridgeRegistry({ catalog, store, now: () => "2026-08-18T00:00:00.000Z" });

  registry.load(entry());
  assert.deepEqual(store.get("bridge-a"), {
    bridgeId: "bridge-a",
    adapterType: "home-assistant",
    createdAt: "2026-08-18T00:00:00.000Z",
    generation: 1,
  });

  assert.equal(registry.validateOrBindRemoteInstanceId("bridge-a", "remote-a").remoteInstanceId, "remote-a");
  assert.throws(
    () => registry.validateOrBindRemoteInstanceId("bridge-a", "remote-b"),
    (error: unknown) => error instanceof BridgeRegistryError
      && error.code === "remote_instance_rebind_required",
  );
  assert.equal(store.get("bridge-a")?.remoteInstanceId, "remote-a");
});

test("explicit remote rebind advances generation while preserving the hub-assigned bridgeId", () => {
  const catalog = new BridgeCatalog();
  catalog.register(makeRegistration(() => adapter("bridge-a")));
  const store = new MemoryBridgeRegistryStore();
  const registry = new BridgeRegistry({ catalog, store, now: () => "2026-08-18T00:00:00.000Z" });

  registry.load(entry());
  registry.validateOrBindRemoteInstanceId("bridge-a", "remote-a");
  const rebound = registry.rebindRemoteInstance("bridge-a", "remote-b");

  assert.equal(rebound.bridgeId, "bridge-a");
  assert.equal(rebound.remoteInstanceId, "remote-b");
  assert.equal(store.get("bridge-a")?.generation, 2);
  assert.equal(store.get("bridge-a")?.remoteInstanceId, "remote-b");
});

test("exposes a boolean ingest seam that binds sync-start before epoch creation", () => {
  const catalog = new BridgeCatalog();
  catalog.register(makeRegistration(() => adapter("bridge-a")));
  const registry = new BridgeRegistry({ catalog, store: new MemoryBridgeRegistryStore() });
  registry.load(entry());
  const validate = registry.createRemoteIdentityValidator("bridge-a");

  assert.equal(validate("remote-a", "epoch-a"), true);
  assert.equal(validate("remote-b", "epoch-b"), false);
  assert.equal(registry.binding("bridge-a")?.remoteInstanceId, "remote-a");
});

test("rejects a factory that returns an adapter with the wrong bridgeId", () => {
  const catalog = new BridgeCatalog();
  catalog.register(makeRegistration(() => adapter("not-bridge-a")));
  const registry = new BridgeRegistry({
    catalog,
    store: new MemoryBridgeRegistryStore(),
    now: () => "2026-08-18T00:00:00.000Z",
  });

  assert.throws(
    () => registry.load(entry()),
    (error: unknown) => error instanceof BridgeRegistryError
      && error.code === "bridge_id_echo_mismatch",
  );
});

test("rejects an async factory to preserve pure synchronous construction", () => {
  const catalog = new BridgeCatalog();
  catalog.register(makeRegistration((() => Promise.resolve(adapter("bridge-a"))) as never));
  const registry = new BridgeRegistry({
    catalog,
    store: new MemoryBridgeRegistryStore(),
  });

  assert.throws(
    () => registry.load(entry()),
    (error: unknown) => error instanceof BridgeRegistryError
      && error.code === "factory_must_be_synchronous",
  );
});

test("persists bridge bindings and remote identity across SQLite store reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-registry-"));
  const path = join(directory, "registry.sqlite");
  const first = new SqliteBridgeRegistryStore(path);
  const record = {
    bridgeId: "bridge-a",
    adapterType: "home-assistant",
    createdAt: "2026-08-18T00:00:00.000Z",
    generation: 3,
    remoteInstanceId: "remote-a",
  } as const;
  first.save(record);
  first.close();

  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const reopened = new SqliteBridgeRegistryStore(path);
  assert.deepEqual(reopened.get("bridge-a"), record);
  assert.deepEqual(reopened.list(), [record]);
  reopened.close();
  await rm(directory, { recursive: true, force: true });
});

test("keeps persisted adapter type and remote mismatch fail-closed while rebind advances generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-registry-bind-"));
  const path = join(directory, "registry.sqlite");
  const store = new SqliteBridgeRegistryStore(path);
  const catalog = new BridgeCatalog();
  catalog.register(makeRegistration(() => adapter("bridge-a")));
  catalog.register({
    adapterType: "other",
    configSchema: z.object({ endpoint: z.string() }),
    credentialRequirements: [],
    capabilitySchemas: [],
    factory: () => adapter("bridge-a"),
  });
  const registry = new BridgeRegistry({ catalog, store, now: () => "2026-08-18T00:00:00.000Z" });

  registry.load(entry());
  registry.validateOrBindRemoteInstanceId("bridge-a", "remote-a");
  store.close();

  const reopened = new SqliteBridgeRegistryStore(path);
  const restoredRegistry = new BridgeRegistry({ catalog, store: reopened });
  assert.throws(
    () => restoredRegistry.load(entry({ adapterType: "other" })),
    (error: unknown) => error instanceof BridgeRegistryError && error.code === "adapter_type_mismatch",
  );
  assert.throws(
    () => restoredRegistry.validateOrBindRemoteInstanceId("bridge-a", "remote-b"),
    (error: unknown) => error instanceof BridgeRegistryError && error.code === "remote_instance_rebind_required",
  );
  const rebound = restoredRegistry.rebindRemoteInstance("bridge-a", "remote-b");
  assert.equal(rebound.generation, 2);
  assert.equal(reopened.get("bridge-a")?.remoteInstanceId, "remote-b");
  reopened.close();
  await rm(directory, { recursive: true, force: true });
});
