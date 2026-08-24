import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
import {
  AUTOMATION_TRACE_EXTENSION,
  AUTOMATION_TRACE_EXTENSION_KEY,
  CAUSALITY_EXTENSION,
  type AutomationTraceHandle,
  type BridgeAdapter,
  type BridgeEvent,
  type Envelope,
  type ExtensionHandleRegistry,
} from "@hob/bridge-contract";
import { SyntheticBridge } from "@hob/bridge-contract/testing";

import { BridgeCatalog, type AdapterRegistration } from "../bridge/bridge-catalog.js";
import { BridgeRegistry, type BridgeConfigEntry } from "../bridge/bridge-registry.js";
import { SqliteIngestJournal } from "./ingest-journal.js";
import { HomeWorldService, type HomeWorldServiceOptions } from "./home-world-service.js";
import { WorldIdentityManager } from "./world-identity.js";

const capabilitySchema = {
  schema: "synthetic.light",
  majorVersion: 1,
  attrsSchema: z.record(z.string(), z.unknown()),
  canonicalHash: "synthetic-light-v1",
} as never;

function eventEnvelope(epochId: string, seq: number, event: BridgeEvent): Envelope {
  return { epochId, seq, event };
}

function stream(cause: "foreign_rule" | "user" | false): Envelope[] {
  const events: Envelope[] = [
    eventEnvelope("trace-epoch", 1, {
      kind: "sync-start",
      snapshotId: "trace-snapshot",
      remoteInstanceId: "remote-trace",
      reason: "initial",
    }),
    eventEnvelope("trace-epoch", 2, {
      kind: "device-upserted",
      device: {
        nativeId: "native-light",
        name: "Living light",
        capabilities: [{
          nativeInstanceId: "native-light:main",
          schema: "synthetic.light",
          schemaVersion: "1.0.0",
          semanticKind: "light",
        }],
      },
    }),
    eventEnvelope("trace-epoch", 3, {
      kind: "state",
      state: {
        nativeId: "native-light",
        nativeInstanceId: "native-light:main",
        attrs: { state: "off" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }),
    eventEnvelope("trace-epoch", 4, {
      kind: "sync-complete",
      manifest: { snapshotId: "trace-snapshot", deviceEnvelopeCount: 1, stateEnvelopeCount: 1 },
    }),
    eventEnvelope("trace-epoch", 5, {
      kind: "state",
      state: {
        nativeId: "native-light",
        nativeInstanceId: "native-light:main",
        attrs: { state: "on" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    }),
  ];
  if (cause !== false) events.push(eventEnvelope("trace-epoch", 6, {
    kind: "ext",
    ext: "causality@1",
    payload: {
      refSeq: 5,
      cause: cause === "foreign_rule"
        ? { kind: "foreign_rule", ruleRef: "ha-rule:arrival" }
        : { kind: "user", principalRef: "principal:member" },
    },
  }));
  return events;
}

class TraceBridge implements BridgeAdapter {
  readonly info;
  readonly control;

  constructor(
    private readonly streamBridge: SyntheticBridge,
    private readonly handle: AutomationTraceHandle | undefined,
  ) {
    this.info = streamBridge.info;
    this.control = streamBridge.control;
  }

  events(signal: AbortSignal): AsyncIterable<Envelope> {
    return this.streamBridge.events(signal);
  }

  extension<K extends keyof ExtensionHandleRegistry>(name: K): ExtensionHandleRegistry[K] | undefined {
    return name === AUTOMATION_TRACE_EXTENSION_KEY && this.handle !== undefined
      ? this.handle as ExtensionHandleRegistry[K]
      : undefined;
  }
}

function registration(factory: AdapterRegistration<Record<string, never>>["factory"]): AdapterRegistration<Record<string, never>> {
  return {
    adapterType: "synthetic",
    configSchema: z.object({}).strict(),
    credentialRequirements: [],
    capabilitySchemas: [capabilitySchema],
    factory,
  };
}

function identityManager(): WorldIdentityManager {
  return new WorldIdentityManager({
    idFactory: (kind) => ({
      hw: "hw-device",
      hwCapability: "hwc-light",
      hwSpace: "hws-living",
      proposal: "proposal-test",
      audit: "audit-test",
    })[kind],
  });
}

function options(
  catalog: BridgeCatalog,
  registry: BridgeRegistry,
  automationTraceTimeoutMs?: number,
): HomeWorldServiceOptions {
  const bridge: BridgeConfigEntry<Record<string, never>> = {
    bridgeId: "bridge-trace",
    adapterType: "synthetic",
    config: {},
  };
  return {
    catalog,
    registry,
    bridges: [bridge],
    journalFactory: () => new SqliteIngestJournal(":memory:"),
    maxRestarts: 0,
    scheduler: { wait: async () => undefined },
    identityManager: identityManager(),
    clock: () => "2026-08-25T00:00:00.000Z",
    ...(automationTraceTimeoutMs === undefined ? {} : { automationTraceTimeoutMs }),
  };
}

async function createService(input: {
  readonly cause: "foreign_rule" | "user" | false;
  readonly handle?: AutomationTraceHandle;
  readonly automationTraceTimeoutMs?: number;
}): Promise<{
  readonly service: HomeWorldService;
  readonly fiber: { dispose(): Promise<void> };
}> {
  const streamBridge = new SyntheticBridge({
    bridgeId: "bridge-trace",
    remoteInstanceId: "remote-trace",
    extensions: [CAUSALITY_EXTENSION, AUTOMATION_TRACE_EXTENSION],
  });
  for (const event of stream(input.cause)) streamBridge.enqueue(event);
  const adapter = new TraceBridge(streamBridge, input.handle);
  const catalog = new BridgeCatalog();
  catalog.register(registration(() => adapter));
  const registry = new BridgeRegistry({ catalog });
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeWorldService, options(catalog, registry, input.automationTraceTimeoutMs));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (ctx.homeWorld.snapshot().bridges["bridge-trace"]?.diagnostics.connectionState === "ready") {
      return { service: ctx.homeWorld, fiber };
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for automation trace bridge");
}

const query = {
  hwCapabilityId: "hwc-light",
  provenance: { bridgeId: "bridge-trace", epochId: "trace-epoch", seq: 5 },
} as const;

test("reads one exact foreign-rule run and removes adapter references", async () => {
  const requests: unknown[] = [];
  const { service, fiber } = await createService({
    cause: "foreign_rule",
    handle: {
      async readTrace(request) {
        requests.push(request);
        return {
          status: "complete",
          ruleRef: request.ruleRef,
          target: request.target,
          run: {
            automationLabel: "Arrival lights",
            state: "completed",
            outcome: "completed",
            startedAt: "2026-08-25T00:00:00.000Z",
            finishedAt: "2026-08-25T00:00:01.000Z",
            steps: [{ ordinal: 1, kind: "trigger", status: "executed" }],
            truncated: false,
          },
        };
      },
    },
  });

  const result = await service.queryAutomationTrace(query);
  assert.deepEqual(requests, [{
    ruleRef: "ha-rule:arrival",
    target: { epochId: "trace-epoch", seq: 5 },
  }]);
  assert.deepEqual(result, {
    status: "complete",
    coverage: "exact_run",
    hwCapabilityId: "hwc-light",
    provenance: query.provenance,
    automationLabel: "Arrival lights",
    run: {
      state: "completed",
      outcome: "completed",
      startedAt: "2026-08-25T00:00:00.000Z",
      finishedAt: "2026-08-25T00:00:01.000Z",
    },
    steps: [{ ordinal: 1, kind: "trigger", status: "executed" }],
    reasons: [],
    truncated: false,
  });
  assert.equal("ruleRef" in result, false);
  assert.equal(JSON.stringify(result).includes("ha-rule:arrival"), false);
  await fiber.dispose();
});

test("does not query trace for a non-automation cause", async () => {
  let called = false;
  const { service, fiber } = await createService({
    cause: "user",
    handle: {
      async readTrace(request) {
        called = true;
        return { status: "unknown", ruleRef: request.ruleRef, target: request.target, reasons: ["association_missing"] };
      },
    },
  });

  assert.deepEqual(await service.queryAutomationTrace(query), {
    status: "unknown",
    coverage: "not_available",
    hwCapabilityId: "hwc-light",
    provenance: query.provenance,
    reasons: ["not_foreign_rule"],
    truncated: false,
  });
  assert.equal(called, false);
  await fiber.dispose();
});

test("maps retained-run loss without treating it as proof that no run happened", async () => {
  const { service, fiber } = await createService({
    cause: "foreign_rule",
    handle: {
      async readTrace(request) {
        return {
          status: "unknown",
          ruleRef: request.ruleRef,
          target: request.target,
          reasons: ["trace_not_retained"],
        };
      },
    },
  });

  assert.deepEqual(await service.queryAutomationTrace(query), {
    status: "unknown",
    coverage: "not_retained",
    hwCapabilityId: "hwc-light",
    provenance: query.provenance,
    reasons: ["trace_not_retained"],
    truncated: false,
  });
  await fiber.dispose();
});

test("fails closed on an invalid adapter result", async () => {
  const { service, fiber } = await createService({
    cause: "foreign_rule",
    handle: {
      async readTrace(request) {
        return {
          status: "complete",
          ruleRef: request.ruleRef,
          target: request.target,
          run: {
            state: "completed",
            outcome: "completed",
            steps: [],
            truncated: false,
            runId: "raw-run-id",
          },
        } as never;
      },
    },
  });

  assert.deepEqual(await service.queryAutomationTrace(query), {
    status: "unavailable",
    coverage: "not_available",
    hwCapabilityId: "hwc-light",
    provenance: query.provenance,
    reasons: ["invalid_response"],
    truncated: false,
  });
  await fiber.dispose();
});

test("returns on the Hub deadline when an adapter ignores cancellation", async () => {
  const { service, fiber } = await createService({
    cause: "foreign_rule",
    automationTraceTimeoutMs: 5,
    handle: {
      async readTrace() {
        return new Promise<never>(() => undefined);
      },
    },
  });

  assert.deepEqual(await service.queryAutomationTrace(query), {
    status: "unavailable",
    coverage: "rule_only",
    hwCapabilityId: "hwc-light",
    provenance: query.provenance,
    reasons: ["timeout"],
    truncated: false,
  });
  await fiber.dispose();
});

test("does not report a complete run when the bridge disconnects during the read", async () => {
  let serviceRef: HomeWorldService | undefined;
  const created = await createService({
    cause: "foreign_rule",
    handle: {
      async readTrace(request) {
        const runtimes = (serviceRef as unknown as {
          runtimesById: Map<string, { ingest: { markDown(): void } }>;
        }).runtimesById;
        runtimes.get("bridge-trace")?.ingest.markDown();
        return {
          status: "complete",
          ruleRef: request.ruleRef,
          target: request.target,
          run: {
            state: "completed",
            outcome: "completed",
            steps: [],
            truncated: false,
          },
        };
      },
    },
  });
  serviceRef = created.service;

  assert.deepEqual(await created.service.queryAutomationTrace(query), {
    status: "unavailable",
    coverage: "rule_only",
    hwCapabilityId: "hwc-light",
    provenance: query.provenance,
    reasons: ["bridge_not_ready"],
    truncated: false,
  });
  await created.fiber.dispose();
});
