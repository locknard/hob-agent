import {
  computeAssessmentInputIdentity,
  computeConflictInputIdentity,
  createArtifactRiskAssessment,
  parseArtifactAuthorityAssessment,
  parseArtifactEvidenceAttestation,
  parseArtifactRiskAssessment,
  type ArtifactAuthorityAssessment,
  type ArtifactEvidenceAttestation,
  type ArtifactRiskAssessment,
  type ArtifactRiskInput,
} from "./artifact-assessments.js";
import type {
  ArtifactAssessmentEntry,
  ArtifactRegistryEntry,
} from "./artifact-registry.js";
import {
  artifactRefSchema,
  parseArtifactRevision,
  type ArtifactAction,
  type ArtifactContent,
  type ArtifactRef,
  type ArtifactRevision,
} from "./neutral-artifact.js";

/** Frozen Phase-1 risk policy identity. */
export const ARTIFACT_RISK_POLICY_ID = "policy-home-v1" as const;
export const ARTIFACT_RISK_POLICY_VERSION = "1.0.0" as const;

const PRODUCER_VERSION = "artifact-risk-producer-v1";
const PRODUCER_ACTOR = "hub-artifact-risk-producer";
const MAX_ID_BYTES = 200;

export type ArtifactRiskConflictStatus = "none" | "duplicate" | "possible_overlap" | "unavailable";
export type ArtifactRiskConflictKind =
  | "existing_artifact"
  | "foreign_rule"
  | "stale_evidence"
  | "authority_unavailable"
  | "target_invalid"
  | "policy_blocked";
export type ArtifactRiskConflictSeverity = "blocking" | "warning";

/** Closed reason codes accepted from the Hub-private conflict seam. */
export type ArtifactRiskConflictReason =
  | "existing_artifact"
  | "foreign_rule"
  | "stale_evidence"
  | "authority_unavailable"
  | "target_invalid"
  | "policy_blocked"
  | "duplicate"
  | "possible_overlap"
  | "conflict_unavailable";

export interface ArtifactRiskConflictFinding {
  readonly kind: ArtifactRiskConflictKind;
  readonly severity: ArtifactRiskConflictSeverity;
  readonly reason: ArtifactRiskConflictReason;
  readonly hwCapabilityId?: string;
  readonly reference?: string;
}

export interface ArtifactRiskConflictResult {
  readonly status: ArtifactRiskConflictStatus;
  readonly findings: readonly ArtifactRiskConflictFinding[];
}

export interface ArtifactRiskConflictQuery {
  readonly artifact: ArtifactRef;
  readonly hwCapabilityIds: readonly string[];
}

/** Hub-only read seam; it has no bridge, control, credential, or mutation method. */
export interface ArtifactRiskConflictPort {
  readonly assess: (input: ArtifactRiskConflictQuery) => ArtifactRiskConflictResult;
}

/** Exact latest assessment lookup and one immutable risk append. */
export interface ArtifactRiskRegistry {
  readonly getRevision: (artifactId: string, revision: number) => ArtifactRegistryEntry | undefined;
  readonly latestAttestation: (query: {
    readonly kind: "evidence-attestation" | "authority-assessment" | "risk-assessment";
    readonly artifact: ArtifactRef;
  }) => ArtifactAssessmentEntry | undefined;
  /** Narrow exact read used to find an older risk identity after refreshes. */
  readonly attestationByInputIdentity: (query: {
    readonly kind: "risk-assessment";
    readonly artifact: ArtifactRef;
    readonly inputIdentity: string;
  }) => ArtifactAssessmentEntry | undefined;
  readonly recordRiskAssessment: (input: {
    readonly assessment: ArtifactRiskAssessment;
    readonly idempotencyKey: string;
    readonly actor?: string;
  }) => ArtifactAssessmentEntry;
}

export interface ArtifactRiskProducerOptions {
  readonly registry: ArtifactRiskRegistry;
  readonly conflict: ArtifactRiskConflictPort;
  /** Hub-owned evaluation clock; never accepted in the production request. */
  readonly now?: () => string;
}

export type ArtifactRiskProducerErrorCode =
  | "invalid_input"
  | "artifact_not_found"
  | "assessment_unavailable"
  | "policy_blocked"
  | "conflict_blocked"
  | "conflict_unavailable"
  | "risk_write_failed";

export class ArtifactRiskProducerError extends Error {
  constructor(
    readonly code: ArtifactRiskProducerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactRiskProducerError";
  }
}

/**
 * Hub-owned, unmounted risk producer. It accepts only an ArtifactRef, reads
 * the immutable draft and its latest Hub attestations, and writes one neutral
 * risk assessment. It never receives a caller risk label, reason, conflict
 * identity, route, bridge, or control capability.
 */
export class ArtifactRiskProducer {
  private readonly registry: ArtifactRiskRegistry;
  private readonly conflict: ArtifactRiskConflictPort;
  private readonly now: () => string;

  constructor(options: ArtifactRiskProducerOptions) {
    if (!isPlainObject(options)
      || !options.registry
      || typeof options.registry.getRevision !== "function"
      || typeof options.registry.latestAttestation !== "function"
      || typeof options.registry.attestationByInputIdentity !== "function"
      || typeof options.registry.recordRiskAssessment !== "function") {
      throw new ArtifactRiskProducerError("invalid_input", "Artifact risk Registry seam is required");
    }
    if (options.conflict === null
      || (typeof options.conflict !== "object" && typeof options.conflict !== "function")
      || typeof options.conflict.assess !== "function") {
      throw new ArtifactRiskProducerError("invalid_input", "Artifact risk conflict seam is required");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new ArtifactRiskProducerError("invalid_input", "Artifact risk clock must be callable");
    }
    this.registry = options.registry;
    this.conflict = options.conflict;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Produce an immutable risk assessment for exactly one draft ArtifactRef. */
  produce(input: ArtifactRef): ArtifactAssessmentEntry {
    const artifactRef = parseArtifactRef(input);
    const artifact = this.readDraft(artifactRef);
    const policyClass = classifyPolicy(artifact);
    const capabilityIds = capabilityRefsFromContent(artifact.content);
    const authorityCapabilityIds = actionCapabilityIds(artifact.content);
    const evidence = this.readLatestEvidence(artifactRef);
    const authority = this.readLatestAuthority(artifactRef);

    validateEvidence(evidence, artifactRef, capabilityIds);
    validateAuthority(authority, artifactRef, authorityCapabilityIds);

    const conflictResult = this.readConflict({
      artifact: artifactRef,
      hwCapabilityIds: capabilityIds,
    });
    if (conflictResult.status === "unavailable") {
      throw new ArtifactRiskProducerError("conflict_unavailable", "Conflict assessment is unavailable");
    }
    if (conflictResult.findings.some((finding) => finding.severity === "blocking")) {
      throw new ArtifactRiskProducerError("conflict_blocked", "Conflict assessment blocks risk production");
    }

    let assessedAt: string;
    try {
      assessedAt = normalizeTimestamp(this.now());
    } catch {
      throw new ArtifactRiskProducerError("assessment_unavailable", "Risk assessment clock is unavailable");
    }

    const conflictInputIdentity = computeConflictInputIdentity({
      artifact: artifactRef,
      hwCapabilityIds: capabilityIds,
      result: conflictResult,
    });
    const reasons = policyReasons(policyClass, conflictResult);
    const identityInput: Omit<ArtifactRiskInput, "assessmentId" | "assessedAt"> & {
      readonly requiresHumanApproval?: never;
    } = {
      artifact: artifactRef,
      evidence: {
        attestationId: evidence.attestationId,
        inputIdentity: evidence.inputIdentity,
      },
      authority: {
        assessmentId: authority.assessmentId,
        inputIdentity: authority.inputIdentity,
      },
      conflictInputIdentity,
      class: policyClass,
      reasons: [...reasons],
      policyId: ARTIFACT_RISK_POLICY_ID,
      policyVersion: ARTIFACT_RISK_POLICY_VERSION,
    };
    const inputIdentity = computeAssessmentInputIdentity("risk", identityInput);
    let assessment: ArtifactRiskAssessment;
    try {
      assessment = createArtifactRiskAssessment({
        ...identityInput,
        assessmentId: `${PRODUCER_VERSION}-${inputIdentity.slice("sha256:".length)}`,
        assessedAt,
      });
    } catch {
      throw new ArtifactRiskProducerError("policy_blocked", "Risk assessment inputs are invalid");
    }

    const existing = this.readExistingRisk(artifactRef, assessment);
    if (existing !== undefined) return existing;

    try {
      const entry = this.registry.recordRiskAssessment({
        assessment,
        idempotencyKey: `${PRODUCER_VERSION}-${inputIdentity.slice("sha256:".length)}`,
        actor: PRODUCER_ACTOR,
      });
      if (!isRiskEntryFor(entry, artifactRef, assessment)) {
        throw new Error("risk entry is inconsistent");
      }
      return entry;
    } catch {
      try {
        const raced = this.readExistingRisk(artifactRef, assessment);
        if (raced !== undefined) return raced;
      } catch {
        // Preserve the bounded write failure below.
      }
      throw new ArtifactRiskProducerError("risk_write_failed", "Risk assessment could not be persisted");
    }
  }

  private readDraft(artifactRef: ArtifactRef): ArtifactRevision {
    let entry: ArtifactRegistryEntry | undefined;
    try {
      entry = this.registry.getRevision(artifactRef.artifactId, artifactRef.revision);
    } catch {
      throw new ArtifactRiskProducerError("artifact_not_found", "Artifact revision is unavailable");
    }
    if (entry === undefined
      || entry.status !== "draft"
      || entry.tombstone
      || !sameArtifactRef(entry.artifact, artifactRef)) {
      throw new ArtifactRiskProducerError("artifact_not_found", "Artifact draft is unavailable");
    }
    try {
      return parseArtifactRevision(entry.artifact);
    } catch {
      throw new ArtifactRiskProducerError("artifact_not_found", "Artifact draft is unavailable");
    }
  }

  private readLatestEvidence(artifact: ArtifactRef): ArtifactEvidenceAttestation {
    let entry: ArtifactAssessmentEntry | undefined;
    try {
      entry = this.registry.latestAttestation({ kind: "evidence-attestation", artifact });
    } catch {
      throw new ArtifactRiskProducerError("assessment_unavailable", "Evidence assessment is unavailable");
    }
    if (entry === undefined || entry.kind !== "evidence-attestation") {
      throw new ArtifactRiskProducerError("assessment_unavailable", "Evidence assessment is unavailable");
    }
    try {
      const parsed = parseArtifactEvidenceAttestation(entry.assessment);
      if (entry.recordId !== parsed.attestationId
        || entry.inputIdentity !== parsed.inputIdentity
        || !sameArtifactRef(entry.artifact, artifact)
        || !sameArtifactRef(parsed.artifact, artifact)) {
        throw new Error("evidence row identity is inconsistent");
      }
      return parsed;
    } catch {
      throw new ArtifactRiskProducerError("assessment_unavailable", "Evidence assessment is unavailable");
    }
  }

  private readLatestAuthority(artifact: ArtifactRef): ArtifactAuthorityAssessment {
    let entry: ArtifactAssessmentEntry | undefined;
    try {
      entry = this.registry.latestAttestation({ kind: "authority-assessment", artifact });
    } catch {
      throw new ArtifactRiskProducerError("assessment_unavailable", "Authority assessment is unavailable");
    }
    if (entry === undefined || entry.kind !== "authority-assessment") {
      throw new ArtifactRiskProducerError("assessment_unavailable", "Authority assessment is unavailable");
    }
    try {
      const parsed = parseArtifactAuthorityAssessment(entry.assessment);
      if (entry.recordId !== parsed.assessmentId
        || entry.inputIdentity !== parsed.inputIdentity
        || !sameArtifactRef(entry.artifact, artifact)
        || !sameArtifactRef(parsed.artifact, artifact)) {
        throw new Error("authority row identity is inconsistent");
      }
      return parsed;
    } catch {
      throw new ArtifactRiskProducerError("assessment_unavailable", "Authority assessment is unavailable");
    }
  }

  private readConflict(query: ArtifactRiskConflictQuery): ArtifactRiskConflictResult {
    let raw: unknown;
    try {
      raw = this.conflict.assess(query);
    } catch {
      throw new ArtifactRiskProducerError("conflict_unavailable", "Conflict assessment is unavailable");
    }
    return normalizeConflictResult(raw, query.hwCapabilityIds);
  }

  private readExistingRisk(
    artifact: ArtifactRef,
    expected: ArtifactRiskAssessment,
  ): ArtifactAssessmentEntry | undefined {
    let entry: ArtifactAssessmentEntry | undefined;
    try {
      entry = this.registry.attestationByInputIdentity({
        kind: "risk-assessment",
        artifact,
        inputIdentity: expected.inputIdentity,
      });
    } catch {
      throw new ArtifactRiskProducerError("risk_write_failed", "Existing risk assessment is unavailable");
    }
    if (entry === undefined || entry.kind !== "risk-assessment") return undefined;
    try {
      const parsed = parseArtifactRiskAssessment(entry.assessment);
      if (entry.recordId !== parsed.assessmentId
        || entry.inputIdentity !== parsed.inputIdentity
        || !sameArtifactRef(entry.artifact, artifact)
        || !sameArtifactRef(parsed.artifact, artifact)) {
        throw new Error("risk row identity is inconsistent");
      }
      if (parsed.inputIdentity !== expected.inputIdentity) return undefined;
      if (parsed.assessmentId !== expected.assessmentId) {
        throw new Error("risk row record identity is inconsistent");
      }
      return entry;
    } catch {
      throw new ArtifactRiskProducerError("risk_write_failed", "Existing risk assessment is invalid");
    }
  }
}

function parseArtifactRef(value: unknown): ArtifactRef {
  if (!isPlainObject(value) || !hasExactKeys(value, ["artifactId", "revision", "contentHash"])) {
    throw new ArtifactRiskProducerError("invalid_input", "Only an ArtifactRef is accepted");
  }
  const parsed = artifactRefSchema.safeParse(value);
  if (!parsed.success) {
    throw new ArtifactRiskProducerError("invalid_input", "ArtifactRef is invalid");
  }
  return parsed.data;
}

function classifyPolicy(artifact: ArtifactRevision): "observe_or_notify" | "comfort_reversible" {
  const actions = artifact.content.actions;
  const allNotify = actions.length > 0 && actions.every((action) => action.kind === "notify_local");
  if (allNotify && artifact.content.rollback.kind === "no_remote_change") {
    return "observe_or_notify";
  }
  const hasDeviceAction = actions.some(isDeviceAction);
  if (hasDeviceAction && artifact.content.rollback.kind === "restore_previous_state") {
    return "comfort_reversible";
  }
  throw new ArtifactRiskProducerError("policy_blocked", "Artifact action shape is outside the fixed risk policy");
}

function validateEvidence(
  evidence: ArtifactEvidenceAttestation,
  artifact: ArtifactRef,
  expectedCapabilityIds: readonly string[],
): void {
  if (!sameArtifactRef(evidence.artifact, artifact)
    || evidence.coverage !== "complete"
    || evidence.reasons.length !== 0
    || !sameStringArray(evidence.selectedHwCapabilityIds, expectedCapabilityIds)
    || evidence.watermarks.length === 0
    || evidence.watermarks.some((watermark) => watermark.freshness !== "fresh" || watermark.gapCount !== 0)) {
    throw new ArtifactRiskProducerError("assessment_unavailable", "Complete evidence assessment is required");
  }
}

function validateAuthority(
  authority: ArtifactAuthorityAssessment,
  artifact: ArtifactRef,
  expectedCapabilityIds: readonly string[],
): void {
  if (!sameArtifactRef(authority.artifact, artifact)
    || (expectedCapabilityIds.length > 0 && authority.checkedWatermarks.length === 0)
    || authority.checkedWatermarks.some((watermark) => watermark.freshness !== "fresh" || watermark.gapCount !== 0)) {
    throw new ArtifactRiskProducerError("assessment_unavailable", "Authority assessment is unavailable");
  }
  if (authority.candidates.length !== expectedCapabilityIds.length) {
    throw new ArtifactRiskProducerError("assessment_unavailable", "Authority assessment scope is incomplete");
  }
  const candidatesByCapability = new Map<string, ArtifactAuthorityAssessment["candidates"][number]>();
  for (const candidate of authority.candidates) {
    if (candidatesByCapability.has(candidate.hwCapabilityId)
      || candidate.status !== "available"
      || !expectedCapabilityIds.includes(candidate.hwCapabilityId)) {
      throw new ArtifactRiskProducerError("assessment_unavailable", "Authority assessment scope is unavailable");
    }
    candidatesByCapability.set(candidate.hwCapabilityId, candidate);
  }
  if (expectedCapabilityIds.some((capabilityId) => !candidatesByCapability.has(capabilityId))) {
    throw new ArtifactRiskProducerError("assessment_unavailable", "Authority assessment scope is incomplete");
  }
}

function normalizeConflictResult(value: unknown, capabilityIds: readonly string[]): ArtifactRiskConflictResult {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ["status", "findings"])
    || !isConflictStatus(value.status)
    || !Array.isArray(value.findings)
    || value.findings.length > 20) {
    throw new ArtifactRiskProducerError("conflict_unavailable", "Conflict assessment is invalid");
  }
  const normalized = value.findings.map((raw) => normalizeConflictFinding(raw, capabilityIds));
  normalized.sort(compareFindings);
  for (let index = 1; index < normalized.length; index += 1) {
    if (compareFindings(normalized[index - 1]!, normalized[index]!) === 0) {
      throw new ArtifactRiskProducerError("conflict_unavailable", "Conflict assessment contains duplicate findings");
    }
  }
  if (value.status === "none" && normalized.length !== 0) {
    throw new ArtifactRiskProducerError("conflict_unavailable", "Conflict status does not match findings");
  }
  if (value.status !== "none" && normalized.length === 0) {
    throw new ArtifactRiskProducerError("conflict_unavailable", "Conflict status has no findings");
  }
  return {
    status: value.status,
    findings: normalized,
  };
}

function normalizeConflictFinding(value: unknown, capabilityIds: readonly string[]): ArtifactRiskConflictFinding {
  if (!isPlainObject(value)
    || !hasAllowedKeys(value, ["kind", "severity", "reason", "hwCapabilityId", "reference"])
    || !isConflictKind(value.kind)
    || !isConflictSeverity(value.severity)
    || !isConflictReason(value.reason)) {
    throw new ArtifactRiskProducerError("conflict_unavailable", "Conflict finding is invalid");
  }
  const finding: ArtifactRiskConflictFinding = {
    kind: value.kind,
    severity: value.severity,
    reason: value.reason,
  };
  if (value.hwCapabilityId !== undefined) {
    validateBoundedIdentifier(value.hwCapabilityId, "conflict_unavailable");
    if (!capabilityIds.includes(value.hwCapabilityId)) {
      throw new ArtifactRiskProducerError("conflict_unavailable", "Conflict finding capability is out of scope");
    }
    (finding as { hwCapabilityId?: string }).hwCapabilityId = value.hwCapabilityId;
  }
  if (value.reference !== undefined) {
    validateBoundedIdentifier(value.reference, "conflict_unavailable");
    (finding as { reference?: string }).reference = value.reference;
  }
  return finding;
}

function policyReasons(
  policyClass: "observe_or_notify" | "comfort_reversible",
  conflict: ArtifactRiskConflictResult,
): readonly string[] {
  const reasons = policyClass === "observe_or_notify"
    ? ["Local notification only; no remote change is permitted."]
    : ["Device change has an exact bounded restore path."];
  if (conflict.status === "duplicate" || conflict.status === "possible_overlap") {
    return [...reasons, "Conflict findings require household review."];
  }
  return reasons;
}

function capabilityRefsFromContent(content: ArtifactContent): string[] {
  const ids = new Set<string>();
  if (content.trigger.kind === "capability_changed") ids.add(content.trigger.source.hwCapabilityId);
  for (const condition of content.conditions) ids.add(condition.source.hwCapabilityId);
  for (const action of content.actions) {
    if (isDeviceAction(action)) ids.add(action.target.hwCapabilityId);
  }
  if (content.rollback.kind === "restore_previous_state") ids.add(content.rollback.target.hwCapabilityId);
  for (const postcondition of content.postconditions) ids.add(postcondition.source.hwCapabilityId);
  return [...ids].sort(compareUnicodeCodePoints);
}

function actionCapabilityIds(content: ArtifactContent): string[] {
  return [...new Set(content.actions.filter(isDeviceAction).map((action) => action.target.hwCapabilityId))]
    .sort(compareUnicodeCodePoints);
}

function isDeviceAction(action: ArtifactAction): action is Extract<ArtifactAction, { kind: "set_level" | "set_boolean" }> {
  return action.kind === "set_level" || action.kind === "set_boolean";
}

function isRiskEntryFor(
  entry: ArtifactAssessmentEntry,
  artifact: ArtifactRef,
  expected: ArtifactRiskAssessment,
): boolean {
  return entry.kind === "risk-assessment"
    && entry.assessment.kind === "risk-assessment"
    && entry.recordId === expected.assessmentId
    && entry.inputIdentity === expected.inputIdentity
    && sameArtifactRef(entry.artifact, artifact)
    && sameArtifactRef(entry.assessment.artifact, artifact)
    && entry.assessment.assessmentId === expected.assessmentId;
}

function sameArtifactRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.artifactId === right.artifactId
    && left.revision === right.revision
    && left.contentHash === right.contentHash;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error("timestamp is invalid");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("timestamp is invalid");
  return date.toISOString();
}

function validateBoundedIdentifier(value: unknown, code: "conflict_unavailable"): asserts value is string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || Buffer.byteLength(value, "utf8") > MAX_ID_BYTES
    || /(?:\b[a-z][a-z0-9+.-]*:\/\/|\b(?:data|javascript|mailto):|\bwww\.)/iu.test(value)) {
    throw new ArtifactRiskProducerError(code, "Conflict identifier is invalid");
  }
}

function isConflictStatus(value: unknown): value is ArtifactRiskConflictStatus {
  return value === "none" || value === "duplicate" || value === "possible_overlap" || value === "unavailable";
}

function isConflictKind(value: unknown): value is ArtifactRiskConflictKind {
  return value === "existing_artifact"
    || value === "foreign_rule"
    || value === "stale_evidence"
    || value === "authority_unavailable"
    || value === "target_invalid"
    || value === "policy_blocked";
}

function isConflictSeverity(value: unknown): value is ArtifactRiskConflictSeverity {
  return value === "blocking" || value === "warning";
}

function isConflictReason(value: unknown): value is ArtifactRiskConflictReason {
  return value === "existing_artifact"
    || value === "foreign_rule"
    || value === "stale_evidence"
    || value === "authority_unavailable"
    || value === "target_invalid"
    || value === "policy_blocked"
    || value === "duplicate"
    || value === "possible_overlap"
    || value === "conflict_unavailable";
}

function compareFindings(left: ArtifactRiskConflictFinding, right: ArtifactRiskConflictFinding): number {
  return compareUnicodeCodePoints(
    `${left.kind}\u0000${left.severity}\u0000${left.reason}\u0000${left.hwCapabilityId ?? ""}\u0000${left.reference ?? ""}`,
    `${right.kind}\u0000${right.severity}\u0000${right.reason}\u0000${right.hwCapabilityId ?? ""}\u0000${right.reference ?? ""}`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function hasAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key));
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
