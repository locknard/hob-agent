import { canonicalAssessmentInput, computeConflictInputIdentity } from "./artifact-assessments.js";
import type { ArtifactRegistryEntry } from "./artifact-registry.js";
import type {
  ArtifactRiskConflictFinding,
  ArtifactRiskConflictPort,
  ArtifactRiskConflictQuery,
  ArtifactRiskConflictResult,
} from "./artifact-risk-producer.js";
import type { ApprovedProposalSource } from "./artifact-producer.js";
import {
  artifactRefSchema,
  parseArtifactContent,
  parseArtifactRevision,
  type ArtifactContent,
  type ArtifactRef,
  type ArtifactRevision,
} from "./neutral-artifact.js";
import type { HubVerifiedProposalSource } from "./proposal-source-port.js";

const MAX_CAPABILITY_IDS = 16;
const MAX_SCAN_ENTRIES = 200;
const MAX_FINDINGS = 20;
const MAX_ID_BYTES = 200;
const URL_LIKE = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\b(?:data|javascript|mailto):|\bwww\.)/iu;
const UNAVAILABLE_SOURCE_IDENTITY = `sha256:${"0".repeat(64)}`;

type ProposalConflictCheckIdentity = {
  readonly status: "checked";
  readonly existingAutomationCount: number;
  readonly matches: readonly ProposalConflictMatchIdentity[];
};

type ProposalConflictMatchIdentity = {
  readonly identity: string;
  readonly relation: "duplicate" | "conflict" | "possible_overlap";
};

type RegistryScanIdentity = {
  readonly artifact: {
    readonly artifactId: string;
    readonly revision: number;
    readonly contentHash: string;
  };
  readonly status: "draft" | "superseded";
  readonly tombstone: boolean;
};

/** The read-only Artifact Registry seam used by the unmounted conflict source. */
export interface ArtifactRiskConflictArtifactRegistry {
  readonly getRevision: (artifactId: string, revision: number) => ArtifactRegistryEntry | undefined;
  readonly list: (query?: { readonly limit?: number }) => readonly ArtifactRegistryEntry[];
}

/** The exact approved Proposal source seam; it has no proposal mutation method. */
export type ArtifactRiskConflictProposalSource = ApprovedProposalSource;

export interface ArtifactRiskConflictSourceOptions {
  readonly proposals: ArtifactRiskConflictProposalSource;
  readonly registry: ArtifactRiskConflictArtifactRegistry;
}

export type ArtifactRiskConflictSourceErrorCode = "invalid_input";

export class ArtifactRiskConflictSourceError extends Error {
  constructor(readonly code: ArtifactRiskConflictSourceErrorCode, message: string) {
    super(message);
    this.name = "ArtifactRiskConflictSourceError";
  }
}

/**
 * Hub-private, unmounted conflict source for ArtifactRiskProducer.
 *
 * It reads the exact draft, re-binds its approved Proposal source, and scans a
 * bounded read-only Registry view. It owns no bridge, credential, control,
 * network, or mutation capability.
 */
export class ArtifactRiskConflictSource implements ArtifactRiskConflictPort {
  private readonly proposals: ArtifactRiskConflictProposalSource;
  private readonly registry: ArtifactRiskConflictArtifactRegistry;

  constructor(options: ArtifactRiskConflictSourceOptions) {
    if (!isPlainObject(options)
      || !options.proposals
      || typeof options.proposals.withApprovedProposalAtRevision !== "function") {
      throw new ArtifactRiskConflictSourceError("invalid_input", "Approved Proposal source is required");
    }
    if (!options.registry
      || typeof options.registry.getRevision !== "function"
      || typeof options.registry.list !== "function") {
      throw new ArtifactRiskConflictSourceError("invalid_input", "Artifact Registry read seam is required");
    }
    this.proposals = options.proposals;
    this.registry = options.registry;
  }

  assess(input: ArtifactRiskConflictQuery): ArtifactRiskConflictResult {
    const query = normalizeQuery(input);
    const artifact = this.readExactDraft(query.artifact);
    if (artifact === undefined) return unavailableResult();

    const capabilityIds = capabilityRefsFromContent(artifact.content);
    if (capabilityIds.some((capabilityId) => !opaqueId(capabilityId))
      || !sameStringArray(capabilityIds, query.hwCapabilityIds)) return unavailableResult();

    const proposal = this.readProposalConflict(artifact);
    if (proposal === undefined) return unavailableResult();

    const registry = this.readRegistryConflicts(query.artifact, artifact, capabilityIds);
    if (registry === undefined) return unavailableResult();

    const findings = deduplicateFindings([...proposal.findings, ...registry.findings]);
    if (findings.length > MAX_FINDINGS) return unavailableResult();
    try {
      return freezeResult({
        status: statusForFindings(findings),
        findings,
        sourceIdentity: computeConflictInputIdentity({
          artifact: query.artifact,
          conflictCheck: proposal.conflictCheck,
          // Hash each exact bounded row before composing the scan identity so
          // the aggregate digest remains bounded even for max-length IDs.
          registryScan: registry.scanIdentity.map((row) => computeConflictInputIdentity(row)),
        }),
      });
    } catch {
      return unavailableResult();
    }
  }

  private readExactDraft(ref: ArtifactRef): ArtifactRevision | undefined {
    let entry: ArtifactRegistryEntry | undefined;
    try {
      entry = this.registry.getRevision(ref.artifactId, ref.revision);
    } catch {
      return undefined;
    }
    if (!isRegistryEntry(entry)
      || entry.status !== "draft"
      || entry.tombstone
      || !sameArtifactRef(entry.artifact, ref)) {
      return undefined;
    }
    try {
      return parseArtifactRevision(entry.artifact);
    } catch {
      return undefined;
    }
  }

  private readProposalConflict(
    artifact: ArtifactRevision,
  ): {
    readonly findings: readonly ArtifactRiskConflictFinding[];
    readonly conflictCheck: ProposalConflictCheckIdentity;
  } | undefined {
    try {
      const result = this.proposals.withApprovedProposalAtRevision(
        artifact.sourceProposal.proposalId,
        artifact.sourceProposal.proposalRevision,
        (source) => translateProposalSource(source, artifact),
      );
      if (isPromiseLike(result)) return undefined;
      return result;
    } catch {
      return undefined;
    }
  }

  private readRegistryConflicts(
    requested: ArtifactRef,
    artifact: ArtifactRevision,
    capabilityIds: readonly string[],
  ): {
    readonly findings: readonly ArtifactRiskConflictFinding[];
    readonly scanIdentity: readonly RegistryScanIdentity[];
  } | undefined {
    let rows: readonly ArtifactRegistryEntry[];
    try {
      rows = this.registry.list({ limit: MAX_SCAN_ENTRIES });
    } catch {
      return undefined;
    }
    if (!Array.isArray(rows) || rows.length >= MAX_SCAN_ENTRIES) return undefined;

    const candidateBehavior = behaviorCanonical(artifact.content);
    if (candidateBehavior === undefined) return undefined;
    const candidateActions = deviceActionsByTarget(artifact.content);
    const seenRevisions = new Set<string>();
    const findings: ArtifactRiskConflictFinding[] = [];
    const scanIdentity: RegistryScanIdentity[] = [];

    for (const row of rows) {
      const normalized = normalizeRegistryEntry(row);
      if (normalized === undefined) return undefined;
      const existing = normalized.artifact;
      const revisionKey = `${existing.artifactId}\u0000${existing.revision}`;
      if (seenRevisions.has(revisionKey)) {
        // The Registry cannot return duplicate immutable rows. Do not guess
        // which row is authoritative if a custom read seam violates that rule.
        return undefined;
      }
      seenRevisions.add(revisionKey);
      scanIdentity.push({
        artifact: {
          artifactId: existing.artifactId,
          revision: existing.revision,
          contentHash: existing.contentHash,
        },
        status: normalized.status,
        tombstone: normalized.tombstone,
      });

      if (normalized.status !== "draft" || normalized.tombstone || sameArtifactRef(existing, requested)) {
        continue;
      }

      const existingBehavior = behaviorCanonical(existing.content);
      if (existingBehavior === undefined) return undefined;
      const reference = existing.contentHash;

      if (existing.contentHash === artifact.contentHash || existingBehavior === candidateBehavior) {
        findings.push({
          kind: "existing_artifact",
          severity: "blocking",
          reason: "duplicate",
          reference,
        });
        continue;
      }

      const existingActions = deviceActionsByTarget(existing.content);
      const commonActionTargets = [...candidateActions.keys()]
        .filter((target) => existingActions.has(target))
        .sort(compareCodePoints);
      const blockingActionTargets = new Set<string>();
      for (const hwCapabilityId of commonActionTargets) {
        const candidateAction = candidateActions.get(hwCapabilityId)!;
        const existingAction = existingActions.get(hwCapabilityId)!;
        if (candidateAction !== existingAction) {
          blockingActionTargets.add(hwCapabilityId);
          findings.push({
            kind: "existing_artifact",
            severity: "blocking",
            reason: "existing_artifact",
            hwCapabilityId,
            reference,
          });
        }
      }

      const existingCapabilityIds = capabilityRefsFromContent(existing.content);
      if (existingCapabilityIds.some((capabilityId) => !opaqueId(capabilityId))) return undefined;
      for (const hwCapabilityId of capabilityIds) {
        if (existingCapabilityIds.includes(hwCapabilityId) && !blockingActionTargets.has(hwCapabilityId)) {
          findings.push({
            kind: "existing_artifact",
            severity: "warning",
            reason: "possible_overlap",
            hwCapabilityId,
            reference,
          });
        }
      }
    }

    return {
      findings,
      scanIdentity: scanIdentity.sort(compareRegistryScanIdentity),
    };
  }
}

function translateProposalSource(
  source: HubVerifiedProposalSource,
  artifact: ArtifactRevision,
): {
  readonly findings: readonly ArtifactRiskConflictFinding[];
  readonly conflictCheck: ProposalConflictCheckIdentity;
} {
  if (!isPlainObject(source)
    || !hasExactKeys(source, [
      "proposalId", "revision", "kind", "status", "applicationStatus", "title", "summary",
      "intent", "evidence", "conflictCheck", "risk", "artifactCandidate",
    ])
    || source.proposalId !== artifact.sourceProposal.proposalId
    || source.revision !== artifact.sourceProposal.proposalRevision
    || source.kind !== "automation-draft"
    || source.status !== "approved"
    || source.applicationStatus !== "not_available"
    || !isPlainObject(source.artifactCandidate)
    || !hasExactKeys(source.artifactCandidate, ["schemaVersion", "content"])
    || source.artifactCandidate.schemaVersion !== "1") {
    throw new Error("approved Proposal source does not match Artifact");
  }

  const sourceContent = parseArtifactContent(source.artifactCandidate.content);
  if (canonicalAssessmentInput(sourceContent) !== canonicalAssessmentInput(artifact.content)) {
    throw new Error("approved Proposal candidate does not match Artifact");
  }

  const conflictCheck = source.conflictCheck;
  if (!isPlainObject(conflictCheck)
    || !hasExactKeys(conflictCheck, ["status", "existingAutomationCount", "matches"])
    || conflictCheck.status !== "checked"
    || !Number.isSafeInteger(conflictCheck.existingAutomationCount)
    || conflictCheck.existingAutomationCount < 0
    || !Array.isArray(conflictCheck.matches)
    || conflictCheck.matches.length > MAX_FINDINGS
    || conflictCheck.existingAutomationCount < conflictCheck.matches.length) {
    throw new Error("approved Proposal conflict check is unavailable");
  }

  const findings: ArtifactRiskConflictFinding[] = [];
  const matches: ProposalConflictMatchIdentity[] = [];
  const seen = new Set<string>();
  for (const match of conflictCheck.matches) {
    if (!isPlainObject(match)
      || !hasExactKeys(match, ["identity", "relation"])
      || !opaqueId(match.identity)
      || (match.relation !== "duplicate" && match.relation !== "conflict" && match.relation !== "possible_overlap")) {
      throw new Error("approved Proposal conflict match is invalid");
    }
    if (seen.has(match.identity)) throw new Error("approved Proposal conflict match is duplicated");
    seen.add(match.identity);
    matches.push({ identity: match.identity, relation: match.relation });
    const reference = computeConflictInputIdentity({
      kind: "foreign-rule-reference",
      ruleRef: match.identity,
    });
    findings.push(match.relation === "possible_overlap"
      ? {
          kind: "foreign_rule",
          severity: "warning",
          reason: "possible_overlap",
          reference,
        }
      : {
          kind: "foreign_rule",
          severity: "blocking",
          reason: match.relation === "duplicate" ? "duplicate" : "foreign_rule",
          reference,
        });
  }
  return {
    findings: sortFindings(findings),
    conflictCheck: {
      status: "checked",
      existingAutomationCount: conflictCheck.existingAutomationCount,
      matches,
    },
  };
}

function normalizeQuery(value: unknown): ArtifactRiskConflictQuery {
  if (!isPlainObject(value) || !hasExactKeys(value, ["artifact", "hwCapabilityIds"])) {
    throw new ArtifactRiskConflictSourceError("invalid_input", "Conflict query is invalid");
  }
  const artifactValue = value.artifact;
  if (!isPlainObject(artifactValue) || !hasExactKeys(artifactValue, ["artifactId", "revision", "contentHash"])) {
    throw new ArtifactRiskConflictSourceError("invalid_input", "Conflict ArtifactRef is invalid");
  }
  const parsedArtifact = artifactRefSchema.safeParse(artifactValue);
  if (!parsedArtifact.success) {
    throw new ArtifactRiskConflictSourceError("invalid_input", "Conflict ArtifactRef is invalid");
  }
  if (!Array.isArray(value.hwCapabilityIds) || value.hwCapabilityIds.length > MAX_CAPABILITY_IDS) {
    throw new ArtifactRiskConflictSourceError("invalid_input", "Conflict capability scope is invalid");
  }
  const ids = value.hwCapabilityIds.map((item) => {
    if (!opaqueId(item)) {
      throw new ArtifactRiskConflictSourceError("invalid_input", "Conflict capability scope is invalid");
    }
    return item;
  });
  if (new Set(ids).size !== ids.length || !sameStringArray(ids, [...ids].sort(compareCodePoints))) {
    throw new ArtifactRiskConflictSourceError("invalid_input", "Conflict capability scope is not canonical");
  }
  return { artifact: parsedArtifact.data, hwCapabilityIds: ids };
}

function normalizeRegistryEntry(value: unknown): {
  readonly artifact: ArtifactRevision;
  readonly status: "draft" | "superseded";
  readonly tombstone: boolean;
} | undefined {
  if (!isRegistryEntry(value)) return undefined;
  try {
    const artifact = parseArtifactRevision(value.artifact);
    if (artifact.artifactId !== value.artifact.artifactId
      || artifact.revision !== value.artifact.revision
      || artifact.contentHash !== value.artifact.contentHash) {
      return undefined;
    }
    return { artifact, status: value.status, tombstone: value.tombstone };
  } catch {
    return undefined;
  }
}

function isRegistryEntry(value: unknown): value is ArtifactRegistryEntry {
  return isPlainObject(value)
    && hasExactKeys(value, ["artifact", "status", "tombstone", "audit"])
    && (value.status === "draft" || value.status === "superseded")
    && typeof value.tombstone === "boolean"
    && Array.isArray(value.audit);
}

function capabilityRefsFromContent(content: ArtifactContent): string[] {
  const ids = new Set<string>();
  if (content.trigger.kind === "capability_changed") ids.add(content.trigger.source.hwCapabilityId);
  for (const condition of content.conditions) ids.add(condition.source.hwCapabilityId);
  for (const action of content.actions) {
    if (action.kind !== "notify_local") ids.add(action.target.hwCapabilityId);
  }
  if (content.rollback.kind === "restore_previous_state") ids.add(content.rollback.target.hwCapabilityId);
  for (const postcondition of content.postconditions) ids.add(postcondition.source.hwCapabilityId);
  return [...ids].sort(compareCodePoints);
}

function deviceActionsByTarget(content: ArtifactContent): ReadonlyMap<string, string> {
  const actions = new Map<string, string>();
  for (const action of content.actions) {
    if (action.kind === "notify_local") continue;
    const canonical = canonicalAssessmentInput(action);
    const existing = actions.get(action.target.hwCapabilityId);
    actions.set(action.target.hwCapabilityId, existing === undefined ? canonical : `${existing}\u0000${canonical}`);
  }
  return actions;
}

function behaviorCanonical(content: ArtifactContent): string | undefined {
  try {
    return canonicalAssessmentInput(content);
  } catch {
    return undefined;
  }
}

function sameArtifactRef(left: ArtifactRevision | ArtifactRef, right: ArtifactRevision | ArtifactRef): boolean {
  return left.artifactId === right.artifactId
    && left.revision === right.revision
    && left.contentHash === right.contentHash;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareRegistryScanIdentity(left: RegistryScanIdentity, right: RegistryScanIdentity): number {
  const artifactIdDifference = compareCodePoints(left.artifact.artifactId, right.artifact.artifactId);
  if (artifactIdDifference !== 0) return artifactIdDifference;
  if (left.artifact.revision !== right.artifact.revision) {
    return left.artifact.revision - right.artifact.revision;
  }
  const contentHashDifference = compareCodePoints(left.artifact.contentHash, right.artifact.contentHash);
  if (contentHashDifference !== 0) return contentHashDifference;
  const statusDifference = compareCodePoints(left.status, right.status);
  if (statusDifference !== 0) return statusDifference;
  return Number(left.tombstone) - Number(right.tombstone);
}

function statusForFindings(findings: readonly ArtifactRiskConflictFinding[]): "none" | "duplicate" | "possible_overlap" {
  if (findings.length === 0) return "none";
  return findings.some((finding) => finding.reason === "duplicate") ? "duplicate" : "possible_overlap";
}

function deduplicateFindings(findings: readonly ArtifactRiskConflictFinding[]): readonly ArtifactRiskConflictFinding[] {
  const seen = new Set<string>();
  const unique: ArtifactRiskConflictFinding[] = [];
  for (const finding of findings) {
    const key = [
      finding.kind,
      finding.severity,
      finding.reason,
      finding.hwCapabilityId ?? "",
      finding.reference ?? "",
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  return sortFindings(unique);
}

function sortFindings(findings: readonly ArtifactRiskConflictFinding[]): readonly ArtifactRiskConflictFinding[] {
  return [...findings].sort((left, right) => compareCodePoints(
    `${left.kind}\u0000${left.severity}\u0000${left.reason}\u0000${left.hwCapabilityId ?? ""}\u0000${left.reference ?? ""}`,
    `${right.kind}\u0000${right.severity}\u0000${right.reason}\u0000${right.hwCapabilityId ?? ""}\u0000${right.reference ?? ""}`,
  ));
}

function unavailableResult(): ArtifactRiskConflictResult {
  return freezeResult({
    status: "unavailable",
    findings: [{
      kind: "stale_evidence",
      severity: "blocking",
      reason: "conflict_unavailable",
    }],
    sourceIdentity: UNAVAILABLE_SOURCE_IDENTITY,
  });
}

function freezeResult(value: ArtifactRiskConflictResult): ArtifactRiskConflictResult {
  for (const finding of value.findings) Object.freeze(finding);
  Object.freeze(value.findings);
  return Object.freeze(value);
}

function opaqueId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES
    && !URL_LIKE.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every((key) => ownKeys.includes(key));
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  return typeof (value as { readonly then?: unknown }).then === "function";
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]!;
    const rightPoint = rightPoints[index]!;
    if (leftPoint < rightPoint) return -1;
    if (leftPoint > rightPoint) return 1;
  }
  return leftPoints.length - rightPoints.length;
}
