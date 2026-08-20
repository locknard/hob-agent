import { createHash } from "node:crypto";

import { z, type ZodType } from "zod";

import { capabilitySemanticKindSchema, semverSchema } from "../../../contracts/bridge-contract.js";
import {
  artifactAuthorityAssessmentSchema,
  artifactEvidenceAttestationSchema,
  artifactRiskAssessmentSchema,
  artifactWatermarkSchema,
  type ArtifactAuthorityAssessment,
  type ArtifactEvidenceAttestation,
  type ArtifactRiskAssessment,
} from "./artifact-assessments.js";
import {
  artifactContentSchema,
  artifactRevisionSchema,
  type ArtifactAction,
  type ArtifactContent,
  type ArtifactRef,
  type ArtifactRevision,
} from "./neutral-artifact.js";

/** M3c's neutral compiler contract has the same bounded canonical envelope as M3b. */
export const MAX_COMPILER_CANONICAL_BYTES = 64 * 1024;
export const MAX_COMPILER_DEPTH = 16;
export const MAX_COMPILER_FIELDS = 128;
export const MAX_COMPILER_TOTAL_FIELDS = 512;
export const MAX_COMPILER_ARRAY_LENGTH = 64;
export const MAX_COMPILER_TOTAL_ARRAY_ITEMS = 256;
export const MAX_COMPILER_STRING_BYTES = 16 * 1024;
export const MAX_COMPILER_TOTAL_STRING_BYTES = 64 * 1024;
export const MAX_NEUTRAL_DEVICES = 16;
export const MAX_NEUTRAL_WATERMARKS = 16;
export const MAX_NEUTRAL_CONFLICTS = 20;
export const MAX_NEUTRAL_OPERATIONS = 20;
export const MAX_NEUTRAL_BLOCKING_REASONS = 20;
export const MAX_NEUTRAL_ACTION_COMPATIBILITY = 4;
export const MAX_NEUTRAL_PREDICATE_COMPATIBILITY = 12;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const URL_PATTERN = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\b(?:data|javascript|mailto):|\bwww\.)/iu;
const MAX_ID_BYTES = 200;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_NEUTRAL_TEXT = 512;

const forbiddenFieldNames = new Set([
  "accessToken",
  "adapterType",
  "apiKey",
  "attrs",
  "attributes",
  "bridgeRoute",
  "certificatePem",
  "command",
  "credential",
  "credentials",
  "entityId",
  "endpoint",
  "installationId",
  "nativeId",
  "nativeInstanceId",
  "nativeRoute",
  "password",
  "piid",
  "privateKey",
  "provider",
  "providerPayload",
  "raw",
  "rawAttr",
  "rawAttrs",
  "rawAttributes",
  "rawCommand",
  "refreshToken",
  "remoteInstanceId",
  "remoteRoute",
  "route",
  "ruleId",
  "secret",
  "secretText",
  "service",
  "serviceName",
  "siid",
  "shell",
  "script",
  "token",
  "url",
  "uri",
  "vendor",
]);

const boundedIdSchema = z.string()
  .min(1)
  .refine((value) => value === value.trim(), "identifier must not have surrounding whitespace")
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES, "identifier exceeds the UTF-8 byte budget")
  .refine((value) => !URL_PATTERN.test(value), "neutral identifiers cannot contain URLs");
const boundedTextSchema = z.string()
  .min(1)
  .max(MAX_NEUTRAL_TEXT)
  .refine((value) => value === value.trim(), "text must not have surrounding whitespace")
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES, "text exceeds the UTF-8 byte budget")
  .refine((value) => !URL_PATTERN.test(value), "neutral text cannot contain a URL");
const schemaNameSchema = z.string()
  .min(1)
  .max(MAX_NEUTRAL_TEXT)
  .refine((value) => value === value.trim(), "schema name must not have surrounding whitespace")
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES, "schema name exceeds the UTF-8 byte budget")
  .refine((value) => !URL_PATTERN.test(value), "schema name cannot contain a URL");
const digestSchema = z.string().regex(SHA256_PATTERN);
const finiteNumberSchema = z.number().finite();
const positiveSafeIntegerSchema = z.number().finite().int().positive().safe();
const nonNegativeSafeIntegerSchema = z.number().finite().int().nonnegative().safe();

export type ClosedReasonCode = z.infer<typeof closedReasonCodeSchema>;

/**
 * Closed reasons are deliberately neutral. Provider diagnostics, native rule
 * IDs, and model-authored explanations do not cross this boundary.
 */
export const closedReasonCodeSchema = z.enum([
  "artifact_invalid",
  "schema_mismatch",
  "semantic_mismatch",
  "target_invalid",
  "target_unavailable",
  "candidate_unavailable",
  "authority_unavailable",
  "evidence_unavailable",
  "risk_unavailable",
  "policy_blocked",
  "conflict_blocked",
  "foreign_catalog_unavailable",
  "foreign_catalog_stale",
  "world_cut_unavailable",
  "watermark_stale",
  "timezone_unavailable",
  "postcondition_invalid",
  "rollback_invalid",
  "compiler_dependency_unavailable",
  "missing_before",
  "not_ready",
  "duplicate",
  "possible_overlap",
  "stale_evidence",
  "existing_artifact",
  "foreign_rule",
  "schema_unsupported",
  "state_missing",
  "state_stale",
  "state_invalid",
  "value_unsupported",
  "value_invalid",
  "operator_unsupported",
  "predicate_type_mismatch",
  "set_level_unsupported",
  "action_mapping_unreviewed",
  "not_writable",
  "action_invalid",
]);
export const ClosedReasonCodeSchema = closedReasonCodeSchema;

export type NeutralScalar = z.infer<typeof neutralScalarSchema>;
export const neutralScalarSchema = z.union([
  z.string()
    .max(MAX_NEUTRAL_TEXT)
    .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES, "scalar string exceeds the byte budget")
    .refine((value) => !URL_PATTERN.test(value), "scalar string cannot contain a URL"),
  finiteNumberSchema,
  z.boolean(),
  z.null(),
]);
export const NeutralScalarSchema = neutralScalarSchema;

const neutralWatermarkSchemaValue = artifactWatermarkSchema;
export const neutralWatermarkSchema = neutralWatermarkSchemaValue;
export const NeutralWatermarkSchema = neutralWatermarkSchemaValue;
export type NeutralWatermark = z.infer<typeof neutralWatermarkSchemaValue>;

const neutralActionCompatibilityObjectSchema = z.object({
  order: positiveSafeIntegerSchema,
  kind: z.enum(["set_level", "set_boolean"]),
  status: z.enum(["compatible", "incompatible", "unavailable"]),
  reason: closedReasonCodeSchema.optional(),
  before: neutralScalarSchema.optional(),
  after: neutralScalarSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "compatible") {
    if (value.reason !== undefined) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Compatible action projections cannot carry a reason" });
    }
    if (value.before === undefined) {
      ctx.addIssue({ code: "custom", path: ["before"], message: "Compatible action projections require a neutral before value" });
    }
    if (value.after === undefined) {
      ctx.addIssue({ code: "custom", path: ["after"], message: "Compatible action projections require a neutral after value" });
    }
    if (value.kind === "set_boolean") {
      if (value.before !== undefined && typeof value.before !== "boolean") {
        ctx.addIssue({ code: "custom", path: ["before"], message: "Compatible set_boolean before value must be boolean" });
      }
      if (value.after !== undefined && typeof value.after !== "boolean") {
        ctx.addIssue({ code: "custom", path: ["after"], message: "Compatible set_boolean after value must be boolean" });
      }
    } else {
      if (value.before !== undefined && !isNormalizedLevel(value.before)) {
        ctx.addIssue({ code: "custom", path: ["before"], message: "Compatible set_level before value must be finite and within 0..1" });
      }
      if (value.after !== undefined && !isNormalizedLevel(value.after)) {
        ctx.addIssue({ code: "custom", path: ["after"], message: "Compatible set_level after value must be finite and within 0..1" });
      }
    }
  } else {
    if (value.reason === undefined) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Incompatible or unavailable action projections require a closed reason" });
    }
    if (value.before !== undefined) {
      ctx.addIssue({ code: "custom", path: ["before"], message: "Incompatible or unavailable action projections cannot carry a before value" });
    }
    if (value.after !== undefined) {
      ctx.addIssue({ code: "custom", path: ["after"], message: "Incompatible or unavailable action projections cannot carry an after value" });
    }
  }
});
const neutralActionCompatibilitySchemaObjectWithPreflight = z.preprocess(
  preflightForSchema,
  neutralActionCompatibilityObjectSchema,
);
export const neutralActionCompatibilitySchema = neutralActionCompatibilitySchemaObjectWithPreflight;
export const NeutralActionCompatibilitySchema = neutralActionCompatibilitySchema;
export const neutralActionCompatibilityResultSchema = neutralActionCompatibilitySchema;
export const NeutralActionCompatibilityResultSchema = neutralActionCompatibilitySchema;
export type NeutralActionCompatibility = z.infer<typeof neutralActionCompatibilityObjectSchema>;
export type NeutralActionCompatibilityResult = NeutralActionCompatibility;

const neutralActionCompatibilityListSchema = z.array(neutralActionCompatibilityObjectSchema)
  .max(MAX_NEUTRAL_ACTION_COMPATIBILITY)
  .superRefine((values, ctx) => {
    const orders = values.map((value) => value.order);
    if (new Set(orders).size !== orders.length) {
      ctx.addIssue({ code: "custom", message: "Action compatibility projection orders must be unique" });
    }
    for (let index = 1; index < orders.length; index += 1) {
      if (orders[index - 1]! >= orders[index]!) {
        ctx.addIssue({ code: "custom", message: "Action compatibility projection orders must be strictly increasing" });
        break;
      }
    }
  });

const neutralPredicateCompatibilityObjectSchema = z.object({
  phase: z.enum(["condition", "postcondition"]),
  order: positiveSafeIntegerSchema,
  status: z.enum(["compatible", "incompatible", "unavailable"]),
  reason: closedReasonCodeSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "compatible" && value.reason !== undefined) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "Compatible predicate projections cannot carry a reason" });
  }
  if (value.status !== "compatible" && value.reason === undefined) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "Incompatible or unavailable predicate projections require a closed reason" });
  }
});
const neutralPredicateCompatibilitySchemaObjectWithPreflight = z.preprocess(
  preflightForSchema,
  neutralPredicateCompatibilityObjectSchema,
);
export const neutralPredicateCompatibilitySchema = neutralPredicateCompatibilitySchemaObjectWithPreflight;
export const NeutralPredicateCompatibilitySchema = neutralPredicateCompatibilitySchema;
export type NeutralPredicateCompatibility = z.infer<typeof neutralPredicateCompatibilityObjectSchema>;

const neutralPredicateCompatibilityListSchema = z.array(neutralPredicateCompatibilityObjectSchema)
  .max(MAX_NEUTRAL_PREDICATE_COMPATIBILITY)
  .superRefine((values, ctx) => {
    const keys = values.map((value) => `${value.phase}\u0000${value.order}`);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", message: "Predicate compatibility phase/order pairs must be unique" });
    }
    for (let index = 1; index < values.length; index += 1) {
      const previous = values[index - 1]!;
      const current = values[index]!;
      if (comparePredicateCompatibility(previous, current) >= 0) {
        ctx.addIssue({ code: "custom", message: "Predicate compatibility projections must be in canonical phase/order sequence" });
        break;
      }
    }
  });

const neutralDeviceReadObjectSchema = z.union([
  z.object({
    status: z.literal("available"),
    value: neutralScalarSchema,
  }).strict(),
  z.object({
    status: z.enum(["unsupported", "unavailable"]),
    reason: closedReasonCodeSchema,
  }).strict(),
]);
const neutralDeviceReadSchemaWithPreflight = z.preprocess(
  preflightForSchema,
  neutralDeviceReadObjectSchema,
);
export const neutralDeviceReadSchema = neutralDeviceReadSchemaWithPreflight;
export const NeutralDeviceReadSchema = neutralDeviceReadSchema;
export type NeutralDeviceRead = z.infer<typeof neutralDeviceReadObjectSchema>;

const neutralDeviceSummaryObjectSchema = z.object({
  hwCapabilityId: boundedIdSchema,
  schema: schemaNameSchema,
  schemaVersion: semverSchema,
  semanticKind: capabilitySemanticKindSchema.optional(),
  read: neutralDeviceReadObjectSchema,
  validity: z.enum(["valid", "stale", "invalid", "invalid-source", "present-but-invalid", "unavailable"]),
  actionCompatibility: neutralActionCompatibilityListSchema,
  predicateCompatibility: neutralPredicateCompatibilityListSchema,
}).strict().superRefine((value, ctx) => {
  if (value.read.status === "available" && value.validity !== "valid") {
    ctx.addIssue({ code: "custom", path: ["read", "status"], message: "An available read requires valid device validity" });
  }
  if (value.read.status === "unavailable" && value.validity === "valid") {
    ctx.addIssue({ code: "custom", path: ["read", "status"], message: "An unavailable read cannot claim valid device validity" });
  }
  if (value.validity !== "valid" && value.read.status !== "unavailable") {
    ctx.addIssue({ code: "custom", path: ["read", "status"], message: "Non-valid device state requires an unavailable read" });
  }
  for (const [index, projection] of value.actionCompatibility.entries()) {
    if (projection.status !== "compatible") continue;
    if (value.read.status !== "available") {
      ctx.addIssue({
        code: "custom",
        path: ["actionCompatibility", index, "status"],
        message: "A compatible action projection requires an available capability read",
      });
    } else if (projection.before !== value.read.value) {
      ctx.addIssue({
        code: "custom",
        path: ["actionCompatibility", index, "before"],
        message: "Compatible action before value must equal the capability read value",
      });
    }
  }
  for (const [index, projection] of value.predicateCompatibility.entries()) {
    if (projection.status === "compatible" && value.read.status !== "available") {
      ctx.addIssue({
        code: "custom",
        path: ["predicateCompatibility", index, "status"],
        message: "A compatible predicate projection requires an available capability read",
      });
    }
  }
});

const neutralDeviceSummarySchemaObject = z.preprocess(
  preflightForSchema,
  neutralDeviceSummaryObjectSchema,
);
export const neutralDeviceSummarySchema = neutralDeviceSummarySchemaObject;
export const NeutralDeviceSummarySchema = neutralDeviceSummarySchema;
export type NeutralDeviceSummary = z.infer<typeof neutralDeviceSummaryObjectSchema>;
export type NeutralDeviceSummaryInput = Omit<NeutralDeviceSummary, never>;

const canonicalWatermarksSchema = z.array(neutralWatermarkSchema).max(MAX_NEUTRAL_WATERMARKS);
const neutralWorldCutBodySchema = z.object({
  devices: z.array(neutralDeviceSummaryObjectSchema).max(MAX_NEUTRAL_DEVICES),
  watermarks: canonicalWatermarksSchema,
}).strict();
const neutralWorldCutSchemaObject = z.object({
  devices: z.array(neutralDeviceSummaryObjectSchema).max(MAX_NEUTRAL_DEVICES),
  cutIdentity: digestSchema,
  watermarks: canonicalWatermarksSchema,
}).strict().superRefine((value, ctx) => {
  try {
    validateUnique(value.devices.map((device) => device.hwCapabilityId), "device");
    validateUnique(value.watermarks.map((watermark) => watermark.bridgeId), "bridge");
    if (!isCanonicalDeviceOrder(value.devices)) {
      ctx.addIssue({ code: "custom", path: ["devices"], message: "World-cut devices must be in canonical capability order" });
    }
    if (!isCanonicalWatermarkOrder(value.watermarks)) {
      ctx.addIssue({ code: "custom", path: ["watermarks"], message: "World-cut watermarks must be in canonical bridge order" });
    }
    if (computeNeutralWorldCutIdentity(value) !== value.cutIdentity) {
      ctx.addIssue({ code: "custom", path: ["cutIdentity"], message: "World-cut identity does not match its canonical projection" });
    }
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid world cut" });
  }
});
const neutralWorldCutSchemaObjectWithPreflight = z.preprocess(preflightForSchema, neutralWorldCutSchemaObject);
export const neutralWorldCutSchema = neutralWorldCutSchemaObjectWithPreflight;
export const NeutralWorldCutSchema = neutralWorldCutSchema;
export const worldCutSchema = neutralWorldCutSchema;
export type NeutralWorldCut = z.infer<typeof neutralWorldCutSchemaObject>;
export type NeutralWorldCutInput = z.input<typeof neutralWorldCutBodySchema>;

export type NeutralConflictStatus = z.infer<typeof neutralConflictStatusSchema>;
export const neutralConflictStatusSchema = z.enum(["none", "duplicate", "possible_overlap", "unavailable"]);
export const NeutralConflictStatusSchema = neutralConflictStatusSchema;
const neutralConflictKindSchema = z.enum([
  "existing_artifact",
  "foreign_rule",
  "stale_evidence",
  "authority_unavailable",
  "target_invalid",
  "policy_blocked",
]);
const neutralConflictSeveritySchema = z.enum(["blocking", "warning"]);

const neutralConflictFindingObjectSchema = z.object({
  kind: neutralConflictKindSchema,
  severity: neutralConflictSeveritySchema,
  hwCapabilityId: boundedIdSchema.optional(),
  reference: boundedIdSchema.optional(),
  reason: closedReasonCodeSchema,
}).strict();
const neutralConflictFindingSchemaObject = z.preprocess(
  preflightForSchema,
  neutralConflictFindingObjectSchema,
);
export const neutralConflictFindingSchema = neutralConflictFindingSchemaObject;
export const NeutralConflictFindingSchema = neutralConflictFindingSchema;
export type NeutralConflictFinding = z.infer<typeof neutralConflictFindingObjectSchema>;

const neutralConflictResultObjectSchema = z.object({
  status: neutralConflictStatusSchema,
  findings: z.array(neutralConflictFindingObjectSchema).max(MAX_NEUTRAL_CONFLICTS),
}).strict().superRefine((value, ctx) => {
  try {
    validateUnique(value.findings.map((finding) => findingIdentity(finding)), "finding");
    if (!isCanonicalFindingOrder(value.findings)) {
      ctx.addIssue({ code: "custom", path: ["findings"], message: "Conflict findings must be in canonical order" });
    }
    if (value.status === "none" && value.findings.length !== 0) {
      ctx.addIssue({ code: "custom", path: ["findings"], message: "A none conflict result cannot contain findings" });
    }
    if (value.status !== "none" && value.findings.length === 0) {
      ctx.addIssue({ code: "custom", path: ["findings"], message: "A non-none conflict result requires a finding" });
    }
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid conflict result" });
  }
});
const neutralConflictResultSchemaObjectWithPreflight = z.preprocess(
  preflightForSchema,
  neutralConflictResultObjectSchema,
);
export const neutralConflictResultSchema = neutralConflictResultSchemaObjectWithPreflight;
export const NeutralConflictResultSchema = neutralConflictResultSchema;
export type NeutralConflictResult = z.infer<typeof neutralConflictResultObjectSchema>;

const neutralConflictInputObjectSchema = z.object({
  bridgeId: boundedIdSchema,
  epochId: boundedIdSchema,
  watermark: neutralWatermarkSchema,
  catalogIdentity: digestSchema,
  status: z.enum(["current", "unavailable"]),
  findings: z.array(neutralConflictFindingObjectSchema).max(MAX_NEUTRAL_CONFLICTS),
}).strict().superRefine((value, ctx) => {
  try {
    if (value.watermark.bridgeId !== value.bridgeId) {
      ctx.addIssue({ code: "custom", path: ["watermark", "bridgeId"], message: "Conflict watermark bridge must match bridgeId" });
    }
    if (value.watermark.epochId !== value.epochId) {
      ctx.addIssue({ code: "custom", path: ["watermark", "epochId"], message: "Conflict watermark epoch must match epochId" });
    }
    validateUnique(value.findings.map((finding) => findingIdentity(finding)), "finding");
    if (!isCanonicalFindingOrder(value.findings)) {
      ctx.addIssue({ code: "custom", path: ["findings"], message: "Conflict input findings must be in canonical order" });
    }
    if (value.findings.some((finding) => finding.kind !== "foreign_rule")) {
      ctx.addIssue({ code: "custom", path: ["findings"], message: "Foreign rule checks may only contain foreign-rule findings" });
    }
    if (value.status === "current" && value.findings.some((finding) => finding.reason === "foreign_catalog_unavailable")) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "A current foreign catalog cannot report unavailable" });
    }
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid conflict input" });
  }
});
const neutralConflictInputSchemaObjectWithPreflight = z.preprocess(
  preflightForSchema,
  neutralConflictInputObjectSchema,
);
export const neutralConflictInputSchema = neutralConflictInputSchemaObjectWithPreflight;
export const NeutralConflictInputSchema = neutralConflictInputSchema;
export type NeutralConflictInput = z.infer<typeof neutralConflictInputObjectSchema>;

const neutralCurrentConflictObjectSchema = z.object({
  sourceIdentity: digestSchema,
  result: neutralConflictResultObjectSchema,
}).strict();
const neutralCurrentConflictSchemaWithPreflight = z.preprocess(
  preflightForSchema,
  neutralCurrentConflictObjectSchema,
);
export const neutralCurrentConflictSchema = neutralCurrentConflictSchemaWithPreflight;
export const NeutralCurrentConflictSchema = neutralCurrentConflictSchema;
export type NeutralCurrentConflict = z.infer<typeof neutralCurrentConflictObjectSchema>;

const neutralSetLevelDiffOperationSchema = z.object({
  actionOrder: positiveSafeIntegerSchema,
  kind: z.literal("set_level"),
  hwCapabilityId: boundedIdSchema,
  actionAuthorityCandidateId: boundedIdSchema,
  before: neutralScalarSchema,
  after: neutralScalarSchema,
}).strict().superRefine((value, ctx) => {
  if (!isNormalizedLevel(value.before)) {
    ctx.addIssue({ code: "custom", path: ["before"], message: "set_level diff before value must be finite and within 0..1" });
  }
  if (!isNormalizedLevel(value.after)) {
    ctx.addIssue({ code: "custom", path: ["after"], message: "set_level diff after value must be finite and within 0..1" });
  }
  if (value.before === value.after) {
    ctx.addIssue({ code: "custom", path: ["after"], message: "A set_level diff operation must change the value" });
  }
});
const neutralSetBooleanDiffOperationSchema = z.object({
  actionOrder: positiveSafeIntegerSchema,
  kind: z.literal("set_boolean"),
  hwCapabilityId: boundedIdSchema,
  actionAuthorityCandidateId: boundedIdSchema,
  before: neutralScalarSchema,
  after: neutralScalarSchema,
}).strict().superRefine((value, ctx) => {
  if (typeof value.before !== "boolean") {
    ctx.addIssue({ code: "custom", path: ["before"], message: "set_boolean diff before value must be boolean" });
  }
  if (typeof value.after !== "boolean") {
    ctx.addIssue({ code: "custom", path: ["after"], message: "set_boolean diff after value must be boolean" });
  }
  if (value.before === value.after) {
    ctx.addIssue({ code: "custom", path: ["after"], message: "A set_boolean diff operation must change the value" });
  }
});
const neutralNotifyDiffOperationSchema = z.object({
  actionOrder: positiveSafeIntegerSchema,
  kind: z.literal("notify_local"),
  after: boundedTextSchema,
}).strict();
const neutralDiffOperationObjectSchema = z.union([
  neutralSetLevelDiffOperationSchema,
  neutralSetBooleanDiffOperationSchema,
  neutralNotifyDiffOperationSchema,
]);
const neutralDiffOperationSchemaObjectWithPreflight = z.preprocess(
  preflightForSchema,
  neutralDiffOperationObjectSchema,
);
export const neutralDiffOperationSchema = neutralDiffOperationSchemaObjectWithPreflight;
export const NeutralDiffOperationSchema = neutralDiffOperationSchema;
export type NeutralDiffOperation = z.infer<typeof neutralDiffOperationObjectSchema>;

const neutralDiffObjectSchema = z.object({
  status: z.enum(["no_change", "changes", "unavailable"]),
  operations: z.array(neutralDiffOperationObjectSchema).max(MAX_NEUTRAL_OPERATIONS),
  unchangedCount: nonNegativeSafeIntegerSchema,
  redacted: z.literal(true),
}).strict().superRefine((value, ctx) => {
  for (let index = 0; index < value.operations.length; index += 1) {
    if (index > 0 && value.operations[index - 1]!.actionOrder >= value.operations[index]!.actionOrder) {
      ctx.addIssue({ code: "custom", path: ["operations", index, "actionOrder"], message: "Diff actionOrder values must be strictly increasing" });
    }
  }
  if (value.status === "no_change" && value.operations.length !== 0) {
    ctx.addIssue({ code: "custom", path: ["operations"], message: "A no_change diff cannot contain operations" });
  }
  if (value.status === "changes" && value.operations.length === 0) {
    ctx.addIssue({ code: "custom", path: ["operations"], message: "A changes diff requires an operation" });
  }
  if (value.status === "unavailable" && value.operations.length !== 0) {
    ctx.addIssue({ code: "custom", path: ["operations"], message: "An unavailable diff cannot contain operations" });
  }
});
const neutralDiffSchemaObjectWithPreflight = z.preprocess(preflightForSchema, neutralDiffObjectSchema);
export const neutralDiffSchema = neutralDiffSchemaObjectWithPreflight;
export const NeutralDiffSchema = neutralDiffSchema;
export type NeutralDiff = z.infer<typeof neutralDiffObjectSchema>;
type NeutralDiffOperationInput = {
  readonly actionOrder: number;
  readonly kind: "set_level" | "set_boolean" | "notify_local";
  readonly hwCapabilityId?: string;
  readonly actionAuthorityCandidateId?: string;
  readonly before?: NeutralScalar;
  readonly after?: NeutralScalar;
};
type NeutralDiffInput = {
  readonly status: "no_change" | "changes" | "unavailable";
  readonly operations: readonly NeutralDiffOperationInput[];
  readonly unchangedCount: number;
  readonly redacted: true;
};

const neutralPlanSchemaObject = artifactContentSchema;
export const neutralPlanSchema = neutralPlanSchemaObject;
export const NeutralPlanSchema = neutralPlanSchema;
export type NeutralPlan = ArtifactContent;

const compilerIdVersionSchema = z.object({
  id: boundedIdSchema,
  version: semverSchema,
}).strict();
export const neutralCompilerSchema = compilerIdVersionSchema;
export const NeutralCompilerSchema = neutralCompilerSchema;
export type NeutralCompiler = z.infer<typeof compilerIdVersionSchema>;

const proposalIdentitySchema = z.object({
  id: boundedIdSchema,
  revision: positiveSafeIntegerSchema,
  status: z.enum(["pending_review", "approved", "rejected", "expired"]),
}).strict();
export const neutralProposalIdentitySchema = proposalIdentitySchema;
export const NeutralProposalIdentitySchema = proposalIdentitySchema;
export type NeutralProposalIdentity = z.infer<typeof proposalIdentitySchema>;

const evidenceIdentityRefSchema = z.object({
  attestationId: boundedIdSchema,
  inputIdentity: digestSchema,
}).strict();
const riskIdentityRefSchema = z.object({
  assessmentId: boundedIdSchema,
  inputIdentity: digestSchema,
}).strict();
const authorityIdentityRefSchema = z.object({
  assessmentId: boundedIdSchema,
  inputIdentity: digestSchema,
}).strict();
export const neutralEvidenceIdentityRefSchema = evidenceIdentityRefSchema;
export const neutralRiskIdentityRefSchema = riskIdentityRefSchema;
export const neutralAuthorityIdentityRefSchema = authorityIdentityRefSchema;
export type NeutralEvidenceIdentityRef = z.infer<typeof evidenceIdentityRefSchema>;
export type NeutralRiskIdentityRef = z.infer<typeof riskIdentityRefSchema>;
export type NeutralAuthorityIdentityRef = z.infer<typeof authorityIdentityRefSchema>;

const compileInputBodySchema = z.object({
  artifact: artifactRevisionSchema,
  proposal: proposalIdentitySchema,
  evidence: artifactEvidenceAttestationSchema,
  risk: artifactRiskAssessmentSchema,
  authority: artifactAuthorityAssessmentSchema,
  currentConflict: neutralCurrentConflictObjectSchema,
  worldCut: neutralWorldCutSchemaObject,
  foreignCatalogIdentity: digestSchema,
  foreignRuleChecks: z.array(neutralConflictInputObjectSchema).max(MAX_NEUTRAL_CONFLICTS),
  compiler: compilerIdVersionSchema,
}).strict();
const neutralWorldCutCreateSchema = z.object({
  devices: z.array(neutralDeviceSummaryObjectSchema).max(MAX_NEUTRAL_DEVICES),
  cutIdentity: digestSchema,
  watermarks: canonicalWatermarksSchema,
}).strict();
const neutralConflictInputCreateSchema = z.object({
  bridgeId: boundedIdSchema,
  epochId: boundedIdSchema,
  watermark: neutralWatermarkSchema,
  catalogIdentity: digestSchema,
  status: z.enum(["current", "unavailable"]),
  findings: z.array(neutralConflictFindingObjectSchema).max(MAX_NEUTRAL_CONFLICTS),
}).strict();
const compileInputCreateBodySchema = z.object({
  artifact: artifactRevisionSchema,
  proposal: proposalIdentitySchema,
  evidence: artifactEvidenceAttestationSchema,
  risk: artifactRiskAssessmentSchema,
  authority: artifactAuthorityAssessmentSchema,
  currentConflict: neutralCurrentConflictObjectSchema,
  worldCut: neutralWorldCutCreateSchema,
  foreignCatalogIdentity: digestSchema,
  foreignRuleChecks: z.array(neutralConflictInputCreateSchema).max(MAX_NEUTRAL_CONFLICTS),
  compiler: compilerIdVersionSchema,
}).strict();
const compileInputObjectSchema = compileInputBodySchema.extend({
  inputIdentity: digestSchema,
}).strict().superRefine((value, ctx) => {
  validateCompileBindings(value, ctx);
  try {
    if (neutralCompileInputIdentity(value) !== value.inputIdentity) {
      ctx.addIssue({ code: "custom", path: ["inputIdentity"], message: "Compile input identity does not match canonical inputs" });
    }
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid compile input identity" });
  }
});
const compileInputSchemaWithPreflight = z.preprocess(preflightForSchema, compileInputObjectSchema);
export const artifactCompileInputSchema = compileInputSchemaWithPreflight;
export const ArtifactCompileInputSchema = artifactCompileInputSchema;
export type ArtifactCompileInput = z.infer<typeof compileInputObjectSchema>;
export type ArtifactCompileInputDraft = z.input<typeof compileInputCreateBodySchema>;

const neutralActionAuthorityBindingObjectSchema = z.object({
  actionOrder: positiveSafeIntegerSchema,
  kind: z.enum(["set_level", "set_boolean"]),
  hwCapabilityId: boundedIdSchema,
  actionAuthorityCandidateId: boundedIdSchema,
}).strict();
const neutralActionAuthorityBindingListSchema = z.array(neutralActionAuthorityBindingObjectSchema)
  .max(MAX_NEUTRAL_ACTION_COMPATIBILITY)
  .superRefine((values, ctx) => {
    const orders = values.map((value) => value.actionOrder);
    if (new Set(orders).size !== orders.length) {
      ctx.addIssue({ code: "custom", message: "Action authority binding actionOrder values must be unique" });
    }
    for (let index = 1; index < orders.length; index += 1) {
      if (orders[index - 1]! >= orders[index]!) {
        ctx.addIssue({ code: "custom", message: "Action authority bindings must be in ascending actionOrder" });
        break;
      }
    }
  });
export const neutralActionAuthorityBindingSchema = z.preprocess(
  preflightForSchema,
  neutralActionAuthorityBindingObjectSchema,
);
export const NeutralActionAuthorityBindingSchema = neutralActionAuthorityBindingSchema;
export type NeutralActionAuthorityBinding = z.infer<typeof neutralActionAuthorityBindingObjectSchema>;

const canonicalBlockingReasonsSchema = z.array(closedReasonCodeSchema)
  .max(MAX_NEUTRAL_BLOCKING_REASONS)
  .superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: "custom", message: "Blocking reasons must be unique" });
    }
    for (let index = 1; index < values.length; index += 1) {
      if (compareUnicodeCodePoints(values[index - 1]!, values[index]!) >= 0) {
        ctx.addIssue({ code: "custom", message: "Blocking reasons must be in canonical order" });
        break;
      }
    }
  });

const compileAttestationBodySchema = z.object({
  kind: z.literal("compile-attestation"),
  artifact: z.object({ artifactId: boundedIdSchema, revision: positiveSafeIntegerSchema, contentHash: digestSchema }).strict(),
  inputIdentity: digestSchema,
  resultId: digestSchema,
  proposal: z.object({ id: boundedIdSchema, revision: positiveSafeIntegerSchema }).strict(),
  evidenceAttestationId: boundedIdSchema,
  evidenceInputIdentity: digestSchema,
  riskAssessmentId: boundedIdSchema,
  riskInputIdentity: digestSchema,
  authorityAssessmentId: boundedIdSchema,
  authorityInputIdentity: digestSchema,
  worldCutIdentity: digestSchema,
  foreignCatalogIdentity: digestSchema,
  status: z.enum(["compiled", "rejected", "unavailable"]),
  compiler: compilerIdVersionSchema,
  usedWatermarks: canonicalWatermarksSchema,
  actionAuthorityBindings: neutralActionAuthorityBindingListSchema,
  plan: neutralPlanSchemaObject.optional(),
  diff: neutralDiffObjectSchema,
  conflicts: neutralConflictResultObjectSchema,
  blockingReasons: canonicalBlockingReasonsSchema,
}).strict().superRefine((value, ctx) => {
  validateCompileAttestationSemantics(value, ctx);
  try {
    if (neutralCompileResultIdentity(value) !== value.resultId) {
      ctx.addIssue({ code: "custom", path: ["resultId"], message: "Compile result identity does not match canonical result" });
    }
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid compile result identity" });
  }
});
const compileAttestationSchemaWithPreflight = z.preprocess(preflightForSchema, compileAttestationBodySchema);
export const artifactCompileAttestationSchema = compileAttestationSchemaWithPreflight;
export const ArtifactCompileAttestationSchema = artifactCompileAttestationSchema;
export const compileAttestationSchema = artifactCompileAttestationSchema;
export type ArtifactCompileAttestation = z.infer<typeof compileAttestationBodySchema>;

const dryRunAttestationBodySchema = z.object({
  kind: z.literal("dry-run-attestation"),
  artifact: z.object({ artifactId: boundedIdSchema, revision: positiveSafeIntegerSchema, contentHash: digestSchema }).strict(),
  inputIdentity: digestSchema,
  resultId: digestSchema,
  compileAttestationId: boundedIdSchema,
  compileInputIdentity: digestSchema,
  evidenceAttestationId: boundedIdSchema,
  evidenceInputIdentity: digestSchema,
  riskAssessmentId: boundedIdSchema,
  riskInputIdentity: digestSchema,
  authorityAssessmentId: boundedIdSchema,
  authorityInputIdentity: digestSchema,
  worldCutIdentity: digestSchema,
  foreignCatalogIdentity: digestSchema,
  status: z.enum(["passed", "failed", "unavailable"]),
  compiler: compilerIdVersionSchema,
  checkedWatermarks: canonicalWatermarksSchema,
  actionAuthorityBindings: neutralActionAuthorityBindingListSchema,
  diff: neutralDiffObjectSchema,
  conflicts: neutralConflictResultObjectSchema,
  writesPerformed: z.literal(false),
  summary: z.string().min(1).max(1_000)
    .refine((value) => value === value.trim(), "summary must not have surrounding whitespace")
    .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES, "summary exceeds the byte budget")
    .refine((value) => !URL_PATTERN.test(value), "summary cannot contain a URL"),
}).strict().superRefine((value, ctx) => {
  validateDryRunAttestationSemantics(value, ctx);
  try {
    if (neutralDryRunInputIdentity(value) !== value.inputIdentity) {
      ctx.addIssue({ code: "custom", path: ["inputIdentity"], message: "Dry-run input identity does not match canonical inputs" });
    }
    if (neutralDryRunResultIdentity(value) !== value.resultId) {
      ctx.addIssue({ code: "custom", path: ["resultId"], message: "Dry-run result identity does not match canonical result" });
    }
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid dry-run identity" });
  }
});
const dryRunAttestationSchemaWithPreflight = z.preprocess(preflightForSchema, dryRunAttestationBodySchema);
export const neutralDryRunAttestationSchema = dryRunAttestationSchemaWithPreflight;
export const NeutralDryRunAttestationSchema = neutralDryRunAttestationSchema;
export const artifactDryRunAttestationSchema = neutralDryRunAttestationSchema;
export const dryRunAttestationSchema = neutralDryRunAttestationSchema;
export type NeutralDryRunAttestation = z.infer<typeof dryRunAttestationBodySchema>;
export type ArtifactDryRunAttestation = NeutralDryRunAttestation;

const neutralDryRunStateSchemaObject = z.union([
  z.object({ status: z.literal("not_run"), artifact: z.object({ artifactId: boundedIdSchema, revision: positiveSafeIntegerSchema, contentHash: digestSchema }).strict() }).strict(),
  dryRunAttestationBodySchema,
]);
export const neutralDryRunStateSchema = z.preprocess(preflightForSchema, neutralDryRunStateSchemaObject);
export const NeutralDryRunStateSchema = neutralDryRunStateSchema;
export type NeutralDryRunState = z.infer<typeof neutralDryRunStateSchemaObject>;

export class ArtifactCompilerContractError extends TypeError {
  readonly code:
    | "invalid_contract"
    | "identity_mismatch"
    | "resource_exhausted"
    | "forbidden_field"
    | "duplicate_json_key";

  constructor(code: ArtifactCompilerContractError["code"], message: string) {
    super(message);
    this.name = "ArtifactCompilerContractError";
    this.code = code;
  }
}

export function createNeutralScalar(input: NeutralScalar): NeutralScalar {
  return parseWithSchema(neutralScalarSchema, input);
}

export function parseNeutralScalar(input: unknown): NeutralScalar {
  return parseWithSchema(neutralScalarSchema, input);
}

export function createNeutralActionCompatibility(input: NeutralActionCompatibility): NeutralActionCompatibility {
  return freezeDeep(parseWithSchema(neutralActionCompatibilityObjectSchema, input));
}

export function parseNeutralActionCompatibility(input: unknown): NeutralActionCompatibility {
  return freezeDeep(parseWithSchema(neutralActionCompatibilitySchema, input));
}
export const createNeutralActionCompatibilityResult = createNeutralActionCompatibility;
export const parseNeutralActionCompatibilityResult = parseNeutralActionCompatibility;

export function createNeutralPredicateCompatibility(input: NeutralPredicateCompatibility): NeutralPredicateCompatibility {
  return freezeDeep(parseWithSchema(neutralPredicateCompatibilityObjectSchema, input));
}

export function parseNeutralPredicateCompatibility(input: unknown): NeutralPredicateCompatibility {
  return freezeDeep(parseWithSchema(neutralPredicateCompatibilitySchema, input));
}

export function createNeutralDeviceRead(input: NeutralDeviceRead): NeutralDeviceRead {
  return freezeDeep(parseWithSchema(neutralDeviceReadObjectSchema, input));
}

export function parseNeutralDeviceRead(input: unknown): NeutralDeviceRead {
  return freezeDeep(parseWithSchema(neutralDeviceReadSchema, input));
}

export function createNeutralPlan(input: NeutralPlan): NeutralPlan {
  return freezeDeep(parseWithSchema(neutralPlanSchemaObject, input));
}

export function parseNeutralPlan(input: unknown): NeutralPlan {
  return freezeDeep(parseWithSchema(neutralPlanSchemaObject, input));
}

export function createNeutralDeviceSummary(input: NeutralDeviceSummaryInput): NeutralDeviceSummary {
  return freezeDeep(parseWithSchema(neutralDeviceSummarySchemaObject, input));
}

export function parseNeutralDeviceSummary(input: unknown): NeutralDeviceSummary {
  return freezeDeep(parseWithSchema(neutralDeviceSummarySchemaObject, input));
}

/**
 * Returns the complete canonical set of capability IDs referenced by an
 * artifact's behavior intent. Notify-only actions do not add a device target;
 * every other trigger/condition/action/rollback/postcondition reference does.
 */
export function deriveArtifactCapabilityScope(content: ArtifactContent): readonly string[] {
  const ids = new Set<string>();
  if (content.trigger.kind === "capability_changed") ids.add(content.trigger.source.hwCapabilityId);
  for (const condition of content.conditions) ids.add(condition.source.hwCapabilityId);
  for (const action of content.actions) {
    if (action.kind !== "notify_local") ids.add(action.target.hwCapabilityId);
  }
  if (content.rollback.kind === "restore_previous_state") ids.add(content.rollback.target.hwCapabilityId);
  for (const postcondition of content.postconditions) ids.add(postcondition.source.hwCapabilityId);
  return Object.freeze([...ids].sort(compareUnicodeCodePoints));
}
export const computeArtifactCapabilityScope = deriveArtifactCapabilityScope;
export const artifactCapabilityScope = deriveArtifactCapabilityScope;

export function createNeutralWorldCut(input: NeutralWorldCutInput): NeutralWorldCut {
  const parsed = parseWithSchema(neutralWorldCutBodySchema, input);
  const devices = sortDevices(parsed.devices);
  const watermarks = sortWatermarks(parsed.watermarks);
  validateUnique(devices.map((device) => device.hwCapabilityId), "device");
  validateUnique(watermarks.map((watermark) => watermark.bridgeId), "bridge");
  const output = neutralWorldCutSchemaObject.parse({
    devices,
    watermarks,
    cutIdentity: computeNeutralWorldCutIdentity({ devices, watermarks }),
  });
  return freezeDeep(output);
}

export function parseNeutralWorldCut(input: unknown): NeutralWorldCut {
  return freezeDeep(parseWithSchema(neutralWorldCutSchema, input));
}

export function computeNeutralWorldCutIdentity(input: Pick<NeutralWorldCut, "devices" | "watermarks">): string {
  const payload = {
    devices: sortDevices(input.devices),
    // lastSyncCompleteAt is capture metadata. The committed epoch/sequence,
    // freshness, and gap count are the semantic world-cut watermark.
    watermarks: sortWatermarks(input.watermarks).map(({ bridgeId, epochId, lastSeq, freshness, gapCount }) => ({
      bridgeId,
      epochId,
      lastSeq,
      freshness,
      gapCount,
    })),
  };
  return digestCanonical({ kind: "neutral-world-cut", input: payload });
}
export const neutralWorldCutIdentity = computeNeutralWorldCutIdentity;

export function createNeutralConflictInput(input: NeutralConflictInput): NeutralConflictInput {
  const candidate = { ...input, findings: sortFindings(input.findings) };
  const parsed = parseWithSchema(neutralConflictInputObjectSchema, candidate);
  return freezeDeep(parsed);
}

export function parseNeutralConflictInput(input: unknown): NeutralConflictInput {
  return freezeDeep(parseWithSchema(neutralConflictInputSchema, input));
}

/** Aggregate the complete, sorted foreign-rule checks into one catalog identity. */
export function computeNeutralForeignCatalogIdentity(checks: readonly NeutralConflictInput[]): string {
  const payload = sortConflictInputs(checks).map((check) => ({
    bridgeId: check.bridgeId,
    epochId: check.epochId,
    watermark: identityWatermark(check.watermark),
    catalogIdentity: check.catalogIdentity,
    status: check.status,
    findings: sortFindings(check.findings),
  }));
  return digestCanonical({ kind: "neutral-foreign-catalog", input: payload });
}
export const computeForeignCatalogIdentity = computeNeutralForeignCatalogIdentity;
export const neutralForeignCatalogIdentity = computeNeutralForeignCatalogIdentity;

export function createNeutralConflictResult(input: NeutralConflictResult): NeutralConflictResult {
  const candidate = { ...input, findings: sortFindings(input.findings) };
  const parsed = parseWithSchema(neutralConflictResultObjectSchema, candidate);
  return freezeDeep(parsed);
}

export function parseNeutralConflictResult(input: unknown): NeutralConflictResult {
  return freezeDeep(parseWithSchema(neutralConflictResultSchema, input));
}

export function createNeutralDiff(input: NeutralDiffInput): NeutralDiff {
  const parsed = parseWithSchema(neutralDiffObjectSchema, input);
  return freezeDeep(neutralDiffObjectSchema.parse(parsed));
}

export function parseNeutralDiff(input: unknown): NeutralDiff {
  return freezeDeep(parseWithSchema(neutralDiffSchema, input));
}

export function createArtifactCompileInput(input: ArtifactCompileInputDraft): ArtifactCompileInput {
  const parsed = parseWithSchema(compileInputCreateBodySchema, input);
  const normalized = normalizeCompileInput(parsed);
  const output = compileInputObjectSchema.parse({
    ...normalized,
    inputIdentity: neutralCompileInputIdentity(normalized),
  });
  return freezeDeep(output);
}

export function parseArtifactCompileInput(input: unknown): ArtifactCompileInput {
  return freezeDeep(parseWithSchema(artifactCompileInputSchema, input));
}

/** Canonical M3c dynamic input identity; assessment/cut timestamps are not included. */
export function neutralCompileInputIdentity(input: Pick<ArtifactCompileInput, "artifact" | "proposal" | "evidence" | "risk" | "authority" | "currentConflict" | "worldCut" | "foreignCatalogIdentity" | "foreignRuleChecks" | "compiler">): string {
  const candidate = hasOwnProperty(input, "inputIdentity")
    ? omitKey(input as Record<string, unknown>, "inputIdentity")
    : input;
  const parsed = parseWithSchema(compileInputBodySchema, candidate);
  const payload = {
    artifact: artifactRef(parsed.artifact),
    proposal: parsed.proposal,
    evidence: evidenceIdentityRef(parsed.evidence),
    risk: riskIdentityRef(parsed.risk),
    authority: authorityIdentityRef(parsed.authority),
    currentConflict: parsed.currentConflict,
    worldCutIdentity: parsed.worldCut.cutIdentity,
    foreignCatalogIdentity: parsed.foreignCatalogIdentity,
    foreignRuleChecks: sortConflictInputs(parsed.foreignRuleChecks),
    compiler: parsed.compiler,
  };
  return digestCanonical({ kind: "artifact-compile-input", input: payload });
}
export const computeArtifactCompileInputIdentity = neutralCompileInputIdentity;
export const artifactCompileInputIdentity = neutralCompileInputIdentity;
export const computeCompileInputIdentity = neutralCompileInputIdentity;

export interface ArtifactCompileAttestationDraft {
  readonly input: ArtifactCompileInput;
  readonly status: ArtifactCompileAttestation["status"];
  readonly plan?: NeutralPlan;
  readonly diff: NeutralDiff;
  readonly conflicts: NeutralConflictResult;
  readonly blockingReasons: readonly ClosedReasonCode[];
}

export function createArtifactCompileAttestation(input: ArtifactCompileAttestationDraft): ArtifactCompileAttestation {
  const parsed = parseWithSchema(compileAttestationDraftSchema, input);
  const compileInput = parseArtifactCompileInput(parsed.input);
  const diff = parseNeutralDiff(parsed.diff);
  const conflicts = parseNeutralConflictResult(parsed.conflicts);
  if (canonicalJson(conflicts) !== canonicalJson(compileInput.currentConflict.result)) {
    throw new ArtifactCompilerContractError("invalid_contract", "Compile conflicts must equal the current conflict result");
  }
  const authorityResolution = deriveActionAuthorityBindings(compileInput.artifact.content.actions, compileInput.authority);
  assertDiffBindings(compileInput.artifact.content.actions, diff, authorityResolution.bindings);
  const plan = parsed.plan === undefined ? undefined : parseWithSchema(artifactContentSchema, parsed.plan);
  const blockingReasons = [...parsed.blockingReasons];
  if (authorityResolution.unavailable && !blockingReasons.includes("authority_unavailable")) {
    blockingReasons.push("authority_unavailable");
  }
  const dependencyUnavailable = authorityResolution.unavailable
    || compileInput.currentConflict.result.status === "unavailable"
    || compileInput.foreignRuleChecks.some((check) => check.status === "unavailable");
  if (compileInput.currentConflict.result.status === "unavailable" && !blockingReasons.includes("foreign_catalog_unavailable")) {
    blockingReasons.push("foreign_catalog_unavailable");
  }
  if (compileInput.foreignRuleChecks.some((check) => check.status === "unavailable") && !blockingReasons.includes("foreign_catalog_unavailable")) {
    blockingReasons.push("foreign_catalog_unavailable");
  }
  if (dependencyUnavailable && parsed.status !== "unavailable") {
    throw new ArtifactCompilerContractError("invalid_contract", "Unavailable compile dependencies require unavailable compile status");
  }
  const body = {
    kind: "compile-attestation" as const,
    artifact: artifactRef(compileInput.artifact),
    inputIdentity: compileInput.inputIdentity,
    resultId: "sha256:" + "0".repeat(64),
    proposal: { id: compileInput.proposal.id, revision: compileInput.proposal.revision },
    evidenceAttestationId: compileInput.evidence.attestationId,
    evidenceInputIdentity: compileInput.evidence.inputIdentity,
    riskAssessmentId: compileInput.risk.assessmentId,
    riskInputIdentity: compileInput.risk.inputIdentity,
    authorityAssessmentId: compileInput.authority.assessmentId,
    authorityInputIdentity: compileInput.authority.inputIdentity,
    worldCutIdentity: compileInput.worldCut.cutIdentity,
    foreignCatalogIdentity: compileInput.foreignCatalogIdentity,
    status: parsed.status,
    compiler: compileInput.compiler,
    usedWatermarks: sortWatermarks(compileInput.worldCut.watermarks),
    actionAuthorityBindings: [...authorityResolution.bindings],
    ...(plan === undefined ? {} : { plan }),
    diff,
    conflicts,
    blockingReasons: sortClosedReasons(blockingReasons),
  };
  const resultId = neutralCompileResultIdentity(body as unknown as Omit<ArtifactCompileAttestation, "resultId">);
  return freezeDeep(compileAttestationBodySchema.parse({ ...body, resultId }));
}

export function parseArtifactCompileAttestation(input: unknown): ArtifactCompileAttestation {
  return freezeDeep(parseWithSchema(artifactCompileAttestationSchema, input));
}
export const createCompileAttestation = createArtifactCompileAttestation;
export const parseCompileAttestation = parseArtifactCompileAttestation;

export function neutralCompileResultIdentity(input: Omit<ArtifactCompileAttestation, "resultId">): string {
  return digestCanonical({ kind: "artifact-compile-result", input: {
    kind: input.kind,
    artifact: input.artifact,
    inputIdentity: input.inputIdentity,
    proposal: input.proposal,
    evidenceAttestationId: input.evidenceAttestationId,
    evidenceInputIdentity: input.evidenceInputIdentity,
    riskAssessmentId: input.riskAssessmentId,
    riskInputIdentity: input.riskInputIdentity,
    authorityAssessmentId: input.authorityAssessmentId,
    authorityInputIdentity: input.authorityInputIdentity,
    worldCutIdentity: input.worldCutIdentity,
    foreignCatalogIdentity: input.foreignCatalogIdentity,
    status: input.status,
    compiler: input.compiler,
    usedWatermarks: identityWatermarks(input.usedWatermarks),
    actionAuthorityBindings: input.actionAuthorityBindings,
    ...(input.plan === undefined ? {} : { plan: input.plan }),
    diff: input.diff,
    conflicts: input.conflicts,
    blockingReasons: input.blockingReasons,
  } });
}
export const computeArtifactCompileResultIdentity = neutralCompileResultIdentity;
export const artifactCompileResultIdentity = neutralCompileResultIdentity;
export const computeCompileResultIdentity = neutralCompileResultIdentity;

export interface NeutralDryRunAttestationDraft {
  readonly compile: ArtifactCompileAttestation;
  readonly status: NeutralDryRunAttestation["status"];
  readonly diff: NeutralDiff;
  readonly conflicts: NeutralConflictResult;
  readonly summary: string;
}

export function createNeutralDryRunAttestation(input: NeutralDryRunAttestationDraft): NeutralDryRunAttestation {
  const parsed = parseWithSchema(dryRunAttestationDraftSchema, input);
  const compile = parseArtifactCompileAttestation(parsed.compile);
  const diff = parseNeutralDiff(parsed.diff);
  const conflicts = parseNeutralConflictResult(parsed.conflicts);
  if (canonicalJson(diff) !== canonicalJson(compile.diff)) {
    throw new ArtifactCompilerContractError("invalid_contract", "Dry-run diff must equal the compile diff");
  }
  if (canonicalJson(conflicts) !== canonicalJson(compile.conflicts)) {
    throw new ArtifactCompilerContractError("invalid_contract", "Dry-run conflicts must equal the compile conflicts");
  }
  const expectedStatus = expectedDryRunStatus(compile);
  if (parsed.status !== expectedStatus) {
    throw new ArtifactCompilerContractError("invalid_contract", "Dry-run status must match compile status, diff, and conflicts");
  }
  const body = {
    kind: "dry-run-attestation" as const,
    artifact: compile.artifact,
    inputIdentity: "sha256:" + "0".repeat(64),
    resultId: "sha256:" + "0".repeat(64),
    compileAttestationId: compile.resultId,
    compileInputIdentity: compile.inputIdentity,
    evidenceAttestationId: compile.evidenceAttestationId,
    evidenceInputIdentity: compile.evidenceInputIdentity,
    riskAssessmentId: compile.riskAssessmentId,
    riskInputIdentity: compile.riskInputIdentity,
    authorityAssessmentId: compile.authorityAssessmentId,
    authorityInputIdentity: compile.authorityInputIdentity,
    worldCutIdentity: compile.worldCutIdentity,
    foreignCatalogIdentity: compile.foreignCatalogIdentity,
    status: parsed.status,
    compiler: compile.compiler,
    checkedWatermarks: compile.usedWatermarks,
    actionAuthorityBindings: compile.actionAuthorityBindings,
    diff,
    conflicts,
    writesPerformed: false as const,
    summary: parsed.summary,
  };
  const inputIdentity = neutralDryRunInputIdentity(body as unknown as Parameters<typeof neutralDryRunInputIdentity>[0]);
  const resultId = neutralDryRunResultIdentity({ ...body, inputIdentity } as unknown as Omit<NeutralDryRunAttestation, "resultId">);
  return freezeDeep(dryRunAttestationBodySchema.parse({ ...body, inputIdentity, resultId }));
}

export function parseNeutralDryRunAttestation(input: unknown): NeutralDryRunAttestation {
  return freezeDeep(parseWithSchema(neutralDryRunAttestationSchema, input));
}
export const createDryRunAttestation = createNeutralDryRunAttestation;
export const parseDryRunAttestation = parseNeutralDryRunAttestation;

export function neutralDryRunInputIdentity(input: Pick<NeutralDryRunAttestation, "artifact" | "compileAttestationId" | "compileInputIdentity" | "evidenceAttestationId" | "evidenceInputIdentity" | "riskAssessmentId" | "riskInputIdentity" | "authorityAssessmentId" | "authorityInputIdentity" | "worldCutIdentity" | "foreignCatalogIdentity" | "status" | "compiler" | "checkedWatermarks" | "actionAuthorityBindings" | "diff" | "conflicts">): string {
  return digestCanonical({ kind: "neutral-dry-run-input", input: {
    artifact: input.artifact,
    compileAttestationId: input.compileAttestationId,
    compileInputIdentity: input.compileInputIdentity,
    evidence: { attestationId: input.evidenceAttestationId, inputIdentity: input.evidenceInputIdentity },
    risk: { assessmentId: input.riskAssessmentId, inputIdentity: input.riskInputIdentity },
    authority: { assessmentId: input.authorityAssessmentId, inputIdentity: input.authorityInputIdentity },
    worldCutIdentity: input.worldCutIdentity,
    foreignCatalogIdentity: input.foreignCatalogIdentity,
    status: input.status,
    compiler: input.compiler,
    checkedWatermarks: identityWatermarks(input.checkedWatermarks),
    actionAuthorityBindings: input.actionAuthorityBindings,
    diff: input.diff,
    conflicts: input.conflicts,
  } });
}
export const computeNeutralDryRunInputIdentity = neutralDryRunInputIdentity;
export const artifactDryRunInputIdentity = neutralDryRunInputIdentity;
export const computeDryRunInputIdentity = neutralDryRunInputIdentity;

export function neutralDryRunResultIdentity(input: Omit<NeutralDryRunAttestation, "resultId">): string {
  return digestCanonical({ kind: "neutral-dry-run-result", input: {
    kind: input.kind,
    artifact: input.artifact,
    inputIdentity: input.inputIdentity,
    compileAttestationId: input.compileAttestationId,
    compileInputIdentity: input.compileInputIdentity,
    evidenceAttestationId: input.evidenceAttestationId,
    evidenceInputIdentity: input.evidenceInputIdentity,
    riskAssessmentId: input.riskAssessmentId,
    riskInputIdentity: input.riskInputIdentity,
    authorityAssessmentId: input.authorityAssessmentId,
    authorityInputIdentity: input.authorityInputIdentity,
    worldCutIdentity: input.worldCutIdentity,
    foreignCatalogIdentity: input.foreignCatalogIdentity,
    status: input.status,
    compiler: input.compiler,
    checkedWatermarks: identityWatermarks(input.checkedWatermarks),
    actionAuthorityBindings: input.actionAuthorityBindings,
    diff: input.diff,
    conflicts: input.conflicts,
    writesPerformed: input.writesPerformed,
    summary: input.summary,
  } });
}
export const computeNeutralDryRunResultIdentity = neutralDryRunResultIdentity;
export const artifactDryRunResultIdentity = neutralDryRunResultIdentity;
export const computeDryRunResultIdentity = neutralDryRunResultIdentity;

/** Parse a JSON row while rejecting duplicate keys before JSON.parse last-wins behavior. */
export function parseArtifactCompileInputJson(raw: string): ArtifactCompileInput {
  return parseNeutralCompilerJson(raw, parseArtifactCompileInput);
}
export function parseArtifactCompileAttestationJson(raw: string): ArtifactCompileAttestation {
  return parseNeutralCompilerJson(raw, parseArtifactCompileAttestation);
}
export function parseNeutralDryRunAttestationJson(raw: string): NeutralDryRunAttestation {
  return parseNeutralCompilerJson(raw, parseNeutralDryRunAttestation);
}

const compileInputDraftSchema = compileInputObjectSchema;
const compileAttestationDraftSchema = z.object({
  input: compileInputDraftSchema,
  status: z.enum(["compiled", "rejected", "unavailable"]),
  plan: neutralPlanSchemaObject.optional(),
  diff: neutralDiffObjectSchema,
  conflicts: neutralConflictResultObjectSchema,
  blockingReasons: z.array(closedReasonCodeSchema).max(MAX_NEUTRAL_BLOCKING_REASONS),
}).strict();
const dryRunAttestationDraftSchema = z.object({
  compile: compileAttestationBodySchema,
  status: z.enum(["passed", "failed", "unavailable"]),
  diff: neutralDiffObjectSchema,
  conflicts: neutralConflictResultObjectSchema,
  summary: z.string().min(1).max(1_000),
}).strict();

function normalizeCompileInput(input: z.output<typeof compileInputCreateBodySchema>): z.output<typeof compileInputBodySchema> {
  const devices = sortDevices(input.worldCut.devices);
  const watermarks = sortWatermarks(input.worldCut.watermarks);
  const foreignRuleChecks = sortConflictInputs(input.foreignRuleChecks.map((check) => ({
    ...check,
    findings: sortFindings(check.findings),
  })));
  const worldCut = neutralWorldCutSchemaObject.parse({
    devices,
    watermarks,
    cutIdentity: input.worldCut.cutIdentity,
  });
  return { ...input, worldCut, foreignRuleChecks };
}

function validateCompileBindings(
  value: Pick<ArtifactCompileInput, "artifact" | "proposal" | "evidence" | "risk" | "authority" | "currentConflict" | "worldCut" | "foreignCatalogIdentity" | "foreignRuleChecks">,
  ctx: z.RefinementCtx,
): void {
  const artifactReference = artifactRef(value.artifact);
  if (!sameArtifactRef(value.evidence.artifact, artifactReference)) addIssue(ctx, ["evidence", "artifact"], "Evidence is bound to another artifact");
  if (!sameArtifactRef(value.risk.artifact, artifactReference)) addIssue(ctx, ["risk", "artifact"], "Risk is bound to another artifact");
  if (!sameArtifactRef(value.authority.artifact, artifactReference)) addIssue(ctx, ["authority", "artifact"], "Authority is bound to another artifact");
  if (value.proposal.id !== value.artifact.sourceProposal.proposalId || value.proposal.revision !== value.artifact.sourceProposal.proposalRevision) {
    addIssue(ctx, ["proposal"], "Proposal identity must match the artifact source proposal");
  }
  if (value.evidence.sourceProposal.proposalId !== value.proposal.id || value.evidence.sourceProposal.proposalRevision !== value.proposal.revision) {
    addIssue(ctx, ["evidence", "sourceProposal"], "Evidence proposal identity does not match the compiler proposal");
  }
  if (value.risk.evidence.attestationId !== value.evidence.attestationId || value.risk.evidence.inputIdentity !== value.evidence.inputIdentity) {
    addIssue(ctx, ["risk", "evidence"], "Risk evidence identity does not match the compiler evidence");
  }
  if (value.risk.authority.assessmentId !== value.authority.assessmentId || value.risk.authority.inputIdentity !== value.authority.inputIdentity) {
    addIssue(ctx, ["risk", "authority"], "Risk authority identity does not match the compiler authority");
  }
  if (value.risk.conflictInputIdentity !== value.currentConflict.sourceIdentity) {
    addIssue(ctx, ["risk", "conflictInputIdentity"], "Risk conflict identity must match the current conflict source identity");
  }
  validateAuthorityWatermarkBindings(value.authority.checkedWatermarks, value.worldCut.watermarks, ctx);
  for (const [index, check] of value.foreignRuleChecks.entries()) {
    if (check.watermark.bridgeId !== check.bridgeId) addIssue(ctx, ["foreignRuleChecks", index, "watermark", "bridgeId"], "Foreign rule watermark bridge must match its check bridge");
    if (check.watermark.epochId !== check.epochId) addIssue(ctx, ["foreignRuleChecks", index, "watermark", "epochId"], "Foreign rule watermark epoch must match its check epoch");
  }
  if (new Set(value.foreignRuleChecks.map((check) => check.bridgeId)).size !== value.foreignRuleChecks.length) {
    addIssue(ctx, ["foreignRuleChecks"], "Foreign rule checks must have unique bridges");
  }
  if (!isCanonicalConflictInputOrder(value.foreignRuleChecks)) {
    addIssue(ctx, ["foreignRuleChecks"], "Foreign rule checks must be in canonical bridge order");
  }
  if (computeNeutralForeignCatalogIdentity(value.foreignRuleChecks) !== value.foreignCatalogIdentity) {
    addIssue(ctx, ["foreignCatalogIdentity"], "Foreign catalog identity must match the complete canonical foreign checks");
  }
  validateCurrentConflictForeignFindings(value.currentConflict, value.foreignRuleChecks, ctx);
  validateForeignRuleCoverage(value.evidence.watermarks, value.worldCut.watermarks, value.foreignRuleChecks, ctx);
  const capabilityScope = deriveArtifactCapabilityScope(value.artifact.content);
  if (!sameStringSequence(value.worldCut.devices.map((device) => device.hwCapabilityId), capabilityScope)) {
    addIssue(ctx, ["worldCut", "devices"], "World-cut device IDs must exactly match the artifact capability scope");
  }
  if (!sameStringSequence(value.evidence.selectedHwCapabilityIds, capabilityScope)) {
    addIssue(ctx, ["evidence", "selectedHwCapabilityIds"], "Evidence capability IDs must exactly match the artifact capability scope");
  }
  validateWatermarkBindings(value.evidence.watermarks, value.worldCut.watermarks, ctx);
  validateActionCompatibilityBindings(value.artifact.content.actions, value.worldCut.devices, ctx);
  validatePredicateCompatibilityBindings(value.artifact.content, value.worldCut.devices, ctx);
}

function validateCurrentConflictForeignFindings(
  currentConflict: NeutralCurrentConflict,
  checks: readonly NeutralConflictInput[],
  ctx: z.RefinementCtx,
): void {
  const foreignFindings = canonicalForeignFindingUnion(checks);
  const foreignIdentities = new Set(foreignFindings.map(findingIdentity));
  for (const finding of foreignFindings) {
    if (!currentConflict.result.findings.some((candidate) => findingIdentity(candidate) === findingIdentity(finding))) {
      addIssue(ctx, ["currentConflict", "result", "findings"], "Current conflict result must include every canonical foreign-rule finding");
    }
  }
  for (const finding of currentConflict.result.findings) {
    if (!foreignIdentities.has(findingIdentity(finding)) && finding.kind !== "existing_artifact") {
      addIssue(ctx, ["currentConflict", "result", "findings"], "Current conflict result may only add existing-artifact findings beyond the foreign union");
    }
  }

  const hasUnavailableCheck = checks.some((check) => check.status === "unavailable");
  const hasDuplicateFinding = currentConflict.result.findings.some((finding) => finding.reason === "duplicate");
  const hasExistingArtifactFinding = currentConflict.result.findings.some((finding) => finding.kind === "existing_artifact");
  const expectedStatus: NeutralConflictStatus = hasUnavailableCheck
    ? "unavailable"
    : hasDuplicateFinding
      ? "duplicate"
      : currentConflict.result.findings.length === 0
        ? "none"
        : "possible_overlap";
  // A Hub-owned existing-artifact source may carry duplicate status while its
  // bounded finding reason remains existing_artifact. Preserve that source
  // fact, while rejecting every other status mismatch.
  const duplicateExistingArtifactStatus = !hasUnavailableCheck
    && currentConflict.result.status === "duplicate"
    && hasExistingArtifactFinding
    && !hasDuplicateFinding;
  if (currentConflict.result.status !== expectedStatus && !duplicateExistingArtifactStatus) {
    addIssue(ctx, ["currentConflict", "result", "status"], "Current conflict status must match the complete foreign finding union");
  }
}

function validateForeignRuleCoverage(
  evidenceWatermarks: readonly NeutralWatermark[],
  worldCutWatermarks: readonly NeutralWatermark[],
  checks: readonly NeutralConflictInput[],
  ctx: z.RefinementCtx,
): void {
  const expected = new Map(worldCutWatermarks.map((watermark) => [watermark.bridgeId, watermark]));
  if (evidenceWatermarks.length !== worldCutWatermarks.length) {
    addIssue(ctx, ["foreignRuleChecks"], "Foreign rule checks must cover the exact evidence/world-cut watermark vector");
  }
  if (checks.length !== expected.size) {
    addIssue(ctx, ["foreignRuleChecks"], "Foreign rule checks must cover every evidence/world-cut watermark bridge exactly once");
  }
  const seen = new Set<string>();
  for (const [index, check] of checks.entries()) {
    if (seen.has(check.bridgeId)) continue;
    seen.add(check.bridgeId);
    const watermark = expected.get(check.bridgeId);
    if (watermark === undefined) {
      addIssue(ctx, ["foreignRuleChecks", index, "bridgeId"], "Foreign rule check bridge is outside the evidence/world-cut watermark vector");
      continue;
    }
    if (check.epochId !== watermark.epochId || !sameWatermarkSemantics(check.watermark, watermark)) {
      addIssue(ctx, ["foreignRuleChecks", index, "watermark"], "Foreign rule check watermark must exactly match the world-cut watermark");
    }
  }
  for (const bridgeId of expected.keys()) {
    if (!seen.has(bridgeId)) addIssue(ctx, ["foreignRuleChecks"], `Missing foreign rule check for watermark bridge ${bridgeId}`);
  }
}

function validateWatermarkBindings(
  evidenceWatermarks: readonly NeutralWatermark[],
  worldCutWatermarks: readonly NeutralWatermark[],
  ctx: z.RefinementCtx,
): void {
  const evidenceByBridge = new Map(evidenceWatermarks.map((watermark) => [watermark.bridgeId, watermark]));
  const worldCutByBridge = new Map(worldCutWatermarks.map((watermark) => [watermark.bridgeId, watermark]));
  if (evidenceByBridge.size !== worldCutByBridge.size) {
    addIssue(ctx, ["worldCut", "watermarks"], "World-cut watermarks must exactly match evidence watermarks");
  }
  for (const [bridgeId, evidenceWatermark] of evidenceByBridge) {
    const worldCutWatermark = worldCutByBridge.get(bridgeId);
    if (worldCutWatermark === undefined || !sameWatermarkSemantics(evidenceWatermark, worldCutWatermark)) {
      addIssue(ctx, ["worldCut", "watermarks"], `World-cut watermark ${bridgeId} must match evidence bridge, epoch, sequence, freshness, and gap`);
    }
  }
  for (const bridgeId of worldCutByBridge.keys()) {
    if (!evidenceByBridge.has(bridgeId)) {
      addIssue(ctx, ["worldCut", "watermarks"], `World-cut watermark ${bridgeId} is not present in evidence`);
    }
  }
}

function validateAuthorityWatermarkBindings(
  authorityWatermarks: readonly NeutralWatermark[],
  worldCutWatermarks: readonly NeutralWatermark[],
  ctx: z.RefinementCtx,
): void {
  const worldCutByBridge = new Map(worldCutWatermarks.map((watermark) => [watermark.bridgeId, watermark]));
  const seen = new Set<string>();
  for (const authorityWatermark of authorityWatermarks) {
    const bridgeId = authorityWatermark.bridgeId;
    const worldCutWatermark = worldCutByBridge.get(bridgeId);
    if (seen.has(bridgeId)
      || worldCutWatermark === undefined
      || !sameWatermarkSemantics(authorityWatermark, worldCutWatermark)) {
      addIssue(ctx, ["authority", "checkedWatermarks"], `Authority watermark ${bridgeId} must be a unique exact subset of the world cut`);
    }
    seen.add(bridgeId);
  }
}

function sameWatermarkSemantics(left: NeutralWatermark, right: NeutralWatermark): boolean {
  return left.bridgeId === right.bridgeId
    && left.epochId === right.epochId
    && left.lastSeq === right.lastSeq
    && left.freshness === right.freshness
    && left.gapCount === right.gapCount;
}

function validateActionCompatibilityBindings(
  actions: ArtifactContent["actions"],
  devices: readonly NeutralDeviceSummary[],
  ctx: z.RefinementCtx,
): void {
  const devicesByCapability = new Map(devices.map((device, index) => [device.hwCapabilityId, { device, index }]));
  const expectedByCapability = new Map<string, readonly { action: ArtifactAction; order: number }[]>();
  for (const [index, action] of actions.entries()) {
    if (action.kind !== "set_level" && action.kind !== "set_boolean") continue;
    const existing = expectedByCapability.get(action.target.hwCapabilityId) ?? [];
    expectedByCapability.set(action.target.hwCapabilityId, [...existing, { action, order: index + 1 }]);
  }

  for (const [deviceIndex, entry] of devicesByCapability.entries()) {
    const expected = expectedByCapability.get(deviceIndex) ?? [];
    const projections = entry.device.actionCompatibility;
    if (expected.length !== projections.length) {
      addIssue(ctx, ["worldCut", "devices", entry.index, "actionCompatibility"], "Device action compatibility projection count must match artifact device actions");
      continue;
    }
    for (let projectionIndex = 0; projectionIndex < projections.length; projectionIndex += 1) {
      const projection = projections[projectionIndex]!;
      const expectedAction = expected[projectionIndex]!;
      if (projection.order !== expectedAction.order) {
        addIssue(ctx, ["worldCut", "devices", entry.index, "actionCompatibility", projectionIndex, "order"], "Action compatibility projection order must match artifact action order");
      }
      if (projection.kind !== expectedAction.action.kind) {
        addIssue(ctx, ["worldCut", "devices", entry.index, "actionCompatibility", projectionIndex, "kind"], "Action compatibility kind must match the artifact action kind");
      }
      if (projection.status === "compatible") {
        if (expectedAction.action.kind === "set_level" && projection.after !== expectedAction.action.value) {
          addIssue(ctx, ["worldCut", "devices", entry.index, "actionCompatibility", projectionIndex, "after"], "Compatible set_level after value must match the artifact action");
        }
        if (expectedAction.action.kind === "set_boolean" && projection.after !== expectedAction.action.value) {
          addIssue(ctx, ["worldCut", "devices", entry.index, "actionCompatibility", projectionIndex, "after"], "Compatible set_boolean after value must match the artifact action");
        }
      }
    }
  }

  for (const [capabilityId, expected] of expectedByCapability.entries()) {
    if (expected.length === 0 || devicesByCapability.has(capabilityId)) continue;
    addIssue(ctx, ["worldCut", "devices"], `Missing NeutralDeviceSummary for artifact device action target ${capabilityId}`);
  }
}

function validatePredicateCompatibilityBindings(
  content: ArtifactContent,
  devices: readonly NeutralDeviceSummary[],
  ctx: z.RefinementCtx,
): void {
  const devicesByCapability = new Map(devices.map((device, index) => [device.hwCapabilityId, { device, index }]));
  const expectedByCapability = new Map<string, readonly { phase: "condition" | "postcondition"; order: number }[]>();
  for (const [index, condition] of content.conditions.entries()) {
    const existing = expectedByCapability.get(condition.source.hwCapabilityId) ?? [];
    expectedByCapability.set(condition.source.hwCapabilityId, [...existing, { phase: "condition", order: index + 1 }]);
  }
  for (const [index, postcondition] of content.postconditions.entries()) {
    const existing = expectedByCapability.get(postcondition.source.hwCapabilityId) ?? [];
    expectedByCapability.set(postcondition.source.hwCapabilityId, [...existing, { phase: "postcondition", order: index + 1 }]);
  }

  for (const [capabilityId, entry] of devicesByCapability) {
    const expected = expectedByCapability.get(capabilityId) ?? [];
    const projections = entry.device.predicateCompatibility;
    if (expected.length !== projections.length) {
      addIssue(ctx, ["worldCut", "devices", entry.index, "predicateCompatibility"], "Device predicate compatibility projection count must match artifact predicates");
      continue;
    }
    for (let projectionIndex = 0; projectionIndex < projections.length; projectionIndex += 1) {
      const projection = projections[projectionIndex]!;
      const expectedPredicate = expected[projectionIndex]!;
      if (projection.phase !== expectedPredicate.phase) {
        addIssue(ctx, ["worldCut", "devices", entry.index, "predicateCompatibility", projectionIndex, "phase"], "Predicate compatibility phase must match the artifact predicate");
      }
      if (projection.order !== expectedPredicate.order) {
        addIssue(ctx, ["worldCut", "devices", entry.index, "predicateCompatibility", projectionIndex, "order"], "Predicate compatibility order must match the artifact phase order");
      }
    }
  }
  for (const [capabilityId] of expectedByCapability) {
    if (!devicesByCapability.has(capabilityId)) {
      addIssue(ctx, ["worldCut", "devices"], `Missing NeutralDeviceSummary for artifact predicate source ${capabilityId}`);
    }
  }
}

function sameStringSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortClosedReasons(reasons: readonly ClosedReasonCode[]): ClosedReasonCode[] {
  return [...reasons].sort(compareUnicodeCodePoints);
}

function deriveActionAuthorityBindings(
  actions: ArtifactContent["actions"],
  authority: ArtifactAuthorityAssessment,
): { readonly bindings: readonly NeutralActionAuthorityBinding[]; readonly unavailable: boolean } {
  const bindings: NeutralActionAuthorityBinding[] = [];
  let unavailable = false;
  for (const [index, action] of actions.entries()) {
    if (action.kind === "notify_local") continue;
    const candidates = authority.candidates.filter((candidate) =>
      candidate.hwCapabilityId === action.target.hwCapabilityId && candidate.status === "available",
    );
    if (candidates.length !== 1) {
      unavailable = true;
      continue;
    }
    bindings.push({
      actionOrder: index + 1,
      kind: action.kind,
      hwCapabilityId: action.target.hwCapabilityId,
      actionAuthorityCandidateId: candidates[0]!.actionAuthorityCandidateId,
    });
  }
  return { bindings: unavailable ? [] : bindings, unavailable };
}

function assertDiffBindings(
  actions: ArtifactContent["actions"],
  diff: NeutralDiff,
  actionAuthorityBindings: readonly NeutralActionAuthorityBinding[],
): void {
  if (diff.operations.length + diff.unchangedCount > actions.length) {
    throw new ArtifactCompilerContractError("invalid_contract", "Diff operation and unchanged counts exceed artifact actions");
  }
  if (diff.status === "no_change") {
    const deviceActionCount = actions.filter((action) => action.kind !== "notify_local").length;
    if (diff.unchangedCount !== deviceActionCount) {
      throw new ArtifactCompilerContractError("invalid_contract", "A no_change diff must account for every device action");
    }
    if (deviceActionCount === 0) {
      throw new ArtifactCompilerContractError("invalid_contract", "A notify-only artifact cannot produce a no_change diff");
    }
  }
  if (diff.status === "unavailable" && diff.operations.length !== 0) {
    throw new ArtifactCompilerContractError("invalid_contract", "An unavailable diff cannot contain operations");
  }
  for (const operation of diff.operations) {
    const action = actions[operation.actionOrder - 1];
    if (action === undefined) {
      throw new ArtifactCompilerContractError("invalid_contract", "Diff actionOrder must reference an artifact action");
    }
    if (operation.kind !== action.kind) {
      throw new ArtifactCompilerContractError("invalid_contract", "Diff operation kind must match its artifact action");
    }
    if (action.kind === "notify_local") {
      if (operation.after !== action.message) {
        throw new ArtifactCompilerContractError("invalid_contract", "Notify diff after value must match its artifact message");
      }
      continue;
    }
    if (operation.kind === "notify_local" || operation.hwCapabilityId !== action.target.hwCapabilityId) {
      throw new ArtifactCompilerContractError("invalid_contract", "Diff operation target must match its artifact action");
    }
    const binding = actionAuthorityBindings.find((candidate) => candidate.actionOrder === operation.actionOrder);
    if (binding === undefined || operation.actionAuthorityCandidateId !== binding.actionAuthorityCandidateId) {
      throw new ArtifactCompilerContractError("invalid_contract", "Diff operation candidate must match its action authority binding");
    }
    if (operation.after !== action.value) {
      throw new ArtifactCompilerContractError("invalid_contract", "Diff operation after value must match its artifact action value");
    }
  }
}

function expectedDryRunStatus(compile: ArtifactCompileAttestation): NeutralDryRunAttestation["status"] {
  if (compile.status === "unavailable") return "unavailable";
  if (compile.status === "rejected") return "failed";
  return compile.diff.status !== "unavailable" && compile.conflicts.status === "none" ? "passed" : "failed";
}

function validateCompileAttestationSemantics(value: Pick<ArtifactCompileAttestation, "status" | "plan" | "blockingReasons" | "diff" | "conflicts">, ctx: z.RefinementCtx): void {
  if (value.status === "compiled" && value.plan === undefined) addIssue(ctx, ["plan"], "Compiled output requires a neutral plan");
  if (value.status === "compiled" && value.blockingReasons.length !== 0) addIssue(ctx, ["blockingReasons"], "Compiled output cannot have blocking reasons");
  if (value.status !== "compiled" && value.blockingReasons.length === 0) addIssue(ctx, ["blockingReasons"], "Rejected or unavailable output requires blocking reasons");
  if (value.status !== "compiled" && value.plan !== undefined) addIssue(ctx, ["plan"], "Rejected or unavailable output cannot carry a compiled plan");
  if (value.status === "compiled" && value.diff.status === "unavailable") addIssue(ctx, ["diff", "status"], "Compiled output cannot have an unavailable diff");
  if (value.status === "compiled" && value.conflicts.status === "unavailable") addIssue(ctx, ["conflicts", "status"], "Compiled output cannot hide unavailable conflicts");
}

function validateDryRunAttestationSemantics(value: Pick<NeutralDryRunAttestation, "status" | "diff" | "conflicts">, ctx: z.RefinementCtx): void {
  if (value.status === "passed" && value.diff.status === "unavailable") addIssue(ctx, ["diff", "status"], "A passed dry-run cannot have an unavailable diff");
  if (value.status === "passed" && value.conflicts.status === "unavailable") addIssue(ctx, ["conflicts", "status"], "A passed dry-run cannot hide unavailable conflicts");
  if (value.status === "passed" && value.conflicts.status !== "none") addIssue(ctx, ["conflicts", "status"], "A passed dry-run requires no conflicts");
}

function artifactRef(value: Pick<ArtifactRevision, "artifactId" | "revision" | "contentHash">): ArtifactRef {
  return { artifactId: value.artifactId, revision: value.revision, contentHash: value.contentHash };
}

function evidenceIdentityRef(value: ArtifactEvidenceAttestation): NeutralEvidenceIdentityRef {
  return { attestationId: value.attestationId, inputIdentity: value.inputIdentity };
}

function riskIdentityRef(value: ArtifactRiskAssessment): NeutralRiskIdentityRef {
  return { assessmentId: value.assessmentId, inputIdentity: value.inputIdentity };
}

function authorityIdentityRef(value: ArtifactAuthorityAssessment): NeutralAuthorityIdentityRef {
  return { assessmentId: value.assessmentId, inputIdentity: value.inputIdentity };
}

function sameArtifactRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.artifactId === right.artifactId && left.revision === right.revision && left.contentHash === right.contentHash;
}

function identityWatermarks(watermarks: readonly NeutralWatermark[]): readonly unknown[] {
  return sortWatermarks(watermarks).map(identityWatermark);
}

function identityWatermark({ bridgeId, epochId, lastSeq, freshness, gapCount }: NeutralWatermark): unknown {
  return { bridgeId, epochId, lastSeq, freshness, gapCount };
}

function sortDevices<T extends { readonly hwCapabilityId: string }>(devices: readonly T[]): T[] {
  return [...devices].sort((left, right) => compareUnicodeCodePoints(left.hwCapabilityId, right.hwCapabilityId));
}

function sortWatermarks<T extends { readonly bridgeId: string }>(watermarks: readonly T[]): T[] {
  return [...watermarks].sort((left, right) => compareUnicodeCodePoints(left.bridgeId, right.bridgeId));
}

function sortConflictInputs(inputs: readonly NeutralConflictInput[]): NeutralConflictInput[] {
  return [...inputs].sort((left, right) => compareUnicodeCodePoints(
    `${left.bridgeId}\u0000${left.epochId}\u0000${left.catalogIdentity}`,
    `${right.bridgeId}\u0000${right.epochId}\u0000${right.catalogIdentity}`,
  ));
}

function isCanonicalConflictInputOrder(inputs: readonly NeutralConflictInput[]): boolean {
  return inputs.every((input, index) => index === 0 || compareUnicodeCodePoints(
    `${inputs[index - 1]!.bridgeId}\u0000${inputs[index - 1]!.epochId}\u0000${inputs[index - 1]!.catalogIdentity}`,
    `${input.bridgeId}\u0000${input.epochId}\u0000${input.catalogIdentity}`,
  ) <= 0);
}

function sortFindings(findings: readonly NeutralConflictFinding[]): NeutralConflictFinding[] {
  return [...findings].sort((left, right) => compareUnicodeCodePoints(findingIdentity(left), findingIdentity(right)));
}

function canonicalForeignFindingUnion(checks: readonly NeutralConflictInput[]): NeutralConflictFinding[] {
  const unique = new Map<string, NeutralConflictFinding>();
  for (const check of checks) {
    for (const finding of check.findings) {
      const identity = findingIdentity(finding);
      if (!unique.has(identity)) unique.set(identity, finding);
    }
  }
  return sortFindings([...unique.values()]);
}

function findingIdentity(finding: NeutralConflictFinding): string {
  return `${finding.kind}\u0000${finding.severity}\u0000${finding.reason}\u0000${finding.hwCapabilityId ?? ""}\u0000${finding.reference ?? ""}`;
}

function isCanonicalDeviceOrder<T extends { readonly hwCapabilityId: string }>(devices: readonly T[]): boolean {
  return devices.every((device, index) => index === 0 || compareUnicodeCodePoints(devices[index - 1]!.hwCapabilityId, device.hwCapabilityId) <= 0);
}

function isCanonicalWatermarkOrder<T extends { readonly bridgeId: string }>(watermarks: readonly T[]): boolean {
  return watermarks.every((watermark, index) => index === 0 || compareUnicodeCodePoints(watermarks[index - 1]!.bridgeId, watermark.bridgeId) <= 0);
}

function isCanonicalFindingOrder(findings: readonly NeutralConflictFinding[]): boolean {
  return findings.every((finding, index) => index === 0 || compareUnicodeCodePoints(findingIdentity(findings[index - 1]!), findingIdentity(finding)) <= 0);
}

function validateUnique(values: readonly string[], kind: "device" | "bridge" | "finding"): void {
  if (new Set(values).size === values.length) return;
  throw new ArtifactCompilerContractError("invalid_contract", `Duplicate ${kind} entry`);
}

function addIssue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

function isNormalizedLevel(value: NeutralScalar): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function predicateCompatibilityOrder(value: Pick<NeutralPredicateCompatibility, "phase" | "order">): [number, number] {
  return [value.phase === "condition" ? 0 : 1, value.order];
}

function comparePredicateCompatibility(
  left: Pick<NeutralPredicateCompatibility, "phase" | "order">,
  right: Pick<NeutralPredicateCompatibility, "phase" | "order">,
): number {
  const [leftPhase, leftOrder] = predicateCompatibilityOrder(left);
  const [rightPhase, rightOrder] = predicateCompatibilityOrder(right);
  return leftPhase - rightPhase || leftOrder - rightOrder;
}

function hasOwnProperty(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function omitKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const output = { ...value };
  delete output[key];
  return output;
}

function parseWithSchema<T extends ZodType>(schema: T, input: unknown): z.output<T> {
  try {
    preflightCompilerInput(input);
    const parsed = schema.parse(input);
    return parsed;
  } catch (error) {
    if (error instanceof ArtifactCompilerContractError) throw error;
    throw new ArtifactCompilerContractError("invalid_contract", error instanceof Error ? error.message : "Invalid neutral compiler contract input");
  }
}

function preflightForSchema(input: unknown, ctx: z.RefinementCtx): unknown {
  try {
    return preflightCompilerInput(input);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid neutral compiler contract input",
    });
    return z.NEVER;
  }
}

function preflightCompilerInput(input: unknown): unknown {
  const budget = { fields: 0, totalFields: 0, arrays: 0, totalArrays: 0, stringBytes: 0, totalStringBytes: 0 };
  inspectCompilerValue(input, 0, new WeakSet<object>(), budget);
  return input;
}

interface CompilerBudget {
  fields: number;
  totalFields: number;
  arrays: number;
  totalArrays: number;
  stringBytes: number;
  totalStringBytes: number;
}

function inspectCompilerValue(value: unknown, depth: number, seen: WeakSet<object>, budget: CompilerBudget): void {
  if (depth > MAX_COMPILER_DEPTH) throw new ArtifactCompilerContractError("resource_exhausted", "Compiler input nesting exceeds the resource budget");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > MAX_COMPILER_STRING_BYTES || bytes > MAX_TEXT_BYTES) throw new ArtifactCompilerContractError("resource_exhausted", "Compiler string exceeds the byte budget");
    if (URL_PATTERN.test(value)) throw new ArtifactCompilerContractError("forbidden_field", "Compiler input contains a URL");
    budget.stringBytes += bytes;
    budget.totalStringBytes += bytes;
    if (budget.totalStringBytes > MAX_COMPILER_TOTAL_STRING_BYTES) throw new ArtifactCompilerContractError("resource_exhausted", "Compiler strings exceed the total byte budget");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ArtifactCompilerContractError("invalid_contract", "Compiler input contains a non-finite scalar");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new ArtifactCompilerContractError("invalid_contract", "Compiler input contains an unsafe integer");
    return;
  }
  if (typeof value !== "object") throw new ArtifactCompilerContractError("invalid_contract", "Compiler input contains an unsupported value");
  if (seen.has(value)) throw new ArtifactCompilerContractError("invalid_contract", "Compiler input contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_COMPILER_ARRAY_LENGTH) throw new ArtifactCompilerContractError("resource_exhausted", "Compiler array exceeds the item budget");
      budget.arrays += value.length;
      budget.totalArrays += value.length;
      if (budget.totalArrays > MAX_COMPILER_TOTAL_ARRAY_ITEMS) throw new ArtifactCompilerContractError("resource_exhausted", "Compiler arrays exceed the total item budget");
      for (const item of value) inspectCompilerValue(item, depth + 1, seen, budget);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new ArtifactCompilerContractError("invalid_contract", "Compiler input must contain plain objects");
    const keys = Object.keys(value);
    if (keys.length > MAX_COMPILER_FIELDS) throw new ArtifactCompilerContractError("resource_exhausted", "Compiler object exceeds the field budget");
    budget.fields += keys.length;
    budget.totalFields += keys.length;
    if (budget.totalFields > MAX_COMPILER_TOTAL_FIELDS) throw new ArtifactCompilerContractError("resource_exhausted", "Compiler objects exceed the total field budget");
    for (const key of keys) {
      if (isForbiddenField(key)) throw new ArtifactCompilerContractError("forbidden_field", `Compiler input contains forbidden field ${key}`);
      inspectCompilerValue((value as Record<string, unknown>)[key], depth + 1, seen, budget);
    }
  } finally {
    seen.delete(value);
  }
}

function isForbiddenField(key: string): boolean {
  if (forbiddenFieldNames.has(key)) return true;
  return /^(?:native|provider|remote|raw|secret|credential|route|service|url|uri|token|password|privateKey|accessToken|refreshToken)/iu.test(key);
}

function canonicalJson(value: unknown): string {
  preflightCompilerInput(value);
  const normalized = canonicalValue(value, 0, new WeakSet<object>());
  const encoded = JSON.stringify(normalized);
  if (encoded === undefined) throw new ArtifactCompilerContractError("invalid_contract", "Value is not JSON-canonicalizable");
  if (Buffer.byteLength(encoded, "utf8") > MAX_COMPILER_CANONICAL_BYTES) throw new ArtifactCompilerContractError("resource_exhausted", "Canonical compiler input exceeds the byte budget");
  return encoded;
}

function canonicalValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ArtifactCompilerContractError("invalid_contract", "Value contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") throw new ArtifactCompilerContractError("invalid_contract", "Value contains an unsupported type");
  if (depth > MAX_COMPILER_DEPTH) throw new ArtifactCompilerContractError("resource_exhausted", "Canonical value exceeds the depth budget");
  if (seen.has(value)) throw new ArtifactCompilerContractError("invalid_contract", "Value contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalValue(item, depth + 1, seen));
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareUnicodeCodePoints)) output[key] = canonicalValue((value as Record<string, unknown>)[key], depth + 1, seen);
    return output;
  } finally {
    seen.delete(value);
  }
}

function digestCanonical(value: unknown): string {
  const canonical = canonicalJson(value);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function parseNeutralCompilerJson<T>(raw: string, parser: (input: unknown) => T): T {
  if (typeof raw !== "string") throw new ArtifactCompilerContractError("invalid_contract", "Compiler JSON must be a string");
  if (Buffer.byteLength(raw, "utf8") > MAX_COMPILER_CANONICAL_BYTES) throw new ArtifactCompilerContractError("resource_exhausted", "Compiler JSON exceeds the byte budget");
  assertNoDuplicateJsonKeys(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ArtifactCompilerContractError("invalid_contract", "Compiler JSON is malformed");
  }
  return parser(parsed);
}

function assertNoDuplicateJsonKeys(raw: string): void {
  let index = 0;
  const fail = (): never => { throw new ArtifactCompilerContractError("invalid_contract", "Compiler JSON is malformed"); };
  const skipWhitespace = (): void => { while (index < raw.length && /[\u0020\u0009\u000a\u000d]/u.test(raw[index]!)) index += 1; };
  const parseString = (): string => {
    const start = index;
    if (raw[index] !== '"') fail();
    index += 1;
    while (index < raw.length) {
      const character = raw[index]!;
      if (character === '"') {
        index += 1;
        try { return JSON.parse(raw.slice(start, index)) as string; } catch { fail(); }
      }
      if (character === "\\") { index += 2; continue; }
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
      if (raw[index] === "}") { index += 1; return; }
      while (index < raw.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw new ArtifactCompilerContractError("duplicate_json_key", "Compiler JSON contains a duplicate object key");
        keys.add(key);
        skipWhitespace();
        if (raw[index] !== ":") fail();
        index += 1;
        parseValue();
        skipWhitespace();
        if (raw[index] === "}") { index += 1; return; }
        if (raw[index] !== ",") fail();
        index += 1;
      }
      fail();
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      if (raw[index] === "]") { index += 1; return; }
      while (index < raw.length) {
        parseValue();
        skipWhitespace();
        if (raw[index] === "]") { index += 1; return; }
        if (raw[index] !== ",") fail();
        index += 1;
      }
      fail();
    }
    if (character === '"') { parseString(); return; }
    if (raw.startsWith("true", index)) { index += 4; return; }
    if (raw.startsWith("false", index)) { index += 5; return; }
    if (raw.startsWith("null", index)) { index += 4; return; }
    const number = raw.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (number !== undefined) { index += number.length; return; }
    fail();
  };
  parseValue();
  skipWhitespace();
  if (index !== raw.length) fail();
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested);
  return value;
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
