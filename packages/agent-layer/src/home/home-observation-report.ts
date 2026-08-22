import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";

export type HomeObservationDisposition =
  | "no_material_value"
  | "insufficient_evidence"
  | "existing_rule_overlap"
  | "mapping_uncertain"
  | "other_uncertainty";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeObservationReport: HomeObservationReportService;
  }
}

/** Captures one bounded, model-authored disposition during an autonomous observation. */
export class HomeObservationReportService extends Service {
  static inject = ["tools"];

  private activeAgent: Agent | undefined;
  private disposition: HomeObservationDisposition | undefined;

  constructor(ctx: Context) {
    super(ctx, "homeObservationReport");
  }

  protected [Service.init](): void {
    this.ctx.tools.register(defineTool({
      name: "report_home_observation",
      description: [
        "Report one bounded reason when a governed household observation creates no proposal.",
        "This is Agent-authored calibration metadata only; it is not Hub evidence and changes no household state or authority.",
      ].join(" "),
      parameters: {
        disposition: {
          type: "string",
          required: true,
          enum: [
            "no_material_value",
            "insufficient_evidence",
            "existing_rule_overlap",
            "mapping_uncertain",
            "other_uncertainty",
          ],
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            recorded: { type: "boolean", required: true },
            disposition: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      execute: async (args, execution) => {
        if (execution.agent === undefined) throw new Error("Observation report requires an Agent");
        this.record(execution.agent, args.disposition);
        return { recorded: true, disposition: args.disposition };
      },
    }));
  }

  begin(agent: Agent): void {
    if (this.activeAgent !== undefined) throw new Error("Home observation report is already active");
    this.activeAgent = agent;
    this.disposition = undefined;
  }

  end(): HomeObservationDisposition | undefined {
    const disposition = this.disposition;
    this.activeAgent = undefined;
    this.disposition = undefined;
    return disposition;
  }

  private record(agent: Agent, disposition: HomeObservationDisposition): void {
    if (this.activeAgent === undefined || agent !== this.activeAgent) {
      throw new Error("Observation report is outside the active autonomous observation");
    }
    if (this.disposition !== undefined) throw new Error("Observation disposition is already recorded");
    this.disposition = disposition;
  }
}

