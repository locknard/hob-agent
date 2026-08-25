import {
  parseArtifactCompileAttestation,
  parseNeutralDryRunAttestation,
  type ArtifactCompileAttestation,
  type NeutralDryRunAttestation,
} from "./artifact-compiler-contract.js";
import {
  createHistoryReplayInput,
  createHistoryReplayResult,
  parseHistoryReplayResult,
  type HistoryReplayCoverage,
  type HistoryReplayEvaluation,
  type HistoryReplayImportedReference,
  type HistoryReplayInput,
  type HistoryReplayResult,
  type HistoryReplayReason,
} from "./artifact-history-replay-attestation.js";
import {
  createHistoryReplaySource,
  type HistoryReplaySource,
  type HistoryReplaySourceCoverage,
} from "./artifact-history-replay-source.js";
import type {
  ArtifactAssessmentEntry,
  ArtifactRegistryEntry,
} from "./artifact-registry.js";
import {
  artifactRefSchema,
  parseArtifactRevision,
  type ArtifactRef,
  type ArtifactRevision,
} from "./neutral-artifact.js";
import type { ApprovedProposalSource, HubVerifiedProposalSource } from "./proposal-source-port.js";
import type {
  HomeWorldImportedHistoryProposalReference,
  HomeWorldImportedHistoryQuery,
  HomeWorldImportedHistoryReplayResult,
  HomeWorldImportedHistoryWindow,
} from "../world/home-world-service.js";

export interface ArtifactHistoryReplayCoordinatorOptions {
  readonly proposals: ApprovedProposalSource;
  readonly world: {
    readonly queryImportedHistoryForReplay: (
      input: HomeWorldImportedHistoryQuery,
      importedWindow: HomeWorldImportedHistoryWindow,
      expectedReferences: readonly HomeWorldImportedHistoryProposalReference[],
    ) => HomeWorldImportedHistoryReplayResult;
  };
  readonly registry: {
    readonly getRevision: (artifactId: string, revision: number) => ArtifactRegistryEntry | undefined;
    readonly recordHistoryReplayAttestation: (input: {
      readonly assessment: HistoryReplayResult;
      readonly idempotencyKey: string;
      readonly actor?: string;
    }) => ArtifactAssessmentEntry;
  };
  readonly evaluator: {
    readonly id: string;
    readonly version: string;
    readonly evaluate: (artifact: ArtifactRevision, input: HistoryReplayInput) => HistoryReplayEvaluation;
  };
}

export interface ArtifactHistoryReplayRequest {
  readonly artifact: ArtifactRef;
  readonly compile: ArtifactCompileAttestation;
  readonly dryRun: NeutralDryRunAttestation;
}

/** The durable registry summary returned beside the redacted replay result. */
export interface ArtifactHistoryReplayEntry {
  readonly kind: "history-replay-attestation";
  readonly recordId: string;
  readonly artifact: ArtifactRef;
  readonly inputIdentity: string;
  readonly recordedAt: string;
}

export interface ArtifactHistoryReplayReceipt {
  readonly result: HistoryReplayResult;
  readonly entry: ArtifactHistoryReplayEntry;
}

export type ArtifactHistoryReplayCoordinatorStage =
  | "input"
  | "artifact"
  | "proposal"
  | "world"
  | "identity"
  | "evaluator"
  | "persist";

export type ArtifactHistoryReplayCoordinatorFailureCode =
  | "invalid_input"
  | "not_found"
  | "unavailable"
  | "malformed_dependency"
  | "identity_mismatch"
  | "malformed_result"
  | "persistence_failed";

export class ArtifactHistoryReplayCoordinatorError extends Error {
  constructor(
    readonly stage: ArtifactHistoryReplayCoordinatorStage,
    readonly code: ArtifactHistoryReplayCoordinatorFailureCode,
  ) {
    super(`Artifact history replay ${stage} stage failed`);
    this.name = "ArtifactHistoryReplayCoordinatorError";
  }
}

/**
 * Owns the bounded preparation-to-replay seam. The coordinator never reads a
 * provider directly: the approved Proposal source freezes the exact imported
 * evidence identity, and World only receives those exact references.
 */
export class ArtifactHistoryReplayCoordinator {
  private readonly proposals: ApprovedProposalSource;
  private readonly world: ArtifactHistoryReplayCoordinatorOptions["world"];
  private readonly registry: ArtifactHistoryReplayCoordinatorOptions["registry"];
  private readonly evaluator: ArtifactHistoryReplayCoordinatorOptions["evaluator"];

  constructor(options: ArtifactHistoryReplayCoordinatorOptions) {
    assertStrictOptions(options);
    this.proposals = options.proposals;
    this.world = options.world;
    this.registry = options.registry;
    this.evaluator = options.evaluator;
  }

  /** Replay one exact compiled, write-free artifact against imported history. */
  replay(input: ArtifactHistoryReplayRequest): ArtifactHistoryReplayReceipt {
    const request = parseRequest(input);
    const artifact = this.readArtifact(request.artifact);
    assertPreparationBindings(request, artifact);

    let receipt: ArtifactHistoryReplayReceipt;
    try {
      receipt = this.proposals.withApprovedProposalAtRevision(
        artifact.sourceProposal.proposalId,
        artifact.sourceProposal.proposalRevision,
        (proposal) => this.replayAtApprovedProposal(request, artifact, proposal),
      );
    } catch (error) {
      if (error instanceof ArtifactHistoryReplayCoordinatorError) throw error;
      throw coordinatorError("proposal", "unavailable");
    }
    return receipt;
  }

  private readArtifact(reference: ArtifactRef): ArtifactRevision {
    let entry: ArtifactRegistryEntry | undefined;
    try {
      entry = this.registry.getRevision(reference.artifactId, reference.revision);
    } catch {
      throw coordinatorError("artifact", "unavailable");
    }
    if (entry === undefined) throw coordinatorError("artifact", "not_found");
    if (entry.status !== "draft" || entry.tombstone !== false) {
      throw coordinatorError("artifact", "identity_mismatch");
    }
    let artifact: ArtifactRevision;
    try {
      artifact = parseArtifactRevision(entry.artifact);
    } catch {
      throw coordinatorError("artifact", "malformed_dependency");
    }
    if (!sameArtifactRef(artifactRef(artifact), reference)) {
      throw coordinatorError("artifact", "identity_mismatch");
    }
    return artifact;
  }

  private replayAtApprovedProposal(
    request: ArtifactHistoryReplayRequest,
    artifact: ArtifactRevision,
    proposal: HubVerifiedProposalSource,
  ): ArtifactHistoryReplayReceipt {
    let source: HistoryReplaySource;
    try {
      source = createHistoryReplaySource(proposal, artifact);
    } catch {
      throw coordinatorError("proposal", "malformed_dependency");
    }
    if (!sameArtifactRef(source.artifact, request.artifact)
      || source.proposal.id !== artifact.sourceProposal.proposalId
      || source.proposal.revision !== artifact.sourceProposal.proposalRevision) {
      throw coordinatorError("identity", "identity_mismatch");
    }

    let worldResult: HomeWorldImportedHistoryReplayResult;
    try {
      worldResult = this.world.queryImportedHistoryForReplay(
        source.query,
        source.requestedWindow,
        source.expectedReferences,
      );
      validateWorldProjection(worldResult, source);
    } catch (error) {
      if (error instanceof ArtifactHistoryReplayCoordinatorError) throw error;
      throw coordinatorError("world", "unavailable");
    }

    let replayInput: HistoryReplayInput;
    try {
      replayInput = createHistoryReplayInput({
        artifact: source.artifact,
        proposal: source.proposal,
        compile: {
          resultId: request.compile.resultId,
          inputIdentity: request.compile.inputIdentity,
        },
        dryRun: {
          resultId: request.dryRun.resultId,
          inputIdentity: request.dryRun.inputIdentity,
        },
        refs: worldResult.references,
        samples: worldResult.samples,
        coverage: mergeCoverage(source.coverage, worldResult.coverage),
        truncated: source.truncated || worldResult.truncated,
        evaluator: { id: this.evaluator.id, version: this.evaluator.version },
      });
    } catch {
      throw coordinatorError("identity", "identity_mismatch");
    }

    let evaluation: HistoryReplayEvaluation;
    try {
      evaluation = this.evaluator.evaluate(artifact, replayInput);
    } catch {
      throw coordinatorError("evaluator", "unavailable");
    }

    let result: HistoryReplayResult;
    try {
      result = createHistoryReplayResult(replayInput, evaluation);
    } catch {
      throw coordinatorError("evaluator", "malformed_result");
    }
    return this.persist(result);
  }

  private persist(result: HistoryReplayResult): ArtifactHistoryReplayReceipt {
    const idempotencyKey = `history-replay-${result.inputIdentity}`;
    let raw: ArtifactAssessmentEntry;
    try {
      raw = this.registry.recordHistoryReplayAttestation({
        assessment: result,
        idempotencyKey,
      });
    } catch {
      throw coordinatorError("persist", "persistence_failed");
    }
    const entry = validateAssessmentEntry(raw, result);
    return freezeDeep({ result, entry });
  }
}

function parseRequest(input: unknown): ArtifactHistoryReplayRequest {
  if (!isPlainObject(input) || !hasExactKeys(input, ["artifact", "compile", "dryRun"])) {
    throw coordinatorError("input", "invalid_input");
  }
  let artifact: ArtifactRef;
  let compile: ArtifactCompileAttestation;
  let dryRun: NeutralDryRunAttestation;
  try {
    artifact = Object.freeze(artifactRefSchema.parse(input.artifact));
    compile = parseArtifactCompileAttestation(input.compile);
    dryRun = parseNeutralDryRunAttestation(input.dryRun);
  } catch {
    throw coordinatorError("input", "invalid_input");
  }
  return Object.freeze({ artifact, compile, dryRun });
}

function assertPreparationBindings(
  request: ArtifactHistoryReplayRequest,
  artifact: ArtifactRevision,
): void {
  const artifactReference = artifactRef(artifact);
  if (!sameArtifactRef(request.compile.artifact, request.artifact)
    || !sameArtifactRef(request.dryRun.artifact, request.artifact)
    || !sameArtifactRef(request.compile.artifact, request.dryRun.artifact)) {
    throw coordinatorError("identity", "identity_mismatch");
  }
  if (request.compile.status !== "compiled") {
    throw coordinatorError("identity", "unavailable");
  }
  if (request.dryRun.status !== "passed" || request.dryRun.writesPerformed !== false) {
    throw coordinatorError("identity", "unavailable");
  }
  if (request.dryRun.compileAttestationId !== request.compile.resultId
    || request.dryRun.compileInputIdentity !== request.compile.inputIdentity
    || request.compile.proposal.id !== artifact.sourceProposal.proposalId
    || request.compile.proposal.revision !== artifact.sourceProposal.proposalRevision
    || !sameArtifactRef(artifactReference, request.artifact)) {
    throw coordinatorError("identity", "identity_mismatch");
  }
}

function validateWorldProjection(
  value: unknown,
  source: HistoryReplaySource,
): asserts value is HomeWorldImportedHistoryReplayResult {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ["requestedSince", "requestedUntil", "references", "coverage", "truncated", "samples"])
    || value.requestedSince !== source.requestedWindow.requestedSince
    || value.requestedUntil !== source.requestedWindow.requestedUntil
    || !Array.isArray(value.references)
    || !Array.isArray(value.coverage)
    || !Array.isArray(value.samples)
    || typeof value.truncated !== "boolean") {
    throw coordinatorError("world", "identity_mismatch");
  }
  const expected = new Map(source.expectedReferences.map((reference) => [referenceKey(reference), reference] as const));
  const seen = new Set<string>();
  for (const valueReference of value.references) {
    if (!isPlainObject(valueReference)) throw coordinatorError("world", "malformed_result");
    const key = referenceKey(valueReference);
    const expectedReference = expected.get(key);
    if (expectedReference === undefined || seen.has(key) || !sameReference(valueReference, expectedReference)) {
      throw coordinatorError("world", "identity_mismatch");
    }
    seen.add(key);
  }
  const coverageByBridge = new Map<string, { readonly status: unknown }>();
  for (const item of value.coverage) {
    if (!isPlainObject(item) || typeof item.bridgeId !== "string"
      || (item.status !== "partial" && item.status !== "unavailable")
      || !Array.isArray(item.reasons)
      || coverageByBridge.has(item.bridgeId)) {
      throw coordinatorError("world", "malformed_result");
    }
    coverageByBridge.set(item.bridgeId, { status: item.status });
  }
  for (const reference of source.expectedReferences) {
    if (seen.has(referenceKey(reference))) continue;
    if (coverageByBridge.get(reference.bridgeId)?.status !== "unavailable") {
      throw coordinatorError("world", "identity_mismatch");
    }
  }
}

function mergeCoverage(
  source: readonly HistoryReplaySourceCoverage[],
  replay: readonly {
    readonly bridgeId: string;
    readonly status: "partial" | "unavailable";
    readonly reasons: readonly HistoryReplayReason[];
  }[],
): readonly HistoryReplayCoverage[] {
  const merged = new Map<string, { status: "partial" | "unavailable"; reasons: Set<HistoryReplayReason> }>();
  for (const item of [...source, ...replay]) {
    const current = merged.get(item.bridgeId) ?? { status: "partial", reasons: new Set<HistoryReplayReason>() };
    if (item.status === "unavailable") current.status = "unavailable";
    for (const reason of item.reasons) current.reasons.add(reason);
    merged.set(item.bridgeId, current);
  }
  return [...merged.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([bridgeId, item]) => ({
      bridgeId,
      status: item.status,
      reasons: [...item.reasons].sort(compareStrings),
    }));
}

function validateAssessmentEntry(
  value: unknown,
  result: HistoryReplayResult,
): ArtifactHistoryReplayEntry {
  if (!isPlainObject(value)
    || value.kind !== "history-replay-attestation"
    || typeof value.recordId !== "string"
    || !sameArtifactRef(value.artifact, result.artifact)
    || value.inputIdentity !== result.inputIdentity
    || typeof value.recordedAt !== "string"
    || !Array.isArray(value.audit)) {
    throw coordinatorError("persist", "malformed_result");
  }
  if (value.recordId !== result.resultId) {
    throw coordinatorError("persist", "identity_mismatch");
  }
  let assessment: HistoryReplayResult;
  try {
    assessment = parseHistoryReplayResult(value.assessment);
  } catch {
    throw coordinatorError("persist", "malformed_result");
  }
  if (assessment.resultId !== result.resultId
    || assessment.inputIdentity !== result.inputIdentity
    || !sameArtifactRef(assessment.artifact, result.artifact)) {
    throw coordinatorError("persist", "identity_mismatch");
  }
  return freezeDeep({
    kind: "history-replay-attestation",
    recordId: value.recordId,
    artifact: result.artifact,
    inputIdentity: result.inputIdentity,
    recordedAt: value.recordedAt,
  });
}

function artifactRef(artifact: ArtifactRevision): ArtifactRef {
  return artifactRefSchema.parse({
    artifactId: artifact.artifactId,
    revision: artifact.revision,
    contentHash: artifact.contentHash,
  });
}

function sameArtifactRef(left: unknown, right: ArtifactRef): boolean {
  return isPlainObject(left)
    && left.artifactId === right.artifactId
    && left.revision === right.revision
    && left.contentHash === right.contentHash;
}

function referenceKey(value: unknown): string {
  if (!isPlainObject(value)
    || typeof value.bridgeId !== "string"
    || typeof value.importId !== "string"
    || typeof value.historySeq !== "number") {
    throw coordinatorError("world", "malformed_result");
  }
  return `${value.bridgeId}\u0000${value.importId}\u0000${value.historySeq}`;
}

function sameReference(left: Record<string, unknown>, right: HistoryReplayImportedReference): boolean {
  const leftRange = isPlainObject(left.sourceRange) ? left.sourceRange : undefined;
  return left.bridgeId === right.bridgeId
    && left.hwId === right.hwId
    && left.capabilityId === right.capabilityId
    && left.observedAt === right.observedAt
    && left.source === right.source
    && left.origin === right.origin
    && left.importId === right.importId
    && left.historySeq === right.historySeq
    && leftRange?.since === right.sourceRange.since
    && leftRange?.until === right.sourceRange.until;
}

function assertStrictOptions(value: unknown): asserts value is ArtifactHistoryReplayCoordinatorOptions {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ["proposals", "world", "registry", "evaluator"])
    || !isPlainObject(value.proposals)
    || typeof value.proposals.withApprovedProposalAtRevision !== "function"
    || !isPlainObject(value.world)
    || typeof value.world.queryImportedHistoryForReplay !== "function"
    || !isPlainObject(value.registry)
    || typeof value.registry.getRevision !== "function"
    || typeof value.registry.recordHistoryReplayAttestation !== "function"
    || !isPlainObject(value.evaluator)
    || typeof value.evaluator.id !== "string"
    || typeof value.evaluator.version !== "string"
    || typeof value.evaluator.evaluate !== "function") {
    throw new TypeError("Artifact history replay coordinator options are invalid");
  }
}

function coordinatorError(
  stage: ArtifactHistoryReplayCoordinatorStage,
  code: ArtifactHistoryReplayCoordinatorFailureCode,
): ArtifactHistoryReplayCoordinatorError {
  return new ArtifactHistoryReplayCoordinatorError(stage, code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function compareStrings(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested);
  return value;
}
