import { z } from "zod";

import type { ExtensionDeclaration } from "./bridge-contract.js";

const boundedNeutralReference = (maximum: number, name: string) => z.string()
  .min(1)
  .max(maximum)
  .refine((value) => value.trim() === value, `${name} must not have surrounding whitespace`)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), `${name} must not contain control characters`);

const ruleRefSchema = boundedNeutralReference(200, "ruleRef");
const epochIdSchema = boundedNeutralReference(256, "epochId");
const safeSequenceSchema = z.number()
  .finite()
  .int()
  .positive()
  .refine(Number.isSafeInteger, "seq must be a safe integer");
const isoOffsetTimestampSchema = z.iso.datetime({ offset: true });
const automationLabelSchema = boundedNeutralReference(256, "automationLabel");
export const MAX_AUTOMATION_TRACE_COVERAGE_ENTITIES = 4096;
const automationTraceCoverageCountSchema = z.number()
  .int()
  .nonnegative()
  .max(MAX_AUTOMATION_TRACE_COVERAGE_ENTITIES)
  .refine(Number.isSafeInteger, "coverage counts must be safe integers");

export const AUTOMATION_TRACE_EXTENSION = Object.freeze({
  id: "automationTrace",
  version: "1.0.0",
}) satisfies ExtensionDeclaration;
export const AUTOMATION_TRACE_EXTENSION_KEY = "automationTrace@1" as const;

export const automationTraceCoverageSchema = z.object({
  status: z.enum(["complete", "partial", "unavailable"]),
  totalAutomationEntities: automationTraceCoverageCountSchema,
  stableTraceIdentityEntities: automationTraceCoverageCountSchema,
  missingTraceIdentityEntities: automationTraceCoverageCountSchema,
  ambiguousTraceIdentityEntities: automationTraceCoverageCountSchema,
}).strict().superRefine((coverage, context) => {
  if (coverage.stableTraceIdentityEntities
    + coverage.missingTraceIdentityEntities
    + coverage.ambiguousTraceIdentityEntities !== coverage.totalAutomationEntities) {
    context.addIssue({ code: "custom", message: "coverage counts must partition automation entities" });
  }
  if (coverage.status === "complete"
    && (coverage.missingTraceIdentityEntities > 0 || coverage.ambiguousTraceIdentityEntities > 0)) {
    context.addIssue({ code: "custom", message: "complete coverage cannot contain missing or ambiguous identities" });
  }
});
export type AutomationTraceCoverage = z.infer<typeof automationTraceCoverageSchema>;
export const AutomationTraceCoverageSchema = automationTraceCoverageSchema;

export const automationTraceReasonSchema = z.enum([
  "permission_denied",
  "bridge_not_ready",
  "busy",
  "timeout",
  "cancelled",
  "invalid_response",
  "trace_not_retained",
  "rule_not_found",
  "association_missing",
  "association_stale",
  "resync_stale",
  "unsupported_trace",
]);
export type AutomationTraceReason = z.infer<typeof automationTraceReasonSchema>;
export const AutomationTraceReasonSchema = automationTraceReasonSchema;

export const automationTraceTargetSchema = z.object({
  epochId: epochIdSchema,
  seq: safeSequenceSchema,
}).strict();
export type AutomationTraceTarget = z.infer<typeof automationTraceTargetSchema>;
export const AutomationTraceTargetSchema = automationTraceTargetSchema;

export const automationTraceRequestSchema = z.object({
  ruleRef: ruleRefSchema,
  target: automationTraceTargetSchema,
}).strict();
export type AutomationTraceRequest = z.infer<typeof automationTraceRequestSchema>;
export const AutomationTraceRequestSchema = automationTraceRequestSchema;

export const automationTraceStepSchema = z.object({
  ordinal: z.number()
    .finite()
    .int()
    .min(1)
    .max(32)
    .refine(Number.isSafeInteger, "ordinal must be a safe integer"),
  kind: z.enum(["trigger", "condition", "action", "wait", "branch", "unknown"]),
  status: z.enum(["executed", "passed", "skipped", "failed", "unknown"]),
  errorKind: z.enum(["action_failed", "template_failed", "timeout", "unknown"]).optional(),
}).strict();
export type AutomationTraceStep = z.infer<typeof automationTraceStepSchema>;
export const AutomationTraceStepSchema = automationTraceStepSchema;

export const automationTraceRunSchema = z.object({
  automationLabel: automationLabelSchema.optional(),
  state: z.enum(["running", "completed", "failed", "unknown"]),
  outcome: z.enum(["completed", "condition_not_met", "failed", "cancelled", "unknown"]),
  startedAt: isoOffsetTimestampSchema.optional(),
  finishedAt: isoOffsetTimestampSchema.optional(),
  steps: z.array(automationTraceStepSchema).max(32).superRefine((steps, context) => {
    const ordinals = new Set<number>();
    for (const [index, step] of steps.entries()) {
      if (ordinals.has(step.ordinal)) {
        context.addIssue({
          code: "custom",
          path: [index, "ordinal"],
          message: "step ordinals must be unique",
        });
      }
      ordinals.add(step.ordinal);
    }
  }),
  truncated: z.boolean(),
}).strict().superRefine((run, context) => {
  if (run.startedAt !== undefined
    && run.finishedAt !== undefined
    && Date.parse(run.finishedAt) < Date.parse(run.startedAt)) {
    context.addIssue({
      code: "custom",
      path: ["finishedAt"],
      message: "finishedAt must not precede startedAt",
    });
  }
});
export type AutomationTraceRun = z.infer<typeof automationTraceRunSchema>;
export const AutomationTraceRunSchema = automationTraceRunSchema;

const automationTraceReasonsSchema = z.array(automationTraceReasonSchema)
  .min(1)
  .max(automationTraceReasonSchema.options.length)
  .superRefine((reasons, context) => {
    if (new Set(reasons).size !== reasons.length) {
      context.addIssue({ code: "custom", message: "automation trace reasons must be unique" });
    }
  });

const partialReasons = new Set<AutomationTraceReason>(["invalid_response", "unsupported_trace"]);
const unknownReasons = new Set<AutomationTraceReason>([
  "invalid_response",
  "trace_not_retained",
  "rule_not_found",
  "association_missing",
  "association_stale",
  "resync_stale",
  "unsupported_trace",
]);
const unavailableReasons = new Set<AutomationTraceReason>([
  "permission_denied",
  "bridge_not_ready",
  "busy",
  "timeout",
  "cancelled",
  "invalid_response",
  "unsupported_trace",
]);

function reasonsForStatus(allowed: ReadonlySet<AutomationTraceReason>) {
  return automationTraceReasonsSchema.refine(
    (reasons) => reasons.every((reason) => allowed.has(reason)),
    "automation trace reason contradicts result status",
  );
}

const completeResultSchema = z.object({
  status: z.literal("complete"),
  ruleRef: ruleRefSchema,
  target: automationTraceTargetSchema,
  run: automationTraceRunSchema,
}).strict();

const partialResultSchema = z.object({
  status: z.literal("partial"),
  ruleRef: ruleRefSchema,
  target: automationTraceTargetSchema,
  run: automationTraceRunSchema,
  reasons: reasonsForStatus(partialReasons),
}).strict();

const unknownResultSchema = z.object({
  status: z.literal("unknown"),
  ruleRef: ruleRefSchema,
  target: automationTraceTargetSchema,
  reasons: reasonsForStatus(unknownReasons),
}).strict();

const unavailableResultSchema = z.object({
  status: z.literal("unavailable"),
  ruleRef: ruleRefSchema,
  target: automationTraceTargetSchema,
  reasons: reasonsForStatus(unavailableReasons),
}).strict();

export const automationTraceResultSchema = z.discriminatedUnion("status", [
  completeResultSchema,
  partialResultSchema,
  unknownResultSchema,
  unavailableResultSchema,
]);
export type AutomationTraceResult = z.infer<typeof automationTraceResultSchema>;
export const AutomationTraceResultSchema = automationTraceResultSchema;

export interface AutomationTraceHandle {
  /** Reads one exact live automation context without mutating Hub evidence or authority. */
  readTrace(
    request: AutomationTraceRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<AutomationTraceResult>;
  /** Optional aggregate prerequisite coverage; it never returns provider identities. */
  coverage?(options: { readonly signal: AbortSignal }): Promise<AutomationTraceCoverage>;
}

declare module "./bridge-contract.js" {
  interface ExtensionHandleRegistry {
    "automationTrace@1": AutomationTraceHandle;
  }
}
