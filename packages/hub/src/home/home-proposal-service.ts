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
  type ProposalDeploymentIntent,
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
import { householdCapabilityLabel } from "../world/home-world-service.js";
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
  /**
   * Resolves the deterministic native id and target execution domain for a
   * plan without writing anything, so the approval can persist the intent
   * before the external write happens.
   */
  resolveIntent(request: {
    readonly proposalId: string;
    readonly kind: CreateProposalInput["kind"];
    readonly artifactCandidate?: CreateProposalInput["artifactCandidate"];
    readonly actionPolicyClasses?: readonly string[];
    readonly confirmationDeviceNames?: readonly string[];
  }): ProposalDeploymentIntent
    | { readonly reason: string }
    | { readonly revalidationReason: string; readonly updatedGateDisclosure?: { readonly actionPolicyClasses: readonly ("direct" | "confirmation")[]; readonly confirmationDeviceNames?: readonly string[] } }
    | { readonly blockedKind?: "not_configured" | "not_approved" | "unknown_capability" | "protected"; readonly blockedReason: string };
  deploy(request: {
    readonly proposalId: string;
    readonly revision: number;
    readonly kind: CreateProposalInput["kind"];
    readonly title: string;
    readonly artifactCandidate?: CreateProposalInput["artifactCandidate"];
    readonly intent: ProposalDeploymentIntent;
  }): Promise<ProposalDeploymentOutcome> | ProposalDeploymentOutcome;
  status?(request: { readonly deploymentId: string; readonly target: string }):
    | Promise<{ readonly status: "running" | "paused" | "missing" | "unknown"; readonly configFingerprint?: string }>
    | { readonly status: "running" | "paused" | "missing" | "unknown"; readonly configFingerprint?: string };
  pause?(request: { readonly proposalId: string; readonly deploymentId?: string; readonly target?: string }): Promise<void> | void;
  resume?(request: { readonly proposalId: string; readonly deploymentId?: string; readonly target?: string }): Promise<void> | void;
  withdraw?(request: { readonly proposalId: string; readonly deploymentId: string; readonly target?: string }):
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
    const actionPolicyClasses = new Set<"direct" | "confirmation">();
    const confirmationDeviceNames = new Set<string>();
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
        // Administrator-class actions never enter a native automation. A
        // confirmation-class action may: the enable decision itself is the
        // household's consent (DR-015), and the plan card must disclose it.
        if (authority.policyClass === "administrator") {
          throw new TypeError("home proposal artifact candidate cannot target an administrator policy capability");
        }
        actionPolicyClasses.add(authority.policyClass === "confirmation" ? "confirmation" : "direct");
        if (authority.policyClass === "confirmation") {
          // Named-device authorization is an invariant, not a best effort: a
          // confirmation action the household cannot name cannot be disclosed,
          // so admission fails toward fixing the home map.
          const device = selectedDevices.find((candidateDevice) =>
            candidateDevice.capabilities.some((capability) => capability.hwCapabilityId === action.target.hwCapabilityId));
          const name = device?.name
            ?? householdCapabilityLabel(selectedCapabilities.get(action.target.hwCapabilityId)?.semanticKind);
          if (name === undefined) {
            throw new TypeError("home proposal confirmation action requires a household-readable device name; name the device in the home map first");
          }
          confirmationDeviceNames.add(name);
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

    const governed = this.store.createGoverned({
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      ...(actionPolicyClasses.size === 0 ? {} : { actionPolicyClasses: [...actionPolicyClasses].sort() }),
      ...(confirmationDeviceNames.size === 0 ? {} : { confirmationDeviceNames: [...confirmationDeviceNames].sort().slice(0, 8) }),
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
    // Admission wakes the preparation worker on the governed path — the only
    // production ingress — so a new or revised plan starts preparing at once.
    if (governed.kind === "created" || governed.kind === "merged") this.wakePreparation(governed.proposal);
    return governed;
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

  /**
   * Re-validates every blocked prepared plan against the current world — the
   * follow-up to a configuration change. A block only clears through a fresh
   * successful validation; a plan that stays blocked updates its stated
   * reason, and a changed disclosure re-prepares without spending anything.
   */
  recheckBlockedEnablement(): { readonly rechecked: number; readonly cleared: number } {
    if (this.deployment === undefined) return { rechecked: 0, cleared: 0 };
    const blocked = this.store.list({ status: "pending_review", limit: 200 })
      .filter((proposal) => proposal.lifecycle === "ready" && proposal.enableBlockedReason !== undefined);
    let cleared = 0;
    for (const proposal of blocked) {
      const resolved = this.deployment.resolveIntent({
        proposalId: proposal.id,
        kind: proposal.kind,
        ...(proposal.artifactCandidate === undefined ? {} : { artifactCandidate: proposal.artifactCandidate }),
        ...(proposal.actionPolicyClasses === undefined ? {} : { actionPolicyClasses: proposal.actionPolicyClasses }),
        ...(proposal.confirmationDeviceNames === undefined ? {} : { confirmationDeviceNames: proposal.confirmationDeviceNames }),
      });
      if ("blockedReason" in resolved) {
        if (resolved.blockedReason !== proposal.enableBlockedReason || resolved.blockedKind !== proposal.enableBlockedKind) {
          this.store.markEnableBlocked({
            proposalId: proposal.id,
            actor: "system",
            reason: resolved.blockedReason,
            ...(resolved.blockedKind === undefined ? {} : { kind: resolved.blockedKind }),
          });
        }
        continue;
      }
      if ("revalidationReason" in resolved) {
        this.wakePreparation(this.store.returnToPreparation({
          proposalId: proposal.id,
          actor: "system",
          note: resolved.revalidationReason,
          ...(resolved.updatedGateDisclosure === undefined ? {} : { updatedGateDisclosure: resolved.updatedGateDisclosure }),
        }));
        continue;
      }
      if ("reason" in resolved) continue;
      this.store.clearEnableBlock({ proposalId: proposal.id, actor: "system" });
      cleared += 1;
    }
    return { rechecked: blocked.length, cleared };
  }

  /** Retries a failed enablement through the same governed deployment seam and intent. */
  async retryEnable(input: ProposalLifecycleInput): Promise<ProposalEnvelope> {
    const current = this.store.get(input.proposalId);
    const backfill = current !== undefined
      && current.deployment?.deploymentId === undefined
      && this.deployment !== undefined
      ? this.deployment.resolveIntent({
          proposalId: current.id,
          kind: current.kind,
          ...(current.artifactCandidate === undefined ? {} : { artifactCandidate: current.artifactCandidate }),
          ...(current.actionPolicyClasses === undefined ? {} : { actionPolicyClasses: current.actionPolicyClasses }),
          ...(current.confirmationDeviceNames === undefined ? {} : { confirmationDeviceNames: current.confirmationDeviceNames }),
        })
      : undefined;
    const enabling = this.store.beginDeploymentRetry({
      ...input,
      ...(backfill !== undefined && !("reason" in backfill) && !("revalidationReason" in backfill) && !("blockedReason" in backfill)
        ? { deploymentIntent: backfill }
        : {}),
    });
    const outcome = await this.deploy(enabling);
    return this.store.recordProposalDeployment({
      proposalId: enabling.id,
      expectedRevision: enabling.revision,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      outcome,
    });
  }

  /**
   * Turns the single household decision into a running automation. The decision
   * records `enabling`, the governed deployment seam applies the neutral
   * artifact, and only a verified result reports a running automation. Without a
   * deployment path the proposal fails explicitly instead of appearing to run.
   */
  async enableProposal(input: ProposalLifecycleInput & { readonly reviewer: string }): Promise<ProposalEnvelope> {
    const current = this.store.get(input.proposalId);
    if (current === undefined) throw new ProposalStoreError("not_found", "Proposal was not found");
    const automation = current.kind === "automation-draft" && current.artifactCandidate !== undefined;
    if (automation && this.deployment === undefined) {
      throw new ProposalStoreError("lifecycle_invalid", "这个家还没有可用的自动化部署通道，方案已保留，接通后可以启用。");
    }
    const resolved = automation && this.deployment !== undefined
      ? this.deployment.resolveIntent({
          proposalId: current.id,
          kind: current.kind,
          ...(current.artifactCandidate === undefined ? {} : { artifactCandidate: current.artifactCandidate }),
          ...(current.actionPolicyClasses === undefined ? {} : { actionPolicyClasses: current.actionPolicyClasses }),
          ...(current.confirmationDeviceNames === undefined ? {} : { confirmationDeviceNames: current.confirmationDeviceNames }),
        })
      : undefined;
    if (resolved !== undefined && "blockedReason" in resolved) {
      // The plan can no longer enable; the card says so instead of looping, and
      // the household keeps the revise and decline entries.
      return this.store.markEnableBlocked({
        proposalId: input.proposalId,
        ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
        actor: "system",
        reason: resolved.blockedReason,
        ...(resolved.blockedKind === undefined ? {} : { kind: resolved.blockedKind }),
      });
    }
    if (resolved !== undefined && "revalidationReason" in resolved) {
      // The gate disclosure changed: re-prepare once with the refreshed truth,
      // never spending the household decision on stale facts.
      const demoted = this.store.returnToPreparation({
        proposalId: input.proposalId,
        ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
        actor: "system",
        note: resolved.revalidationReason,
        ...(resolved.updatedGateDisclosure === undefined ? {} : { updatedGateDisclosure: resolved.updatedGateDisclosure }),
      });
      return this.wakePreparation(demoted);
    }
    if (resolved !== undefined && "reason" in resolved) {
      // A passing failure gets its own code so callers can offer a retry
      // without parsing message text.
      throw new ProposalStoreError("enable_temporarily_unavailable", resolved.reason);
    }
    const enabling = this.store.decideProposal({
      proposalId: input.proposalId,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      decision: "approve",
      reviewer: input.reviewer,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(resolved === undefined ? {} : { deploymentIntent: resolved }),
    });
    if (!automation) return enabling;
    const outcome = await this.deploy(enabling);
    return this.store.recordProposalDeployment({
      proposalId: enabling.id,
      expectedRevision: enabling.revision,
      actor: input.reviewer,
      outcome,
    });
  }

  private deploymentIntentOf(proposal: ProposalEnvelope): ProposalDeploymentIntent | undefined {
    const deployment = proposal.deployment;
    return deployment?.deploymentId !== undefined && deployment.target !== undefined && deployment.targets !== undefined
      ? { deploymentId: deployment.deploymentId, target: deployment.target, targets: deployment.targets }
      : undefined;
  }

  private async deploy(proposal: ProposalEnvelope): Promise<ProposalDeploymentOutcome> {
    if (this.deployment === undefined) {
      return { status: "failed", reason: "这个家还没有可用的自动化部署通道，方案已保留，接通后可以重试。" };
    }
    const intent = this.deploymentIntentOf(proposal);
    if (intent === undefined) {
      return { status: "failed", reason: "这次启用缺少部署意图，请重新发起一次。" };
    }
    try {
      return await this.deployment.deploy({
        proposalId: proposal.id,
        revision: proposal.revision,
        kind: proposal.kind,
        title: proposal.title,
        artifactCandidate: proposal.artifactCandidate,
        intent,
      });
    } catch {
      return { status: "failed", reason: "部署没有完成，家里的设置保持原样。" };
    }
  }

  async pauseAutomation(input: ProposalLifecycleInput): Promise<ProposalEnvelope> {
    const current = this.requireDeployed(input.proposalId);
    const paused = this.store.pauseAutomation(input);
    try {
      await this.deployment?.pause?.({
        proposalId: current.id,
        deploymentId: current.deployment?.deploymentId,
        target: current.deployment?.target,
      });
    } catch (error) {
      // The bridge disagreed; read-back reconciliation converges the lifecycle.
      this.store.resumeAutomation({ proposalId: paused.id, actor: "system" });
      throw error;
    }
    return this.store.get(paused.id) ?? paused;
  }

  async resumeAutomation(input: ProposalLifecycleInput): Promise<ProposalEnvelope> {
    const current = this.requireDeployed(input.proposalId);
    const resumed = this.store.resumeAutomation(input);
    try {
      await this.deployment?.resume?.({
        proposalId: current.id,
        deploymentId: current.deployment?.deploymentId,
        target: current.deployment?.target,
      });
    } catch (error) {
      this.store.pauseAutomation({ proposalId: resumed.id, actor: "system" });
      throw error;
    }
    return this.store.get(resumed.id) ?? resumed;
  }

  /** Closing withdraws the automation and restores the configuration it replaced. */
  async closeAutomation(input: ProposalLifecycleInput): Promise<ProposalEnvelope> {
    const current = this.requireDeployed(input.proposalId);
    let restored = false;
    if (this.deployment?.withdraw !== undefined && current.deployment?.deploymentId !== undefined) {
      const result = await this.deployment.withdraw({
        proposalId: current.id,
        deploymentId: current.deployment.deploymentId,
        target: current.deployment.target,
      });
      restored = result?.restored === true;
    }
    const closeInput: ProposalCloseInput = { ...input, restored };
    return this.store.closeAutomation(closeInput);
  }

  /** The household's deployed automations, most recent first. */
  listAutomations(): readonly ProposalEnvelope[] {
    return this.store.list({ status: "approved", limit: 100 })
      .filter((proposal) => proposal.lifecycle === "enabling"
        || proposal.lifecycle === "active"
        || proposal.lifecycle === "paused"
        || proposal.lifecycle === "enable_failed"
        || proposal.lifecycle === "closed")
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  /**
   * Converges local lifecycles with the target bridge, which owns the truth
   * about whether an automation runs. A crash between decision and record
   * heals here: a deployed-but-unrecorded enablement becomes active, a
   * missing one becomes an explicit failure, and a natively toggled or deleted
   * automation is reflected instead of contradicted.
   */
  async reconcileAutomations(): Promise<void> {
    const status = this.deployment?.status;
    if (status === undefined) return;
    for (const proposal of this.listAutomations()) {
      const deployment = proposal.deployment;
      if (deployment?.deploymentId === undefined || deployment.target === undefined) continue;
      if (proposal.lifecycle === "closed") continue;
      let observedResult: { readonly status: "running" | "paused" | "missing" | "unknown"; readonly configFingerprint?: string };
      try {
        observedResult = await status.call(this.deployment, { deploymentId: deployment.deploymentId, target: deployment.target });
      } catch {
        continue;
      }
      const observed = observedResult.status;
      if (observed === "unknown") continue;
      if ((proposal.lifecycle === "active" || proposal.lifecycle === "paused")
        && observedResult.configFingerprint !== undefined
        && deployment.configFingerprint !== undefined) {
        const drifted = observedResult.configFingerprint !== deployment.configFingerprint;
        if (drifted !== (deployment.drifted ?? false)) {
          try {
            this.store.setAutomationDrift({ proposalId: proposal.id, actor: "system", drifted });
          } catch {
            // Another writer converged first; the next pass observes the result.
          }
        }
      }
      try {
        if (proposal.lifecycle === "enabling") {
          if (observed === "running") {
            this.store.recordProposalDeployment({
              proposalId: proposal.id,
              expectedRevision: proposal.revision,
              actor: "system",
              outcome: {
                status: "verified",
                deploymentId: deployment.deploymentId,
                target: deployment.target,
                ...(observedResult.configFingerprint === undefined ? {} : { configFingerprint: observedResult.configFingerprint }),
              },
            });
          } else if (observed === "missing") {
            this.store.recordProposalDeployment({
              proposalId: proposal.id,
              expectedRevision: proposal.revision,
              actor: "system",
              outcome: { status: "failed", reason: "部署没有完成，家里的设置保持原样。" },
            });
          }
        } else if (proposal.lifecycle === "active" && observed === "paused") {
          this.store.pauseAutomation({ proposalId: proposal.id, actor: "system" });
        } else if (proposal.lifecycle === "paused" && observed === "running") {
          this.store.resumeAutomation({ proposalId: proposal.id, actor: "system" });
        } else if ((proposal.lifecycle === "active" || proposal.lifecycle === "paused") && observed === "missing") {
          this.store.closeAutomation({ proposalId: proposal.id, actor: "system", restored: false });
        }
      } catch {
        // Another writer converged first; the next pass observes the result.
      }
    }
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
