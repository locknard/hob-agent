import { z } from "zod";

import {
  stateEventSchema,
  type ExtensionDeclaration,
} from "./bridge-contract.js";

export const MAX_HISTORY_RANGE_HOURS = 168;
export const MAX_HISTORY_BINDINGS = 20;
export const MAX_HISTORY_RECORDS = 200;
export const MAX_HISTORY_RECORD_BYTES = 64 * 1024;

export const HISTORY_EXTENSION = Object.freeze({
  id: "history",
  version: "1.0.0",
}) satisfies ExtensionDeclaration;
export const HISTORY_EXTENSION_KEY = "history@1" as const;

const utcTimestampSchema = z
  .iso.datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "timestamp must use UTC");

const boundedBindingIdSchema = z.string().min(1).max(256).refine(
  (value) => value.trim() === value,
  "identifier must not have surrounding whitespace",
);

export const historyCoverageReasonSchema = z.enum([
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
]);
export type HistoryCoverageReason = z.infer<typeof historyCoverageReasonSchema>;
export const HistoryCoverageReasonSchema = historyCoverageReasonSchema;

export const historyLiveCutSchema = z.object({
  epochId: boundedBindingIdSchema,
  lastSeq: z.number().int().positive().refine(Number.isSafeInteger, "lastSeq must be a safe integer"),
}).strict();
export type HistoryLiveCut = z.infer<typeof historyLiveCutSchema>;
export const HistoryLiveCutSchema = historyLiveCutSchema;

export const historyBindingSchema = z.object({
  nativeId: boundedBindingIdSchema,
  nativeInstanceId: boundedBindingIdSchema,
}).strict();
export type HistoryBinding = z.infer<typeof historyBindingSchema>;
export const HistoryBindingSchema = historyBindingSchema;

export const historyRangeSchema = z.object({
  since: utcTimestampSchema,
  until: utcTimestampSchema,
}).strict().superRefine((range, context) => {
  const since = Date.parse(range.since);
  const until = Date.parse(range.until);
  if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since) {
    context.addIssue({ code: "custom", path: ["until"], message: "history range must be increasing" });
    return;
  }
  if (until - since > MAX_HISTORY_RANGE_HOURS * 60 * 60 * 1000) {
    context.addIssue({ code: "custom", path: ["until"], message: "history range exceeds 168 hours" });
  }
});
export type HistoryRange = z.infer<typeof historyRangeSchema>;
export const HistoryRangeSchema = historyRangeSchema;

export const historyRequestSchema = z.object({
  since: utcTimestampSchema,
  until: utcTimestampSchema,
  bindings: z.array(historyBindingSchema).min(1).max(MAX_HISTORY_BINDINGS),
  liveCut: historyLiveCutSchema,
}).strict().superRefine((request, context) => {
  const since = Date.parse(request.since);
  const until = Date.parse(request.until);
  if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since) {
    context.addIssue({ code: "custom", path: ["until"], message: "history range must be increasing" });
    return;
  }
  if (until - since > MAX_HISTORY_RANGE_HOURS * 60 * 60 * 1000) {
    context.addIssue({ code: "custom", path: ["until"], message: "history range exceeds 168 hours" });
  }
  const seen = new Set<string>();
  for (const [index, binding] of request.bindings.entries()) {
    const key = JSON.stringify([binding.nativeId, binding.nativeInstanceId]);
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["bindings", index],
        message: "history bindings must be unique",
      });
    }
    seen.add(key);
  }
});
export type HistoryRequest = z.infer<typeof historyRequestSchema>;
export const HistoryRequestSchema = historyRequestSchema;

const importedTimeSchema = z.discriminatedUnion("sourceTsQuality", [
  z.object({ sourceTs: utcTimestampSchema, sourceTsQuality: z.literal("platform") }).strict(),
  z.object({ sourceTsQuality: z.literal("none") }).strict(),
]);

const importedStateEventSchema = stateEventSchema.extend({
  time: importedTimeSchema,
  origin: z.literal("imported"),
});

export const historyRecordSchema = z.object({
  historySeq: z.number().int().positive().refine(Number.isSafeInteger, "historySeq must be a safe integer"),
  state: importedStateEventSchema,
}).strict().superRefine((record, context) => {
  const encoded = new TextEncoder().encode(JSON.stringify(record));
  if (encoded.byteLength > MAX_HISTORY_RECORD_BYTES) {
    context.addIssue({ code: "custom", message: "history record exceeds 64 KiB" });
  }
});
export type HistoryRecord = z.infer<typeof historyRecordSchema>;
export const HistoryRecordSchema = historyRecordSchema;

export const historyPageSchema = z.object({
  importId: boundedBindingIdSchema,
  source: z.literal("home-assistant-recorder"),
  sourceRange: historyRangeSchema,
  liveCut: historyLiveCutSchema,
  coverage: z.enum(["partial", "unavailable"]),
  reasons: z.array(historyCoverageReasonSchema).min(1).max(historyCoverageReasonSchema.options.length),
  records: z.array(historyRecordSchema).max(MAX_HISTORY_RECORDS),
}).strict().superRefine((page, context) => {
  if (new Set(page.reasons).size !== page.reasons.length) {
    context.addIssue({ code: "custom", path: ["reasons"], message: "history coverage reasons must be unique" });
  }
  if (page.coverage === "unavailable" && page.records.length !== 0) {
    context.addIssue({ code: "custom", path: ["records"], message: "unavailable history pages cannot contain records" });
  }
  page.records.forEach((record, index) => {
    if (record.historySeq !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["records", index, "historySeq"],
        message: "historySeq must be contiguous from one",
      });
    }
  });
});
export type HistoryPage = z.infer<typeof historyPageSchema>;
export const HistoryPageSchema = historyPageSchema;

export interface HistoryHandle {
  fetchHistory(
    request: HistoryRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<HistoryPage>;
}

declare module "./bridge-contract.js" {
  interface ExtensionHandleRegistry {
    "history@1": HistoryHandle;
  }
}
