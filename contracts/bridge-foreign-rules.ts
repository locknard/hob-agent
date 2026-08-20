import { z } from "zod";

import type { ExtensionDeclaration } from "./bridge-contract.js";

export const MAX_FOREIGN_RULES = 256;

export const FOREIGN_RULES_EXTENSION = Object.freeze({
  id: "foreignRules",
  version: "2.0.0",
}) satisfies ExtensionDeclaration;

export const foreignRuleSummarySchema = z.object({
  ruleRef: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(256).optional(),
  enabled: z.boolean().optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
}).strict();

export const foreignRuleListSchema = z.array(foreignRuleSummarySchema).max(MAX_FOREIGN_RULES);

export const foreignRuleCatalogSchema = z.object({
  epochId: z.string().trim().min(1).max(256),
  lastSeq: z.number().int().positive(),
  complete: z.boolean(),
  rules: foreignRuleListSchema,
}).strict();

export type ForeignRuleSummary = z.infer<typeof foreignRuleSummarySchema>;
export type ForeignRuleCatalog = z.infer<typeof foreignRuleCatalogSchema>;

export interface ForeignRulesHandle {
  /** Returns bounded metadata bound to one replay epoch and exact sequence. It never executes a rule. */
  catalog(): Promise<ForeignRuleCatalog | undefined>;
}

declare module "./bridge-contract.js" {
  interface ExtensionHandleRegistry {
    "foreignRules@2": ForeignRulesHandle;
  }
}
