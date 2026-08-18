import { z } from "zod";

import type { ExtensionDeclaration } from "./bridge-contract.js";

export const ORG_HINTS_EXTENSION = Object.freeze({
  id: "orgHints",
  version: "1.0.0",
}) satisfies ExtensionDeclaration;

/** Organization metadata remains a hint and never changes identity or authority. */
export const orgHintPayloadSchema = z.object({
  nativeId: z.string().trim().min(1).max(256),
  spatialDisposition: z.literal("non_spatial"),
}).strict();

export type OrgHintPayload = z.infer<typeof orgHintPayloadSchema>;
