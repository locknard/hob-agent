import {
  sliceAgentLoopTraceForTool,
  type AgentLoopTrace,
} from "@hob-agent/agent-layer/agent-loop-trace";

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
  readonly rationale?: {
    readonly householdValue: string;
    readonly whyNow: string;
    readonly uncertainties: readonly string[];
  };
  readonly spaceCoverage?: {
    readonly selectedDevices: number;
    readonly devicesWithSingleSpace: number;
    readonly devicesWithoutSpace: number;
    readonly devicesWithMultipleSpaces: number;
  };
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
  readonly enabled: boolean;
  readonly intervalMinutes?: number;
  readonly runOnStart: boolean;
  readonly state: "waiting" | "running" | "stopped";
  readonly lastAttempt?: {
    readonly at: string;
    readonly outcome: "proposal_created" | "no_proposal" | "world_not_ready" | "proposal_pending" | "agent_busy" | "failed";
    readonly disposition?: InboxObservationDisposition;
    readonly metrics?: InboxObservationMetrics;
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
      readonly disposition?: InboxObservationDisposition;
      readonly metrics?: InboxObservationMetrics;
    }
);

export interface InboxObservationMetrics {
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly toolCalls: number;
  readonly failedToolCalls: number;
}

export type InboxObservationDisposition =
  | "no_material_value"
  | "insufficient_evidence"
  | "existing_rule_overlap"
  | "mapping_uncertain"
  | "other_uncertainty";

export type InboxHomeAdviceRecord = {
  readonly id: string;
  readonly question: string;
  readonly createdAt: string;
} & (
  | { readonly status: "running" }
  | { readonly status: "failed"; readonly completedAt: string }
  | {
      readonly status: "completed";
      readonly completedAt: string;
      readonly report: {
        readonly summary: string;
        readonly confidence: "sufficient" | "partial" | "insufficient";
        readonly findings: readonly string[];
        readonly unknowns: readonly string[];
        readonly trial?: {
          readonly description: string;
          readonly durationDays: number;
          readonly successCriteria: readonly string[];
          readonly rollback: string;
        };
        readonly hardwareSuggestions: readonly {
          readonly capability: "illuminance" | "motion" | "presence" | "contact" | "temperature" | "humidity" | "air_quality" | "energy" | "leak" | "weather";
          readonly necessity: "optional" | "recommended";
          readonly reason: string;
          readonly placement?: string;
          readonly privacyImpact: "low" | "medium" | "high";
          readonly alternative: string;
        }[];
        readonly validationSteps: readonly string[];
      };
    }
);

export interface InboxProposalQualitySummary {
  readonly total: number;
  readonly statuses: Readonly<Record<InboxProposalStatus, number>>;
  readonly feedback: Readonly<Record<InboxReviewFeedbackCode, number>>;
  readonly reviewedWithoutFeedback: number;
}

export interface InboxObservationQualitySummary {
  readonly totalAttempts: number;
  readonly completedAttempts: number;
  readonly interruptedAttempts: number;
  readonly runningAttempts: number;
  readonly outcomes: Readonly<Record<NonNullable<InboxObservationStatus["lastAttempt"]>["outcome"], number>>;
  readonly dispositions: Readonly<Record<InboxObservationDisposition, number>>;
  readonly noProposalWithoutDisposition: number;
  readonly measuredAttempts: number;
  readonly metrics: InboxObservationMetrics;
}

export interface InboxCalibrationSummary {
  readonly proposals: InboxProposalQualitySummary;
  readonly observations?: InboxObservationQualitySummary;
}

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
    const proposalTrace = trace !== undefined
      && trace.sessionId === proposal.provenance.sessionId
      && toolCallId !== undefined
      ? sliceAgentLoopTraceForTool(trace, toolCallId)
      : undefined;
    return {
      proposal,
      ...(proposalTrace === undefined ? {} : { trace: proposalTrace }),
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
  calibration?: InboxCalibrationSummary,
  advice: readonly InboxHomeAdviceRecord[] = [],
  canAskAdvice = false,
): string {
  const items = proposals.map((proposal) => `<li class="proposal-row" data-status="${escapeHtml(proposal.status)}">
    <a href="/proposals/${encodeURIComponent(proposal.id)}"><h2>${escapeHtml(proposal.title)}</h2></a>
    <p>${escapeHtml(proposal.summary)}</p>
    <dl class="proposal-meta"><div><dt>Risk</dt><dd>${escapeHtml(proposal.riskLevel)}</dd></div><div><dt>Existing rules</dt><dd>${proposal.existingAutomationCount}</dd></div><div><dt>Possible overlaps</dt><dd>${proposal.conflictMatchCount}</dd></div></dl>
  </li>`).join("");
  const observationStatus = observation === undefined
    ? "<p class=\"observation-status\">Observation schedule is disabled.</p>"
    : `<p class="observation-status">Observation: ${escapeHtml(observation.state)} · ${observation.enabled ? `every ${observation.intervalMinutes} minutes · startup ${observation.runOnStart ? "enabled" : "disabled"}` : "recurring schedule disabled · manual observation available"}${observation.lastAttempt === undefined ? "" : ` · last ${escapeHtml(observationOutcomeLabel(observation.lastAttempt.outcome, observation.lastAttempt.disposition))}${observationMetricsLabel(observation.lastAttempt.metrics)} at ${escapeHtml(observation.lastAttempt.at)}`}</p>`;
  const observationControl = observation === undefined
    ? "<div><h2>Observe your home</h2><p>Open the full home runtime to start a governed observation. This standalone review process never connects a bridge or calls a model.</p></div>"
    : `<div><h2>Observe your home</h2><p>Ask the Agent to examine bounded evidence from this running home session. It may create one review item, but it cannot apply a change.</p></div><form method="post" action="/observations/run"><button type="submit"${observation.state === "running" || observation.state === "stopped" ? " disabled" : ""}>Observe now</button></form>`;
  const attempts = observation?.recentAttempts ?? persistedAttempts;
  const observationHistory = attempts.length === 0
    ? ""
    : `<ol class="observation-list">${attempts.slice(0, 5).map((attempt) =>
      `<li>${escapeHtml(observationTriggerLabel(attempt.trigger))} · ${observationAttemptLabel(attempt)}${observationMetricsLabel(attempt.status === "completed" ? attempt.metrics : undefined)} · ${escapeHtml(attempt.startedAt)}</li>`,
    ).join("")}</ol>`;
  const calibrationSection = calibration === undefined ? "" : `<details class="quiet-section">${renderCalibrationSummary(calibration)}</details>`;
  const empty = proposals.length === 0 ? `<div class="empty-state"><h2>No ideas need review</h2><p>When the Agent finds a useful pattern with enough evidence, it will appear here before anything can change.</p></div>` : `<ol class="proposal-list">${items}</ol>`;
  const adviceItems = advice.slice(0, 5).map((item) => `<li><a href="/advice/${encodeURIComponent(item.id)}"><strong>${escapeHtml(item.question)}</strong></a><span>${item.status === "completed" ? escapeHtml(item.report.summary) : escapeHtml(item.status)}</span></li>`).join("");
  const adviceControl = canAskAdvice
    ? `<form class="advice-form" method="post" action="/advice"><label for="home-question">What would you like to understand?</label><textarea id="home-question" name="question" maxlength="1000" required></textarea><p>The Agent will inspect bounded household evidence and return guidance only. It cannot make a change.</p><button type="submit">Ask about your home</button></form>`
    : `<p>Open the full home runtime to ask a new question. Stored answers remain available here.</p>`;
  const adviceHistory = adviceItems.length === 0 ? "<p>No household questions have been answered yet.</p>" : `<ol class="advice-list">${adviceItems}</ol>`;
  return `<main id="main-content" class="proposal-inbox"><header id="overview" class="page-header"><p class="eyebrow">Household review</p><h1>Review ideas for your home</h1><p class="muted">The Agent can suggest persistent behavior, but your household decides what is useful.</p></header><section id="home" class="inbox-overview" aria-label="Home status">${observationStatus}</section><section id="advice" class="quiet-section" aria-labelledby="advice-heading"><div class="section-heading"><div><p class="eyebrow">One question at a time</p><h2 id="advice-heading">Ask about your home</h2></div></div>${adviceControl}<details><summary>Recent answers</summary>${adviceHistory}</details></section><section id="observations" class="observation-panel" aria-label="Home observation">${observationControl}</section><section class="quiet-section" aria-label="Recent observations"><details><summary>Recent observations</summary>${observationHistory || "<p>No observations have been recorded yet.</p>"}</details></section><section id="reviews" class="quiet-section" aria-labelledby="reviews-heading"><div class="section-heading"><div><p class="eyebrow">Decision queue</p><h2 id="reviews-heading">Reviews</h2></div><p>${proposals.length} item${proposals.length === 1 ? "" : "s"}</p></div>${empty}</section>${calibrationSection}<section id="settings" class="quiet-section" aria-labelledby="settings-heading"><h2 id="settings-heading">Connections and access</h2><p>Secrets are kept outside household files and are never shown in proposal evidence or Agent traces.</p></section></main>`;
}

export function renderHomeAdvice(advice: InboxHomeAdviceRecord): string {
  const header = `<header><a class="back-link" href="/proposals#advice">← Back to household questions</a><p class="eyebrow">Agent-authored guidance</p><h1>${escapeHtml(advice.question)}</h1><p class="muted">This answer cannot control a device, change a rule, or grant authority.</p></header>`;
  if (advice.status === "running") return `<main id="main-content" class="advice-detail">${header}<section><h2>Answer in progress</h2><p>The Agent is inspecting bounded household evidence.</p></section></main>`;
  if (advice.status === "failed") return `<main id="main-content" class="advice-detail">${header}<section><h2>No answer was produced</h2><p>The request failed safely without storing provider error details.</p></section></main>`;
  const report = advice.report;
  const findings = report.findings.length === 0 ? "<p>No supported findings were reported.</p>" : `<ul>${report.findings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  const unknowns = report.unknowns.length === 0 ? "<p>No additional unknowns were reported.</p>" : `<ul>${report.unknowns.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  const trial = report.trial === undefined ? "<p>No trial was suggested.</p>" : `<div class="advice-trial"><p>${escapeHtml(report.trial.description)}</p><p><strong>Duration:</strong> ${report.trial.durationDays} days</p><h3>Success criteria</h3><ul>${report.trial.successCriteria.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul><p><strong>Rollback:</strong> ${escapeHtml(report.trial.rollback)}</p></div>`;
  const hardware = report.hardwareSuggestions.length === 0
    ? "<p>No additional hardware is currently suggested.</p>"
    : `<ol class="hardware-suggestions">${report.hardwareSuggestions.map((item) => `<li><h3>${escapeHtml(hardwareCapabilityLabel(item.capability))} sensing · ${escapeHtml(item.necessity)}</h3><p>${escapeHtml(item.reason)}</p>${item.placement === undefined ? "" : `<p><strong>Placement:</strong> ${escapeHtml(item.placement)}</p>`}<p><strong>Privacy impact:</strong> ${escapeHtml(item.privacyImpact)}</p><p class="no-purchase-alternative"><strong>No-purchase alternative:</strong> ${escapeHtml(item.alternative)}</p></li>`).join("")}</ol>`;
  const validation = report.validationSteps.length === 0 ? "<p>No validation steps were reported.</p>" : `<ol>${report.validationSteps.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>`;
  return `<main id="main-content" class="advice-detail">${header}<section class="advice-answer"><p class="eyebrow">Confidence: ${escapeHtml(report.confidence)}</p><h2>Answer</h2><p>${escapeHtml(report.summary)}</p></section><section><h2>What the Agent found</h2>${findings}</section><section><h2>What remains unknown</h2>${unknowns}</section><section><h2>Suggested trial</h2>${trial}</section><section><h2>Would more sensing help?</h2>${hardware}</section><section><h2>How to validate</h2>${validation}</section></main>`;
}

function hardwareCapabilityLabel(value: string): string {
  return `${value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase())}`;
}

function renderCalibrationSummary(summary: InboxCalibrationSummary): string {
  const proposal = summary.proposals;
  const feedback = (Object.entries(proposal.feedback) as [InboxReviewFeedbackCode, number][])
    .filter(([, count]) => count > 0)
    .map(([code, count]) => `<dt>${escapeHtml(feedbackLabel(code))}</dt><dd>${count}</dd>`)
    .join("");
  const observation = summary.observations;
  const outcomes = observation === undefined ? "" : (Object.entries(observation.outcomes) as [NonNullable<InboxObservationStatus["lastAttempt"]>["outcome"], number][])
    .filter(([, count]) => count > 0)
    .map(([outcome, count]) => `<dt>${escapeHtml(observationAggregateOutcomeLabel(outcome))}</dt><dd>${count}</dd>`)
    .join("");
  const dispositions = observation === undefined ? "" : (Object.entries(observation.dispositions) as [InboxObservationDisposition, number][])
    .filter(([, count]) => count > 0)
    .map(([disposition, count]) => `<dt>${escapeHtml(observationDispositionLabel(disposition))}</dt><dd>${count}</dd>`)
    .join("");
  const observationSummary = observation === undefined ? "" : `<h3>Observations</h3><dl>
    <dt>Total attempts</dt><dd>${observation.totalAttempts}</dd>
    <dt>Completed</dt><dd>${observation.completedAttempts}</dd>
    <dt>Interrupted</dt><dd>${observation.interruptedAttempts}</dd>
    <dt>Running</dt><dd>${observation.runningAttempts}</dd>
    ${outcomes}
    ${dispositions}
    <dt>No-proposal disposition not reported</dt><dd>${observation.noProposalWithoutDisposition}</dd>
    <dt>Measured attempts</dt><dd>${observation.measuredAttempts}</dd>
    <dt>Cumulative model tokens</dt><dd>${observation.metrics.inputTokens} input / ${observation.metrics.outputTokens} output / ${observation.metrics.reasoningTokens} reasoning tokens</dd>
    <dt>Cumulative tools</dt><dd>${observation.metrics.toolCalls} tool calls / ${observation.metrics.failedToolCalls} failed</dd>
    <dt>Cumulative turn duration</dt><dd>${observation.metrics.durationMs} ms</dd>
  </dl>`;
  return `<summary>Household calibration</summary><div aria-label="Household calibration"><p>All local records · descriptive only</p>
    <h3>Proposals</h3><dl>
      <dt>Total</dt><dd>${proposal.total}</dd>
      <dt>Pending review</dt><dd>${proposal.statuses.pending_review}</dd>
      <dt>Approved</dt><dd>${proposal.statuses.approved}</dd>
      <dt>Rejected</dt><dd>${proposal.statuses.rejected}</dd>
      <dt>Expired</dt><dd>${proposal.statuses.expired}</dd>
      ${feedback}
      <dt>Legacy review without feedback</dt><dd>${proposal.reviewedWithoutFeedback}</dd>
    </dl>${observationSummary}</div>`;
}

function observationAttemptLabel(attempt: InboxObservationAttempt): string {
  if (attempt.status === "running") return "running";
  if (attempt.status === "interrupted") return "interrupted safely";
  return escapeHtml(observationOutcomeLabel(attempt.outcome, attempt.disposition));
}

function observationMetricsLabel(metrics: InboxObservationMetrics | undefined): string {
  if (metrics === undefined) return "";
  const failed = metrics.failedToolCalls === 0 ? "" : ` · ${metrics.failedToolCalls} failed`;
  return ` · ${metrics.toolCalls} tools${failed} · ${metrics.inputTokens} input / ${metrics.outputTokens} output / ${metrics.reasoningTokens} reasoning tokens · ${metrics.durationMs} ms`;
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
  const rationale = proposal.rationale === undefined
    ? "<section class=\"agent-authored\" aria-label=\"Agent proposal rationale\"><h2>Why this may help</h2><p>Agent reasoning was not recorded for this legacy proposal.</p></section>"
    : `<section class="agent-authored" aria-label="Agent proposal rationale"><p class="eyebrow">Agent-authored</p><h2>Why this may help</h2><p>These model-authored statements explain the Agent's case; they do not replace Hub evidence or household judgment.</p><h3>Expected household value</h3><p>${escapeHtml(proposal.rationale.householdValue)}</p><h3>Why now</h3><p>${escapeHtml(proposal.rationale.whyNow)}</p><h3>Agent-declared uncertainties</h3><ul class="uncertainty-list">${proposal.rationale.uncertainties.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`;
  const spaceCoverage = proposal.spaceCoverage === undefined
    ? "<section aria-label=\"Selected-device space coverage\"><h2>Selected-device space coverage</h2><p>Not recorded in this legacy proposal.</p></section>"
    : `<section aria-label="Selected-device space coverage"><h2>Selected-device space coverage</h2><p>Hub-produced mapping coverage; this is separate from the Agent's rationale.</p><dl><dt>Selected devices</dt><dd>${proposal.spaceCoverage.selectedDevices}</dd><dt>Single-space suggestions</dt><dd>${proposal.spaceCoverage.devicesWithSingleSpace}</dd><dt>Unassigned</dt><dd>${proposal.spaceCoverage.devicesWithoutSpace}</dd><dt>Multiple spaces</dt><dd>${proposal.spaceCoverage.devicesWithMultipleSpaces}</dd></dl></section>`;
  const review = proposal.status === "pending_review" ? `<section class="review-boundary" aria-label="Household review"><p>Approval records intent only</p><p>Approving tells the Agent this idea fits your household. It does not install automation or control a device.</p><div class="review-forms"><form method="post" action="/proposals/${encodeURIComponent(proposal.id)}/review">
    <input type="hidden" name="expectedRevision" value="${proposal.revision}">
    <input type="hidden" name="feedbackCode" value="useful_as_is">
    <p>Why does this match your household? Approve only when it is useful as-is.</p>
    <label>Approval note <textarea name="note" maxlength="1000"></textarea></label>
    <button type="submit" name="decision" value="approved">Approve idea</button>
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
    <button class="reject-button" type="submit" name="decision" value="rejected">Reject</button>
  </form></div></section>` : `<section class="review-decision" aria-label="Household review"><h2>Household review</h2><p>Decision: ${escapeHtml(proposal.status)}</p>${proposal.review?.feedbackCode === undefined ? "" : `<p>Reason: ${escapeHtml(feedbackLabel(proposal.review.feedbackCode))}</p>`}${proposal.review?.note === undefined ? "" : `<p>Note: ${escapeHtml(proposal.review.note)}</p>`}</section>`;
  const timeline = detail.trace === undefined ? "" : `<details class="agent-details"><summary>How the Agent reached this</summary>${renderAgentLoopTimeline(detail.trace)}</details>`;
  const ledgerReferences = proposal.evidence.references.map((reference) => `<li class="ledger-item"><span class="ledger-marker" aria-hidden="true"></span><div><p><strong>${escapeHtml(reference.capabilityId ?? reference.hwId ?? reference.bridgeId)}</strong></p><p class="ledger-meta">${escapeHtml(reference.source ?? "legacy-reference")} · ${escapeHtml(reference.observedAt)}${reference.seq === undefined ? "" : ` · seq ${reference.seq}`}</p></div></li>`).join("");
  const ledgerCoverage = proposal.evidence.temporal?.coverage.map((coverage) => `<li class="ledger-item" data-coverage="${escapeHtml(coverage.status)}"><span class="ledger-marker" aria-hidden="true"></span><div><p><strong>${escapeHtml(coverage.bridgeId)}</strong> · ${escapeHtml(coverage.status)}</p><p class="ledger-meta">${coverage.reasons.length === 0 ? "No recorded coverage warnings" : coverage.reasons.map(escapeHtml).join(", ")}</p></div></li>`).join("") ?? "";
  return `<main id="main-content" class="proposal-detail review-desk" data-status="${escapeHtml(proposal.status)}">
    <header><a class="back-link" href="/proposals">← Back to reviews</a><p class="eyebrow">Household proposal</p><h1>${escapeHtml(proposal.title)}</h1><p>${escapeHtml(proposal.summary)}</p><div class="status-line"><span class="status-chip">Risk: ${escapeHtml(proposal.risk.level)}</span><span class="muted">Updated ${escapeHtml(proposal.updatedAt)}</span></div></header>
    <div class="review-columns"><div class="proposal-case">${rationale}
    <section aria-label="Intent"><h2>Intended change</h2><p>${escapeHtml(proposal.intent.description)}</p><h3>Rollback</h3><p>${escapeHtml(proposal.intent.rollback)}</p></section>
    <section aria-label="Dry run"><h2>Dry run: ${escapeHtml(proposal.dryRun.status)}</h2><p>${escapeHtml(proposal.dryRun.summary)}</p></section>
    <section aria-label="Risk"><h2>Risk: ${escapeHtml(proposal.risk.level)}</h2><ul class="risk-list">${risks}</ul></section>
    ${review}</div><aside class="evidence-ledger" aria-label="Evidence from your home"><h2>Evidence from your home</h2><p>${proposal.evidence.references.length} bounded references from the Hub</p><ul class="ledger-list">${ledgerReferences}${ledgerCoverage}</ul>
    <section aria-label="Evidence"><h3>Coverage details</h3>${temporalCoverage}<h3>Bridge watermarks</h3><ul>${watermarks}</ul></section>
    ${spaceCoverage}
    <section aria-label="Existing-rule overlap screen"><h2>Existing-rule overlap screen</h2><p>${proposal.conflictCheck.existingAutomationCount} existing automations · ${proposal.conflictCheck.matches.length} possible name overlaps</p><p>Metadata-only overlap screen; zero matches does not prove non-interference. Review existing rule logic before implementation.</p></section>
    ${timeline}</aside></div>
  </main>`;
}

function observationOutcomeLabel(
  outcome: NonNullable<InboxObservationStatus["lastAttempt"]>["outcome"],
  disposition?: InboxObservationDisposition,
): string {
  switch (outcome) {
    case "proposal_created": return "proposal created";
    case "no_proposal": return disposition === undefined
      ? "no proposal · Agent disposition not reported"
      : `no proposal · Agent reported: ${observationDispositionLabel(disposition)}`;
    case "world_not_ready": return "home not ready";
    case "proposal_pending": return "review already pending";
    case "agent_busy": return "agent busy";
    case "failed": return "failed safely";
  }
}

function observationDispositionLabel(disposition: InboxObservationDisposition): string {
  switch (disposition) {
    case "no_material_value": return "no material household value";
    case "insufficient_evidence": return "insufficient evidence";
    case "existing_rule_overlap": return "existing rule overlap";
    case "mapping_uncertain": return "home mapping uncertain";
    case "other_uncertainty": return "other uncertainty";
  }
}

function observationAggregateOutcomeLabel(
  outcome: NonNullable<InboxObservationStatus["lastAttempt"]>["outcome"],
): string {
  switch (outcome) {
    case "proposal_created": return "Proposal created";
    case "no_proposal": return "No proposal";
    case "world_not_ready": return "Home not ready";
    case "proposal_pending": return "Review already pending";
    case "agent_busy": return "Agent busy";
    case "failed": return "Failed safely";
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
