import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const HOME_ADVICE_HARDWARE_CAPABILITIES = [
  "illuminance",
  "motion",
  "presence",
  "contact",
  "temperature",
  "humidity",
  "air_quality",
  "energy",
  "leak",
  "weather",
] as const;

export type HomeAdviceHardwareCapability = typeof HOME_ADVICE_HARDWARE_CAPABILITIES[number];
export type HomeAdviceConfidence = "sufficient" | "partial" | "insufficient";

export interface HomeAdviceReport {
  readonly summary: string;
  readonly confidence: HomeAdviceConfidence;
  readonly findings: readonly string[];
  readonly unknowns: readonly string[];
  readonly trial?: {
    readonly description: string;
    readonly durationDays: number;
    readonly successCriteria: readonly string[];
    readonly rollback: string;
  };
  readonly hardwareSuggestions: readonly {
    readonly capability: HomeAdviceHardwareCapability;
    readonly necessity: "optional" | "recommended";
    readonly reason: string;
    readonly placement?: string;
    readonly privacyImpact: "low" | "medium" | "high";
    readonly alternative: string;
  }[];
  readonly validationSteps: readonly string[];
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeAdviceReport: HomeAdviceReportService;
  }
}

/** Captures one bounded model-authored report during an explicit advice turn. */
export class HomeAdviceReportService extends Service {
  static inject = ["tools"];

  private activeAgent: Agent | undefined;
  private report: HomeAdviceReport | undefined;

  constructor(ctx: Context) {
    super(ctx, "homeAdviceReport");
  }

  protected [Service.init](): void {
    this.ctx.tools.register(defineTool({
      name: "report_home_advice",
      description: [
        "Publish the one structured answer required for an explicit household advice request.",
        "All fields are Agent-authored guidance, not Hub evidence or authority.",
        "Hardware suggestions name sensing capabilities only, never brands or products.",
      ].join(" "),
      parameters: {
        summary: { type: "string", required: true },
        confidence: { type: "string", required: true, enum: ["sufficient", "partial", "insufficient"] },
        findings: { type: "array", required: true, items: { type: "string" } },
        unknowns: { type: "array", required: true, items: { type: "string" } },
        trial: {
          type: "object",
          additionalProperties: false,
          properties: {
            description: { type: "string", required: true },
            durationDays: { type: "integer", required: true },
            successCriteria: { type: "array", required: true, items: { type: "string" } },
            rollback: { type: "string", required: true },
          },
        },
        hardwareSuggestions: {
          type: "array",
          required: true,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              capability: { type: "string", required: true, enum: HOME_ADVICE_HARDWARE_CAPABILITIES },
              necessity: { type: "string", required: true, enum: ["optional", "recommended"] },
              reason: { type: "string", required: true },
              placement: { type: "string" },
              privacyImpact: { type: "string", required: true, enum: ["low", "medium", "high"] },
              alternative: { type: "string", required: true },
            },
          },
        },
        validationSteps: { type: "array", required: true, items: { type: "string" } },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { recorded: { type: "boolean", required: true } },
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      execute: async (args, execution) => {
        if (execution.agent === undefined) throw new Error("Advice report requires an Agent");
        const report = parseHomeAdviceReport(args);
        if (report.hardwareSuggestions.length > 0) {
          this.ctx.get("homeInventoryCoverage")?.assertHardwareAdviceAllowed();
        }
        this.record(execution.agent, report);
        return { recorded: true };
      },
    }));
  }

  begin(agent: Agent): void {
    if (this.activeAgent !== undefined) throw new Error("Home advice report is already active");
    this.activeAgent = agent;
    this.report = undefined;
  }

  end(): HomeAdviceReport | undefined {
    const report = this.report;
    this.activeAgent = undefined;
    this.report = undefined;
    return report === undefined ? undefined : copyReport(report);
  }

  private record(agent: Agent, report: HomeAdviceReport): void {
    if (this.activeAgent === undefined || agent !== this.activeAgent) {
      throw new Error("Advice report is outside the active household advice turn");
    }
    if (this.report !== undefined) throw new Error("Home advice report is already recorded");
    this.report = copyReport(report);
  }
}

export function parseHomeAdviceReport(value: unknown): HomeAdviceReport {
  if (!isRecord(value)) throw new TypeError("Invalid home advice report");
  const summary = boundedText(value.summary, "summary");
  const confidence = value.confidence;
  if (confidence !== "sufficient" && confidence !== "partial" && confidence !== "insufficient") {
    throw new TypeError("Invalid home advice confidence");
  }
  const findings = boundedTextArray(value.findings, "findings", 6);
  const unknowns = boundedTextArray(value.unknowns, "unknowns", 6);
  const validationSteps = boundedTextArray(value.validationSteps, "validationSteps", 6);
  if (!Array.isArray(value.hardwareSuggestions) || value.hardwareSuggestions.length > 4) {
    throw new TypeError("Invalid home advice hardware suggestions");
  }
  const hardwareSuggestions = value.hardwareSuggestions.map((item) => validateHardwareSuggestion(item));
  const trial = value.trial === undefined ? undefined : validateTrial(value.trial);
  if (confidence !== "sufficient" && hardwareSuggestions.some((item) => item.necessity === "recommended")) {
    throw new TypeError("Recommended hardware requires sufficient evidence confidence");
  }
  if (confidence !== "sufficient" && hardwareSuggestions.length > 0 && trial === undefined) {
    throw new TypeError("Hardware advice with incomplete evidence requires a reversible trial");
  }
  return {
    summary,
    confidence,
    findings,
    unknowns,
    ...(trial === undefined ? {} : { trial }),
    hardwareSuggestions,
    validationSteps,
  };
}

function validateTrial(value: unknown): NonNullable<HomeAdviceReport["trial"]> {
  if (!isRecord(value)) throw new TypeError("Invalid home advice trial");
  if (!Number.isSafeInteger(value.durationDays) || (value.durationDays as number) < 1 || (value.durationDays as number) > 90) {
    throw new TypeError("Invalid home advice trial duration");
  }
  return {
    description: boundedText(value.description, "trial description"),
    durationDays: value.durationDays as number,
    successCriteria: boundedTextArray(value.successCriteria, "successCriteria", 6),
    rollback: boundedText(value.rollback, "trial rollback"),
  };
}

function validateHardwareSuggestion(value: unknown): HomeAdviceReport["hardwareSuggestions"][number] {
  if (!isRecord(value) || !HOME_ADVICE_HARDWARE_CAPABILITIES.includes(value.capability as HomeAdviceHardwareCapability)) {
    throw new TypeError("Invalid home advice hardware capability");
  }
  if (value.necessity !== "optional" && value.necessity !== "recommended") {
    throw new TypeError("Invalid home advice hardware necessity");
  }
  if (value.privacyImpact !== "low" && value.privacyImpact !== "medium" && value.privacyImpact !== "high") {
    throw new TypeError("Invalid home advice privacy impact");
  }
  return {
    capability: value.capability as HomeAdviceHardwareCapability,
    necessity: value.necessity,
    reason: boundedText(value.reason, "hardware reason"),
    ...(value.placement === undefined ? {} : { placement: boundedText(value.placement, "hardware placement") }),
    privacyImpact: value.privacyImpact,
    alternative: boundedText(value.alternative, "hardware alternative"),
  };
}

function boundedTextArray(value: unknown, field: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`Invalid home advice ${field}`);
  return value.map((item) => boundedText(item, field));
}

function boundedText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`Invalid home advice ${field}`);
  const text = value.trim();
  if (text.length < 1 || text.length > 1_000) throw new TypeError(`Invalid home advice ${field}`);
  if (containsInternalImplementationDetail(text)) {
    throw new TypeError(`Home advice ${field} contains an internal implementation detail`);
  }
  return text;
}

function containsInternalImplementationDetail(text: string): boolean {
  return /\bhwc?-[a-f0-9]{6,}\b/i.test(text)
    || /\b(?:hwId|hwCapabilityId|capabilityId)\b/i.test(text)
    || /\b(?:binary-sensor|invalid-source|present-but-invalid)\b/i.test(text)
    || /\b(?:journal_query_unavailable|window_before_baseline|missing_consistent_baseline|baseline_time_unknown|bridge_not_ready|selection_too_broad|query_truncated|merge_truncated)\b/i.test(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyReport(report: HomeAdviceReport): HomeAdviceReport {
  return {
    ...report,
    findings: [...report.findings],
    unknowns: [...report.unknowns],
    ...(report.trial === undefined ? {} : {
      trial: { ...report.trial, successCriteria: [...report.trial.successCriteria] },
    }),
    hardwareSuggestions: report.hardwareSuggestions.map((item) => ({ ...item })),
    validationSteps: [...report.validationSteps],
  };
}
