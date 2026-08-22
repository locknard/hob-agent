import { createHash } from "node:crypto";

import { z, type RefinementCtx } from "zod";

import { semverSchema } from "@hob/bridge-contract";
import {
  artifactRefSchema,
  type ArtifactRef,
} from "./neutral-artifact.js";
import type { HomeWorldEvidenceCoverageReason } from "../world/home-world-service.js";
import {
  CanonicalJsonError,
  MAX_CANONICAL_ARRAY_LENGTH,
  MAX_CANONICAL_DEPTH,
  MAX_CANONICAL_INPUT_BYTES,
  MAX_CANONICAL_OBJECT_FIELDS,
  MAX_CANONICAL_STRING_BYTES,
  MAX_CANONICAL_TOTAL_ARRAY_ITEMS,
  MAX_CANONICAL_TOTAL_OBJECT_FIELDS,
  MAX_CANONICAL_TOTAL_STRING_BYTES,
  canonicalHubJson,
} from "../foundation/canonical-json.js";

export type { ArtifactRef };

/** The contract-wide maximum for canonical assessment input bytes. */
export const MAX_ASSESSMENT_INPUT_BYTES = MAX_CANONICAL_INPUT_BYTES;
export const MAX_ASSESSMENT_ID_LENGTH = 200;
export const MAX_ASSESSMENT_REASON_LENGTH = 1_000;
export const MAX_ASSESSMENT_REASONS = 10;
export const MAX_ASSESSMENT_WATERMARKS = 16;
export const MAX_AUTHORITY_CANDIDATES = 16;
export const MAX_ASSESSMENT_DEPTH = MAX_CANONICAL_DEPTH;
export const MAX_ASSESSMENT_ARRAY_LENGTH = MAX_CANONICAL_ARRAY_LENGTH;
export const MAX_ASSESSMENT_TOTAL_ARRAY_ITEMS = MAX_CANONICAL_TOTAL_ARRAY_ITEMS;
export const MAX_ASSESSMENT_OBJECT_FIELDS = MAX_CANONICAL_OBJECT_FIELDS;
export const MAX_ASSESSMENT_TOTAL_OBJECT_FIELDS = MAX_CANONICAL_TOTAL_OBJECT_FIELDS;
export const MAX_ASSESSMENT_STRING_BYTES = MAX_CANONICAL_STRING_BYTES;
export const MAX_ASSESSMENT_TOTAL_STRING_BYTES = MAX_CANONICAL_TOTAL_STRING_BYTES;

const boundedId = z.string()
  .min(1)
  .refine((value) => value === value.trim(), "identifier must not have surrounding whitespace")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_ASSESSMENT_ID_LENGTH,
    "identifier must be at most 200 UTF-8 bytes",
  );
const boundedReason = z.string()
  .min(1)
  .max(MAX_ASSESSMENT_REASON_LENGTH)
  .refine((value) => value === value.trim(), "reason must not have surrounding whitespace");
const isoTimestamp = z.iso.datetime({ offset: true });
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const positiveSafeInteger = z.number().int().positive().safe();
/** Keep this list in lockstep with HomeWorldService's closed neutral vocabulary. */
export const HOME_WORLD_EVIDENCE_COVERAGE_REASONS = [
  "bridge_not_ready",
  "missing_consistent_baseline",
  "baseline_time_unknown",
  "window_before_baseline",
  "history_gap",
  "journal_query_unavailable",
  "selection_too_broad",
  "query_truncated",
  "merge_truncated",
] as const satisfies readonly HomeWorldEvidenceCoverageReason[];
type MissingHomeWorldCoverageReason = Exclude<
  HomeWorldEvidenceCoverageReason,
  typeof HOME_WORLD_EVIDENCE_COVERAGE_REASONS[number]
>;
const homeWorldCoverageReasonSetIsComplete: MissingHomeWorldCoverageReason extends never ? true : never = true;
void homeWorldCoverageReasonSetIsComplete;

const coverageReasonSchema = z.enum(HOME_WORLD_EVIDENCE_COVERAGE_REASONS);
const freshnessSchema = z.enum(["fresh", "stale", "unknown"]);
const coverageSchema = z.enum(["complete", "partial", "unavailable"]);

const sourceProposalSchema = z.object({
  proposalId: boundedId,
  proposalRevision: positiveSafeInteger,
}).strict();

const assessmentIdentityRefSchema = z.object({
  attestationId: boundedId,
  inputIdentity: sha256Digest,
}).strict();

const selectedHwCapabilityIdsSchema = z.array(boundedId).max(16);
const canonicalSelectedHwCapabilityIdsSchema = selectedHwCapabilityIdsSchema.superRefine((ids, ctx) => {
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", message: "selectedHwCapabilityIds must be unique" });
  }
  if (!isCanonicalStringOrder(ids)) {
    ctx.addIssue({ code: "custom", message: "selectedHwCapabilityIds must be in canonical capability order" });
  }
});

const watermarkSchema = z.object({
  bridgeId: boundedId,
  epochId: boundedId,
  lastSeq: z.number().int().nonnegative().safe(),
  lastSyncCompleteAt: isoTimestamp.optional(),
  freshness: freshnessSchema,
  gapCount: z.number().int().nonnegative().safe(),
}).strict();

const evidenceInputSchema = z.object({
  artifact: artifactRefSchema,
  attestationId: boundedId,
  capturedAt: isoTimestamp,
  source: z.literal("home-world-consistent-cut"),
  sourceProposal: sourceProposalSchema,
  proposalEvidenceIdentity: sha256Digest,
  selectedHwCapabilityIds: selectedHwCapabilityIdsSchema,
  watermarks: z.array(watermarkSchema).min(1).max(MAX_ASSESSMENT_WATERMARKS),
  coverage: coverageSchema,
  reasons: z.array(coverageReasonSchema).max(HOME_WORLD_EVIDENCE_COVERAGE_REASONS.length),
}).strict();

const evidenceSchema = z.preprocess(preflightForSchema, z.object({
  kind: z.literal("evidence-attestation"),
  attestationId: boundedId,
  artifact: artifactRefSchema,
  inputIdentity: sha256Digest,
  source: z.literal("home-world-consistent-cut"),
  sourceProposal: sourceProposalSchema,
  proposalEvidenceIdentity: sha256Digest,
  selectedHwCapabilityIds: canonicalSelectedHwCapabilityIdsSchema,
  capturedAt: isoTimestamp,
  watermarks: z.array(watermarkSchema).min(1).max(MAX_ASSESSMENT_WATERMARKS),
  coverage: coverageSchema,
  reasons: z.array(coverageReasonSchema).max(HOME_WORLD_EVIDENCE_COVERAGE_REASONS.length),
}).strict().superRefine((value, ctx) => {
  try {
    validateCoverage(value.coverage, value.reasons, value.watermarks);
    validateUnique(value.watermarks.map((item) => item.bridgeId), "bridge");
    if (!isCanonicalWatermarkOrder(value.watermarks)) {
      ctx.addIssue({ code: "custom", message: "Evidence watermarks must be in canonical bridge order" });
    }
    const expected = computeAssessmentInputIdentity("evidence", evidenceIdentityInput(value));
    if (value.inputIdentity !== expected) {
      ctx.addIssue({ code: "custom", message: "Assessment input identity does not match its canonical inputs" });
    }
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid evidence assessment" });
  }
}));

const riskInputSchema = z.object({
  artifact: artifactRefSchema,
  assessmentId: boundedId,
  assessedAt: isoTimestamp,
  evidence: assessmentIdentityRefSchema,
  authority: z.object({
    assessmentId: boundedId,
    inputIdentity: sha256Digest,
  }).strict(),
  conflictInputIdentity: sha256Digest,
  class: z.enum(["observe_or_notify", "comfort_reversible"]),
  reasons: z.array(boundedReason).max(MAX_ASSESSMENT_REASONS),
  policyId: boundedId,
  policyVersion: semverSchema,
}).strict();

const riskSchema = z.preprocess(preflightForSchema, z.object({
  kind: z.literal("risk-assessment"),
  assessmentId: boundedId,
  artifact: artifactRefSchema,
  inputIdentity: sha256Digest,
  evidence: assessmentIdentityRefSchema,
  authority: z.object({
    assessmentId: boundedId,
    inputIdentity: sha256Digest,
  }).strict(),
  conflictInputIdentity: sha256Digest,
  class: z.enum(["observe_or_notify", "comfort_reversible"]),
  reasons: z.array(boundedReason).max(MAX_ASSESSMENT_REASONS),
  policyId: boundedId,
  policyVersion: semverSchema,
  requiresHumanApproval: z.literal(true),
  assessedAt: isoTimestamp,
}).strict().superRefine((value, ctx) => {
  try {
    const expected = computeAssessmentInputIdentity("risk", riskIdentityInput(value));
    if (value.inputIdentity !== expected) {
      ctx.addIssue({ code: "custom", message: "Assessment input identity does not match its canonical inputs" });
    }
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid risk assessment" });
  }
}));

const authorityCandidateSchema = z.object({
  actionAuthorityCandidateId: boundedId,
  hwCapabilityId: boundedId,
  status: z.enum(["available", "unavailable", "not_approved"]),
}).strict();

const authorityInputSchema = z.object({
  artifact: artifactRefSchema,
  assessmentId: boundedId,
  assessedAt: isoTimestamp,
  authorityRegistryIdentity: sha256Digest,
  candidates: z.array(authorityCandidateSchema).max(MAX_AUTHORITY_CANDIDATES),
  checkedWatermarks: z.array(watermarkSchema).max(MAX_ASSESSMENT_WATERMARKS),
}).strict();

const authorityScopeSchema = z.object({
  // An explicit empty scope is valid for notify-only artifacts. The field
  // remains required so callers cannot omit authority scope accidentally.
  hwCapabilityIds: z.array(boundedId).max(MAX_AUTHORITY_CANDIDATES),
}).strict();

const authoritySchema = z.preprocess(preflightForSchema, z.object({
  kind: z.literal("authority-assessment"),
  assessmentId: boundedId,
  artifact: artifactRefSchema,
  inputIdentity: sha256Digest,
  authorityRegistryIdentity: sha256Digest,
  candidates: z.array(authorityCandidateSchema).max(MAX_AUTHORITY_CANDIDATES),
  checkedWatermarks: z.array(watermarkSchema).max(MAX_ASSESSMENT_WATERMARKS),
  assessedAt: isoTimestamp,
}).strict().superRefine((value, ctx) => {
  try {
    validateUnique(value.candidates.map((item) => item.actionAuthorityCandidateId), "candidate");
    validateUnique(value.checkedWatermarks.map((item) => item.bridgeId), "bridge");
    if (!isCanonicalCandidateOrder(value.candidates)) {
      ctx.addIssue({ code: "custom", message: "Authority candidates must be in canonical candidate order" });
    }
    if (!isCanonicalWatermarkOrder(value.checkedWatermarks)) {
      ctx.addIssue({ code: "custom", message: "Checked watermarks must be in canonical bridge order" });
    }
    const expected = computeAssessmentInputIdentity("authority", authorityIdentityInput(value));
    if (value.inputIdentity !== expected) {
      ctx.addIssue({ code: "custom", message: "Assessment input identity does not match its canonical inputs" });
    }
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid authority assessment" });
  }
}));

export const artifactEvidenceAttestationSchema = evidenceSchema;
export const artifactRiskAssessmentSchema = riskSchema;
export const artifactAuthorityAssessmentSchema = authoritySchema;
export const artifactEvidenceSchema = artifactEvidenceAttestationSchema;
export const artifactRiskSchema = artifactRiskAssessmentSchema;
export const artifactAuthoritySchema = artifactAuthorityAssessmentSchema;
export const artifactWatermarkSchema = watermarkSchema;
export const artifactAuthorityCandidateSchema = authorityCandidateSchema;
export const ArtifactEvidenceAttestationSchema = artifactEvidenceAttestationSchema;
export const ArtifactRiskAssessmentSchema = artifactRiskAssessmentSchema;
export const ArtifactAuthorityAssessmentSchema = artifactAuthorityAssessmentSchema;

export type ArtifactEvidenceAttestation = z.infer<typeof evidenceSchema>;
export type ArtifactRiskAssessment = z.infer<typeof riskSchema>;
export type ArtifactAuthorityAssessment = z.infer<typeof authoritySchema>;
export type ArtifactEvidenceInput = z.input<typeof evidenceInputSchema>;
export type ArtifactRiskInput = z.input<typeof riskInputSchema>;
export type ArtifactAuthorityInput = z.input<typeof authorityInputSchema>;

export class ArtifactAssessmentError extends Error {
  readonly code:
    | "invalid_assessment"
    | "invalid_coverage"
    | "duplicate_bridge"
    | "duplicate_reason"
    | "duplicate_candidate"
    | "duplicate_capability"
    | "duplicate_scope"
    | "out_of_scope"
    | "identity_mismatch"
    | "resource_exhausted";

  constructor(
    code: ArtifactAssessmentError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ArtifactAssessmentError";
    this.code = code;
  }
}

/**
 * Canonical JSON for an already validated, neutral assessment input.
 * Objects are sorted by Unicode code point; arrays retain semantic order.
 */
export function canonicalAssessmentInput(input: unknown): string {
  try {
    return canonicalHubJson(input);
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw new ArtifactAssessmentError(
        error.code === "resource_exhausted" ? "resource_exhausted" : "invalid_assessment",
        error.message,
      );
    }
    throw new ArtifactAssessmentError("invalid_assessment", "Assessment input is not canonicalizable");
  }
}

/** Computes the Hub-owned digest for the exact approved Proposal evidence envelope. */
export function computeProposalEvidenceIdentity(input: unknown): string {
  return computeCanonicalDigest({ kind: "proposal-evidence", input });
}

/** Computes the Hub-owned digest for the exact conflict assessment/query input. */
export function computeConflictInputIdentity(input: unknown): string {
  return computeCanonicalDigest({ kind: "conflict-input", input });
}

function computeCanonicalDigest(input: unknown): string {
  const canonical = canonicalAssessmentInput(input);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** Compute the stable identity of Hub-owned dynamic assessment inputs. */
export function computeAssessmentInputIdentity(
  kind: "evidence" | "risk" | "authority",
  input: unknown,
): string {
  const canonical = canonicalAssessmentInput({ kind, input: normalizeIdentityInput(kind, input) });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function createArtifactEvidenceAttestation(
  input: ArtifactEvidenceInput,
): ArtifactEvidenceAttestation {
  const parsed = parseInput(evidenceInputSchema, input);
  const watermarks = sortWatermarks(parsed.watermarks);
  validateUnique(parsed.selectedHwCapabilityIds, "capability");
  const selectedHwCapabilityIds = sortCapabilityIds(parsed.selectedHwCapabilityIds);
  validateCoverage(parsed.coverage, parsed.reasons, watermarks);
  validateUnique(watermarks.map((item) => item.bridgeId), "bridge");

  const output = evidenceSchema.parse({
    kind: "evidence-attestation",
    ...parsed,
    selectedHwCapabilityIds,
    watermarks,
    inputIdentity: computeAssessmentInputIdentity("evidence", evidenceIdentityInput({
      ...parsed,
      selectedHwCapabilityIds,
      watermarks,
    })),
  });
  return freezeDeep(output);
}

export function createArtifactRiskAssessment(
  input: ArtifactRiskInput,
): ArtifactRiskAssessment {
  const parsed = parseInput(riskInputSchema, input);
  const output = riskSchema.parse({
    kind: "risk-assessment",
    ...parsed,
    requiresHumanApproval: true,
    inputIdentity: computeAssessmentInputIdentity("risk", riskIdentityInput(parsed)),
  });
  return freezeDeep(output);
}

export interface ArtifactAuthorityScope {
  readonly hwCapabilityIds: readonly string[];
}

export function createArtifactAuthorityAssessment(
  input: ArtifactAuthorityInput,
  scope: ArtifactAuthorityScope,
): ArtifactAuthorityAssessment {
  const parsed = parseInput(authorityInputSchema, input);
  const parsedScope = parseInput(authorityScopeSchema, scope);
  validateUnique(parsedScope.hwCapabilityIds, "scope");
  validateUnique(parsed.candidates.map((item) => item.actionAuthorityCandidateId), "candidate");
  const allowed = new Set(parsedScope.hwCapabilityIds);
  for (const candidate of parsed.candidates) {
    if (!allowed.has(candidate.hwCapabilityId)) {
      throw new ArtifactAssessmentError(
        "out_of_scope",
        "Authority candidate is outside the supplied capability scope",
      );
    }
  }
  const candidates = sortAuthorityCandidates(parsed.candidates);
  const checkedWatermarks = sortWatermarks(parsed.checkedWatermarks);
  validateUnique(checkedWatermarks.map((item) => item.bridgeId), "bridge");

  const output = authoritySchema.parse({
    kind: "authority-assessment",
    ...parsed,
    candidates,
    checkedWatermarks,
    inputIdentity: computeAssessmentInputIdentity("authority", authorityIdentityInput({
      ...parsed,
      candidates,
      checkedWatermarks,
    })),
  });
  return freezeDeep(output);
}

export const createEvidenceAttestation = createArtifactEvidenceAttestation;
export const createRiskAssessment = createArtifactRiskAssessment;
export const createAuthorityAssessment = createArtifactAuthorityAssessment;
export const canonicalInputIdentity = computeAssessmentInputIdentity;

/** Parse and re-verify an immutable evidence row from a durable boundary. */
export function parseArtifactEvidenceAttestation(input: unknown): ArtifactEvidenceAttestation {
  const parsed = parseInput(evidenceSchema, input);
  validateCoverage(parsed.coverage, parsed.reasons, parsed.watermarks);
  validateUnique(parsed.selectedHwCapabilityIds, "capability");
  validateUnique(parsed.watermarks.map((item) => item.bridgeId), "bridge");
  assertInputIdentity(parsed.inputIdentity, "evidence", evidenceIdentityInput(parsed));
  return freezeDeep(parsed);
}

/** Parse and re-verify an immutable risk row from a durable boundary. */
export function parseArtifactRiskAssessment(input: unknown): ArtifactRiskAssessment {
  const parsed = parseInput(riskSchema, input);
  assertInputIdentity(parsed.inputIdentity, "risk", riskIdentityInput(parsed));
  return freezeDeep(parsed);
}

/** Parse and re-verify an immutable authority row from a durable boundary. */
export function parseArtifactAuthorityAssessment(input: unknown): ArtifactAuthorityAssessment {
  const parsed = parseInput(authoritySchema, input);
  validateUnique(parsed.candidates.map((item) => item.actionAuthorityCandidateId), "candidate");
  validateUnique(parsed.checkedWatermarks.map((item) => item.bridgeId), "bridge");
  assertInputIdentity(parsed.inputIdentity, "authority", authorityIdentityInput(parsed));
  return freezeDeep(parsed);
}

/** Convenient aliases for callers that use the shorter assessment terminology. */
export const evidenceAttestationSchema = artifactEvidenceAttestationSchema;
export const riskAssessmentSchema = artifactRiskAssessmentSchema;
export const authorityAssessmentSchema = artifactAuthorityAssessmentSchema;

function evidenceIdentityInput(
  input: Pick<ArtifactEvidenceInput, "artifact" | "source" | "sourceProposal" | "proposalEvidenceIdentity" | "selectedHwCapabilityIds" | "watermarks" | "coverage" | "reasons">,
): unknown {
  return {
    artifact: input.artifact,
    source: input.source,
    sourceProposal: input.sourceProposal,
    proposalEvidenceIdentity: input.proposalEvidenceIdentity,
    selectedHwCapabilityIds: sortCapabilityIds(input.selectedHwCapabilityIds),
    watermarks: sortWatermarks(input.watermarks),
    coverage: input.coverage,
    reasons: input.reasons,
  };
}

function riskIdentityInput(
  input: Pick<ArtifactRiskInput, "artifact" | "evidence" | "authority" | "conflictInputIdentity" | "class" | "reasons" | "policyId" | "policyVersion">,
): unknown {
  return {
    artifact: input.artifact,
    evidence: input.evidence,
    authority: input.authority,
    conflictInputIdentity: input.conflictInputIdentity,
    class: input.class,
    reasons: input.reasons,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    requiresHumanApproval: true,
  };
}

function authorityIdentityInput(
  input: Pick<ArtifactAuthorityInput, "artifact" | "authorityRegistryIdentity" | "candidates" | "checkedWatermarks">,
): unknown {
  return {
    artifact: input.artifact,
    authorityRegistryIdentity: input.authorityRegistryIdentity,
    candidates: sortAuthorityCandidates(input.candidates),
    checkedWatermarks: sortWatermarks(input.checkedWatermarks),
  };
}

function normalizeIdentityInput(
  kind: "evidence" | "risk" | "authority",
  input: unknown,
): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (kind === "evidence" && Array.isArray(record.watermarks)) {
    return { ...record, watermarks: sortUnknownRecords(record.watermarks, "bridgeId") };
  }
  if (kind === "authority") {
    return {
      ...record,
      candidates: Array.isArray(record.candidates)
        ? sortUnknownRecords(record.candidates, "actionAuthorityCandidateId", "hwCapabilityId")
        : record.candidates,
      checkedWatermarks: Array.isArray(record.checkedWatermarks)
        ? sortUnknownRecords(record.checkedWatermarks, "bridgeId")
        : record.checkedWatermarks,
    };
  }
  return input;
}

function sortWatermarks<T extends { readonly bridgeId: string }>(watermarks: readonly T[]): T[] {
  return [...watermarks].sort((left, right) => compareUnicodeCodePoints(left.bridgeId, right.bridgeId));
}

function sortCapabilityIds(ids: readonly string[]): string[] {
  return [...ids].sort(compareUnicodeCodePoints);
}

function isCanonicalStringOrder(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || compareUnicodeCodePoints(values[index - 1]!, value) <= 0);
}

function sortAuthorityCandidates<T extends {
  readonly actionAuthorityCandidateId: string;
  readonly hwCapabilityId: string;
}>(candidates: readonly T[]): T[] {
  return [...candidates].sort((left, right) => compareUnicodeCodePoints(
    `${left.actionAuthorityCandidateId}\u0000${left.hwCapabilityId}`,
    `${right.actionAuthorityCandidateId}\u0000${right.hwCapabilityId}`,
  ));
}

function isCanonicalWatermarkOrder<T extends { readonly bridgeId: string }>(watermarks: readonly T[]): boolean {
  return watermarks.every((watermark, index) =>
    index === 0 || compareUnicodeCodePoints(watermarks[index - 1]!.bridgeId, watermark.bridgeId) <= 0,
  );
}

function isCanonicalCandidateOrder<T extends {
  readonly actionAuthorityCandidateId: string;
  readonly hwCapabilityId: string;
}>(candidates: readonly T[]): boolean {
  return candidates.every((candidate, index) =>
    index === 0 || compareUnicodeCodePoints(
      `${candidates[index - 1]!.actionAuthorityCandidateId}\u0000${candidates[index - 1]!.hwCapabilityId}`,
      `${candidate.actionAuthorityCandidateId}\u0000${candidate.hwCapabilityId}`,
    ) <= 0,
  );
}

function sortUnknownRecords(
  values: readonly unknown[],
  primaryKey: string,
  secondaryKey?: string,
): unknown[] {
  if (!values.every((value) => value !== null && typeof value === "object" && !Array.isArray(value))) return [...values];
  return [...values].sort((left, right) => {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftPrimary = typeof leftRecord[primaryKey] === "string" ? leftRecord[primaryKey] : "";
    const rightPrimary = typeof rightRecord[primaryKey] === "string" ? rightRecord[primaryKey] : "";
    const primaryDifference = compareUnicodeCodePoints(leftPrimary, rightPrimary);
    if (primaryDifference !== 0 || secondaryKey === undefined) return primaryDifference;
    const leftSecondary = typeof leftRecord[secondaryKey] === "string" ? leftRecord[secondaryKey] : "";
    const rightSecondary = typeof rightRecord[secondaryKey] === "string" ? rightRecord[secondaryKey] : "";
    return compareUnicodeCodePoints(leftSecondary, rightSecondary);
  });
}

function assertInputIdentity(
  actual: string,
  kind: "evidence" | "risk" | "authority",
  input: unknown,
): void {
  const expected = computeAssessmentInputIdentity(kind, input);
  if (actual !== expected) {
    throw new ArtifactAssessmentError("identity_mismatch", "Assessment input identity does not match its canonical inputs");
  }
}

function validateCoverage(
  coverage: z.infer<typeof coverageSchema>,
  reasons: readonly string[],
  watermarks: readonly z.infer<typeof watermarkSchema>[],
): void {
  validateUnique(reasons, "reason");
  if (coverage === "complete" && reasons.length !== 0) {
    throw new ArtifactAssessmentError("invalid_coverage", "Complete evidence cannot carry coverage reasons");
  }
  if (coverage === "complete" && watermarks.some((watermark) => watermark.freshness !== "fresh" || watermark.gapCount !== 0)) {
    throw new ArtifactAssessmentError(
      "invalid_coverage",
      "Complete evidence requires fresh, gap-free bridge watermarks",
    );
  }
  if (coverage !== "complete" && reasons.length === 0) {
    throw new ArtifactAssessmentError("invalid_coverage", "Partial or unavailable evidence requires a closed coverage reason");
  }
}

function validateUnique(values: readonly string[], kind: "bridge" | "reason" | "candidate" | "capability" | "scope"): void {
  if (new Set(values).size === values.length) return;
  const code = kind === "bridge"
    ? "duplicate_bridge"
    : kind === "reason"
      ? "duplicate_reason"
      : kind === "scope"
        ? "duplicate_scope"
        : kind === "capability"
          ? "duplicate_capability"
        : "duplicate_candidate";
  throw new ArtifactAssessmentError(code, `Assessment contains duplicate ${kind} entries`);
}

function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  try {
    preflightAssessmentInput(input);
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ArtifactAssessmentError) throw error;
    throw new ArtifactAssessmentError("invalid_assessment", error instanceof Error ? error.message : "Invalid assessment input");
  }
}

/**
 * Walk untrusted input before nested Zod parsing. This returns the original
 * value intentionally: unknown fields are never stripped or normalized.
 */
export function preflightAssessmentInput(input: unknown): unknown {
  canonicalAssessmentInput(input);
  return input;
}

function preflightForSchema(input: unknown, ctx: RefinementCtx): unknown {
  try {
    return preflightAssessmentInput(input);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid assessment input",
    });
    return z.NEVER;
  }
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

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested);
  return value;
}
