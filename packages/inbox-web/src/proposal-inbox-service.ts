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
  type InboxObservationQualitySummary,
  type ProposalInboxPort,
  type ProposalTracePort,
  type InboxHomeAdviceRecord,
} from "./proposal-inbox.js";
import {
  projectControlCenter,
  renderControlCenter as renderControlCenterPage,
  type ControlCenterAgentSource,
  type ControlCenterArtifactSource,
  type ArtifactReviewReadSource,
  type ArtifactReviewReadSnapshot,
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
  private readonly artifactReviewSource?: ArtifactReviewReadSource;
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
    readonly artifacts?: ControlCenterArtifactSource;
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
    const artifacts = ctx.get("homeArtifacts") as unknown as ControlCenterArtifactSource | undefined;
    this.artifactReviewSource = hasArtifactReviewReadSource(artifacts) ? artifacts : undefined;
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
      artifacts,
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
    const detail = this.controller.detail(proposalId);
    if (detail === undefined) return undefined;
    const artifactReview = this.readArtifactReview(detail.proposal.id, detail.proposal.revision);
    return artifactReview === undefined
      ? detail
      : { ...detail, proposal: { ...detail.proposal, artifactReview } };
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

  private readArtifactReview(proposalId: string, proposalRevision: number): InboxArtifactReviewSnapshot | undefined {
    if (this.artifactReviewSource === undefined) return undefined;
    const snapshot = this.artifactReviewSource.reviewForProposal(proposalId, proposalRevision);
    if (snapshot === undefined
      || snapshot.proposal.id !== proposalId
      || snapshot.proposal.revision !== proposalRevision) return undefined;
    return projectArtifactReview(snapshot);
  }
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
