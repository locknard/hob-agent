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

type EvidenceSource = "live" | "imported-history";
type ProposalEvidenceSummarySource = "current-state" | EvidenceSource;
// The neutral proposal/artifact envelope bounds one evidence coverage row per
// relevant bridge at sixteen; keep the Agent projection aligned with that Hub bound.
const MAX_PROPOSAL_COVERAGE_BRIDGES = 16;

interface HomeProposalResult {
  readonly id: string;
  readonly revision: number;
  readonly status: "pending_review";
  readonly applicationStatus: "not_available" | "deploying" | "running" | "failed" | "withdrawn";
  readonly conflictCheck: { readonly existingAutomationCount: number; readonly matches: readonly unknown[] };
  readonly spaceCoverage: {
    readonly selectedDevices: number;
    readonly devicesWithSingleSpace: number;
    readonly devicesWithoutSpace: number;
    readonly devicesWithMultipleSpaces: number;
  };
  readonly evidence: {
    readonly references: readonly unknown[];
    readonly temporal?: {
      readonly truncated: boolean;
      readonly coverage: readonly { readonly status: "complete" | "partial" | "unavailable" }[];
    };
    readonly importedHistory?: {
      readonly truncated: boolean;
      readonly coverage: readonly { readonly status: "partial" | "unavailable" }[];
    };
  };
}

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
    evidenceSource?: EvidenceSource;
    artifactCandidate?: ArtifactCandidate;
    rationale: {
      householdValue: string;
      whyNow: string;
      uncertainties: readonly string[];
    };
    risk: { level: "low" | "medium" | "high"; reasons: readonly string[] };
    intent: { type: string; description: string; rollback: string };
  }): Promise<HomeProposalResult>;
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
        source: {
          type: "string",
          required: true,
          enum: ["current-state", "live", "imported-history"],
        },
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
      "Imported recorder history can answer what happened and when, but it cannot establish why; use the causality and automation-trace tools for that separate question.",
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
      evidenceSource: { type: "string", enum: ["live", "imported-history"] },
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
      validateCreateHomeProposalArguments(args);
      if (args.kind === "automation-draft" && args.artifactCandidate === undefined) {
        throw new TypeError("artifactCandidate is required for automation-draft");
      }
      if (args.kind !== "automation-draft" && args.artifactCandidate !== undefined) {
        throw new TypeError("artifactCandidate is only allowed for automation-draft");
      }
      if (args.evidenceSource !== undefined
        && args.evidenceSource !== "live"
        && args.evidenceSource !== "imported-history") {
        throw new TypeError("evidenceSource is invalid");
      }
      if (args.evidenceSource !== undefined
        && (args.selectedHwCapabilityIds === undefined || args.evidenceLookbackHours === undefined)) {
        throw new TypeError("evidenceSource requires selectedHwCapabilityIds and evidenceLookbackHours");
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
        ...(args.evidenceSource === undefined ? {} : { evidenceSource: args.evidenceSource }),
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
      validateHomeProposalResult(proposal);
      if (proposal.status !== "pending_review") throw new Error("Created proposal is not pending review");
      const evidenceSummary = summarizeEvidence(proposal.evidence, args.evidenceSource);
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
        evidenceSummary,
      };
    },
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const CREATE_HOME_PROPOSAL_ARGUMENTS = new Set([
  "kind",
  "title",
  "summary",
  "dedupKey",
  "householdValue",
  "whyNow",
  "uncertainties",
  "idempotencyKey",
  "selectedHwIds",
  "selectedHwCapabilityIds",
  "evidenceLookbackHours",
  "evidenceSource",
  "artifactCandidate",
  "riskLevel",
  "riskReasons",
  "intentDescription",
  "rollback",
]);

function validateCreateHomeProposalArguments(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).some((key) => !CREATE_HOME_PROPOSAL_ARGUMENTS.has(key))) {
    throw new TypeError("create_home_proposal arguments are invalid");
  }
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && value.trim() === value;
}

function isBoundedCount(value: unknown, maximum = 20): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= maximum;
}

function hasStatus(value: unknown, statuses: readonly string[]): boolean {
  return isRecord(value) && typeof value.status === "string" && statuses.includes(value.status);
}

function validateHomeProposalResult(value: unknown): asserts value is HomeProposalResult {
  if (!isRecord(value)
    || !isBoundedString(value.id)
    || typeof value.revision !== "number"
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
    || value.status !== "pending_review"
    || !["not_available", "deploying", "running", "failed", "withdrawn"].includes(String(value.applicationStatus))) {
    throw new TypeError("Home proposal result is invalid");
  }
  const conflict = value.conflictCheck;
  if (!isRecord(conflict)
    || !isBoundedCount(conflict.existingAutomationCount, 1_000)
    || !Array.isArray(conflict.matches)
    || conflict.matches.length > 20) {
    throw new TypeError("Home proposal result is invalid");
  }
  const space = value.spaceCoverage;
  if (!isRecord(space)
    || !isBoundedCount(space.selectedDevices)
    || !isBoundedCount(space.devicesWithSingleSpace)
    || !isBoundedCount(space.devicesWithoutSpace)
    || !isBoundedCount(space.devicesWithMultipleSpaces)
    || space.devicesWithSingleSpace + space.devicesWithoutSpace + space.devicesWithMultipleSpaces !== space.selectedDevices) {
    throw new TypeError("Home proposal result is invalid");
  }
  const evidence = value.evidence;
  if (!isRecord(evidence) || !Array.isArray(evidence.references) || evidence.references.length > 50) {
    throw new TypeError("Home proposal evidence result is invalid");
  }
  if (evidence.temporal !== undefined) {
    if (!isRecord(evidence.temporal)
      || typeof evidence.temporal.truncated !== "boolean"
      || !Array.isArray(evidence.temporal.coverage)
      || evidence.temporal.coverage.length > MAX_PROPOSAL_COVERAGE_BRIDGES
      || evidence.temporal.coverage.some((item) => !hasStatus(item, ["complete", "partial", "unavailable"]))) {
      throw new TypeError("Home proposal evidence result is invalid");
    }
  }
  if (evidence.importedHistory !== undefined) {
    if (!isRecord(evidence.importedHistory)
      || typeof evidence.importedHistory.truncated !== "boolean"
      || !Array.isArray(evidence.importedHistory.coverage)
      || evidence.importedHistory.coverage.length > MAX_PROPOSAL_COVERAGE_BRIDGES
      || evidence.importedHistory.coverage.some((item) => !hasStatus(item, ["partial", "unavailable"]))) {
      throw new TypeError("Home proposal imported-history result is invalid");
    }
  }
}

function summarizeEvidence(
  evidence: HomeProposalResult["evidence"],
  requestedSource: EvidenceSource | undefined,
): {
  readonly source: ProposalEvidenceSummarySource;
  readonly referenceCount: number;
  readonly coverageStatus: "current_state_only" | "complete" | "partial" | "unavailable";
  readonly truncated: boolean;
} {
  const hasTemporal = evidence.temporal !== undefined;
  const hasImportedHistory = evidence.importedHistory !== undefined;
  if (requestedSource === "live" && !hasTemporal) {
    throw new TypeError("Home proposal live evidence is missing temporal coverage");
  }
  if (requestedSource === "imported-history" && !hasImportedHistory) {
    throw new TypeError("Home proposal imported-history evidence is missing coverage");
  }
  if (hasTemporal && hasImportedHistory) {
    throw new TypeError("Home proposal evidence contains mixed sources");
  }
  const source = hasTemporal ? "live" : hasImportedHistory ? "imported-history" : "current-state";
  if (source === "imported-history") {
    const imported = evidence.importedHistory;
    if (imported === undefined) throw new TypeError("Home proposal imported-history evidence is missing coverage");
    return {
      source,
      referenceCount: evidence.references.length,
      coverageStatus: imported.coverage.length === 0 || imported.coverage.some((item) => item.status === "unavailable")
        ? "unavailable"
        : "partial",
      truncated: imported.truncated,
    };
  }
  if (source === "live") {
    const temporal = evidence.temporal;
    if (temporal === undefined) throw new TypeError("Home proposal live evidence is missing temporal coverage");
    return {
      source,
      referenceCount: evidence.references.length,
      coverageStatus: summarizeLiveCoverage(temporal.coverage),
      truncated: temporal.truncated,
    };
  }
  return {
    source,
    referenceCount: evidence.references.length,
    coverageStatus: "current_state_only",
    truncated: false,
  };
}

function summarizeLiveCoverage(
  coverage: readonly { readonly status: "complete" | "partial" | "unavailable" }[],
): "complete" | "partial" | "unavailable" {
  if (coverage.length === 0 || coverage.some((item) => item.status === "unavailable")) return "unavailable";
  return coverage.some((item) => item.status === "partial") ? "partial" : "complete";
}
