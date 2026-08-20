import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import * as contract from "./index.js";
import {
  BridgeStreamError,
  type AdapterRegistration,
  type BridgeAdapter,
  type BridgeCredentialProvider,
} from "./bridge-contract.js";
import {
  runBridgeAdapterConformance,
  type BridgeAdapterConformanceInput,
  type ReplayExpectation,
} from "./bridge-adapter-conformance.js";

const bridgeId = "bridge-third-party";
const adapterType = "third-party";
const replay: ReplayExpectation = {
  epochId: "epoch-1",
  snapshotId: "snapshot-1",
  remoteInstanceId: "remote-1",
  deviceEnvelopeCount: 1,
  stateEnvelopeCount: 1,
};

interface FixtureConfig {
  readonly endpoint: string;
}

interface FixtureOptions {
  readonly replayOverride?: Partial<ReplayExpectation>;
  readonly extensionHandles?: BridgeAdapterConformanceInput<FixtureConfig>["extensionHandles"];
  readonly streamError?: BridgeAdapterConformanceInput<FixtureConfig>["streamError"];
  readonly config?: unknown;
  readonly factory?: AdapterRegistration<FixtureConfig>["factory"];
  readonly coreVersion?: string;
  readonly resyncResult?: { readonly status: "completed" | "unsupported" | "failed"; readonly reason?: "timeout" | "unsupported" };
  readonly dispose?: () => Promise<void>;
  readonly credentials?: BridgeCredentialProvider;
}

function fixture(options: FixtureOptions = {}): BridgeAdapterConformanceInput<FixtureConfig> {
  const expected = { ...replay, ...options.replayOverride };
  const configSchema = z.object({ endpoint: z.string().url() }).strict();
  const credentials: BridgeCredentialProvider = {
    resolve: async (alias) => alias === "access-token"
      ? { kind: "secret_text", value: "fixture-secret" }
      : undefined,
    describe: async (alias) => ({ configured: alias === "access-token" }),
  };
  const registration: AdapterRegistration<FixtureConfig> = {
    adapterType,
    configSchema,
    credentialRequirements: [{ alias: "access-token", kind: "secret_text" }],
    capabilitySchemas: [],
    factory: options.factory ?? (() => ({
      info: {
        bridgeId,
        coreVersion: options.coreVersion ?? "6.3.0",
        ecosystem: "third-party",
        heartbeatIntervalMs: 1_000,
        extensions: [
          { id: "telemetry", version: "1.2.0" },
          { id: "future", version: "99.0.0" },
        ],
      },
      events: async function* () {
        yield {
          epochId: expected.epochId,
          seq: 1,
          event: {
            kind: "sync-start" as const,
            snapshotId: expected.snapshotId,
            remoteInstanceId: expected.remoteInstanceId,
            reason: "initial" as const,
          },
        };
        yield {
          epochId: expected.epochId,
          seq: 2,
          event: {
            kind: "device-upserted" as const,
            device: { nativeId: "device-1", capabilities: [] },
          },
        };
        yield {
          epochId: expected.epochId,
          seq: 3,
          event: {
            kind: "state" as const,
            state: {
              nativeId: "device-1",
              nativeInstanceId: "main",
              attrs: { state: "ready" },
              time: { sourceTsQuality: "none" as const },
              origin: "observed" as const,
            },
          },
        };
        yield { epochId: expected.epochId, seq: 4, event: { kind: "heartbeat" as const } };
        yield {
          epochId: expected.epochId,
          seq: 5,
          event: {
            kind: "sync-complete" as const,
            manifest: {
              snapshotId: expected.snapshotId,
              deviceEnvelopeCount: 1,
              stateEnvelopeCount: 1,
            },
          },
        };
      },
      control: {
        requestResync: async () => options.resyncResult ?? { status: "completed" as const },
        dispose: options.dispose ?? (async () => undefined),
      },
      extension: (name: string) => name === "telemetry@1" ? { readonly: true } : undefined,
    } as unknown as BridgeAdapter)),
  };
  return {
    registration,
    adapterType,
    bridgeId,
    config: options.config ?? { endpoint: "https://fixture.test" },
    credentials: options.credentials ?? credentials,
    replay: expected,
    coreMajor: 6,
    extensionHandles: options.extensionHandles ?? [
      { key: "telemetry@1", available: true },
      { key: "future@99", available: false },
    ],
    streamError: options.streamError,
    resync: { result: { status: "completed" } },
  };
}

test("exposes a reusable neutral bridge adapter conformance harness", () => {
  const exports = contract as unknown as Record<string, unknown>;
  assert.equal(typeof exports.runBridgeAdapterConformance, "function");
});

test("passes one deterministic third-party adapter through every neutral boundary probe", async () => {
  const report = await runBridgeAdapterConformance(fixture());

  assert.equal(report.passed, true);
  assert.deepEqual(report.checks.map((check) => check.name), [
    "registration-schema",
    "registration-identity",
    "config-schema",
    "factory-sync",
    "factory-purity",
    "adapter-schema",
    "credential-scope",
    "stream-replay",
    "extension-handles",
    "resync",
    "dispose",
  ]);
  assert.equal(report.checks.every((check) => check.passed), true);
  assert.equal(JSON.stringify(report).includes("fixture-secret"), false);
});

test("normalizes the declared stream failure reason without exposing raw errors", async () => {
  const report = await runBridgeAdapterConformance(fixture({
    streamError: {
      reason: "authentication_failed",
      probe: async () => {
        throw new BridgeStreamError("authentication failed", "authentication_failed");
      },
    },
  }));

  assert.equal(report.passed, true);
  assert.equal(report.checks.find((check) => check.name === "stream-error")?.passed, true);
});

test("accepts every closed stream failure classification", async () => {
  for (const reason of [
    "upstream_unavailable",
    "authentication_failed",
    "rate_limited",
    "protocol_error",
    "internal_error",
  ] as const) {
    const report = await runBridgeAdapterConformance(fixture({
      streamError: {
        reason,
        probe: async () => { throw new BridgeStreamError(reason, reason); },
      },
    }));
    assert.equal(report.passed, true, reason);
  }
});

test("rejects a replay whose manifest does not match the observed unique envelope kinds", async () => {
  const report = await runBridgeAdapterConformance(fixture({
    replayOverride: { stateEnvelopeCount: 2 },
  }));

  assert.equal(report.passed, false);
  assert.equal(report.checks.find((check) => check.name === "stream-replay")?.passed, false);
});

test("rejects invalid registration config before constructing the adapter", async () => {
  let factoryCalls = 0;
  const input = fixture({
    config: { endpoint: "not-an-url" },
    factory: (() => {
      factoryCalls += 1;
      return {};
    }) as unknown as AdapterRegistration<FixtureConfig>["factory"],
  });
  const report = await runBridgeAdapterConformance(input);

  assert.equal(report.passed, false);
  assert.equal(report.checks.find((check) => check.name === "config-schema")?.passed, false);
  assert.equal(factoryCalls, 0);
});

test("rejects an adapter that reports an unsupported core major", async () => {
  const report = await runBridgeAdapterConformance(fixture({ coreVersion: "7.0.0" }));

  assert.equal(report.passed, false);
  assert.equal(report.checks.find((check) => check.name === "registration-identity")?.passed, false);
});

test("flags credential reads performed during synchronous factory construction", async () => {
  const validFactory = fixture().registration.factory;
  const report = await runBridgeAdapterConformance(fixture({
    factory: (context) => {
      void context.credentials.describe("access-token");
      return validFactory(context);
    },
  }));

  assert.equal(report.passed, false);
  assert.equal(report.checks.find((check) => check.name === "factory-purity")?.passed, false);
});

test("rejects a declared extension whose expected handle availability is wrong", async () => {
  const report = await runBridgeAdapterConformance(fixture({
    extensionHandles: [
      { key: "telemetry@1", available: false },
      { key: "future@99", available: false },
    ],
  }));

  assert.equal(report.passed, false);
  assert.equal(report.checks.find((check) => check.name === "extension-handles")?.passed, false);
});

test("disposes the replay adapter and reports any lifecycle disposal failure", async () => {
  let disposeCalls = 0;
  const report = await runBridgeAdapterConformance(fixture({
    dispose: async () => {
      disposeCalls += 1;
      throw new Error("fixture dispose failed");
    },
  }));

  assert.equal(report.passed, false);
  assert.equal(disposeCalls, 2);
  assert.equal(report.checks.find((check) => check.name === "dispose")?.passed, false);
});

test("rejects credentials read by the adapter outside its declared aliases", async () => {
  const validFactory = fixture().registration.factory;
  let observedMaterial: unknown = "not-observed";
  let observedDescription: unknown = "not-observed";
  const report = await runBridgeAdapterConformance(fixture({
    factory: (context) => {
      const adapter = validFactory(context);
      return {
        ...adapter,
        events: async function* (signal: AbortSignal) {
          observedDescription = await context.credentials.describe("not-declared");
          observedMaterial = await context.credentials.resolve("not-declared");
          yield* adapter.events(signal);
        },
      };
    },
    credentials: {
      resolve: async (alias) => alias === "not-declared"
        ? { kind: "secret_text", value: "must-not-reach-adapter" }
        : undefined,
      describe: async (alias) => ({ configured: alias === "access-token" }),
    },
  }));

  assert.equal(report.passed, false);
  assert.equal(report.checks.find((check) => check.name === "credential-scope")?.passed, false);
  assert.deepEqual(observedDescription, { configured: false });
  assert.equal(observedMaterial, undefined);
});

test("rejects a credential material kind read by the adapter outside its registration kind", async () => {
  const validFactory = fixture().registration.factory;
  let observedMaterial: unknown = "not-observed";
  const report = await runBridgeAdapterConformance({
    ...fixture({
      factory: (context) => {
        const adapter = validFactory(context);
        return {
          ...adapter,
          events: async function* (signal: AbortSignal) {
            observedMaterial = await context.credentials.resolve("access-token");
            yield* adapter.events(signal);
          },
        };
      },
    }),
    credentials: {
      resolve: async (alias) => alias === "access-token"
        ? { kind: "oauth", accessToken: "wrong-kind" }
        : undefined,
      describe: async (alias) => ({ configured: alias === "access-token" }),
    },
  });

  assert.equal(report.passed, false);
  assert.equal(report.checks.find((check) => check.name === "credential-scope")?.passed, false);
  assert.equal(observedMaterial, undefined);
});
