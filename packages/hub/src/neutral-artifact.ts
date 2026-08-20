import { createHash } from "node:crypto";

import { z } from "zod";

const MAX_CANONICAL_BYTES = 64 * 1024;
const MAX_DEPTH = 12;
const MAX_FIELDS = 128;
const MAX_ARRAY_LENGTH = 64;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_ID_BYTES = 200;

const schemaVersion = z.literal("1");
const artifactKind = z.literal("event-condition-action");

const boundedId = z
  .string()
  .min(1)
  .max(MAX_ID_BYTES)
  .refine((value) => value.trim() === value && value.length > 0, "text must not have surrounding whitespace")
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES, "id must fit the UTF-8 byte budget");
const boundedText = (max: number) => z
  .string()
  .min(1)
  .max(max)
  .refine((value) => value.trim() === value, "text must not have surrounding whitespace");
const finiteNumber = z.number().finite();
const safePositiveInteger = z.number()
  .finite()
  .int()
  .refine(Number.isSafeInteger, "must be a safe integer")
  .positive();
const isoTimestamp = z.iso.datetime({ offset: true });
const contentHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const urlLikeLocator = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\b(?:data|javascript|mailto):|\bwww\.)/iu;
const neutralContentString = z.string().max(512)
  .refine((value) => !urlLikeLocator.test(value), "neutral behavior content cannot contain a URL");
const neutralNotificationText = boundedText(512)
  .refine((value) => !urlLikeLocator.test(value), "neutral behavior content cannot contain a URL");

export const artifactRefSchema = z.object({
  artifactId: boundedId,
  revision: safePositiveInteger,
  contentHash,
}).strict();

export const ArtifactRefSchema = artifactRefSchema;
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

const scalar = z.union([
  neutralContentString,
  finiteNumber,
  z.boolean(),
  z.null(),
]);

const capabilityRef = z.object({ hwCapabilityId: boundedId }).strict();
const actionTarget = z.object({ hwCapabilityId: boundedId }).strict();

const scheduleTrigger = z.object({
  kind: z.literal("schedule"),
  timezone: z.string().min(1).max(128).refine(isIanaTimezone, "timezone must be an IANA timezone"),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  at: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
}).strict().superRefine((trigger, ctx) => {
  if (new Set(trigger.daysOfWeek).size !== trigger.daysOfWeek.length) {
    ctx.addIssue({ code: "custom", path: ["daysOfWeek"], message: "daysOfWeek must not contain duplicates" });
  }
});

const capabilityChangedTrigger = z.object({
  kind: z.literal("capability_changed"),
  source: capabilityRef,
}).strict();

const trigger = z.discriminatedUnion("kind", [scheduleTrigger, capabilityChangedTrigger]);

const condition = z.object({
  kind: z.literal("capability_value"),
  source: capabilityRef,
  operator: z.enum(["equals", "not_equals", "greater_than", "less_than"]),
  value: scalar,
}).strict();

const action = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("set_level"),
    target: actionTarget,
    value: finiteNumber.min(0).max(1),
    transitionSeconds: finiteNumber.min(0).max(3_600).optional(),
  }).strict(),
  z.object({
    kind: z.literal("set_boolean"),
    target: actionTarget,
    value: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("notify_local"),
    message: neutralNotificationText,
  }).strict(),
]);

const rollback = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("restore_previous_state"),
    target: actionTarget,
    maxAgeSeconds: safePositiveInteger.max(86_400),
  }).strict(),
  z.object({ kind: z.literal("no_remote_change") }).strict(),
]);

const postcondition = z.object({
  kind: z.literal("capability_value"),
  source: capabilityRef,
  operator: z.enum(["equals", "not_equals", "greater_than", "less_than"]),
  value: scalar,
  withinSeconds: safePositiveInteger.max(300),
}).strict();

const artifactContentObjectSchema = z.object({
  trigger,
  conditions: z.array(condition).max(8),
  actions: z.array(action).min(1).max(4),
  rollback,
  postconditions: z.array(postcondition).max(4),
}).strict().superRefine((content, ctx) => {
  const deviceActions = content.actions.filter(isDeviceAction);
  const targetIds = new Set(deviceActions.map((item) => item.target.hwCapabilityId));
  if (targetIds.size > 1) {
    ctx.addIssue({ code: "custom", path: ["actions"], message: "Phase 1 permits at most one device target" });
  }

  const deviceTarget = deviceActions[0]?.target.hwCapabilityId;
  if (deviceTarget !== undefined) {
    if (content.rollback.kind !== "restore_previous_state") {
      ctx.addIssue({ code: "custom", path: ["rollback"], message: "device actions require restore_previous_state" });
    } else if (content.rollback.target.hwCapabilityId !== deviceTarget) {
      ctx.addIssue({ code: "custom", path: ["rollback", "target"], message: "rollback target must match the device action target" });
    }
    if (!content.postconditions.some((item) => item.source.hwCapabilityId === deviceTarget)) {
      ctx.addIssue({ code: "custom", path: ["postconditions"], message: "device actions require a matching postcondition" });
    }
  } else {
    if (content.rollback.kind !== "no_remote_change") {
      ctx.addIssue({ code: "custom", path: ["rollback"], message: "pure notifications require no_remote_change" });
    }
    if (content.postconditions.length > 0) {
      ctx.addIssue({ code: "custom", path: ["postconditions"], message: "pure notifications cannot have device postconditions" });
    }
  }
});

export const artifactContentSchema = z.preprocess((value, ctx) => {
  const budget = inspectResourceBudget(value);
  if (!budget.ok) {
    ctx.addIssue({ code: "custom", message: budget.code });
    return z.NEVER;
  }
  return value;
}, artifactContentObjectSchema);

export const ArtifactContentSchema = artifactContentSchema;

const sourceProposal = z.object({
  proposalId: boundedId,
  proposalRevision: safePositiveInteger,
}).strict();

const artifactRevisionObjectSchema = z.object({
  schemaVersion,
  kind: artifactKind,
  artifactId: boundedId,
  revision: safePositiveInteger,
  title: boundedText(120),
  summary: boundedText(1_000),
  sourceProposal,
  content: artifactContentSchema,
  createdAt: isoTimestamp,
  contentHash,
}).strict();

const createArtifactRevisionObjectSchema = artifactRevisionObjectSchema.omit({ contentHash: true });
const verifiedArtifactRevisionSchema = artifactRevisionObjectSchema.superRefine((artifact, ctx) => {
  if (hashStablePayload(artifact) !== artifact.contentHash) {
    ctx.addIssue({ code: "custom", message: "hash_mismatch" });
  }
});

/** Runtime budget applied before the nested Zod schema is traversed. */
export const ARTIFACT_RESOURCE_BUDGET = Object.freeze({
  maxCanonicalBytes: MAX_CANONICAL_BYTES,
  maxDepth: MAX_DEPTH,
  maxFields: MAX_FIELDS,
  maxArrayLength: MAX_ARRAY_LENGTH,
  maxStringBytes: MAX_STRING_BYTES,
});

export type ArtifactRevision = z.infer<typeof artifactRevisionObjectSchema>;
export type CreateArtifactRevisionInput = Omit<ArtifactRevision, "contentHash">;
export type ArtifactContent = z.infer<typeof artifactContentSchema>;
export type ArtifactTrigger = z.infer<typeof trigger>;
export type ArtifactCondition = z.infer<typeof condition>;
export type ArtifactAction = z.infer<typeof action>;
export type ArtifactRollback = z.infer<typeof rollback>;
export type ArtifactPostcondition = z.infer<typeof postcondition>;

export const artifactRevisionSchema = z.preprocess((value, ctx) => {
  const budget = inspectResourceBudget(value);
  if (!budget.ok) {
    ctx.addIssue({ code: "custom", message: budget.code });
    return z.NEVER;
  }
  return value;
}, verifiedArtifactRevisionSchema);

export const ArtifactRevisionSchema = artifactRevisionSchema;

export type ArtifactValidationErrorCode =
  | "resource_exhausted"
  | "invalid_artifact"
  | "hash_mismatch"
  | "duplicate_json_key"
  | "invalid_json";

export class ArtifactValidationError extends TypeError {
  readonly code: ArtifactValidationErrorCode;

  constructor(code: ArtifactValidationErrorCode, message: string) {
    super(message);
    this.name = "ArtifactValidationError";
    this.code = code;
  }
}

export function createArtifactRevision(input: CreateArtifactRevisionInput): ArtifactRevision {
  const parsed = parseCreateInput(input);
  return {
    ...parsed,
    contentHash: hashStablePayload(parsed),
  };
}

/** Validates one review-only ECA content candidate without creating an Artifact revision. */
export function parseArtifactContent(value: unknown): ArtifactContent {
  assertResourceBudget(value);
  const parsed = artifactContentObjectSchema.safeParse(value);
  if (!parsed.success) {
    throw new ArtifactValidationError("invalid_artifact", "artifact content does not match the closed schema");
  }
  return parsed.data;
}

/** Parses and verifies one complete immutable revision, including its hash. */
export function parseArtifactRevision(value: unknown): ArtifactRevision {
  assertResourceBudget(value);
  const parsed = artifactRevisionObjectSchema.safeParse(value);
  if (!parsed.success) {
    throw new ArtifactValidationError("invalid_artifact", "artifact revision does not match the closed schema");
  }
  const expected = hashStablePayload(parsed.data);
  if (parsed.data.contentHash !== expected) {
    throw new ArtifactValidationError("hash_mismatch", "artifact content hash does not match canonical content");
  }
  return parsed.data;
}

/** Returns false for malformed, resource-exhausting, or hash-invalid input. */
export function verifyArtifactRevision(value: unknown): value is ArtifactRevision {
  try {
    parseArtifactRevision(value);
    return true;
  } catch {
    return false;
  }
}

/** Parses raw JSON while rejecting duplicate keys before JSON.parse last-wins behavior. */
export function parseArtifactJson(raw: string): ArtifactRevision {
  if (typeof raw !== "string") {
    throw new ArtifactValidationError("invalid_json", "artifact JSON must be a string");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_CANONICAL_BYTES) {
    throw new ArtifactValidationError("resource_exhausted", "artifact JSON exceeds the resource budget");
  }
  assertNoDuplicateJsonKeys(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ArtifactValidationError("invalid_json", "artifact JSON is malformed");
  }
  return parseArtifactRevision(parsed);
}

/** Returns canonical UTF-8 JSON input used for the stable content hash. */
export function canonicalArtifactPayload(value: ArtifactRevision | CreateArtifactRevisionInput): string {
  const parsed = "contentHash" in value
    ? parseArtifactRevision(value)
    : parseCreateInput(value);
  return canonicalJson(stablePayload(parsed));
}

export function computeArtifactContentHash(value: ArtifactRevision | CreateArtifactRevisionInput): string {
  const parsed = "contentHash" in value
    ? parseArtifactRevision(value)
    : parseCreateInput(value);
  return hashStablePayload(parsed);
}

export const artifactContentHash = computeArtifactContentHash;

function parseCreateInput(value: unknown): CreateArtifactRevisionInput {
  assertResourceBudget(value);
  const parsed = createArtifactRevisionObjectSchema.safeParse(value);
  if (!parsed.success) {
    throw new ArtifactValidationError("invalid_artifact", "artifact creation input does not match the closed schema");
  }
  return parsed.data;
}

function stablePayload(value: Pick<ArtifactRevision, "schemaVersion" | "kind" | "artifactId" | "revision" | "title" | "summary" | "sourceProposal" | "content">) {
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    artifactId: value.artifactId,
    revision: value.revision,
    title: value.title,
    summary: value.summary,
    sourceProposal: value.sourceProposal,
    content: value.content,
  };
}

function hashStablePayload(value: Pick<ArtifactRevision, "schemaVersion" | "kind" | "artifactId" | "revision" | "title" | "summary" | "sourceProposal" | "content">): string {
  const bytes = canonicalJson(stablePayload(value));
  if (Buffer.byteLength(bytes, "utf8") > MAX_CANONICAL_BYTES) {
    throw new ArtifactValidationError("resource_exhausted", "canonical artifact payload exceeds the resource budget");
  }
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  const normalized = canonicalValue(value, 0, new WeakSet<object>());
  const json = JSON.stringify(normalized);
  if (json === undefined) {
    throw new ArtifactValidationError("invalid_artifact", "artifact contains an unsupported JSON value");
  }
  return json;
}

function canonicalValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ArtifactValidationError("invalid_artifact", "artifact contains a non-finite number");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new ArtifactValidationError("invalid_artifact", "artifact contains an unsupported value");
  }
  if (depth > MAX_DEPTH) {
    throw new ArtifactValidationError("resource_exhausted", "artifact nesting exceeds the resource budget");
  }
  if (seen.has(value)) {
    throw new ArtifactValidationError("invalid_artifact", "artifact contains a cycle");
  }
  seen.add(value);
  let normalized: unknown;
  if (Array.isArray(value)) {
    normalized = value.map((item) => canonicalValue(item, depth + 1, seen));
  } else {
    const object = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort(compareCodePoints)) {
      output[key] = canonicalValue(object[key], depth + 1, seen);
    }
    normalized = output;
  }
  seen.delete(value);
  return normalized;
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

function isDeviceAction(value: ArtifactAction): value is Exclude<ArtifactAction, { kind: "notify_local" }> {
  return value.kind === "set_level" || value.kind === "set_boolean";
}

function isIanaTimezone(value: string): boolean {
  if (value !== "UTC" && !/^[A-Za-z0-9_.+-]+\/[A-Za-z0-9_.+\-]+(?:\/[A-Za-z0-9_.+\-]+)*$/.test(value)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

type BudgetResult = { ok: true } | { ok: false; code: "resource_exhausted" | "invalid_artifact" };

function inspectResourceBudget(value: unknown): BudgetResult {
  const state = { bytes: 0, fields: 0, strings: 0 };
  const seen = new WeakSet<object>();

  const visit = (candidate: unknown, depth: number): BudgetResult => {
    if (candidate === null) {
      state.bytes += 4;
    } else if (typeof candidate === "string") {
      const bytes = Buffer.byteLength(candidate, "utf8");
      state.strings += bytes;
      state.bytes += bytes + 2;
      if (bytes > MAX_STRING_BYTES || state.strings > MAX_CANONICAL_BYTES) return { ok: false, code: "resource_exhausted" };
    } else if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) return { ok: false, code: "invalid_artifact" };
      state.bytes += 8;
    } else if (typeof candidate === "boolean") {
      state.bytes += 5;
    } else if (typeof candidate === "object") {
      if (depth > MAX_DEPTH) return { ok: false, code: "resource_exhausted" };
      if (seen.has(candidate)) return { ok: false, code: "invalid_artifact" };
      seen.add(candidate);
      if (Array.isArray(candidate)) {
        if (candidate.length > MAX_ARRAY_LENGTH) return { ok: false, code: "resource_exhausted" };
        state.bytes += 2;
        for (const item of candidate) {
          const result = visit(item, depth + 1);
          if (!result.ok) return result;
        }
      } else {
        if (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null) {
          return { ok: false, code: "invalid_artifact" };
        }
        state.bytes += 2;
        for (const [key, child] of Object.entries(candidate)) {
          state.fields += 1;
          state.bytes += Buffer.byteLength(key, "utf8") + 3;
          if (state.fields > MAX_FIELDS) return { ok: false, code: "resource_exhausted" };
          const result = visit(child, depth + 1);
          if (!result.ok) return result;
        }
      }
      seen.delete(candidate);
    } else {
      return { ok: false, code: "invalid_artifact" };
    }
    return state.bytes > MAX_CANONICAL_BYTES
      ? { ok: false, code: "resource_exhausted" }
      : { ok: true };
  };

  return visit(value, 0);
}

function assertResourceBudget(value: unknown): void {
  const result = inspectResourceBudget(value);
  if (!result.ok) {
    throw new ArtifactValidationError(result.code, result.code === "resource_exhausted"
      ? "artifact exceeds the resource budget"
      : "artifact contains an unsupported value");
  }
}

function assertNoDuplicateJsonKeys(raw: string): void {
  let index = 0;

  const fail = (message = "artifact JSON is malformed"): never => {
    throw new ArtifactValidationError("invalid_json", message);
  };
  const skipWhitespace = (): void => {
    while (index < raw.length && /[\u0020\u0009\u000a\u000d]/.test(raw[index]!)) index += 1;
  };
  const parseString = (): string => {
    const start = index;
    if (raw[index] !== '"') fail();
    index += 1;
    while (index < raw.length) {
      const character = raw[index]!;
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(raw.slice(start, index)) as string;
        } catch {
          fail();
        }
      }
      if (character === "\\") {
        index += 2;
        if (index > raw.length) fail();
        continue;
      }
      if (character < " ") fail();
      index += 1;
    }
    return fail();
  };
  const parseValue = (): void => {
    skipWhitespace();
    const character = raw[index];
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (raw[index] === "}") {
        index += 1;
        return;
      }
      while (index < raw.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw new ArtifactValidationError("duplicate_json_key", "artifact JSON contains a duplicate object key");
        keys.add(key);
        skipWhitespace();
        if (raw[index] !== ":") fail();
        index += 1;
        parseValue();
        skipWhitespace();
        if (raw[index] === "}") {
          index += 1;
          return;
        }
        if (raw[index] !== ",") fail();
        index += 1;
      }
      fail();
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      if (raw[index] === "]") {
        index += 1;
        return;
      }
      while (index < raw.length) {
        parseValue();
        skipWhitespace();
        if (raw[index] === "]") {
          index += 1;
          return;
        }
        if (raw[index] !== ",") fail();
        index += 1;
      }
      fail();
    }
    if (character === '"') {
      parseString();
      return;
    }
    if (raw.startsWith("true", index)) {
      index += 4;
      return;
    }
    if (raw.startsWith("false", index)) {
      index += 5;
      return;
    }
    if (raw.startsWith("null", index)) {
      index += 4;
      return;
    }
    const number = raw.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (number !== undefined) {
      index += number.length;
      return;
    }
    fail();
  };

  parseValue();
  skipWhitespace();
  if (index !== raw.length) fail();
}
