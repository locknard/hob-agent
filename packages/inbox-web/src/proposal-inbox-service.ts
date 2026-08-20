import { Context, Service } from "@deepseek-ai/cordis";

import {
  ProposalInboxController,
  renderProposalDetail,
  renderProposalList,
  renderHomeAdvice,
  type InboxProposal,
  type InboxProposalDetail,
  type InboxProposalStatus,
  type InboxProposalSummary,
  type InboxObservationStatus,
  type InboxObservationAttempt,
  type InboxReviewInput,
  type InboxProposalQualitySummary,
  type InboxObservationQualitySummary,
  type ProposalInboxPort,
  type ProposalTracePort,
  type InboxHomeAdviceRecord,
} from "./proposal-inbox.js";
import {
  projectControlCenter,
  renderControlCenter as renderControlCenterPage,
  type ControlCenterAgentSource,
  type ControlCenterObservationSource,
  type ControlCenterProposalSource,
  type ControlCenterRetentionSource,
  type ControlCenterSnapshot,
  type ControlCenterWorldSource,
} from "./control-center.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeInbox: ProposalInboxService;
  }
}

/** Local review composition over hub proposal state and metadata-safe DSH traces. */
export class ProposalInboxService extends Service {
  static inject = ["homeProposals"];

  private readonly controller: ProposalInboxController;
  private readonly observation?: {
    snapshot(): InboxObservationStatus;
    observeNow(): Promise<string>;
  };
  private readonly proposalQuality: { qualitySummary(): InboxProposalQualitySummary };
  private readonly controlCenterSources: {
    readonly world?: ControlCenterWorldSource;
    readonly retention?: ControlCenterRetentionSource;
    readonly agent?: ControlCenterAgentSource;
    readonly observation?: ControlCenterObservationSource;
    readonly proposals?: ControlCenterProposalSource;
  };
  private readonly observationAudit?: {
    list(query: { limit: number }): readonly InboxObservationAttempt[];
    summary(): InboxObservationQualitySummary;
  };
  private readonly advice?: {
    canAsk(): boolean;
    ask(question: string): Promise<InboxHomeAdviceRecord>;
    list(query?: { limit?: number }): readonly InboxHomeAdviceRecord[];
    get(id: string): InboxHomeAdviceRecord | undefined;
  };

  constructor(ctx: Context) {
    super(ctx, "homeInbox");
    const trace = ctx.get("homeAgent") as unknown as ProposalTracePort | undefined;
    this.controller = new ProposalInboxController({
      proposals: ctx.homeProposals as unknown as ProposalInboxPort,
      ...(trace === undefined ? {} : { traces: trace }),
    });
    this.proposalQuality = ctx.homeProposals as unknown as { qualitySummary(): InboxProposalQualitySummary };
    const retention = ctx.get("homeRetention") as unknown as { status(): ReturnType<ControlCenterRetentionSource["snapshot"]> } | undefined;
    this.observation = ctx.get("homeObservationScheduler") as unknown as {
      snapshot(): InboxObservationStatus;
      observeNow(): Promise<string>;
    } | undefined;
    this.controlCenterSources = {
      world: ctx.get("homeWorld") as unknown as ControlCenterWorldSource | undefined,
      ...(retention === undefined ? {} : { retention: { snapshot: () => retention.status() } }),
      agent: ctx.get("homeAgent") as unknown as ControlCenterAgentSource | undefined,
      ...(this.observation === undefined ? {} : { observation: this.observation }),
      proposals: this.proposalQuality,
    };
    this.observationAudit = ctx.get("homeObservationAudit") as unknown as {
      list(query: { limit: number }): readonly InboxObservationAttempt[];
      summary(): InboxObservationQualitySummary;
    } | undefined;
    this.advice = ctx.get("homeAdvice") as unknown as typeof this.advice;
  }

  list(query?: { status?: InboxProposalStatus; limit?: number }): readonly InboxProposalSummary[] {
    return this.controller.list(query);
  }

  detail(proposalId: string): InboxProposalDetail | undefined {
    return this.controller.detail(proposalId);
  }

  review(input: InboxReviewInput): Promise<InboxProposal> {
    return this.controller.review(input);
  }

  canObserveNow(): boolean {
    return this.observation !== undefined;
  }

  async observeNow(): Promise<string> {
    if (this.observation === undefined) throw new Error("Home observation is unavailable");
    return this.observation.observeNow();
  }

  canAskAdvice(): boolean {
    return this.advice?.canAsk() ?? false;
  }

  async askAdvice(question: string): Promise<InboxHomeAdviceRecord> {
    if (!this.canAskAdvice() || this.advice === undefined) throw new Error("Home advice is unavailable");
    return this.advice.ask(question);
  }

  renderAdvice(id: string): string | undefined {
    const advice = this.advice?.get(id);
    return advice === undefined ? undefined : renderHomeAdvice(advice);
  }

  renderList(query?: { status?: InboxProposalStatus; limit?: number }): string {
    return renderProposalList(
      this.list(query),
      this.observation?.snapshot(),
      this.observationAudit?.list({ limit: 5 }),
      {
        proposals: this.proposalQuality.qualitySummary(),
        ...(this.observationAudit === undefined ? {} : { observations: this.observationAudit.summary() }),
      },
      this.advice?.list({ limit: 5 }),
      this.canAskAdvice(),
    );
  }

  controlCenterSnapshot(): ControlCenterSnapshot {
    return projectControlCenter(this.controlCenterSources);
  }

  renderControlCenter(): string {
    return renderControlCenterPage(this.controlCenterSnapshot());
  }

  renderDetail(proposalId: string): string | undefined {
    const detail = this.detail(proposalId);
    return detail === undefined ? undefined : renderProposalDetail(detail);
  }
}
