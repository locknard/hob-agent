import { Context, Service } from "@deepseek-ai/cordis";

import {
  SqliteProposalStore,
  type CreateProposalInput,
  type ProposalEnvelope,
  type ProposalListQuery,
  type ReviewProposalInput,
  type SqliteProposalStoreOptions,
} from "./proposal-store.js";
import type { HomeWorldService } from "./home-world-service.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeProposals: HomeProposalService;
  }
}

/** Hub-owned review state. It deliberately exposes no application method. */
export class HomeProposalService extends Service {
  static inject = ["homeWorld"];

  private readonly store: SqliteProposalStore;

  constructor(ctx: Context, options: SqliteProposalStoreOptions) {
    super(ctx, "homeProposals");
    this.store = new SqliteProposalStore(options);
  }

  protected async [Service.init](): Promise<void> {
    this.ctx.effect(() => () => this.store.close(), "home-proposals.close");
  }

  create(input: CreateProposalInput): ProposalEnvelope {
    return this.store.create(input);
  }

  async createDraft(input: CreateHomeProposalDraftInput): Promise<ProposalEnvelope> {
    validateDraftInput(input);
    const pending = this.store.list({ status: "pending_review", limit: 1 })[0];
    if (pending !== undefined) {
      if (pending.provenance.producer === input.provenance.producer
        && pending.idempotencyKey === input.idempotencyKey) return pending;
      throw new Error("A household proposal is already pending review");
    }
    const world = this.ctx.homeWorld as HomeWorldService;
    const snapshot = world.snapshot();
    const selected = new Set(input.selectedHwIds);
    const selectedDevices = snapshot.devices.filter((device) => selected.has(device.hwId));
    if (selectedDevices.length !== selected.size) {
      throw new TypeError("home proposal selected devices are unavailable");
    }
    const catalogs = await world.foreignRuleCatalog();
    const conflictAvailable = catalogs.every((catalog) => catalog.status === "available");
    const rules = catalogs.flatMap((catalog) => catalog.rules);
    const proposalText = `${input.title} ${input.summary} ${input.intent.description}`;
    const matches = conflictAvailable
      ? rules.filter((rule) => rule.name !== undefined && overlaps(proposalText, rule.name))
        .slice(0, 20)
        .map((rule) => ({ identity: rule.ruleRef, relation: "possible_overlap" as const }))
      : [];
    const diagnostics = new Map(snapshot.diagnostics.map((item) => [item.bridgeId, item]));
    const currentReferences = selectedDevices.flatMap((device) => {
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
    }).slice(0, 50);
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
    const references = temporalEvidence === undefined
      ? currentReferences
      : temporalEvidence.events.map((event) => ({
        bridgeId: event.provenance.bridgeId,
        hwId: event.hwId,
        capabilityId: event.hwCapabilityId,
        observedAt: event.observedAt,
        source: "post-baseline-event" as const,
        epochId: event.provenance.epochId,
        seq: event.provenance.seq,
      }));
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
    });
  }

  get(proposalId: string): ProposalEnvelope | undefined {
    return this.store.get(proposalId);
  }

  list(query?: ProposalListQuery): readonly ProposalEnvelope[] {
    return this.store.list(query);
  }

  review(input: ReviewProposalInput): ProposalEnvelope {
    return this.store.review(input);
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
}

function validateDraftInput(input: CreateHomeProposalDraftInput): void {
  if (!input || typeof input !== "object") throw new TypeError("home proposal draft is required");
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
