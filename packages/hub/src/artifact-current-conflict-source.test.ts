import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactRegistryEntry } from "./artifact-registry.js";
import type {
  ArtifactRiskConflictFinding,
  ArtifactRiskConflictPort,
  ArtifactRiskConflictResult,
} from "./artifact-risk-producer.js";
import {
  ArtifactCurrentConflictSource,
  ArtifactCurrentConflictSourceError,
  type ArtifactCurrentConflictHomeWorldPort,
} from "./artifact-current-conflict-source.js";
import type { ApprovedProposalSource } from "./artifact-producer.js";
import {
  createArtifactRevision,
  type ArtifactContent,
  type ArtifactRef,
  type ArtifactRevision,
} from "./neutral-artifact.js";
import type {
  HomeWorldBridgeSnapshot,
  HomeWorldCapabilitySnapshot,
  HomeWorldDeviceSnapshot,
  HomeWorldDiagnostics,
  HomeWorldForeignRuleCatalog,
  HomeWorldSnapshot,
  HomeWorldWatermark,
} from "./home-world-service.js";
import type { HubVerifiedProposalSource } from "./proposal-store.js";
import type {
  ArtifactRiskConflictArtifactRegistry,
} from "./artifact-conflict-source.js";

const capturedAt = "2026-08-20T04:00:00.000Z";

function deviceContent(target = "hwc-target", trigger = "hwc-trigger"): ArtifactContent {
  return {
    trigger: { kind: "capability_changed", source: { hwCapabilityId: trigger } },
    conditions: [],
    actions: [{ kind: "set_level", target: { hwCapabilityId: target }, value: 0.5 }],
    rollback: { kind: "restore_previous_state", target: { hwCapabilityId: target }, maxAgeSeconds: 900 },
    postconditions: [{
      kind: "capability_value",
      source: { hwCapabilityId: target },
      operator: "equals",
      value: 0.5,
      withinSeconds: 120,
    }],
  };
}

function artifact(
  content: ArtifactContent = deviceContent(),
  artifactId = "artifact-current-conflict",
): ArtifactRevision {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId,
    revision: 1,
    title: "Turn on kitchen light",
    summary: "Turn on the kitchen light when the house arrives home.",
    sourceProposal: { proposalId: "proposal-current-conflict", proposalRevision: 2 },
    content,
    createdAt: capturedAt,
  });
}

function ref(value: ArtifactRevision): ArtifactRef {
  return {
    artifactId: value.artifactId,
    revision: value.revision,
    contentHash: value.contentHash,
  };
}

function proposal(value: ArtifactRevision): HubVerifiedProposalSource {
  return {
    proposalId: value.sourceProposal.proposalId,
    revision: value.sourceProposal.proposalRevision,
    kind: "automation-draft",
    status: "approved",
    applicationStatus: "not_available",
    title: value.title,
    summary: value.summary,
    intent: {
      type: "automation-draft",
      description: "Turn on the kitchen light when arriving home.",
      rollback: "Restore the previous light state.",
    },
    evidence: {
      references: [],
      watermarks: [{
        bridgeId: "bridge-relevant",
        epochId: "epoch-relevant",
        lastSeq: 7,
        freshness: "fresh",
        gapCount: 0,
      }],
    },
    conflictCheck: { status: "checked", existingAutomationCount: 0, matches: [] },
    risk: { level: "low", reasons: [], requiresHumanApproval: true },
    artifactCandidate: { schemaVersion: "1", content: value.content },
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
    historyGapCount,
    recentHistoryGaps: historyGapCount === 0 ? [] : [{
      from: "epoch-old",
      to: "epoch-new",
      reason: "fixture-gap",
    }],
  };
}

function watermark(bridgeId: string, epochId = "epoch-relevant", lastSeq = 7): HomeWorldWatermark {
  return { bridgeId, epochId, lastSeq, lastSyncCompleteAt: capturedAt };
}

function capability(
  hwCapabilityId: string,
  bridgeId: string,
): HomeWorldCapabilitySnapshot {
  return {
    hwCapabilityId,
    hwId: "hw-device",
    schema: "hob.light",
    schemaVersion: "1.0.0",
    semanticKind: "light",
    bindings: [{ bridgeId, nativeId: "native-device", nativeInstanceId: "native-device:main" }],
  };
}

function device(bridgeId: string, capabilities: readonly HomeWorldCapabilitySnapshot[]): HomeWorldDeviceSnapshot {
  const first = capabilities[0]!;
  return {
    bridgeId,
    hwId: first.hwId,
    nativeId: "native-device",
    bindings: first.bindings,
    capabilities,
    descriptor: {
      nativeId: "native-device",
      capabilities: first.bindings.map((binding) => ({
        nativeInstanceId: binding.nativeInstanceId,
        schema: first.schema,
        schemaVersion: first.schemaVersion,
        semanticKind: first.semanticKind,
      })),
    },
    states: [],
    validity: "valid",
  };
}

function bridge(
  bridgeId: string,
  options: {
    readonly epochId?: string;
    readonly lastSeq?: number;
    readonly connectionState?: HomeWorldDiagnostics["connectionState"];
    readonly historyGapCount?: number;
    readonly capabilities?: readonly HomeWorldCapabilitySnapshot[];
  } = {},
): HomeWorldBridgeSnapshot {
  const state = options.connectionState ?? "ready";
  return {
    bridgeId,
    adapterType: "fixture",
    diagnostics: diagnostics(state, options.historyGapCount ?? 0),
    watermark: watermark(bridgeId, options.epochId ?? "epoch-relevant", options.lastSeq ?? 7),
    devices: options.capabilities === undefined ? [] : [device(bridgeId, options.capabilities)],
    extensions: { "foreignRules@1": "available" },
    metrics: {
      consistency: state === "ready" ? "ready" : "degraded",
      eventActivity: "active",
      connection: state === "ready" ? "up" : "degraded",
    },
  };
}

function snapshot(bridges: readonly HomeWorldBridgeSnapshot[]): HomeWorldSnapshot {
  const bridgeMap = Object.fromEntries(bridges.map((item) => [item.bridgeId, item]));
  const bridgeWatermarks = bridges.flatMap((item) => item.watermark === null ? [] : [item.watermark]);
  return {
    generatedAt: capturedAt,
    bridges: bridgeMap,
    watermarkVector: Object.fromEntries(bridges.map((item) => [item.bridgeId, item.watermark])),
    bridgeWatermarks,
    watermarks: bridgeWatermarks,
    diagnostics: bridges.map((item) => ({ bridgeId: item.bridgeId, connectionState: item.diagnostics.connectionState })),
    metrics: {
      consistency: bridges.map((item) => ({ bridgeId: item.bridgeId, state: item.diagnostics.connectionState })),
      eventActivity: bridges.map((item) => ({ bridgeId: item.bridgeId })),
      connectionActivity: bridges.map((item) => ({ bridgeId: item.bridgeId, state: item.diagnostics.connectionState })),
    },
    spaces: [],
    devices: bridges.flatMap((item) => item.devices),
  };
}

function availableCatalog(
  bridgeId = "bridge-relevant",
  epochId = "epoch-relevant",
  rules: HomeWorldForeignRuleCatalog["rules"] = [],
): HomeWorldForeignRuleCatalog {
  return { bridgeId, status: "available", epochId, rules };
}

class FakeHomeWorld implements ArtifactCurrentConflictHomeWorldPort {
  readonly snapshotCalls: number[] = [];
  readonly catalogCalls: number[] = [];
  private snapshotIndex = 0;
  private catalogValue: readonly HomeWorldForeignRuleCatalog[] | Error;

  constructor(
    private readonly snapshots: readonly HomeWorldSnapshot[],
    catalog: readonly HomeWorldForeignRuleCatalog[] | Error,
  ) {
    this.catalogValue = catalog;
  }

  snapshot(): HomeWorldSnapshot {
    this.snapshotCalls.push(this.snapshotIndex);
    return this.snapshots[Math.min(this.snapshotIndex++, this.snapshots.length - 1)]!;
  }

  async foreignRuleCatalog(): Promise<readonly HomeWorldForeignRuleCatalog[]> {
    this.catalogCalls.push(1);
    if (this.catalogValue instanceof Error) throw this.catalogValue;
    return this.catalogValue;
  }
}

class StubProposalSource implements ApprovedProposalSource {
  constructor(readonly value: unknown) {}

  withApprovedProposalAtRevision<T>(
    proposalId: string,
    revision: number,
    operation: (source: HubVerifiedProposalSource) => T,
  ): T {
    assert.equal(proposalId, "proposal-current-conflict");
    assert.equal(revision, 2);
    return operation(this.value as HubVerifiedProposalSource);
  }
}

class StubRegistry implements ArtifactRiskConflictArtifactRegistry {
  constructor(readonly value: ArtifactRevision) {}

  getRevision(artifactId: string, revision: number): ArtifactRegistryEntry | undefined {
    if (artifactId !== this.value.artifactId || revision !== this.value.revision) return undefined;
    return { artifact: this.value, status: "draft", tombstone: false, audit: [] };
  }

  list(): readonly ArtifactRegistryEntry[] {
    return [];
  }
}

class StubExistingConflict implements ArtifactRiskConflictPort {
  readonly calls: ArtifactRiskConflictResult[] = [];

  constructor(private readonly result: ArtifactRiskConflictResult) {}

  assess(input: { readonly artifact: ArtifactRef; readonly hwCapabilityIds: readonly string[] }): ArtifactRiskConflictResult {
    this.calls.push({ ...this.result, findings: [...this.result.findings] });
    assert.deepEqual(input.hwCapabilityIds, ["hwc-target", "hwc-trigger"]);
    return this.result;
  }
}

class MutableExistingConflict implements ArtifactRiskConflictPort {
  constructor(public result: ArtifactRiskConflictResult) {}

  assess(input: { readonly artifact: ArtifactRef; readonly hwCapabilityIds: readonly string[] }): ArtifactRiskConflictResult {
    assert.deepEqual(input.hwCapabilityIds, ["hwc-target", "hwc-trigger"]);
    return this.result;
  }
}

function baseResult(findings: readonly ArtifactRiskConflictFinding[] = []): ArtifactRiskConflictResult {
  return {
    status: findings.length === 0 ? "none" : "possible_overlap",
    findings,
    sourceIdentity: `sha256:${"b".repeat(64)}`,
  };
}

function makeSource(options: {
  readonly snapshots?: readonly HomeWorldSnapshot[];
  readonly catalogs?: readonly HomeWorldForeignRuleCatalog[] | Error;
  readonly existing?: ArtifactRiskConflictPort;
} = {}) {
  const value = artifact();
  const target = capability("hwc-target", "bridge-relevant");
  const trigger = capability("hwc-trigger", "bridge-relevant");
  const before = snapshot([bridge("bridge-relevant", { capabilities: [target, trigger] })]);
  const after = snapshot([bridge("bridge-relevant", { capabilities: [target, trigger] })]);
  const homeWorld = new FakeHomeWorld(options.snapshots ?? [before, after], options.catalogs ?? [availableCatalog()]);
  const existing = options.existing ?? new StubExistingConflict(baseResult());
  const source = new ArtifactCurrentConflictSource({
    proposals: new StubProposalSource(proposal(value)),
    registry: new StubRegistry(value),
    homeWorld,
    existing,
  });
  return { value, homeWorld, source, existing };
}

function expectedQuery(value: ArtifactRevision): { artifact: ArtifactRef; hwCapabilityIds: readonly string[] } {
  return { artifact: ref(value), hwCapabilityIds: ["hwc-target", "hwc-trigger"] };
}

test("captures zero current rules into an immutable synchronous port with a stable non-empty identity", async () => {
  const environment = makeSource();
  const port = await environment.source.capture(ref(environment.value));
  const result = port.assess(expectedQuery(environment.value));

  assert.deepEqual({ status: result.status, findings: result.findings }, { status: "none", findings: [] });
  assert.match(result.sourceIdentity, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(result.sourceIdentity, `sha256:${"0".repeat(64)}`);
  assert.equal(environment.homeWorld.catalogCalls.length, 1);
  assert.equal(environment.homeWorld.snapshotCalls.length, 2);
  assert.equal(typeof (port as unknown as { capture?: unknown }).capture, "undefined");
  assert.ok(Object.isFrozen(port));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.findings));
  assert.equal(port.assess(expectedQuery(environment.value)).sourceIdentity, result.sourceIdentity);
});

test("covers the complete bounded foreign-rule catalog without truncating its identity", async () => {
  const rules = Array.from({ length: 256 }, (_, index) => ({ ruleRef: `rule-${index}` }));
  const environment = makeSource({ catalogs: [availableCatalog("bridge-relevant", "epoch-relevant", rules)] });
  const result = (await environment.source.capture(ref(environment.value))).assess(expectedQuery(environment.value));
  assert.equal(result.status, "none");
  assert.deepEqual(result.findings, []);
  assert.match(result.sourceIdentity, /^sha256:[0-9a-f]{64}$/);
});

test("adds deterministic opaque overlap findings without returning rule metadata", async () => {
  const environment = makeSource({
    catalogs: [availableCatalog("bridge-relevant", "epoch-relevant", [{
      ruleRef: "ha-automation-123",
      name: "Turn on kitchen light when arriving home",
      enabled: true,
      updatedAt: capturedAt,
    }])],
  });
  const port = await environment.source.capture(ref(environment.value));
  const result = port.assess(expectedQuery(environment.value));

  assert.equal(result.status, "possible_overlap");
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0], {
    kind: "foreign_rule",
    severity: "warning",
    reason: "possible_overlap",
    reference: result.findings[0]!.reference,
  });
  assert.match(result.findings[0]!.reference!, /^sha256:[0-9a-f]{64}$/);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes("ha-automation-123"), false);
  assert.equal(encoded.includes("kitchen light"), false);
  assert.equal(encoded.includes("provider"), false);
  assert.equal(encoded.includes("native"), false);
  assert.equal(encoded.includes("http"), false);
});

test("preserves blocking findings from the injected source while composing current overlap", async () => {
  const blocking: ArtifactRiskConflictFinding = {
    kind: "existing_artifact",
    severity: "blocking",
    reason: "existing_artifact",
    hwCapabilityId: "hwc-target",
    reference: `sha256:${"c".repeat(64)}`,
  };
  const existing = new StubExistingConflict(baseResult([blocking]));
  const environment = makeSource({
    existing,
    catalogs: [availableCatalog("bridge-relevant", "epoch-relevant", [{ ruleRef: "rule-1", name: "kitchen light" }])],
  });
  const result = (await environment.source.capture(ref(environment.value))).assess(expectedQuery(environment.value));
  assert.equal(result.status, "possible_overlap");
  assert.equal(result.findings.some((finding) => finding.severity === "blocking" && finding.reason === "existing_artifact"), true);
  assert.equal(result.findings.some((finding) => finding.kind === "foreign_rule"), true);
});

test("fails closed for unavailable, incomplete, epoch-mismatched, and cut-changing current catalogs", async () => {
  const value = artifact();
  const target = capability("hwc-target", "bridge-relevant");
  const trigger = capability("hwc-trigger", "bridge-relevant");
  const stableBefore = snapshot([bridge("bridge-relevant", { capabilities: [target, trigger] })]);
  const cases: Array<{ readonly homeWorld: FakeHomeWorld }> = [
    { homeWorld: new FakeHomeWorld([stableBefore, stableBefore], [{ bridgeId: "bridge-relevant", status: "unavailable", rules: [] }]) },
    { homeWorld: new FakeHomeWorld([stableBefore, stableBefore], [{ bridgeId: "bridge-relevant", status: "available", epochId: "epoch-relevant", rules: [] }, { bridgeId: "bridge-relevant", status: "available", epochId: "epoch-relevant", rules: [] }]) },
    { homeWorld: new FakeHomeWorld([stableBefore, stableBefore], [availableCatalog("bridge-relevant", "wrong-epoch")]) },
    { homeWorld: new FakeHomeWorld([
      stableBefore,
      snapshot([bridge("bridge-relevant", { lastSeq: 8, capabilities: [target, trigger] })]),
    ], [availableCatalog()]) },
  ];

  for (const { homeWorld } of cases) {
    const source = new ArtifactCurrentConflictSource({
      proposals: new StubProposalSource(proposal(value)),
      registry: new StubRegistry(value),
      homeWorld,
      existing: new StubExistingConflict(baseResult()),
    });
    const port = await source.capture(ref(value));
    const result = port.assess(expectedQuery(value));
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.findings, [{
      kind: "stale_evidence",
      severity: "blocking",
      reason: "conflict_unavailable",
    }]);
    assert.equal(result.sourceIdentity, `sha256:${"0".repeat(64)}`);
  }
});

test("ignores an unrelated bad bridge and changes identity when catalog or watermark metadata changes", async () => {
  const value = artifact();
  const target = capability("hwc-target", "bridge-relevant");
  const trigger = capability("hwc-trigger", "bridge-relevant");
  const irrelevant = bridge("bridge-irrelevant", { connectionState: "down" });
  const first = snapshot([bridge("bridge-relevant", { capabilities: [target, trigger] }), irrelevant]);
  const firstAfter = snapshot([bridge("bridge-relevant", { capabilities: [target, trigger] }), irrelevant]);
  const firstSource = new ArtifactCurrentConflictSource({
    proposals: new StubProposalSource(proposal(value)),
    registry: new StubRegistry(value),
    homeWorld: new FakeHomeWorld([first, firstAfter], [availableCatalog()]),
    existing: new StubExistingConflict(baseResult()),
  });
  const firstPort = await firstSource.capture(ref(value));
  const firstResult = firstPort.assess(expectedQuery(value));

  const changed = new ArtifactCurrentConflictSource({
    proposals: new StubProposalSource(proposal(value)),
    registry: new StubRegistry(value),
    homeWorld: new FakeHomeWorld(
      [first, firstAfter],
      [availableCatalog("bridge-relevant", "epoch-relevant", [{ ruleRef: "rule-1", name: "unrelated metadata" }])],
    ),
    existing: new StubExistingConflict(baseResult()),
  });
  const changedResult = (await changed.capture(ref(value))).assess(expectedQuery(value));
  assert.notEqual(changedResult.sourceIdentity, firstResult.sourceIdentity);

  const watermarkChanged = new ArtifactCurrentConflictSource({
    proposals: new StubProposalSource(proposal(value)),
    registry: new StubRegistry(value),
    homeWorld: new FakeHomeWorld([
      first,
      snapshot([bridge("bridge-relevant", { lastSeq: 8, capabilities: [target, trigger] }), irrelevant]),
    ], [availableCatalog()]),
    existing: new StubExistingConflict(baseResult()),
  });
  const watermarkResult = (await watermarkChanged.capture(ref(value))).assess(expectedQuery(value));
  assert.equal(watermarkResult.status, "unavailable");
});

test("fails closed when a relevant bridge has no catalog row at all", async () => {
  const environment = makeSource({ catalogs: [] });
  const port = await environment.source.capture(ref(environment.value));
  const result = port.assess(expectedQuery(environment.value));
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.findings, [{
    kind: "stale_evidence",
    severity: "blocking",
    reason: "conflict_unavailable",
  }]);
});

test("changes the composed identity when the existing source identity changes with equal findings", async () => {
  const existing = new MutableExistingConflict(baseResult());
  const environment = makeSource({ existing });
  const first = (await environment.source.capture(ref(environment.value))).assess(expectedQuery(environment.value));

  existing.result = {
    ...baseResult(),
    sourceIdentity: `sha256:${"d".repeat(64)}`,
  };
  const second = (await environment.source.capture(ref(environment.value))).assess(expectedQuery(environment.value));

  assert.deepEqual(second.findings, first.findings);
  assert.notEqual(second.sourceIdentity, first.sourceIdentity);
});

test("rejects constructor options with an extra key", () => {
  const environment = makeSource();
  assert.throws(
    () => new ArtifactCurrentConflictSource({
      proposals: new StubProposalSource(proposal(environment.value)),
      registry: new StubRegistry(environment.value),
      homeWorld: environment.homeWorld,
      existing: environment.existing,
      extra: true,
    } as never),
    (error: unknown) => error instanceof ArtifactCurrentConflictSourceError && error.code === "invalid_input",
  );
});

test("requires exact capture and assessment inputs and never invokes a control seam", async () => {
  const environment = makeSource();
  await assert.rejects(
    () => environment.source.capture({ artifact: ref(environment.value) } as never),
    (error: unknown) => error instanceof ArtifactCurrentConflictSourceError && error.code === "invalid_input",
  );
  await assert.rejects(
    () => environment.source.capture({ ...ref(environment.value), extra: true } as never),
    (error: unknown) => error instanceof ArtifactCurrentConflictSourceError && error.code === "invalid_input",
  );

  const port = await environment.source.capture(ref(environment.value));
  assert.throws(
    () => port.assess({ artifact: ref(environment.value), hwCapabilityIds: ["hwc-trigger", "hwc-target"] }),
    (error: unknown) => error instanceof ArtifactCurrentConflictSourceError && error.code === "invalid_input",
  );
  assert.throws(
    () => port.assess({ artifact: ref(environment.value), hwCapabilityIds: ["hwc-target", "hwc-trigger"], extra: true } as never),
    (error: unknown) => error instanceof ArtifactCurrentConflictSourceError && error.code === "invalid_input",
  );
  assert.throws(
    () => port.assess({ artifact: { ...ref(environment.value), contentHash: `sha256:${"f".repeat(64)}` }, hwCapabilityIds: ["hwc-target", "hwc-trigger"] }),
    (error: unknown) => error instanceof ArtifactCurrentConflictSourceError && error.code === "invalid_input",
  );
});
