import { createHash } from "node:crypto";

import { HistoryRangeSchema, semverSchema } from "@hob/bridge-contract";
import { z } from "zod";

import { canonicalHubJson } from "../foundation/canonical-json.js";
import {
  neutralScalarSchema,
} from "./artifact-compiler-contract.js";
import {
  artifactRefSchema,
} from "./neutral-artifact.js";

export const MAX_HISTORY_REPLAY_REFS = 200;
export const MAX_HISTORY_REPLAY_COVERAGE = 16;
export const MAX_HISTORY_REPLAY_COUNT = 200;

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_ID_BYTES = 200;
const MAX_REPLAY_CANONICAL_BYTES = 64 * 1024;

const historyReplayReasonValues = [
  "bridge_not_ready",
  "missing_consistent_baseline",
  "journal_query_unavailable",
  "retention_floor_unknown",
  "empty_or_purged",
  "history_unavailable",
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
  "history_gap",
  "query_truncated",
  "history_range_unavailable",
  "replay_mismatch",
  "evaluator_unavailable",
] as const;

export const MAX_HISTORY_REPLAY_REASONS = historyReplayReasonValues.length;
export const HISTORY_REPLAY_REASONS = Object.freeze(historyReplayReasonValues);
export const historyReplayReasonSchema = z.enum(historyReplayReasonValues);
export const HistoryReplayReasonSchema = historyReplayReasonSchema;
export type HistoryReplayReason = z.infer<typeof historyReplayReasonSchema>;

const boundedIdSchema = z.string()
  .min(1)
  .max(MAX_ID_BYTES)
  .refine((value) => value.trim() === value, "identifier must not have surrounding whitespace")
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES, "identifier exceeds the byte budget");
const digestSchema = z.string().regex(SHA256_DIGEST);
const positiveSafeIntegerSchema = z.number().int().positive().safe();
const boundedCountSchema = z.number().int().nonnegative().max(MAX_HISTORY_REPLAY_COUNT).safe();
const utcTimestampSchema = z.iso.datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "timestamp must use UTC");
const sourceRangeSchema = HistoryRangeSchema;

const artifactIdentitySchema = artifactRefSchema;
const proposalIdentitySchema = z.object({
  id: boundedIdSchema,
  revision: positiveSafeIntegerSchema,
  proposalEvidenceIdentity: digestSchema,
}).strict();
const preparationIdentitySchema = z.object({
  resultId: digestSchema,
  inputIdentity: digestSchema,
}).strict();

const importedReferenceSchema = z.object({
  bridgeId: boundedIdSchema,
  hwId: boundedIdSchema,
  capabilityId: boundedIdSchema,
  observedAt: utcTimestampSchema,
  source: z.literal("imported-history"),
  origin: z.literal("imported"),
  importId: boundedIdSchema,
  historySeq: positiveSafeIntegerSchema,
  sourceRange: sourceRangeSchema,
}).strict();

const neutralSampleSchema = z.object({
  bridgeId: boundedIdSchema,
  importId: boundedIdSchema,
  historySeq: positiveSafeIntegerSchema,
  sourceTs: utcTimestampSchema,
  sourceTsQuality: z.literal("platform"),
  value: neutralScalarSchema,
}).strict();

const coverageSchema = z.object({
  bridgeId: boundedIdSchema,
  status: z.enum(["partial", "unavailable"]),
  reasons: z.array(historyReplayReasonSchema).min(1).max(MAX_HISTORY_REPLAY_REASONS),
}).strict();

const evaluatorSchema = z.object({
  id: boundedIdSchema,
  version: semverSchema,
}).strict();

const inputBodySchema = z.object({
  artifact: artifactIdentitySchema,
  proposal: proposalIdentitySchema,
  compile: preparationIdentitySchema,
  dryRun: preparationIdentitySchema,
  refs: z.array(importedReferenceSchema).max(MAX_HISTORY_REPLAY_REFS),
  samples: z.array(neutralSampleSchema).max(MAX_HISTORY_REPLAY_REFS),
  coverage: z.array(coverageSchema).min(1).max(MAX_HISTORY_REPLAY_COVERAGE),
  truncated: z.boolean(),
  evaluator: evaluatorSchema,
}).strict();

const inputSchema = inputBodySchema.extend({
  inputIdentity: digestSchema,
}).strict();

const evaluationSchema = z.object({
  status: z.enum(["passed", "failed", "unavailable"]),
  matchedSampleCount: boundedCountSchema,
  triggerCount: boundedCountSchema,
  actionCount: boundedCountSchema,
  reasons: z.array(historyReplayReasonSchema).max(MAX_HISTORY_REPLAY_REASONS),
}).strict();

const countsSchema = z.object({
  referenceCount: boundedCountSchema,
  sampleCount: boundedCountSchema,
  matchedSampleCount: boundedCountSchema,
  triggerCount: boundedCountSchema,
  actionCount: boundedCountSchema,
}).strict();

const resultBodySchema = z.object({
  kind: z.literal("history-replay-attestation"),
  artifact: artifactIdentitySchema,
  proposal: proposalIdentitySchema,
  compile: preparationIdentitySchema,
  dryRun: preparationIdentitySchema,
  inputIdentity: digestSchema,
  evaluator: evaluatorSchema,
  status: z.enum(["passed", "failed", "unavailable"]),
  coverage: z.enum(["partial", "unavailable"]),
  truncated: z.boolean(),
  counts: countsSchema,
  reasons: z.array(historyReplayReasonSchema).max(MAX_HISTORY_REPLAY_REASONS),
  writesPerformed: z.literal(false),
}).strict();

const resultSchema = resultBodySchema.extend({
  resultId: digestSchema,
}).strict();

export const historyReplayInputSchema = inputSchema;
export const HistoryReplayInputSchema = inputSchema;
export const historyReplayResultSchema = resultSchema;
export const HistoryReplayResultSchema = resultSchema;
export const historyReplayAttestationSchema = resultSchema;
export const HistoryReplayAttestationSchema = resultSchema;

export type HistoryReplayInputDraft = z.input<typeof inputBodySchema>;
export type HistoryReplayInput = z.infer<typeof inputSchema>;
export type HistoryReplayImportedReference = z.infer<typeof importedReferenceSchema>;
export type HistoryReplayNeutralSample = z.infer<typeof neutralSampleSchema>;
export type HistoryReplayCoverage = z.infer<typeof coverageSchema>;
export type HistoryReplayEvaluator = z.infer<typeof evaluatorSchema>;
export type HistoryReplayEvaluation = z.infer<typeof evaluationSchema>;
export type HistoryReplayResultBody = z.infer<typeof resultBodySchema>;
export type HistoryReplayResult = z.infer<typeof resultSchema>;
export type HistoryReplayAttestation = HistoryReplayResult;

export class HistoryReplayContractError extends TypeError {
  readonly code: "invalid_contract" | "identity_mismatch";

  constructor(code: "invalid_contract" | "identity_mismatch", message: string) {
    super(message);
    this.name = "HistoryReplayContractError";
    this.code = code;
  }
}

/** Parse and freeze one exact, bounded replay input. */
export function parseHistoryReplayInput(input: unknown): HistoryReplayInput {
  const parsed = parseSchema(inputSchema, input, "History replay input");
  const normalized = normalizeInputBody(omitOwnKey(parsed, "inputIdentity") as HistoryReplayInputDraft);
  const expected = computeInputIdentityFromBody(normalized);
  if (parsed.inputIdentity !== expected) {
    throw new HistoryReplayContractError("identity_mismatch", "History replay input identity does not match its canonical inputs");
  }
  return freezeDeep({ ...normalized, inputIdentity: parsed.inputIdentity });
}

/** Build the canonical input identity while accepting either a draft or a full input row. */
export function computeHistoryReplayInputIdentity(input: unknown): string {
  const body = inputBodyFromUnknown(input, "History replay input");
  return computeInputIdentityFromBody(normalizeInputBody(body));
}

/** Build a full input row and calculate its identity from the immutable body. */
export function createHistoryReplayInput(input: unknown): HistoryReplayInput {
  const body = parseInputBody(input);
  const normalized = normalizeInputBody(body);
  const inputIdentity = computeInputIdentityFromBody(normalized);
  return freezeDeep(inputSchema.parse({ ...normalized, inputIdentity }));
}

/** Create a bounded result from a pure evaluator decision. */
export function createHistoryReplayResult(input: unknown, evaluation: unknown): HistoryReplayResult {
  const parsedInput = parseHistoryReplayInput(input);
  const parsedEvaluation = parseEvaluation(evaluation);
  const sourceBlocked = replaySourceIsBlocked(parsedInput);
  const status = sourceBlocked ? "unavailable" : parsedEvaluation.status;
  const coverage = status === "passed" || status === "failed" ? "partial" : "unavailable";
  const reasons = mergeReasons([
    ...parsedInput.coverage.flatMap((item) => item.reasons),
    ...(parsedInput.truncated ? ["query_truncated" as const] : []),
    ...parsedEvaluation.reasons,
  ]);
  const body: HistoryReplayResultBody = {
    kind: "history-replay-attestation",
    artifact: parsedInput.artifact,
    proposal: parsedInput.proposal,
    compile: parsedInput.compile,
    dryRun: parsedInput.dryRun,
    inputIdentity: parsedInput.inputIdentity,
    evaluator: parsedInput.evaluator,
    status,
    coverage,
    truncated: parsedInput.truncated,
    counts: {
      referenceCount: parsedInput.refs.length,
      sampleCount: parsedInput.samples.length,
      matchedSampleCount: parsedEvaluation.matchedSampleCount,
      triggerCount: parsedEvaluation.triggerCount,
      actionCount: parsedEvaluation.actionCount,
    },
    reasons,
    writesPerformed: false,
  };
  validateResultSemantics(body);
  const resultId = computeHistoryReplayResultIdentity(body);
  return freezeDeep(resultSchema.parse({ ...body, resultId }));
}

/** Parse and re-verify a durable replay result. */
export function parseHistoryReplayResult(input: unknown): HistoryReplayResult {
  const parsed = parseSchema(resultSchema, input, "History replay result");
  const normalized: HistoryReplayResultBody = {
    ...parsed,
    reasons: sortReasons(parsed.reasons),
  };
  validateResultSemantics(normalized);
  const expected = computeHistoryReplayResultIdentity(normalized);
  if (parsed.resultId !== expected) {
    throw new HistoryReplayContractError("identity_mismatch", "History replay result identity does not match its canonical result");
  }
  return freezeDeep({ ...normalized, resultId: parsed.resultId });
}

/** Build a deterministic result identity from a result body or full row. */
export function computeHistoryReplayResultIdentity(input: unknown): string {
  const body = resultBodyFromUnknown(input);
  const parsed = parseSchema(resultBodySchema, body, "History replay result body");
  const normalized: HistoryReplayResultBody = {
    ...parsed,
    reasons: sortReasons(parsed.reasons),
  };
  validateResultSemantics(normalized);
  return digestCanonical({ kind: "artifact-history-replay-result", input: normalized });
}

export const createHistoryReplayAttestation = createHistoryReplayResult;
export const parseHistoryReplayAttestation = parseHistoryReplayResult;
export const computeHistoryReplayAttestationIdentity = computeHistoryReplayResultIdentity;

function parseInputBody(input: unknown): HistoryReplayInputDraft {
  const body = parseSchema(inputBodySchema, input, "History replay input");
  return normalizeInputBody(body);
}

function inputBodyFromUnknown(input: unknown, label: string): HistoryReplayInputDraft {
  const candidate = omitOwnKey(input, "inputIdentity");
  return parseSchema(inputBodySchema, candidate, label);
}

function resultBodyFromUnknown(input: unknown): unknown {
  return omitOwnKey(input, "resultId");
}

function parseEvaluation(input: unknown): HistoryReplayEvaluation {
  const parsed = parseSchema(evaluationSchema, input, "History replay evaluation");
  const reasons = sortReasons(parsed.reasons);
  if (parsed.status === "passed" && reasons.length > 0) {
    throw new HistoryReplayContractError("invalid_contract", "A passed replay evaluation cannot carry failure reasons");
  }
  if (parsed.status !== "passed" && reasons.length === 0) {
    throw new HistoryReplayContractError("invalid_contract", "A failed or unavailable replay evaluation requires a reason");
  }
  return freezeDeep({ ...parsed, reasons });
}

function normalizeInputBody(input: HistoryReplayInputDraft): HistoryReplayInputDraft {
  validateInputSemantics(input);
  return {
    ...input,
    refs: [...input.refs].sort(compareReferences),
    samples: [...input.samples].sort(compareSamples),
    coverage: input.coverage.map((item) => ({ ...item, reasons: sortReasons(item.reasons) })).sort(compareCoverage),
  };
}

function validateInputSemantics(input: HistoryReplayInputDraft | HistoryReplayInput): void {
  const refsByKey = new Map<string, HistoryReplayImportedReference>();
  const eventKeys = new Set<string>();
  for (const reference of input.refs) {
    const key = replayRefKey(reference);
    if (refsByKey.has(key)) throw new HistoryReplayContractError("invalid_contract", "History replay references must be unique");
    refsByKey.set(key, reference);
    const since = Date.parse(reference.sourceRange.since);
    const until = Date.parse(reference.sourceRange.until);
    const observedAt = Date.parse(reference.observedAt);
    if (!(since <= observedAt && observedAt < until)) {
      throw new HistoryReplayContractError("invalid_contract", "History replay observation must fall inside its exact source range");
    }
    const eventKey = `${reference.bridgeId}\u0000${reference.capabilityId}\u0000${reference.observedAt}`;
    if (eventKeys.has(eventKey)) {
      throw new HistoryReplayContractError("invalid_contract", "Cross-import observations must not overlap ambiguously");
    }
    eventKeys.add(eventKey);
  }

  const samplesByKey = new Map<string, HistoryReplayNeutralSample>();
  for (const sample of input.samples) {
    const key = replaySampleKey(sample);
    if (samplesByKey.has(key)) throw new HistoryReplayContractError("invalid_contract", "History replay samples must be unique");
    samplesByKey.set(key, sample);
    const reference = refsByKey.get(key);
    if (reference === undefined) {
      throw new HistoryReplayContractError("invalid_contract", "Every replay sample must match exactly one imported reference");
    }
    if (sample.sourceTs !== reference.observedAt) {
      throw new HistoryReplayContractError("invalid_contract", "Replay sample sourceTs must equal its imported observation time");
    }
    const since = Date.parse(reference.sourceRange.since);
    const until = Date.parse(reference.sourceRange.until);
    const sourceTs = Date.parse(sample.sourceTs);
    if (!(since <= sourceTs && sourceTs < until)) {
      throw new HistoryReplayContractError("invalid_contract", "Replay sample source time must fall inside its exact source range");
    }
  }
  if (refsByKey.size !== samplesByKey.size) {
    throw new HistoryReplayContractError("invalid_contract", "Imported references and replay samples must be one-to-one");
  }

  const coverageByBridge = new Map<string, HistoryReplayCoverage>();
  for (const item of input.coverage) {
    if (coverageByBridge.has(item.bridgeId)) {
      throw new HistoryReplayContractError("invalid_contract", "Replay coverage must contain one row per bridge");
    }
    validateReasons(item.reasons, "Replay coverage reasons");
    const bridgeHasRefs = input.refs.some((reference) => reference.bridgeId === item.bridgeId);
    if (item.status === "unavailable" && bridgeHasRefs) {
      throw new HistoryReplayContractError("invalid_contract", "Unavailable replay coverage cannot carry imported references");
    }
    coverageByBridge.set(item.bridgeId, item);
  }
  for (const reference of input.refs) {
    if (!coverageByBridge.has(reference.bridgeId)) {
      throw new HistoryReplayContractError("invalid_contract", "Replay coverage must include every imported reference bridge");
    }
  }
}

function validateResultSemantics(result: HistoryReplayResultBody): void {
  validateReasons(result.reasons, "History replay result reasons");
  const counts = result.counts;
  if (counts.matchedSampleCount > counts.sampleCount) {
    throw new HistoryReplayContractError("invalid_contract", "Matched replay samples cannot exceed sample count");
  }
  if (result.status === "passed") {
    if (result.coverage !== "partial" || result.truncated
      || counts.referenceCount === 0 || counts.sampleCount === 0
      || counts.matchedSampleCount !== counts.sampleCount
      || result.reasons.length !== 1
      || result.reasons[0] !== "retention_floor_unknown") {
      throw new HistoryReplayContractError("invalid_contract", "Only complete selected samples with retention uncertainty may pass replay");
    }
  } else if (result.status === "failed") {
    if (result.coverage !== "partial" || result.reasons.length === 0) {
      throw new HistoryReplayContractError("invalid_contract", "Failed replay results require partial coverage and a reason");
    }
  } else if (result.coverage !== "unavailable" || result.reasons.length === 0) {
    throw new HistoryReplayContractError("invalid_contract", "Unavailable replay results require unavailable coverage and a reason");
  }
}

function replaySourceIsBlocked(input: HistoryReplayInput): boolean {
  if (input.refs.length === 0 || input.samples.length === 0 || input.truncated) return true;
  const bridgesWithRefs = new Set(input.refs.map((reference) => reference.bridgeId));
  return input.coverage.some((item) => !bridgesWithRefs.has(item.bridgeId)
    || item.status === "unavailable"
    || item.reasons.some((reason) => reason !== "retention_floor_unknown"));
}

function validateReasons(reasons: readonly HistoryReplayReason[], label: string): void {
  if (new Set(reasons).size !== reasons.length) {
    throw new HistoryReplayContractError("invalid_contract", `${label} must be unique`);
  }
}

function computeInputIdentityFromBody(input: HistoryReplayInputDraft): string {
  return digestCanonical({ kind: "artifact-history-replay-input", input });
}

function digestCanonical(input: unknown): string {
  const canonical = canonicalHubJson(input);
  if (Buffer.byteLength(canonical, "utf8") > MAX_REPLAY_CANONICAL_BYTES) {
    throw new HistoryReplayContractError("invalid_contract", "History replay canonical input exceeds its byte budget");
  }
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function parseSchema<T extends z.ZodTypeAny>(schema: T, input: unknown, label: string): z.output<T> {
  try {
    canonicalHubJson(input);
    return schema.parse(input);
  } catch (error) {
    if (error instanceof HistoryReplayContractError) throw error;
    throw new HistoryReplayContractError("invalid_contract", error instanceof Error ? `${label} is invalid: ${error.message}` : `${label} is invalid`);
  }
}

function omitOwnKey(input: unknown, key: string): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  if (!Object.prototype.hasOwnProperty.call(input, key)) return input;
  const copy = { ...(input as Record<string, unknown>) };
  delete copy[key];
  return copy;
}

function replayRefKey(reference: Pick<HistoryReplayImportedReference, "bridgeId" | "importId" | "historySeq">): string {
  return `${reference.bridgeId}\u0000${reference.importId}\u0000${reference.historySeq}`;
}

function replaySampleKey(sample: Pick<HistoryReplayNeutralSample, "bridgeId" | "importId" | "historySeq">): string {
  return `${sample.bridgeId}\u0000${sample.importId}\u0000${sample.historySeq}`;
}

function compareReferences(left: HistoryReplayImportedReference, right: HistoryReplayImportedReference): number {
  return compareStrings(left.bridgeId, right.bridgeId)
    || compareStrings(left.capabilityId, right.capabilityId)
    || compareStrings(left.observedAt, right.observedAt)
    || compareStrings(left.importId, right.importId)
    || left.historySeq - right.historySeq;
}

function compareSamples(left: HistoryReplayNeutralSample, right: HistoryReplayNeutralSample): number {
  return compareStrings(left.bridgeId, right.bridgeId)
    || compareStrings(left.importId, right.importId)
    || left.historySeq - right.historySeq;
}

function compareCoverage(left: HistoryReplayCoverage, right: HistoryReplayCoverage): number {
  return compareStrings(left.bridgeId, right.bridgeId);
}

function sortReasons(reasons: readonly HistoryReplayReason[]): HistoryReplayReason[] {
  validateReasons(reasons, "Replay reasons");
  return [...reasons].sort(compareStrings);
}

function mergeReasons(reasons: readonly HistoryReplayReason[]): HistoryReplayReason[] {
  return [...new Set(reasons)].sort(compareStrings);
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
