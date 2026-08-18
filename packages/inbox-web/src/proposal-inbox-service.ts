import { Context, Service } from "@deepseek-ai/cordis";

import {
  ProposalInboxController,
  renderProposalDetail,
  renderProposalList,
  type InboxProposal,
  type InboxProposalDetail,
  type InboxProposalStatus,
  type InboxProposalSummary,
  type InboxReviewInput,
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
  static inject = ["homeProposals", "homeAgent"];

  private readonly controller: ProposalInboxController;

  constructor(ctx: Context) {
    super(ctx, "homeInbox");
    this.controller = new ProposalInboxController({
      proposals: ctx.homeProposals as unknown as ProposalInboxPort,
      traces: ctx.homeAgent as unknown as ProposalTracePort,
    });
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
    return renderProposalList(this.list(query));
  }

  renderDetail(proposalId: string): string | undefined {
    const detail = this.detail(proposalId);
    return detail === undefined ? undefined : renderProposalDetail(detail);
  }
}
