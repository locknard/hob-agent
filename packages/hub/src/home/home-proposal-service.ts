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
  type MigrationProposalIdentity,
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
import type {
  HomeWorldArtifactPlanPreflightResult,
  HomeWorldService,
} from "../world/home-world-service.js";
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
    | { readonly blockedKind: "not_configured" | "not_approved" | "unknown_capability" | "protected"; readonly blockedReason: string };
  /**
   * Rechecks the approved neutral plan against the current read-side world.
   * The result is deliberately closed and read-only; providers never cross
   * this seam and a blocked result carries only a stable household-neutral
   * reason code.
   */
  preflight?(request: {
    readonly kind: CreateProposalInput["kind"];
    readonly artifactCandidate?: CreateProposalInput["artifactCandidate"];
  }): HomeWorldArtifactPlanPreflightResult | Promise<HomeWorldArtifactPlanPreflightResult>;
  deploy(request: {
    readonly proposalId: string;
    readonly revision: number;
    /** The bounded Hub principal responsible for this deployment attempt. */
    readonly actor: string;
    readonly kind: CreateProposalInput["kind"];
    readonly title: string;
    readonly artifactCandidate?: CreateProposalInput["artifactCandidate"];
    readonly intent: ProposalDeploymentIntent;
  }): Promise<ProposalDeploymentOutcome> | ProposalDeploymentOutcome;
  status?(request: { readonly deploymentId: string; readonly target: string }):
    | Promise<ProposalDeploymentReadback>
    | ProposalDeploymentReadback;
  /** Supplies a workflow-aware readback before generic lifecycle projection. */
  reconcileStatus?(request: {
    readonly proposalId: string;
    readonly lifecycle: ProposalEnvelope["lifecycle"];
    readonly deploymentId: string;
    readonly target: string;
  }): ProposalDeploymentReconciliationResult | Promise<ProposalDeploymentReconciliationResult>;
  /** Allows an ecosystem workflow to keep target-only restart reconciliation read-only. */
  reconciliationGuard?(request: {
    readonly proposalId: string;
    readonly lifecycle: ProposalEnvelope["lifecycle"];
  }): ProposalDeploymentReconciliationDisposition | Promise<ProposalDeploymentReconciliationDisposition>;
  pause?(request: { readonly proposalId: string; readonly deploymentId?: string; readonly target?: string }): Promise<void> | void;
  resume?(request: { readonly proposalId: string; readonly deploymentId?: string; readonly target?: string }): Promise<void> | void;
  withdraw?(request: { readonly proposalId: string; readonly deploymentId: string; readonly target?: string; readonly actor: string }):
    | Promise<{ readonly restored: boolean; readonly recoveryRequired?: boolean; readonly reason?: string }>
    | { readonly restored: boolean; readonly recoveryRequired?: boolean; readonly reason?: string };
  /** Readback-driven restoration for a migration already projected as recovery_required. */
  recover?(request: {
    readonly proposalId: string;
    readonly revision: number;
    readonly actor: string;
    readonly kind: CreateProposalInput["kind"];
    readonly title: string;
    readonly artifactCandidate?: CreateProposalInput["artifactCandidate"];
    readonly intent: ProposalDeploymentIntent;
  }): Promise<{ readonly restored: boolean; readonly recoveryRequired?: boolean; readonly reason?: string }>
    | { readonly restored: boolean; readonly recoveryRequired?: boolean; readonly reason?: string };
}

export type ProposalDeploymentReconciliationDisposition = "allow" | "defer";

export type ProposalDeploymentReadback = {
  readonly status: "running" | "paused" | "missing" | "unknown";
  readonly configFingerprint?: string;
};

export type ProposalDeploymentReconciliationResult =
  | { readonly disposition: "observed"; readonly target: ProposalDeploymentReadback }
  | { readonly disposition: "recovery_required"; readonly reason: string }
  | { readonly disposition: "defer" };

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

type AutomationMutationKind = "retryEnable" | "recoverAutomation" | "closeAutomation";

interface AutomationMutationInFlight {
  readonly kind: AutomationMutationKind;
  readonly promise: Promise<ProposalEnvelope>;
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
  private readonly automationMutationInFlight = new Map<string, AutomationMutationInFlight>();

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
    if (isRecord(input) && Object.prototype.hasOwnProperty.call(input, "sourceRuleRef")) {
      throw new TypeError("Only the Hub-owned migration ingress may select a source rule");
    }
    return this.createDraftGovernedInLane(input, "standard");
  }

  /**
   * The only migration proposal ingress. Its public input has no producer or
   * lane selector; both are owned by this Hub service.
   */
  async createMigrationDraftGoverned(input: CreateHomeMigrationDraftInput): Promise<ProposalCreationResult> {
    if (!isRecord(input)
      || Object.prototype.hasOwnProperty.call(input, "reviewLane")
      || Object.prototype.hasOwnProperty.call(input, "provenance")
      || !isBoundedId(input.sourceRuleRef)) {
      throw new TypeError("Migration review lane is selected by the Hub-owned ingress");
    }
    const { sourceRuleRef, ...draft } = input;
    return this.createDraftGovernedInLane(
      draft as unknown as CreateHomeProposalDraftInput,
      "migration",
      sourceRuleRef,
    );
  }

  private async createDraftGovernedInLane(
    input: CreateHomeProposalDraftInput,
    reviewLane: "standard" | "migration",
    migrationSourceRuleRef?: string,
  ): Promise<ProposalCreationResult> {
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
    const stableCatalogs = catalogs.filter((catalog) => {
      if (!relevantBridgeIds.has(catalog.bridgeId) || catalog.status !== "available"
        || catalog.epochId === undefined || catalog.lastSeq === undefined) return false;
      const watermark = snapshot.watermarkVector?.[catalog.bridgeId]
        ?? snapshot.bridgeWatermarks.find((candidate) => candidate.bridgeId === catalog.bridgeId);
      return watermark?.epochId === catalog.epochId && watermark.lastSeq === catalog.lastSeq;
    });
    const relevantCatalogs = catalogs.filter((catalog) => relevantBridgeIds.has(catalog.bridgeId));
    const conflictAvailable = reviewLane === "migration"
      ? selectedDevices.length === 0
        || (relevantBridgeIds.size > 0 && [...relevantBridgeIds].every((bridgeId) => {
          const rows = relevantCatalogs.filter((catalog) => catalog.bridgeId === bridgeId);
          return rows.length === 1 && stableCatalogs.includes(rows[0]!);
        }))
      : selectedDevices.length === 0
        || (relevantBridgeIds.size > 0
          && [...relevantBridgeIds].every((bridgeId) => catalogsByBridge.get(bridgeId)?.status === "available"));
    const rules = (reviewLane === "migration" ? stableCatalogs : catalogs).flatMap((catalog) =>
      relevantBridgeIds.has(catalog.bridgeId) && catalog.status === "available" ? catalog.rules : []);
    const proposalText = `${input.title} ${input.summary} ${input.intent.description}`;
    let matches: CreateProposalInput["conflictCheck"]["matches"] = [];
    if (reviewLane === "migration") {
      if (!conflictAvailable || migrationSourceRuleRef === undefined) {
        throw new TypeError("Migration source catalog is unavailable");
      }
      const sourceMatches = rules.filter((rule) => rule.ruleRef === migrationSourceRuleRef);
      if (sourceMatches.length !== 1) {
        throw new TypeError("Migration source rule is missing or ambiguous");
      }
      matches = [{ identity: migrationSourceRuleRef, relation: "possible_overlap" }];
    } else if (conflictAvailable) {
      matches = rules.filter((rule) => rule.name !== undefined && overlaps(proposalText, rule.name))
        .slice(0, 20)
        .map((rule) => ({ identity: rule.ruleRef, relation: "possible_overlap" as const }));
    }
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

    const governedInput: CreateProposalInput = {
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      ...(actionPolicyClasses.size === 0 ? {} : { actionPolicyClasses: [...actionPolicyClasses].sort() }),
      ...(confirmationDeviceNames.size === 0 ? {} : { confirmationDeviceNames: [...confirmationDeviceNames].sort().slice(0, 8) }),
      ...(input.dedupKey === undefined ? {} : { dedupKey: input.dedupKey }),
      idempotencyKey: input.idempotencyKey,
      provenance: reviewLane === "migration"
        ? { producer: "home-automation-migration" }
        : input.provenance,
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
    };
    const governed = reviewLane === "migration"
      ? this.store.createMigrationGoverned(governedInput)
      : this.store.createGoverned(governedInput);
    // Admission wakes the preparation worker on the governed path — the only
    // production ingress — so a new or revised plan starts preparing at once.
    if (governed.kind === "created" || governed.kind === "merged") this.wakePreparation(governed.proposal);
    return governed;
  }

  get(proposalId: string): ProposalEnvelope | undefined {
    return this.store.get(proposalId);
  }

  /** Narrow read-only identity lookup reserved for migration restart recovery. */
  findMigrationProposalByIdentity(input: MigrationProposalIdentity): ProposalEnvelope | undefined {
    return this.store.findMigrationProposalByIdentity(input);
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
            kind: resolved.blockedKind,
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
    validateLifecycleInput(input, "deployment retry");
    return this.claimAutomationMutation(input, "retryEnable", () => this.retryEnableOnce(input));
  }

  private async retryEnableOnce(input: ProposalLifecycleInput): Promise<ProposalEnvelope> {
    const current = this.store.get(input.proposalId);
    // A process can restart after approval has persisted `enabling` but before
    // the migration decorator records its switching outcome. Only the
    // Hub-owned migration lane may resume that exact pending decision here;
    // ordinary enabling rows still require the existing failed-enable retry.
    if (current?.lifecycle === "enabling" && current.reviewLane === "migration") {
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        throw new ProposalStoreError("revision_conflict", "Proposal revision has changed");
      }
      const outcome = await this.deploy(current, input.actor ?? "household-owner");
      return this.store.recordProposalDeployment({
        proposalId: current.id,
        expectedRevision: current.revision,
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        outcome,
      });
    }
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
    const outcome = await this.deploy(enabling, input.actor ?? "household-owner");
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
        kind: resolved.blockedKind,
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
    const outcome = await this.deploy(enabling, input.reviewer);
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

  private async deploy(proposal: ProposalEnvelope, actor: string): Promise<ProposalDeploymentOutcome> {
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
        actor,
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
    validateCloseInput(input);
    return this.claimAutomationMutation(input, "closeAutomation", () => this.closeAutomationOnceWithLease(input));
  }

  private async closeAutomationOnceWithLease(input: ProposalLifecycleInput): Promise<ProposalEnvelope> {
    const current = this.requireDeployed(input.proposalId);
    if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
      throw new ProposalStoreError("revision_conflict", "Proposal revision has changed");
    }
    if (current.lifecycle === "recovery_required") {
      throw new ProposalStoreError("lifecycle_invalid", "This migration requires recovery before it can close");
    }
    return this.closeAutomationOnce(input, current);
  }

  private async closeAutomationOnce(
    input: ProposalLifecycleInput,
    current: ProposalEnvelope,
  ): Promise<ProposalEnvelope> {
    let restored = false;
    if (this.deployment?.withdraw !== undefined && current.deployment?.deploymentId !== undefined) {
      const result = await this.deployment.withdraw({
        proposalId: current.id,
        deploymentId: current.deployment.deploymentId,
        target: current.deployment.target,
        actor: input.actor ?? "household-owner",
      });
      if (result?.recoveryRequired === true) {
        return this.store.markRecoveryRequired({
          ...input,
          actor: input.actor ?? "household-owner",
          reason: result.reason ?? "自动化回退结果暂时无法确认，等待继续恢复。",
        });
      }
      restored = result?.restored === true;
    }
    const closeInput: ProposalCloseInput = { ...input, restored };
    return this.store.closeAutomation(closeInput);
  }

  /** Continues one already-decided migration recovery; it never creates a new review decision. */
  async recoverAutomation(input: ProposalLifecycleInput & { readonly actor: string }): Promise<ProposalEnvelope> {
    validateRecoveryInput(input);
    return this.claimAutomationMutation(input, "recoverAutomation", () => this.recoverAutomationOnce(input));
  }

  private async recoverAutomationOnce(input: ProposalLifecycleInput & { readonly actor: string }): Promise<ProposalEnvelope> {
    const current = this.store.get(input.proposalId);
    if (current === undefined) throw new ProposalStoreError("not_found", "Proposal was not found");
    const started = this.store.beginRecoveryAttempt(input);
    const intent = this.deploymentIntentOf(current);
    if (this.deployment?.recover === undefined || intent === undefined) {
      return this.store.recordRecoveryFailure({
        proposalId: started.id,
        expectedRevision: started.revision,
        actor: input.actor,
        reason: "迁移恢复通道不可用，等待继续恢复。",
      });
    }
    let result: Awaited<ReturnType<NonNullable<ProposalDeploymentPort["recover"]>>>;
    try {
      result = await this.deployment.recover({
        proposalId: current.id,
        revision: started.revision,
        actor: input.actor,
        kind: current.kind,
        title: current.title,
        ...(current.artifactCandidate === undefined ? {} : { artifactCandidate: current.artifactCandidate }),
        intent,
      });
    } catch {
      return this.store.recordRecoveryFailure({
        proposalId: started.id,
        expectedRevision: started.revision,
        actor: input.actor,
        reason: "迁移恢复结果暂时无法确认，等待继续恢复。",
      });
    }
    if (result.restored !== true) {
      const reason = typeof result.reason === "string" && result.reason.trim().length > 0 && result.reason.trim().length <= 1_000
        ? result.reason.trim()
        : "迁移恢复没有完成，等待继续恢复。";
      return this.store.recordRecoveryFailure({
        proposalId: started.id,
        expectedRevision: started.revision,
        actor: input.actor,
        reason,
      });
    }
    return this.store.completeRecovery({
      proposalId: started.id,
      expectedRevision: started.revision,
      actor: input.actor,
    });
  }

  private claimAutomationMutation(
    input: ProposalLifecycleInput,
    kind: AutomationMutationKind,
    operation: () => Promise<ProposalEnvelope>,
  ): Promise<ProposalEnvelope> {
    const current = this.store.get(input.proposalId);
    if (current === undefined) throw new ProposalStoreError("not_found", "Proposal was not found");
    if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
      throw new ProposalStoreError("revision_conflict", "Proposal revision has changed");
    }
    const inFlight = this.automationMutationInFlight.get(input.proposalId);
    if (inFlight !== undefined) {
      if (inFlight.kind !== kind) {
        throw new ProposalStoreError("lifecycle_invalid", "Another automation change is already in progress");
      }
      return inFlight.promise;
    }

    // Defer the store transition until the lease is visible. Concurrent valid
    // callers can then join against the same pre-transition revision, while a
    // stale or malformed caller is rejected before it can ride the lease.
    const promise = Promise.resolve().then(operation);
    const owner: AutomationMutationInFlight = { kind, promise };
    this.automationMutationInFlight.set(input.proposalId, owner);
    void promise.finally(() => {
      if (this.automationMutationInFlight.get(input.proposalId) === owner) {
        this.automationMutationInFlight.delete(input.proposalId);
      }
    }).catch(() => {
      // The original operation promise carries the failure to its caller.
    });
    return promise;
  }

  /** The household's deployed automations, most recent first. */
  listAutomations(): readonly ProposalEnvelope[] {
    return this.store.list({ status: "approved", limit: 100 })
      .filter((proposal) => proposal.lifecycle === "enabling"
      || proposal.lifecycle === "active"
      || proposal.lifecycle === "paused"
      || proposal.lifecycle === "enable_failed"
      || proposal.lifecycle === "recovery_required"
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
    const port = this.deployment;
    const status = port?.status;
    if (status === undefined || port === undefined) return;
    for (const proposal of this.listAutomations()) {
      const deployment = proposal.deployment;
      if (proposal.lifecycle === "closed") continue;
      if (port.reconciliationGuard !== undefined) {
        let disposition: ProposalDeploymentReconciliationDisposition;
        try {
          disposition = await port.reconciliationGuard.call(port, {
            proposalId: proposal.id,
            lifecycle: proposal.lifecycle,
          });
        } catch {
          continue;
        }
        if (disposition !== "allow") continue;
      }
      if (deployment?.deploymentId === undefined || deployment.target === undefined) continue;
      let observedResult: ProposalDeploymentReadback;
      if (port.reconcileStatus !== undefined) {
        let reconciliation: ProposalDeploymentReconciliationResult;
        try {
          reconciliation = await port.reconcileStatus.call(port, {
            proposalId: proposal.id,
            lifecycle: proposal.lifecycle,
            deploymentId: deployment.deploymentId,
            target: deployment.target,
          });
        } catch {
          continue;
        }
        if (reconciliation.disposition === "defer") continue;
        if (reconciliation.disposition === "recovery_required") {
          if (proposal.lifecycle === "active" || proposal.lifecycle === "paused") {
            try {
              this.store.markRecoveryRequired({
                proposalId: proposal.id,
                actor: "system",
                reason: reconciliation.reason,
              });
            } catch {
              // Another writer converged first; the next pass observes the result.
            }
          }
          continue;
        }
        observedResult = reconciliation.target;
      } else {
        try {
          observedResult = await status.call(port, { deploymentId: deployment.deploymentId, target: deployment.target });
        } catch {
          continue;
        }
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

/** Migration ingress input: the Hub owns both producer and review-lane fields. */
export type CreateHomeMigrationDraftInput = Omit<CreateHomeProposalDraftInput, "provenance"> & {
  readonly sourceRuleRef: string;
  readonly provenance?: never;
  readonly reviewLane?: never;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 200;
}

function validateLifecycleInput(input: ProposalLifecycleInput, label: string): void {
  if (!isRecord(input)) throw new TypeError(`proposal ${label} is required`);
  if (!isBoundedId(input.proposalId)) throw new TypeError(`proposal ${label} id is invalid`);
  if (input.expectedRevision !== undefined
    && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
    throw new TypeError(`proposal ${label} expectedRevision is invalid`);
  }
  if (input.actor !== undefined && !isBoundedId(input.actor)) {
    throw new TypeError(`proposal ${label} actor is invalid`);
  }
  if (input.note !== undefined
    && (typeof input.note !== "string" || input.note.trim().length === 0 || input.note.length > 1_000)) {
    throw new TypeError(`proposal ${label} note is invalid`);
  }
}

function validateRecoveryInput(input: ProposalLifecycleInput & { readonly actor: string }): void {
  validateLifecycleInput(input, "recovery");
  if (typeof input.actor !== "string" || input.actor.trim().length === 0 || input.actor.length > 200) {
    throw new TypeError("proposal recovery actor is invalid");
  }
}

function validateCloseInput(input: ProposalLifecycleInput): void {
  validateLifecycleInput(input, "close");
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
