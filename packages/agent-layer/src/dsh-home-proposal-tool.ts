import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-home-proposal-tool";
export const inject = ["tools", "homeProposals"] as const;

interface HomeProposalPort {
  createDraft(input: {
    kind: "automation-draft" | "household-insight";
    title: string;
    summary: string;
    idempotencyKey: string;
    provenance: { producer: string; sessionId?: string; toolCallId?: string; turnId?: string };
    selectedHwIds: readonly string[];
    selectedHwCapabilityIds?: readonly string[];
    evidenceLookbackHours?: number;
    rationale: {
      householdValue: string;
      whyNow: string;
      uncertainties: readonly string[];
    };
    risk: { level: "low" | "medium" | "high"; reasons: readonly string[] };
    intent: { type: string; description: string; rollback: string };
  }): Promise<{
    id: string;
    revision: number;
    status: "pending_review";
    applicationStatus: "not_available";
    conflictCheck: { existingAutomationCount: number; matches: readonly unknown[] };
    evidence: {
      references: readonly unknown[];
      temporal?: {
        truncated: boolean;
        coverage: readonly { status: "complete" | "partial" | "unavailable" }[];
      };
    };
  }>;
}

type ProposalContext = Context & { homeProposals: HomeProposalPort };

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    proposalId: { type: "string", required: true },
    status: { type: "string", required: true, enum: ["pending_review"] },
    revision: { type: "number", required: true },
    applicationStatus: { type: "string", required: true, enum: ["not_available"] },
    conflictSummary: {
      type: "object",
      required: true,
      additionalProperties: false,
      properties: {
        existingAutomationCount: { type: "number", required: true },
        matchCount: { type: "number", required: true },
      },
    },
    evidenceSummary: {
      type: "object",
      required: true,
      additionalProperties: false,
      properties: {
        referenceCount: { type: "number", required: true },
        coverageStatus: {
          type: "string",
          required: true,
          enum: ["current_state_only", "complete", "partial", "unavailable"],
        },
        truncated: { type: "boolean", required: true },
      },
    },
  },
} as const;

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: "create_home_proposal",
    description: [
      "Create a local pending household proposal from bounded hub evidence.",
      "When the proposal relies on recent behavior, select current hub capability IDs and a lookback window; the Hub binds exact event provenance and coverage.",
      "This only adds an Inbox item; it cannot control a device or install an automation.",
    ].join(" "),
    parameters: {
      kind: { type: "string", enum: ["automation-draft", "household-insight"], required: true },
      title: { type: "string", required: true },
      summary: { type: "string", required: true },
      householdValue: { type: "string", required: true },
      whyNow: { type: "string", required: true },
      uncertainties: { type: "array", items: { type: "string" }, required: true },
      idempotencyKey: { type: "string", required: true },
      selectedHwIds: { type: "array", items: { type: "string" }, required: true },
      selectedHwCapabilityIds: { type: "array", items: { type: "string" } },
      evidenceLookbackHours: { type: "integer" },
      riskLevel: { type: "string", enum: ["low", "medium", "high"], required: true },
      riskReasons: { type: "array", items: { type: "string" }, required: true },
      intentDescription: { type: "string", required: true },
      rollback: { type: "string", required: true },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text" as const, text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      ctx.get("homeInventoryCoverage")?.assertProposalAllowed();
      const proposal = await (ctx as ProposalContext).homeProposals.createDraft({
        kind: args.kind,
        title: args.title,
        summary: args.summary,
        idempotencyKey: args.idempotencyKey,
        provenance: {
          producer: "dsh-home-agent",
          ...(exec.agent === undefined ? {} : { sessionId: String(exec.agent.id) }),
          toolCallId: String(exec.rootCallId),
        },
        selectedHwIds: args.selectedHwIds,
        ...(args.selectedHwCapabilityIds === undefined ? {} : { selectedHwCapabilityIds: args.selectedHwCapabilityIds }),
        ...(args.evidenceLookbackHours === undefined ? {} : { evidenceLookbackHours: args.evidenceLookbackHours }),
        rationale: {
          householdValue: args.householdValue,
          whyNow: args.whyNow,
          uncertainties: args.uncertainties,
        },
        risk: { level: args.riskLevel, reasons: args.riskReasons },
        intent: {
          type: args.kind,
          description: args.intentDescription,
          rollback: args.rollback,
        },
      });
      if (proposal.status !== "pending_review") throw new Error("Created proposal is not pending review");
      const coverageStatus = summarizeCoverage(proposal.evidence.temporal?.coverage);
      return {
        proposalId: proposal.id,
        status: "pending_review" as const,
        revision: proposal.revision,
        applicationStatus: proposal.applicationStatus,
        conflictSummary: {
          existingAutomationCount: proposal.conflictCheck.existingAutomationCount,
          matchCount: proposal.conflictCheck.matches.length,
        },
        evidenceSummary: {
          referenceCount: proposal.evidence.references.length,
          coverageStatus,
          truncated: proposal.evidence.temporal?.truncated ?? false,
        },
      };
    },
  }));
}

function summarizeCoverage(
  coverage: readonly { status: "complete" | "partial" | "unavailable" }[] | undefined,
): "current_state_only" | "complete" | "partial" | "unavailable" {
  if (coverage === undefined) return "current_state_only";
  if (coverage.length === 0 || coverage.some((item) => item.status === "unavailable")) return "unavailable";
  return coverage.some((item) => item.status === "partial") ? "partial" : "complete";
}
