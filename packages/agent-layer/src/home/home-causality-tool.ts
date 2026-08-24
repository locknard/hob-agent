import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-home-causality-tool";
export const inject = ["tools", "homeWorld"] as const;

const STATUSES = ["complete", "partial", "unknown", "unavailable"] as const;
type HomeCausalityStatus = typeof STATUSES[number];

const ATTRIBUTIONS = ["physical", "member", "hob", "external-rule", "unknown"] as const;
type HomeCausalityAttribution = typeof ATTRIBUTIONS[number];

const REASONS = [
  "bridge_not_ready",
  "missing_consistent_baseline",
  "history_gap",
  "journal_query_unavailable",
  "target_not_found",
  "target_not_state",
  "target_stale",
  "causality_unavailable",
  "causality_missing",
  "causality_unknown",
  "causality_rejected",
  "source_unresolved",
] as const;
type HomeCausalityReason = typeof REASONS[number];

export interface HomeCausalityQuery {
  readonly hwCapabilityId: string;
  readonly provenance: {
    readonly bridgeId: string;
    readonly epochId: string;
    readonly seq: number;
  };
}

interface HomeCausalityPortResult {
  readonly status?: unknown;
  readonly attribution?: unknown;
  readonly reasons?: readonly unknown[];
}

interface HomeCausalityPort {
  /** The Hub implementation is a synchronous, read-only neutral projection. */
  queryCausality(input: HomeCausalityQuery): HomeCausalityPortResult | Promise<HomeCausalityPortResult>;
}

type HomeCausalityContext = Context & { homeWorld: HomeCausalityPort };

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: STATUSES, required: true },
    attribution: { type: "string", enum: ATTRIBUTIONS },
    reasons: { type: "array", items: { type: "string", enum: REASONS }, required: true },
  },
} as const;

const PORT_ATTRIBUTIONS: Readonly<Record<string, HomeCausalityAttribution>> = {
  physical: "physical",
  user: "member",
  foreign_rule: "external-rule",
  hob_artifact: "hob",
  unknown: "unknown",
};

const PORT_REASONS: Readonly<Record<string, HomeCausalityReason>> = {
  capability_unavailable: "target_not_found",
  causality_unavailable: "causality_unavailable",
  causality_unknown: "causality_unknown",
  journal_unavailable: "journal_query_unavailable",
  state_not_retained: "target_not_state",
  cause_not_retained: "causality_missing",
  state_value_unknown: "source_unresolved",
  missing_consistent_baseline: "missing_consistent_baseline",
  target_stale: "target_stale",
  bridge_not_ready: "bridge_not_ready",
  history_gap: "history_gap",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function projectCausality(value: unknown): {
  readonly status: HomeCausalityStatus;
  readonly attribution?: HomeCausalityAttribution;
  readonly reasons: HomeCausalityReason[];
} {
  const record = isRecord(value) ? value : {};
  const requestedStatus = typeof record.status === "string" && STATUSES.includes(record.status as HomeCausalityStatus)
    ? record.status as HomeCausalityStatus
    : undefined;
  let status: HomeCausalityStatus = requestedStatus ?? "unavailable";
  const attribution = typeof record.attribution === "string"
    ? own(PORT_ATTRIBUTIONS, record.attribution)
    : undefined;
  const reasons = new Set<HomeCausalityReason>();
  if (Array.isArray(record.reasons)) {
    for (let index = 0; index < record.reasons.length && index < 32; index += 1) {
      const reason = record.reasons[index];
      if (typeof reason !== "string") continue;
      const mapped = own(PORT_REASONS, reason);
      if (mapped !== undefined) reasons.add(mapped);
    }
  }

  if (requestedStatus === undefined) {
    reasons.add("causality_unavailable");
  } else if (status === "complete" && attribution === undefined) {
    // A complete result without a closed attribution cannot support a cause claim.
    status = "unknown";
    reasons.add("causality_unknown");
  } else if (status === "partial" && reasons.size === 0) {
    reasons.add("source_unresolved");
  } else if (status === "unknown" && reasons.size === 0) {
    reasons.add("causality_unknown");
  } else if (status === "unavailable" && reasons.size === 0) {
    reasons.add("causality_unavailable");
  }

  if (status === "complete" && reasons.size > 0) {
    // A positive result carrying an unresolved reason is contradictory; preserve the
    // safe side of the boundary instead of presenting it as a complete cause.
    status = "partial";
  }

  const projectedAttribution = status === "complete" || status === "partial"
    ? attribution ?? "unknown"
    : status === "unknown" ? "unknown" : undefined;
  return {
    status,
    ...(projectedAttribution === undefined ? {} : { attribution: projectedAttribution }),
    reasons: [...reasons],
  };
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: "get_home_causality",
    description: [
      "Read the recorded cause for one exact post-baseline home event.",
      "The hwCapabilityId and provenance must come from get_home_evidence; activity counts or timestamps never prove a cause.",
      "Only bounded household-safe attribution, status, and reasons are returned; raw member, rule, artifact, provider, and native references stay inside HomeWorld.",
      "Partial, unknown, or unavailable means the source chain is incomplete and must not be guessed.",
      "This tool is read-only and cannot control devices, create proposals, or change configuration.",
    ].join(" "),
    parameters: {
      hwCapabilityId: { type: "string", required: true },
      provenance: {
        type: "object",
        required: true,
        additionalProperties: false,
        properties: {
          bridgeId: { type: "string", required: true },
          epochId: { type: "string", required: true },
          seq: { type: "integer", required: true },
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text" as const, text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const homeWorld = (ctx as HomeCausalityContext).homeWorld;
      try {
        const value = await homeWorld.queryCausality.call(homeWorld, {
          hwCapabilityId: args.hwCapabilityId,
          provenance: {
            bridgeId: args.provenance.bridgeId,
            epochId: args.provenance.epochId,
            seq: args.provenance.seq,
          },
        });
        return projectCausality(value);
      } catch {
        return {
          status: "unavailable" as const,
          reasons: ["causality_unavailable"] as HomeCausalityReason[],
        };
      }
    },
  }));
}
