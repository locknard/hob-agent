import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";

export type HomeObservationBudgetOutcome = "tool_budget_exhausted" | undefined;

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeObservationBudget: HomeObservationBudgetService;
  }
}

/** Product-owned tool-call bound for one autonomous Home Agent observation. */
export class HomeObservationBudgetService extends Service {
  static inject = ["tools"];

  private activeAgent: Agent | undefined;
  private maxToolCalls = 0;
  private usedToolCalls = 0;
  private exhausted = false;

  constructor(ctx: Context) {
    super(ctx, "homeObservationBudget");
  }

  protected [Service.init](): void {
    this.ctx.tools.guard((execution) => this.guard(execution));
  }

  begin(agent: Agent, maxToolCalls: number): void {
    if (this.activeAgent !== undefined) throw new Error("Home observation budget is already active");
    if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1) {
      throw new TypeError("Home observation tool budget must be a positive safe integer");
    }
    this.activeAgent = agent;
    this.maxToolCalls = maxToolCalls;
    this.usedToolCalls = 0;
    this.exhausted = false;
  }

  end(): HomeObservationBudgetOutcome {
    const outcome = this.exhausted ? "tool_budget_exhausted" : undefined;
    this.activeAgent = undefined;
    this.maxToolCalls = 0;
    this.usedToolCalls = 0;
    this.exhausted = false;
    return outcome;
  }

  private guard(execution: Readonly<ToolExecution>): string | undefined {
    if (this.activeAgent === undefined || execution.agent !== this.activeAgent) return undefined;
    if (this.usedToolCalls < this.maxToolCalls) {
      this.usedToolCalls += 1;
      return undefined;
    }
    if (!this.exhausted) {
      this.exhausted = true;
      this.activeAgent.cancel({ kind: "parent" }, { keepInbox: true });
    }
    return "Autonomous home observation tool budget exhausted";
  }
}
