import { createHash } from "node:crypto";

import { parseArtifactContent, type ArtifactContent } from "../artifact/neutral-artifact.js";

/** The narrow immutable input accepted by the migration projection. */
export interface HomeAutomationMigrationSimulatorInput {
  readonly ruleRef: string;
  readonly sourceFingerprint: string;
  /** A candidate returned by the bounded foreign-rule adapter. */
  readonly candidate: unknown;
  /** A HomeProposalService ProposalEnvelope or its equivalent read-only view. */
  readonly proposal: unknown;
  /** The HomeProposalService preparationForProposal projection, when present. */
  readonly preparation?: unknown;
}

export type HomeAutomationMigrationSimulationReason =
  | "invalid_candidate"
  | "proposal_unavailable"
  | "candidate_mismatch"
  | "rule_binding_mismatch"
  | "source_fingerprint_mismatch"
  | "proposal_mismatch"
  | "preparation_unavailable"
  | "preparation_failed"
  | "prepared_artifact_missing"
  | "preparation_not_succeeded"
  | "prepared_content_stale";

export type HomeAutomationMigrationSimulationResult =
  | {
    readonly status: "translated";
    readonly ruleRef: string;
    readonly sourceFingerprint: string;
    readonly proposalId: string;
    readonly candidateProposalRevision: number;
    readonly candidateContentHash: string;
    readonly writesPerformed: false;
  }
  | {
    readonly status: "simulated";
    readonly ruleRef: string;
    readonly sourceFingerprint: string;
    readonly proposalId: string;
    readonly candidateProposalRevision: number;
    readonly candidateContentHash: string;
    readonly writesPerformed: false;
  }
  | {
    readonly status: "ready";
    readonly ruleRef: string;
    readonly sourceFingerprint: string;
    readonly proposalId: string;
    readonly candidateProposalRevision: number;
    readonly reviewProposalRevision: number;
    readonly candidateContentHash: string;
    readonly preparedArtifact: HomeAutomationMigrationPreparedArtifact;
    readonly writesPerformed: false;
  }
  | {
    readonly status: "needs_attention";
    readonly reason: HomeAutomationMigrationSimulationReason;
    readonly writesPerformed: false;
  };

export interface HomeAutomationMigrationPreparedArtifact {
  readonly artifactId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly compileResultId: string;
  readonly dryRunResultId: string;
}

/**
 * Projects an imported rule into the existing proposal/preparation lifecycle.
 * This function deliberately has no compiler, registry, bridge, or write
 * dependency: compiler and dry-run attestations are produced by the governed
 * preparation worker and arrive here only through durable references.
 */
export function projectHomeAutomationMigration(
  input: HomeAutomationMigrationSimulatorInput,
): HomeAutomationMigrationSimulationResult {
  try {
    const parsedInput = parseInput(input);
    if (parsedInput === undefined) return needs("preparation_unavailable");

    const candidate = parseCandidate(parsedInput.candidate);
    if (candidate === undefined) return needs("invalid_candidate");
    const proposal = parseProposal(parsedInput.proposal);
    if (proposal === undefined) return needs("proposal_unavailable");

    if (candidate.ruleRef !== parsedInput.ruleRef) return needs("rule_binding_mismatch");
    if (candidate.sourceFingerprint !== parsedInput.sourceFingerprint) {
      return needs("source_fingerprint_mismatch");
    }
    if (candidate.title !== proposal.title
      || candidate.contentHash !== proposal.candidateContentHash) {
      return needs("candidate_mismatch");
    }

    const preparation = parsePreparation(parsedInput.preparation);
    if (parsedInput.preparation !== undefined && preparation === undefined) {
      return needs("preparation_unavailable");
    }
    if (preparation === undefined) {
      return proposal.lifecycle === "ready"
        ? needs("preparation_not_succeeded")
        : translated(candidate, proposal, proposal.revision);
    }
    if (preparation.proposalId !== proposal.id
      || !preparationRevisionMatchesProposal(preparation, proposal)) {
      return needs("proposal_mismatch");
    }
    if (preparation.status === "failed") return needs("preparation_failed");
    if (preparation.status === "queued" || preparation.status === "running") {
      return proposal.lifecycle === "ready"
        ? needs("preparation_not_succeeded")
        : translated(candidate, proposal, preparation.proposalRevision);
    }

    const preparedArtifact = parsePreparedArtifact(proposal.preparedArtifact);
    if (proposal.lifecycle !== "ready") {
      return proposal.preparedArtifact === undefined
        ? simulated(candidate, proposal, preparation.proposalRevision)
        : needs("proposal_mismatch");
    }
    if (preparedArtifact === undefined) return needs("prepared_artifact_missing");
    if (!proposal.preparedContentHash || !proposal.preparedContentHashMatches) {
      return needs("prepared_content_stale");
    }
    return ready(candidate, preparation.proposalRevision, proposal, preparedArtifact);
  } catch {
    return needs("preparation_unavailable");
  }
}

/** A class facade keeps the projection easy to mount from a runtime service. */
export class HomeAutomationMigrationSimulator {
  project(input: HomeAutomationMigrationSimulatorInput): HomeAutomationMigrationSimulationResult {
    return projectHomeAutomationMigration(input);
  }
}

export const simulateHomeAutomationMigration = projectHomeAutomationMigration;

/** Computes the stable neutral content identity used to bind a candidate. */
export function computeHomeAutomationMigrationCandidateContentHash(content: unknown): string {
  const parsed = parseArtifactContent(content);
  return digestCanonical(parsed);
}

interface ParsedInput {
  readonly ruleRef: string;
  readonly sourceFingerprint: string;
  readonly candidate: unknown;
  readonly proposal: unknown;
  readonly preparation?: unknown;
}

interface ParsedCandidate {
  readonly ruleRef: string;
  readonly sourceFingerprint: string;
  readonly title: string;
  readonly content: ArtifactContent;
  readonly contentHash: string;
}

interface ParsedProposal {
  readonly id: string;
  readonly revision: number;
  readonly lifecycle: "preparing" | "needs_info" | "ready";
  readonly title: string;
  readonly candidateContentHash: string;
  readonly preparedArtifact?: unknown;
  readonly preparedContentHash?: string;
  readonly preparedContentHashMatches: boolean;
}

interface ParsedPreparation {
  readonly proposalId: string;
  readonly proposalRevision: number;
  readonly status: "queued" | "running" | "succeeded" | "failed";
}

function parseInput(value: unknown): ParsedInput | undefined {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ["ruleRef", "sourceFingerprint", "candidate", "proposal", "preparation"])) {
      // The optional preparation key is omitted by normal callers. Accept
      // both exact forms while rejecting arbitrary caller-controlled fields.
      if (!isRecord(value) || !hasExactKeys(value, ["ruleRef", "sourceFingerprint", "candidate", "proposal"])) return undefined;
    }
    if (!isBoundedId(value.ruleRef, 200) || !isDigest(value.sourceFingerprint)) return undefined;
    return {
      ruleRef: value.ruleRef,
      sourceFingerprint: value.sourceFingerprint,
      candidate: value.candidate,
      proposal: value.proposal,
      ...(Object.hasOwn(value, "preparation") ? { preparation: value.preparation } : {}),
    };
  } catch {
    return undefined;
  }
}

function parseCandidate(value: unknown): ParsedCandidate | undefined {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ["status", "ruleRef", "sourceFingerprint", "title", "content"])
      || value.status !== "candidate"
      || !isBoundedId(value.ruleRef, 200)
      || !isDigest(value.sourceFingerprint)
      || !isBoundedText(value.title, 120)) return undefined;
    const content = parseArtifactContent(value.content);
    return {
      ruleRef: value.ruleRef,
      sourceFingerprint: value.sourceFingerprint,
      title: value.title,
      content,
      contentHash: digestCanonical(content),
    };
  } catch {
    return undefined;
  }
}

function parseProposal(value: unknown): ParsedProposal | undefined {
  try {
    if (!isRecord(value)
      || value.kind !== "automation-draft"
      || value.status !== "pending_review"
      || !isBoundedId(value.id, 200)
      || !isPositiveSafeInteger(value.revision)
      || (value.lifecycle !== "preparing" && value.lifecycle !== "needs_info" && value.lifecycle !== "ready")
      || !isBoundedText(value.title, 120)
      || !isRecord(value.artifactCandidate)
      || !hasExactKeys(value.artifactCandidate, ["schemaVersion", "content"])
      || value.artifactCandidate.schemaVersion !== "1") return undefined;
    const proposalContent = parseArtifactContent(value.artifactCandidate.content);
    const candidateContentHash = digestCanonical(proposalContent);
    const preparedContentHash = value.preparedContentHash;
    if (preparedContentHash !== undefined && !isDigest(preparedContentHash)) return undefined;
    const preparedContentHashMatches = preparedContentHash === undefined
      ? false
      : preparedContentHash === computePreparedContentHash(value);
    return {
      id: value.id,
      revision: value.revision,
      lifecycle: value.lifecycle,
      title: value.title,
      candidateContentHash,
      ...(Object.hasOwn(value, "preparedArtifact") ? { preparedArtifact: value.preparedArtifact } : {}),
      ...(preparedContentHash === undefined ? {} : { preparedContentHash }),
      preparedContentHashMatches,
    };
  } catch {
    return undefined;
  }
}

function parsePreparation(value: unknown): ParsedPreparation | undefined {
  if (value === undefined) return undefined;
  try {
    if (!isRecord(value)
      || !isBoundedId(value.proposalId, 200)
      || !isPositiveSafeInteger(value.proposalRevision)
      || (value.status !== "queued" && value.status !== "running" && value.status !== "succeeded" && value.status !== "failed")) {
      return undefined;
    }
    return {
      proposalId: value.proposalId,
      proposalRevision: value.proposalRevision,
      status: value.status,
    };
  } catch {
    return undefined;
  }
}

function parsePreparedArtifact(value: unknown): HomeAutomationMigrationPreparedArtifact | undefined {
  try {
    if (!isRecord(value)
      || !hasExactKeys(value, ["artifactId", "revision", "contentHash", "compileResultId", "dryRunResultId"])
      || !isBoundedId(value.artifactId, 256)
      || !isPositiveSafeInteger(value.revision)
      || !isDigest(value.contentHash)
      || !isDigest(value.compileResultId)
      || !isDigest(value.dryRunResultId)) return undefined;
    return Object.freeze({
      artifactId: value.artifactId,
      revision: value.revision,
      contentHash: value.contentHash,
      compileResultId: value.compileResultId,
      dryRunResultId: value.dryRunResultId,
    });
  } catch {
    return undefined;
  }
}

function preparationRevisionMatchesProposal(
  preparation: ParsedPreparation,
  proposal: ParsedProposal,
): boolean {
  if (proposal.lifecycle === "ready") {
    return preparation.proposalRevision < Number.MAX_SAFE_INTEGER
      && preparation.proposalRevision + 1 === proposal.revision;
  }
  return preparation.proposalRevision === proposal.revision;
}

function translated(
  candidate: ParsedCandidate,
  proposal: ParsedProposal,
  candidateProposalRevision: number,
): HomeAutomationMigrationSimulationResult {
  return Object.freeze({
    status: "translated" as const,
    ruleRef: candidate.ruleRef,
    sourceFingerprint: candidate.sourceFingerprint,
    proposalId: proposal.id,
    candidateProposalRevision,
    candidateContentHash: candidate.contentHash,
    writesPerformed: false as const,
  });
}

function simulated(
  candidate: ParsedCandidate,
  proposal: ParsedProposal,
  candidateProposalRevision: number,
): HomeAutomationMigrationSimulationResult {
  return Object.freeze({
    status: "simulated" as const,
    ruleRef: candidate.ruleRef,
    sourceFingerprint: candidate.sourceFingerprint,
    proposalId: proposal.id,
    candidateProposalRevision,
    candidateContentHash: candidate.contentHash,
    writesPerformed: false as const,
  });
}

function ready(
  candidate: ParsedCandidate,
  candidateProposalRevision: number,
  proposal: ParsedProposal,
  preparedArtifact: HomeAutomationMigrationPreparedArtifact,
): HomeAutomationMigrationSimulationResult {
  return Object.freeze({
    status: "ready" as const,
    ruleRef: candidate.ruleRef,
    sourceFingerprint: candidate.sourceFingerprint,
    proposalId: proposal.id,
    candidateProposalRevision,
    reviewProposalRevision: proposal.revision,
    candidateContentHash: candidate.contentHash,
    preparedArtifact,
    writesPerformed: false as const,
  });
}

function needs(reason: HomeAutomationMigrationSimulationReason): HomeAutomationMigrationSimulationResult {
  return Object.freeze({ status: "needs_attention" as const, reason, writesPerformed: false as const });
}

function computePreparedContentHash(value: Record<string, unknown>): string {
  const snapshot = {
    title: value.title,
    summary: value.summary,
    intent: value.intent,
    rationale: value.rationale ?? null,
    artifactCandidate: value.artifactCandidate ?? null,
    risk: value.risk,
    actionPolicyClasses: value.actionPolicyClasses ?? null,
    confirmationDeviceNames: value.confirmationDeviceNames ?? null,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex")}`;
}

function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object") throw new TypeError("value is not canonical JSON");
  if (seen.has(value)) throw new TypeError("value contains a cycle");
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
  } else {
    const record = value as Record<string, unknown>;
    result = `{${Object.keys(record).sort(compareCodePoints).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function isBoundedId(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxBytes
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return isBoundedId(value, maxBytes) && !/(?:\b[a-z][a-z0-9+.-]*:\/\/|\b(?:data|javascript|mailto):|\bwww\.)/iu.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCodePoints);
  const expected = [...keys].sort(compareCodePoints);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
