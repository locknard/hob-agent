import {
  parseArtifactAuthorityAssessment,
  parseArtifactEvidenceAttestation,
  parseArtifactRiskAssessment,
} from "./artifact-assessments.js";
import type {
  ArtifactAssessmentEntry,
  ArtifactRegistryEntry,
} from "./artifact-registry.js";
import type {
  ArtifactEvidenceProductionRequest,
  ArtifactEvidenceProducer,
} from "./artifact-evidence-producer.js";
import type {
  ArtifactAuthorityProducer,
} from "./artifact-authority-producer.js";
import type {
  ArtifactProductionRequest,
  ArtifactProducer,
} from "./artifact-producer.js";
import type {
  ArtifactRiskProducer,
} from "./artifact-risk-producer.js";
import {
  artifactRefSchema,
  parseArtifactRevision,
  type ArtifactRef,
} from "./neutral-artifact.js";

/** The only mutation stages owned by this coordinator. */
export type ArtifactMutationCoordinatorStage = "artifact" | "evidence" | "authority" | "risk";

/** Bounded coordinator failure reasons; producer messages never cross this seam. */
export type ArtifactMutationCoordinatorFailureCode = "producer_failed" | "registry_mismatch";

/**
 * Narrow producer ports used by the coordinator.  The concrete unmounted
 * producers satisfy these shapes, while narrow fakes remain possible in local
 * contract tests without widening the coordinator's authority.
 */
export interface ArtifactMutationArtifactProducer {
  readonly produce: (input: ArtifactProductionRequest) => ArtifactRegistryEntry;
}

export interface ArtifactMutationEvidenceProducer {
  readonly produce: (input: ArtifactEvidenceProductionRequest) => ArtifactAssessmentEntry;
}

export interface ArtifactMutationAuthorityProducer {
  readonly produce: (input: ArtifactRef) => ArtifactAssessmentEntry;
}

export interface ArtifactMutationRiskProducer {
  readonly produce: (input: ArtifactRef) => ArtifactAssessmentEntry;
}

export interface ArtifactMutationCoordinatorOptions {
  readonly artifact: ArtifactMutationArtifactProducer | ArtifactProducer;
  readonly evidence: ArtifactMutationEvidenceProducer | ArtifactEvidenceProducer;
  readonly authority: ArtifactMutationAuthorityProducer | ArtifactAuthorityProducer;
  readonly risk: ArtifactMutationRiskProducer | ArtifactRiskProducer;
}

export interface ArtifactMutationProposalCommand {
  readonly proposalId: string;
  readonly proposalRevision: number;
}

/**
 * A success receipt intentionally contains only neutral references and
 * assessment identities.  Artifact content, dynamic values, routes, actors,
 * and Registry audit rows do not cross this Hub-private seam.
 */
export interface ArtifactMutationReceipt {
  readonly artifact: ArtifactRef;
  readonly evidence: {
    readonly attestationId: string;
    readonly inputIdentity: string;
  };
  readonly authority: {
    readonly assessmentId: string;
    readonly inputIdentity: string;
  };
  readonly risk: {
    readonly assessmentId: string;
    readonly inputIdentity: string;
  };
}

export class ArtifactMutationCoordinatorError extends Error {
  constructor(
    readonly stage: ArtifactMutationCoordinatorStage,
    readonly code: ArtifactMutationCoordinatorFailureCode,
  ) {
    super(`Artifact mutation ${stage} stage failed`);
    this.name = "ArtifactMutationCoordinatorError";
  }
}

/**
 * Hub-private, unmounted composition for the immutable Artifact assessment
 * pipeline.  It has no Registry, bridge, credential, route, or execution
 * dependency of its own; every write remains inside a typed producer seam.
 *
 * A failed run deliberately leaves any earlier immutable rows in place.  A
 * caller must explicitly invoke one of the two commands again; the producers'
 * own idempotency keys make that retry safe and restart-stable.
 */
export class ArtifactMutationCoordinator {
  private readonly artifact: ArtifactMutationArtifactProducer | ArtifactProducer;
  private readonly evidence: ArtifactMutationEvidenceProducer | ArtifactEvidenceProducer;
  private readonly authority: ArtifactMutationAuthorityProducer | ArtifactAuthorityProducer;
  private readonly risk: ArtifactMutationRiskProducer | ArtifactRiskProducer;

  constructor(options: ArtifactMutationCoordinatorOptions) {
    assertStrictOptions(options);
    this.artifact = options.artifact;
    this.evidence = options.evidence;
    this.authority = options.authority;
    this.risk = options.risk;
  }

  /** Produce a draft from one exact approved Proposal revision, then assess it. */
  fromApprovedProposal(input: ArtifactMutationProposalCommand): ArtifactMutationReceipt {
    assertCoordinatorReceiver(this);
    const command = parseProposalCommand(input);
    const artifactEntry = callProducer("artifact", () => this.artifact.produce(command));
    const artifactRef = validateArtifactEntry(artifactEntry, command);
    return runAssessments(this.evidence, this.authority, this.risk, artifactRef);
  }

  /** Refresh evidence, authority, and risk for one existing exact ArtifactRef. */
  refresh(input: ArtifactRef): ArtifactMutationReceipt {
    assertCoordinatorReceiver(this);
    const artifactRef = parseArtifactRef(input);
    return runAssessments(this.evidence, this.authority, this.risk, artifactRef);
  }
}

function runAssessments(
  evidenceProducer: ArtifactMutationEvidenceProducer | ArtifactEvidenceProducer,
  authorityProducer: ArtifactMutationAuthorityProducer | ArtifactAuthorityProducer,
  riskProducer: ArtifactMutationRiskProducer | ArtifactRiskProducer,
  artifactRef: ArtifactRef,
): ArtifactMutationReceipt {
  const evidenceEntry = callProducer("evidence", () => evidenceProducer.produce({ artifact: artifactRef }));
  const evidence = validateEvidenceEntry(evidenceEntry, artifactRef);

  const authorityEntry = callProducer("authority", () => authorityProducer.produce(artifactRef));
  const authority = validateAuthorityEntry(authorityEntry, artifactRef);

  const riskEntry = callProducer("risk", () => riskProducer.produce(artifactRef));
  const risk = validateRiskEntry(riskEntry, artifactRef, evidence, authority);

  return freezeDeep({
    artifact: { ...artifactRef },
    evidence,
    authority,
    risk,
  });
}

function assertStrictOptions(value: unknown): asserts value is ArtifactMutationCoordinatorOptions {
  if (!isPlainObject(value) || !hasExactKeys(value, ["artifact", "evidence", "authority", "risk"])) {
    throw new TypeError("Artifact mutation coordinator options are invalid");
  }
  const options = value as Record<string, unknown>;
  if (!hasProducer(options.artifact)
    || !hasProducer(options.evidence)
    || !hasProducer(options.authority)
    || !hasProducer(options.risk)) {
    throw new TypeError("Artifact mutation coordinator producer seams are invalid");
  }
}

function hasProducer(value: unknown): value is { readonly produce: (...args: readonly unknown[]) => unknown } {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof (value as { readonly produce?: unknown }).produce === "function";
}

function parseProposalCommand(value: unknown): ArtifactMutationProposalCommand {
  if (!isPlainObject(value) || !hasExactKeys(value, ["proposalId", "proposalRevision"])) {
    throw new TypeError("Artifact mutation Proposal command is invalid");
  }
  const proposalId = value.proposalId;
  const proposalRevision = value.proposalRevision;
  if (typeof proposalId !== "string"
    || proposalId.length === 0
    || proposalId.trim() !== proposalId
    || Buffer.byteLength(proposalId, "utf8") > 200
    || typeof proposalRevision !== "number"
    || !Number.isSafeInteger(proposalRevision)
    || proposalRevision < 1) {
    throw new TypeError("Artifact mutation Proposal command is invalid");
  }
  return Object.freeze({ proposalId, proposalRevision });
}

function parseArtifactRef(value: unknown): ArtifactRef {
  if (!isPlainObject(value) || !hasExactKeys(value, ["artifactId", "revision", "contentHash"])) {
    throw new TypeError("Artifact mutation ArtifactRef is invalid");
  }
  const parsed = artifactRefSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Artifact mutation ArtifactRef is invalid");
  return Object.freeze({ ...parsed.data });
}

function validateArtifactEntry(
  value: unknown,
  command: ArtifactMutationProposalCommand,
): ArtifactRef {
  if (!isPlainObject(value)
    || value.status !== "draft"
    || value.tombstone !== false
    || !isPlainObject(value.artifact)) {
    throw new ArtifactMutationCoordinatorError("artifact", "registry_mismatch");
  }
  let artifact;
  try {
    artifact = parseArtifactRevision(value.artifact);
  } catch {
    throw new ArtifactMutationCoordinatorError("artifact", "registry_mismatch");
  }
  if (artifact.sourceProposal.proposalId !== command.proposalId
    || artifact.sourceProposal.proposalRevision !== command.proposalRevision
    || artifact.revision !== 1) {
    throw new ArtifactMutationCoordinatorError("artifact", "registry_mismatch");
  }
  try {
    return artifactRef(artifact);
  } catch {
    throw new ArtifactMutationCoordinatorError("artifact", "registry_mismatch");
  }
}

function validateEvidenceEntry(value: unknown, expected: ArtifactRef): ArtifactMutationReceipt["evidence"] {
  const parsed = validateAssessmentEntry(value, expected, "evidence-attestation");
  let attestation;
  try {
    attestation = parseArtifactEvidenceAttestation(parsed.assessment);
  } catch {
    throw new ArtifactMutationCoordinatorError("evidence", "registry_mismatch");
  }
  if (!sameArtifactRef(attestation.artifact, expected)
    || parsed.recordId !== attestation.attestationId
    || parsed.inputIdentity !== attestation.inputIdentity) {
    throw new ArtifactMutationCoordinatorError("evidence", "registry_mismatch");
  }
  return Object.freeze({
    attestationId: attestation.attestationId,
    inputIdentity: attestation.inputIdentity,
  });
}

function validateAuthorityEntry(value: unknown, expected: ArtifactRef): ArtifactMutationReceipt["authority"] {
  const parsed = validateAssessmentEntry(value, expected, "authority-assessment");
  let assessment;
  try {
    assessment = parseArtifactAuthorityAssessment(parsed.assessment);
  } catch {
    throw new ArtifactMutationCoordinatorError("authority", "registry_mismatch");
  }
  if (!sameArtifactRef(assessment.artifact, expected)
    || parsed.recordId !== assessment.assessmentId
    || parsed.inputIdentity !== assessment.inputIdentity) {
    throw new ArtifactMutationCoordinatorError("authority", "registry_mismatch");
  }
  return Object.freeze({
    assessmentId: assessment.assessmentId,
    inputIdentity: assessment.inputIdentity,
  });
}

function validateRiskEntry(
  value: unknown,
  expected: ArtifactRef,
  evidence: ArtifactMutationReceipt["evidence"],
  authority: ArtifactMutationReceipt["authority"],
): ArtifactMutationReceipt["risk"] {
  const parsed = validateAssessmentEntry(value, expected, "risk-assessment");
  let assessment;
  try {
    assessment = parseArtifactRiskAssessment(parsed.assessment);
  } catch {
    throw new ArtifactMutationCoordinatorError("risk", "registry_mismatch");
  }
  if (parsed.recordId !== assessment.assessmentId
    || parsed.inputIdentity !== assessment.inputIdentity
    || !sameArtifactRef(assessment.artifact, expected)
    || assessment.evidence.attestationId !== evidence.attestationId
    || assessment.evidence.inputIdentity !== evidence.inputIdentity
    || assessment.authority.assessmentId !== authority.assessmentId
    || assessment.authority.inputIdentity !== authority.inputIdentity) {
    throw new ArtifactMutationCoordinatorError("risk", "registry_mismatch");
  }
  return Object.freeze({
    assessmentId: assessment.assessmentId,
    inputIdentity: assessment.inputIdentity,
  });
}

function validateAssessmentEntry(
  value: unknown,
  expected: ArtifactRef,
  kind: ArtifactAssessmentEntry["kind"],
): Extract<ArtifactAssessmentEntry, { kind: typeof kind }> {
  if (!isPlainObject(value)
    || value.kind !== kind
    || !isPlainObject(value.artifact)
    || !hasExactKeys(value.artifact, ["artifactId", "revision", "contentHash"])
    || !sameArtifactRef(value.artifact, expected)
    || !isPlainObject(value.assessment)) {
    throw new ArtifactMutationCoordinatorError(stageForKind(kind), "registry_mismatch");
  }
  const parsedRef = artifactRefSchema.safeParse(value.artifact);
  if (!parsedRef.success || !sameArtifactRef(parsedRef.data, expected)) {
    throw new ArtifactMutationCoordinatorError(stageForKind(kind), "registry_mismatch");
  }
  return value as unknown as Extract<ArtifactAssessmentEntry, { kind: typeof kind }>;
}

function stageForKind(kind: ArtifactAssessmentEntry["kind"]): ArtifactMutationCoordinatorStage {
  if (kind === "evidence-attestation") return "evidence";
  if (kind === "authority-assessment") return "authority";
  return "risk";
}

function callProducer<T>(stage: ArtifactMutationCoordinatorStage, operation: () => T): T {
  try {
    const value = operation();
    if (isPromiseLike(value)) throw new Error("async producer result");
    return value;
  } catch {
    throw new ArtifactMutationCoordinatorError(stage, "producer_failed");
  }
}

function artifactRef(value: { readonly artifactId: string; readonly revision: number; readonly contentHash: string }): ArtifactRef {
  return artifactRefSchema.parse({
    artifactId: value.artifactId,
    revision: value.revision,
    contentHash: value.contentHash,
  });
}

function sameArtifactRef(left: unknown, right: ArtifactRef): boolean {
  if (!isPlainObject(left)) return false;
  return left.artifactId === right.artifactId
    && left.revision === right.revision
    && left.contentHash === right.contentHash;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null || typeof value === "function")
    && typeof (value as { readonly then?: unknown }).then === "function";
}

function assertCoordinatorReceiver(value: unknown): asserts value is ArtifactMutationCoordinator {
  if (!(value instanceof ArtifactMutationCoordinator)) {
    throw new TypeError("Artifact mutation coordinator receiver is invalid");
  }
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child, seen);
  return Object.freeze(value);
}
