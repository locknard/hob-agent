import { Context, Service } from "@deepseek-ai/cordis";

import {
  SqliteProposalStore,
  type ArtifactPreparationJob,
  type CreateProposalInput,
  type HubVerifiedProposalSource,
  type ProposalEnvelope,
  type ProposalCalibrationItem,
  type ProposalListQuery,
  type ProposalQualitySummary,
  type ProposalRetentionEvidenceReference,
  type ReviewProposalInput,
  type SqliteProposalStoreOptions,
} from "./proposal-store.js";
import type { HomeWorldService } from "./home-world-service.js";
import {
  parseArtifactContent,
  type ArtifactContent,
} from "./neutral-artifact.js";

export interface BorrowedHomeProposalServiceOptions {
  readonly store: SqliteProposalStore;
  readonly onPreparationQueued?: (job: ArtifactPreparationJob) => void;
}

export type HomeProposalServiceOptions =
  | SqliteProposalStoreOptions
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

  constructor(ctx: Context, options: HomeProposalServiceOptions) {
    super(ctx, "homeProposals");
    if ("store" in options) {
      this.store = options.store;
      this.ownedStore = undefined;
      this.onPreparationQueued = options.onPreparationQueued;
    } else {
      this.store = new SqliteProposalStore(options);
      this.ownedStore = this.store;
      this.onPreparationQueued = undefined;
    }
  }

  protected async [Service.init](): Promise<void> {
    if (this.ownedStore !== undefined) {
      this.ctx.effect(() => () => this.ownedStore?.close(), "home-proposals.close");
    }
  }

  create(input: CreateProposalInput): ProposalEnvelope {
    return this.store.create(input);
  }

  async createDraft(input: CreateHomeProposalDraftInput): Promise<ProposalEnvelope> {
    const artifactCandidate = validateDraftInput(input);
    const pending = this.store.list({ status: "pending_review", limit: 1 })[0];
    if (pending !== undefined) {
      if (pending.provenance.producer === input.provenance.producer
        && pending.idempotencyKey === input.idempotencyKey) return pending;
      throw new Error("A household proposal is already pending review");
    }
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
      const unsafeTarget = artifactCandidate.content.actions.some((action) =>
        action.kind !== "notify_local"
        && selectedCapabilities.get(action.target.hwCapabilityId)?.semanticKind === "lock");
      if (unsafeTarget) {
        throw new TypeError("home proposal artifact candidate cannot target a safety-sensitive capability");
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
    const conflictAvailable = relevantBridgeIds.size > 0
      && [...relevantBridgeIds].every((bridgeId) => catalogsByBridge.get(bridgeId)?.status === "available");
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

    return this.store.create({
      kind: input.kind,
      title: input.title,
      summary: input.summary,
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

  qualitySummary(): ProposalQualitySummary {
    return this.store.qualitySummary();
  }

  calibrationHistory(limit?: number): readonly ProposalCalibrationItem[] {
    return this.store.calibrationHistory(limit);
  }

  review(input: ReviewProposalInput): ProposalEnvelope {
    const reviewed = this.store.review(input);
    if (reviewed.status === "approved"
      && reviewed.kind === "automation-draft"
      && reviewed.artifactCandidate !== undefined
      && this.onPreparationQueued !== undefined) {
      const job = this.store.getPreparationJobForProposal(reviewed.id, reviewed.revision);
      if (job !== undefined) {
        try {
          this.onPreparationQueued(job);
        } catch {
          // The durable approval and job are already committed; wake is best-effort.
        }
      }
    }
    return reviewed;
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
  readonly idempotencyKey: string;
  readonly provenance: CreateProposalInput["provenance"];
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
  if (!Array.isArray(input.selectedHwIds) || input.selectedHwIds.length < 1 || input.selectedHwIds.length > 20
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
