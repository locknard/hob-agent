import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-home-activity-tool";
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

interface HomeActivityPort {
  queryRecentActivity(input: { readonly lookbackHours: number; readonly limit?: number }): {
    readonly requestedSince: string;
    readonly requestedUntil: string;
    readonly devices: readonly {
      readonly hwId: string;
      readonly eventCount: number;
      readonly latestObservedAt: string;
      readonly semanticKinds: readonly typeof SEMANTIC_KINDS[number][];
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

type ActivityContext = Context & { homeWorld: HomeActivityPort };

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    requestedSince: { type: "string", required: true },
    requestedUntil: { type: "string", required: true },
    devices: {
      type: "array", required: true,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          hwId: { type: "string", required: true },
          eventCount: { type: "integer", required: true },
          latestObservedAt: { type: "string", required: true },
          semanticKinds: { type: "array", required: true, items: { type: "string", enum: SEMANTIC_KINDS } },
        },
      },
    },
    coverage: {
      type: "array", required: true,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          bridgeId: { type: "string", required: true },
          epochId: { type: "string" },
          baselineSeq: { type: "number" },
          baselineAt: { type: "string" },
          status: { type: "string", required: true, enum: ["complete", "partial", "unavailable"] },
          reasons: { type: "array", required: true, items: { type: "string", enum: COVERAGE_REASONS } },
        },
      },
    },
    truncated: { type: "boolean", required: true },
  },
} as const;

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: "get_home_activity",
    description: [
      "Discover bounded post-baseline device activity before selecting detailed household candidates.",
      "Returns only aggregate event counts, latest receive times, opaque Hub device IDs, and neutral semantic kinds; no state values or native identities.",
      "Activity is a triage signal, not evidence of a routine. Inspect coverage, then use detailed snapshot and evidence tools before making behavioral claims.",
    ].join(" "),
    parameters: {
      lookbackHours: { type: "integer", required: true },
      limit: { type: "integer" },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text" as const, text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const homeWorld = (ctx as ActivityContext).homeWorld;
      const value = homeWorld.queryRecentActivity.call(homeWorld, {
        lookbackHours: args.lookbackHours,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      });
      return {
        requestedSince: value.requestedSince,
        requestedUntil: value.requestedUntil,
        devices: value.devices.map((device) => ({ ...device, semanticKinds: [...device.semanticKinds] })),
        coverage: value.coverage.map((item) => ({ ...item, reasons: [...item.reasons] })),
        truncated: value.truncated,
      };
    },
  }));
}

