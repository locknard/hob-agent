import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-home-proposal-tool";
export const inject = ["tools", "homeProposals"] as const;

type NeutralScalar = string | number | boolean | null;

type ArtifactCapabilityRef = { readonly hwCapabilityId: string };

type ArtifactCandidateContent = {
  readonly trigger:
    | { readonly kind: "schedule"; readonly timezone: string; readonly daysOfWeek: readonly number[]; readonly at: string }
    | { readonly kind: "capability_changed"; readonly source: ArtifactCapabilityRef };
  readonly conditions: readonly {
    readonly kind: "capability_value";
    readonly source: ArtifactCapabilityRef;
    readonly operator: "equals" | "not_equals" | "greater_than" | "less_than";
    readonly value: NeutralScalar;
  }[];
  readonly actions: readonly (
    | {
        readonly kind: "set_level";
        readonly target: ArtifactCapabilityRef;
        readonly value: number;
        readonly transitionSeconds?: number;
      }
    | { readonly kind: "set_boolean"; readonly target: ArtifactCapabilityRef; readonly value: boolean }
    | { readonly kind: "notify_local"; readonly message: string }
  )[];
  readonly rollback:
    | { readonly kind: "restore_previous_state"; readonly target: ArtifactCapabilityRef; readonly maxAgeSeconds: number }
    | { readonly kind: "no_remote_change" };
  readonly postconditions: readonly {
    readonly kind: "capability_value";
    readonly source: ArtifactCapabilityRef;
    readonly operator: "equals" | "not_equals" | "greater_than" | "less_than";
    readonly value: NeutralScalar;
    readonly withinSeconds: number;
  }[];
};

type ArtifactCandidate = {
  readonly schemaVersion: "1";
  readonly content: ArtifactCandidateContent;
};

interface HomeProposalPort {
  createDraft(input: {
    kind: "automation-draft" | "household-insight";
    title: string;
    summary: string;
    dedupKey: string;
    idempotencyKey: string;
    provenance: { producer: string; sessionId?: string; toolCallId?: string; turnId?: string };
    selectedHwIds: readonly string[];
    selectedHwCapabilityIds?: readonly string[];
    evidenceLookbackHours?: number;
    artifactCandidate?: ArtifactCandidate;
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
    applicationStatus: string;
    conflictCheck: { existingAutomationCount: number; matches: readonly unknown[] };
    spaceCoverage: {
      selectedDevices: number;
      devicesWithSingleSpace: number;
      devicesWithoutSpace: number;
      devicesWithMultipleSpaces: number;
    };
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
    applicationStatus: { type: "string", required: true, enum: ["not_available", "deploying", "running", "failed", "withdrawn"] },
    conflictSummary: {
      type: "object",
      required: true,
      additionalProperties: false,
      properties: {
        existingAutomationCount: { type: "number", required: true },
        matchCount: { type: "number", required: true },
      },
    },
    spaceCoverage: {
      type: "object",
      required: true,
      additionalProperties: false,
      properties: {
        selectedDevices: { type: "number", required: true },
        devicesWithSingleSpace: { type: "number", required: true },
        devicesWithoutSpace: { type: "number", required: true },
        devicesWithMultipleSpaces: { type: "number", required: true },
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

const scalarParameter = {
  oneOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
} as const;

const capabilityRefParameter = {
  type: "object",
  additionalProperties: false,
  properties: {
    hwCapabilityId: { type: "string", required: true },
  },
} as const;

const triggerParameter = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "schedule", required: true },
        timezone: { type: "string", required: true },
        daysOfWeek: { type: "array", items: { type: "integer" }, required: true },
        at: { type: "string", required: true },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "capability_changed", required: true },
        source: { ...capabilityRefParameter, required: true },
      },
    },
  ],
} as const;

const conditionParameter = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", const: "capability_value", required: true },
    source: { ...capabilityRefParameter, required: true },
    operator: {
      type: "string",
      enum: ["equals", "not_equals", "greater_than", "less_than"],
      required: true,
    },
    value: { ...scalarParameter, required: true },
  },
} as const;

const actionParameter = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "set_level", required: true },
        target: { ...capabilityRefParameter, required: true },
        value: { type: "number", required: true },
        transitionSeconds: { type: "number" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "set_boolean", required: true },
        target: { ...capabilityRefParameter, required: true },
        value: { type: "boolean", required: true },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "notify_local", required: true },
        message: { type: "string", required: true },
      },
    },
  ],
} as const;

const rollbackParameter = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "restore_previous_state", required: true },
        target: { ...capabilityRefParameter, required: true },
        maxAgeSeconds: { type: "integer", required: true },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "no_remote_change", required: true },
      },
    },
  ],
} as const;

const postconditionParameter = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", const: "capability_value", required: true },
    source: { ...capabilityRefParameter, required: true },
    operator: {
      type: "string",
      enum: ["equals", "not_equals", "greater_than", "less_than"],
      required: true,
    },
    value: { ...scalarParameter, required: true },
    withinSeconds: { type: "integer", required: true },
  },
} as const;

const artifactCandidateContentParameter = {
  type: "object",
  additionalProperties: false,
  properties: {
    trigger: { ...triggerParameter, required: true },
    conditions: { type: "array", items: conditionParameter, required: true },
    actions: { type: "array", items: actionParameter, required: true },
    rollback: { ...rollbackParameter, required: true },
    postconditions: { type: "array", items: postconditionParameter, required: true },
  },
} as const;

const artifactCandidateParameter = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "string", const: "1", required: true },
    content: { ...artifactCandidateContentParameter, required: true },
  },
} as const;

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: "list_home_proposals",
    description: [
      "List the household's unresolved proposals with their stable dedupKey.",
      "To revise one after the household asks for a change, call create_home_proposal with the SAME dedupKey and the full replacement plan; the Hub replaces the plan content, wakes the card, and re-verifies it before the household decides.",
      "Read-only; it exposes no device control and no approval authority.",
    ].join(" "),
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          proposals: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                proposalId: { type: "string", required: true },
                revision: { type: "number", required: true },
                title: { type: "string", required: true },
                summary: { type: "string", required: true },
                dedupKey: { type: "string", required: true },
                kind: { type: "string", required: true },
                lifecycle: { type: "string", required: true },
              },
            },
          },
        },
      } as never,
      render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }],
    },
    execute: async () => {
      const proposals = (ctx as ProposalContext).homeProposals.list({ status: "pending_review", limit: 20 });
      return {
        proposals: proposals.map((proposal) => ({
          proposalId: proposal.id,
          revision: proposal.revision,
          title: proposal.title,
          summary: proposal.summary,
          dedupKey: proposal.dedupKey,
          kind: proposal.kind,
          lifecycle: proposal.lifecycle ?? "ready",
        })),
      };
    },
  } as never));

  ctx.tools.register(defineTool({
    name: "create_home_proposal",
    description: [
      "Create a local pending household proposal from bounded hub evidence.",
      "When the proposal relies on recent behavior, select current hub capability IDs and a lookback window; the Hub binds exact event provenance and coverage.",
      "An artifact candidate is review-only intent; this tool cannot compile, approve, install, or execute it.",
      "This only adds an Inbox item; it cannot control a device or install an automation.",
    ].join(" "),
    parameters: {
      kind: { type: "string", enum: ["automation-draft", "household-insight"], required: true },
      title: { type: "string", required: true },
      summary: { type: "string", required: true },
      /** Stable behavior identity; idempotencyKey is only one producer attempt. */
      dedupKey: { type: "string", required: true },
      householdValue: { type: "string", required: true },
      whyNow: { type: "string", required: true },
      uncertainties: { type: "array", items: { type: "string" }, required: true },
      idempotencyKey: { type: "string", required: true },
      selectedHwIds: { type: "array", items: { type: "string" }, required: true },
      selectedHwCapabilityIds: { type: "array", items: { type: "string" } },
      evidenceLookbackHours: { type: "integer" },
      artifactCandidate: artifactCandidateParameter,
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
      if (args.kind === "automation-draft" && args.artifactCandidate === undefined) {
        throw new TypeError("artifactCandidate is required for automation-draft");
      }
      if (args.kind !== "automation-draft" && args.artifactCandidate !== undefined) {
        throw new TypeError("artifactCandidate is only allowed for automation-draft");
      }
      ctx.get("homeCalibrationCoverage")?.assertProposalAllowed();
      ctx.get("homeInventoryCoverage")?.assertProposalAllowed();
      ctx.get("homeRulesCoverage")?.assertProposalAllowed();
      const proposal = await (ctx as ProposalContext).homeProposals.createDraft({
        kind: args.kind,
        title: args.title,
        summary: args.summary,
        dedupKey: args.dedupKey,
        idempotencyKey: args.idempotencyKey,
        provenance: {
          producer: "dsh-home-agent",
          ...(exec.agent === undefined ? {} : { sessionId: String(exec.agent.id) }),
          toolCallId: String(exec.rootCallId),
        },
        selectedHwIds: args.selectedHwIds,
        ...(args.selectedHwCapabilityIds === undefined ? {} : { selectedHwCapabilityIds: args.selectedHwCapabilityIds }),
        ...(args.evidenceLookbackHours === undefined ? {} : { evidenceLookbackHours: args.evidenceLookbackHours }),
        ...(args.artifactCandidate === undefined ? {} : { artifactCandidate: args.artifactCandidate }),
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
      if (proposal.spaceCoverage === undefined) throw new Error("Created proposal is missing Hub-bound space coverage");
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
        spaceCoverage: proposal.spaceCoverage,
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
