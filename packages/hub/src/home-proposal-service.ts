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
    const world = this.ctx.homeWorld as HomeWorldService;
    const snapshot = world.snapshot();
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
    const selected = new Set(input.selectedHwIds);
    const references = snapshot.devices.filter((device) => selected.has(device.hwId)).flatMap((device) => {
      const bridgeId = device.bindings[0]?.bridgeId;
      if (bridgeId === undefined) return [];
      const observedAt = latestObservedAt(device.states.map((state) => state.time.sourceTs), snapshot.generatedAt);
      const capabilities = device.capabilities.length > 0 ? device.capabilities : [undefined];
      return capabilities.map((capability) => ({
        bridgeId,
        hwId: device.hwId,
        ...(capability === undefined ? {} : { capabilityId: capability.hwCapabilityId }),
        observedAt,
      }));
    }).slice(0, 50);
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
      evidence: { references, watermarks },
      conflictCheck: {
        status: conflictAvailable ? "checked" : "unavailable",
        existingAutomationCount: rules.length,
        matches,
      },
      dryRun: { status: "passed", summary: "Review-only proposal; no device or automation was changed." },
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
  readonly risk: Omit<CreateProposalInput["risk"], "requiresHumanApproval">;
  readonly intent: CreateProposalInput["intent"];
}

function validateDraftInput(input: CreateHomeProposalDraftInput): void {
  if (!input || typeof input !== "object") throw new TypeError("home proposal draft is required");
  if (!Array.isArray(input.selectedHwIds) || input.selectedHwIds.length > 20
    || input.selectedHwIds.some((value) => typeof value !== "string" || value.length === 0 || value.length > 200)) {
    throw new TypeError("home proposal selectedHwIds are invalid");
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
