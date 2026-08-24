import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";

const SURVIVAL_WINDOW_DAYS = 30;
const SURVIVAL_WINDOW_MS = SURVIVAL_WINDOW_DAYS * 24 * 60 * 60 * 1_000;
const MAX_PROPOSAL_ROWS = 10_000;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_AUDIT_EVENTS = 512;
const VALID_STATUSES = ["pending_review", "approved", "rejected", "expired"] as const;
const VALID_KINDS = [
  "automation-draft",
  "household-insight",
  "identity-link",
  "capability-binding",
  "action-authority-binding",
] as const;
const VALID_DEPLOYMENT_STATUSES = ["pending", "verified", "failed", "rolled_back"] as const;
const REVIEW_ACTIONS = ["approved", "rejected", "expired"] as const;
const AUDIT_ACTIONS = [
  "created", "approved", "rejected", "expired", "evidence_merged", "snoozed", "snooze_elapsed",
  "prepared", "info_requested", "revalidation_required", "enable_unblocked", "deployment_retried",
  "deployment_verified", "deployment_failed", "recovery_required", "recovery_started", "recovery_failed",
  "drift_detected", "drift_restored", "paused", "resumed", "closed",
] as const;

export type ProposalSuccessMetricsInputRow = {
  readonly proposalId: string;
  readonly status: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly payloadJson: string;
};

export type ProposalSuccessMetricsFailureReason =
  | "proposal_store_unavailable"
  | "proposal_store_corrupt"
  | "invalid_as_of"
  | "missing_audit_history"
  | "ambiguous_audit_history";

export type ProposalSuccessMetricsMissingField =
  | "proposals.payload_json"
  | "proposal.audit"
  | "proposal.audit.approved.at"
  | "proposal.audit.deployment_verified.at"
  | "proposal.audit.state_transition.at";

export interface ProposalSuccessMetricsFailure {
  readonly schemaVersion: "1";
  readonly outcome: "insufficient_evidence";
  readonly asOf: string;
  readonly scope: "automation_proposals";
  readonly readMode: "durable_only";
  readonly reason: ProposalSuccessMetricsFailureReason;
  readonly missingDurableField: ProposalSuccessMetricsMissingField;
  readonly remoteWritesPerformed: false;
  readonly localWritesPerformed: false;
}

export interface ProposalSuccessMetricsReport {
  readonly schemaVersion: "1";
  readonly outcome: "metrics";
  readonly asOf: string;
  readonly scope: "automation_proposals";
  readonly readMode: "durable_only";
  readonly reviewedProposalCount: number;
  readonly enableDecisionCount: number;
  readonly enableRate: number | null;
  readonly unreviewedProposalCount: number;
  readonly excludedProposalCount: number;
  readonly survival: {
    readonly windowDays: 30;
    readonly maturedCohortCount: number;
    readonly immatureCohortCount: number;
    readonly survivingCount: number;
    readonly disabledCount: number;
    readonly closedCount: number;
    readonly rollbackCount: number;
    readonly unknownCount: number;
    readonly evidenceStatus: "not_matured" | "complete" | "unknown_present";
    readonly survivalRate: number | null;
  };
  readonly remoteWritesPerformed: false;
  readonly localWritesPerformed: false;
}

export type ProposalSuccessMetricsResult = ProposalSuccessMetricsReport | ProposalSuccessMetricsFailure;

type AuditAction = typeof AUDIT_ACTIONS[number];
type ReviewAction = typeof REVIEW_ACTIONS[number];
type SurvivalOutcome = "surviving" | "disabled" | "closed" | "rollback" | "unknown";

interface AuditEvent {
  readonly action: AuditAction;
  readonly at: string;
  readonly timestamp: number;
  readonly revision: number;
}

interface ParsedProposal {
  readonly kind: typeof VALID_KINDS[number];
  readonly status: typeof VALID_STATUSES[number];
  readonly audit: readonly AuditEvent[];
  readonly deploymentVerifiedAt?: number;
  readonly deploymentStatus?: typeof VALID_DEPLOYMENT_STATUSES[number];
}

interface ParseFailure {
  readonly reason: ProposalSuccessMetricsFailureReason;
  readonly missingDurableField: ProposalSuccessMetricsMissingField;
}

type ParseResult = { readonly kind: "ok"; readonly value: ParsedProposal } | { readonly kind: "failure"; readonly value: ParseFailure };

/** Aggregates only bounded metadata and historical audit events from Proposal rows. */
export function aggregateProposalSuccessMetrics(
  rows: readonly ProposalSuccessMetricsInputRow[],
  asOf: string,
): ProposalSuccessMetricsResult {
  const asOfTimestamp = parseTimestamp(asOf);
  if (asOfTimestamp === undefined) return insufficient(asOf, "invalid_as_of", "proposals.payload_json");
  if (rows.length > MAX_PROPOSAL_ROWS) return insufficient(asOf, "proposal_store_corrupt", "proposals.payload_json");

  let reviewedProposalCount = 0;
  let enableDecisionCount = 0;
  let unreviewedProposalCount = 0;
  let excludedProposalCount = 0;
  const parsedAutomation: ParsedProposal[] = [];
  for (const row of rows) {
    const rowCreatedAt = parseTimestamp(row.createdAt);
    if (rowCreatedAt === undefined) {
      return insufficient(asOf, "proposal_store_corrupt", "proposals.payload_json");
    }
    if (rowCreatedAt > asOfTimestamp) continue;
    const parsed = parseProposalRow(row);
    if (parsed.kind === "failure") return insufficient(asOf, parsed.value.reason, parsed.value.missingDurableField);
    if (parsed.value.kind !== "automation-draft") {
      excludedProposalCount += 1;
      continue;
    }
    const fullReviewAction = reviewActionFor(parsed.value.audit);
    if (fullReviewAction === "ambiguous") {
      return insufficient(asOf, "ambiguous_audit_history", "proposal.audit.approved.at");
    }
    if (fullReviewAction !== undefined && !statusMatchesReview(parsed.value.status, fullReviewAction)) {
      return insufficient(asOf, "ambiguous_audit_history", "proposal.audit.approved.at");
    }
    const auditAtAsOf = parsed.value.audit.filter((event) => event.timestamp <= asOfTimestamp);
    const reviewAction = reviewActionFor(auditAtAsOf);
    if (reviewAction === "ambiguous") return insufficient(asOf, "ambiguous_audit_history", "proposal.audit.approved.at");
    if (reviewAction === undefined) {
      if (fullReviewAction === undefined && parsed.value.status !== "pending_review") {
        return insufficient(asOf, "ambiguous_audit_history", "proposal.audit.approved.at");
      }
      unreviewedProposalCount += 1;
    } else {
      reviewedProposalCount += 1;
      if (reviewAction === "approved") enableDecisionCount += 1;
    }
    parsedAutomation.push({ ...parsed.value, audit: auditAtAsOf });
  }

  let maturedCohortCount = 0;
  let immatureCohortCount = 0;
  let survivingCount = 0;
  let disabledCount = 0;
  let closedCount = 0;
  let rollbackCount = 0;
  let unknownCount = 0;
  for (const proposal of parsedAutomation) {
    const deploymentVerifiedAt = proposal.audit.find((event) => event.action === "deployment_verified")?.timestamp;
    if (deploymentVerifiedAt === undefined) continue;
    const maturityAt = deploymentVerifiedAt + SURVIVAL_WINDOW_MS;
    if (maturityAt > asOfTimestamp) {
      immatureCohortCount += 1;
      continue;
    }
    maturedCohortCount += 1;
    const outcome = classifySurvivalAt(proposal.audit, maturityAt, proposal.deploymentStatus);
    if (outcome === "surviving") survivingCount += 1;
    else if (outcome === "disabled") disabledCount += 1;
    else if (outcome === "closed") closedCount += 1;
    else if (outcome === "rollback") rollbackCount += 1;
    else unknownCount += 1;
  }

  const evidenceStatus = maturedCohortCount === 0
    ? "not_matured" as const
    : unknownCount === 0 ? "complete" as const : "unknown_present" as const;
  return {
    schemaVersion: "1",
    outcome: "metrics",
    asOf,
    scope: "automation_proposals",
    readMode: "durable_only",
    reviewedProposalCount,
    enableDecisionCount,
    enableRate: reviewedProposalCount === 0 ? null : enableDecisionCount / reviewedProposalCount,
    unreviewedProposalCount,
    excludedProposalCount,
    survival: {
      windowDays: SURVIVAL_WINDOW_DAYS,
      maturedCohortCount,
      immatureCohortCount,
      survivingCount,
      disabledCount,
      closedCount,
      rollbackCount,
      unknownCount,
      evidenceStatus,
      survivalRate: maturedCohortCount === 0 || unknownCount > 0 ? null : survivingCount / maturedCohortCount,
    },
    remoteWritesPerformed: false,
    localWritesPerformed: false,
  };
}

/** Opens the existing Proposal SQLite file read-only and never initializes or mutates its schema. */
export function readProposalSuccessMetricsFromPath(
  proposalPath: string,
  asOf: string,
): ProposalSuccessMetricsResult {
  if (!isSafePath(proposalPath)) return insufficient(asOf, "proposal_store_unavailable", "proposals.payload_json");
  const before = readRegularFileMetadata(proposalPath);
  if (before === undefined) return insufficient(asOf, "proposal_store_unavailable", "proposals.payload_json");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(proposalPath, { readOnly: true });
    const rows = db.prepare(`SELECT proposal_id, status, revision, created_at, updated_at, payload_json
      FROM proposals ORDER BY created_at ASC, proposal_id ASC LIMIT ?`).all(MAX_PROPOSAL_ROWS + 1) as Array<Record<string, unknown>>;
    if (readRegularFileMetadata(proposalPath) === undefined || !sameMetadata(before, readRegularFileMetadata(proposalPath))) {
      return insufficient(asOf, "proposal_store_unavailable", "proposals.payload_json");
    }
    const inputRows: ProposalSuccessMetricsInputRow[] = rows.map((row) => ({
      proposalId: String(row.proposal_id ?? ""),
      status: String(row.status ?? ""),
      revision: Number(row.revision),
      createdAt: String(row.created_at ?? ""),
      updatedAt: String(row.updated_at ?? ""),
      payloadJson: typeof row.payload_json === "string" ? row.payload_json : "",
    }));
    return aggregateProposalSuccessMetrics(inputRows, asOf);
  } catch {
    return insufficient(asOf, "proposal_store_corrupt", "proposals.payload_json");
  } finally {
    db?.close();
  }
}

function parseProposalRow(row: ProposalSuccessMetricsInputRow): ParseResult {
  if (!isBoundedText(row.proposalId, 256)
    || !VALID_STATUSES.includes(row.status as typeof VALID_STATUSES[number])
    || !Number.isSafeInteger(row.revision) || row.revision < 1
    || !isTimestamp(row.createdAt) || !isTimestamp(row.updatedAt)
    || typeof row.payloadJson !== "string"
    || Buffer.byteLength(row.payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
    return { kind: "failure", value: { reason: "proposal_store_corrupt", missingDurableField: "proposals.payload_json" } };
  }
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.payloadJson) as unknown;
    if (!isRecord(parsed)) throw new Error("not object");
    payload = parsed;
  } catch {
    return { kind: "failure", value: { reason: "proposal_store_corrupt", missingDurableField: "proposals.payload_json" } };
  }
  if (payload.id !== row.proposalId
    || payload.status !== row.status
    || payload.revision !== row.revision
    || payload.createdAt !== row.createdAt
    || payload.updatedAt !== row.updatedAt
    || !VALID_KINDS.includes(payload.kind as typeof VALID_KINDS[number])) {
    return { kind: "failure", value: { reason: "proposal_store_corrupt", missingDurableField: "proposals.payload_json" } };
  }
  const auditRaw = payload.audit;
  if (!Array.isArray(auditRaw)) {
    return { kind: "failure", value: { reason: "missing_audit_history", missingDurableField: "proposal.audit" } };
  }
  if (auditRaw.length === 0 || auditRaw.length > MAX_AUDIT_EVENTS) {
    return { kind: "failure", value: { reason: "ambiguous_audit_history", missingDurableField: "proposal.audit" } };
  }
  const audit: AuditEvent[] = [];
  let previousTimestamp = -Infinity;
  let previousRevision = 0;
  for (const candidate of auditRaw) {
    const candidateRevision: number | undefined = isRecord(candidate) && typeof candidate.revision === "number"
      ? candidate.revision
      : undefined;
    if (!isRecord(candidate)
      || typeof candidate.action !== "string"
      || !AUDIT_ACTIONS.includes(candidate.action as AuditAction)
      || typeof candidate.at !== "string"
      || candidateRevision === undefined
      || !Number.isSafeInteger(candidateRevision)
      || candidateRevision <= previousRevision) {
      return { kind: "failure", value: { reason: "ambiguous_audit_history", missingDurableField: "proposal.audit.state_transition.at" } };
    }
    const timestamp = parseTimestamp(candidate.at);
    if (timestamp === undefined || timestamp < previousTimestamp) {
      return { kind: "failure", value: { reason: "ambiguous_audit_history", missingDurableField: "proposal.audit.state_transition.at" } };
    }
    const action = candidate.action as AuditAction;
    audit.push({ action, at: candidate.at, timestamp, revision: candidateRevision });
    previousTimestamp = timestamp;
    previousRevision = candidateRevision;
  }
  if (audit.filter((item) => item.action === "created").length !== 1) {
    return { kind: "failure", value: { reason: "ambiguous_audit_history", missingDurableField: "proposal.audit" } };
  }
  const verifiedEvents = audit.filter((item) => item.action === "deployment_verified");
  const deploymentVerifiedAt = verifiedEvents.length === 0 ? undefined : verifiedEvents.length === 1
    ? verifiedEvents[0].timestamp : undefined;
  if (verifiedEvents.length > 1) {
    return { kind: "failure", value: { reason: "ambiguous_audit_history", missingDurableField: "proposal.audit.deployment_verified.at" } };
  }
  const deployment = payload.deployment;
  if (deployment !== undefined && !isRecord(deployment)) {
    return { kind: "failure", value: { reason: "proposal_store_corrupt", missingDurableField: "proposals.payload_json" } };
  }
  const persistedVerifiedAt = deployment !== undefined && isRecord(deployment) && deployment.verifiedAt !== undefined
    ? parseTimestamp(deployment.verifiedAt) : undefined;
  const deploymentStatus = deployment !== undefined && isRecord(deployment) && deployment.status !== undefined
    ? deployment.status : undefined;
  if (deploymentStatus !== undefined
    && !VALID_DEPLOYMENT_STATUSES.includes(deploymentStatus as typeof VALID_DEPLOYMENT_STATUSES[number])) {
    return { kind: "failure", value: { reason: "proposal_store_corrupt", missingDurableField: "proposals.payload_json" } };
  }
  if (deploymentVerifiedAt !== undefined && persistedVerifiedAt !== deploymentVerifiedAt) {
    return { kind: "failure", value: { reason: "ambiguous_audit_history", missingDurableField: "proposal.audit.deployment_verified.at" } };
  }
  if (persistedVerifiedAt !== undefined && deploymentVerifiedAt === undefined) {
    return { kind: "failure", value: { reason: "missing_audit_history", missingDurableField: "proposal.audit.deployment_verified.at" } };
  }
  return {
    kind: "ok",
    value: {
      kind: payload.kind as typeof VALID_KINDS[number],
      status: payload.status as typeof VALID_STATUSES[number],
      audit,
      ...(deploymentVerifiedAt === undefined ? {} : { deploymentVerifiedAt }),
      ...(deploymentStatus === undefined ? {} : {
        deploymentStatus: deploymentStatus as typeof VALID_DEPLOYMENT_STATUSES[number],
      }),
    },
  };
}

function reviewActionFor(audit: readonly AuditEvent[]): ReviewAction | "ambiguous" | undefined {
  const decisions = audit.filter((event): event is AuditEvent & { readonly action: ReviewAction } =>
    (REVIEW_ACTIONS as readonly string[]).includes(event.action));
  if (decisions.length === 0) return undefined;
  if (decisions.length !== 1) return "ambiguous";
  return decisions[0].action;
}

function statusMatchesReview(status: typeof VALID_STATUSES[number], action: ReviewAction): boolean {
  return status === action;
}

function classifySurvivalAt(
  audit: readonly AuditEvent[],
  maturityAt: number,
  deploymentStatus: typeof VALID_DEPLOYMENT_STATUSES[number] | undefined,
): SurvivalOutcome {
  let verified = false;
  let lifecycle: "active" | "disabled" | "closed" = "active";
  let drifted = false;
  let pausedDuringWindow = false;
  let recoveryObserved = false;
  for (const event of audit) {
    if (event.timestamp > maturityAt) break;
    if (event.action === "deployment_verified") {
      if (verified) return "unknown";
      verified = true;
      lifecycle = "active";
      continue;
    }
    if (!verified) continue;
    if (event.action === "paused") {
      if (lifecycle === "closed") return "unknown";
      pausedDuringWindow = true;
      lifecycle = "disabled";
    } else if (event.action === "resumed") {
      if (lifecycle !== "disabled") return "unknown";
      lifecycle = "active";
    } else if (event.action === "closed") {
      lifecycle = "closed";
    } else if (event.action === "recovery_required" || event.action === "recovery_started" || event.action === "recovery_failed") {
      if (lifecycle === "closed") return "unknown";
      recoveryObserved = true;
    } else if (event.action === "drift_detected") {
      if (lifecycle === "closed") return "unknown";
      drifted = true;
    } else if (event.action === "drift_restored") {
      if (!drifted) return "unknown";
      drifted = false;
    } else if (event.action === "deployment_failed") {
      return "unknown";
    }
  }
  if (!verified || drifted) return "unknown";
  if (lifecycle === "closed") {
    if (recoveryObserved) return deploymentStatus === "rolled_back" ? "rollback" : "unknown";
    return "closed";
  }
  if (recoveryObserved) return "unknown";
  if (pausedDuringWindow) return "disabled";
  return lifecycle === "active" ? "surviving" : "unknown";
}

function insufficient(
  asOf: string,
  reason: ProposalSuccessMetricsFailureReason,
  missingDurableField: ProposalSuccessMetricsMissingField,
): ProposalSuccessMetricsFailure {
  return {
    schemaVersion: "1",
    outcome: "insufficient_evidence",
    asOf,
    scope: "automation_proposals",
    readMode: "durable_only",
    reason,
    missingDurableField,
    remoteWritesPerformed: false,
    localWritesPerformed: false,
  };
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isTimestamp(value: unknown): value is string {
  return parseTimestamp(value) !== undefined;
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafePath(value: string): boolean {
  return isBoundedText(value, 4_096) && isAbsolute(value) && value !== ":memory:" && !/(?:^|[\\/])\.env(?:$|[\\/])/iu.test(value);
}

interface DurableFileMetadata {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function readRegularFileMetadata(path: string): DurableFileMetadata | undefined {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isFile() ? {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    } : undefined;
  } catch {
    return undefined;
  }
}

function sameMetadata(a: DurableFileMetadata | undefined, b: DurableFileMetadata | undefined): boolean {
  return a !== undefined && b !== undefined
    && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
