import { Context, Service } from "@deepseek-ai/cordis";

import {
  SqliteProposalStore,
  type ArtifactPreparationJob,
  type CreateProposalInput,
  type HubVerifiedProposalSource,
  type ProposalEnvelope,
  type ProposalCreationResult,
  type ProposalCalibrationItem,
  type ProposalListQuery,
  type ProposalQualitySummary,
  type ProposalRetentionEvidenceReference,
  type ProposalClearDedupLatchInput,
  type ProposalCloseInput,
  type ProposalDeploymentOutcome,
  type ProposalLifecycleInput,
  type ProposalInfoRequestInput,
  type ProposalDecideInput,
  type ProposalSnoozeInput,
  type ReviewProposalInput,
  type SqliteProposalStoreOptions,
  ProposalStoreError,
} from "./proposal-store.js";
import type { HomeWorldService } from "../world/home-world-service.js";
import {
  parseArtifactContent,
  type ArtifactContent,
} from "../artifact/neutral-artifact.js";

/**
 * The governed seam that turns an approved neutral artifact into a running
 * automation inside an ecosystem bridge. It is the only route from a household
 * decision to persistent behavior, and it never receives bridge-native payloads
 * from callers.
 */
export interface ProposalDeploymentPort {
  deploy(request: {
    readonly proposalId: string;
    readonly revision: number;
    readonly kind: CreateProposalInput["kind"];
    readonly title: string;
    readonly artifactCandidate?: CreateProposalInput["artifactCandidate"];
  }): Promise<ProposalDeploymentOutcome> | ProposalDeploymentOutcome;
  pause?(request: { readonly proposalId: string; readonly deploymentId?: string }): Promise<void> | void;
  resume?(request: { readonly proposalId: string; readonly deploymentId?: string }): Promise<void> | void;
  withdraw?(request: { readonly proposalId: string; readonly deploymentId: string }):
    | Promise<{ readonly restored: boolean }>
    | { readonly restored: boolean };
}

export interface BorrowedHomeProposalServiceOptions {
  readonly store: SqliteProposalStore;
  readonly onPreparationQueued?: (job: ArtifactPreparationJob) => void;
  readonly deployment?: ProposalDeploymentPort;
}

export type HomeProposalServiceOptions =
  | (SqliteProposalStoreOptions & { readonly deployment?: ProposalDeploymentPort })
  | BorrowedHomeProposalServiceOptions;

export interface HomePreparationStatus {
  readonly proposalId: string;
  readonly proposalRevision: number;
  readonly status: ArtifactPreparationJob["status"];
  readonly attempt: number;
  readonly version: number;
  readonly stage?: ArtifactPreparationJob["stage"];
  readonly error?: ArtifactPreparationJob["error"];
  readonly createdAt: string;
  readonly updatedAt: string;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeProposals: HomeProposalService;
  }
}

/** Hub-owned review state. It deliberately exposes no application method. */
export class HomeProposalService extends Service {
  private readonly store: SqliteProposalStore;
  private readonly ownedStore: SqliteProposalStore | undefined;
  private readonly onPreparationQueued: BorrowedHomeProposalServiceOptions["onPreparationQueued"];
  private readonly deployment: ProposalDeploymentPort | undefined;

  constructor(ctx: Context, options: HomeProposalServiceOptions) {
    super(ctx, "homeProposals");
    if ("store" in options) {
      this.store = options.store;
      this.ownedStore = undefined;
      this.onPreparationQueued = options.onPreparationQueued;
      this.deployment = options.deployment;
    } else {
      this.store = new SqliteProposalStore(options);
      this.ownedStore = this.store;
      this.onPreparationQueued = undefined;
      this.deployment = options.deployment;
    }
  }

  protected async [Service.init](): Promise<void> {
    if (this.ownedStore !== undefined) {
      this.ctx.effect(() => () => this.ownedStore?.close(), "home-proposals.close");
    }
  }

  create(input: CreateProposalInput): ProposalEnvelope {
    return this.wakePreparation(this.store.create(input));
  }

  createGoverned(input: CreateProposalInput) {
    const result = this.store.createGoverned(input);
    if (result.kind === "created") this.wakePreparation(result.proposal);
    return result;
  }

  async createDraft(input: CreateHomeProposalDraftInput): Promise<ProposalEnvelope> {
    const result = await this.createDraftGoverned(input);
    if (result.kind === "capacity_full") {
      throw new ProposalStoreError("capacity_full", "Review capacity is full; retry explicitly after a review slot opens");
    }
    if (result.kind === "suppressed") {
      throw new ProposalStoreError("dedup_latched", "This behavior identity has been marked do-not-suggest");
    }
    return result.proposal;
  }

  async createDraftGoverned(input: CreateHomeProposalDraftInput): Promise<ProposalCreationResult> {
    const artifactCandidate = validateDraftInput(input);
    const world = this.ctx.get("homeWorld") as HomeWorldService | undefined;
    if (world === undefined) {
      throw new Error("HomeWorld is required to create a proposal draft");
    }
    const snapshot = world.snapshot();
    const selected = new Set(input.selectedHwIds);
    const selectedDevices = snapshot.devices.filter((device) => selected.has(device.hwId));
    if (selectedDevices.length !== selected.size) {
      throw new TypeError("home proposal selected devices are unavailable");
    }
    if (artifactCandidate !== undefined
      && selectedDevices.some((device) => device.validity !== "valid")) {
      throw new TypeError("home proposal artifact candidate selected devices are not valid");
    }
    const selectedCapabilities = new Map(selectedDevices.flatMap((device) =>
      device.capabilities.map((capability) => [capability.hwCapabilityId, capability] as const)));
    const candidateCapabilityIds = artifactCandidate === undefined
      ? []
      : artifactCapabilityIds(artifactCandidate.content);
    const candidateCapabilityIdSet = new Set(candidateCapabilityIds);
    if (artifactCandidate !== undefined) {
      if (candidateCapabilityIds.some((id) => !selectedCapabilities.has(id))) {
        throw new TypeError("home proposal artifact candidate capabilities must belong to selected devices");
      }
      for (const action of artifactCandidate.content.actions) {
        if (action.kind === "notify_local") continue;
        const authority = world.resolveActionAuthority(action.target.hwCapabilityId);
        if (authority.status !== "available") {
          throw new TypeError("home proposal artifact candidate requires explicit action policy");
        }
        if (authority.policyClass === "administrator") {
          throw new TypeError("home proposal artifact candidate cannot target an administrator policy capability");
        }
      }
      if (input.selectedHwCapabilityIds !== undefined
        && candidateCapabilityIds.some((id) => !input.selectedHwCapabilityIds!.includes(id))) {
        throw new TypeError("home proposal artifact candidate lacks selected temporal evidence");
      }
    }
    const activeSpaceIds = new Set(snapshot.spaces.map((space) => space.hwSpaceId));
    const selectedDeviceSpaceCounts = selectedDevices.map((device) =>
      new Set(device.bindings.flatMap((binding) =>
        binding.hwSpaceId !== undefined && activeSpaceIds.has(binding.hwSpaceId) ? [binding.hwSpaceId] : [])).size);
    const relevantBridgeIds = new Set(selectedDevices.flatMap((device) => [
      ...device.bindings.map((binding) => binding.bridgeId),
      ...device.capabilities.flatMap((capability) =>
        capability.bindings.map((binding) => binding.bridgeId)),
    ]));
    const catalogs = await world.foreignRuleCatalog();
    const catalogsByBridge = new Map(catalogs.map((catalog) => [catalog.bridgeId, catalog]));
    const conflictAvailable = selectedDevices.length === 0
      || (relevantBridgeIds.size > 0
        && [...relevantBridgeIds].every((bridgeId) => catalogsByBridge.get(bridgeId)?.status === "available"));
    const rules = catalogs.flatMap((catalog) =>
      relevantBridgeIds.has(catalog.bridgeId) && catalog.status === "available" ? catalog.rules : []);
    const proposalText = `${input.title} ${input.summary} ${input.intent.description}`;
    const matches = conflictAvailable
      ? rules.filter((rule) => rule.name !== undefined && overlaps(proposalText, rule.name))
        .slice(0, 20)
        .map((rule) => ({ identity: rule.ruleRef, relation: "possible_overlap" as const }))
      : [];
    const diagnostics = new Map(snapshot.diagnostics.map((item) => [item.bridgeId, item]));
    const currentReferenceCandidates: CreateProposalInput["evidence"]["references"] = selectedDevices.flatMap((device) => {
      if (device.capabilities.length === 0) {
        const bridgeId = device.bindings[0]?.bridgeId;
        return bridgeId === undefined ? [] : [{
          bridgeId,
          hwId: device.hwId,
          observedAt: latestObservedAt(device.states.map((state) => state.time.sourceTs), snapshot.generatedAt),
          source: "current-state" as const,
        }];
      }
      return device.capabilities.flatMap((capability) => {
        const binding = capability.bindings[0];
        if (binding === undefined) return [];
        const bindingKeys = new Set(capability.bindings.map((item) =>
          `${item.nativeId}\u0000${item.nativeInstanceId}`));
        const observedAt = latestObservedAt(device.states
          .filter((state) => bindingKeys.has(`${state.nativeId}\u0000${state.nativeInstanceId}`))
          .map((state) => state.time.sourceTs), snapshot.generatedAt);
        return [{
          bridgeId: binding.bridgeId,
          hwId: device.hwId,
          capabilityId: capability.hwCapabilityId,
          observedAt,
          source: "current-state" as const,
        }];
      });
    });
    const candidateCurrentReferences = currentReferenceCandidates.filter((reference) =>
      reference.capabilityId !== undefined && candidateCapabilityIdSet.has(reference.capabilityId));
    const candidateCurrentIds = new Set(candidateCurrentReferences.map((reference) => reference.capabilityId));
    if (candidateCapabilityIds.some((id) => !candidateCurrentIds.has(id))) {
      throw new TypeError("home proposal artifact candidate lacks current capability evidence");
    }
    const temporalEvidence = input.selectedHwCapabilityIds === undefined ? undefined : (() => {
      const selectedCapabilities = new Set(selectedDevices
        .flatMap((device) => device.capabilities.map((capability) => capability.hwCapabilityId)));
      if (input.selectedHwCapabilityIds.some((id) => !selectedCapabilities.has(id))) {
        throw new TypeError("home proposal evidence capabilities must belong to selected devices");
      }
      return world.queryRecentEvidence({
        hwCapabilityIds: input.selectedHwCapabilityIds,
        lookbackHours: input.evidenceLookbackHours!,
        limit: 50,
      });
    })();
    const temporalReferences = temporalEvidence?.events.map((event) => ({
        bridgeId: event.provenance.bridgeId,
        hwId: event.hwId,
        capabilityId: event.hwCapabilityId,
        observedAt: event.observedAt,
        source: "post-baseline-event" as const,
        epochId: event.provenance.epochId,
        seq: event.provenance.seq,
      })) ?? [];
    const temporalCandidateIds = new Set(temporalReferences.flatMap((reference) =>
      candidateCapabilityIdSet.has(reference.capabilityId) ? [reference.capabilityId] : []));
    const missingTemporalCandidateReferences = candidateCurrentReferences.filter((reference) =>
      reference.capabilityId !== undefined && !temporalCandidateIds.has(reference.capabilityId));
    const referenceCandidates = temporalEvidence === undefined
      ? [
          ...candidateCurrentReferences,
          ...currentReferenceCandidates.filter((reference) =>
            reference.capabilityId === undefined || !candidateCapabilityIdSet.has(reference.capabilityId)),
        ]
      : [...missingTemporalCandidateReferences, ...temporalReferences];
    const references = referenceCandidates.slice(0, 50);
    const watermarks = snapshot.bridgeWatermarks.map((watermark) => {
      const diagnostic = diagnostics.get(watermark.bridgeId);
      const bridgeDiagnostic = snapshot.bridges[watermark.bridgeId]?.diagnostics;
      return {
        bridgeId: watermark.bridgeId,
        epochId: watermark.epochId,
        lastSeq: watermark.lastSeq,
        freshness: diagnostic?.connectionState === "ready"
          ? "fresh" as const
          : diagnostic === undefined ? "unknown" as const : "stale" as const,
        gapCount: bridgeDiagnostic?.historyGapCount
          ?? Number((diagnostic as unknown as { historyGapCount?: number } | undefined)?.historyGapCount ?? 0),
      };
    });

    return this.store.createGoverned({
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      ...(input.dedupKey === undefined ? {} : { dedupKey: input.dedupKey }),
      idempotencyKey: input.idempotencyKey,
      provenance: input.provenance,
      evidence: {
        references,
        watermarks,
        ...(temporalEvidence === undefined ? {} : {
          temporal: {
            requestedSince: temporalEvidence.requestedSince,
            requestedUntil: temporalEvidence.requestedUntil,
            truncated: temporalEvidence.truncated,
            coverage: temporalEvidence.coverage.map((item) => ({ ...item, reasons: [...item.reasons] })),
          },
        }),
      },
      conflictCheck: {
        status: conflictAvailable ? "checked" : "unavailable",
        existingAutomationCount: rules.length,
        matches,
      },
      dryRun: {
        status: "not_run",
        summary: "No automation artifact exists yet; execution simulation was not run.",
      },
      risk: { ...input.risk, requiresHumanApproval: true },
      intent: input.intent,
      artifactCandidate,
      rationale: input.rationale,
      spaceCoverage: {
        selectedDevices: selectedDevices.length,
        devicesWithSingleSpace: selectedDeviceSpaceCounts.filter((count) => count === 1).length,
        devicesWithoutSpace: selectedDeviceSpaceCounts.filter((count) => count === 0).length,
        devicesWithMultipleSpaces: selectedDeviceSpaceCounts.filter((count) => count > 1).length,
      },
    });
  }

  get(proposalId: string): ProposalEnvelope | undefined {
    return this.store.get(proposalId);
  }

  list(query?: ProposalListQuery): readonly ProposalEnvelope[] {
    return this.store.list(query);
  }

  proposalCapacity(): ReturnType<SqliteProposalStore["proposalCapacity"]> {
    return this.store.proposalCapacity();
  }

  snoozeProposal(input: ProposalSnoozeInput): ProposalEnvelope {
    return this.store.snoozeProposal(input);
  }

  decideProposal(input: ProposalDecideInput): ProposalEnvelope {
    return this.store.decideProposal(input);
  }

  clearDedupLatch(input: ProposalClearDedupLatchInput) {
    return this.store.clearDedupLatch(input);
  }

  markProposalReady(input: ProposalLifecycleInput): ProposalEnvelope {
    return this.store.markProposalReady(input);
  }

  requestProposalInfo(input: ProposalInfoRequestInput): ProposalEnvelope {
    return this.store.requestProposalInfo(input);
  }

  requestProposalChanges(input: ProposalLifecycleInput): ProposalEnvelope {
    return this.store.requestProposalChanges(input);
  }

  /**
   * Turns the single household decision into a running automation. The decision
   * records `enabling`, the governed deployment seam applies the neutral
   * artifact, and only a verified result reports a running automation. Without a
   * deployment path the proposal fails explicitly instead of appearing to run.
   */
  async enableProposal(input: ProposalLifecycleInput & { readonly reviewer: string }): Promise<ProposalEnvelope> {
    const enabling = this.store.decideProposal({
      proposalId: input.proposalId,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      decision: "approve",
      reviewer: input.reviewer,
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    const outcome = await this.deploy(enabling);
    return this.store.recordProposalDeployment({
      proposalId: enabling.id,
      expectedRevision: enabling.revision,
      actor: input.reviewer,
      outcome,
    });
  }

  private async deploy(proposal: ProposalEnvelope): Promise<ProposalDeploymentOutcome> {
    if (this.deployment === undefined) {
      return { status: "failed", reason: "这个家还没有可用的自动化部署通道，方案已保留，接通后可以重试。" };
    }
    try {
      return await this.deployment.deploy({
        proposalId: proposal.id,
        revision: proposal.revision,
        kind: proposal.kind,
        title: proposal.title,
        artifactCandidate: proposal.artifactCandidate,
      });
    } catch {
      return { status: "failed", reason: "部署没有完成，家里的设置保持原样。" };
    }
  }

  async pauseAutomation(input: ProposalLifecycleInput): Promise<ProposalEnvelope> {
    const current = this.requireDeployed(input.proposalId);
    await this.deployment?.pause?.({ proposalId: current.id, deploymentId: current.deployment?.deploymentId });
    return this.store.pauseAutomation(input);
  }

  async resumeAutomation(input: ProposalLifecycleInput): Promise<ProposalEnvelope> {
    const current = this.requireDeployed(input.proposalId);
    await this.deployment?.resume?.({ proposalId: current.id, deploymentId: current.deployment?.deploymentId });
    return this.store.resumeAutomation(input);
  }

  /** Closing withdraws the automation and restores the configuration it replaced. */
  async closeAutomation(input: ProposalLifecycleInput): Promise<ProposalEnvelope> {
    const current = this.requireDeployed(input.proposalId);
    let restored = false;
    if (this.deployment?.withdraw !== undefined && current.deployment?.deploymentId !== undefined) {
      const result = await this.deployment.withdraw({
        proposalId: current.id,
        deploymentId: current.deployment.deploymentId,
      });
      restored = result?.restored === true;
    }
    const closeInput: ProposalCloseInput = { ...input, restored };
    return this.store.closeAutomation(closeInput);
  }

  private requireDeployed(proposalId: string): ProposalEnvelope {
    const current = this.store.get(proposalId);
    if (current === undefined) throw new ProposalStoreError("not_found", "Proposal was not found");
    return current;
  }

  listDedupLatches() {
    return this.store.listDedupLatches();
  }

  listDedupLatchAudit(limit?: number) {
    return this.store.listDedupLatchAudit(limit);
  }

  qualitySummary(): ProposalQualitySummary {
    return this.store.qualitySummary();
  }

  calibrationHistory(limit?: number): readonly ProposalCalibrationItem[] {
    return this.store.calibrationHistory(limit);
  }

  review(input: ReviewProposalInput): ProposalEnvelope {
    return this.store.review(input);
  }

  /** Preparation is admitted with the proposal, so the runner wakes before any decision. */
  private wakePreparation(proposal: ProposalEnvelope): ProposalEnvelope {
    if (proposal.kind !== "automation-draft"
      || proposal.artifactCandidate === undefined
      || this.onPreparationQueued === undefined) {
      return proposal;
    }
    const job = this.store.getPreparationJobForProposal(proposal.id, proposal.revision);
    if (job !== undefined) {
      try {
        this.onPreparationQueued(job);
      } catch {
        // The durable proposal and job are already committed; wake is best-effort.
      }
    }
    return proposal;
  }

  preparationForProposal(
    proposalId: string,
    proposalRevision: number,
  ): HomePreparationStatus | undefined {
    const job = this.store.getPreparationJobForProposal(proposalId, proposalRevision);
    if (job === undefined) return undefined;
    const error = job.error === undefined ? undefined : Object.freeze({ ...job.error });
    return Object.freeze({
      proposalId: job.proposalId,
      proposalRevision: job.proposalRevision,
      status: job.status,
      attempt: job.attempt,
      version: job.version,
      ...(job.stage === undefined ? {} : { stage: job.stage }),
      ...(error === undefined ? {} : { error }),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  }

  withApprovedProposalAtRevision<T>(
    proposalId: string,
    revision: number,
    operation: (source: HubVerifiedProposalSource) => T,
  ): T {
    return this.store.withApprovedProposalAtRevision(proposalId, revision, operation);
  }

  withRetentionEvidence<T>(
    bridgeId: string,
    limit: number,
    operation: (references: readonly ProposalRetentionEvidenceReference[]) => T,
  ): T {
    return this.store.withRetentionEvidence(bridgeId, limit, operation);
  }
}

export interface CreateHomeProposalDraftInput {
  readonly kind: CreateProposalInput["kind"];
  readonly title: string;
  readonly summary: string;
  /** Stable behavior identity; idempotencyKey remains one producer attempt. */
  readonly dedupKey?: string;
  readonly idempotencyKey: string;
  readonly provenance: CreateProposalInput["provenance"];
  /** Device scope for evidence and coverage; household insights may use an empty scope. */
  readonly selectedHwIds: readonly string[];
  readonly selectedHwCapabilityIds?: readonly string[];
  readonly evidenceLookbackHours?: number;
  readonly risk: Omit<CreateProposalInput["risk"], "requiresHumanApproval">;
  readonly intent: CreateProposalInput["intent"];
  readonly artifactCandidate?: NonNullable<CreateProposalInput["artifactCandidate"]>;
  readonly rationale: NonNullable<CreateProposalInput["rationale"]>;
}

function validateDraftInput(
  input: CreateHomeProposalDraftInput,
): NonNullable<CreateProposalInput["artifactCandidate"]> | undefined {
  if (!input || typeof input !== "object") throw new TypeError("home proposal draft is required");
  if (input.kind === "automation-draft" && input.artifactCandidate === undefined) {
    throw new TypeError("home proposal automation draft requires an artifact candidate");
  }
  if (input.kind !== "automation-draft" && input.artifactCandidate !== undefined) {
    throw new TypeError("home proposal artifact candidate is only valid for automation drafts");
  }
  let artifactCandidate: NonNullable<CreateProposalInput["artifactCandidate"]> | undefined;
  if (input.artifactCandidate !== undefined) {
    if (input.artifactCandidate.schemaVersion !== "1") {
      throw new TypeError("home proposal artifact candidate schema is invalid");
    }
    artifactCandidate = {
      schemaVersion: "1",
      content: parseArtifactContent(input.artifactCandidate.content),
    };
  }
  const rationale = input.rationale;
  if (!rationale || typeof rationale !== "object"
    || !boundedRationaleText(rationale.householdValue)
    || !boundedRationaleText(rationale.whyNow)
    || !Array.isArray(rationale.uncertainties)
    || rationale.uncertainties.length < 1
    || rationale.uncertainties.length > 6
    || rationale.uncertainties.some((value) => !boundedRationaleText(value))) {
    throw new TypeError("home proposal rationale is invalid or unbounded");
  }
  const minSelectedHwIds = input.kind === "household-insight" ? 0 : 1;
  if (!Array.isArray(input.selectedHwIds) || input.selectedHwIds.length < minSelectedHwIds || input.selectedHwIds.length > 20
    || new Set(input.selectedHwIds).size !== input.selectedHwIds.length
    || input.selectedHwIds.some((value) => typeof value !== "string" || value.length === 0 || value.length > 200)) {
    throw new TypeError("home proposal selectedHwIds are invalid");
  }
  const capabilityIds = input.selectedHwCapabilityIds;
  const hasCapabilities = capabilityIds !== undefined;
  const hasLookback = input.evidenceLookbackHours !== undefined;
  if (hasCapabilities !== hasLookback
    || (hasCapabilities && (!Array.isArray(capabilityIds)
      || capabilityIds.length < 1
      || capabilityIds.length > 20
      || new Set(capabilityIds).size !== capabilityIds.length
      || capabilityIds.some((value) => typeof value !== "string" || value.length === 0 || value.length > 200)))
    || (hasLookback && (!Number.isSafeInteger(input.evidenceLookbackHours)
      || input.evidenceLookbackHours! < 1
      || input.evidenceLookbackHours! > 168))) {
    throw new TypeError("home proposal temporal evidence selection is invalid or unbounded");
  }
  return artifactCandidate;
}

function artifactCapabilityIds(content: ArtifactContent): readonly string[] {
  const ids = new Set<string>();
  if (content.trigger.kind === "capability_changed") ids.add(content.trigger.source.hwCapabilityId);
  for (const condition of content.conditions) ids.add(condition.source.hwCapabilityId);
  for (const action of content.actions) {
    if (action.kind !== "notify_local") ids.add(action.target.hwCapabilityId);
  }
  if (content.rollback.kind === "restore_previous_state") ids.add(content.rollback.target.hwCapabilityId);
  for (const postcondition of content.postconditions) ids.add(postcondition.source.hwCapabilityId);
  return [...ids];
}

function boundedRationaleText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1_000;
}

function latestObservedAt(values: readonly (string | undefined)[], fallback: string): string {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.localeCompare(left))[0] ?? fallback;
}

function overlaps(proposal: string, ruleName: string): boolean {
  const proposalTokens = tokens(proposal);
  return [...tokens(ruleName)].some((token) => proposalTokens.has(token));
}

function tokens(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2));
}
