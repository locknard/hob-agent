import {
  type CapabilityActionInput,
  type CapabilityActionResult,
  type CapabilityPredicateInput,
  type CapabilityPredicateResult,
  type CapabilityReadResult,
  type CapabilitySemanticsState,
  resolveCapabilityRead,
} from "./capability-semantics.js";
import {
  parseArtifactAuthorityAssessment,
  parseArtifactEvidenceAttestation,
  parseArtifactRiskAssessment,
  type ArtifactAuthorityAssessment,
  type ArtifactEvidenceAttestation,
  type ArtifactRiskAssessment,
} from "./artifact-assessments.js";
import type { ArtifactRegistryEntry } from "./artifact-registry.js";
import type {
  HomeWorldCapabilitySnapshot,
  HomeWorldDeviceSnapshot,
  HomeWorldSnapshot,
  HomeWorldWatermark,
} from "../world/home-world-service.js";
import {
  closedReasonCodeSchema,
  createNeutralWorldCut,
  deriveArtifactCapabilityScope,
  neutralScalarSchema,
  type ClosedReasonCode,
  type NeutralDeviceSummary,
  type NeutralWatermark,
  type NeutralWorldCut,
} from "./artifact-compiler-contract.js";
import {
  artifactRefSchema,
  parseArtifactRevision,
  type ArtifactAction,
  type ArtifactContent,
  type ArtifactRef,
  type ArtifactRevision,
} from "./neutral-artifact.js";

const MAX_CAPABILITY_IDS = 16;
const MAX_BINDINGS = 16;

/** The resolver seam is pure and has no authority, route, or control surface. */
export interface ArtifactWorldCutCapabilityResolver {
  readonly resolveRead: (input: Parameters<typeof resolveCapabilityRead>[0]) => CapabilityReadResult;
  readonly checkPredicate: (input: CapabilityPredicateInput) => CapabilityPredicateResult;
  readonly checkAction: (input: CapabilityActionInput) => CapabilityActionResult;
}

export interface ArtifactWorldCutRegistry {
  readonly getRevision: (artifactId: string, revision: number) => ArtifactRegistryEntry | undefined;
}

export interface ArtifactWorldCutHomeWorldPort {
  readonly snapshot: () => HomeWorldSnapshot;
}

export interface ArtifactWorldCutSourceOptions {
  readonly artifacts: ArtifactWorldCutRegistry;
  readonly homeWorld: ArtifactWorldCutHomeWorldPort;
  readonly resolver: ArtifactWorldCutCapabilityResolver;
}

export interface ArtifactWorldCutInput {
  readonly artifact: ArtifactRef;
  readonly evidence: ArtifactEvidenceAttestation;
  readonly risk: ArtifactRiskAssessment;
  readonly authority: ArtifactAuthorityAssessment;
}

export type ArtifactWorldCutSourceErrorCode =
  | "invalid_input"
  | "not_found"
  | "assessment_mismatch"
  | "unavailable"
  | "inconsistent_cut"
  | "invalid_source";

export class ArtifactWorldCutSourceError extends Error {
  constructor(
    readonly code: ArtifactWorldCutSourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactWorldCutSourceError";
  }
}

interface NormalizedCapability {
  readonly capability: HomeWorldCapabilitySnapshot;
  readonly devices: readonly HomeWorldDeviceSnapshot[];
  readonly bindings: readonly HomeWorldBinding[];
  readonly validity: NeutralDeviceSummary["validity"];
  readonly state?: StateSelection;
}

interface HomeWorldBinding {
  readonly bridgeId: string;
  readonly nativeId: string;
  readonly nativeInstanceId: string;
}

interface StateSelection {
  readonly attrs: CapabilitySemanticsState["attrs"];
  readonly bridgeIds: readonly string[];
}

interface CollectedCut {
  readonly cut: NeutralWorldCut;
}

/**
 * Unmounted Hub-private producer for the exact neutral compiler world cut.
 * The only HomeWorld operation is a read-only snapshot; no bridge, control,
 * credential, route, or execution dependency crosses this seam.
 */
export class ArtifactWorldCutSource {
  private readonly artifacts: ArtifactWorldCutRegistry;
  private readonly homeWorld: ArtifactWorldCutHomeWorldPort;
  private readonly resolver: ArtifactWorldCutCapabilityResolver;

  constructor(options: ArtifactWorldCutSourceOptions) {
    if (!isPlainObject(options) || !hasExactKeys(options, ["artifacts", "homeWorld", "resolver"])) {
      throw new ArtifactWorldCutSourceError("invalid_input", "World-cut source options are invalid");
    }
    if (!isPlainObject(options.artifacts) || typeof options.artifacts.getRevision !== "function") {
      throw new ArtifactWorldCutSourceError("invalid_input", "Artifact Registry read seam is required");
    }
    if (!isPlainObject(options.homeWorld) || typeof options.homeWorld.snapshot !== "function") {
      throw new ArtifactWorldCutSourceError("invalid_input", "HomeWorld snapshot seam is required");
    }
    if (!isPlainObject(options.resolver)
      || typeof options.resolver.resolveRead !== "function"
      || typeof options.resolver.checkPredicate !== "function"
      || typeof options.resolver.checkAction !== "function") {
      throw new ArtifactWorldCutSourceError("invalid_input", "Capability semantics resolver is required");
    }
    this.artifacts = options.artifacts;
    this.homeWorld = options.homeWorld;
    this.resolver = options.resolver;
  }

  read(input: ArtifactWorldCutInput): NeutralWorldCut {
    const requested = normalizeInput(input);
    const artifact = this.readExactDraft(requested.artifact);
    const scope = validateAssessmentBindings(artifact, requested);

    const first = this.collectSnapshot(artifact.content, scope, requested);
    let secondSnapshot: HomeWorldSnapshot;
    try {
      secondSnapshot = this.homeWorld.snapshot();
    } catch {
      throw new ArtifactWorldCutSourceError("inconsistent_cut", "HomeWorld changed during inconsistent world-cut capture");
    }
    const second = this.collectSnapshot(artifact.content, scope, requested, secondSnapshot);
    if (first.cut.cutIdentity !== second.cut.cutIdentity) {
      throw new ArtifactWorldCutSourceError("inconsistent_cut", "HomeWorld changed during inconsistent world-cut capture");
    }
    return first.cut;
  }

  private readExactDraft(ref: ArtifactRef): ArtifactRevision {
    let entry: ArtifactRegistryEntry | undefined;
    try {
      entry = this.artifacts.getRevision(ref.artifactId, ref.revision);
    } catch {
      throw new ArtifactWorldCutSourceError("not_found", "Artifact revision is unavailable");
    }
    if (!isRegistryEntry(entry)
      || entry.status !== "draft"
      || entry.tombstone
      || !sameArtifactRef(entry.artifact, ref)) {
      throw new ArtifactWorldCutSourceError("not_found", "Artifact revision is unavailable");
    }
    try {
      return parseArtifactRevision(entry.artifact);
    } catch {
      throw new ArtifactWorldCutSourceError("not_found", "Artifact revision is unavailable");
    }
  }

  private collectSnapshot(
    content: ArtifactContent,
    scope: readonly string[],
    input: NormalizedInput,
    suppliedSnapshot?: HomeWorldSnapshot,
  ): CollectedCut {
    let snapshot: HomeWorldSnapshot;
    if (suppliedSnapshot !== undefined) {
      snapshot = suppliedSnapshot;
    } else {
      try {
        snapshot = this.homeWorld.snapshot();
      } catch {
        throw new ArtifactWorldCutSourceError("unavailable", "HomeWorld snapshot is unavailable");
      }
    }
    const watermarks = collectWatermarks(snapshot, input.evidence);
    const capabilities = scope.map((hwCapabilityId) => normalizeCapability(snapshot, hwCapabilityId, watermarks));
    const predicates = collectPredicates(content, capabilities, this.resolver);
    const devices = capabilities.map((item) => projectDevice(item, content, predicates, this.resolver));
    try {
      return {
        cut: createNeutralWorldCut({
          devices: [...devices],
          watermarks: [...watermarks],
        }),
      };
    } catch {
      throw new ArtifactWorldCutSourceError("invalid_source", "Neutral world-cut projection is invalid");
    }
  }
}

interface NormalizedInput {
  readonly artifact: ArtifactRef;
  readonly evidence: ArtifactEvidenceAttestation;
  readonly risk: ArtifactRiskAssessment;
  readonly authority: ArtifactAuthorityAssessment;
}

function normalizeInput(value: unknown): NormalizedInput {
  if (!isPlainObject(value) || !hasExactKeys(value, ["artifact", "evidence", "risk", "authority"])) {
    throw new ArtifactWorldCutSourceError("invalid_input", "World-cut input is invalid");
  }
  const artifact = parseRef(value.artifact);
  let evidence: ArtifactEvidenceAttestation;
  let risk: ArtifactRiskAssessment;
  let authority: ArtifactAuthorityAssessment;
  try {
    evidence = parseArtifactEvidenceAttestation(value.evidence);
    risk = parseArtifactRiskAssessment(value.risk);
    authority = parseArtifactAuthorityAssessment(value.authority);
  } catch {
    throw new ArtifactWorldCutSourceError("invalid_input", "World-cut assessment is invalid");
  }
  return Object.freeze({ artifact, evidence, risk, authority });
}

function validateAssessmentBindings(
  artifact: ArtifactRevision,
  input: NormalizedInput,
): readonly string[] {
  const expected = artifactRef(artifact);
  if (!sameArtifactRef(input.evidence.artifact, expected)
    || !sameArtifactRef(input.risk.artifact, expected)
    || !sameArtifactRef(input.authority.artifact, expected)) {
    throw new ArtifactWorldCutSourceError("assessment_mismatch", "Assessment is bound to another artifact");
  }
  if (input.evidence.sourceProposal.proposalId !== artifact.sourceProposal.proposalId
    || input.evidence.sourceProposal.proposalRevision !== artifact.sourceProposal.proposalRevision) {
    throw new ArtifactWorldCutSourceError("assessment_mismatch", "Evidence proposal is bound to another artifact");
  }
  if (input.risk.evidence.attestationId !== input.evidence.attestationId
    || input.risk.evidence.inputIdentity !== input.evidence.inputIdentity
    || input.risk.authority.assessmentId !== input.authority.assessmentId
    || input.risk.authority.inputIdentity !== input.authority.inputIdentity) {
    throw new ArtifactWorldCutSourceError("assessment_mismatch", "Risk assessment dependencies are stale");
  }
  if (input.evidence.coverage !== "complete"
    || input.evidence.watermarks.some((watermark) => watermark.freshness !== "fresh" || watermark.gapCount !== 0)) {
    throw new ArtifactWorldCutSourceError("unavailable", "Evidence cut is not fresh and complete");
  }
  if (input.authority.checkedWatermarks.some((watermark) => watermark.freshness !== "fresh" || watermark.gapCount !== 0)) {
    throw new ArtifactWorldCutSourceError("unavailable", "Authority cut is not fresh and complete");
  }
  if (!sameAssessmentWatermarks(input.evidence.watermarks, input.authority.checkedWatermarks)) {
    throw new ArtifactWorldCutSourceError("assessment_mismatch", "Authority watermark assessment is not bound to evidence");
  }
  const scope = deriveArtifactCapabilityScope(artifact.content);
  if (scope.length > MAX_CAPABILITY_IDS || !sameStringArray(input.evidence.selectedHwCapabilityIds, scope)) {
    throw new ArtifactWorldCutSourceError("assessment_mismatch", "Evidence scope does not match the artifact scope");
  }
  const actionTargets = new Set(artifact.content.actions.flatMap((action) => (
    action.kind === "notify_local" ? [] : [action.target.hwCapabilityId]
  )));
  // Authority availability is a later compiler concern. This source only
  // prevents an assessment from naming duplicate or unrelated candidates.
  const authorityTargets = new Set(input.authority.candidates.map((candidate) => candidate.hwCapabilityId));
  if (authorityTargets.size !== input.authority.candidates.length
    || [...authorityTargets].some((target) => !actionTargets.has(target))) {
    throw new ArtifactWorldCutSourceError("assessment_mismatch", "Authority scope contains duplicate or out-of-scope candidates");
  }
  return scope;
}

function collectWatermarks(
  snapshot: HomeWorldSnapshot,
  evidence: ArtifactEvidenceAttestation,
): readonly NeutralWatermark[] {
  if (!isPlainObject(snapshot) || !isPlainObject(snapshot.bridges)
    || !isPlainObject(snapshot.watermarkVector)
    || !Array.isArray(snapshot.bridgeWatermarks)
    || !Array.isArray(snapshot.watermarks)) {
    throw new ArtifactWorldCutSourceError("invalid_source", "HomeWorld snapshot is invalid");
  }
  const expected = new Map(evidence.watermarks.map((watermark) => [watermark.bridgeId, watermark]));
  if (expected.size !== evidence.watermarks.length || expected.size > 16) {
    throw new ArtifactWorldCutSourceError("invalid_source", "Evidence watermarks are invalid");
  }
  const result: NeutralWatermark[] = [];
  for (const [bridgeId, expectedWatermark] of expected) {
    const bridge = snapshot.bridges[bridgeId];
    if (!isPlainObject(bridge) || bridge.bridgeId !== bridgeId || !isPlainObject(bridge.diagnostics)
      || !isPlainObject(bridge.metrics) || bridge.watermark === null || bridge.watermark === undefined) {
      throw new ArtifactWorldCutSourceError("unavailable", "Evidence watermark is unavailable");
    }
    const actual = normalizeHomeWatermark(bridge.watermark, bridgeId);
    const vector = snapshot.watermarkVector[bridgeId];
    if (!sameHomeWatermark(vector, actual)) {
      throw new ArtifactWorldCutSourceError("invalid_source", "HomeWorld watermark projection is inconsistent");
    }
    const listed = snapshot.bridgeWatermarks.filter((candidate) => isPlainObject(candidate) && candidate.bridgeId === bridgeId);
    if (listed.length !== 1 || !sameHomeWatermark(listed[0], actual)) {
      throw new ArtifactWorldCutSourceError("invalid_source", "HomeWorld watermark vector is inconsistent");
    }
    const aliasListed = snapshot.watermarks.filter((candidate) => isPlainObject(candidate) && candidate.bridgeId === bridgeId);
    if (aliasListed.length !== 1 || !sameHomeWatermark(aliasListed[0], actual)) {
      throw new ArtifactWorldCutSourceError("invalid_source", "HomeWorld watermark aliases are inconsistent");
    }
    const diagnostics = bridge.diagnostics;
    const fresh = diagnostics.connectionState === "ready"
      && bridge.metrics.consistency === "ready"
      && bridge.metrics.connection === "up"
      && diagnostics.historyGapCount === 0
      && Array.isArray(diagnostics.recentHistoryGaps)
      && diagnostics.recentHistoryGaps.length === 0;
    if (!fresh || expectedWatermark.freshness !== "fresh" || expectedWatermark.gapCount !== 0) {
      throw new ArtifactWorldCutSourceError("unavailable", "Evidence watermark is stale");
    }
    // lastSyncCompleteAt is capture metadata, not the semantic cut fence.
    // Preserve the evidence value so repeated captures have stable output.
    if (actual.epochId !== expectedWatermark.epochId || actual.lastSeq !== expectedWatermark.lastSeq) {
      throw new ArtifactWorldCutSourceError("inconsistent_cut", "HomeWorld watermark changed during world-cut capture");
    }
    result.push({
      bridgeId: expectedWatermark.bridgeId,
      epochId: expectedWatermark.epochId,
      lastSeq: expectedWatermark.lastSeq,
      ...(expectedWatermark.lastSyncCompleteAt === undefined ? {} : { lastSyncCompleteAt: expectedWatermark.lastSyncCompleteAt }),
      freshness: "fresh",
      gapCount: 0,
    });
  }
  return result.sort((left, right) => compareCodePoints(left.bridgeId, right.bridgeId));
}

function normalizeCapability(
  snapshot: HomeWorldSnapshot,
  hwCapabilityId: string,
  watermarks: readonly NeutralWatermark[],
): NormalizedCapability {
  if (!Array.isArray(snapshot.devices)) {
    throw new ArtifactWorldCutSourceError("invalid_source", "HomeWorld device projection is invalid");
  }
  const matches: Array<{ readonly capability: HomeWorldCapabilitySnapshot; readonly device: HomeWorldDeviceSnapshot }> = [];
  for (const device of snapshot.devices) {
    if (!isHomeWorldDeviceSnapshot(device)) {
      throw new ArtifactWorldCutSourceError("invalid_source", "HomeWorld device projection is invalid");
    }
    const deviceBindings = uniqueBindings(device.bindings);
    const deviceBindingKeys = new Set(deviceBindings.map(bindingKey));
    for (const capability of device.capabilities) {
      if (!isCapabilitySnapshot(capability)) {
        throw new ArtifactWorldCutSourceError("invalid_source", "HomeWorld capability projection is invalid");
      }
      if (capability.hwCapabilityId !== hwCapabilityId) continue;
      if (capability.hwId !== device.hwId) {
        throw new ArtifactWorldCutSourceError("invalid_source", "HomeWorld capability identity is inconsistent");
      }
      if (capability.bindings.some((binding) => !deviceBindingKeys.has(bindingKey(binding)))) {
        throw new ArtifactWorldCutSourceError("invalid_source", "HomeWorld capability binding is inconsistent");
      }
      matches.push({ capability, device });
    }
  }
  if (matches.length === 0) throw new ArtifactWorldCutSourceError("unavailable", "Artifact capability is unavailable");
  const first = matches[0]!;
  for (const match of matches.slice(1)) {
    if (match.capability.hwId !== first.capability.hwId
      || match.capability.schema !== first.capability.schema
      || match.capability.schemaVersion !== first.capability.schemaVersion
      || match.capability.semanticKind !== first.capability.semanticKind) {
      throw new ArtifactWorldCutSourceError("unavailable", "Artifact capability identity is ambiguous");
    }
  }
  const bindings = uniqueBindings(matches.flatMap((match) => match.capability.bindings));
  if (bindings.length === 0 || bindings.length > MAX_BINDINGS) {
    throw new ArtifactWorldCutSourceError("unavailable", "Artifact capability binding is unavailable");
  }
  const watermarkIds = new Set(watermarks.map((watermark) => watermark.bridgeId));
  if (bindings.some((binding) => !watermarkIds.has(binding.bridgeId))) {
    throw new ArtifactWorldCutSourceError("unavailable", "Artifact capability watermark is unavailable");
  }
  const state = selectState(matches, bindings);
  const invalidDevice = matches.some((match) => match.device.validity !== "valid");
  return {
    capability: first.capability,
    devices: matches.map((match) => match.device),
    bindings,
    validity: invalidDevice ? matches.find((match) => match.device.validity !== "valid")!.device.validity : "valid",
    ...(state === undefined ? {} : { state }),
  };
}

function selectState(
  matches: readonly { readonly capability: HomeWorldCapabilitySnapshot; readonly device: HomeWorldDeviceSnapshot }[],
  bindings: readonly HomeWorldBinding[],
): StateSelection | undefined {
  const bindingKeys = new Set(bindings.map(bindingKey));
  const states: StateSelection[] = [];
  for (const match of matches) {
    for (const state of match.device.states) {
      const stateBinding: HomeWorldBinding = {
        bridgeId: match.device.bridgeId,
        nativeId: state.nativeId,
        nativeInstanceId: state.nativeInstanceId,
      };
      if (!bindingKeys.has(bindingKey(stateBinding))) continue;
      if (!isPlainObject(state.attrs)) throw new ArtifactWorldCutSourceError("invalid_source", "HomeWorld state projection is invalid");
      states.push({ attrs: state.attrs, bridgeIds: [match.device.bridgeId] });
    }
  }
  if (states.length === 0) return undefined;
  if (states.length !== 1) throw new ArtifactWorldCutSourceError("unavailable", "Artifact capability state is ambiguous");
  return states[0];
}

interface PredicateProjection {
  readonly phase: "condition" | "postcondition";
  readonly order: number;
  readonly status: "compatible" | "incompatible" | "unavailable";
  readonly reason?: ClosedReasonCode;
}

function collectPredicates(
  content: ArtifactContent,
  capabilities: readonly NormalizedCapability[],
  resolver: ArtifactWorldCutCapabilityResolver,
): ReadonlyMap<string, readonly PredicateProjection[]> {
  const byId = new Map(capabilities.map((item) => [item.capability.hwCapabilityId, item]));
  const output = new Map<string, PredicateProjection[]>();
  const phases: readonly ["condition" | "postcondition", ArtifactContent["conditions"] | ArtifactContent["postconditions"]][] = [
    ["condition", content.conditions],
    ["postcondition", content.postconditions],
  ];
  for (const [phase, predicates] of phases) {
    predicates.forEach((predicate, index) => {
      const capability = byId.get(predicate.source.hwCapabilityId);
      if (capability === undefined) throw new ArtifactWorldCutSourceError("unavailable", "Predicate capability is unavailable");
      const result = callPredicate(resolver, capability, predicate);
      const projection: PredicateProjection = {
        phase,
        order: index + 1,
        status: result.status,
        ...(result.status === "compatible" ? {} : { reason: mapReason(result.reason) }),
      };
      const existing = output.get(predicate.source.hwCapabilityId) ?? [];
      existing.push(projection);
      output.set(predicate.source.hwCapabilityId, existing);
    });
  }
  return output;
}

function callPredicate(
  resolver: ArtifactWorldCutCapabilityResolver,
  capability: NormalizedCapability,
  predicate: ArtifactContent["conditions"][number] | ArtifactContent["postconditions"][number],
): CapabilityPredicateResult {
  const input = {
    capability: {
      schema: capability.capability.schema,
      schemaVersion: capability.capability.schemaVersion,
    },
    ...(capability.state === undefined ? {} : { state: capabilityState(capability) }),
    operator: predicate.operator,
    value: predicate.value,
  } satisfies CapabilityPredicateInput;
  let result: CapabilityPredicateResult;
  try {
    result = resolver.checkPredicate(input);
  } catch {
    throw new ArtifactWorldCutSourceError("invalid_source", "Capability predicate resolver failed");
  }
  validatePredicateResult(result);
  return result;
}

function projectDevice(
  capability: NormalizedCapability,
  content: ArtifactContent,
  predicates: ReadonlyMap<string, readonly PredicateProjection[]>,
  resolver: ArtifactWorldCutCapabilityResolver,
): NeutralDeviceSummary {
  const readInput = {
    capability: {
      schema: capability.capability.schema,
      schemaVersion: capability.capability.schemaVersion,
    },
    ...(capability.state === undefined ? {} : { state: capabilityState(capability) }),
  } satisfies Parameters<typeof resolveCapabilityRead>[0];
  let read: CapabilityReadResult;
  try {
    read = resolver.resolveRead(readInput);
  } catch {
    throw new ArtifactWorldCutSourceError("invalid_source", "Capability read resolver failed");
  }
  validateReadResult(read);
  const readProjection = projectRead(read);
  const validity = readProjection.status === "unavailable" && capability.validity === "valid"
    ? "unavailable"
    : capability.validity;
  if (validity !== "valid" && readProjection.status !== "unavailable") {
    throw new ArtifactWorldCutSourceError("invalid_source", "Non-valid capability has a non-unavailable read projection");
  }
  const actions = content.actions.flatMap((action, index) => (
    action.kind === "notify_local" || action.target.hwCapabilityId !== capability.capability.hwCapabilityId
      ? []
      : [{ action, order: index + 1 }]
  ));
  const actionCompatibility = actions.map(({ action, order }) => projectAction(resolver, capability, action, order));
  const projection: NeutralDeviceSummary = {
    hwCapabilityId: capability.capability.hwCapabilityId,
    schema: capability.capability.schema,
    schemaVersion: capability.capability.schemaVersion,
    ...(capability.capability.semanticKind === undefined ? {} : { semanticKind: capability.capability.semanticKind }),
    read: readProjection,
    validity,
    actionCompatibility,
    predicateCompatibility: [...(predicates.get(capability.capability.hwCapabilityId) ?? [])],
  };
  return projection;
}

function projectRead(read: CapabilityReadResult): NeutralDeviceSummary["read"] {
  if (read.status === "available") {
    return {
      status: "available",
      value: read.value,
    };
  }
  return {
    status: read.status,
    reason: mapReason(read.reason),
  };
}

function projectAction(
  resolver: ArtifactWorldCutCapabilityResolver,
  capability: NormalizedCapability,
  action: Exclude<ArtifactAction, { kind: "notify_local" }>,
  order: number,
) {
  const input = {
    capability: {
      schema: capability.capability.schema,
      schemaVersion: capability.capability.schemaVersion,
    },
    ...(capability.state === undefined ? {} : { state: capabilityState(capability) }),
    action,
  } satisfies CapabilityActionInput;
  let result: CapabilityActionResult;
  try {
    result = resolver.checkAction(input);
  } catch {
    throw new ArtifactWorldCutSourceError("invalid_source", "Capability action resolver failed");
  }
  validateActionResult(result, action.kind);
  if (result.status === "compatible") {
    return {
      order,
      kind: result.kind,
      status: "compatible" as const,
      before: result.before,
      after: result.after,
    };
  }
  return {
    order,
    kind: "kind" in result && result.kind !== undefined ? result.kind : action.kind,
    status: result.status,
    reason: mapReason(result.reason),
  };
}

function capabilityState(capability: NormalizedCapability): CapabilitySemanticsState {
  if (capability.state === undefined || capability.validity !== "valid") {
    return {
      attrs: capability.state?.attrs ?? {},
      validity: capability.validity === "valid" ? "unavailable" : capability.validity,
      freshness: "fresh",
    };
  }
  return {
    attrs: capability.state.attrs,
    validity: "valid",
    freshness: "fresh",
  };
}

function validateReadResult(value: unknown): asserts value is CapabilityReadResult {
  if (!isPlainObject(value) || (value.status !== "available" && value.status !== "unsupported" && value.status !== "unavailable")) {
    throw new ArtifactWorldCutSourceError("invalid_source", "Capability read projection is invalid");
  }
  if (value.status === "available") {
    if (!("value" in value) || !("valueType" in value) || !Array.isArray(value.operators)) {
      throw new ArtifactWorldCutSourceError("invalid_source", "Capability read projection is invalid");
    }
    if (!neutralScalarSchema.safeParse(value.value).success) {
      throw new ArtifactWorldCutSourceError("invalid_source", "Capability read projection is invalid");
    }
  } else if (!("reason" in value)) {
    throw new ArtifactWorldCutSourceError("invalid_source", "Capability read projection is invalid");
  } else {
    mapReason(value.reason);
  }
}

function validatePredicateResult(value: unknown): asserts value is CapabilityPredicateResult {
  if (!isPlainObject(value)
    || (value.status !== "compatible" && value.status !== "incompatible" && value.status !== "unavailable")) {
    throw new ArtifactWorldCutSourceError("invalid_source", "Capability predicate projection is invalid");
  }
  if (value.status === "compatible" && "reason" in value) {
    throw new ArtifactWorldCutSourceError("invalid_source", "Capability predicate projection is invalid");
  }
  if (value.status !== "compatible" && !("reason" in value)) {
    throw new ArtifactWorldCutSourceError("invalid_source", "Capability predicate projection is invalid");
  }
}

function validateActionResult(
  value: unknown,
  expectedKind: "set_level" | "set_boolean",
): asserts value is CapabilityActionResult {
  if (!isPlainObject(value)
    || (value.status !== "compatible" && value.status !== "incompatible" && value.status !== "unavailable")) {
    throw new ArtifactWorldCutSourceError("invalid_source", "Capability action projection is invalid");
  }
  if (value.status === "compatible" && value.kind !== expectedKind) {
    throw new ArtifactWorldCutSourceError("invalid_source", "Capability action projection kind is invalid");
  }
  if (value.status === "compatible" && "reason" in value) {
    throw new ArtifactWorldCutSourceError("invalid_source", "Capability action projection is invalid");
  }
  if (value.status !== "compatible" && !("reason" in value)) {
    throw new ArtifactWorldCutSourceError("invalid_source", "Capability action projection is invalid");
  }
}

function mapReason(reason: unknown): ClosedReasonCode {
  const parsed = closedReasonCodeSchema.safeParse(reason);
  if (!parsed.success) throw new ArtifactWorldCutSourceError("invalid_source", "Capability resolver reason is not closed");
  return parsed.data;
}

function parseRef(value: unknown): ArtifactRef {
  if (!isPlainObject(value) || !hasExactKeys(value, ["artifactId", "revision", "contentHash"])) {
    throw new ArtifactWorldCutSourceError("invalid_input", "ArtifactRef is invalid");
  }
  const parsed = artifactRefSchema.safeParse(value);
  if (!parsed.success) throw new ArtifactWorldCutSourceError("invalid_input", "ArtifactRef is invalid");
  return Object.freeze({ ...parsed.data });
}

function artifactRef(value: ArtifactRevision): ArtifactRef {
  return {
    artifactId: value.artifactId,
    revision: value.revision,
    contentHash: value.contentHash,
  };
}

function isRegistryEntry(value: unknown): value is ArtifactRegistryEntry {
  return isPlainObject(value)
    && (value.status === "draft" || value.status === "superseded")
    && typeof value.tombstone === "boolean"
    && Array.isArray(value.audit)
    && isPlainObject(value.artifact);
}

function isCapabilitySnapshot(value: unknown): value is HomeWorldCapabilitySnapshot {
  return isPlainObject(value)
    && typeof value.hwCapabilityId === "string"
    && typeof value.hwId === "string"
    && typeof value.schema === "string"
    && typeof value.schemaVersion === "string"
    && (value.semanticKind === undefined || typeof value.semanticKind === "string")
    && Array.isArray(value.bindings);
}

function isHomeWorldDeviceSnapshot(value: unknown): value is HomeWorldDeviceSnapshot {
  return isPlainObject(value)
    && typeof value.bridgeId === "string"
    && typeof value.hwId === "string"
    && typeof value.nativeId === "string"
    && Array.isArray(value.bindings)
    && Array.isArray(value.capabilities)
    && Array.isArray(value.states)
    && (value.validity === "valid"
      || value.validity === "stale"
      || value.validity === "invalid-source"
      || value.validity === "present-but-invalid");
}

function normalizeHomeWatermark(value: unknown, expectedBridgeId: string): HomeWorldWatermark {
  const record = isPlainObject(value) ? value : undefined;
  const lastSeq = record?.lastSeq;
  if (record === undefined
    || record.bridgeId !== expectedBridgeId
    || !boundedId(record.bridgeId)
    || !boundedId(record.epochId)
    || typeof lastSeq !== "number"
    || !Number.isSafeInteger(lastSeq)
    || lastSeq < 0
    || (record.lastSyncCompleteAt !== undefined && typeof record.lastSyncCompleteAt !== "string")) {
    throw new ArtifactWorldCutSourceError("invalid_source", "HomeWorld watermark is invalid");
  }
  return {
    bridgeId: record.bridgeId,
    epochId: record.epochId,
    lastSeq,
    ...(record.lastSyncCompleteAt === undefined ? {} : { lastSyncCompleteAt: record.lastSyncCompleteAt }),
  };
}

function sameHomeWatermark(left: unknown, right: HomeWorldWatermark): boolean {
  return isPlainObject(left)
    && left.bridgeId === right.bridgeId
    && left.epochId === right.epochId
    && left.lastSeq === right.lastSeq;
}

function uniqueBindings(bindings: readonly HomeWorldBinding[]): readonly HomeWorldBinding[] {
  const map = new Map<string, HomeWorldBinding>();
  for (const binding of bindings) {
    if (!isPlainObject(binding)
      || !boundedId(binding.bridgeId)
      || !boundedId(binding.nativeId)
      || !boundedId(binding.nativeInstanceId)) {
      throw new ArtifactWorldCutSourceError("invalid_source", "HomeWorld capability binding is invalid");
    }
    const key = bindingKey(binding);
    if (!map.has(key)) map.set(key, {
      bridgeId: binding.bridgeId,
      nativeId: binding.nativeId,
      nativeInstanceId: binding.nativeInstanceId,
    });
  }
  return [...map.values()].sort((left, right) => compareCodePoints(
    `${left.bridgeId}\u0000${left.nativeId}\u0000${left.nativeInstanceId}`,
    `${right.bridgeId}\u0000${right.nativeId}\u0000${right.nativeInstanceId}`,
  ));
}

function bindingKey(binding: HomeWorldBinding): string {
  return `${binding.bridgeId}\u0000${binding.nativeId}\u0000${binding.nativeInstanceId}`;
}

function sameArtifactRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.artifactId === right.artifactId
    && left.revision === right.revision
    && left.contentHash === right.contentHash;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameAssessmentWatermarks(
  evidence: readonly ArtifactEvidenceAttestation["watermarks"][number][],
  authority: readonly ArtifactAuthorityAssessment["checkedWatermarks"][number][],
): boolean {
  // Evidence covers every capability referenced by the Artifact, while
  // authority covers only device-action targets. Consequently authority is
  // an exact semantic-fence subset; notify-only artifacts have an empty set.
  // lastSyncCompleteAt is capture metadata and is intentionally excluded.
  const evidenceByBridge = new Map(evidence.map((watermark) => [watermark.bridgeId, watermark]));
  if (evidenceByBridge.size !== evidence.length) return false;
  const seen = new Set<string>();
  return authority.every((candidate) => {
    if (seen.has(candidate.bridgeId)) return false;
    seen.add(candidate.bridgeId);
    const watermark = evidenceByBridge.get(candidate.bridgeId);
    return watermark !== undefined
      && candidate.epochId === watermark.epochId
      && candidate.lastSeq === watermark.lastSeq
      && candidate.freshness === watermark.freshness
      && candidate.gapCount === watermark.gapCount;
  });
}

function boundedId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= 200;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
