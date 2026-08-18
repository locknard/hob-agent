import { Context, Service } from "@deepseek-ai/cordis";

import {
  ProposalInboxController,
  renderProposalDetail,
  renderProposalList,
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
} from "./proposal-inbox.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeInbox: ProposalInboxService;
  }
}

/** Local review composition over hub proposal state and metadata-safe DSH traces. */
export class ProposalInboxService extends Service {
  static inject = ["homeProposals"];

  private readonly controller: ProposalInboxController;
  private readonly observation?: { snapshot(): InboxObservationStatus };
  private readonly proposalQuality: { qualitySummary(): InboxProposalQualitySummary };
  private readonly observationAudit?: {
    list(query: { limit: number }): readonly InboxObservationAttempt[];
    summary(): InboxObservationQualitySummary;
  };

  constructor(ctx: Context) {
    super(ctx, "homeInbox");
    const trace = ctx.get("homeAgent") as unknown as ProposalTracePort | undefined;
    this.controller = new ProposalInboxController({
      proposals: ctx.homeProposals as unknown as ProposalInboxPort,
      ...(trace === undefined ? {} : { traces: trace }),
    });
    this.proposalQuality = ctx.homeProposals as unknown as { qualitySummary(): InboxProposalQualitySummary };
    this.observation = ctx.get("homeObservationScheduler") as unknown as { snapshot(): InboxObservationStatus } | undefined;
    this.observationAudit = ctx.get("homeObservationAudit") as unknown as {
      list(query: { limit: number }): readonly InboxObservationAttempt[];
      summary(): InboxObservationQualitySummary;
    } | undefined;
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

  renderList(query?: { status?: InboxProposalStatus; limit?: number }): string {
    return renderProposalList(
      this.list(query),
      this.observation?.snapshot(),
      this.observationAudit?.list({ limit: 5 }),
      {
        proposals: this.proposalQuality.qualitySummary(),
        ...(this.observationAudit === undefined ? {} : { observations: this.observationAudit.summary() }),
      },
    );
  }

  renderDetail(proposalId: string): string | undefined {
    const detail = this.detail(proposalId);
    return detail === undefined ? undefined : renderProposalDetail(detail);
  }
}
