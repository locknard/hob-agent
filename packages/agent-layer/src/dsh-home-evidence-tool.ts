import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-home-evidence-tool";
export const inject = ["tools", "homeWorld"] as const;

const SEMANTIC_KINDS = [
  "light", "switch", "button", "sensor", "binary-sensor",
  "numeric-control", "choice-control", "text-control", "time-control",
  "event", "media", "cover", "lock", "presence", "fan", "camera",
  "vacuum", "climate", "weather", "automation",
] as const;

const COVERAGE_REASONS = [
  "bridge_not_ready",
  "missing_consistent_baseline",
  "baseline_time_unknown",
  "window_before_baseline",
  "history_gap",
  "journal_query_unavailable",
  "selection_too_broad",
  "query_truncated",
  "merge_truncated",
] as const;

interface HomeEvidencePort {
  queryRecentEvidence(input: {
    readonly hwCapabilityIds: readonly string[];
    readonly lookbackHours: number;
    readonly limit?: number;
  }): {
    readonly requestedSince: string;
    readonly requestedUntil: string;
    readonly events: readonly {
      readonly hwId: string;
      readonly hwCapabilityId: string;
      readonly semanticKind?: typeof SEMANTIC_KINDS[number];
      readonly value: string | number | boolean | null;
      readonly observedAt: string;
      readonly sourceTs?: string;
      readonly sourceTsQuality: "device" | "platform" | "none";
      readonly origin: "observed" | "imported";
      readonly provenance: { readonly bridgeId: string; readonly epochId: string; readonly seq: number };
    }[];
    readonly coverage: readonly {
      readonly bridgeId: string;
      readonly epochId?: string;
      readonly baselineSeq?: number;
      readonly baselineAt?: string;
      readonly status: "complete" | "partial" | "unavailable";
      readonly reasons: readonly typeof COVERAGE_REASONS[number][];
    }[];
    readonly truncated: boolean;
  };
}

type EvidenceContext = Context & { homeWorld: HomeEvidencePort };

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    requestedSince: { type: "string", required: true },
    requestedUntil: { type: "string", required: true },
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
          sourceTsQuality: { type: "string", enum: ["device", "platform", "none"], required: true },
          origin: { type: "string", enum: ["observed", "imported"], required: true },
          provenance: {
            type: "object",
            required: true,
            additionalProperties: false,
            properties: {
              bridgeId: { type: "string", required: true },
              epochId: { type: "string", required: true },
              seq: { type: "number", required: true },
            },
          },
        },
      },
    },
    coverage: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          bridgeId: { type: "string", required: true },
          epochId: { type: "string" },
          baselineSeq: { type: "number" },
          baselineAt: { type: "string" },
          status: { type: "string", enum: ["complete", "partial", "unavailable"], required: true },
          reasons: { type: "array", items: { type: "string", enum: COVERAGE_REASONS }, required: true },
        },
      },
    },
    truncated: { type: "boolean", required: true },
  },
} as const;

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: "get_home_evidence",
    description: [
      "Read bounded recent state changes for current neutral home capability IDs.",
      "Only changes observed after a verified bridge snapshot are returned; bootstrap state is excluded.",
      "Inspect coverage and truncation before treating the result as behavioral evidence.",
      "This tool is read-only.",
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
    execute: async (args) => {
      const value = (ctx as EvidenceContext).homeWorld.queryRecentEvidence({
        hwCapabilityIds: args.hwCapabilityIds,
        lookbackHours: args.lookbackHours,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      });
      return {
        requestedSince: value.requestedSince,
        requestedUntil: value.requestedUntil,
        events: value.events.map((event) => ({ ...event, provenance: { ...event.provenance } })),
        coverage: value.coverage.map((item) => ({ ...item, reasons: [...item.reasons] })),
        truncated: value.truncated,
      };
    },
  }));
}
