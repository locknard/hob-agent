import { z } from "zod";

import type { ExtensionDeclaration } from "./bridge-contract.js";

const MAX_CAUSALITY_REFERENCE_LENGTH = 256;

const boundedNeutralReference = z
  .string()
  .min(1)
  .max(MAX_CAUSALITY_REFERENCE_LENGTH)
  .refine((value) => value.trim() === value, "reference must not have surrounding whitespace")
  .refine((value) => !/[\u0000-\u001f\u007f\s]/u.test(value), "reference must not contain control or whitespace characters")
  .refine((value) => !/[./\\]/u.test(value), "reference must be opaque and neutral");

const principalRef = z.string().regex(/^principal:[A-Za-z0-9_-]{1,240}$/u);

export const CAUSALITY_EXTENSION = Object.freeze({
  id: "causality",
  version: "1.0.0",
}) satisfies ExtensionDeclaration;
export const CAUSALITY_EXTENSION_KEY = "causality@1" as const;

export const causalityCauseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    principalRef,
  }).strict(),
  z.object({
    kind: z.literal("foreign_rule"),
    ruleRef: boundedNeutralReference,
  }).strict(),
  z.object({
    kind: z.literal("hob_artifact"),
    artifactId: boundedNeutralReference,
  }).strict(),
  z.object({ kind: z.literal("physical") }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]);
export const causeRefSchema = causalityCauseSchema;
export type CausalityCause = z.infer<typeof causalityCauseSchema>;
/** Neutral cause reference carried by one causality extension event. */
export type CauseRef = CausalityCause;

export const causalityPayloadSchema = z.object({
  refSeq: z.number().finite().int().positive().refine(Number.isSafeInteger, "refSeq must be a safe integer"),
  cause: causalityCauseSchema,
}).strict();
export type CausalityPayload = z.infer<typeof causalityPayloadSchema>;

export const CausalityExtensionSchema = z.object({
  id: z.literal("causality"),
  version: z.literal("1.0.0"),
}).strict();
export const CausalityCauseSchema = causalityCauseSchema;
export const CauseRefSchema = causeRefSchema;
export const CausalityPayloadSchema = causalityPayloadSchema;
