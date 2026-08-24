import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "@hob/bridge-contract";
import type {
  HomeWorldBridgeSnapshot,
  HomeWorldCapabilitySnapshot,
  HomeWorldDeviceSnapshot,
  HomeWorldDiagnostics,
  HomeWorldSnapshot,
  HomeWorldWatermark,
} from "../world/home-world-service.js";
import {
  checkCapabilityAction,
  checkCapabilityPredicate,
  resolveCapabilityRead,
} from "./capability-semantics.js";
import {
  ArtifactWorldCutSource,
  type ArtifactWorldCutCapabilityResolver,
} from "./artifact-world-cut-source.js";
import type { ArtifactRegistryEntry } from "./artifact-registry.js";
import {
  createArtifactAuthorityAssessment,
  createArtifactEvidenceAttestation,
  createArtifactRiskAssessment,
  type ArtifactAuthorityAssessment,
  type ArtifactEvidenceAttestation,
  type ArtifactRiskAssessment,
} from "./artifact-assessments.js";
import {
  deriveArtifactCapabilityScope,
  type NeutralWorldCut,
} from "./artifact-compiler-contract.js";
import {
  createArtifactRevision,
  type ArtifactRef,
  type ArtifactRevision,
} from "./neutral-artifact.js";

const capturedAt = "2026-08-20T04:00:00.000Z";

type AssessmentWatermark = ArtifactEvidenceAttestation["watermarks"][number];
type AuthorityCandidate = ArtifactAuthorityAssessment["candidates"][number];

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

function artifact(): ArtifactRevision {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: "artifact-world-cut-1",
    revision: 1,
    title: "Turn off the boolean capability",
    summary: "A bounded world-cut source fixture.",
    sourceProposal: { proposalId: "proposal-world-cut-1", proposalRevision: 1 },
    content: {
      trigger: { kind: "capability_changed", source: { hwCapabilityId: "hwc-trigger" } },
      conditions: [{
        kind: "capability_value",
        source: { hwCapabilityId: "hwc-trigger" },
        operator: "equals",
        value: "on",
      }],
      actions: [
        { kind: "notify_local", message: "Review the boolean capability." },
        { kind: "set_boolean", target: { hwCapabilityId: "hwc-target" }, value: false },
      ],
      rollback: { kind: "restore_previous_state", target: { hwCapabilityId: "hwc-target" }, maxAgeSeconds: 900 },
      postconditions: [{
        kind: "capability_value",
        source: { hwCapabilityId: "hwc-target" },
        operator: "equals",
        value: false,
        withinSeconds: 120,
      }],
    },
    createdAt: capturedAt,
  });
}

function coverArtifact(): ArtifactRevision {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: "artifact-world-cut-cover-1",
    revision: 1,
    title: "Set the cover level",
    summary: "A bounded HA cover world-cut fixture.",
    sourceProposal: { proposalId: "proposal-world-cut-cover-1", proposalRevision: 1 },
    content: {
      trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "09:00" },
      conditions: [],
      actions: [{ kind: "set_level", target: { hwCapabilityId: "hwc-target" }, value: 0.65 }],
      rollback: { kind: "restore_previous_state", target: { hwCapabilityId: "hwc-target" }, maxAgeSeconds: 900 },
      postconditions: [{
        kind: "capability_value",
        source: { hwCapabilityId: "hwc-target" },
        operator: "equals",
        value: 0.65,
        withinSeconds: 120,
      }],
    },
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

function watermark(overrides: Partial<HomeWorldWatermark> = {}): HomeWorldWatermark {
  return {
    bridgeId: "bridge-world-cut",
    epochId: "epoch-world-cut",
    lastSeq: 7,
    lastSyncCompleteAt: capturedAt,
    ...overrides,
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
      : [{ from: "epoch-old", to: "epoch-new", reason: "fixture-gap" }],
  };
}

function capability(
  hwCapabilityId: string,
  nativeInstanceId: string,
  schema: string,
  schemaVersion = "1.0.0",
  semanticKind: HomeWorldCapabilitySnapshot["semanticKind"] = "switch",
  bridgeId = "bridge-world-cut",
  nativeId = "native-device-world-cut",
  hwId = "hw-device-world-cut",
): HomeWorldCapabilitySnapshot {
  return {
    hwCapabilityId,
    hwId,
    schema,
    schemaVersion,
    ...(semanticKind === undefined ? {} : { semanticKind }),
    bindings: [{
      bridgeId,
      nativeId,
      nativeInstanceId,
    }],
  };
}

function device(
  capabilities: readonly HomeWorldCapabilitySnapshot[],
  states: HomeWorldDeviceSnapshot["states"],
  validity: HomeWorldDeviceSnapshot["validity"] = "valid",
  bridgeId = "bridge-world-cut",
  nativeId = "native-device-world-cut",
  hwId = "hw-device-world-cut",
): HomeWorldDeviceSnapshot {
  return {
    bridgeId,
    hwId,
    nativeId,
    bindings: capabilities.flatMap((item) => item.bindings),
    capabilities,
    descriptor: {
      nativeId,
      capabilities: capabilities.map((item) => ({
        nativeInstanceId: item.bindings[0]!.nativeInstanceId,
        schema: item.schema,
        schemaVersion: item.schemaVersion,
        ...(item.semanticKind === undefined ? {} : { semanticKind: item.semanticKind }),
      })),
    },
    states,
    validity,
  };
}

function state(
  nativeInstanceId: string,
  attrs: Record<string, JsonValue>,
  nativeId = "native-device-world-cut",
): HomeWorldDeviceSnapshot["states"][number] {
  return {
    nativeId,
    nativeInstanceId,
    attrs,
    time: { sourceTsQuality: "platform" },
    origin: "observed",
  };
}

function snapshot(
  options: {
    readonly targetState?: JsonValue;
    readonly targetSchema?: string;
    readonly triggerState?: JsonValue;
    readonly triggerSchema?: string;
    readonly targetValidity?: HomeWorldDeviceSnapshot["validity"];
    readonly bridgeWatermark?: HomeWorldWatermark | null;
    readonly connectionState?: HomeWorldDiagnostics["connectionState"];
    readonly historyGapCount?: number;
  } = {},
): HomeWorldSnapshot {
  const targetSchema = options.targetSchema ?? "miot.property";
  const target = capability("hwc-target", "native-target", targetSchema);
  const trigger = capability(
    "hwc-trigger",
    "native-trigger",
    options.triggerSchema ?? "ha.entity",
    "1.0.0",
    "sensor",
  );
  const states = [
    ...(options.targetState === undefined ? [] : [state("native-target", targetSchema === "ha.boolean-actuator"
      ? { state: options.targetState === true ? "on" : "off", value: options.targetState }
      : {
          value: options.targetState,
          format: "bool",
          unit: "none",
          writable: true,
        })]),
    ...(options.triggerState === undefined ? [] : [state("native-trigger", { state: options.triggerState })]),
  ];
  const item = device([target, trigger], states, options.targetValidity);
  const bridgeState = options.connectionState ?? "ready";
  const bridgeWatermark = options.bridgeWatermark === undefined
    ? watermark()
    : options.bridgeWatermark;
  const bridge: HomeWorldBridgeSnapshot = {
    bridgeId: "bridge-world-cut",
    adapterType: "fixture-adapter",
    diagnostics: diagnostics(bridgeState, options.historyGapCount ?? 0),
    watermark: bridgeWatermark,
    devices: [item],
    extensions: {},
    metrics: {
      consistency: bridgeState === "ready" ? "ready" : "degraded",
      eventActivity: "active",
      connection: bridgeState === "ready" ? "up" : "degraded",
    },
  };
  const watermarks = bridgeWatermark === null ? [] : [bridgeWatermark];
  return {
    generatedAt: capturedAt,
    bridges: { "bridge-world-cut": bridge },
    watermarkVector: { "bridge-world-cut": bridgeWatermark },
    bridgeWatermarks: watermarks,
    watermarks,
    diagnostics: [{
      bridgeId: "bridge-world-cut",
      ...bridge.diagnostics,
    }],
    metrics: {
      consistency: [{ bridgeId: "bridge-world-cut", state: bridgeState }],
      eventActivity: [{ bridgeId: "bridge-world-cut" }],
      connectionActivity: [{ bridgeId: "bridge-world-cut", state: bridgeState }],
    },
    spaces: [],
    devices: [item],
  };
}

function coverSnapshot(): HomeWorldSnapshot {
  const base = snapshot();
  const cover = capability(
    "hwc-target",
    "native-target",
    "ha.cover",
    "1.0.0",
    "cover",
  );
  const item = device([cover], [state("native-target", {
    state: "open",
    level: 0.37,
    setLevelSupported: true,
  })]);
  const bridge = base.bridges["bridge-world-cut"]!;
  return {
    ...base,
    bridges: {
      ...base.bridges,
      "bridge-world-cut": { ...bridge, devices: [item] },
    },
    devices: [item],
  };
}

function crossBridgeCollisionSnapshot(): HomeWorldSnapshot {
  const first = snapshot({ targetState: true, triggerState: "on" });
  const secondBridgeId = "bridge-world-cut-2";
  const secondWatermark = watermark({
    bridgeId: secondBridgeId,
    epochId: "epoch-world-cut-2",
    lastSeq: 8,
  });
  const secondTarget = capability(
    "hwc-target",
    "native-target",
    "miot.property",
    "1.0.0",
    "switch",
    secondBridgeId,
  );
  const secondDevice = device(
    [secondTarget],
    [state("native-target", {
      value: false,
      format: "bool",
      unit: "none",
      writable: true,
    })],
    "valid",
    secondBridgeId,
  );
  const firstBridge = first.bridges["bridge-world-cut"]!;
  const secondBridge: HomeWorldBridgeSnapshot = {
    ...firstBridge,
    bridgeId: secondBridgeId,
    watermark: secondWatermark,
    devices: [secondDevice],
  };
  const secondDiagnostics = { bridgeId: secondBridgeId, ...secondBridge.diagnostics };
  return {
    ...first,
    bridges: { ...first.bridges, [secondBridgeId]: secondBridge },
    watermarkVector: { ...first.watermarkVector, [secondBridgeId]: secondWatermark },
    bridgeWatermarks: [...first.bridgeWatermarks, secondWatermark],
    watermarks: [...first.watermarks, secondWatermark],
    diagnostics: [...first.diagnostics, secondDiagnostics],
    metrics: {
      consistency: [...first.metrics.consistency, { bridgeId: secondBridgeId, state: "ready" }],
      eventActivity: [...first.metrics.eventActivity, { bridgeId: secondBridgeId }],
      connectionActivity: [...first.metrics.connectionActivity, { bridgeId: secondBridgeId, state: "ready" }],
    },
    devices: [...first.devices, secondDevice],
  };
}

function assessments(value: ArtifactRevision, options: {
  readonly watermarks?: readonly AssessmentWatermark[];
  readonly authorityCandidates?: readonly AuthorityCandidate[];
  readonly authorityWatermarks?: readonly AssessmentWatermark[];
} = {}): {
  readonly evidence: ArtifactEvidenceAttestation;
  readonly authority: ArtifactAuthorityAssessment;
  readonly risk: ArtifactRiskAssessment;
} {
  const artifactRef = ref(value);
  const scope = deriveArtifactCapabilityScope(value.content);
  const watermarks = options.watermarks ?? [watermark({ freshness: "fresh", gapCount: 0 }) as AssessmentWatermark];
  const authorityWatermarks = options.authorityWatermarks ?? watermarks;
  const authorityCandidates = options.authorityCandidates ?? [{
    actionAuthorityCandidateId: "candidate-world-cut-1",
    hwCapabilityId: "hwc-target",
    status: "available",
  }];
  const evidence = createArtifactEvidenceAttestation({
    artifact: artifactRef,
    attestationId: "evidence-world-cut-1",
    source: "home-world-consistent-cut",
    sourceProposal: value.sourceProposal,
    proposalEvidenceIdentity: digest("e"),
    selectedHwCapabilityIds: scope,
    capturedAt,
    watermarks,
    coverage: "complete",
    reasons: [],
  });
  const authority = createArtifactAuthorityAssessment({
    artifact: artifactRef,
    assessmentId: "authority-world-cut-1",
    authorityRegistryIdentity: digest("a"),
    candidates: authorityCandidates,
    checkedWatermarks: authorityWatermarks,
    assessedAt: capturedAt,
  }, { hwCapabilityIds: ["hwc-target"] });
  const risk = createArtifactRiskAssessment({
    artifact: artifactRef,
    assessmentId: "risk-world-cut-1",
    evidence: { attestationId: evidence.attestationId, inputIdentity: evidence.inputIdentity },
    authority: { assessmentId: authority.assessmentId, inputIdentity: authority.inputIdentity },
    conflictInputIdentity: digest("c"),
    class: "comfort_reversible",
    reasons: ["Bounded fixture."],
    policyId: "policy-world-cut-1",
    policyVersion: "1.0.0",
    assessedAt: capturedAt,
  });
  return { evidence, authority, risk };
}

function makeEnvironment(options: {
  readonly artifact?: ArtifactRevision;
  readonly bound?: ReturnType<typeof assessments>;
  readonly snapshots?: readonly HomeWorldSnapshot[];
  readonly resolver?: ArtifactWorldCutCapabilityResolver;
} = {}) {
  const value = options.artifact ?? artifact();
  const bound = options.bound ?? assessments(value);
  const first = snapshot({ targetState: true, triggerState: "on" });
  const snapshots = options.snapshots ?? [first, first];
  const resolverCalls = { reads: [] as unknown[], predicates: [] as unknown[], actions: [] as unknown[] };
  const baseResolver = options.resolver ?? {
    resolveRead: resolveCapabilityRead,
    checkPredicate: checkCapabilityPredicate,
    checkAction: checkCapabilityAction,
  };
  const resolver: ArtifactWorldCutCapabilityResolver = {
    resolveRead(input) {
      resolverCalls.reads.push(input);
      return baseResolver.resolveRead(input);
    },
    checkPredicate(input) {
      resolverCalls.predicates.push(input);
      return baseResolver.checkPredicate(input);
    },
    checkAction(input) {
      resolverCalls.actions.push(input);
      return baseResolver.checkAction(input);
    },
  };
  let snapshotIndex = 0;
  let snapshotCalls = 0;
  const homeWorld = {
    snapshot(): HomeWorldSnapshot {
      snapshotCalls += 1;
      return snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]!;
    },
  };
  const entry: ArtifactRegistryEntry = {
    artifact: value,
    status: "draft",
    tombstone: false,
    audit: [],
  };
  const artifacts = {
    getRevision(artifactId: string, revision: number): ArtifactRegistryEntry | undefined {
      return artifactId === value.artifactId && revision === value.revision ? entry : undefined;
    },
  };
  const source = new ArtifactWorldCutSource({ artifacts, homeWorld, resolver });
  return { value, bound, homeWorld, resolverCalls, source, get snapshotCalls() { return snapshotCalls; } };
}

function read(source: ArtifactWorldCutSource, value: ArtifactRevision, bound: ReturnType<typeof assessments>): NeutralWorldCut {
  return source.read({
    artifact: ref(value),
    evidence: bound.evidence,
    risk: bound.risk,
    authority: bound.authority,
  });
}

test("projects a complete scope through read/predicate/action resolvers into a frozen neutral cut", () => {
  const environment = makeEnvironment();
  const cut = read(environment.source, environment.value, environment.bound);

  assert.deepEqual(cut.devices.map((device) => device.hwCapabilityId), ["hwc-target", "hwc-trigger"]);
  assert.deepEqual(cut.watermarks, [environment.bound.evidence.watermarks[0]]);
  assert.deepEqual(cut.devices.find((device) => device.hwCapabilityId === "hwc-target")?.read, {
    status: "available",
    value: true,
  });
  assert.deepEqual(cut.devices.find((device) => device.hwCapabilityId === "hwc-trigger")?.read, {
    status: "available",
    value: "on",
  });
  assert.deepEqual(cut.devices.find((device) => device.hwCapabilityId === "hwc-target")?.actionCompatibility, [{
    order: 2,
    kind: "set_boolean",
    status: "compatible",
    before: true,
    after: false,
  }]);
  assert.deepEqual(cut.devices.find((device) => device.hwCapabilityId === "hwc-target")?.predicateCompatibility, [{
    phase: "postcondition",
    order: 1,
    status: "compatible",
  }]);
  assert.deepEqual(cut.devices.find((device) => device.hwCapabilityId === "hwc-trigger")?.predicateCompatibility, [{
    phase: "condition",
    order: 1,
    status: "compatible",
  }]);
  assert.equal(environment.resolverCalls.reads.length, 4);
  assert.equal(environment.resolverCalls.predicates.length, 4);
  assert.equal(environment.resolverCalls.actions.length, 2);
  assert.equal(environment.snapshotCalls, 2);
  assert.equal(Object.isFrozen(cut), true);
  assert.equal(Object.isFrozen(cut.devices), true);
  assert.equal(Object.isFrozen(cut.watermarks), true);
  assert.equal(Object.isFrozen(cut.devices[0]!), true);
  assert.equal(Object.isFrozen(cut.devices[0]!.actionCompatibility), true);
  assert.equal(Object.isFrozen(cut.devices[0]!.predicateCompatibility), true);
  assert.equal(JSON.stringify(cut).includes("attrs"), false);
  assert.equal(JSON.stringify(cut).includes("native"), false);
});

test("keeps resolver compatibility independent from authority candidate availability", () => {
  const available = makeEnvironment();
  const availableCut = read(available.source, available.value, available.bound);

  const unavailable = makeEnvironment();
  const unavailableBound = assessments(unavailable.value, {
    authorityCandidates: [{
      actionAuthorityCandidateId: "candidate-world-cut-unavailable",
      hwCapabilityId: "hwc-target",
      status: "unavailable",
    }],
  });
  const unavailableCut = read(unavailable.source, unavailable.value, unavailableBound);

  const empty = makeEnvironment();
  const emptyBound = assessments(empty.value, { authorityCandidates: [] });
  const emptyCut = read(empty.source, empty.value, emptyBound);

  const expected = availableCut.devices.find((device) => device.hwCapabilityId === "hwc-target")?.actionCompatibility;
  assert.deepEqual(unavailableCut.devices.find((device) => device.hwCapabilityId === "hwc-target")?.actionCompatibility, expected);
  assert.deepEqual(emptyCut.devices.find((device) => device.hwCapabilityId === "hwc-target")?.actionCompatibility, expected);
  assert.equal(unavailableCut.cutIdentity, availableCut.cutIdentity);
  assert.equal(emptyCut.cutIdentity, availableCut.cutIdentity);
});

test("projects the exact HA boolean-actuator schema into a compatible neutral set_boolean action", () => {
  const value = artifact();
  const bound = assessments(value);
  const booleanSnapshot = snapshot({
    targetSchema: "ha.boolean-actuator",
    targetState: true,
    triggerState: "on",
  });
  const environment = makeEnvironment({
    artifact: value,
    bound,
    snapshots: [booleanSnapshot, booleanSnapshot],
  });

  const cut = read(environment.source, value, bound);
  const target = cut.devices.find((item) => item.hwCapabilityId === "hwc-target");
  assert.equal(target?.schema, "ha.boolean-actuator");
  assert.deepEqual(target?.read, { status: "available", value: true });
  assert.deepEqual(target?.actionCompatibility, [{
    order: 2,
    kind: "set_boolean",
    status: "compatible",
    before: true,
    after: false,
  }]);
  assert.deepEqual(target?.predicateCompatibility, [{
    phase: "postcondition",
    order: 1,
    status: "compatible",
  }]);
});

test("projects an exact HA cover snapshot into a compatible neutral set_level action", () => {
  const value = coverArtifact();
  const bound = assessments(value);
  const environment = makeEnvironment({
    artifact: value,
    bound,
    snapshots: [coverSnapshot(), coverSnapshot()],
  });

  const cut = read(environment.source, value, bound);
  const cover = cut.devices.find((item) => item.hwCapabilityId === "hwc-target");

  assert.deepEqual(cover, {
    hwCapabilityId: "hwc-target",
    schema: "ha.cover",
    schemaVersion: "1.0.0",
    semanticKind: "cover",
    read: { status: "available", value: 0.37 },
    validity: "valid",
    actionCompatibility: [{
      order: 1,
      kind: "set_level",
      status: "compatible",
      before: 0.37,
      after: 0.65,
    }],
    predicateCompatibility: [{
      phase: "postcondition",
      order: 1,
      status: "compatible",
    }],
  });
  assert.equal(environment.resolverCalls.actions.length, 2);
  assert.deepEqual((environment.resolverCalls.actions[0] as { state?: unknown }).state, {
    attrs: { state: "open", level: 0.37, setLevelSupported: true },
    validity: "valid",
    freshness: "fresh",
  });
});

test("rejects a snapshot change instead of returning a mixed world cut", () => {
  const value = artifact();
  const bound = assessments(value);
  const environment = makeEnvironment({
    snapshots: [
      snapshot({ targetState: true, triggerState: "on" }),
      snapshot({ targetState: false, triggerState: "on" }),
    ],
  });

  assert.throws(
    () => read(environment.source, value, bound),
    /inconsistent|stable|world[- ]cut/i,
  );
});

test("treats lastSyncCompleteAt as capture metadata rather than world-cut identity", () => {
  const value = artifact();
  const bound = assessments(value);
  const environment = makeEnvironment({
    snapshots: [
      snapshot({ bridgeWatermark: watermark({ lastSyncCompleteAt: capturedAt }) }),
      snapshot({ bridgeWatermark: watermark({ lastSyncCompleteAt: "2026-08-20T05:00:00.000Z" }) }),
    ],
  });

  const cut = read(environment.source, value, bound);
  assert.equal(cut.watermarks[0]?.lastSyncCompleteAt, bound.evidence.watermarks[0]?.lastSyncCompleteAt);
});

test("includes the neutral read projection in world-cut identity", () => {
  const first = makeEnvironment({
    snapshots: [
      snapshot({ targetState: true, triggerState: "on" }),
      snapshot({ targetState: true, triggerState: "on" }),
    ],
  });
  const second = makeEnvironment({
    snapshots: [
      snapshot({ targetState: true, triggerState: "off" }),
      snapshot({ targetState: true, triggerState: "off" }),
    ],
  });

  const firstCut = read(first.source, first.value, first.bound);
  const secondCut = read(second.source, second.value, second.bound);
  assert.deepEqual(firstCut.devices.find((device) => device.hwCapabilityId === "hwc-trigger")?.read, {
    status: "available",
    value: "on",
  });
  assert.deepEqual(secondCut.devices.find((device) => device.hwCapabilityId === "hwc-trigger")?.read, {
    status: "available",
    value: "off",
  });
  assert.notEqual(firstCut.cutIdentity, secondCut.cutIdentity);
});

test("projects an unknown capability schema as an explicit unsupported read", () => {
  const environment = makeEnvironment({
    snapshots: [
      snapshot({ targetState: true, triggerState: "on", triggerSchema: "unknown.schema" }),
      snapshot({ targetState: true, triggerState: "on", triggerSchema: "unknown.schema" }),
    ],
  });

  const cut = read(environment.source, environment.value, environment.bound);
  assert.deepEqual(cut.devices.find((device) => device.hwCapabilityId === "hwc-trigger")?.read, {
    status: "unsupported",
    reason: "schema_unsupported",
  });
});

test("fails closed when one capability has colliding native routes across bridges", () => {
  const environment = makeEnvironment({
    snapshots: [crossBridgeCollisionSnapshot(), crossBridgeCollisionSnapshot()],
  });
  const bound = assessments(environment.value, {
    watermarks: [
      watermark({ freshness: "fresh", gapCount: 0 }),
      watermark({
        bridgeId: "bridge-world-cut-2",
        epochId: "epoch-world-cut-2",
        lastSeq: 8,
        freshness: "fresh",
        gapCount: 0,
      }),
    ],
  });

  assert.throws(
    () => read(environment.source, environment.value, bound),
    /ambiguous|unavailable/i,
  );
});

test("fails closed for exact watermark drift and assessment cross-binding", () => {
  const value = artifact();
  const bound = assessments(value);
  const changed = makeEnvironment({
    snapshots: [
      snapshot({ targetState: true, triggerState: "on" }),
      snapshot({ targetState: true, triggerState: "on", bridgeWatermark: watermark({ lastSeq: 8 }) }),
    ],
  });
  assert.throws(() => read(changed.source, value, bound), /inconsistent|watermark/i);

  const missing = makeEnvironment({
    snapshots: [snapshot({ targetState: true }), snapshot({ targetState: true })],
  });
  const missingBound = assessments(value);
  const missingCut = read(missing.source, value, missingBound);
  assert.deepEqual(missingCut.devices.find((device) => device.hwCapabilityId === "hwc-trigger")?.read, {
    status: "unavailable",
    reason: "state_missing",
  });
  assert.deepEqual(missingCut.devices.find((device) => device.hwCapabilityId === "hwc-trigger")?.predicateCompatibility, [{
    phase: "condition",
    order: 1,
    status: "unavailable",
    reason: "state_missing",
  }]);

  const mismatch = makeEnvironment();
  const wrongRisk = { ...bound.risk, evidence: { attestationId: "other", inputIdentity: digest("x") } } as ArtifactRiskAssessment;
  assert.throws(() => mismatch.source.read({
    artifact: ref(value),
    evidence: bound.evidence,
    risk: wrongRisk,
    authority: bound.authority,
  }), /assessment|binding|mismatch/i);
});

test("does not invent before/after for stale or invalid state", () => {
  const value = artifact();
  const bound = assessments(value);
  const environment = makeEnvironment({
    snapshots: [
      snapshot({ targetState: true, triggerState: "on", connectionState: "degraded" }),
      snapshot({ targetState: true, triggerState: "on", connectionState: "degraded" }),
    ],
  });
  assert.throws(() => read(environment.source, value, bound), /stale|unavailable|watermark/i);

  const staleState = makeEnvironment({
    snapshots: [
      snapshot({ targetState: true, triggerState: "on", targetValidity: "stale" }),
      snapshot({ targetState: true, triggerState: "on", targetValidity: "stale" }),
    ],
  });
  const staleCut = read(staleState.source, value, bound);
  assert.deepEqual(staleCut.devices.find((device) => device.hwCapabilityId === "hwc-target")?.actionCompatibility, [{
    order: 2,
    kind: "set_boolean",
    status: "unavailable",
    reason: "state_stale",
  }]);
});

test("never exposes a control or credential seam", () => {
  const environment = makeEnvironment();
  const world = environment.homeWorld as unknown as Record<string, unknown>;
  assert.equal("control" in world, false);
  assert.equal("credential" in world, false);
  assert.equal("execute" in world, false);
});
