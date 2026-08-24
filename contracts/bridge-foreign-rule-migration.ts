import { z } from "zod";

import type { ExtensionDeclaration } from "./bridge-contract.js";

const MAX_RULE_REF_BYTES = 512;
const MAX_BINDING_FIELD_BYTES = 1_024;
const MAX_TITLE_BYTES = 2_048;
const MAX_MESSAGE_BYTES = 2_048;
const MAX_TIMEZONE_BYTES = 512;
const utf8Encoder = new TextEncoder();

export const MAX_FOREIGN_RULE_MIGRATION_CONDITIONS = 8;
export const MAX_FOREIGN_RULE_MIGRATION_ACTIONS = 4;

const boundedUtf8 = (maxCharacters: number, maxBytes: number) => z
  .string()
  .trim()
  .min(1)
  .max(maxCharacters)
  .superRefine((value, context) => {
    if (utf8Encoder.encode(value).byteLength > maxBytes) {
      context.addIssue({ code: "too_big", maximum: maxBytes, origin: "string", inclusive: true, message: "value exceeds the byte limit" });
    }
    if (/[\u0000-\u001f\u007f]/u.test(value)) {
      context.addIssue({ code: "custom", message: "value contains a control character" });
    }
  });

const boundedRuleRef = boundedUtf8(200, MAX_RULE_REF_BYTES);
const boundedBindingField = boundedUtf8(256, MAX_BINDING_FIELD_BYTES);
const boundedTitle = boundedUtf8(512, MAX_TITLE_BYTES);
const boundedMessage = boundedUtf8(512, MAX_MESSAGE_BYTES);
const boundedTimezone = boundedUtf8(128, MAX_TIMEZONE_BYTES);
const migrationScalar = z.union([
  boundedUtf8(512, MAX_MESSAGE_BYTES),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const FOREIGN_RULE_MIGRATION_EXTENSION = Object.freeze({
  id: "foreignRuleMigration",
  version: "1.0.0",
}) satisfies ExtensionDeclaration;

/** A route local to one registered bridge; Hub resolves it to a hwCapabilityId. */
export const foreignRuleMigrationBindingSchema = z.object({
  bridgeId: boundedBindingField,
  nativeId: boundedBindingField,
  nativeInstanceId: boundedBindingField,
}).strict();
export type ForeignRuleMigrationBinding = z.infer<typeof foreignRuleMigrationBindingSchema>;

export const foreignRuleMigrationTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("schedule"),
    timezone: boundedTimezone,
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7)
      .superRefine((days, context) => {
        if (new Set(days).size !== days.length) context.addIssue({ code: "custom", message: "daysOfWeek must be unique" });
      }),
    at: z.string().regex(/^\d{2}:\d{2}$/u),
  }).strict(),
  z.object({
    kind: z.literal("capability_changed"),
    source: foreignRuleMigrationBindingSchema,
  }).strict(),
]);
export type ForeignRuleMigrationTrigger = z.infer<typeof foreignRuleMigrationTriggerSchema>;

export const foreignRuleMigrationConditionSchema = z.object({
  kind: z.literal("capability_value"),
  source: foreignRuleMigrationBindingSchema,
  operator: z.enum(["equals", "not_equals", "greater_than", "less_than"]),
  value: migrationScalar,
}).strict();
export type ForeignRuleMigrationCondition = z.infer<typeof foreignRuleMigrationConditionSchema>;

export const foreignRuleMigrationActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("set_boolean"),
    target: foreignRuleMigrationBindingSchema,
    value: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("set_level"),
    target: foreignRuleMigrationBindingSchema,
    level: z.number().finite().min(0).max(1),
  }).strict(),
  z.object({
    kind: z.literal("notify_local"),
    message: boundedMessage,
  }).strict(),
]);
export type ForeignRuleMigrationAction = z.infer<typeof foreignRuleMigrationActionSchema>;

/** The neutral ECA intersection accepted by the first HA migration slice. */
export const foreignRuleMigrationPlanSchema = z.object({
  trigger: foreignRuleMigrationTriggerSchema,
  conditions: z.array(foreignRuleMigrationConditionSchema).max(MAX_FOREIGN_RULE_MIGRATION_CONDITIONS),
  actions: z.array(foreignRuleMigrationActionSchema).min(1).max(MAX_FOREIGN_RULE_MIGRATION_ACTIONS),
}).strict();
export type ForeignRuleMigrationPlan = z.infer<typeof foreignRuleMigrationPlanSchema>;

export const foreignRuleMigrationRequestSchema = z.object({
  /** The opaque identifier copied from the currently bound foreignRules@2 catalog. */
  ruleRef: boundedRuleRef,
}).strict();
export type ForeignRuleMigrationRequest = z.infer<typeof foreignRuleMigrationRequestSchema>;

const unsupportedReasonSchema = z.enum([
  "unknown_rule",
  "mode_not_single",
  "multiple_triggers",
  "unsupported_trigger",
  "unsupported_condition",
  "unsupported_action",
  "multiple_targets",
  "unbound_target",
  "unsupported_structure",
]);
export type ForeignRuleMigrationUnsupportedReason = z.infer<typeof unsupportedReasonSchema>;

const unavailableReasonSchema = z.enum([
  "not_ready",
  "upstream_unavailable",
  "invalid_response",
  "cancelled",
]);
export type ForeignRuleMigrationUnavailableReason = z.infer<typeof unavailableReasonSchema>;

export const foreignRuleMigrationResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("translated"),
    ruleRef: boundedRuleRef,
    sourceFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    title: boundedTitle,
    plan: foreignRuleMigrationPlanSchema,
  }).strict(),
  z.object({
    status: z.literal("unsupported"),
    reason: unsupportedReasonSchema,
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    reason: unavailableReasonSchema,
  }).strict(),
]);
export type ForeignRuleMigrationResult = z.infer<typeof foreignRuleMigrationResultSchema>;

export interface ForeignRuleMigrationHandle {
  /** Reads one opaque catalog rule and never writes or executes it. */
  translate(
    request: ForeignRuleMigrationRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<ForeignRuleMigrationResult>;
}

declare module "./bridge-contract.js" {
  interface ExtensionHandleRegistry {
    "foreignRuleMigration@1": ForeignRuleMigrationHandle;
  }
}
