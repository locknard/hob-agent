import { Context, Service } from "@deepseek-ai/cordis";
import { createHash } from "node:crypto";

import type {
  IngestJournal,
  IngestJournalRetentionEvidenceReference,
  IngestJournalRetentionPolicy,
  IngestJournalRetentionResult,
  JournalCapacityStatus,
} from "./world/ingest-journal.js";
import { MAX_PROPOSAL_RETENTION_REFERENCES } from "./proposal-store.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeRetention: HomeRetentionService;
  }
}

export interface HomeRetentionServiceOptions {
  readonly now?: () => string;
}

export interface HomeRetentionRequest {
  readonly bridgeId: string;
  /** In-process trusted operator context only; not an HTTP, agent, or UI field. */
  readonly requestedBy: string;
  readonly reason: string;
  readonly evidenceWindowMs?: number;
}

export type HomeRetentionCoverageStatus = "complete" | "partial" | "degraded" | "unavailable";

export interface HomeRetentionOperationalBridgeStatus {
  readonly bridgeId: string;
  readonly status: "ready" | "attention" | "unavailable";
  readonly capacity?: JournalCapacityStatus;
  readonly coverage: {
    readonly status: HomeRetentionCoverageStatus;
    readonly coverageFloor?: string;
  };
  readonly lastRetention?: {
    readonly appliedAt: string;
    readonly result: "complete" | "partial";
    readonly bytesDeleted: number;
  };
}

export interface HomeRetentionOperationalStatus {
  readonly status: "ready" | "attention" | "unavailable";
  readonly capacity: JournalCapacityStatus;
  readonly bridges: readonly HomeRetentionOperationalBridgeStatus[];
}

export interface RetentionProposalEvidenceSource {
  withRetentionEvidence<T>(
    bridgeId: string,
    limit: number,
    operation: (references: readonly IngestJournalRetentionEvidenceReference[]) => T,
  ): T;
}

export interface RetentionJournalSource {
  journal(bridgeId: string): IngestJournal | undefined;
  bridgeIds?(): readonly string[];
}

export type HomeRetentionErrorCode =
  | "invalid_request"
  | "bridge_unavailable"
  | "proposal_source_failure"
  | "invalid_proposal_evidence"
  | "journal_failure";

export class HomeRetentionError extends Error {
  constructor(readonly code: HomeRetentionErrorCode, message: string) {
    super(message);
    this.name = "HomeRetentionError";
  }
}

const DEFAULT_EVIDENCE_WINDOW_MS = 168 * 60 * 60 * 1_000;
const MAX_EVIDENCE_WINDOW_MS = 366 * 24 * 60 * 60 * 1_000;
/** Warn before quota exhaustion so an operator has room for a governed run. */
export const HOME_RETENTION_CAPACITY_WARNING_RATIO = 0.9;
const ALLOWED_REQUEST_KEYS = new Set([
  "bridgeId",
  "requestedBy",
  "reason",
  "evidenceWindowMs",
]);

export interface RetentionCoordinatorOptions {
  readonly now?: () => string;
}

/**
 * Explicit retention coordinator. Proposal evidence is obtained only through
 * the Hub-owned durable source callback; callers never provide pin references.
 */
export class RetentionCoordinator {
  private readonly now: () => string;

  constructor(
    private readonly journals: RetentionJournalSource,
    private readonly proposals: RetentionProposalEvidenceSource,
    options: RetentionCoordinatorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  retain(request: HomeRetentionRequest): IngestJournalRetentionResult {
    return this.run(request, "apply");
  }

  preview(request: HomeRetentionRequest): IngestJournalRetentionResult {
    return this.run(request, "preview");
  }

  private run(request: HomeRetentionRequest, mode: "preview" | "apply"): IngestJournalRetentionResult {
    const normalized = normalizeRequest(request, this.now);
    const journal = this.journals.journal(normalized.bridgeId);
    const operation = mode === "preview" ? journal?.previewRetention : journal?.applyRetention;
    if (journal === undefined || typeof operation !== "function") {
      throw new HomeRetentionError("bridge_unavailable", "Retention journal is unavailable");
    }

    try {
      const result = this.proposals.withRetentionEvidence(
        normalized.bridgeId,
        MAX_PROPOSAL_RETENTION_REFERENCES,
        (references) => {
          const proposalEvidence = validateProposalEvidence(references, normalized.bridgeId);
          const policy: IngestJournalRetentionPolicy = {
            policyId: policyId(normalized),
            bridgeId: normalized.bridgeId,
            requestedAt: normalized.requestedAt,
            requestedBy: normalized.requestedBy,
            reason: normalized.reason,
            ...(normalized.evidenceWindowMs === undefined ? {} : { evidenceWindowMs: normalized.evidenceWindowMs }),
            proposalEvidence,
          };
          try {
            return operation.call(journal, policy);
          } catch {
            throw new HomeRetentionError("journal_failure", "Retention journal operation failed");
          }
        },
      );
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new HomeRetentionError("proposal_source_failure", "Durable proposal evidence is unavailable");
      }
      return result;
    } catch (error) {
      if (error instanceof HomeRetentionError) throw error;
      throw new HomeRetentionError("proposal_source_failure", "Durable proposal evidence is unavailable");
    }
  }

  status(bridgeIds: readonly string[] = this.journals.bridgeIds?.() ?? []): HomeRetentionOperationalStatus {
    const ids = [...new Set(bridgeIds)].sort();
    const bridges = ids.map((bridgeId) => retentionBridgeStatus(this.journals.journal(bridgeId), bridgeId));
    const capacity = bridges.reduce((total, bridge) => ({
      usedBytes: total.usedBytes + (bridge.capacity?.usedBytes ?? 0),
      maxBytes: total.maxBytes + (bridge.capacity?.maxBytes ?? 0),
      remainingBytes: total.remainingBytes + (bridge.capacity?.remainingBytes ?? 0),
    }), { usedBytes: 0, maxBytes: 0, remainingBytes: 0 });
    return {
      status: ids.length === 0
        ? "unavailable"
        : bridges.every((bridge) => bridge.status === "ready") ? "ready" : "attention",
      capacity,
      bridges,
    };
  }
}

export class HomeRetentionService extends Service {
  static inject = ["homeWorld", "homeProposals"];

  private readonly coordinator: RetentionCoordinator;

  constructor(ctx: Context, options: HomeRetentionServiceOptions = {}) {
    super(ctx, "homeRetention");
    this.coordinator = new RetentionCoordinator(
      ctx.get("homeWorld") as unknown as RetentionJournalSource,
      ctx.get("homeProposals") as unknown as RetentionProposalEvidenceSource,
      options,
    );
  }

  retain(request: HomeRetentionRequest): IngestJournalRetentionResult {
    return this.coordinator.retain(request);
  }

  preview(request: HomeRetentionRequest): IngestJournalRetentionResult {
    return this.coordinator.preview(request);
  }

  status(): HomeRetentionOperationalStatus {
    return this.coordinator.status();
  }
}

function normalizeRequest(
  request: HomeRetentionRequest,
  now: () => string,
): {
  readonly bridgeId: string;
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly evidenceWindowMs?: number;
} {
  if (!request || typeof request !== "object") {
    throw new HomeRetentionError("invalid_request", "Invalid retention request");
  }
  if (Object.keys(request as object).some((key) => !ALLOWED_REQUEST_KEYS.has(key))) {
    throw new HomeRetentionError("invalid_request", "Invalid retention request");
  }
  const bridgeId = boundedString(request.bridgeId, 200);
  const requestedBy = boundedString(request.requestedBy, 200);
  const reason = boundedString(request.reason, 1_000);
  const requestedAt = normalizeTimestamp(now());
  if (request.evidenceWindowMs !== undefined
    && (!Number.isSafeInteger(request.evidenceWindowMs)
      || request.evidenceWindowMs < DEFAULT_EVIDENCE_WINDOW_MS
      || request.evidenceWindowMs > MAX_EVIDENCE_WINDOW_MS)) {
    throw new HomeRetentionError("invalid_request", "Invalid retention request");
  }
  return {
    bridgeId,
    requestedAt,
    requestedBy,
    reason,
    ...(request.evidenceWindowMs === undefined ? {} : { evidenceWindowMs: request.evidenceWindowMs }),
  };
}

function validateProposalEvidence(
  references: readonly IngestJournalRetentionEvidenceReference[],
  bridgeId: string,
): readonly IngestJournalRetentionEvidenceReference[] {
  if (!Array.isArray(references) || references.length > MAX_PROPOSAL_RETENTION_REFERENCES) {
    throw new HomeRetentionError("invalid_proposal_evidence", "Durable proposal evidence is unbounded");
  }
  const referenceIds = new Set<string>();
  return references.map((reference) => {
    if (!reference || typeof reference !== "object") {
      throw new HomeRetentionError("invalid_proposal_evidence", "Durable proposal evidence is invalid");
    }
    const referenceId = boundedString(reference.referenceId, 200, "invalid_proposal_evidence");
    const referenceBridgeId = boundedString(reference.bridgeId, 200, "invalid_proposal_evidence");
    const epochId = boundedString(reference.epochId, 200, "invalid_proposal_evidence");
    if (referenceBridgeId !== bridgeId) {
      throw new HomeRetentionError("invalid_proposal_evidence", "Durable proposal evidence crosses bridges");
    }
    if (referenceIds.has(referenceId)) {
      throw new HomeRetentionError("invalid_proposal_evidence", "Durable proposal evidence is duplicated");
    }
    if (!Number.isSafeInteger(reference.seq) || reference.seq < 0) {
      throw new HomeRetentionError("invalid_proposal_evidence", "Durable proposal evidence sequence is invalid");
    }
    referenceIds.add(referenceId);
    return Object.freeze({
      referenceId,
      bridgeId: referenceBridgeId,
      epochId,
      seq: reference.seq,
    });
  });
}

function policyId(request: {
  readonly bridgeId: string;
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly evidenceWindowMs?: number;
}): string {
  const canonical = JSON.stringify({
    bridgeId: request.bridgeId,
    requestedAt: request.requestedAt,
    requestedBy: request.requestedBy,
    reason: request.reason,
    evidenceWindowMs: request.evidenceWindowMs ?? null,
  });
  return `retention-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

function boundedString(
  value: unknown,
  max: number,
  code: HomeRetentionErrorCode = "invalid_request",
): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new HomeRetentionError(
      code,
      code === "invalid_proposal_evidence" ? "Durable proposal evidence is invalid" : "Invalid retention request",
    );
  }
  return value.trim();
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) {
    throw new HomeRetentionError("invalid_request", "Invalid retention request");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new HomeRetentionError("invalid_request", "Invalid retention request");
  }
  return new Date(parsed).toISOString();
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  return typeof (value as { readonly then?: unknown }).then === "function";
}

function retentionBridgeStatus(
  journal: IngestJournal | undefined,
  bridgeId: string,
): HomeRetentionOperationalBridgeStatus {
  if (journal === undefined
    || typeof journal.capacity !== "function"
    || typeof journal.coverage !== "function"
    || typeof journal.latestRetentionAudit !== "function") {
    return {
      bridgeId,
      status: "unavailable",
      coverage: { status: "unavailable" },
    };
  }
  try {
    const capacity = journal.capacity();
    if (!isValidRetentionCapacity(capacity)) {
      return {
        bridgeId,
        status: "unavailable",
        coverage: { status: "unavailable" },
      };
    }
    const coverage = journal.coverage(bridgeId);
    const lastAudit = journal.latestRetentionAudit(bridgeId);
    const coverageStatus: HomeRetentionCoverageStatus = coverage.openHistoryGapCount > 0
      ? "degraded"
      : coverage.partial ? "partial" : "complete";
    const capacityAttention = capacity.usedBytes / capacity.maxBytes >= HOME_RETENTION_CAPACITY_WARNING_RATIO;
    return {
      bridgeId,
      status: coverageStatus === "complete" && !capacityAttention ? "ready" : "attention",
      capacity,
      coverage: {
        status: coverageStatus,
        ...(coverage.coverageFloor === undefined ? {} : { coverageFloor: coverage.coverageFloor }),
      },
      ...(lastAudit === undefined ? {} : {
        lastRetention: {
          appliedAt: lastAudit.appliedAt,
          result: lastAudit.partialCoverage ? "partial" as const : "complete" as const,
          bytesDeleted: lastAudit.bytesDeleted,
        },
      }),
    };
  } catch {
    return {
      bridgeId,
      status: "unavailable",
      coverage: { status: "unavailable" },
    };
  }
}

function isValidRetentionCapacity(value: JournalCapacityStatus): boolean {
  return Number.isSafeInteger(value.usedBytes)
    && value.usedBytes >= 0
    && Number.isSafeInteger(value.maxBytes)
    && value.maxBytes > 0
    && Number.isSafeInteger(value.remainingBytes)
    && value.remainingBytes >= 0
    && value.usedBytes <= value.maxBytes
    && value.remainingBytes <= value.maxBytes;
}
