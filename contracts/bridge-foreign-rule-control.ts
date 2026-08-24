import { z } from "zod";

import type { ExtensionDeclaration } from "./bridge-contract.js";

const utf8Encoder = new TextEncoder();
const boundedRuleRef = z.string()
  .trim()
  .min(1)
  .max(200)
  .superRefine((value, context) => {
    if (utf8Encoder.encode(value).byteLength > 512) {
      context.addIssue({ code: "too_big", maximum: 512, origin: "string", inclusive: true, message: "value exceeds the byte limit" });
    }
    if (/[\u0000-\u001f\u007f]/u.test(value)) {
      context.addIssue({ code: "custom", message: "value contains a control character" });
    }
  });
const sourceFingerprint = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const operationId = z.string().regex(/^[0-9a-f]{32}$/u);

export const FOREIGN_RULE_CONTROL_EXTENSION = Object.freeze({
  id: "foreignRuleControl",
  version: "1.0.0",
}) satisfies ExtensionDeclaration;

export const foreignRuleControlStatusRequestSchema = z.object({
  ruleRef: boundedRuleRef,
}).strict();
export type ForeignRuleControlStatusRequest = z.infer<typeof foreignRuleControlStatusRequestSchema>;

export const foreignRuleControlSetEnabledRequestSchema = z.object({
  ruleRef: boundedRuleRef,
  expectedSourceFingerprint: sourceFingerprint,
  enabled: z.boolean(),
  operationId,
}).strict();
export type ForeignRuleControlSetEnabledRequest = z.infer<typeof foreignRuleControlSetEnabledRequestSchema>;

const foreignRuleControlVerifiedResultSchema = z.object({
  status: z.enum(["running", "paused"]),
  sourceFingerprint,
}).strict();

export const foreignRuleControlStatusResultSchema = z.discriminatedUnion("status", [
  foreignRuleControlVerifiedResultSchema,
  z.object({ status: z.literal("missing") }).strict(),
  z.object({
    status: z.literal("unknown"),
    reason: z.enum(["unavailable", "invalid_response"]),
  }).strict(),
]);
export type ForeignRuleControlStatusResult = z.infer<typeof foreignRuleControlStatusResultSchema>;

export const foreignRuleControlSetEnabledResultSchema = z.discriminatedUnion("status", [
  foreignRuleControlVerifiedResultSchema,
  z.object({
    status: z.literal("rejected"),
    reason: z.enum(["stale_source", "not_found", "unavailable", "failed"]),
  }).strict(),
  z.object({
    status: z.literal("unknown"),
    reason: z.enum(["cancelled", "upstream_unavailable"]),
  }).strict(),
]);
export type ForeignRuleControlSetEnabledResult = z.infer<typeof foreignRuleControlSetEnabledResultSchema>;

export interface ForeignRuleControlHandle {
  /** Reads one source rule's enabled state and exact neutral source fingerprint. */
  status(
    request: ForeignRuleControlStatusRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<ForeignRuleControlStatusResult>;
  /** Applies an idempotent enabled-state command only after the source fingerprint matches. */
  setEnabled(
    request: ForeignRuleControlSetEnabledRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<ForeignRuleControlSetEnabledResult>;
}

declare module "./bridge-contract.js" {
  interface ExtensionHandleRegistry {
    "foreignRuleControl@1": ForeignRuleControlHandle;
  }
}
