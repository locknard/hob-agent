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
    provenance: { producer: string; sessionId?: string; turnId?: string };
    selectedHwIds: readonly string[];
    risk: { level: "low" | "medium" | "high"; reasons: readonly string[] };
    intent: { type: string; description: string; rollback: string };
  }): Promise<{
    id: string;
    revision: number;
    status: "pending_review";
    applicationStatus: "not_available";
    conflictCheck: { existingAutomationCount: number; matches: readonly unknown[] };
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
  },
} as const;

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: "create_home_proposal",
    description: [
      "Create a local pending household proposal from bounded hub evidence.",
      "This only adds an Inbox item; it cannot control a device or install an automation.",
    ].join(" "),
    parameters: {
      kind: { type: "string", enum: ["automation-draft", "household-insight"], required: true },
      title: { type: "string", required: true },
      summary: { type: "string", required: true },
      idempotencyKey: { type: "string", required: true },
      selectedHwIds: { type: "array", items: { type: "string" }, required: true },
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
      const proposal = await (ctx as ProposalContext).homeProposals.createDraft({
        kind: args.kind,
        title: args.title,
        summary: args.summary,
        idempotencyKey: args.idempotencyKey,
        provenance: {
          producer: "dsh-home-agent",
          ...(exec.agent === undefined ? {} : { sessionId: String(exec.agent.id) }),
          turnId: String(exec.rootCallId),
        },
        selectedHwIds: args.selectedHwIds,
        risk: { level: args.riskLevel, reasons: args.riskReasons },
        intent: {
          type: args.kind,
          description: args.intentDescription,
          rollback: args.rollback,
        },
      });
      if (proposal.status !== "pending_review") throw new Error("Created proposal is not pending review");
      return {
        proposalId: proposal.id,
        status: "pending_review" as const,
        revision: proposal.revision,
        applicationStatus: proposal.applicationStatus,
        conflictSummary: {
          existingAutomationCount: proposal.conflictCheck.existingAutomationCount,
          matchCount: proposal.conflictCheck.matches.length,
        },
      };
    },
  }));
}
