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

export type InboxArtifactScalar = string | number | boolean | null;
export type InboxArtifactValueOperator = "equals" | "not_equals" | "greater_than" | "less_than";

export interface InboxArtifactCapabilityReference {
  readonly hwCapabilityId: string;
}

export type InboxArtifactTrigger =
  | {
      readonly kind: "schedule";
      readonly timezone: string;
      readonly daysOfWeek: readonly number[];
      readonly at: string;
    }
  | {
      readonly kind: "capability_changed";
      readonly source: InboxArtifactCapabilityReference;
    };

export interface InboxArtifactCondition {
  readonly kind: "capability_value";
  readonly source: InboxArtifactCapabilityReference;
  readonly operator: InboxArtifactValueOperator;
  readonly value: InboxArtifactScalar;
}

export type InboxArtifactAction =
  | {
      readonly kind: "set_level";
      readonly target: InboxArtifactCapabilityReference;
      readonly value: number;
      readonly transitionSeconds?: number;
    }
  | {
      readonly kind: "set_boolean";
      readonly target: InboxArtifactCapabilityReference;
      readonly value: boolean;
    }
  | {
      readonly kind: "notify_local";
      readonly message: string;
    };

export type InboxArtifactRollback =
  | {
      readonly kind: "restore_previous_state";
      readonly target: InboxArtifactCapabilityReference;
      readonly maxAgeSeconds: number;
    }
  | { readonly kind: "no_remote_change" };

export interface InboxArtifactPostcondition {
  readonly kind: "capability_value";
  readonly source: InboxArtifactCapabilityReference;
  readonly operator: InboxArtifactValueOperator;
  readonly value: InboxArtifactScalar;
  readonly withinSeconds: number;
}

export interface InboxArtifactContent {
  readonly trigger: InboxArtifactTrigger;
  readonly conditions: readonly InboxArtifactCondition[];
  readonly actions: readonly InboxArtifactAction[];
  readonly rollback: InboxArtifactRollback;
  readonly postconditions: readonly InboxArtifactPostcondition[];
}

/** Structural seam for the persisted, optional neutral behavior candidate. */
export interface InboxArtifactCandidate {
  readonly schemaVersion: "1";
  readonly content: InboxArtifactContent;
}

/**
 * Inbox-owned structural projection of the Hub's read-only artifact check.
 *
 * Keep this seam deliberately independent from the Hub compiler contracts:
 * no plan, native binding, provider payload, or execution input crosses into
 * the review surface.
 */
export interface InboxArtifactReviewRef {
  readonly artifactId: string;
  readonly revision: number;
  readonly contentHash: string;
}

export interface InboxArtifactReviewWatermark {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly lastSeq: number;
  readonly freshness: string;
  readonly gapCount: number;
}

export type InboxArtifactReviewDiffOperation =
  | {
      readonly actionOrder: number;
      readonly kind: "set_level" | "set_boolean";
      readonly hwCapabilityId: string;
      readonly actionAuthorityCandidateId: string;
      readonly before?: InboxArtifactScalar;
      readonly after?: InboxArtifactScalar;
    }
  | {
      readonly actionOrder: number;
      readonly kind: "notify_local";
      readonly after?: InboxArtifactScalar;
    };

export interface InboxArtifactReviewDiff {
  readonly status: "no_change" | "changes" | "unavailable";
  readonly operations: readonly InboxArtifactReviewDiffOperation[];
  readonly unchangedCount: number;
  readonly redacted: true;
}

export type InboxArtifactReviewConflictStatus = "none" | "duplicate" | "possible_overlap" | "unavailable";

export interface InboxArtifactReviewConflictFinding {
  readonly kind: "existing_artifact" | "foreign_rule" | "stale_evidence" | "authority_unavailable" | "target_invalid" | "policy_blocked";
  readonly severity: "blocking" | "warning";
  readonly hwCapabilityId?: string;
  readonly reference?: string;
  readonly reason: string;
}

export interface InboxArtifactReviewConflicts {
  readonly status: InboxArtifactReviewConflictStatus;
  readonly findings: readonly InboxArtifactReviewConflictFinding[];
}

export interface InboxArtifactReviewActionAuthorityBinding {
  readonly actionOrder: number;
  readonly kind: "set_level" | "set_boolean";
  readonly hwCapabilityId: string;
  readonly actionAuthorityCandidateId: string;
}

export interface InboxArtifactReviewCompiler {
  readonly id: string;
  readonly version: string;
}

export type InboxArtifactCompileReview =
  | { readonly status: "not_run" }
  | {
      readonly status: "compiled" | "rejected" | "unavailable";
      readonly resultId?: string;
      readonly inputIdentity?: string;
      readonly compiler?: InboxArtifactReviewCompiler;
      readonly usedWatermarks: readonly InboxArtifactReviewWatermark[];
      readonly actionAuthorityBindings: readonly InboxArtifactReviewActionAuthorityBinding[];
      readonly blockingReasons: readonly string[];
      readonly diff: InboxArtifactReviewDiff;
      readonly conflicts: InboxArtifactReviewConflicts;
    };

export type InboxArtifactDryRunReview =
  | { readonly status: "not_run"; readonly writesPerformed: false }
  | {
      readonly status: "passed" | "failed" | "unavailable";
      readonly resultId?: string;
      readonly inputIdentity?: string;
      readonly compileAttestationId?: string;
      readonly compileInputIdentity?: string;
      readonly compiler?: InboxArtifactReviewCompiler;
      readonly checkedWatermarks: readonly InboxArtifactReviewWatermark[];
      readonly actionAuthorityBindings: readonly InboxArtifactReviewActionAuthorityBinding[];
      readonly diff: InboxArtifactReviewDiff;
      readonly conflicts: InboxArtifactReviewConflicts;
      readonly writesPerformed: false;
      readonly summary?: string;
    };

/** Read-only, exact proposal-scoped review projection owned by Inbox. */
export interface InboxArtifactReviewSnapshot {
  readonly artifact: InboxArtifactReviewRef;
  readonly compile: InboxArtifactCompileReview;
  readonly dryRun: InboxArtifactDryRunReview;
  readonly writesPerformed: false;
}

export type InboxPreparationStage = "artifact" | "evidence" | "authority" | "risk" | "compile" | "dry-run";
export type InboxPreparationErrorCode = "not_found" | "unavailable" | "malformed_dependency" | "policy_blocked" | "persistence_failed" | "attempt_exhausted";

export interface InboxPreparationStatus {
  readonly status: "queued" | "running" | "succeeded" | "failed";
  readonly attempt?: number;
  readonly version?: number;
  readonly stage?: InboxPreparationStage;
  readonly code?: InboxPreparationErrorCode;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly canRetry?: boolean;
}

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
  readonly artifactCandidate?: InboxArtifactCandidate;
  readonly artifactReview?: InboxArtifactReviewSnapshot;
  readonly preparationStatus?: InboxPreparationStatus;
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
  readonly preparationStatus?: InboxPreparationStatus;
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
    ${proposal.preparationStatus === undefined ? "" : `<p>${renderPreparationStatusLine(proposal.preparationStatus)}</p>`}
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

export function renderProposalDetail(detail: InboxProposalDetail, canRetryPreparation = false): string {
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
  const artifactCandidate = proposal.artifactCandidate === undefined
    ? "<section class=\"artifact-candidate legacy-candidate\" aria-label=\"Automation candidate\"><h2>Proposed behavior</h2><p>No exact neutral behavior candidate is recorded for this legacy proposal.</p></section>"
    : renderArtifactCandidate(proposal.artifactCandidate);
  const artifactReview = proposal.artifactReview === undefined ? "" : renderArtifactReview(proposal.artifactReview);
  const preparation = proposal.preparationStatus === undefined
    ? ""
    : renderPreparationStatus(proposal, canRetryPreparation);
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
    <div class="review-columns"><div class="proposal-case">${rationale}${artifactCandidate}${preparation}${artifactReview}
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

function renderPreparationStatusLine(status: InboxPreparationStatus): string {
  const failure = status.status === "failed" && status.stage !== undefined && status.code !== undefined
    ? ` · ${escapeHtml(status.stage)} · ${escapeHtml(status.code)}`
    : "";
  return `Preparation: ${escapeHtml(status.status)}${failure}`;
}

function renderPreparationStatus(proposal: InboxProposal, canRetry: boolean): string {
  const status = proposal.preparationStatus!;
  const description = preparationDescription(status);
  const retry = (canRetry || status.canRetry === true)
    && status.status === "failed"
    && status.attempt !== undefined
    && status.attempt < 5
    && status.version !== undefined
    ? `<form method="post" action="/proposals/${encodeURIComponent(proposal.id)}/preparation/retry"><input type="hidden" name="expectedRevision" value="${proposal.revision}"><input type="hidden" name="expectedVersion" value="${status.version}"><button type="submit">Retry preparation</button></form><p>This retries read-only preparation only; it does not execute or install anything.</p>`
    : status.status === "failed" && status.attempt === 5
      ? "<p>The retry limit has been reached. Create a new household-reviewed proposal for another attempt.</p>"
      : "";
  return `<section class="preparation-status" aria-label="Preparation status"><p class="eyebrow">Preparation</p><h2>Preparation: ${escapeHtml(status.status)}</h2><p>${renderPreparationStatusLine(status)}</p><p>${description}</p>${retry}</section>`;
}

function preparationDescription(status: InboxPreparationStatus): string {
  switch (status.status) {
    case "queued": return "Preparation is queued; it has not run yet.";
    case "running": return "Preparation is in progress. It cannot control a device or install automation.";
    case "succeeded": return "The read-only review checks are ready. Nothing was installed or enabled.";
    case "failed": return `Preparation stopped safely${status.stage === undefined ? "" : ` at ${escapeHtml(status.stage)}`}; no household or device change was made.`;
  }
}

function renderArtifactCandidate(candidate: InboxArtifactCandidate): string {
  const { content } = candidate;
  const conditions = content.conditions.length === 0
    ? "<p>No additional conditions; the trigger alone starts this candidate.</p>"
    : `<p>All conditions must be true.</p><ol>${content.conditions.map((condition) => `<li>${renderArtifactCondition(condition)}</li>`).join("")}</ol>`;
  const actions = `<ol>${content.actions.map((action) => `<li>${renderArtifactAction(action)}</li>`).join("")}</ol>`;
  const rollback = renderArtifactRollback(content.rollback);
  const postconditions = content.postconditions.length === 0
    ? "<p>No additional result is required.</p>"
    : `<ol>${content.postconditions.map((postcondition) => `<li>${renderArtifactPostcondition(postcondition)}</li>`).join("")}</ol>`;

  return `<section class="artifact-candidate" aria-label="Automation candidate"><p class="eyebrow">Unverified automation candidate</p><h2>Proposed behavior</h2><p>Approval records this reviewed intent only. This candidate cannot install, enable, or execute anything.</p><h3>When it runs</h3><p>${renderArtifactTrigger(content.trigger)}</p><h3>When all conditions are met</h3>${conditions}<h3>What would happen</h3>${actions}<h3>How it could be undone</h3><p>${rollback}</p><h3>What should be true afterward</h3>${postconditions}</section>`;
}

function renderArtifactReview(review: InboxArtifactReviewSnapshot): string {
  const compile = review.compile;
  const dryRun = review.dryRun;
  const compileConflict = compile.status === "not_run"
    ? "Not run; no conflict-free conclusion is available."
    : renderArtifactReviewConflictSummary(compile.conflicts);
  const dryRunConflict = dryRun.status === "not_run"
    ? "Not run; no conflict-free conclusion is available."
    : renderArtifactReviewConflictSummary(dryRun.conflicts);
  const compileDiff = compile.status === "not_run"
    ? "Not run; no diff is available."
    : renderArtifactReviewDiffSummary(compile.diff);
  const dryRunDiff = dryRun.status === "not_run"
    ? "Not run; no diff is available."
    : renderArtifactReviewDiffSummary(dryRun.diff);
  const compileDescription = artifactCompileStatusDescription(compile.status);
  const dryRunDescription = artifactDryRunStatusDescription(dryRun.status);

  return `<section class="artifact-review" aria-labelledby="artifact-review-heading"><p class="eyebrow">Read-only check</p><h2 id="artifact-review-heading">Read-only automation check</h2><p>This check only reviews a neutral candidate for this proposal revision. It cannot install, enable, apply, or execute anything.</p><table class="artifact-review-status"><caption>Read-only automation check status</caption><thead><tr><th scope="col">Check</th><th scope="col">Status</th><th scope="col">What this means at home</th></tr></thead><tbody><tr><th scope="row">Household-language compilation</th><td>${artifactReviewStatusChip(compile.status, artifactCompileStatusLabel(compile.status))}</td><td>${compileDescription}</td></tr><tr><th scope="row">Read-only dry run</th><td>${artifactReviewStatusChip(dryRun.status, artifactDryRunStatusLabel(dryRun.status))}</td><td>${dryRunDescription}</td></tr></tbody></table><p class="no-household-writes"><strong>No household changes were made.</strong> This review is read-only; <code>writesPerformed: false</code>.</p><section class="artifact-review-summary" aria-labelledby="artifact-review-findings-heading"><h3 id="artifact-review-findings-heading">What the check found</h3><dl><dt>Compilation diff</dt><dd>${compileDiff}</dd><dt>Compilation conflicts</dt><dd>${compileConflict}</dd><dt>Dry-run diff</dt><dd>${dryRunDiff}</dd><dt>Dry-run conflicts</dt><dd>${dryRunConflict}</dd></dl></section>${renderArtifactReviewDiagnostics(review)}</section>`;
}

function artifactReviewStatusChip(status: string, label: string): string {
  return `<span class="status-chip" data-status="${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function artifactCompileStatusLabel(status: InboxArtifactCompileReview["status"]): string {
  switch (status) {
    case "not_run": return "Not run";
    case "compiled": return "Compiled";
    case "rejected": return "Rejected";
    case "unavailable": return "Unavailable";
  }
}

function artifactCompileStatusDescription(status: InboxArtifactCompileReview["status"]): string {
  switch (status) {
    case "not_run": return "No exact compile result is recorded for this proposal revision.";
    case "compiled": return "The neutral behavior was prepared for household review.";
    case "rejected": return "The candidate did not pass the neutral review checks.";
    case "unavailable": return "The check lacked trustworthy information to prepare a review.";
  }
}

function artifactDryRunStatusLabel(status: InboxArtifactDryRunReview["status"]): string {
  switch (status) {
    case "passed": return "Passed";
    case "failed": return "Failed";
    case "unavailable": return "Unavailable";
    case "not_run": return "Not run";
  }
}

function artifactDryRunStatusDescription(status: InboxArtifactDryRunReview["status"]): string {
  switch (status) {
    case "passed": return "The read-only simulation completed for this exact review input.";
    case "failed": return "The read-only simulation found a blocking problem for this input.";
    case "unavailable": return "The read-only simulation could not use a complete, trustworthy input.";
    case "not_run": return "No exact dry-run result is recorded for this proposal revision.";
  }
}

function artifactReviewDiffStatusLabel(status: InboxArtifactReviewDiff["status"]): string {
  switch (status) {
    case "no_change": return "No change";
    case "changes": return "Changes";
    case "unavailable": return "Unavailable";
  }
}

function renderArtifactReviewDiffSummary(diff: InboxArtifactReviewDiff): string {
  switch (diff.status) {
    case "no_change":
      return `No change is reported by this read-only diff; ${diff.unchangedCount} action${diff.unchangedCount === 1 ? "" : "s"} remain unchanged.`;
    case "changes":
      return `${diff.operations.length} neutral change${diff.operations.length === 1 ? "" : "s"} is recorded; ${diff.unchangedCount} action${diff.unchangedCount === 1 ? "" : "s"} remain unchanged.`;
    case "unavailable":
      return "The diff is unavailable; no change is assumed.";
  }
}

function renderArtifactReviewConflictSummary(conflicts: InboxArtifactReviewConflicts): string {
  const findingCount = conflicts.findings.length;
  switch (conflicts.status) {
    case "none":
      return "No conflicts were recorded for this check; this does not prove non-interference.";
    case "duplicate":
      return `Duplicate conflict found (${findingCount} finding${findingCount === 1 ? "" : "s"}); review is not clear.`;
    case "possible_overlap":
      return `Possible overlap found (${findingCount} finding${findingCount === 1 ? "" : "s"}); this does not prove non-interference.`;
    case "unavailable":
      return "Conflict check unavailable; no conflict-free conclusion is available.";
  }
}

function renderArtifactReviewDiagnostics(review: InboxArtifactReviewSnapshot): string {
  const compile = review.compile;
  const dryRun = review.dryRun;
  const compileDiagnostics = compile.status === "not_run"
    ? "<p>Status: <code>not_run</code>; no exact compile row is recorded.</p>"
    : `<dl><dt>Status</dt><dd><code>${escapeHtml(compile.status)}</code></dd>${diagnosticValue("Result identity", compile.resultId)}${diagnosticValue("Input identity", compile.inputIdentity)}${compile.compiler === undefined ? "" : `<dt>Compiler</dt><dd><code class="diagnostic-id">${escapeHtml(compile.compiler.id)}</code> · version <code>${escapeHtml(compile.compiler.version)}</code></dd>`}</dl>${renderArtifactReviewWatermarks(compile.usedWatermarks)}${renderArtifactReviewBlockingReasons(compile.blockingReasons)}${renderArtifactReviewBindings(compile.actionAuthorityBindings ?? [])}${renderArtifactReviewDiffDiagnostics("Compilation diff", compile.diff)}${renderArtifactReviewConflictDiagnostics("Compilation conflicts", compile.conflicts)}`;
  const dryRunDiagnostics = dryRun.status === "not_run"
    ? `<section aria-labelledby="dry-run-diagnostics-heading"><h3 id="dry-run-diagnostics-heading">Dry-run result</h3><p>Status: <code>not_run</code></p><p>Exact artifact: <code class="diagnostic-id">${escapeHtml(review.artifact.artifactId)}</code> · revision ${review.artifact.revision} · hash <code class="diagnostic-id">${escapeHtml(review.artifact.contentHash)}</code></p></section>`
    : `<section aria-labelledby="dry-run-diagnostics-heading"><h3 id="dry-run-diagnostics-heading">Dry-run result</h3><dl><dt>Status</dt><dd><code>${escapeHtml(dryRun.status)}</code></dd>${diagnosticValue("Result identity", dryRun.resultId)}${diagnosticValue("Input identity", dryRun.inputIdentity)}${diagnosticValue("Compile result identity", dryRun.compileAttestationId)}${dryRun.compiler === undefined ? "" : `<dt>Compiler</dt><dd><code class="diagnostic-id">${escapeHtml(dryRun.compiler.id)}</code> · version <code>${escapeHtml(dryRun.compiler.version)}</code></dd>`}<dt>writesPerformed</dt><dd><code>false</code></dd></dl>${renderArtifactReviewWatermarks(dryRun.checkedWatermarks)}${renderArtifactReviewBindings(dryRun.actionAuthorityBindings ?? [])}${renderArtifactReviewDiffDiagnostics("Dry-run diff", dryRun.diff)}${renderArtifactReviewConflictDiagnostics("Dry-run conflicts", dryRun.conflicts)}</section>`;
  return `<details class="artifact-review-diagnostics"><summary>Technical diagnostics</summary><div class="artifact-review-diagnostics-body"><section aria-labelledby="artifact-diagnostics-heading"><h3 id="artifact-diagnostics-heading">Artifact identity</h3><dl><dt>Artifact ID</dt><dd><code class="diagnostic-id">${escapeHtml(review.artifact.artifactId)}</code></dd><dt>Artifact revision</dt><dd>${review.artifact.revision}</dd><dt>Content hash</dt><dd><code class="diagnostic-id">${escapeHtml(review.artifact.contentHash)}</code></dd></dl></section><section aria-labelledby="compile-diagnostics-heading"><h3 id="compile-diagnostics-heading">Compile result</h3>${compileDiagnostics}</section>${dryRunDiagnostics}</div></details>`;
}

function diagnosticValue(label: string, value: string | undefined): string {
  return value === undefined ? "" : `<dt>${escapeHtml(label)}</dt><dd><code class="diagnostic-id">${escapeHtml(value)}</code></dd>`;
}

function renderArtifactReviewWatermarks(watermarks: readonly InboxArtifactReviewWatermark[]): string {
  if (watermarks.length === 0) return "<p>No semantic watermarks were recorded.</p>";
  return `<h4>Semantic watermarks</h4><table class="artifact-review-watermarks"><caption>Semantic watermarks used by this read-only check</caption><thead><tr><th scope="col">Bridge</th><th scope="col">Epoch</th><th scope="col">Last sequence</th><th scope="col">Freshness</th><th scope="col">Gaps</th></tr></thead><tbody>${watermarks.map((watermark) => `<tr><th scope="row"><code class="diagnostic-id">${escapeHtml(watermark.bridgeId)}</code></th><td><code class="diagnostic-id">${escapeHtml(watermark.epochId)}</code></td><td>${watermark.lastSeq}</td><td>${escapeHtml(watermark.freshness)}</td><td>${watermark.gapCount}</td></tr>`).join("")}</tbody></table>`;
}

function renderArtifactReviewBlockingReasons(reasons: readonly string[]): string {
  if (reasons.length === 0) return "<p>Blocking reasons: none.</p>";
  return `<h4>Blocking reasons</h4><ul>${reasons.map((reason) => `<li><code>${escapeHtml(reason)}</code></li>`).join("")}</ul>`;
}

function renderArtifactReviewBindings(bindings: readonly InboxArtifactReviewActionAuthorityBinding[]): string {
  if (bindings.length === 0) return "<p>No opaque action authority candidates were recorded.</p>";
  return `<h4>Action authority candidates</h4><table class="artifact-review-bindings"><caption>Opaque action authority candidates by artifact action order</caption><thead><tr><th scope="col">Action order</th><th scope="col">Kind</th><th scope="col">Capability</th><th scope="col">Candidate</th></tr></thead><tbody>${bindings.map((binding) => `<tr><th scope="row">actionOrder ${binding.actionOrder}</th><td><code>${escapeHtml(binding.kind)}</code></td><td><code class="diagnostic-id">${escapeHtml(binding.hwCapabilityId)}</code></td><td><code class="diagnostic-id">${escapeHtml(binding.actionAuthorityCandidateId)}</code></td></tr>`).join("")}</tbody></table>`;
}

function renderArtifactReviewDiffDiagnostics(heading: string, diff: InboxArtifactReviewDiff): string {
  const operations = diff.operations.length === 0
    ? "<p>No diff operations were recorded.</p>"
    : `<table class="artifact-review-diff"><caption>${escapeHtml(heading)} operations</caption><thead><tr><th scope="col">Action order</th><th scope="col">Kind</th><th scope="col">Capability</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Opaque candidate</th></tr></thead><tbody>${diff.operations.map(renderArtifactReviewDiffOperation).join("")}</tbody></table>`;
  return `<section aria-label="${escapeHtml(heading)}"><h4>${escapeHtml(heading)}</h4><p>Diff status: <code>${escapeHtml(diff.status)}</code> · ${artifactReviewDiffStatusLabel(diff.status)} · unchanged count ${diff.unchangedCount} · redacted <code>true</code></p>${operations}</section>`;
}

function renderArtifactReviewDiffOperation(operation: InboxArtifactReviewDiffOperation): string {
  const before = "before" in operation && operation.before !== undefined
    ? `<code>${formatArtifactScalar(operation.before)}</code>`
    : "absent";
  const after = operation.after === undefined ? "absent" : `<code>${formatArtifactScalar(operation.after)}</code>`;
  const capability = "hwCapabilityId" in operation
    ? `<code class="diagnostic-id">${escapeHtml(operation.hwCapabilityId)}</code>`
    : "not applicable";
  const candidate = "actionAuthorityCandidateId" in operation
    ? `<code class="diagnostic-id">${escapeHtml(operation.actionAuthorityCandidateId)}</code>`
    : "not applicable";
  return `<tr><th scope="row">actionOrder ${operation.actionOrder}</th><td><code>${escapeHtml(operation.kind)}</code></td><td>${capability}</td><td>${before}</td><td>${after}</td><td>${candidate}</td></tr>`;
}

function renderArtifactReviewConflictDiagnostics(heading: string, conflicts: InboxArtifactReviewConflicts): string {
  const findings = conflicts.findings.length === 0
    ? "<p>No findings were recorded for this conflict result.</p>"
    : `<ul>${conflicts.findings.map((finding) => `<li><code>${escapeHtml(finding.kind)}</code> · ${escapeHtml(finding.severity)} · reason <code>${escapeHtml(finding.reason)}</code>${finding.hwCapabilityId === undefined ? "" : ` · capability <code class="diagnostic-id">${escapeHtml(finding.hwCapabilityId)}</code>`}${finding.reference === undefined ? "" : ` · reference <code class="diagnostic-id">${escapeHtml(finding.reference)}</code>`}</li>`).join("")}</ul>`;
  return `<section aria-label="${escapeHtml(heading)}"><h4>${escapeHtml(heading)}</h4><p>Conflict status: <code>${escapeHtml(conflicts.status)}</code></p>${findings}</section>`;
}

function renderArtifactTrigger(trigger: InboxArtifactTrigger): string {
  if (trigger.kind === "schedule") {
    const days = trigger.daysOfWeek.map((day) => artifactDayLabel(day)).join(", ");
    return `At ${escapeHtml(trigger.at)} in ${escapeHtml(trigger.timezone)} on ${days}.`;
  }
  return `When capability ${escapeHtml(trigger.source.hwCapabilityId)} changes.`;
}

function renderArtifactCondition(condition: InboxArtifactCondition): string {
  return `Capability ${escapeHtml(condition.source.hwCapabilityId)} ${artifactOperatorLabel(condition.operator)} ${formatArtifactScalar(condition.value)}.`;
}

function renderArtifactAction(action: InboxArtifactAction): string {
  switch (action.kind) {
    case "set_level":
      return `Set capability ${escapeHtml(action.target.hwCapabilityId)} to ${formatArtifactScalar(action.value)}${action.transitionSeconds === undefined ? "" : ` over ${escapeHtml(String(action.transitionSeconds))} seconds`}.`;
    case "set_boolean":
      return `Set capability ${escapeHtml(action.target.hwCapabilityId)} to ${formatArtifactScalar(action.value)}.`;
    case "notify_local":
      return `Send a local notification: ${escapeHtml(action.message)}.`;
  }
}

function renderArtifactRollback(rollback: InboxArtifactRollback): string {
  if (rollback.kind === "no_remote_change") return "No remote change is made.";
  return `Restore the previous value of capability ${escapeHtml(rollback.target.hwCapabilityId)} within ${escapeHtml(String(rollback.maxAgeSeconds))} seconds.`;
}

function renderArtifactPostcondition(postcondition: InboxArtifactPostcondition): string {
  return `Capability ${escapeHtml(postcondition.source.hwCapabilityId)} should be ${artifactOperatorLabel(postcondition.operator)} ${formatArtifactScalar(postcondition.value)} within ${escapeHtml(String(postcondition.withinSeconds))} seconds.`;
}

function artifactOperatorLabel(operator: InboxArtifactValueOperator): string {
  switch (operator) {
    case "equals": return "is";
    case "not_equals": return "is not";
    case "greater_than": return "is greater than";
    case "less_than": return "is less than";
  }
}

function artifactDayLabel(day: number): string {
  switch (day) {
    case 0: return "Sunday";
    case 1: return "Monday";
    case 2: return "Tuesday";
    case 3: return "Wednesday";
    case 4: return "Thursday";
    case 5: return "Friday";
    case 6: return "Saturday";
    default: return `day ${escapeHtml(String(day))}`;
  }
}

function formatArtifactScalar(value: InboxArtifactScalar): string {
  if (value === null) return "nothing";
  return escapeHtml(String(value));
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
