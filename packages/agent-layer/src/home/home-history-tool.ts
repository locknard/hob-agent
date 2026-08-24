import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-home-history-tool";
export const inject = ["tools", "homeWorld"] as const;

const SEMANTIC_KINDS = [
  "light", "switch", "button", "sensor", "binary-sensor",
  "numeric-control", "choice-control", "text-control", "time-control",
  "event", "media", "cover", "lock", "presence", "fan", "camera",
  "vacuum", "climate", "weather", "automation",
] as const;
type HomeHistorySemanticKind = typeof SEMANTIC_KINDS[number];

const COVERAGE_REASONS = [
  "bridge_not_ready",
  "missing_consistent_baseline",
  "history_unavailable",
  "journal_query_unavailable",
  "history_gap",
  "retention_floor_unknown",
  "empty_or_purged",
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
  "query_truncated",
] as const;
type HomeHistoryCoverageReason = typeof COVERAGE_REASONS[number];

const MAX_CAPABILITY_IDS = 20;
const MAX_ID_LENGTH = 200;
const MAX_RESULT_EVENTS = 200;
const MAX_RESULT_REASONS = 32;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_LIMIT = 200;
const MAX_LOOKBACK_HOURS = 168;
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

export interface HomeHistoryQuery {
  readonly hwCapabilityIds: readonly string[];
  readonly lookbackHours: number;
  readonly limit?: number;
}

export interface HomeHistoryEvent {
  readonly hwId: string;
  readonly hwCapabilityId: string;
  readonly semanticKind?: HomeHistorySemanticKind;
  readonly value: string | number | boolean | null;
  readonly observedAt: string;
  readonly sourceTs?: string;
  readonly sourceTsQuality: "platform";
  readonly origin: "imported";
}

export interface HomeHistoryCoverage {
  readonly status: "partial" | "unavailable";
  readonly reasons: HomeHistoryCoverageReason[];
}

export interface HomeHistoryValue {
  readonly requestedSince?: string;
  readonly requestedUntil?: string;
  readonly events: HomeHistoryEvent[];
  readonly coverage: HomeHistoryCoverage;
  readonly truncated: boolean;
}

interface HomeHistoryPort {
  queryImportedHistory(
    input: HomeHistoryQuery,
    signal?: AbortSignal,
  ): unknown | Promise<unknown>;
}

type HomeHistoryContext = Context & { homeWorld: HomeHistoryPort };

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    requestedSince: { type: "string" },
    requestedUntil: { type: "string" },
    events: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          hwId: { type: "string", required: true },
          hwCapabilityId: { type: "string", required: true },
          semanticKind: { type: "string", enum: SEMANTIC_KINDS },
          value: {
            oneOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "null" },
            ],
            required: true,
          },
          observedAt: { type: "string", required: true },
          sourceTs: { type: "string" },
          sourceTsQuality: { type: "string", enum: ["platform"], required: true },
          origin: { type: "string", enum: ["imported"], required: true },
        },
      },
    },
    coverage: {
      type: "object",
      required: true,
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["partial", "unavailable"], required: true },
        reasons: {
          type: "array",
          required: true,
          items: { type: "string", enum: COVERAGE_REASONS },
        },
      },
    },
    truncated: { type: "boolean", required: true },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && value.trim() === value;
}

function canonicalUtcTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TIMESTAMP_LENGTH) return undefined;
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const milliseconds = Number((fraction + "000").slice(0, 3));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);
  if (!Number.isFinite(date.getTime())
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
    || date.getUTCMilliseconds() !== milliseconds) return undefined;
  return date.getTime();
}

function isBoundedTimestamp(value: unknown): value is string {
  return canonicalUtcTimestampMs(value) !== undefined;
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function isSemanticKind(value: unknown): value is HomeHistorySemanticKind {
  return typeof value === "string" && SEMANTIC_KINDS.includes(value as HomeHistorySemanticKind);
}

function isCoverageReason(value: unknown): value is HomeHistoryCoverageReason {
  return typeof value === "string" && COVERAGE_REASONS.includes(value as HomeHistoryCoverageReason);
}

function unavailableHistory(): HomeHistoryValue {
  return {
    events: [],
    coverage: { status: "unavailable", reasons: ["history_unavailable"] },
    truncated: false,
  };
}

function validateQuery(value: unknown): HomeHistoryQuery {
  if (!isRecord(value)) throw new TypeError("home history query is invalid");
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "hwCapabilityIds" && key !== "lookbackHours" && key !== "limit")) {
    throw new TypeError("home history query is invalid");
  }
  const ids = value.hwCapabilityIds;
  const lookbackHours = value.lookbackHours;
  const limit = value.limit;
  if (!Array.isArray(ids)
    || ids.length < 1
    || ids.length > MAX_CAPABILITY_IDS
    || ids.some((id) => !isBoundedId(id))
    || typeof lookbackHours !== "number"
    || !Number.isSafeInteger(lookbackHours)
    || lookbackHours < 1
    || lookbackHours > MAX_LOOKBACK_HOURS
    || (limit !== undefined
      && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT))) {
    throw new TypeError("home history query is invalid or unbounded");
  }
  return {
    hwCapabilityIds: [...ids],
    lookbackHours,
    ...(limit === undefined ? {} : { limit }),
  };
}

function projectHistory(value: unknown, query: HomeHistoryQuery): HomeHistoryValue {
  if (!isRecord(value)) return unavailableHistory();
  const requestedSinceMs = canonicalUtcTimestampMs(value.requestedSince);
  const requestedUntilMs = canonicalUtcTimestampMs(value.requestedUntil);
  if (!isBoundedTimestamp(value.requestedSince)
    || !isBoundedTimestamp(value.requestedUntil)
    || requestedSinceMs === undefined
    || requestedUntilMs === undefined
    || requestedUntilMs <= requestedSinceMs
    || requestedUntilMs - requestedSinceMs > query.lookbackHours * 60 * 60 * 1_000
    || !Array.isArray(value.events)
    || value.events.length > MAX_RESULT_EVENTS
    || (query.limit !== undefined && value.events.length > query.limit)
    || !isRecord(value.coverage)
    || (value.coverage.status !== "partial" && value.coverage.status !== "unavailable")
    || (value.coverage.status === "unavailable" && value.events.length > 0)
    || !Array.isArray(value.coverage.reasons)
    || value.coverage.reasons.length < 1
    || value.coverage.reasons.length > MAX_RESULT_REASONS
    || value.coverage.reasons.some((reason) => !isCoverageReason(reason))
    || new Set(value.coverage.reasons).size !== value.coverage.reasons.length
    || typeof value.truncated !== "boolean") {
    return unavailableHistory();
  }

  const events: HomeHistoryEvent[] = [];
  for (const candidate of value.events) {
    const observedAtMs = isRecord(candidate) ? canonicalUtcTimestampMs(candidate.observedAt) : undefined;
    if (!isRecord(candidate)
      || !isBoundedId(candidate.hwId)
      || !isBoundedId(candidate.hwCapabilityId)
      || !query.hwCapabilityIds.includes(candidate.hwCapabilityId)
      || (candidate.semanticKind !== undefined && !isSemanticKind(candidate.semanticKind))
      || !isScalar(candidate.value)
      || !isBoundedTimestamp(candidate.observedAt)
      || (candidate.sourceTs !== undefined && !isBoundedTimestamp(candidate.sourceTs))
      || candidate.sourceTsQuality !== "platform"
      || candidate.sourceTs === undefined
      || candidate.observedAt !== candidate.sourceTs
      || observedAtMs === undefined
      || observedAtMs < requestedSinceMs
      || observedAtMs >= requestedUntilMs
      || candidate.origin !== "imported") {
      return unavailableHistory();
    }
    events.push({
      hwId: candidate.hwId,
      hwCapabilityId: candidate.hwCapabilityId,
      ...(candidate.semanticKind === undefined ? {} : { semanticKind: candidate.semanticKind }),
      value: candidate.value,
      observedAt: candidate.observedAt,
      ...(candidate.sourceTs === undefined ? {} : { sourceTs: candidate.sourceTs }),
      sourceTsQuality: candidate.sourceTsQuality,
      origin: "imported",
    });
  }
  return {
    requestedSince: value.requestedSince,
    requestedUntil: value.requestedUntil,
    events,
    coverage: {
      status: value.coverage.status,
      reasons: [...value.coverage.reasons] as HomeHistoryCoverageReason[],
    },
    truncated: value.truncated,
  };
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: "get_home_history",
    description: [
      "Read bounded imported recorder history for what happened or when a recorded state changed.",
      "Returns only scalar imported events for the requested neutral capability IDs and an honest partial or unavailable coverage aggregate.",
      "Imported recorder history says what was recorded and when; it never proves why and must not be passed to get_home_causality.",
      "This tool is read-only and cannot control devices, create proposals, or change configuration.",
    ].join(" "),
    parameters: {
      hwCapabilityIds: { type: "array", items: { type: "string" }, required: true },
      lookbackHours: { type: "integer", required: true },
      limit: { type: "integer" },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text" as const, text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      const query = validateQuery(args);
      const homeWorld = (ctx as HomeHistoryContext).homeWorld;
      try {
        const value = await homeWorld.queryImportedHistory.call(homeWorld, query, exec.signal);
        return projectHistory(value, query);
      } catch {
        return unavailableHistory();
      }
    },
  }));
}
