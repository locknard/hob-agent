import { HistoryRangeSchema } from "@hob/bridge-contract";
import { z } from "zod";

import {
  canonicalAssessmentInput,
  computeProposalEvidenceIdentity,
} from "./artifact-assessments.js";
import {
  parseArtifactContent,
  parseArtifactRevision,
  type ArtifactContent,
  type ArtifactRef,
  type ArtifactRevision,
} from "./neutral-artifact.js";
import type { HubVerifiedProposalSource } from "./proposal-source-port.js";
import type {
  HistoryReplayImportedReference,
  HistoryReplayReason,
} from "./artifact-history-replay-attestation.js";

export const MAX_HISTORY_REPLAY_SOURCE_CAPABILITIES = 16;
export const MAX_HISTORY_REPLAY_SOURCE_REFERENCES = 50;
export const MAX_HISTORY_REPLAY_SOURCE_COVERAGE = 16;
export const HISTORY_REPLAY_SOURCE_QUERY_LIMIT = 50;

const MAX_ID_BYTES = 200;
const UTC_TIMESTAMP = z.iso.datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "timestamp must use UTC");
const BOUNDED_ID = z.string()
  .min(1)
  .max(MAX_ID_BYTES)
  .refine((value) => value.trim() === value, "identifier must not have surrounding whitespace")
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES, "identifier exceeds its byte budget");

const importedHistoryReasonValues = [
  "bridge_not_ready",
  "missing_consistent_baseline",
  "history_unavailable",
  "journal_query_unavailable",
  "history_gap",
  "query_truncated",
  "retention_floor_unknown",
  "empty_or_purged",
  "recorder_disabled",
  "invalid_response",
  "invalid_row",
  "response_too_large",
  "record_limit",
  "record_too_large",
  "timeout",
  "cancelled",
  "busy",
  "resync_stale",
  "source_conflict",
  "imported_quota",
  "history_range_unavailable",
] as const satisfies readonly HistoryReplayReason[];

const importedHistoryReasonSchema = z.enum(importedHistoryReasonValues);
const importedReferenceSchema = z.object({
  bridgeId: BOUNDED_ID,
  hwId: BOUNDED_ID,
  capabilityId: BOUNDED_ID,
  observedAt: UTC_TIMESTAMP,
  source: z.literal("imported-history"),
  origin: z.literal("imported"),
  importId: BOUNDED_ID,
  historySeq: z.number().int().positive().safe(),
  sourceRange: HistoryRangeSchema,
}).strict().superRefine((reference, context) => {
  const since = Date.parse(reference.sourceRange.since);
  const until = Date.parse(reference.sourceRange.until);
  const observedAt = Date.parse(reference.observedAt);
  if (!(Number.isFinite(since) && Number.isFinite(until) && Number.isFinite(observedAt)
    && since <= observedAt && observedAt < until)) {
    context.addIssue({ code: "custom", path: ["observedAt"], message: "imported observation must fall inside its source range" });
  }
});

const fallbackReferenceSchema = z.object({
  bridgeId: BOUNDED_ID,
  hwId: BOUNDED_ID.optional(),
  capabilityId: BOUNDED_ID.optional(),
  observedAt: UTC_TIMESTAMP,
  source: z.literal("current-state"),
}).strict();

const watermarkSchema = z.object({
  bridgeId: BOUNDED_ID,
  epochId: BOUNDED_ID,
  lastSeq: z.number().int().nonnegative().safe(),
  freshness: z.enum(["fresh", "stale", "unknown"]),
  gapCount: z.number().int().nonnegative().safe(),
}).strict();

const importedCoverageSchema = z.object({
  bridgeId: BOUNDED_ID,
  status: z.enum(["partial", "unavailable"]),
  reasons: z.array(importedHistoryReasonSchema).min(1).max(importedHistoryReasonValues.length),
}).strict();

const importedHistorySchema = z.object({
  requestedSince: UTC_TIMESTAMP,
  requestedUntil: UTC_TIMESTAMP,
  truncated: z.boolean(),
  coverage: z.array(importedCoverageSchema).max(MAX_HISTORY_REPLAY_SOURCE_COVERAGE),
}).strict();

const evidenceSchema = z.object({
  references: z.array(z.union([importedReferenceSchema, fallbackReferenceSchema]))
    .max(MAX_HISTORY_REPLAY_SOURCE_REFERENCES),
  watermarks: z.array(watermarkSchema).min(1).max(MAX_HISTORY_REPLAY_SOURCE_COVERAGE),
  temporal: z.unknown().optional(),
  importedHistory: importedHistorySchema.optional(),
}).strict();

export interface HistoryReplaySourceFallbackReference {
  readonly bridgeId: string;
  readonly hwId: string;
  readonly capabilityId: string;
  readonly observedAt: string;
  readonly source: "current-state";
}

export interface HistoryReplaySourceWindow {
  readonly requestedSince: string;
  readonly requestedUntil: string;
}

export interface HistoryReplaySourceQuery {
  readonly hwCapabilityIds: readonly string[];
  readonly lookbackHours: number;
  readonly limit: typeof HISTORY_REPLAY_SOURCE_QUERY_LIMIT;
}

export interface HistoryReplaySourceCoverage {
  readonly bridgeId: string;
  readonly status: "partial" | "unavailable";
  readonly reasons: readonly HistoryReplayReason[];
}

export interface HistoryReplaySource {
  readonly artifact: ArtifactRef;
  readonly proposal: {
    readonly id: string;
    readonly revision: number;
    readonly proposalEvidenceIdentity: string;
  };
  readonly query: HistoryReplaySourceQuery;
  readonly requestedWindow: HistoryReplaySourceWindow;
  readonly expectedReferences: readonly HistoryReplayImportedReference[];
  readonly fallbackReferences: readonly HistoryReplaySourceFallbackReference[];
  readonly coverage: readonly HistoryReplaySourceCoverage[];
  readonly truncated: boolean;
}

export type ArtifactHistoryReplaySource = HistoryReplaySource;

export type HistoryReplaySourceErrorCode = "invalid_source";

export class HistoryReplaySourceError extends TypeError {
  readonly code: HistoryReplaySourceErrorCode;

  constructor(message: string) {
    super(message);
    this.name = "HistoryReplaySourceError";
    this.code = "invalid_source";
  }
}

/**
 * Builds the Hub-private replay read source from one exact approved Proposal
 * source and one verified Artifact revision. It projects only neutral query
 * identities and evidence references; proposal text, state values, live
 * watermarks, and provider/native fields remain outside the result.
 */
export function createHistoryReplaySource(
  source: HubVerifiedProposalSource,
  artifact: ArtifactRevision,
): HistoryReplaySource {
  const parsedArtifact = parseVerifiedArtifact(artifact);
  const parsedSource = parseVerifiedSource(source, parsedArtifact);
  const capabilityIds = deriveCapabilityIds(parsedArtifact.content);
  const evidence = parseEvidence(parsedSource.evidence);
  const importedHistory = evidence.importedHistory;
  if (importedHistory === undefined || hasOwnKey(evidence, "temporal")) {
    throw invalidSource("History replay requires one imported-history evidence mode");
  }

  const lookbackHours = deriveLookbackHours(importedHistory.requestedSince, importedHistory.requestedUntil);
  const selected = new Set(capabilityIds);
  const expectedReferences = evidence.references
    .filter(isImportedReference)
    .filter((reference) => selected.has(reference.capabilityId))
    .sort(compareImportedReferences);
  const fallbackReferences = evidence.references
    .filter(isFallbackReference)
    .filter((reference) => selected.has(reference.capabilityId))
    .sort(compareFallbackReferences);

  const coveredCapabilities = new Set([
    ...expectedReferences.map((reference) => reference.capabilityId),
    ...fallbackReferences.map((reference) => reference.capabilityId),
  ]);
  if ([...selected].some((capabilityId) => !coveredCapabilities.has(capabilityId))) {
    throw invalidSource("Every Artifact capability requires imported or current-state evidence");
  }

  const relevantBridgeIds = new Set([
    ...expectedReferences.map((reference) => reference.bridgeId),
    ...fallbackReferences.map((reference) => reference.bridgeId),
  ]);
  const coverageByBridge = new Map(importedHistory.coverage.map((coverage) => [coverage.bridgeId, coverage] as const));
  if (coverageByBridge.size !== importedHistory.coverage.length) {
    throw invalidSource("Imported-history coverage must contain one row per bridge");
  }
  for (const bridgeId of relevantBridgeIds) {
    if (!coverageByBridge.has(bridgeId)) {
      throw invalidSource("Imported-history coverage must cover every evidence bridge");
    }
  }

  const coverage = [...relevantBridgeIds]
    .sort(compareStrings)
    .map((bridgeId) => {
      const item = coverageByBridge.get(bridgeId)!;
      const reasons = [...new Set(item.reasons)].sort(compareStrings) as HistoryReplayReason[];
      if (reasons.length !== item.reasons.length) {
        throw invalidSource("Imported-history coverage reasons must be unique");
      }
      return {
        bridgeId,
        status: item.status,
        reasons,
      } satisfies HistoryReplaySourceCoverage;
    });

  const result: HistoryReplaySource = {
    artifact: Object.freeze({
      artifactId: parsedArtifact.artifactId,
      revision: parsedArtifact.revision,
      contentHash: parsedArtifact.contentHash,
    }),
    proposal: Object.freeze({
      id: parsedSource.proposalId,
      revision: parsedSource.revision,
      proposalEvidenceIdentity: computeProposalEvidenceIdentity(parsedSource.evidence),
    }),
    query: Object.freeze({
      hwCapabilityIds: Object.freeze([...capabilityIds]),
      lookbackHours,
      limit: HISTORY_REPLAY_SOURCE_QUERY_LIMIT,
    }),
    requestedWindow: Object.freeze({
      requestedSince: importedHistory.requestedSince,
      requestedUntil: importedHistory.requestedUntil,
    }),
    expectedReferences: Object.freeze(expectedReferences.map((reference) => freezeReference(reference))),
    fallbackReferences: Object.freeze(fallbackReferences.map((reference) => Object.freeze({ ...reference }))),
    coverage: Object.freeze(coverage.map((item) => Object.freeze({
      ...item,
      reasons: Object.freeze([...item.reasons]),
    }))),
    truncated: importedHistory.truncated,
  };
  return Object.freeze(result);
}

export const buildHistoryReplaySource = createHistoryReplaySource;
export const createArtifactHistoryReplaySource = createHistoryReplaySource;

function parseVerifiedArtifact(value: unknown): ArtifactRevision {
  try {
    return parseArtifactRevision(value);
  } catch {
    throw invalidSource("Artifact revision is not verified");
  }
}

function parseVerifiedSource(
  value: unknown,
  artifact: ArtifactRevision,
): HubVerifiedProposalSource {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "proposalId", "revision", "kind", "status", "applicationStatus", "title", "summary",
    "intent", "evidence", "conflictCheck", "risk", "artifactCandidate",
  ])) {
    throw invalidSource("Approved Proposal source is invalid");
  }
  const source = value as HubVerifiedProposalSource;
  if (source.proposalId !== artifact.sourceProposal.proposalId
    || source.revision !== artifact.sourceProposal.proposalRevision
    || source.kind !== "automation-draft"
    || source.status !== "pending_review"
    || source.applicationStatus !== "not_available"
    || !isPlainObject(source.artifactCandidate)
    || !hasExactKeys(source.artifactCandidate, ["schemaVersion", "content"])
    || source.artifactCandidate.schemaVersion !== "1") {
    throw invalidSource("Approved Proposal source identity does not match Artifact");
  }
  let candidate: ArtifactContent;
  try {
    candidate = parseArtifactContent(source.artifactCandidate.content);
    if (canonicalAssessmentInput(candidate) !== canonicalAssessmentInput(artifact.content)) {
      throw new Error("candidate does not match artifact");
    }
  } catch {
    throw invalidSource("Approved Proposal candidate does not match Artifact");
  }
  void candidate;
  return source;
}

function parseEvidence(value: unknown): z.infer<typeof evidenceSchema> {
  try {
    const parsed = evidenceSchema.parse(value);
    if (hasOwnKey(parsed, "temporal")) {
      throw new Error("temporal evidence is not part of imported replay");
    }
    const referenceKeys = new Set<string>();
    for (const reference of parsed.references) {
      const key = isImportedReference(reference)
        ? `imported\u0000${reference.bridgeId}\u0000${reference.importId}\u0000${reference.historySeq}`
        : `current-state\u0000${reference.bridgeId}\u0000${reference.capabilityId}\u0000${reference.observedAt}`;
      if (referenceKeys.has(key)) throw new Error("evidence references must be unique");
      referenceKeys.add(key);
    }
    if (parsed.importedHistory !== undefined) {
      const coverageByBridge = new Map<string, z.infer<typeof importedCoverageSchema>>();
      for (const coverage of parsed.importedHistory.coverage) {
        if (coverageByBridge.has(coverage.bridgeId)
          || new Set(coverage.reasons).size !== coverage.reasons.length) {
          throw new Error("imported-history coverage must be unique");
        }
        coverageByBridge.set(coverage.bridgeId, coverage);
      }
      for (const reference of parsed.references) {
        if (isImportedReference(reference)
          && coverageByBridge.get(reference.bridgeId)?.status === "unavailable") {
          throw new Error("unavailable imported-history coverage cannot carry references");
        }
      }
    }
    return parsed;
  } catch {
    throw invalidSource("Approved Proposal evidence is not a strict imported-history envelope");
  }
}

function deriveCapabilityIds(content: ArtifactContent): string[] {
  const ids = new Set<string>();
  if (content.trigger.kind === "capability_changed") ids.add(content.trigger.source.hwCapabilityId);
  for (const condition of content.conditions) ids.add(condition.source.hwCapabilityId);
  for (const action of content.actions) {
    if (action.kind !== "notify_local") ids.add(action.target.hwCapabilityId);
  }
  if (content.rollback.kind === "restore_previous_state") ids.add(content.rollback.target.hwCapabilityId);
  for (const postcondition of content.postconditions) ids.add(postcondition.source.hwCapabilityId);
  const result = [...ids].sort(compareStrings);
  if (result.length > MAX_HISTORY_REPLAY_SOURCE_CAPABILITIES) {
    throw invalidSource("Artifact capability query exceeds its bound");
  }
  return result;
}

function deriveLookbackHours(requestedSince: string, requestedUntil: string): number {
  const since = Date.parse(requestedSince);
  const until = Date.parse(requestedUntil);
  const duration = until - since;
  const hours = duration / (60 * 60 * 1_000);
  if (!Number.isFinite(since) || !Number.isFinite(until)
    || !Number.isSafeInteger(hours) || hours < 1 || hours > 168) {
    throw invalidSource("Imported-history window must be one to 168 whole hours");
  }
  return hours;
}

function isImportedReference(
  value: z.infer<typeof importedReferenceSchema> | z.infer<typeof fallbackReferenceSchema>,
): value is z.infer<typeof importedReferenceSchema> {
  return value.source === "imported-history";
}

function isFallbackReference(
  value: z.infer<typeof importedReferenceSchema> | z.infer<typeof fallbackReferenceSchema>,
): value is z.infer<typeof fallbackReferenceSchema> & {
  readonly hwId: string;
  readonly capabilityId: string;
} {
  return value.source === "current-state"
    && value.hwId !== undefined
    && value.capabilityId !== undefined;
}

function freezeReference(reference: z.infer<typeof importedReferenceSchema>): HistoryReplayImportedReference {
  return Object.freeze({
    ...reference,
    sourceRange: Object.freeze({ ...reference.sourceRange }),
  });
}

function compareImportedReferences(
  left: z.infer<typeof importedReferenceSchema>,
  right: z.infer<typeof importedReferenceSchema>,
): number {
  return compareStrings(left.bridgeId, right.bridgeId)
    || compareStrings(left.capabilityId, right.capabilityId)
    || compareStrings(left.observedAt, right.observedAt)
    || compareStrings(left.importId, right.importId)
    || left.historySeq - right.historySeq;
}

function compareFallbackReferences(
  left: z.infer<typeof fallbackReferenceSchema> & { readonly hwId: string; readonly capabilityId: string },
  right: z.infer<typeof fallbackReferenceSchema> & { readonly hwId: string; readonly capabilityId: string },
): number {
  return compareStrings(left.bridgeId, right.bridgeId)
    || compareStrings(left.capabilityId, right.capabilityId)
    || compareStrings(left.observedAt, right.observedAt)
    || compareStrings(left.hwId, right.hwId);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function hasOwnKey(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidSource(message: string): HistoryReplaySourceError {
  return new HistoryReplaySourceError(message);
}
