import assert from "node:assert/strict";
import test from "node:test";

import type { AuthorityCandidateResolveInput } from "./authority-candidate-registry.js";
import {
  HomeWorldAuthorityBindingSource,
  HomeWorldAuthorityBindingSourceError,
  type HomeWorldAuthorityBindingSourcePort,
} from "./home-world-authority-binding-source.js";
import type {
  HomeWorldBridgeSnapshot,
  HomeWorldCapabilitySnapshot,
  HomeWorldDeviceSnapshot,
  HomeWorldDiagnostics,
  HomeWorldSnapshot,
  HomeWorldWatermark,
} from "./home-world-service.js";

const capturedAt = "2026-08-20T01:00:00.000Z";
const artifact = {
  artifactId: "artifact-authority-source",
  revision: 1,
  contentHash: `sha256:${"a".repeat(64)}`,
};

const bindingIdentity = `sha256:${"1".repeat(64)}`;
const configurationIdentity = `sha256:${"2".repeat(64)}`;

function configuredInput(hwCapabilityId = "hwc-cover", overrides: Partial<AuthorityCandidateResolveInput> = {}): AuthorityCandidateResolveInput {
  return {
    hwCapabilityId,
    knownCapability: true,
    configured: true,
    approved: true,
    available: true,
    bindingIdentity,
    configurationIdentity,
    registrationGeneration: 7,
    ...overrides,
  };
}

function placeholderInput(hwCapabilityId = "hwc-cover"): AuthorityCandidateResolveInput {
  return {
    hwCapabilityId,
    knownCapability: true,
    configured: false,
    approved: false,
    available: false,
  };
}

function capability(
  hwCapabilityId: string,
  bindings: readonly { bridgeId: string; nativeId: string; nativeInstanceId: string }[],
): HomeWorldCapabilitySnapshot {
  return {
    hwCapabilityId,
    hwId: "hw-device",
    schema: "hob.cover",
    schemaVersion: "1.0.0",
    semanticKind: "cover",
    bindings: bindings.map((binding) => ({ ...binding })),
  };
}

function device(bridgeId: string, item: HomeWorldCapabilitySnapshot): HomeWorldDeviceSnapshot {
  const firstBinding = item.bindings[0];
  assert.ok(firstBinding);
  return {
    bridgeId,
    hwId: item.hwId,
    nativeId: firstBinding.nativeId,
    bindings: item.bindings.map((binding) => ({ ...binding })),
    capabilities: [item],
    descriptor: {
      nativeId: firstBinding.nativeId,
      capabilities: item.bindings.map((binding) => ({
        nativeInstanceId: binding.nativeInstanceId,
        schema: item.schema,
        schemaVersion: item.schemaVersion,
        semanticKind: item.semanticKind,
      })),
    },
    states: [],
    validity: "valid",
  };
}

function diagnostics(
  connectionState: HomeWorldDiagnostics["connectionState"] = "ready",
  historyGapCount = 0,
): HomeWorldBridgeSnapshot["diagnostics"] {
  return {
    connectionState,
    droppedInvalidCount: 0,
    strippedFieldsCount: 0,
    staleEpochDropCount: 0,
    foldedStateCount: 0,
    unsupportedSchemaCount: 0,
    protocolViolationCount: 0,
    historyGapCount,
    recentHistoryGaps: historyGapCount === 0
      ? []
      : [{ from: "epoch:1", to: "epoch:2", reason: "fixture-gap" }],
  };
}

function watermark(bridgeId: string, lastSeq = 42): HomeWorldWatermark {
  return {
    bridgeId,
    epochId: `${bridgeId}-epoch`,
    lastSeq,
    lastSyncCompleteAt: capturedAt,
  };
}

function bridge(
  bridgeId: string,
  options: {
    readonly item?: HomeWorldCapabilitySnapshot;
    readonly connectionState?: HomeWorldDiagnostics["connectionState"];
    readonly historyGapCount?: number;
    readonly noWatermark?: boolean;
    readonly watermarkOwnerId?: string;
    readonly lastSeq?: number;
  } = {},
): HomeWorldBridgeSnapshot {
  const state = options.connectionState ?? "ready";
  const diagnosticsValue = diagnostics(state, options.historyGapCount ?? 0);
  const currentWatermark = options.noWatermark === true
    ? null
    : watermark(options.watermarkOwnerId ?? bridgeId, options.lastSeq);
  return {
    bridgeId,
    adapterType: "fixture-adapter",
    diagnostics: diagnosticsValue,
    watermark: currentWatermark,
    devices: options.item === undefined ? [] : [device(bridgeId, options.item)],
    extensions: {},
    metrics: {
      consistency: state === "ready" ? "ready" : state === "degraded" ? "degraded" : "not_ready",
      eventActivity: "active",
      connection: state === "ready" ? "up" : state === "down" || state === "quarantined" ? "down" : "degraded",
    },
  };
}

function snapshot(bridges: readonly HomeWorldBridgeSnapshot[], generatedAt = capturedAt): HomeWorldSnapshot {
  const bridgeMap = Object.fromEntries(bridges.map((item) => [item.bridgeId, item]));
  const bridgeWatermarks = bridges
    .flatMap((item) => item.watermark === null ? [] : [item.watermark])
    .sort((left, right) => left.bridgeId.localeCompare(right.bridgeId));
  return {
    generatedAt,
    bridges: bridgeMap,
    watermarkVector: Object.fromEntries(bridges.map((item) => [item.bridgeId, item.watermark])),
    bridgeWatermarks,
    watermarks: bridgeWatermarks,
    diagnostics: bridges.map((item) => ({
      bridgeId: item.bridgeId,
      connectionState: item.diagnostics.connectionState,
      ...(item.diagnostics.lastSyncCompleteAt === undefined ? {} : { lastSyncCompleteAt: item.diagnostics.lastSyncCompleteAt }),
    })),
    metrics: {
      consistency: bridges.map((item) => ({
        bridgeId: item.bridgeId,
        state: item.diagnostics.connectionState,
        ...(item.diagnostics.lastSyncCompleteAt === undefined ? {} : { lastSyncCompleteAt: item.diagnostics.lastSyncCompleteAt }),
      })),
      eventActivity: bridges.map((item) => ({ bridgeId: item.bridgeId })),
      connectionActivity: bridges.map((item) => ({ bridgeId: item.bridgeId, state: item.diagnostics.connectionState })),
    },
    spaces: [],
    devices: bridges.flatMap((item) => item.devices),
  };
}

class FakeHomeWorld implements HomeWorldAuthorityBindingSourcePort {
  private snapshotIndex = 0;
  private inputIndex = new Map<string, number>();
  readonly snapshotCalls = { count: 0 };
  readonly selectorCalls: string[] = [];

  constructor(
    private readonly snapshots: readonly HomeWorldSnapshot[],
    private readonly inputs: ReadonlyMap<string, readonly (AuthorityCandidateResolveInput | undefined)[]>,
    private readonly selectors: ReadonlyMap<string, readonly ({ status: "available"; bridgeId: string } | { status: "unavailable" })[]>,
    private readonly configuredBridges: ReadonlyMap<string, readonly string[]> = new Map(),
  ) {}

  snapshot(): HomeWorldSnapshot {
    this.snapshotCalls.count += 1;
    return this.snapshots[Math.min(this.snapshotIndex++, this.snapshots.length - 1)]!;
  }

  resolveAuthorityCandidateInput(hwCapabilityId: string): AuthorityCandidateResolveInput | undefined {
    const values = this.inputs.get(hwCapabilityId) ?? [undefined];
    const index = this.inputIndex.get(hwCapabilityId) ?? 0;
    this.inputIndex.set(hwCapabilityId, index + 1);
    return values[Math.min(index, values.length - 1)];
  }

  resolveActionAuthority(hwCapabilityId: string): { status: "available"; bridgeId: string } | { status: "unavailable" } {
    this.selectorCalls.push(hwCapabilityId);
    const values = this.selectors.get(hwCapabilityId) ?? [{ status: "unavailable" as const }];
    return values[0]!;
  }

  isActionAuthorityConfiguredForBridge(hwCapabilityId: string, bridgeId: string): boolean {
    return this.configuredBridges.get(hwCapabilityId)?.includes(bridgeId) ?? false;
  }
}

function source(homeWorld: FakeHomeWorld): HomeWorldAuthorityBindingSource {
  return new HomeWorldAuthorityBindingSource({ homeWorld });
}

function assertSourceError(run: () => unknown, code: HomeWorldAuthorityBindingSourceError["code"]): void {
  assert.throws(run, (error: unknown) => error instanceof HomeWorldAuthorityBindingSourceError && error.code === code);
}

test("builds a fresh configured cut for only the selected binding and watermark", () => {
  const item = capability("hwc-cover", [
    { bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "native-a:main" },
    { bridgeId: "bridge-b", nativeId: "native-b", nativeInstanceId: "native-b:main" },
  ]);
  const first = snapshot([bridge("bridge-a", { item }), bridge("bridge-b", { item })]);
  const world = new FakeHomeWorld(
    [first, first],
    new Map([["hwc-cover", [configuredInput()]]]),
    new Map([["hwc-cover", [{ status: "available", bridgeId: "bridge-b" }]]]),
    new Map([["hwc-cover", ["bridge-b"]]]),
  );

  const cut = source(world).readFreshWorldCut({ artifact, hwCapabilityIds: ["hwc-cover"] });

  assert.equal(cut.capturedAt, capturedAt);
  assert.deepEqual(cut.watermarks.map((item) => item.bridgeId), ["bridge-b"]);
  assert.deepEqual(cut.bindings, [{
    hwCapabilityId: "hwc-cover",
    resolveInput: configuredInput(),
    watermarkBridgeIds: ["bridge-b"],
  }]);
  assert.equal(world.snapshotCalls.count, 2);
  assert.equal(JSON.stringify(cut).includes("native-a"), false);
  assert.equal(JSON.stringify(cut).includes("native-b"), false);
  assert.equal(JSON.stringify(cut).includes("fixture-adapter"), false);
  assert.equal(JSON.stringify(cut).includes("remoteInstanceId"), false);
  assert.equal(JSON.stringify(cut).includes("credential"), false);
});

test("keeps a configured but unapproved candidate bound to its exact configured bridge", () => {
  const item = capability("hwc-cover", [
    { bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "native-a:main" },
    { bridgeId: "bridge-b", nativeId: "native-b", nativeInstanceId: "native-b:main" },
  ]);
  const first = snapshot([bridge("bridge-a", { item }), bridge("bridge-b", { item })]);
  const world = new FakeHomeWorld(
    [first, first],
    new Map([["hwc-cover", [configuredInput("hwc-cover", { approved: false, available: false })]]]),
    new Map([["hwc-cover", [{ status: "unavailable" }]]]),
    new Map([["hwc-cover", ["bridge-b"]]]),
  );

  const cut = source(world).readFreshWorldCut({ artifact, hwCapabilityIds: ["hwc-cover"] });

  assert.deepEqual(cut.watermarks.map((item) => item.bridgeId), ["bridge-b"]);
  assert.deepEqual(cut.bindings, [{
    hwCapabilityId: "hwc-cover",
    resolveInput: configuredInput("hwc-cover", { approved: false, available: false }),
    watermarkBridgeIds: ["bridge-b"],
  }]);
  assert.deepEqual(world.selectorCalls, []);
  assert.equal(JSON.stringify(cut).includes("native-b"), false);
});

test("binds an unconfigured placeholder to every existing capability binding and ignores unrelated bad bridges", () => {
  const item = capability("hwc-cover", [
    { bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "native-a:main" },
    { bridgeId: "bridge-b", nativeId: "native-b", nativeInstanceId: "native-b:main" },
  ]);
  const first = snapshot([
    bridge("bridge-a", { item }),
    bridge("bridge-b", { item }),
    bridge("bridge-unrelated", { connectionState: "degraded", noWatermark: true }),
  ]);
  const world = new FakeHomeWorld(
    [first, first],
    new Map([["hwc-cover", [placeholderInput()]]]),
    new Map(),
  );

  const cut = source(world).readFreshWorldCut({ artifact, hwCapabilityIds: ["hwc-cover"] });

  assert.deepEqual(cut.watermarks.map((item) => item.bridgeId), ["bridge-a", "bridge-b"]);
  assert.deepEqual(cut.bindings[0]?.watermarkBridgeIds, ["bridge-a", "bridge-b"]);
  assert.deepEqual(world.selectorCalls, []);
});

test("notify-only scope returns no watermarks or binding inputs despite unrelated bridge state", () => {
  const bad = snapshot([bridge("bridge-bad", { connectionState: "degraded", historyGapCount: 2, noWatermark: true })]);
  const world = new FakeHomeWorld([bad], new Map(), new Map());

  const cut = source(world).readFreshWorldCut({ artifact, hwCapabilityIds: [] });

  assert.deepEqual(cut, { capturedAt, watermarks: [], bindings: [] });
  assert.equal(world.snapshotCalls.count, 1);
  assert.deepEqual(world.selectorCalls, []);
});

test("fails closed for unknown, invalid, missing, stale, and gapped target state", () => {
  const item = capability("hwc-cover", [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "native-a:main" }]);
  const validInput = configuredInput();
  const cases: readonly [string, HomeWorldSnapshot, readonly (AuthorityCandidateResolveInput | undefined)[], HomeWorldAuthorityBindingSourceError["code"]][] = [
    ["unknown", snapshot([bridge("bridge-a", { item })]), [undefined], "unavailable"],
    ["invalid", snapshot([bridge("bridge-a", { item })]), [{ ...validInput, nativeId: "not-allowed" } as never], "invalid_input"],
    ["missing-watermark", snapshot([bridge("bridge-a", { item, noWatermark: true })]), [validInput], "unavailable"],
    ["stale", snapshot([bridge("bridge-a", { item, connectionState: "degraded" })]), [validInput], "unavailable"],
    ["gap", snapshot([bridge("bridge-a", { item, historyGapCount: 1 })]), [validInput], "unavailable"],
  ];

  for (const [name, current, inputs, code] of cases) {
    const world = new FakeHomeWorld(
      [current, current],
      new Map([["hwc-cover", inputs]]),
      new Map([["hwc-cover", [{ status: "available", bridgeId: "bridge-a" }]]]),
      new Map([["hwc-cover", ["bridge-a"]]]),
    );
    assertSourceError(
      () => source(world).readFreshWorldCut({ artifact, hwCapabilityIds: ["hwc-cover"] }),
      code,
    );
    assert.equal(name.length > 0, true);
  }
});

test("fails closed when a relevant bridge watermark claims another owner", () => {
  const item = capability("hwc-cover", [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "native-a:main" }]);
  const current = snapshot([bridge("bridge-a", { item, watermarkOwnerId: "bridge-b" })]);
  const world = new FakeHomeWorld(
    [current, current],
    new Map([["hwc-cover", [configuredInput()]]]),
    new Map([["hwc-cover", [{ status: "available", bridgeId: "bridge-a" }]]]),
    new Map([["hwc-cover", ["bridge-a"]]]),
  );

  assertSourceError(
    () => source(world).readFreshWorldCut({ artifact, hwCapabilityIds: ["hwc-cover"] }),
    "invalid_input",
  );
});

test("fails closed when a second neutral read changes a relevant watermark or binding identity", () => {
  const firstItem = capability("hwc-cover", [{ bridgeId: "bridge-a", nativeId: "native-a", nativeInstanceId: "native-a:main" }]);
  const secondItem = capability("hwc-cover", [{ bridgeId: "bridge-a", nativeId: "native-a-rotated", nativeInstanceId: "native-a:main" }]);

  const changedWatermarkWorld = new FakeHomeWorld(
    [snapshot([bridge("bridge-a", { item: firstItem, lastSeq: 42 })]), snapshot([bridge("bridge-a", { item: firstItem, lastSeq: 43 })])],
    new Map([["hwc-cover", [configuredInput(), configuredInput()]]]),
    new Map([["hwc-cover", [{ status: "available", bridgeId: "bridge-a" }, { status: "available", bridgeId: "bridge-a" }]]]),
    new Map([["hwc-cover", ["bridge-a"]]]),
  );
  assertSourceError(
    () => source(changedWatermarkWorld).readFreshWorldCut({ artifact, hwCapabilityIds: ["hwc-cover"] }),
    "inconsistent_cut",
  );

  const changedIdentityWorld = new FakeHomeWorld(
    [snapshot([bridge("bridge-a", { item: firstItem })]), snapshot([bridge("bridge-a", { item: firstItem })])],
    new Map([["hwc-cover", [configuredInput(), configuredInput("hwc-cover", { bindingIdentity: `sha256:${"3".repeat(64)}` })]]]),
    new Map([["hwc-cover", [{ status: "available", bridgeId: "bridge-a" }, { status: "available", bridgeId: "bridge-a" }]]]),
    new Map([["hwc-cover", ["bridge-a"]]]),
  );
  assertSourceError(
    () => source(changedIdentityWorld).readFreshWorldCut({ artifact, hwCapabilityIds: ["hwc-cover"] }),
    "inconsistent_cut",
  );
});
