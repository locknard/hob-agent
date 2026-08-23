import {
  sliceAgentLoopTraceForTool,
  type AgentLoopTrace,
} from "@hob-agent/agent-layer/agent-loop-trace";


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
  readonly applicationStatus: "not_available" | "deploying" | "running" | "failed" | "withdrawn";
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly snoozeCount?: number;
  readonly snoozedUntil?: string;
  readonly newEvidence?: boolean;
  readonly lifecycle?: "preparing" | "needs_info" | "ready" | "enabling" | "active" | "paused" | "closed" | "enable_failed";
  readonly actionPolicyClasses?: readonly ("direct" | "confirmation")[];
  readonly confirmationDeviceNames?: readonly string[];
  /** The world no longer allows this prepared plan to enable; the card says so. */
  readonly enableBlockedReason?: string;
  readonly enableBlockedKind?: "not_configured" | "not_approved" | "unknown_capability" | "protected";
  readonly trial?: {
    readonly durationDays: 7;
    readonly startedAt: string;
    readonly endsAt: string;
  };
  readonly enablement?: {
    readonly enabledAt: string;
    readonly reviewer: string;
    readonly note?: string;
  };
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

/**
 * Household-facing availability for a new advice question.
 *
 * The web surface deliberately receives a closed state rather than a boolean:
 * each expected condition needs a useful explanation and a next action. The
 * HTTP/service layer may retain richer diagnostics, but they must not cross
 * this boundary into everyday household copy.
 */
export type InboxAdviceAvailability =
  | { readonly status: "ready" }
  | { readonly status: "setup_required"; readonly actionHref?: string }
  | { readonly status: "home_connecting"; readonly actionHref?: string }
  | { readonly status: "model_unavailable"; readonly actionHref?: string }
  | { readonly status: "agent_busy"; readonly activeAdviceId?: string }
  | { readonly status: "active_request"; readonly activeAdviceId: string }
  | { readonly status: "stopped"; readonly actionHref?: string };

export type InboxHomeAdviceRecord = {
  readonly id: string;
  readonly question: string;
  readonly createdAt: string;
} & (
  | { readonly status: "running" }
  | { readonly status: "background"; readonly backgroundAt: string }
  | { readonly status: "failed"; readonly completedAt: string; readonly backgroundAt?: string }
  | {
      readonly status: "completed";
      readonly completedAt: string;
      readonly backgroundAt?: string;
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
  list(query?: { status?: InboxProposalStatus; limit?: number; visibleOnly?: boolean }): readonly InboxProposal[];
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
