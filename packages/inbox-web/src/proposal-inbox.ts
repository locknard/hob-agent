import type { AgentLoopTrace } from "@hob-agent/agent-layer/agent-loop-trace";

import { renderAgentLoopTimeline } from "./agent-loop-timeline.js";

export type InboxProposalStatus = "pending_review" | "approved" | "rejected" | "expired";
export type InboxApprovalFeedbackCode = "useful_as_is";
export type InboxRejectionFeedbackCode =
  | "already_covered"
  | "not_useful"
  | "incorrect_assumption"
  | "insufficient_evidence"
  | "household_preference"
  | "too_risky"
  | "other";
export type InboxReviewFeedbackCode = InboxApprovalFeedbackCode | InboxRejectionFeedbackCode;

export interface InboxProposal {
  readonly id: string;
  readonly revision: number;
  readonly status: InboxProposalStatus;
  readonly applicationStatus: "not_available";
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly provenance: {
    readonly producer: string;
    readonly sessionId?: string;
    readonly toolCallId?: string;
    /** Legacy v1 field containing a root tool call id, not a DSH turn number. */
    readonly turnId?: string;
  };
  readonly evidence: {
    readonly references: readonly {
      readonly bridgeId: string;
      readonly hwId?: string;
      readonly capabilityId?: string;
      readonly observedAt: string;
      readonly source?: "current-state" | "post-baseline-event";
      readonly epochId?: string;
      readonly seq?: number;
    }[];
    readonly watermarks: readonly { readonly bridgeId: string; readonly epochId: string; readonly lastSeq: number; readonly freshness: string; readonly gapCount: number }[];
    readonly temporal?: {
      readonly requestedSince: string;
      readonly requestedUntil: string;
      readonly truncated: boolean;
      readonly coverage: readonly {
        readonly bridgeId: string;
        readonly epochId?: string;
        readonly baselineSeq?: number;
        readonly baselineAt?: string;
        readonly status: "complete" | "partial" | "unavailable";
        readonly reasons: readonly string[];
      }[];
    };
  };
  readonly conflictCheck: {
    readonly status: "checked" | "unavailable";
    readonly existingAutomationCount: number;
    readonly matches: readonly { readonly identity: string; readonly relation: string }[];
  };
  readonly dryRun: { readonly status: string; readonly summary: string };
  readonly risk: { readonly level: string; readonly reasons: readonly string[]; readonly requiresHumanApproval: boolean };
  readonly intent: { readonly type: string; readonly description: string; readonly rollback: string };
  readonly review?: {
    readonly decision: "approved" | "rejected" | "expired";
    readonly reviewer: string;
    readonly reviewedAt: string;
    readonly feedbackCode?: InboxReviewFeedbackCode;
    readonly note?: string;
  };
  readonly audit: readonly { readonly id: string; readonly at: string; readonly action: string; readonly actor: string; readonly revision: number; readonly feedbackCode?: InboxReviewFeedbackCode; readonly note?: string }[];
}

export interface InboxProposalSummary {
  readonly id: string;
  readonly revision: number;
  readonly status: InboxProposalStatus;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly updatedAt: string;
  readonly riskLevel: string;
  readonly existingAutomationCount: number;
  readonly conflictMatchCount: number;
}

export interface InboxObservationStatus {
  readonly enabled: true;
  readonly intervalMinutes: number;
  readonly runOnStart: boolean;
  readonly state: "waiting" | "running" | "stopped";
  readonly lastAttempt?: {
    readonly at: string;
    readonly outcome: "proposal_created" | "no_proposal" | "world_not_ready" | "proposal_pending" | "agent_busy" | "failed";
  };
  readonly recentAttempts?: readonly InboxObservationAttempt[];
}

export type InboxObservationAttempt = {
  readonly id: string;
  readonly trigger: "startup" | "scheduled" | "manual" | "one_shot";
  readonly startedAt: string;
} & (
  | { readonly status: "running" }
  | { readonly status: "interrupted" }
  | {
      readonly status: "completed";
      readonly completedAt: string;
      readonly outcome: NonNullable<InboxObservationStatus["lastAttempt"]>["outcome"];
    }
);

export interface InboxProposalDetail {
  readonly proposal: InboxProposal;
  readonly trace?: AgentLoopTrace;
}

export interface ProposalInboxPort {
  list(query?: { status?: InboxProposalStatus; limit?: number }): readonly InboxProposal[];
  get(proposalId: string): InboxProposal | undefined;
  review(input: InboxReviewInput): InboxProposal | Promise<InboxProposal>;
}

interface InboxReviewInputBase {
  readonly proposalId: string;
  readonly expectedRevision: number;
  readonly reviewer: string;
  readonly note?: string;
}

export type InboxReviewInput = InboxReviewInputBase & (
  | { readonly decision: "approved"; readonly feedbackCode: InboxApprovalFeedbackCode }
  | { readonly decision: "rejected"; readonly feedbackCode: InboxRejectionFeedbackCode }
  | { readonly decision: "expired"; readonly feedbackCode?: never }
);

export interface ProposalTracePort {
  traceSnapshot(): AgentLoopTrace | undefined;
}

/** Review-only facade. Deliberately has no apply/install/control method. */
export class ProposalInboxController {
  constructor(private readonly ports: {
    readonly proposals: ProposalInboxPort;
    readonly traces?: ProposalTracePort;
  }) {}

  list(query?: { status?: InboxProposalStatus; limit?: number }): readonly InboxProposalSummary[] {
    return this.ports.proposals.list(query).map((proposal) => ({
      id: proposal.id,
      revision: proposal.revision,
      status: proposal.status,
      kind: proposal.kind,
      title: proposal.title,
      summary: proposal.summary,
      updatedAt: proposal.updatedAt,
      riskLevel: proposal.risk.level,
      existingAutomationCount: proposal.conflictCheck.existingAutomationCount,
      conflictMatchCount: proposal.conflictCheck.matches.length,
    }));
  }

  detail(proposalId: string): InboxProposalDetail | undefined {
    const proposal = this.ports.proposals.get(proposalId);
    if (proposal === undefined) return undefined;
    const trace = this.ports.traces?.traceSnapshot();
    const toolCallId = proposal.provenance.toolCallId ?? proposal.provenance.turnId;
    return {
      proposal,
      ...(trace !== undefined
        && trace.sessionId === proposal.provenance.sessionId
        && toolCallId !== undefined
        && trace.tools.some((tool) => tool.id === toolCallId)
        ? { trace }
        : {}),
    };
  }

  async review(input: InboxReviewInput): Promise<InboxProposal> {
    return this.ports.proposals.review(input);
  }
}

export function renderProposalList(
  proposals: readonly InboxProposalSummary[],
  observation?: InboxObservationStatus,
  persistedAttempts: readonly InboxObservationAttempt[] = [],
): string {
  const items = proposals.map((proposal) => `<li class="proposal-card" data-status="${escapeHtml(proposal.status)}">
    <a href="/proposals/${encodeURIComponent(proposal.id)}"><h2>${escapeHtml(proposal.title)}</h2></a>
    <p>${escapeHtml(proposal.summary)}</p>
    <dl><dt>Risk</dt><dd>${escapeHtml(proposal.riskLevel)}</dd><dt>Existing automations</dt><dd>${proposal.existingAutomationCount}</dd><dt>Possible overlaps</dt><dd>${proposal.conflictMatchCount}</dd></dl>
  </li>`).join("");
  const observationStatus = observation === undefined
    ? "<p class=\"observation-status\">Observation schedule is disabled.</p>"
    : `<p class="observation-status">Observation: ${escapeHtml(observation.state)} · every ${observation.intervalMinutes} minutes · startup ${observation.runOnStart ? "enabled" : "disabled"}${observation.lastAttempt === undefined ? "" : ` · last ${escapeHtml(observationOutcomeLabel(observation.lastAttempt.outcome))} at ${escapeHtml(observation.lastAttempt.at)}`}</p>`;
  const attempts = observation?.recentAttempts ?? persistedAttempts;
  const observationHistory = attempts.length === 0
    ? ""
    : `<section aria-label="Recent observations"><h2>Recent observations</h2><ol>${attempts.slice(0, 5).map((attempt) =>
      `<li>${escapeHtml(observationTriggerLabel(attempt.trigger))} · ${observationAttemptLabel(attempt)} · ${escapeHtml(attempt.startedAt)}</li>`,
    ).join("")}</ol></section>`;
  return `<main class="proposal-inbox"><header><h1>Proposal inbox</h1><p>${proposals.length} review item${proposals.length === 1 ? "" : "s"}</p>${observationStatus}</header>${observationHistory}<ol>${items}</ol></main>`;
}

function observationAttemptLabel(attempt: InboxObservationAttempt): string {
  if (attempt.status === "running") return "running";
  if (attempt.status === "interrupted") return "interrupted safely";
  return escapeHtml(observationOutcomeLabel(attempt.outcome));
}

function observationTriggerLabel(trigger: InboxObservationAttempt["trigger"]): string {
  switch (trigger) {
    case "startup": return "startup";
    case "scheduled": return "scheduled";
    case "manual": return "manual";
    case "one_shot": return "one shot";
  }
}

export function renderProposalDetail(detail: InboxProposalDetail): string {
  const { proposal } = detail;
  const watermarks = proposal.evidence.watermarks.map((watermark) =>
    `<li><strong>${escapeHtml(watermark.bridgeId)}</strong> · seq ${watermark.lastSeq} · ${escapeHtml(watermark.freshness)} · ${watermark.gapCount} gaps</li>`,
  ).join("");
  const risks = proposal.risk.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
  const references = proposal.evidence.references.map((reference) =>
    `<li><strong>${escapeHtml(reference.capabilityId ?? reference.hwId ?? reference.bridgeId)}</strong> · ${escapeHtml(reference.source ?? "legacy-reference")} · ${escapeHtml(reference.observedAt)}${reference.seq === undefined ? "" : ` · seq ${reference.seq}`}</li>`,
  ).join("");
  const temporalCoverage = proposal.evidence.temporal === undefined
    ? "<p>Current-state references only; no behavioral coverage is claimed.</p>"
    : `<p>Temporal window ${escapeHtml(proposal.evidence.temporal.requestedSince)} to ${escapeHtml(proposal.evidence.temporal.requestedUntil)}${proposal.evidence.temporal.truncated ? " · truncated" : ""}</p><ul>${proposal.evidence.temporal.coverage.map((coverage) =>
      `<li><strong>${escapeHtml(coverage.bridgeId)}</strong> · ${escapeHtml(coverage.status)}${coverage.reasons.length === 0 ? "" : ` · ${coverage.reasons.map(escapeHtml).join(", ")}`}</li>`,
    ).join("")}</ul>`;
  const review = proposal.status === "pending_review" ? `<section aria-label="Household review"><h2>Household review</h2>
  <form method="post" action="/proposals/${encodeURIComponent(proposal.id)}/review">
    <input type="hidden" name="expectedRevision" value="${proposal.revision}">
    <input type="hidden" name="feedbackCode" value="useful_as_is">
    <p>Why does this match your household? Approve only when it is useful as-is.</p>
    <label>Approval note <textarea name="note" maxlength="1000"></textarea></label>
    <button type="submit" name="decision" value="approved">Approve</button>
  </form>
  <form method="post" action="/proposals/${encodeURIComponent(proposal.id)}/review">
    <input type="hidden" name="expectedRevision" value="${proposal.revision}">
    <label>Why reject this suggestion? <select name="feedbackCode" required>
      <option value="">Choose a reason</option>
      <option value="already_covered">Already handled</option>
      <option value="not_useful">Not useful</option>
      <option value="incorrect_assumption">Incorrect assumption</option>
      <option value="insufficient_evidence">Not enough evidence</option>
      <option value="household_preference">Does not fit our household</option>
      <option value="too_risky">Too risky</option>
      <option value="other">Other</option>
    </select></label>
    <label>Rejection note <textarea name="note" maxlength="1000"></textarea></label>
    <button type="submit" name="decision" value="rejected">Reject</button>
  </form></section>` : `<section class="review-decision" aria-label="Household review"><h2>Household review</h2><p>Decision: ${escapeHtml(proposal.status)}</p>${proposal.review?.feedbackCode === undefined ? "" : `<p>Reason: ${escapeHtml(feedbackLabel(proposal.review.feedbackCode))}</p>`}${proposal.review?.note === undefined ? "" : `<p>Note: ${escapeHtml(proposal.review.note)}</p>`}</section>`;
  const timeline = detail.trace === undefined ? "" : renderAgentLoopTimeline(detail.trace);
  return `<main class="proposal-detail" data-status="${escapeHtml(proposal.status)}">
    <header><a href="/proposals">Proposal inbox</a><h1>${escapeHtml(proposal.title)}</h1><p>${escapeHtml(proposal.summary)}</p></header>
    <section aria-label="Intent"><h2>Intended change</h2><p>${escapeHtml(proposal.intent.description)}</p><h3>Rollback</h3><p>${escapeHtml(proposal.intent.rollback)}</p></section>
    <section aria-label="Evidence"><h2>Evidence</h2><p>${proposal.evidence.references.length} bounded references</p><h3>References</h3><ul>${references}</ul><h3>Coverage</h3>${temporalCoverage}<h3>Bridge watermarks</h3><ul>${watermarks}</ul></section>
    <section aria-label="Existing-rule overlap screen"><h2>Existing-rule overlap screen</h2><p>${proposal.conflictCheck.existingAutomationCount} existing automations · ${proposal.conflictCheck.matches.length} possible name overlaps</p><p>Metadata-only overlap screen; zero matches does not prove non-interference. Review existing rule logic before implementation.</p></section>
    <section aria-label="Dry run"><h2>Dry run: ${escapeHtml(proposal.dryRun.status)}</h2><p>${escapeHtml(proposal.dryRun.summary)}</p></section>
    <section aria-label="Risk"><h2>Risk: ${escapeHtml(proposal.risk.level)}</h2><ul>${risks}</ul></section>
    ${review}${timeline}
  </main>`;
}

function observationOutcomeLabel(
  outcome: NonNullable<InboxObservationStatus["lastAttempt"]>["outcome"],
): string {
  switch (outcome) {
    case "proposal_created": return "proposal created";
    case "no_proposal": return "no useful proposal";
    case "world_not_ready": return "home not ready";
    case "proposal_pending": return "review already pending";
    case "agent_busy": return "agent busy";
    case "failed": return "failed safely";
  }
}

function feedbackLabel(code: InboxReviewFeedbackCode): string {
  switch (code) {
    case "useful_as_is": return "Useful as-is";
    case "already_covered": return "Already handled";
    case "not_useful": return "Not useful";
    case "incorrect_assumption": return "Incorrect assumption";
    case "insufficient_evidence": return "Not enough evidence";
    case "household_preference": return "Does not fit our household";
    case "too_risky": return "Too risky";
    case "other": return "Other";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;",
  })[character] ?? character);
}
