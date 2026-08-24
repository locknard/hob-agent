import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
import {
  type BridgeAdapter,
  type BridgeEvent,
  type Envelope,
  type ForeignRuleMigrationResult,
} from "@hob/bridge-contract";
import { BridgeCatalog } from "../bridge/bridge-catalog.js";
import { BridgeRegistry, MemoryBridgeRegistryStore } from "../bridge/bridge-registry.js";
import { SqliteIngestJournal } from "./ingest-journal.js";
import { HomeWorldService } from "./home-world-service.js";

const BRIDGE_ID = "bridge-migration";
const EPOCH_ID = "epoch-migration";
const LAST_SEQ = 2;
const RULE_REF = "rule-1";
const BINDING = {
  bridgeId: BRIDGE_ID,
  nativeId: "light.living-room",
  nativeInstanceId: "light.living-room:main",
} as const;

type MigrationInput = {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly lastSeq: number;
  readonly ruleRef: string;
  readonly signal: AbortSignal;
};

type MigrationApi = {
  translateForeignRule(input: MigrationInput): Promise<unknown>;
};

class ControlledJournal extends SqliteIngestJournal {
  preDrift: boolean;
  postDrift: boolean;

  constructor() {
    super(":memory:");
    this.preDrift = false;
    this.postDrift = false;
  }

  override consistentWatermark(bridgeId: string) {
    if (this.preDrift || this.postDrift) return { epochId: "drifted-epoch", lastSeq: 99 };
    return super.consistentWatermark(bridgeId);
  }
}

type SetupOptions = {
  readonly migrationAvailable?: boolean;
  readonly catalog?: unknown;
  readonly result?: unknown | ((signal: AbortSignal, journal: ControlledJournal) => Promise<unknown>);
  readonly journal?: ControlledJournal;
};

function eventEnvelope(event: BridgeEvent, seq: number = event.kind === "sync-start" ? 1 : 2): Envelope {
  return { epochId: EPOCH_ID, seq, event };
}

function translatedResult(overrides: Record<string, unknown> = {}): ForeignRuleMigrationResult {
  return {
    status: "translated",
    ruleRef: RULE_REF,
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    title: "Turn on living room light",
    plan: {
      trigger: { kind: "capability_changed", source: BINDING },
      conditions: [],
      actions: [{ kind: "set_boolean", target: BINDING, value: true }],
    },
    ...overrides,
  } as ForeignRuleMigrationResult;
}

async function setup(options: SetupOptions = {}): Promise<{
  readonly service: HomeWorldService;
  readonly fiber: { dispose(): Promise<void> };
  readonly journal: ControlledJournal;
  readonly translateCalls: MigrationInput[];
}> {
  const journal = options.journal ?? new ControlledJournal();
  const translateCalls: MigrationInput[] = [];
  const catalog = new BridgeCatalog();
  const migrationAvailable = options.migrationAvailable ?? true;
  const adapter: BridgeAdapter = {
    info: {
      bridgeId: BRIDGE_ID,
      coreVersion: "6.3.0",
      ecosystem: "test",
      heartbeatIntervalMs: 60_000,
      extensions: [
        { id: "foreignRules", version: "2.0.0" },
        { id: "foreignRuleMigration", version: "1.0.0" },
      ],
    },
    async *events(signal) {
      yield eventEnvelope({
        kind: "sync-start",
        snapshotId: "migration-snapshot",
        remoteInstanceId: "migration-remote",
        reason: "initial",
      });
      yield eventEnvelope({
        kind: "sync-complete",
        manifest: { snapshotId: "migration-snapshot", deviceEnvelopeCount: 0, stateEnvelopeCount: 0 },
      });
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    control: { requestResync: async () => ({ status: "completed" }), dispose: async () => undefined },
    extension(name) {
      if (name === "foreignRules@2") {
        return {
          catalog: async () => options.catalog ?? {
            epochId: EPOCH_ID,
            lastSeq: LAST_SEQ,
            complete: true,
            rules: [{ ruleRef: RULE_REF, name: "Living room light", enabled: true }],
          },
        } as never;
      }
      if (name === "foreignRuleMigration@1" && migrationAvailable) {
        return {
          translate: async (request: { ruleRef: string }, extensionOptions: { signal: AbortSignal }) => {
            translateCalls.push({
              bridgeId: BRIDGE_ID,
              epochId: EPOCH_ID,
              lastSeq: LAST_SEQ,
              ruleRef: request.ruleRef,
              signal: extensionOptions.signal,
            });
            const result = options.result;
            if (typeof result === "function") return result(extensionOptions.signal, journal);
            return result ?? translatedResult();
          },
        } as never;
      }
      return undefined;
    },
  };
  catalog.register({
    adapterType: "migration-test",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas: [],
    factory: () => adapter,
  });
  const registry = new BridgeRegistry({ catalog, store: new MemoryBridgeRegistryStore() });
  const context = new Context();
  const fiber = await context.plugin(HomeWorldService, {
    catalog,
    registry,
    bridges: [{ bridgeId: BRIDGE_ID, adapterType: "migration-test", config: {} }],
    journalFactory: () => journal,
    maxRestarts: 0,
    monitorIntervalMs: 0,
    scheduler: { wait: async () => undefined },
  });
  await waitFor(() => context.homeWorld.snapshot().bridges[BRIDGE_ID]?.diagnostics.connectionState === "ready");
  return { service: context.homeWorld, fiber, journal, translateCalls };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for homeWorld");
}

async function invoke(service: HomeWorldService, input: Omit<MigrationInput, "signal">, signal = new AbortController().signal): Promise<unknown> {
  const method = (service as unknown as Partial<MigrationApi>).translateForeignRule;
  assert.equal(typeof method, "function");
  return method?.call(service, { ...input, signal });
}

function request(overrides: Partial<Omit<MigrationInput, "signal">> = {}): Omit<MigrationInput, "signal"> {
  return { bridgeId: BRIDGE_ID, epochId: EPOCH_ID, lastSeq: LAST_SEQ, ruleRef: RULE_REF, ...overrides };
}

test("translates one committed catalog rule through a Hub-owned bounded read seam", async () => {
  const { service, fiber, translateCalls } = await setup();
  try {
    const result = await invoke(service, request());
    assert.deepEqual(result, translatedResult());
    assert.equal(translateCalls.length, 1);
    assert.equal(translateCalls[0]?.ruleRef, RULE_REF);
    assert.equal("signal" in (translateCalls[0] ?? {}), true);
  } finally {
    await fiber.dispose();
  }
});

test("returns stale_source for an unknown catalog ref without calling translate", async () => {
  const { service, fiber, translateCalls } = await setup();
  try {
    assert.deepEqual(await invoke(service, request({ ruleRef: "missing-rule" })), { status: "stale_source" });
    assert.equal(translateCalls.length, 0);
  } finally {
    await fiber.dispose();
  }
});

test("returns stale_source when the committed watermark drifted before translation", async () => {
  const { service, fiber, journal, translateCalls } = await setup();
  try {
    journal.preDrift = true;
    assert.deepEqual(await invoke(service, request()), { status: "stale_source" });
    assert.equal(translateCalls.length, 0);
  } finally {
    await fiber.dispose();
  }
});

test("returns stale_source when the committed watermark drifts after translation", async () => {
  const { service, fiber, journal, translateCalls } = await setup({
    result: async () => {
      journal.postDrift = true;
      return translatedResult();
    },
  });
  try {
    assert.deepEqual(await invoke(service, request()), { status: "stale_source" });
    assert.equal(translateCalls.length, 1);
  } finally {
    await fiber.dispose();
  }
});

test("returns stale_source when the catalog fence differs from the requested source", async () => {
  const { service, fiber, translateCalls } = await setup({
    catalog: {
      epochId: EPOCH_ID,
      lastSeq: LAST_SEQ + 1,
      complete: true,
      rules: [{ ruleRef: RULE_REF }],
    },
  });
  try {
    assert.deepEqual(await invoke(service, request()), { status: "stale_source" });
    assert.equal(translateCalls.length, 0);
  } finally {
    await fiber.dispose();
  }
});

test("returns unavailable for an invalid or incomplete foreign-rule catalog", async (t) => {
  for (const catalog of [
    { epochId: EPOCH_ID, lastSeq: LAST_SEQ, complete: false, rules: [{ ruleRef: RULE_REF }] },
    { epochId: EPOCH_ID, lastSeq: LAST_SEQ, complete: true, rules: [{ ruleRef: RULE_REF, provider: "raw" }] },
  ]) {
    await t.test(JSON.stringify(catalog), async () => {
      const { service, fiber, translateCalls } = await setup({ catalog });
      try {
        assert.deepEqual(await invoke(service, request()), { status: "unavailable" });
        assert.equal(translateCalls.length, 0);
      } finally {
        await fiber.dispose();
      }
    });
  }
});

test("returns unsupported without exposing provider-specific disposition details", async () => {
  const { service, fiber, translateCalls } = await setup({ result: { status: "unsupported", reason: "unsupported_action" } });
  try {
    assert.deepEqual(await invoke(service, request()), { status: "unsupported", reason: "unsupported_action" });
    assert.equal(translateCalls.length, 1);
  } finally {
    await fiber.dispose();
  }
});

test("fails closed when migration extension negotiation is unavailable", async () => {
  const { service, fiber, translateCalls } = await setup({ migrationAvailable: false });
  try {
    assert.deepEqual(await invoke(service, request()), { status: "unavailable" });
    assert.equal(translateCalls.length, 0);
  } finally {
    await fiber.dispose();
  }
});

test("redacts invalid, mismatched, and cross-bridge provider results", async (t) => {
  const cases: readonly [string, unknown][] = [
    ["invalid result", { status: "translated", ruleRef: RULE_REF, raw: "provider secret" }],
    ["mismatched ruleRef", translatedResult({ ruleRef: "other-rule" })],
    ["cross-bridge binding", translatedResult({ plan: {
      trigger: { kind: "capability_changed", source: { ...BINDING, bridgeId: "other-bridge" } },
      conditions: [],
      actions: [{ kind: "set_boolean", target: BINDING, value: true }],
    } })],
  ];
  for (const [name, providerResult] of cases) {
    await t.test(name, async () => {
      const { service, fiber } = await setup({ result: providerResult });
      try {
        const result = await invoke(service, request());
        assert.deepEqual(result, { status: "unavailable" });
        assert.equal(JSON.stringify(result).includes("provider"), false);
        assert.equal(JSON.stringify(result).includes("raw"), false);
        assert.equal(JSON.stringify(result).includes("entity_id"), false);
        assert.equal(JSON.stringify(result).includes("service"), false);
      } finally {
        await fiber.dispose();
      }
    });
  }
});

test("redacts provider throws and closes aborts before, during, and after translation", async (t) => {
  await t.test("provider throw", async () => {
    const { service, fiber } = await setup({ result: async () => { throw new Error("native config secret"); } });
    try {
      assert.deepEqual(await invoke(service, request()), { status: "unavailable" });
    } finally {
      await fiber.dispose();
    }
  });

  await t.test("abort before call", async () => {
    const { service, fiber, translateCalls } = await setup();
    const controller = new AbortController();
    controller.abort();
    try {
      assert.deepEqual(await invoke(service, request(), controller.signal), { status: "unavailable" });
      assert.equal(translateCalls.length, 0);
    } finally {
      await fiber.dispose();
    }
  });

  await t.test("abort during call", async () => {
    const controller = new AbortController();
    let release!: () => void;
    let translationStarted = false;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const { service, fiber } = await setup({ result: async (signal) => {
      translationStarted = true;
      await pending;
      return signal.aborted ? translatedResult() : translatedResult();
    } });
    try {
      const resultPromise = invoke(service, request(), controller.signal);
      await waitFor(() => translationStarted);
      controller.abort();
      release();
      assert.deepEqual(await resultPromise, { status: "unavailable" });
    } finally {
      await fiber.dispose();
    }
  });

  await t.test("abort after provider returns", async () => {
    const controller = new AbortController();
    const { service, fiber } = await setup({ result: async () => {
      controller.abort();
      return translatedResult();
    } });
    try {
      assert.deepEqual(await invoke(service, request(), controller.signal), { status: "unavailable" });
    } finally {
      await fiber.dispose();
    }
  });
});
