import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactRegistryEntry } from "./artifact-registry.js";
import {
  createArtifactEvidenceAttestation,
  type ArtifactEvidenceAttestation,
} from "./artifact-assessments.js";
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
} from "../world/home-world-service.js";
import type { HubVerifiedProposalSource } from "../proposal-store.js";
import type {
  ArtifactRiskConflictArtifactRegistry,
} from "./artifact-conflict-source.js";
import { computeNeutralForeignCatalogIdentity } from "./artifact-compiler-contract.js";

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

function notifyArtifact(): ArtifactRevision {
  return artifact({
    trigger: {
      kind: "schedule",
      timezone: "UTC",
      daysOfWeek: [1],
      at: "09:00",
    },
    conditions: [],
    actions: [{ kind: "notify_local", message: "Review the household note." }],
    rollback: { kind: "no_remote_change" },
    postconditions: [],
  }, "artifact-current-conflict-notify");
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

function watermark(
  bridgeId: string,
  epochId = "epoch-relevant",
  lastSeq = 7,
  lastSyncCompleteAt = capturedAt,
): HomeWorldWatermark {
  return { bridgeId, epochId, lastSeq, lastSyncCompleteAt };
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
    readonly lastSyncCompleteAt?: string;
  } = {},
): HomeWorldBridgeSnapshot {
  const state = options.connectionState ?? "ready";
  return {
    bridgeId,
    adapterType: "fixture",
    diagnostics: diagnostics(state, options.historyGapCount ?? 0),
    watermark: watermark(
      bridgeId,
      options.epochId ?? "epoch-relevant",
      options.lastSeq ?? 7,
      options.lastSyncCompleteAt ?? capturedAt,
    ),
    devices: options.capabilities === undefined ? [] : [device(bridgeId, options.capabilities)],
    extensions: { "foreignRules@2": "available" },
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

type EvidenceWatermark = ArtifactEvidenceAttestation["watermarks"][number];

function evidenceWatermark(
  bridgeId: string,
  epochId = "epoch-relevant",
  lastSeq = 7,
  overrides: Partial<EvidenceWatermark> = {},
): EvidenceWatermark {
  return {
    bridgeId,
    epochId,
    lastSeq,
    freshness: "fresh",
    gapCount: 0,
    ...overrides,
  };
}

function capabilityScope(content: ArtifactContent): readonly string[] {
  const ids = new Set<string>();
  if (content.trigger.kind === "capability_changed") ids.add(content.trigger.source.hwCapabilityId);
  for (const condition of content.conditions) ids.add(condition.source.hwCapabilityId);
  for (const action of content.actions) {
    if (action.kind !== "notify_local") ids.add(action.target.hwCapabilityId);
  }
  if (content.rollback.kind === "restore_previous_state") ids.add(content.rollback.target.hwCapabilityId);
  for (const postcondition of content.postconditions) ids.add(postcondition.source.hwCapabilityId);
  return [...ids].sort();
}

function evidenceFor(
  value: ArtifactRevision,
  watermarks: readonly EvidenceWatermark[] = [evidenceWatermark("bridge-relevant")],
  selectedHwCapabilityIds: readonly string[] = capabilityScope(value.content),
  overrides: Partial<Parameters<typeof createArtifactEvidenceAttestation>[0]> = {},
): ArtifactEvidenceAttestation {
  return createArtifactEvidenceAttestation({
    artifact: ref(value),
    attestationId: `evidence-${value.artifactId}`,
    source: "home-world-consistent-cut",
    sourceProposal: value.sourceProposal,
    proposalEvidenceIdentity: `sha256:${"e".repeat(64)}`,
    capturedAt,
    selectedHwCapabilityIds,
    watermarks,
    coverage: "complete",
    reasons: [],
    ...overrides,
  });
}

function availableCatalog(
  bridgeId = "bridge-relevant",
  epochId = "epoch-relevant",
  rules: HomeWorldForeignRuleCatalog["rules"] = [],
  lastSeq = 7,
): HomeWorldForeignRuleCatalog {
  return { bridgeId, status: "available", epochId, lastSeq, rules };
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

  constructor(
    private readonly result: ArtifactRiskConflictResult,
    private readonly expectedScope: readonly string[] = ["hwc-target", "hwc-trigger"],
  ) {}

  assess(input: { readonly artifact: ArtifactRef; readonly hwCapabilityIds: readonly string[] }): ArtifactRiskConflictResult {
    this.calls.push({ ...this.result, findings: [...this.result.findings] });
    assert.deepEqual(input.hwCapabilityIds, this.expectedScope);
    return this.result;
  }
}

class MutableExistingConflict implements ArtifactRiskConflictPort {
  constructor(
    public result: ArtifactRiskConflictResult,
    private readonly expectedScope: readonly string[] = ["hwc-target", "hwc-trigger"],
  ) {}

  assess(input: { readonly artifact: ArtifactRef; readonly hwCapabilityIds: readonly string[] }): ArtifactRiskConflictResult {
    assert.deepEqual(input.hwCapabilityIds, this.expectedScope);
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

function captureInput(value: ArtifactRevision, evidence: ArtifactEvidenceAttestation): {
  readonly artifact: ArtifactRef;
  readonly evidence: ArtifactEvidenceAttestation;
} {
  return { artifact: ref(value), evidence };
}

function captureEnvironment(environment: {
  readonly value: ArtifactRevision;
  readonly evidence: ArtifactEvidenceAttestation;
  readonly source: ArtifactCurrentConflictSource;
}) {
  return environment.source.capture(captureInput(environment.value, environment.evidence));
}

function makeSource(options: {
  readonly value?: ArtifactRevision;
  readonly snapshots?: readonly HomeWorldSnapshot[];
  readonly catalogs?: readonly HomeWorldForeignRuleCatalog[] | Error;
  readonly existing?: ArtifactRiskConflictPort;
  readonly evidence?: ArtifactEvidenceAttestation;
} = {}) {
  const value = options.value ?? artifact();
  const scope = capabilityScope(value.content);
  const capabilities = scope.map((id) => capability(id, "bridge-relevant"));
  const snapshotOptions = capabilities.length === 0 ? {} : { capabilities };
  const before = snapshot([bridge("bridge-relevant", snapshotOptions)]);
  const after = snapshot([bridge("bridge-relevant", snapshotOptions)]);
  const homeWorld = new FakeHomeWorld(options.snapshots ?? [before, after], options.catalogs ?? [availableCatalog()]);
  const evidence = options.evidence ?? evidenceFor(value);
  const existing = options.existing ?? new StubExistingConflict(baseResult(), scope);
  const source = new ArtifactCurrentConflictSource({
    proposals: new StubProposalSource(proposal(value)),
    registry: new StubRegistry(value),
    homeWorld,
    existing,
  });
  return { value, evidence, homeWorld, source, existing };
}

function makeMultiBridgeSource(options: {
  readonly snapshots?: readonly HomeWorldSnapshot[];
  readonly catalogs?: readonly HomeWorldForeignRuleCatalog[] | Error;
  readonly existing?: ArtifactRiskConflictPort;
  readonly epochA?: string;
  readonly epochB?: string;
  readonly lastSeqA?: number;
  readonly lastSeqB?: number;
} = {}) {
  const value = artifact();
  const target = capability("hwc-target", "bridge-a");
  const trigger = capability("hwc-trigger", "bridge-b");
  const epochA = options.epochA ?? "epoch-a";
  const epochB = options.epochB ?? "epoch-b";
  const before = snapshot([
    bridge("bridge-a", { capabilities: [target], epochId: epochA, lastSeq: options.lastSeqA ?? 7 }),
    bridge("bridge-b", { capabilities: [trigger], epochId: epochB, lastSeq: options.lastSeqB ?? 11 }),
  ]);
  const after = snapshot([
    bridge("bridge-a", { capabilities: [target], epochId: epochA, lastSeq: options.lastSeqA ?? 7 }),
    bridge("bridge-b", { capabilities: [trigger], epochId: epochB, lastSeq: options.lastSeqB ?? 11 }),
  ]);
  const catalogs = options.catalogs ?? [
    availableCatalog("bridge-a", epochA, [{
      ruleRef: "ha-rule-a",
      name: "Turn on kitchen light",
      enabled: true,
      updatedAt: capturedAt,
    }], options.lastSeqA ?? 7),
    availableCatalog("bridge-b", epochB, [{
      ruleRef: "vendor-rule-b",
      name: "Arriving home turns on light",
      enabled: true,
      updatedAt: capturedAt,
    }], options.lastSeqB ?? 11),
  ];
  const homeWorld = new FakeHomeWorld(options.snapshots ?? [before, after], catalogs);
  const evidence = evidenceFor(value, [
    evidenceWatermark("bridge-a", epochA, options.lastSeqA ?? 7),
    evidenceWatermark("bridge-b", epochB, options.lastSeqB ?? 11),
  ]);
  const existing = options.existing ?? new StubExistingConflict(baseResult([{
    kind: "existing_artifact",
    severity: "blocking",
    reason: "existing_artifact",
    hwCapabilityId: "hwc-target",
    reference: `sha256:${"c".repeat(64)}`,
  }]));
  const source = new ArtifactCurrentConflictSource({
    proposals: new StubProposalSource(proposal(value)),
    registry: new StubRegistry(value),
    homeWorld,
    existing,
  });
  return { value, evidence, homeWorld, source, existing, before, after };
}

function expectedQuery(value: ArtifactRevision): { artifact: ArtifactRef; hwCapabilityIds: readonly string[] } {
  return { artifact: ref(value), hwCapabilityIds: capabilityScope(value.content) };
}

test("captures zero current rules into an immutable synchronous port with a stable non-empty identity", async () => {
  const environment = makeSource();
  const port = await captureEnvironment(environment);
  const result = port.assess(expectedQuery(environment.value));

  assert.deepEqual({ status: result.status, findings: result.findings }, { status: "none", findings: [] });
  assert.match(result.sourceIdentity, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(result.sourceIdentity, `sha256:${"0".repeat(64)}`);
  assert.equal(environment.homeWorld.catalogCalls.length, 1);
  assert.equal(environment.homeWorld.snapshotCalls.length, 2);
  assert.equal(typeof (port as unknown as { capture?: unknown }).capture, "undefined");
  assert.match(port.compileCut()!.foreignCatalogIdentity, /^sha256:[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(port));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.findings));
  assert.equal(port.assess(expectedQuery(environment.value)).sourceIdentity, result.sourceIdentity);
});

test("captures notify-only artifacts for every evidence bridge even with an empty capability scope", async () => {
  const value = notifyArtifact();
  const evidence = evidenceFor(value, [
    evidenceWatermark("bridge-a", "epoch-a", 3),
    evidenceWatermark("bridge-b", "epoch-b", 5),
  ], []);
  const before = snapshot([
    bridge("bridge-a", { epochId: "epoch-a", lastSeq: 3 }),
    bridge("bridge-b", { epochId: "epoch-b", lastSeq: 5 }),
  ]);
  const after = snapshot([
    bridge("bridge-a", { epochId: "epoch-a", lastSeq: 3 }),
    bridge("bridge-b", { epochId: "epoch-b", lastSeq: 5 }),
  ]);
  const environment = makeSource({
    value,
    evidence,
    snapshots: [before, after],
    catalogs: [
      availableCatalog("bridge-a", "epoch-a", [{ ruleRef: "ha-notify-a", name: "kitchen light notice" }], 3),
      availableCatalog("bridge-b", "epoch-b", [{ ruleRef: "vendor-notify-b", name: "house note" }], 5),
    ],
    existing: new StubExistingConflict(baseResult(), []),
  });
  const port = await captureEnvironment(environment);
  const result = port.assess(expectedQuery(value));
  const cut = port.compileCut();

  assert.equal(result.status, "possible_overlap");
  assert.ok(cut);
  assert.deepEqual(cut.foreignRuleChecks.map((check) => check.bridgeId), ["bridge-a", "bridge-b"]);
  assert.deepEqual(cut.foreignRuleChecks.map((check) => check.watermark.lastSeq), [3, 5]);
  assert.equal(cut.currentConflict.result.findings.every((finding) => finding.kind === "foreign_rule"), true);
  assert.deepEqual(environment.existing instanceof StubExistingConflict ? environment.existing.calls[0]!.findings : [], []);
});

test("fails closed for evidence artifact/scope/coverage mismatches and stale snapshot watermarks", async () => {
  const environment = makeSource();
  const wrongArtifactEvidence = evidenceFor(artifact(deviceContent(), "artifact-other"));
  const scopeMismatchEvidence = evidenceFor(environment.value, [evidenceWatermark("bridge-relevant")], ["hwc-other"]);
  const semanticWatermarkMismatchEvidence = evidenceFor(environment.value, [
    evidenceWatermark("bridge-relevant", "epoch-evidence-mismatch", 7),
  ]);
  const partialEvidence = evidenceFor(environment.value, [evidenceWatermark("bridge-relevant")], capabilityScope(environment.value.content), {
    coverage: "partial",
    reasons: ["history_gap"],
  });
  const target = capability("hwc-target", "bridge-relevant");
  const trigger = capability("hwc-trigger", "bridge-relevant");
  const staleSnapshot = snapshot([bridge("bridge-relevant", {
    capabilities: [target, trigger],
    connectionState: "down",
  })]);
  const cases = [
    wrongArtifactEvidence,
    scopeMismatchEvidence,
    semanticWatermarkMismatchEvidence,
    partialEvidence,
  ];
  for (const evidence of cases) {
    const port = await environment.source.capture(captureInput(environment.value, evidence));
    assert.equal(port.assess(expectedQuery(environment.value)).status, "unavailable");
    assert.equal(port.compileCut(), undefined);
  }
  const stale = makeSource({
    snapshots: [staleSnapshot, staleSnapshot],
    evidence: evidenceFor(environment.value),
  });
  const stalePort = await captureEnvironment(stale);
  assert.equal(stalePort.assess(expectedQuery(environment.value)).status, "unavailable");
  assert.equal(stalePort.compileCut(), undefined);
});

test("fails closed when a device capability binding falls outside the evidence watermark vector", async () => {
  const value = artifact();
  const target = capability("hwc-target", "bridge-outside-vector");
  const trigger = capability("hwc-trigger", "bridge-relevant");
  const before = snapshot([
    bridge("bridge-relevant", { capabilities: [trigger, target] }),
    bridge("bridge-outside-vector", { connectionState: "down" }),
  ]);
  const after = snapshot([
    bridge("bridge-relevant", { capabilities: [trigger, target] }),
    bridge("bridge-outside-vector", { connectionState: "down" }),
  ]);
  const environment = makeSource({
    value,
    snapshots: [before, after],
    evidence: evidenceFor(value, [evidenceWatermark("bridge-relevant")]),
    catalogs: [availableCatalog("bridge-relevant")],
  });

  const port = await captureEnvironment(environment);
  assert.equal(port.assess(expectedQuery(value)).status, "unavailable");
  assert.equal(port.compileCut(), undefined);
});

test("exposes one frozen current conflict compile cut with exact per-bridge semantic inputs", async () => {
  const environment = makeMultiBridgeSource();
  const port = await captureEnvironment(environment);
  const result = port.assess(expectedQuery(environment.value));
  const cut = port.compileCut();

  assert.ok(cut);
  assert.deepEqual(Object.keys(cut).sort(), ["currentConflict", "foreignCatalogIdentity", "foreignRuleChecks"]);
  assert.equal(cut.currentConflict.sourceIdentity, result.sourceIdentity);
  assert.deepEqual(cut.currentConflict.result, {
    status: result.status,
    findings: result.findings,
  });
  assert.equal(cut.foreignRuleChecks.length, 2);
  assert.deepEqual(cut.foreignRuleChecks.map((check) => check.bridgeId), ["bridge-a", "bridge-b"]);
  assert.deepEqual(cut.foreignRuleChecks.map((check) => check.status), ["current", "current"]);
  assert.match(cut.foreignCatalogIdentity, /^sha256:[0-9a-f]{64}$/);
  assert.equal(cut.foreignCatalogIdentity, computeNeutralForeignCatalogIdentity(cut.foreignRuleChecks));

  for (const check of cut.foreignRuleChecks) {
    const semanticWatermark = (check as unknown as {
      readonly watermark: {
        readonly bridgeId: string;
        readonly epochId: string;
        readonly lastSeq: number;
        readonly freshness: string;
        readonly gapCount: number;
      };
    }).watermark;
    assert.equal(semanticWatermark.bridgeId, check.bridgeId);
    assert.equal(semanticWatermark.epochId, check.epochId);
    assert.equal(semanticWatermark.lastSeq, check.bridgeId === "bridge-a" ? 7 : 11);
    assert.equal(semanticWatermark.freshness, "fresh");
    assert.equal(semanticWatermark.gapCount, 0);
    assert.match(check.catalogIdentity, /^sha256:[0-9a-f]{64}$/);
    assert.equal(check.findings.every((finding) => finding.kind === "foreign_rule"), true);
    assert.equal(check.findings.some((finding) => finding.reason === "existing_artifact"), false);
    assert.equal(JSON.stringify(check).includes("ha-rule"), false);
    assert.equal(JSON.stringify(check).includes("vendor-rule"), false);
  }
  assert.equal(cut.currentConflict.result.findings.some((finding) => finding.reason === "existing_artifact"), true);
  assert.equal(Object.isFrozen(cut), true);
  assert.equal(Object.isFrozen(cut.currentConflict), true);
  assert.equal(Object.isFrozen(cut.currentConflict.result), true);
  assert.equal(Object.isFrozen(cut.currentConflict.result.findings), true);
  assert.equal(Object.isFrozen(cut.foreignRuleChecks), true);
  assert.equal(Object.isFrozen(cut.foreignRuleChecks[0]), true);
  assert.equal(Object.isFrozen((cut.foreignRuleChecks[0] as unknown as { readonly watermark: object }).watermark), true);
  assert.equal(port.compileCut(), cut);
  assert.equal(JSON.stringify(cut).includes("native"), false);
  assert.equal(JSON.stringify(cut).includes("provider"), false);
  assert.equal(JSON.stringify(cut).includes("http"), false);
});

test("canonicalizes per-bridge checks and aggregate identity across catalog order", async () => {
  const first = makeMultiBridgeSource();
  const firstPort = await captureEnvironment(first);
  const firstCut = firstPort.compileCut();
  assert.ok(firstCut);

  const reordered = makeMultiBridgeSource({
    catalogs: [
      availableCatalog("bridge-b", "epoch-b", [{
        ruleRef: "vendor-rule-b",
      name: "Arriving home turns on light",
      enabled: true,
      updatedAt: capturedAt,
    }], 11),
      availableCatalog("bridge-a", "epoch-a", [{
        ruleRef: "ha-rule-a",
      name: "Turn on kitchen light",
      enabled: true,
      updatedAt: capturedAt,
    }], 7),
    ],
  });
  const reorderedPort = await captureEnvironment(reordered);
  const reorderedCut = reorderedPort.compileCut();
  assert.ok(reorderedCut);
  assert.deepEqual(reorderedCut.foreignRuleChecks.map((check) => check.bridgeId), ["bridge-a", "bridge-b"]);
  assert.equal(reorderedCut.foreignCatalogIdentity, firstCut.foreignCatalogIdentity);
  assert.equal(reorderedCut.currentConflict.sourceIdentity, firstCut.currentConflict.sourceIdentity);
});

test("changes aggregate identity for semantic watermark and catalog epoch changes", async () => {
  const first = makeMultiBridgeSource();
  const firstCut = (await captureEnvironment(first)).compileCut();
  assert.ok(firstCut);

  const sequenceChanged = makeMultiBridgeSource({ lastSeqA: 8 });
  const sequenceCut = (await captureEnvironment(sequenceChanged)).compileCut();
  assert.ok(sequenceCut);
  assert.notEqual(sequenceCut.foreignCatalogIdentity, firstCut.foreignCatalogIdentity);
  assert.notEqual(sequenceCut.currentConflict.sourceIdentity, firstCut.currentConflict.sourceIdentity);

  const epochChanged = makeMultiBridgeSource({ epochA: "epoch-a-2" });
  const epochCut = (await captureEnvironment(epochChanged)).compileCut();
  assert.ok(epochCut);
  assert.notEqual(epochCut.foreignCatalogIdentity, firstCut.foreignCatalogIdentity);
  assert.notEqual(epochCut.currentConflict.sourceIdentity, firstCut.currentConflict.sourceIdentity);
});

test("keeps capture identity stable when only restart timestamp metadata changes", async () => {
  const baseline = makeSource();
  const baselinePort = await captureEnvironment(baseline);
  const baselineResult = baselinePort.assess(expectedQuery(baseline.value));
  const baselineCut = baselinePort.compileCut();
  assert.ok(baselineCut);

  const value = artifact();
  const target = capability("hwc-target", "bridge-relevant");
  const trigger = capability("hwc-trigger", "bridge-relevant");
  const first = snapshot([bridge("bridge-relevant", {
    capabilities: [target, trigger],
    lastSyncCompleteAt: "2026-08-20T04:00:00.000Z",
  })]);
  const restarted = snapshot([bridge("bridge-relevant", {
    capabilities: [target, trigger],
    lastSyncCompleteAt: "2026-08-20T05:00:00.000Z",
  })]);
  const source = new ArtifactCurrentConflictSource({
    proposals: new StubProposalSource(proposal(value)),
    registry: new StubRegistry(value),
    homeWorld: new FakeHomeWorld([first, restarted], [availableCatalog()]),
    existing: new StubExistingConflict(baseResult()),
  });
  const port = await source.capture(captureInput(value, evidenceFor(value)));
  const result = port.assess(expectedQuery(value));
  const cut = port.compileCut();
  assert.equal(result.status, "none");
  assert.equal(result.sourceIdentity, baselineResult.sourceIdentity);
  assert.ok(cut);
  assert.equal(cut.foreignCatalogIdentity, baselineCut.foreignCatalogIdentity);
});

test("binds evidence attestation and input identities into the composed source identity", async () => {
  const first = makeSource();
  const firstResult = (await captureEnvironment(first)).assess(expectedQuery(first.value));
  const secondEvidence = evidenceFor(first.value, first.evidence.watermarks, capabilityScope(first.value.content), {
    attestationId: "evidence-current-conflict-refresh",
  });
  const second = makeSource({ evidence: secondEvidence });
  const secondResult = (await captureEnvironment(second)).assess(expectedQuery(second.value));
  const thirdEvidence = evidenceFor(first.value, first.evidence.watermarks, capabilityScope(first.value.content), {
    proposalEvidenceIdentity: `sha256:${"f".repeat(64)}`,
  });
  const third = makeSource({ evidence: thirdEvidence });
  const thirdResult = (await captureEnvironment(third)).assess(expectedQuery(third.value));

  assert.deepEqual(secondResult.findings, firstResult.findings);
  assert.notEqual(second.evidence.attestationId, first.evidence.attestationId);
  assert.equal(second.evidence.inputIdentity, first.evidence.inputIdentity);
  assert.notEqual(secondResult.sourceIdentity, firstResult.sourceIdentity);
  assert.equal(third.evidence.attestationId, first.evidence.attestationId);
  assert.notEqual(third.evidence.inputIdentity, first.evidence.inputIdentity);
  assert.deepEqual(thirdResult.findings, firstResult.findings);
  assert.notEqual(thirdResult.sourceIdentity, firstResult.sourceIdentity);
});

test("covers the complete bounded foreign-rule catalog without truncating its identity", async () => {
  const rules = Array.from({ length: 256 }, (_, index) => ({ ruleRef: `rule-${index}` }));
  const environment = makeSource({ catalogs: [availableCatalog("bridge-relevant", "epoch-relevant", rules)] });
  const port = await captureEnvironment(environment);
  const result = port.assess(expectedQuery(environment.value));
  const cut = port.compileCut();
  assert.equal(result.status, "possible_overlap");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.kind, "foreign_rule");
  assert.match(result.findings[0]!.reference!, /^sha256:[0-9a-f]{64}$/);
  assert.ok(cut);
  assert.equal(cut.foreignRuleChecks[0]!.findings.length, 1);
  assert.equal(JSON.stringify(cut).includes("rule-0"), false);
  assert.equal(JSON.stringify(cut).includes("rule-255"), false);

  const changedRules = [...rules.slice(0, -1), { ruleRef: "rule-255-changed" }];
  const changed = makeSource({ catalogs: [availableCatalog("bridge-relevant", "epoch-relevant", changedRules)] });
  const changedCut = (await captureEnvironment(changed)).compileCut();
  assert.ok(changedCut);
  assert.notEqual(changedCut.foreignRuleChecks[0]!.catalogIdentity, cut.foreignRuleChecks[0]!.catalogIdentity);
  assert.notEqual(changedCut.currentConflict.sourceIdentity, cut.currentConflict.sourceIdentity);
  assert.notEqual(
    changedCut.currentConflict.result.findings[0]!.reference,
    cut.currentConflict.result.findings[0]!.reference,
  );
});

test("treats every non-empty opaque catalog as a possible overlap instead of none", async () => {
  const environment = makeSource({
    catalogs: [availableCatalog("bridge-relevant", "epoch-relevant", [{ ruleRef: "opaque-rule-without-structure" }])],
  });
  const port = await captureEnvironment(environment);
  const result = port.assess(expectedQuery(environment.value));
  const cut = port.compileCut();

  assert.equal(result.status, "possible_overlap");
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0], {
    kind: "foreign_rule",
    severity: "warning",
    reason: "possible_overlap",
    reference: result.findings[0]!.reference,
  });
  assert.match(result.findings[0]!.reference!, /^sha256:[0-9a-f]{64}$/);
  assert.ok(cut);
  assert.equal(cut.foreignRuleChecks[0]!.findings.length, 1);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes("opaque-rule-without-structure"), false);
});

test("uses one catalog-level opaque finding beyond the finding budget", async () => {
  const rules = Array.from({ length: 21 }, (_, index) => ({ ruleRef: `opaque-budget-rule-${index}` }));
  const environment = makeSource({ catalogs: [availableCatalog("bridge-relevant", "epoch-relevant", rules)] });
  const port = await captureEnvironment(environment);
  const result = port.assess(expectedQuery(environment.value));

  assert.equal(result.status, "possible_overlap");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.kind, "foreign_rule");
  assert.equal(result.findings[0]!.reason, "possible_overlap");
  assert.match(result.findings[0]!.reference!, /^sha256:[0-9a-f]{64}$/);
  assert.ok(port.compileCut());
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
  const port = await captureEnvironment(environment);
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
  const result = (await captureEnvironment(environment)).assess(expectedQuery(environment.value));
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
    { homeWorld: new FakeHomeWorld([stableBefore, stableBefore], [availableCatalog("bridge-relevant", "epoch-relevant", [], 8)]) },
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
    const port = await source.capture(captureInput(value, evidenceFor(value)));
    const result = port.assess(expectedQuery(value));
    assert.equal(result.status, "unavailable");
    assert.equal(port.compileCut(), undefined);
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
  const firstPort = await firstSource.capture(captureInput(value, evidenceFor(value)));
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
  const changedResult = (await changed.capture(captureInput(value, evidenceFor(value)))).assess(expectedQuery(value));
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
  const watermarkResult = (await watermarkChanged.capture(captureInput(value, evidenceFor(value)))).assess(expectedQuery(value));
  assert.equal(watermarkResult.status, "unavailable");
});

test("fails closed when a relevant bridge has no catalog row at all", async () => {
  const environment = makeSource({ catalogs: [] });
  const port = await captureEnvironment(environment);
  const result = port.assess(expectedQuery(environment.value));
  assert.equal(result.status, "unavailable");
  assert.equal(port.compileCut(), undefined);
  assert.deepEqual(result.findings, [{
    kind: "stale_evidence",
    severity: "blocking",
    reason: "conflict_unavailable",
  }]);
});

test("changes the composed identity when the existing source identity changes with equal findings", async () => {
  const existing = new MutableExistingConflict(baseResult());
  const environment = makeSource({ existing });
  const first = (await captureEnvironment(environment)).assess(expectedQuery(environment.value));

  existing.result = {
    ...baseResult(),
    sourceIdentity: `sha256:${"d".repeat(64)}`,
  };
  const second = (await captureEnvironment(environment)).assess(expectedQuery(environment.value));

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
    () => environment.source.capture({ artifact: ref(environment.value), evidence: environment.evidence, extra: true } as never),
    (error: unknown) => error instanceof ArtifactCurrentConflictSourceError && error.code === "invalid_input",
  );

  const port = await captureEnvironment(environment);
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
