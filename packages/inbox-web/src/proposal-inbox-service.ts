import { Context, Service } from "@deepseek-ai/cordis";

import {
  ProposalInboxController,
  type InboxProposal,
  type InboxProposalDetail,
  type InboxProposalStatus,
  type InboxProposalSummary,
  type InboxArtifactReviewActionAuthorityBinding,
  type InboxArtifactReviewConflictFinding,
  type InboxArtifactReviewConflicts,
  type InboxArtifactReviewDiff,
  type InboxArtifactReviewDiffOperation,
  type InboxArtifactReviewSnapshot,
  type InboxArtifactReviewWatermark,
  type InboxObservationStatus,
  type InboxObservationAttempt,
  type InboxReviewInput,
  type InboxProposalQualitySummary,
  type InboxPreparationStatus,
  type InboxObservationQualitySummary,
  type ProposalInboxPort,
  type ProposalTracePort,
  type InboxHomeAdviceRecord,
  type InboxAdviceAvailability,
} from "./proposal-inbox.js";
import type {
  ProductProposal,
  ProductRuntimeConfirmation,
  ProductShellConnection,
  ProductSpace,
  ProductControlSpace,
  ProductControlFeedback,
  ProductActivityRecord,
  ProductTurn,
  ProductTurnStage,
  ProductSafetyAlert,
  ProductAdviceCompletionNotification,
  ProductBatchActionResult,
  ProductBatchControl,
  ProductBatchPolicyClass,
} from "./product-shell.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeInbox: ProposalInboxService;
  }
}

export interface InboxPreparationRetryInput {
  readonly proposalId: string;
  readonly expectedRevision: number;
  readonly expectedVersion: number;
}

export interface ProposalInboxPreparationPort {
  retry(input: InboxPreparationRetryInput): void | Promise<void>;
}

interface ControlCenterArtifactSnapshot {
  readonly status: "ready" | "unavailable";
  readonly schemaVersion?: "1";
  readonly lifecycleStates: readonly ("draft" | "superseded")[];
  readonly hasRecords: boolean;
  readonly canCompile: false;
  readonly canSimulate: false;
  readonly canExecute: false;
}

interface ControlCenterArtifactSource {
  diagnostics(): ControlCenterArtifactSnapshot;
}

interface ArtifactReviewReadSnapshot extends InboxArtifactReviewSnapshot {
  readonly proposal: {
    readonly id: string;
    readonly revision: number;
  };
  readonly evidence?: {
    readonly watermarks: readonly {
      readonly bridgeId: string;
      readonly epochId: string;
      readonly lastSeq: number;
      readonly freshness: string;
      readonly gapCount: number;
    }[];
  };
}

/** Narrow structural seam for exact, read-only proposal artifact reviews. */
interface ArtifactReviewReadSource extends ControlCenterArtifactSource {
  reviewForProposal(proposalId: string, proposalRevision: number): ArtifactReviewReadSnapshot | undefined;
}

/** Neutral identity presented by the authenticated local review surface. */
export interface InboxReviewActor {
  readonly principalId: string;
  readonly role: "admin" | "adult_member" | "member" | "child" | "guest";
  readonly present: boolean;
  readonly device: {
    readonly kind: "private" | "shared";
    readonly boundPrincipalId?: string;
  };
}

export type InboxConversationCorrectionType = "household_fact" | "household_preference" | "future_behavior";

export interface InboxConversationCorrectionResult {
  readonly status: "updated" | "proposal_created";
  readonly correctionId: string;
  readonly adviceId: string;
  readonly correctionType: InboxConversationCorrectionType;
  readonly message: "已更新";
  readonly destination: string;
  readonly proposalId?: string;
  readonly proposalCount?: number;
}

/** Hub-owned completed-turn correction seam. The Inbox only transports typed intent. */
export interface ProposalInboxCorrectionPort {
  submit(input: {
    readonly adviceId: string;
    readonly actor: InboxReviewActor;
    readonly correctionType: InboxConversationCorrectionType;
    readonly correction: string;
    readonly idempotencyKey: string;
  }): Promise<InboxConversationCorrectionResult>;
  acknowledgementForAdvice?(adviceId: string, actorId: string): InboxConversationCorrectionResult | undefined;
}

export interface InboxRuntimeConfirmation {
  readonly id: string;
  readonly dedupKey: string;
  readonly actionSummary: string;
  readonly approvalLevel: "member" | "admin";
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly status: "pending" | "approved" | "rejected" | "expired";
  readonly decision?: {
    readonly kind: "approved" | "rejected" | "expired";
    readonly at: string;
    readonly actorId?: string;
  };
}

export interface InboxRuntimeDecisionRequest {
  readonly confirmationId: string;
  readonly actor: InboxReviewActor;
}

export type InboxRuntimeDecisionResult =
  | { readonly status: "approved" | "rejected"; readonly confirmation: InboxRuntimeConfirmation }
  | {
      readonly status: "denied";
      readonly reason: "unauthorized" | "expired" | "already_decided" | "not_found" | "unavailable";
      readonly confirmation?: InboxRuntimeConfirmation;
    };

/** Hub-owned runtime confirmation seam. No bridge or executor data crosses it. */
export interface ProposalInboxRuntimePort {
  listRuntimeConfirmations(): readonly InboxRuntimeConfirmation[];
  getRuntimeConfirmation?(id: string): InboxRuntimeConfirmation | undefined;
  canApproveRuntimeConfirmation(confirmationId: string, actor: InboxReviewActor): boolean;
  approveRuntimeConfirmation(request: InboxRuntimeDecisionRequest): Promise<InboxRuntimeDecisionResult>;
  rejectRuntimeConfirmation(request: InboxRuntimeDecisionRequest): Promise<InboxRuntimeDecisionResult>;
  snapshot?(): {
    readonly expiredRuntimeSummary?: {
      readonly count: number;
      readonly confirmationIds?: readonly string[];
    };
  };
  activities?(): readonly InboxRuntimeActivity[];
  requestAction?(input: InboxControlActionRequest): Promise<InboxOneShotActionResult>;
  /** Hub-owned explicit action contract; absent means the control stays read-only. */
  actionDescriptorFor?(capabilityId: string): InboxActionDescriptor | undefined;
  undoAction?(input: InboxControlUndoRequest): Promise<InboxOneShotActionResult>;
  listActionTickets?(): readonly InboxActionTicket[];
}

export type InboxOneShotAction =
  | { readonly kind: "set_boolean"; readonly value: boolean }
  | { readonly kind: "set_level"; readonly level: number }
  | { readonly kind: "play_media"; readonly mediaRef: string; readonly queueMode: "replace_and_play" | "play_next" | "add_to_queue" }
  | { readonly kind: "stop_media" };

/**
 * Hub-owned action description for one capability. The Inbox renders and
 * forwards this exact neutral action supplied by the Hub. Semantic hints and
 * display names remain presentation context.
 */
export interface InboxActionDescriptor {
  readonly action: InboxOneShotAction;
  readonly label?: string;
  readonly actionLabel?: string;
  readonly summary?: string;
  readonly value?: string;
  readonly reversible?: boolean;
  readonly policyClass?: ProductBatchPolicyClass;
}

export interface ProposalInboxBatchActionTarget {
  readonly capabilityId: string;
  readonly descriptor: InboxActionDescriptor & { readonly policyClass: ProductBatchPolicyClass };
}

export interface ProposalInboxBatchActionCommand {
  readonly requestId: string;
  readonly capabilityIds: readonly string[];
  readonly actor: InboxReviewActor;
  readonly targets: readonly ProposalInboxBatchActionTarget[];
}

export type ProposalInboxBatchActionResult = ProductBatchActionResult;

/** Hub-owned batch action seam. The Inbox forwards current descriptors and actor identity. */
export interface ProposalInboxBatchActionPort {
  submit(command: ProposalInboxBatchActionCommand): Promise<ProposalInboxBatchActionResult>;
}

export interface InboxControlActionRequest {
  readonly requestId: string;
  readonly capabilityId: string;
  readonly summary: string;
  readonly action: InboxOneShotAction;
  readonly actor: InboxReviewActor;
  readonly source?: "member" | "hob" | "system" | "external-rule" | "unknown";
}

export interface InboxControlUndoRequest {
  readonly ticketId: string;
  readonly actor: InboxReviewActor;
}

export type InboxControlActionStatus = "verified" | "pending_confirmation" | "failed" | "unknown";

export interface InboxActionTicket {
  readonly id: string;
  readonly capabilityId: string;
  readonly action: InboxOneShotAction;
  readonly summary?: string;
  readonly status: InboxControlActionStatus | string;
  readonly requestedAt?: string;
  readonly expiresAt?: string;
  readonly undoExpiresAt?: string;
  readonly undoStatus?: "available" | "pending" | "consumed" | "failed" | "expired";
  readonly resultReason?: string;
}

export interface InboxOneShotActionResult {
  readonly status: InboxControlActionStatus | string;
  readonly ticket: InboxActionTicket;
  readonly reason?: string;
  readonly undo?: {
    readonly status: "available";
    readonly ticketId: string;
    readonly expiresAt: string;
  };
}

export interface InboxControlRequest {
  readonly capabilityId: string;
  readonly actor: InboxReviewActor;
}

export interface InboxControlResult {
  readonly capabilityId: string;
  readonly ticketId?: string;
  readonly status: InboxControlActionStatus;
  readonly label: string;
  readonly detail: string;
  readonly expiresAt?: string;
  readonly expiresIn?: string;
  readonly undo?: {
    readonly ticketId: string;
    readonly expiresAt: string;
  };
}

export interface InboxRuntimeActivity {
  readonly id: string;
  readonly at: string;
  readonly title: string;
  readonly actor: string;
  readonly attribution: ProductActivityRecord["attribution"];
  readonly cause: readonly string[];
  readonly verification?: string;
}

/** Hub-owned safety incident seam. The Inbox only receives its neutral projection. */
export interface ProposalInboxSafetyPort {
  snapshot(): { readonly alerts: readonly ProductSafetyAlert[] };
  acknowledge(alertId: string, actorId: string): ProductSafetyAlert;
}

export type ProposalInboxSnoozeTarget = "tomorrow" | "weekend" | "next_week";

/** Proposal-owner commands used by the review surface. */
export interface ProposalInboxProposalGovernancePort {
  snoozeProposal?(input: { readonly proposalId: string; readonly until: ProposalInboxSnoozeTarget }): void | Promise<void>;
  decideProposal?(input: {
    readonly proposalId: string;
    readonly expectedRevision: number;
    readonly decision: "reject_once" | "do_not_suggest";
    readonly reviewer: string;
  }): void | Promise<void>;
  proposalCapacity?(): { readonly used: number; readonly max: number; readonly available: number };
  enableProposal?(input: {
    readonly proposalId: string;
    readonly expectedRevision: number;
    readonly reviewer: string;
  }): void | Promise<void>;
}

export interface InboxProductReviewProjection {
  readonly runtimeConfirmations: readonly ProductRuntimeConfirmation[];
  readonly proposals: readonly ProductProposal[];
  readonly selectedProposal?: ProductProposal;
  readonly proposalCapacityUsed: number;
  readonly proposalCapacity: number;
  readonly expiredSummary?: string;
}

export interface InboxProductShellProjection {
  readonly connection: ProductShellConnection;
  readonly spaces: readonly ProductSpace[];
  readonly controlSpaces: readonly ProductControlSpace[];
  readonly activity: readonly ProductActivityRecord[];
  readonly safetyAlerts?: readonly ProductSafetyAlert[];
  readonly completionNotification?: ProductAdviceCompletionNotification;
  readonly batchControl?: ProductBatchControl;
}

export interface ProposalInboxServiceOptions {
  readonly preparation?: ProposalInboxPreparationPort;
  readonly proposalGovernance?: ProposalInboxProposalGovernancePort;
  readonly now?: () => Date;
}

/** Local review composition over hub proposal state and metadata-safe DSH traces. */
export class ProposalInboxService extends Service {
  static inject = ["homeProposals"];

  private readonly controller: ProposalInboxController;
  private readonly proposals: ProposalInboxPort;
  private readonly runtime?: ProposalInboxRuntimePort;
  private readonly batchActions?: ProposalInboxBatchActionPort;
  private readonly safety?: ProposalInboxSafetyPort;
  private readonly correction?: ProposalInboxCorrectionPort;
  private readonly proposalGovernance?: ProposalInboxProposalGovernancePort;
  private readonly now: () => Date;
  private controlRequestSequence = 0;
  private batchRequestSequence = 0;
  private readonly batchResults = new Map<string, ProposalInboxBatchActionResult>();
  private readonly artifactReviewSource?: ArtifactReviewReadSource;
  private readonly preparationSource?: PreparationReadSource;
  private readonly preparation?: ProposalInboxPreparationPort;
  private readonly observation?: {
    snapshot(): InboxObservationStatus;
    observeNow(): Promise<string>;
  };
  private readonly world?: { snapshot(): unknown };
  private readonly proposalQuality: { qualitySummary(): InboxProposalQualitySummary };
  private readonly observationAudit?: {
    list(query: { limit: number }): readonly InboxObservationAttempt[];
    summary(): InboxObservationQualitySummary;
  };
  private readonly advice?: {
    canAsk(): boolean;
    availability?(): InboxAdviceAvailability;
    ask(question: string, actor?: InboxReviewActor): Promise<InboxHomeAdviceRecord>;
    events?(id: string, afterSeq?: number): readonly InboxAdviceProgressEvent[];
    subscribe?(id: string, listener: InboxAdviceProgressListener, afterSeq?: number): () => void;
    cancel?(id: string): boolean;
    background?(id: string): boolean;
    peekNextCompletionNotification?(): {
      readonly adviceId: string;
      readonly status: "completed" | "failed" | "cancelled";
      readonly completedAt: string;
      readonly eventId: number;
    } | undefined;
    acknowledgeCompletionNotification?(adviceId: string): boolean;
    list(query?: { limit?: number }): readonly InboxHomeAdviceRecord[];
    get(id: string): InboxHomeAdviceRecord | undefined;
  };

  constructor(ctx: Context, options: ProposalInboxServiceOptions = {}) {
    super(ctx, "homeInbox");
    const trace = ctx.get("homeAgent") as unknown as ProposalTracePort | undefined;
    const artifacts = ctx.get("homeArtifacts") as unknown as ControlCenterArtifactSource | undefined;
    this.artifactReviewSource = hasArtifactReviewReadSource(artifacts) ? artifacts : undefined;
    const proposals = ctx.homeProposals as unknown as ProposalInboxPort & Partial<PreparationReadSource>;
    this.proposals = proposals;
    const runtime = ctx.get("homeReviewCenter") as unknown as ProposalInboxRuntimePort | undefined;
    this.runtime = hasRuntimePort(runtime) ? runtime : undefined;
    const batchActions = ctx.get("homeBatchActions") as unknown;
    this.batchActions = hasBatchActionPort(batchActions) ? batchActions : undefined;
    this.safety = safetyPortFrom(ctx.get("homeSafety"));
    this.correction = correctionPortFrom(ctx.get("homeCorrection"));
    this.proposalGovernance = options.proposalGovernance
      ?? optionalGovernancePort(ctx.get("proposalGovernance") ?? ctx.get("proposal_governance"))
      ?? optionalGovernancePort(proposals);
    this.now = options.now ?? (() => new Date());
    this.preparation = options.preparation ?? preparationPortFrom(proposals);
    this.preparationSource = hasPreparationReadSource(proposals) ? proposals : undefined;
    this.controller = new ProposalInboxController({
      proposals,
      ...(trace === undefined ? {} : { traces: trace }),
    });
    this.proposalQuality = ctx.homeProposals as unknown as { qualitySummary(): InboxProposalQualitySummary };
    this.world = ctx.get("homeWorld") as unknown as { snapshot(): unknown } | undefined;
    this.observation = ctx.get("homeObservationScheduler") as unknown as {
      snapshot(): InboxObservationStatus;
      observeNow(): Promise<string>;
    } | undefined;
    this.observationAudit = ctx.get("homeObservationAudit") as unknown as {
      list(query: { limit: number }): readonly InboxObservationAttempt[];
      summary(): InboxObservationQualitySummary;
    } | undefined;
    this.advice = ctx.get("homeAdvice") as unknown as typeof this.advice;
  }

  list(query?: { status?: InboxProposalStatus; limit?: number }): readonly InboxProposalSummary[] {
    return this.controller.list(query).map((proposal) => {
      const preparationStatus = this.readPreparation(proposal.id, proposal.revision);
      return preparationStatus === undefined ? proposal : { ...proposal, preparationStatus };
    });
  }

  detail(proposalId: string): InboxProposalDetail | undefined {
    const detail = this.controller.detail(proposalId);
    if (detail === undefined) return undefined;
    const artifactReview = this.readArtifactReview(detail.proposal.id, detail.proposal.revision);
    const preparationStatus = this.readPreparation(detail.proposal.id, detail.proposal.revision);
    if (artifactReview === undefined && preparationStatus === undefined) return detail;
    return {
      ...detail,
      proposal: {
        ...detail.proposal,
        ...(preparationStatus === undefined ? {} : { preparationStatus }),
        ...(artifactReview === undefined ? {} : { artifactReview }),
      },
    };
  }

  review(input: InboxReviewInput): Promise<InboxProposal> {
    return this.controller.review(input);
  }

  getProductReviewCounts(): { readonly runtimeConfirmations: number; readonly persistentProposals: number } {
    return {
      runtimeConfirmations: this.runtime?.listRuntimeConfirmations().length ?? 0,
      persistentProposals: this.pendingProductProposals().length,
    };
  }

  getProductReviewProjection(actor?: InboxReviewActor, selectedProposalId?: string): InboxProductReviewProjection {
    const runtimeConfirmations = this.runtime?.listRuntimeConfirmations() ?? [];
    const expiredSummary = this.runtime?.snapshot?.().expiredRuntimeSummary;
    const proposals = this.pendingProductProposals();
    const proposalCapacity = this.proposalGovernance?.proposalCapacity?.();
    const selectedProposal = selectedProposalId === undefined
      ? undefined
      : this.proposals.get(selectedProposalId);
    return {
      runtimeConfirmations: runtimeConfirmations.map((confirmation) => projectRuntimeConfirmation(
        confirmation,
        actor !== undefined && this.runtime?.canApproveRuntimeConfirmation(confirmation.id, actor) === true,
        this.now(),
      )),
      proposals: proposals.map(projectProductProposal),
      ...(selectedProposal === undefined ? {} : { selectedProposal: projectProductProposal(selectedProposal) }),
      proposalCapacityUsed: proposalCapacity?.used ?? proposals.length,
      proposalCapacity: proposalCapacity?.max ?? 5,
      ...(expiredSummary === undefined || expiredSummary.count < 1
        ? {}
        : { expiredSummary: `${expiredSummary.count} 项动作已过期，未执行，已记录到活动。` }),
    };
  }

  getProductShellProjection(actor?: InboxReviewActor, batchRequestId?: string): InboxProductShellProjection {
    const world = this.world?.snapshot();
    const now = this.now();
    const actionDescriptorFor = this.runtime?.actionDescriptorFor === undefined
      ? undefined
      : (capabilityId: string) => readRuntimeActionDescriptor(this.runtime, capabilityId);
    const safetyAlerts = this.safety?.snapshot().alerts.map((alert) => ({
      ...alert,
      canAcknowledge: actor === undefined ? false : canUsePresentHouseholdPrincipal(actor),
    }));
    const completionNotification = projectAdviceCompletionNotification(
      this.advice?.peekNextCompletionNotification?.(),
    );
    const projection = projectProductWorld(world, now, actionDescriptorFor);
    const batchControl = this.batchControlProjection(projection, batchRequestId);
    return {
      ...projection,
      activity: projectRuntimeActivity(this.runtime?.activities?.() ?? [], now),
      ...(safetyAlerts === undefined ? {} : { safetyAlerts }),
      ...(completionNotification === undefined ? {} : { completionNotification }),
      ...(batchControl === undefined ? {} : { batchControl }),
    };
  }

  acknowledgeCompletionNotification(adviceId: string): boolean {
    if (this.advice?.acknowledgeCompletionNotification === undefined) return false;
    return this.advice.acknowledgeCompletionNotification(adviceId);
  }

  canAcknowledgeSafety(actor: InboxReviewActor): boolean {
    return this.safety !== undefined && canUsePresentHouseholdPrincipal(actor);
  }

  acknowledgeSafety(input: { readonly alertId: string; readonly actor: InboxReviewActor }): ProductSafetyAlert {
    if (!this.canAcknowledgeSafety(input.actor)) throw new Error("unauthorized");
    return this.safety!.acknowledge(input.alertId, input.actor.principalId);
  }

  canControl(): boolean {
    return this.runtime?.requestAction !== undefined && this.world?.snapshot !== undefined;
  }

  canBatchControl(): boolean {
    return this.batchActions !== undefined && this.runtime?.actionDescriptorFor !== undefined;
  }

  async requestBatchControl(input: {
    readonly capabilityIds: readonly string[];
    readonly actor: InboxReviewActor;
  }): Promise<ProposalInboxBatchActionResult> {
    if (!this.canBatchControl() || this.batchActions === undefined) throw new Error("batch_control_unavailable");
    const capabilityIds = normalizeBatchCapabilityIds(input.capabilityIds);
    if (capabilityIds === undefined) throw new Error("batch_control_invalid");
    const targets: ProposalInboxBatchActionTarget[] = [];
    for (const capabilityId of capabilityIds) {
      const descriptor = readRuntimeActionDescriptor(this.runtime, capabilityId);
      if (descriptor === undefined || !isBatchPolicyClass(descriptor.policyClass)) {
        throw new Error("batch_control_unavailable");
      }
      targets.push({
        capabilityId,
        descriptor: descriptor as InboxActionDescriptor & { readonly policyClass: ProductBatchPolicyClass },
      });
    }
    const requestId = this.nextBatchRequestId();
    const result = await this.batchActions.submit({ requestId, capabilityIds, actor: input.actor, targets });
    const labels = new Map(targets.map((target) => [target.capabilityId, target.descriptor.label] as const));
    const projected: ProposalInboxBatchActionResult = {
      ...result,
      items: result.items.map((item) => {
        const label = item.label ?? labels.get(item.capabilityId);
        return label === undefined ? item : { ...item, label };
      }),
    };
    this.batchResults.set(projected.requestId, projected);
    return projected;
  }

  async requestControl(input: InboxControlRequest): Promise<InboxControlResult> {
    if (!this.canControl() || this.runtime?.requestAction === undefined) {
      throw new Error("control_unavailable");
    }
    const resolved = resolveControlAction(
      this.world?.snapshot(),
      input.capabilityId,
      readRuntimeActionDescriptor(this.runtime, input.capabilityId),
    );
    if (resolved === undefined) throw new Error("control_unavailable");
    const requestId = this.nextControlRequestId();
    const result = await this.runtime.requestAction({
      requestId,
      capabilityId: input.capabilityId,
      summary: resolved.summary,
      action: resolved.action,
      actor: input.actor,
      source: "member",
    });
    return projectControlResult(result, resolved, this.now());
  }

  async undoAction(input: InboxControlUndoRequest): Promise<InboxControlResult> {
    if (this.runtime?.undoAction === undefined) throw new Error("control_undo_unavailable");
    const result = await this.runtime.undoAction(input);
    const ticket = result.ticket;
    const resolved = resolveControlAction(
      this.world?.snapshot(),
      ticket.capabilityId,
      readRuntimeActionDescriptor(this.runtime, ticket.capabilityId),
    );
    const fallback = resolved ?? {
      capabilityId: ticket.capabilityId,
      action: ticket.action,
      label: actionLabel(ticket.action),
      actionLabel: actionLabel(ticket.action),
      summary: ticket.summary ?? actionLabel(ticket.action),
      value: "状态待确认",
    };
    return projectControlResult(result, fallback, this.now());
  }

  getProductControlFeedback(ticketId: string): ProductControlFeedback | undefined {
    const ticket = this.runtime?.listActionTickets?.().find((item) => item.id === ticketId);
    if (ticket === undefined) return undefined;
    const resolved = resolveControlAction(
      this.world?.snapshot(),
      ticket.capabilityId,
      readRuntimeActionDescriptor(this.runtime, ticket.capabilityId),
    );
    const fallback = resolved ?? {
      capabilityId: ticket.capabilityId,
      action: ticket.action,
      label: actionLabel(ticket.action),
      actionLabel: actionLabel(ticket.action),
      summary: ticket.summary ?? actionLabel(ticket.action),
      value: "状态待确认",
    };
    return projectControlFeedback(ticket, fallback, this.now());
  }

  private batchControlProjection(
    projection: InboxProductShellProjection,
    batchRequestId?: string,
  ): ProductBatchControl | undefined {
    if (!this.canBatchControl()) return undefined;
    const items = projection.controlSpaces
      .flatMap((space) => space.controls ?? [])
      .filter((control): control is typeof control & { readonly policyClass: ProductBatchPolicyClass } => isBatchPolicyClass(control.policyClass))
      .slice(0, 32)
      .map((control) => ({
        capabilityId: control.id,
        label: control.label,
        ...(control.actionLabel === undefined ? {} : { actionLabel: control.actionLabel }),
        policyClass: control.policyClass,
      }));
    if (items.length === 0 && batchRequestId === undefined) return undefined;
    const counts = items.reduce((result, item) => ({ ...result, [item.policyClass]: result[item.policyClass] + 1 }), {
      direct: 0,
      confirmation: 0,
      administrator: 0,
    });
    const result = batchRequestId === undefined ? undefined : this.batchResults.get(batchRequestId);
    return {
      preview: {
        total: items.length,
        direct: counts.direct,
        confirmation: counts.confirmation,
        administrator: counts.administrator,
        items,
      },
      ...(result === undefined ? {} : { result }),
    };
  }

  private nextControlRequestId(): string {
    this.controlRequestSequence += 1;
    return `control-${Date.now().toString(36)}-${this.controlRequestSequence.toString(36)}`;
  }

  private nextBatchRequestId(): string {
    this.batchRequestSequence += 1;
    return `batch-${Date.now().toString(36)}-${this.batchRequestSequence.toString(36)}`;
  }

  canApproveRuntimeConfirmation(actor: InboxReviewActor, confirmationId?: string): boolean {
    return confirmationId !== undefined
      && this.runtime?.canApproveRuntimeConfirmation(confirmationId, actor) === true;
  }

  approveRuntimeConfirmation(input: InboxRuntimeDecisionRequest): Promise<InboxRuntimeDecisionResult> {
    return this.decideRuntime(input, "approve");
  }

  rejectRuntimeConfirmation(input: InboxRuntimeDecisionRequest): Promise<InboxRuntimeDecisionResult> {
    return this.decideRuntime(input, "reject");
  }

  canSnoozeProposal(): boolean {
    return typeof this.proposalGovernance?.snoozeProposal === "function";
  }

  async snoozeProposal(input: { readonly proposalId: string; readonly until: ProposalInboxSnoozeTarget }): Promise<void> {
    const snooze = this.proposalGovernance?.snoozeProposal;
    if (snooze === undefined) throw new Error("proposal_snooze_unavailable");
    await snooze.call(this.proposalGovernance, input);
  }

  canRejectProposal(): boolean {
    return typeof this.proposalGovernance?.decideProposal === "function";
  }

  async rejectProposal(input: { readonly proposalId: string; readonly expectedRevision: number; readonly reviewer: string }): Promise<void> {
    const decide = this.proposalGovernance?.decideProposal;
    if (decide === undefined) throw new Error("proposal_reject_unavailable");
    await decide.call(this.proposalGovernance, { ...input, decision: "reject_once" });
  }

  canLatchProposal(): boolean {
    return typeof this.proposalGovernance?.decideProposal === "function";
  }

  canEnableProposal(): boolean {
    return typeof this.proposalGovernance?.enableProposal === "function";
  }

  async enableProposal(input: { readonly proposalId: string; readonly expectedRevision: number; readonly reviewer: string }): Promise<void> {
    const enable = this.proposalGovernance?.enableProposal;
    if (enable === undefined) throw new Error("proposal_enable_unavailable");
    await enable.call(this.proposalGovernance, input);
  }

  async latchProposal(input: { readonly proposalId: string; readonly expectedRevision: number; readonly reviewer: string }): Promise<void> {
    const decide = this.proposalGovernance?.decideProposal;
    if (decide === undefined) throw new Error("proposal_latch_unavailable");
    await decide.call(this.proposalGovernance, { ...input, decision: "do_not_suggest" });
  }

  canRetryPreparation(): boolean {
    return this.preparation !== undefined;
  }

  async retryPreparation(input: InboxPreparationRetryInput): Promise<void> {
    if (this.preparation === undefined) throw new Error("Preparation retry is unavailable");
    await this.preparation.retry(input);
  }

  canObserveNow(): boolean {
    return this.observation !== undefined;
  }

  async observeNow(): Promise<string> {
    if (this.observation === undefined) throw new Error("Home observation is unavailable");
    return this.observation.observeNow();
  }

  canAskAdvice(): boolean {
    return this.getAdviceAvailability().status === "ready";
  }

  getAdviceAvailability(): InboxAdviceAvailability {
    if (this.advice === undefined) return { status: "setup_required" };
    const availability = this.advice.availability?.();
    if (availability === undefined) {
      return this.advice.canAsk() ? { status: "ready" } : { status: "setup_required" };
    }
    return normalizeAdviceAvailability(availability);
  }

  async askAdvice(question: string, actor?: InboxReviewActor): Promise<InboxHomeAdviceRecord> {
    return this.startAdvice(question, actor);
  }

  async startAdvice(question: string, actor?: InboxReviewActor): Promise<InboxHomeAdviceRecord> {
    if (this.advice === undefined) throw new Error("Home advice is unavailable");
    return this.advice.ask(question, actor);
  }

  async submitConversationCorrection(input: {
    readonly adviceId: string;
    readonly actor: InboxReviewActor;
    readonly correctionType: InboxConversationCorrectionType;
    readonly correction: string;
    readonly idempotencyKey: string;
  }): Promise<InboxConversationCorrectionResult> {
    if (this.correction === undefined) throw new Error("home_correction_unavailable");
    return this.correction.submit(input);
  }

  readAdviceEvents(id: string, after?: string): readonly InboxAdviceProgressEvent[] {
    if (this.advice?.events === undefined) return [];
    return this.advice.events(id, adviceCursor(after));
  }

  subscribeAdvice(id: string, listener: InboxAdviceProgressListener): () => void {
    if (this.advice?.subscribe === undefined) return () => undefined;
    // HTTP subscribes before replay to close the read/subscribe race. Suppress
    // the Hub's synchronous replay here; the HTTP layer performs one cursor-
    // aware replay and queues only events that arrive after this subscription.
    return this.advice.subscribe(id, listener, Number.MAX_SAFE_INTEGER);
  }

  async cancelAdvice(id: string): Promise<InboxAdviceCancelResult> {
    const record = this.advice?.get(id);
    if (record === undefined) return { status: "not_found" };
    if (record.status !== "running" || this.advice?.cancel === undefined) return { status: "terminal_status" };
    return this.advice.cancel(id) ? { status: "cancelled" } : { status: "terminal_status" };
  }

  async backgroundAdvice(id: string): Promise<InboxAdviceBackgroundResult> {
    const record = this.advice?.get(id);
    if (record === undefined) return { status: "not_found" };
    if (record.status !== "running") return { status: "terminal_status" };
    if (this.advice?.background === undefined) return { status: "unavailable" };
    return this.advice.background(id) ? { status: "background" } : { status: "terminal_status" };
  }

  async retryAdvice(id: string): Promise<InboxAdviceRetryResult> {
    const record = this.advice?.get(id);
    if (record === undefined) return { status: "not_found" };
    if (record.status !== "failed") return { status: "terminal_status" };
    if (this.getAdviceAvailability().status !== "ready" || this.advice === undefined) {
      return { status: "unavailable" };
    }
    return this.advice.ask(record.question);
  }

  getProductAdviceTurn(id: string, actor?: InboxReviewActor): ProductTurn | undefined {
    const advice = this.advice?.get(id);
    if (advice === undefined) return undefined;
    if (advice.status === "completed") {
      const suggestions = [
        ...(advice.report.trial === undefined ? [] : [advice.report.trial.description]),
        ...advice.report.hardwareSuggestions.map((item) => item.reason),
        ...advice.report.validationSteps,
      ];
      const turn: ProductTurn = {
        id: advice.id,
        question: advice.question,
        status: "completed",
        answer: advice.report.summary,
        verifiedFacts: [...advice.report.findings],
        unknowns: [...advice.report.unknowns],
        suggestions,
        canStop: false,
        canBackground: false,
      };
      const acknowledgement = actor === undefined || this.correction?.acknowledgementForAdvice === undefined
        ? undefined
        : this.correction.acknowledgementForAdvice(advice.id, actor.principalId);
      if (acknowledgement !== undefined && isCorrectionAcknowledgement(acknowledgement, advice.id)) {
        return {
          ...turn,
          correctionAck: acknowledgement.message,
          correctionDestination: acknowledgement.destination,
          ...(acknowledgement.proposalId === undefined ? {} : { correctionProposalId: acknowledgement.proposalId }),
          ...(acknowledgement.proposalCount === undefined ? {} : { correctionProposalCount: acknowledgement.proposalCount }),
        };
      }
      return turn;
    }
    const events = this.readAdviceEvents(advice.id);
    const lastEvent = events.at(-1);
    if (advice.status === "failed") {
      return {
        id: advice.id,
        question: advice.question,
        status: lastEvent?.type === "cancelled" ? "cancelled" : "failed",
        canStop: false,
        canBackground: false,
      };
    }
    const elapsedSeconds = Math.max(0, Math.floor((this.now().getTime() - Date.parse(advice.createdAt)) / 1_000));
    return {
      id: advice.id,
      question: advice.question,
      status: advice.status === "background" ? "background" : "inspecting",
      stage: productTurnStage(lastEvent?.type),
      elapsedSeconds,
      canStop: true,
      canBackground: advice.status === "running" && elapsedSeconds >= 10,
    };
  }

  private readArtifactReview(proposalId: string, proposalRevision: number): InboxArtifactReviewSnapshot | undefined {
    if (this.artifactReviewSource === undefined) return undefined;
    const snapshot = this.artifactReviewSource.reviewForProposal(proposalId, proposalRevision);
    if (snapshot === undefined
      || snapshot.proposal.id !== proposalId
      || snapshot.proposal.revision !== proposalRevision) return undefined;
    return projectArtifactReview(snapshot);
  }

  private readPreparation(proposalId: string, proposalRevision: number): InboxPreparationStatus | undefined {
    return projectPreparation(
      this.preparationSource?.preparationForProposal(proposalId, proposalRevision),
      this.preparation !== undefined,
    );
  }

  private pendingProductProposals(): readonly InboxProposal[] {
    return this.proposals.list({ status: "pending_review", limit: 200, visibleOnly: true });
  }

  private async decideRuntime(
    input: InboxRuntimeDecisionRequest,
    decision: "approve" | "reject",
  ): Promise<InboxRuntimeDecisionResult> {
    if (this.runtime === undefined) throw new Error("runtime_confirmation_unavailable");
    if (!this.runtime.canApproveRuntimeConfirmation(input.confirmationId, input.actor)) {
      return { status: "denied", reason: "unauthorized" };
    }
    return await (decision === "approve"
      ? this.runtime.approveRuntimeConfirmation(input)
      : this.runtime.rejectRuntimeConfirmation(input));
  }
}

interface InboxAdviceProgressEvent {
  readonly id: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

type InboxAdviceProgressListener = (event: InboxAdviceProgressEvent) => void;

type InboxAdviceCancelResult =
  | { readonly status: "cancelled" }
  | { readonly status: "not_found" }
  | { readonly status: "terminal_status" };

type InboxAdviceBackgroundResult =
  | { readonly status: "background" }
  | { readonly status: "not_found" }
  | { readonly status: "terminal_status" }
  | { readonly status: "unavailable" };

type InboxAdviceRetryResult = InboxHomeAdviceRecord
  | { readonly status: "not_found" }
  | { readonly status: "terminal_status" }
  | { readonly status: "unavailable" };

function adviceCursor(value: string | undefined): number {
  if (value === undefined || value.length === 0) return 0;
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError("Invalid advice event cursor");
  return cursor;
}

function normalizeAdviceAvailability(value: InboxAdviceAvailability): InboxAdviceAvailability {
  switch (value.status) {
    case "ready":
    case "setup_required":
    case "home_connecting":
    case "model_unavailable":
    case "agent_busy":
    case "active_request":
    case "stopped":
      return value;
  }
}

function projectAdviceCompletionNotification(value: unknown): ProductAdviceCompletionNotification | undefined {
  if (!isUnknownRecord(value)
    || typeof value.adviceId !== "string"
    || !isProductResourceId(value.adviceId)
    || (value.status !== "completed" && value.status !== "failed" && value.status !== "cancelled")
    || typeof value.completedAt !== "string"
    || !Number.isFinite(Date.parse(value.completedAt))) return undefined;
  return {
    adviceId: value.adviceId,
    status: value.status,
    completedAt: value.completedAt,
  };
}

function isProductResourceId(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function productTurnStage(type: string | undefined): ProductTurnStage {
  switch (type) {
    case "inspecting_home": return "checking_home";
    case "reading_inventory": return "reading_inventory";
    case "checking_rules": return "checking_rules";
    case "evaluating_evidence":
    case "composing_answer": return "composing";
    default: return "received";
  }
}

interface PreparationReadSource {
  preparationForProposal(proposalId: string, proposalRevision: number): unknown;
}

function hasPreparationReadSource(source: unknown): source is PreparationReadSource {
  return typeof (source as Partial<PreparationReadSource> | undefined)?.preparationForProposal === "function";
}

function preparationPortFrom(source: unknown): ProposalInboxPreparationPort | undefined {
  const retry = (source as { retryPreparation?: unknown } | undefined)?.retryPreparation;
  return typeof retry === "function"
    ? { retry: retry.bind(source) as ProposalInboxPreparationPort["retry"] }
    : undefined;
}

function hasRuntimePort(source: unknown): source is ProposalInboxRuntimePort {
  if (source === undefined || source === null || typeof source !== "object") return false;
  const port = source as Partial<ProposalInboxRuntimePort>;
  return typeof port.listRuntimeConfirmations === "function"
    && typeof port.canApproveRuntimeConfirmation === "function"
    && typeof port.approveRuntimeConfirmation === "function"
    && typeof port.rejectRuntimeConfirmation === "function";
}

function hasBatchActionPort(source: unknown): source is ProposalInboxBatchActionPort {
  return typeof (source as Partial<ProposalInboxBatchActionPort> | undefined)?.submit === "function";
}

function isBatchPolicyClass(value: unknown): value is ProductBatchPolicyClass {
  return value === "direct" || value === "confirmation" || value === "administrator";
}

function normalizeBatchCapabilityIds(value: readonly string[]): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return undefined;
  const seen = new Set<string>();
  for (const capabilityId of value) {
    if (typeof capabilityId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(capabilityId)
      || seen.has(capabilityId)) return undefined;
    seen.add(capabilityId);
  }
  return [...seen];
}

function readRuntimeActionDescriptor(
  runtime: ProposalInboxRuntimePort | undefined,
  capabilityId: string,
): InboxActionDescriptor | undefined {
  if (runtime?.actionDescriptorFor === undefined) return undefined;
  try {
    return runtime.actionDescriptorFor(capabilityId);
  } catch {
    return undefined;
  }
}

function safetyPortFrom(source: unknown): ProposalInboxSafetyPort | undefined {
  if (source === undefined || source === null || typeof source !== "object") return undefined;
  const port = source as Partial<ProposalInboxSafetyPort>;
  return typeof port.snapshot === "function" && typeof port.acknowledge === "function"
    ? port as ProposalInboxSafetyPort
    : undefined;
}

function correctionPortFrom(source: unknown): ProposalInboxCorrectionPort | undefined {
  if (source === undefined || source === null || typeof source !== "object") return undefined;
  const port = source as Partial<ProposalInboxCorrectionPort>;
  return typeof port.submit === "function"
    ? port as ProposalInboxCorrectionPort
    : undefined;
}

function isCorrectionAcknowledgement(
  value: InboxConversationCorrectionResult,
  adviceId: string,
): boolean {
  const proposalCount = value.proposalCount;
  return value.adviceId === adviceId
    && (value.status === "updated" || value.status === "proposal_created")
    && value.message === "已更新"
    && typeof value.destination === "string"
    && value.destination.length > 0
    && value.destination.length <= 200
    && (value.status === "updated"
      || (typeof value.proposalId === "string"
        && value.proposalId.length > 0
        && typeof proposalCount === "number"
        && Number.isSafeInteger(proposalCount)
        && proposalCount >= 0));
}

function canUsePresentHouseholdPrincipal(actor: InboxReviewActor): boolean {
  return actor.present === true && typeof actor.principalId === "string" && actor.principalId.trim().length > 0;
}

function optionalGovernancePort(source: unknown): ProposalInboxProposalGovernancePort | undefined {
  if (source === undefined || source === null || typeof source !== "object") return undefined;
  const port = source as ProposalInboxProposalGovernancePort;
  return typeof port.snoozeProposal === "function"
    || typeof port.decideProposal === "function"
    || typeof port.enableProposal === "function"
    || typeof port.proposalCapacity === "function"
    ? port
    : undefined;
}

function projectRuntimeConfirmation(
  confirmation: InboxRuntimeConfirmation,
  canApprove: boolean,
  now: Date,
): ProductRuntimeConfirmation {
  const status = confirmation.status === "pending"
    ? "pending"
    : confirmation.status === "expired" ? "expired" : "decided";
  return {
    id: confirmation.id,
    title: confirmation.actionSummary,
    effect: confirmation.actionSummary,
    eligibleActor: confirmation.approvalLevel === "admin" ? "绑定管理员私人设备" : "在场的成年成员",
    expiresAt: confirmation.expiresAt,
    expiresLabel: formatRuntimeExpiryLabel(confirmation.expiresAt, now),
    expiresIn: formatRuntimeRemaining(confirmation.expiresAt, now),
    policyClass: confirmation.approvalLevel === "admin" ? "administrator" : "confirmation",
    canApprove: status === "pending" && canApprove,
    status,
  };
}

function formatRuntimeRemaining(expiresAt: string, now: Date): string {
  const remainingMs = Date.parse(expiresAt) - now.getTime();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "已到期";
  const seconds = Math.ceil(remainingMs / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.ceil(minutes / 60)} 小时`;
}

function formatRuntimeExpiryLabel(expiresAt: string, now: Date): string {
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime())) return "时间待确认";
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(expiry);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfExpiry = new Date(expiry.getFullYear(), expiry.getMonth(), expiry.getDate()).getTime();
  const dayOffset = Math.round((startOfExpiry - startOfToday) / 86_400_000);
  if (dayOffset === 0) return `今天 ${time}`;
  if (dayOffset === 1) return `明天 ${time}`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(expiry);
}

function projectProductProposal(proposal: InboxProposal): ProductProposal {
  const rationale = proposal.rationale;
  const why = rationale === undefined
    ? undefined
    : [rationale.householdValue, rationale.whyNow].filter((item): item is string => item.length > 0);
  const willDo = proposal.intent.description.length > 0 ? [proposal.intent.description] : undefined;
  const evidence = proposal.evidence.references.length === 0
    ? undefined
    : [`${proposal.evidence.references.length} 条已记录的家庭证据`];
  const unknowns = rationale?.uncertainties.length === 0 ? undefined : rationale?.uncertainties;
  return {
    id: proposal.id,
    revision: proposal.revision,
    title: proposal.title,
    summary: proposal.summary,
    ...(why === undefined || why.length === 0 ? {} : { why }),
    ...(willDo === undefined ? {} : { willDo }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(unknowns === undefined ? {} : { unknowns }),
    status: proposal.status === "pending_review"
      ? "pending"
      : proposal.status === "expired" ? "expired" : proposal.status,
    stage: proposal.rolloutState === "trial_active"
      ? "trial"
      : proposal.rolloutState === "enable_pending"
        ? "enable"
        : proposal.rolloutState === "enabled" ? "complete" : "direction",
    snoozeCount: proposal.snoozeCount ?? 0,
    newEvidence: proposal.newEvidence ?? false,
  };
}

function projectProductWorld(
  value: unknown,
  now: Date,
  actionDescriptorFor?: (capabilityId: string) => InboxActionDescriptor | undefined,
): InboxProductShellProjection {
  const world = productRecord(value);
  if (world === undefined) {
    return { connection: { state: "unknown" }, spaces: [], controlSpaces: [], activity: [] };
  }
  const connection = projectProductConnection(world, now);
  const devices = Array.isArray(world.devices) ? world.devices.slice(0, 1_000) : [];
  const spaces = (Array.isArray(world.spaces) ? world.spaces : [])
    .slice(0, 100)
    .flatMap((spaceValue): ProductSpace[] => {
      const space = productRecord(spaceValue);
      const id = productText(space?.hwSpaceId, 256);
      if (id === undefined) return [];
      const name = productText(space?.name, 512) ?? "未命名空间";
      const spaceDevices = devices.flatMap((deviceValue) => {
        const device = productRecord(deviceValue);
        return device !== undefined && productDeviceSpaceIds(device).has(id) ? [device] : [];
      });
      const labels = spaceDevices
        .map(productDeviceLabel)
        .filter((label): label is string => label !== undefined)
        .slice(0, 12);
      return [{
        id,
        name,
        deviceCount: spaceDevices.length,
        ...(labels.length === 0 ? {} : { devices: labels }),
      }];
    });
  return {
    connection,
    spaces,
    controlSpaces: spaces.map((space) => ({
      ...space,
      controls: devices
        .map((deviceValue) => productRecord(deviceValue))
        .filter((device): device is Record<string, unknown> => device !== undefined && productDeviceSpaceIds(device).has(space.id))
        .flatMap((device) => projectDeviceControls(device, actionDescriptorFor))
        .slice(0, 24),
    })),
    activity: [],
  };
}

interface ProductWorldControlSnapshot {
  readonly devices?: readonly unknown[];
}

interface ResolvedControlAction {
  readonly capabilityId: string;
  readonly action: InboxOneShotAction;
  readonly label: string;
  readonly actionLabel: string;
  readonly summary: string;
  readonly value: string;
  readonly policyClass?: ProductBatchPolicyClass;
}

function resolveControlAction(
  value: unknown,
  capabilityId: string,
  actionDescriptor: unknown,
): ResolvedControlAction | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(capabilityId)) return undefined;
  const world = productRecord(value) as ProductWorldControlSnapshot | undefined;
  if (world === undefined || !Array.isArray(world.devices)) return undefined;
  for (const deviceValue of world.devices) {
    const device = productRecord(deviceValue);
    if (device === undefined || device.validity !== "valid" || !Array.isArray(device.capabilities)) continue;
    for (const capabilityValue of device.capabilities) {
      const capability = productRecord(capabilityValue);
      if (capability === undefined || capability.hwCapabilityId !== capabilityId) continue;
      const descriptor = parseActionDescriptor(actionDescriptor);
      if (descriptor === undefined) return undefined;
      const deviceName = productText(device.name, 512) ?? "设备";
      const label = descriptor.label ?? deviceName;
      const actionLabel = descriptor.actionLabel ?? explicitActionLabel(descriptor.action);
      return {
        capabilityId,
        action: descriptor.action,
        label,
        actionLabel,
        summary: descriptor.summary ?? `${actionLabel}${deviceName}`,
        value: descriptor.value ?? "状态待确认",
        ...(descriptor.policyClass === undefined ? {} : { policyClass: descriptor.policyClass }),
      };
    }
  }
  return undefined;
}

function projectDeviceControls(
  device: Record<string, unknown>,
  actionDescriptorFor?: (capabilityId: string) => InboxActionDescriptor | undefined,
) {
  if (device.validity !== "valid" || !Array.isArray(device.capabilities)) return [];
  return device.capabilities.flatMap((capabilityValue) => {
    const capability = productRecord(capabilityValue);
    const capabilityId = productText(capability?.hwCapabilityId, 256);
    if (capability === undefined || capabilityId === undefined) return [];
    const resolved = resolveControlAction(
      { devices: [device] },
      capabilityId,
      actionDescriptorFor?.(capabilityId),
    );
    if (resolved === undefined) return [];
    return [{
      id: capabilityId,
      label: resolved.label,
      value: resolved.value,
      actionLabel: resolved.actionLabel,
      ...(resolved.policyClass === undefined ? {} : { policyClass: resolved.policyClass }),
    }];
  });
}

function parseActionDescriptor(value: unknown): InboxActionDescriptor | undefined {
  const descriptor = productRecord(value);
  if (descriptor === undefined) return undefined;
  const action = parseOneShotAction(descriptor.action);
  if (action === undefined) return undefined;
  const label = productText(descriptor.label, 512);
  const actionLabel = productText(descriptor.actionLabel, 256);
  const summary = productText(descriptor.summary, 1_024);
  const displayValue = productText(descriptor.value, 256);
  const reversible = descriptor.reversible === undefined ? undefined : descriptor.reversible === true;
  const policyClass = isBatchPolicyClass(descriptor.policyClass) ? descriptor.policyClass : undefined;
  return {
    action,
    ...(label === undefined ? {} : { label }),
    ...(actionLabel === undefined ? {} : { actionLabel }),
    ...(summary === undefined ? {} : { summary }),
    ...(displayValue === undefined ? {} : { value: displayValue }),
    ...(reversible === undefined ? {} : { reversible }),
    ...(policyClass === undefined ? {} : { policyClass }),
  };
}

function parseOneShotAction(value: unknown): InboxOneShotAction | undefined {
  const action = productRecord(value);
  if (action === undefined || typeof action.kind !== "string") return undefined;
  if (action.kind === "set_boolean" && typeof action.value === "boolean") {
    return { kind: "set_boolean", value: action.value };
  }
  if (action.kind === "set_level"
    && typeof action.level === "number"
    && Number.isFinite(action.level)
    && action.level >= 0
    && action.level <= 1) {
    return { kind: "set_level", level: action.level };
  }
  if (action.kind === "play_media"
    && typeof action.mediaRef === "string"
    && /^[A-Za-z0-9_-]{16,256}$/.test(action.mediaRef)
    && (action.queueMode === "replace_and_play" || action.queueMode === "play_next" || action.queueMode === "add_to_queue")) {
    return { kind: "play_media", mediaRef: action.mediaRef, queueMode: action.queueMode };
  }
  if (action.kind === "stop_media") return { kind: "stop_media" };
  return undefined;
}

function explicitActionLabel(action: InboxOneShotAction): string {
  if (action.kind === "set_boolean") return action.value ? "打开" : "关闭";
  if (action.kind === "set_level") return `调到 ${Math.round(action.level * 100)}%`;
  if (action.kind === "play_media") return "播放媒体";
  return "停止播放";
}

function actionLabel(action: InboxOneShotAction): string {
  if (action.kind === "set_boolean") return action.value ? "打开设备" : "关闭设备";
  if (action.kind === "stop_media") return "停止播放";
  if (action.kind === "set_level") return `调到 ${Math.round(action.level * 100)}%`;
  return "播放媒体";
}

function projectControlResult(
  result: InboxOneShotActionResult,
  resolved: ResolvedControlAction,
  now: Date,
): InboxControlResult {
  const status = controlStatus(result.status);
  const ticket = result.ticket;
  const expiresAt = typeof ticket.expiresAt === "string" ? ticket.expiresAt : undefined;
  const undoExpiresAt = result.undo?.expiresAt ?? ticket.undoExpiresAt;
  const summary = ticket.summary ?? resolved.summary;
  return {
    capabilityId: resolved.capabilityId,
    ticketId: typeof ticket.id === "string" ? ticket.id : undefined,
    status,
    label: summary,
    detail: controlDetail(status, summary, result.reason),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(expiresAt === undefined ? {} : { expiresIn: formatRuntimeRemaining(expiresAt, now) }),
    ...(undoExpiresAt === undefined || !isFuture(undoExpiresAt, now) ? {} : { undo: { ticketId: ticket.id, expiresAt: undoExpiresAt } }),
  };
}

function projectControlFeedback(
  ticket: InboxActionTicket,
  resolved: ResolvedControlAction,
  now: Date,
): ProductControlFeedback {
  const status = controlStatus(ticket.status);
  const undoExpiresAt = ticket.undoExpiresAt;
  const summary = ticket.summary ?? resolved.summary;
  return {
    capabilityId: resolved.capabilityId,
    ...(ticket.id.length === 0 ? {} : { ticketId: ticket.id }),
    status,
    label: summary,
    detail: controlDetail(status, summary, ticket.resultReason),
    ...(ticket.expiresAt === undefined ? {} : { expiresAt: ticket.expiresAt }),
    ...(ticket.expiresAt === undefined ? {} : { expiresIn: formatRuntimeRemaining(ticket.expiresAt, now) }),
    ...(undoExpiresAt === undefined || ticket.undoStatus !== "available" || !isFuture(undoExpiresAt, now)
      ? {}
      : { undo: { id: ticket.id, label: summary, inverseLabel: "撤销这次动作", remainingSeconds: Math.max(0, Math.ceil((Date.parse(undoExpiresAt) - now.getTime()) / 1_000)), status: "available" as const } }),
  };
}

function controlStatus(value: string): InboxControlActionStatus {
  return value === "verified" || value === "pending_confirmation" || value === "failed" || value === "unknown"
    ? value
    : "unknown";
}

function controlDetail(status: InboxControlActionStatus, summary: string, reason?: string): string {
  if (status === "verified") return `${summary}已完成。`;
  if (status === "pending_confirmation") return `${summary}正在等待你放行。`;
  if (status === "failed") return `${summary}没有完成，家里保持原状。${reason === undefined ? "" : ` ${controlReasonLabel(reason)}`}`.trim();
  return `${summary}的结果正在确认，家里保持原状。`;
}

function controlReasonLabel(reason: string): string {
  switch (reason) {
    case "present_person_required": return "请让在场成员发起这项动作。";
    case "action_authority_unavailable":
    case "action_policy_unavailable": return "当前家庭连接提供了只读状态。";
    case "bridge_rejected": return "家庭连接拒绝了这项动作。";
    default: return "可以稍后再次尝试。";
  }
}

function isFuture(value: string, now: Date): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function projectRuntimeActivity(
  source: readonly InboxRuntimeActivity[],
  now: Date,
): readonly ProductActivityRecord[] {
  return source
    .filter((item) => typeof item.id === "string"
      && typeof item.title === "string"
      && typeof item.actor === "string"
      && Array.isArray(item.cause)
      && Number.isFinite(Date.parse(item.at)))
    .slice(-200)
    .map((item) => ({
      id: item.id,
      dateGroup: productActivityDateGroup(item.at, now),
      time: new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(item.at)),
      title: item.title,
      actor: item.actor,
      attribution: item.attribution,
      cause: item.cause.slice(0, 8),
      ...(item.verification === undefined ? {} : { verification: item.verification }),
    }));
}

function productActivityDateGroup(at: string, now: Date): "today" | "yesterday" | string {
  const day = at.slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  if (day === today) return "today";
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  return day === yesterday ? "yesterday" : day;
}

function projectProductConnection(world: Record<string, unknown>, now: Date): ProductShellConnection {
  const bridges = productRecord(world.bridges);
  if (bridges === undefined || Object.keys(bridges).length === 0) return { state: "unknown" };
  const states = Object.values(bridges).flatMap((bridgeValue) => {
    const bridge = productRecord(bridgeValue);
    if (bridge === undefined) return [];
    const metrics = productRecord(bridge.metrics);
    const diagnostics = productRecord(bridge.diagnostics);
    const connection = metrics?.connection;
    const consistency = metrics?.consistency;
    const activity = metrics?.eventActivity;
    const lastContact = productText(diagnostics?.lastSuccessfulContactAt, 64);
    return [{ connection, consistency, activity, lastContact }];
  });
  const ready = states.some((item) => item.connection === "up" && item.consistency === "ready");
  const state: ProductShellConnection["state"] = ready
    ? states.every((item) => item.activity === "idle") ? "quiet" : "connected"
    : states.every((item) => item.connection === "down") ? "disconnected" : "connecting";
  const latestContact = states.map((item) => item.lastContact)
    .filter((item): item is string => item !== undefined && Number.isFinite(Date.parse(item)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  return {
    state,
    ...(latestContact === undefined ? {} : { lastContact: productRelativeTime(latestContact, now) }),
  };
}

function productDeviceSpaceIds(device: Record<string, unknown>): ReadonlySet<string> {
  const ids = new Set<string>();
  const bindingGroups = [device.bindings, ...(Array.isArray(device.capabilities)
    ? device.capabilities.map((item) => productRecord(item)?.bindings)
    : [])];
  for (const bindings of bindingGroups) {
    if (!Array.isArray(bindings)) continue;
    for (const bindingValue of bindings) {
      const id = productText(productRecord(bindingValue)?.hwSpaceId, 256);
      if (id !== undefined) ids.add(id);
    }
  }
  return ids;
}

function productDeviceLabel(device: Record<string, unknown>): string | undefined {
  const capabilities = Array.isArray(device.capabilities)
    ? device.capabilities.flatMap((item) => {
        const capability = productRecord(item);
        return capability === undefined ? [] : [capability];
      })
    : [];
  const semanticKind = capabilities
    .map((item) => productText(item.semanticKind, 64))
    .find((item): item is string => item !== undefined);
  const name = productText(device.name, 512) ?? productSemanticLabel(semanticKind);
  if (name === undefined) return undefined;
  const states = Array.isArray(device.states) ? device.states : [];
  const latest = productRecord(states.at(-1));
  const state = productText(productRecord(latest?.attrs)?.state, 128);
  const stateLabel = productStateLabel(state);
  return stateLabel === undefined ? name : `${name} · ${stateLabel}`;
}

function productSemanticLabel(kind: string | undefined): string | undefined {
  const labels: Readonly<Record<string, string>> = {
    light: "照明设备",
    media: "媒体设备",
    cover: "窗帘",
    lock: "门锁",
    climate: "温控设备",
    sensor: "传感器",
    "binary-sensor": "状态传感器",
    fan: "风扇",
    camera: "摄像头",
  };
  return kind === undefined ? undefined : labels[kind];
}

function productStateLabel(state: string | undefined): string | undefined {
  if (state === undefined) return undefined;
  const labels: Readonly<Record<string, string>> = {
    on: "开",
    off: "关",
    playing: "正在播放",
    paused: "已暂停",
    idle: "空闲",
    open: "打开",
    closed: "关闭",
    locked: "已锁",
    unlocked: "未锁",
    unavailable: "离线",
    unknown: "状态待确认",
  };
  return labels[state];
}

function productRelativeTime(timestamp: string, now: Date): string {
  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - Date.parse(timestamp)) / 1_000));
  if (elapsedSeconds < 60) return "刚刚";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

function productRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function productText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= maximumLength && !/[\u0000-\u001F\u007F]/u.test(text)
    ? text
    : undefined;
}

const PREPARATION_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
const PREPARATION_STAGES = ["artifact", "evidence", "authority", "risk", "compile", "dry-run"] as const;
const PREPARATION_CODES = ["not_found", "unavailable", "malformed_dependency", "policy_blocked", "persistence_failed", "attempt_exhausted"] as const;

function projectPreparation(value: unknown, retryAvailable: boolean): InboxPreparationStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const source = value as Record<string, unknown>;
  if (!PREPARATION_STATUSES.includes(source.status as typeof PREPARATION_STATUSES[number])) return undefined;
  const error = typeof source.error === "object" && source.error !== null
    ? source.error as Record<string, unknown>
    : undefined;
  const stage = error?.stage ?? source.stage;
  const code = error?.code;
  if (source.status === "failed"
    && (!PREPARATION_STAGES.includes(stage as typeof PREPARATION_STAGES[number])
      || !PREPARATION_CODES.includes(code as typeof PREPARATION_CODES[number]))) return undefined;
  return Object.freeze({
    status: source.status as InboxPreparationStatus["status"],
    ...(Number.isSafeInteger(source.attempt) && Number(source.attempt) > 0 ? { attempt: Number(source.attempt) } : {}),
    ...(Number.isSafeInteger(source.version) && Number(source.version) > 0 ? { version: Number(source.version) } : {}),
    ...(source.status === "failed" ? {
      stage: stage as NonNullable<InboxPreparationStatus["stage"]>,
      code: code as NonNullable<InboxPreparationStatus["code"]>,
    } : {}),
    ...(typeof source.createdAt === "string" ? { createdAt: source.createdAt } : {}),
    ...(typeof source.updatedAt === "string" ? { updatedAt: source.updatedAt } : {}),
    canRetry: retryAvailable
      && source.status === "failed"
      && Number.isSafeInteger(source.attempt)
      && Number(source.attempt) < 5,
  });
}

function hasArtifactReviewReadSource(
  source: ControlCenterArtifactSource | undefined,
): source is ArtifactReviewReadSource {
  return source !== undefined && typeof (source as Partial<ArtifactReviewReadSource>).reviewForProposal === "function";
}

/** Strip Hub-only proposal/evidence fields before the read-only Inbox projection. */
function projectArtifactReview(snapshot: ArtifactReviewReadSnapshot | undefined): InboxArtifactReviewSnapshot | undefined {
  if (snapshot === undefined) return undefined;
  const artifact = projectArtifactRef(snapshot.artifact);
  return {
    artifact,
    compile: projectCompileReview(snapshot.compile),
    dryRun: projectDryRunReview(snapshot.dryRun),
    writesPerformed: false,
  };
}

type ReviewWatermark = InboxArtifactReviewWatermark;
type ReviewAuthorityBinding = InboxArtifactReviewActionAuthorityBinding;
type ReviewDiffOperation = InboxArtifactReviewDiffOperation;
type ReviewDiff = InboxArtifactReviewDiff;
type ReviewConflictFinding = InboxArtifactReviewConflictFinding;
type ReviewConflicts = InboxArtifactReviewConflicts;

function projectArtifactRef(ref: InboxArtifactReviewSnapshot["artifact"]): InboxArtifactReviewSnapshot["artifact"] {
  return {
    artifactId: ref.artifactId,
    revision: ref.revision,
    contentHash: ref.contentHash,
  };
}

function projectCompileReview(
  compile: ArtifactReviewReadSnapshot["compile"],
): InboxArtifactReviewSnapshot["compile"] {
  if (compile.status === "not_run") return { status: "not_run" };
  return {
    status: compile.status,
    ...(compile.resultId === undefined ? {} : { resultId: compile.resultId }),
    ...(compile.inputIdentity === undefined ? {} : { inputIdentity: compile.inputIdentity }),
    ...(compile.compiler === undefined ? {} : { compiler: { id: compile.compiler.id, version: compile.compiler.version } }),
    usedWatermarks: compile.usedWatermarks.map(projectReviewWatermark),
    actionAuthorityBindings: compile.actionAuthorityBindings.map(projectAuthorityBinding),
    blockingReasons: [...compile.blockingReasons],
    diff: projectReviewDiff(compile.diff),
    conflicts: projectReviewConflicts(compile.conflicts),
  };
}

function projectDryRunReview(
  dryRun: ArtifactReviewReadSnapshot["dryRun"],
): InboxArtifactReviewSnapshot["dryRun"] {
  if (dryRun.status === "not_run") {
    return { status: "not_run", writesPerformed: false };
  }
  return {
    status: dryRun.status,
    ...(dryRun.resultId === undefined ? {} : { resultId: dryRun.resultId }),
    ...(dryRun.inputIdentity === undefined ? {} : { inputIdentity: dryRun.inputIdentity }),
    ...(dryRun.compileAttestationId === undefined ? {} : { compileAttestationId: dryRun.compileAttestationId }),
    ...(dryRun.compileInputIdentity === undefined ? {} : { compileInputIdentity: dryRun.compileInputIdentity }),
    ...(dryRun.compiler === undefined ? {} : { compiler: { id: dryRun.compiler.id, version: dryRun.compiler.version } }),
    checkedWatermarks: dryRun.checkedWatermarks.map(projectReviewWatermark),
    actionAuthorityBindings: dryRun.actionAuthorityBindings.map(projectAuthorityBinding),
    diff: projectReviewDiff(dryRun.diff),
    conflicts: projectReviewConflicts(dryRun.conflicts),
    writesPerformed: false,
    ...(dryRun.summary === undefined ? {} : { summary: dryRun.summary }),
  };
}

function projectReviewWatermark(
  watermark: ReviewWatermark,
): ReviewWatermark {
  return {
    bridgeId: watermark.bridgeId,
    epochId: watermark.epochId,
    lastSeq: watermark.lastSeq,
    freshness: watermark.freshness,
    gapCount: watermark.gapCount,
  };
}

function projectAuthorityBinding(
  binding: ReviewAuthorityBinding,
): ReviewAuthorityBinding {
  return {
    actionOrder: binding.actionOrder,
    kind: binding.kind,
    hwCapabilityId: binding.hwCapabilityId,
    actionAuthorityCandidateId: binding.actionAuthorityCandidateId,
  };
}

function projectReviewDiff(
  diff: ReviewDiff,
): ReviewDiff {
  return {
    status: diff.status,
    operations: diff.operations.map((operation) => {
      if (operation.kind === "notify_local") {
        return {
          actionOrder: operation.actionOrder,
          kind: operation.kind,
          ...(operation.after === undefined ? {} : { after: operation.after }),
        };
      }
      return {
        actionOrder: operation.actionOrder,
        kind: operation.kind,
        hwCapabilityId: operation.hwCapabilityId,
        actionAuthorityCandidateId: operation.actionAuthorityCandidateId,
        ...(operation.before === undefined ? {} : { before: operation.before }),
        ...(operation.after === undefined ? {} : { after: operation.after }),
      };
    }),
    unchangedCount: diff.unchangedCount,
    redacted: true,
  };
}

function projectReviewConflicts(
  conflicts: ReviewConflicts,
): ReviewConflicts {
  return {
    status: conflicts.status,
    findings: conflicts.findings.map((finding) => ({
      kind: finding.kind,
      severity: finding.severity,
      ...(finding.hwCapabilityId === undefined ? {} : { hwCapabilityId: finding.hwCapabilityId }),
      ...(finding.reference === undefined ? {} : { reference: finding.reference }),
      reason: finding.reason,
    })),
  };
}
