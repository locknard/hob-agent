import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";

import { homeAutomationMigrationProposalIdentity } from "./home-automation-migration-preparation.js";
import { computeHomeAutomationMigrationCandidateContentHash } from "./home-automation-migration-simulator.js";

export const HOME_MIGRATION_WORKFLOW_STATUSES = [
  "assessed",
  "translated",
  "simulated",
  "ready",
  "switching",
  "verified",
  "rolling_back",
  "restored",
  "needs_attention",
] as const;

export const HOME_MIGRATION_WORKFLOW_FAILURE_REASONS = [
  "compile_failed",
  "compile_unavailable",
  "simulation_failed",
  "simulation_unavailable",
  "source_stale",
  "switch_failed",
  "switch_unknown",
  "verification_failed",
  "rollback_failed",
  "rollback_unknown",
] as const;

export const HOME_MIGRATION_SELECTION_STATUSES = [
  "issued",
  "processing",
  "prepared",
  "unavailable",
  "expired",
  "invalidated",
] as const;

export const HOME_MIGRATION_PROPOSAL_REVIEW_STATUSES = [
  "pending_review",
  "approved",
  "rejected",
  "expired",
] as const;

export const HOME_MIGRATION_PROPOSAL_LIFECYCLES = [
  "preparing",
  "needs_info",
  "ready",
  "enabling",
  "active",
  "paused",
  "closed",
  "enable_failed",
  "recovery_required",
] as const;

export const HOME_MIGRATION_PROPOSAL_APPLICATION_STATUSES = [
  "not_available",
  "deploying",
  "running",
  "failed",
  "withdrawn",
] as const;

export const HOME_MIGRATION_PROPOSAL_DEPLOYMENT_STATUSES = [
  "absent",
  "pending",
  "verified",
  "failed",
  "rolled_back",
] as const;

/** Bounds one untrusted proposal row before JSON parsing in the status reader. */
export const HOME_MIGRATION_STATUS_MAX_PROPOSAL_PAYLOAD_BYTES = 512 * 1024;

export type HomeMigrationStatusFailureReason =
  | "migration_store_unavailable"
  | "proposal_store_unavailable"
  | "migration_store_corrupt"
  | "proposal_store_corrupt"
  | "assessment_not_found"
  | "cross_store_inconsistent";

export interface HomeAutomationMigrationStatusPaths {
  readonly migrationPath: string;
  readonly proposalPath: string;
}

export interface HomeAutomationMigrationStatusReport {
  readonly schemaVersion: "1";
  readonly outcome: "reported";
  readonly assessmentId: string;
  readonly assessment: {
    readonly status: "discovered" | "assessed" | "needs_attention" | "closed";
    readonly ruleCount: number;
    readonly dispositionCounts: Readonly<Record<"eligible" | "metadata_only" | "unsupported" | "needs_attention", number>>;
    readonly workflowCounts: Readonly<Record<typeof HOME_MIGRATION_WORKFLOW_STATUSES[number], number>>;
    readonly failureCounts: Readonly<Record<typeof HOME_MIGRATION_WORKFLOW_FAILURE_REASONS[number], number>>;
  };
  readonly selectionAudit: {
    readonly total: number;
    readonly statusCounts: Readonly<Record<typeof HOME_MIGRATION_SELECTION_STATUSES[number], number>>;
  };
  readonly proposals: {
    readonly linkedWorkflowCount: number;
    readonly missingProposalCount: number;
    readonly reviewStatusCounts: Readonly<Record<typeof HOME_MIGRATION_PROPOSAL_REVIEW_STATUSES[number], number>>;
    readonly lifecycleCounts: Readonly<Record<typeof HOME_MIGRATION_PROPOSAL_LIFECYCLES[number], number>>;
    readonly applicationStatusCounts: Readonly<Record<typeof HOME_MIGRATION_PROPOSAL_APPLICATION_STATUSES[number], number>>;
    readonly deploymentCounts: Readonly<Record<typeof HOME_MIGRATION_PROPOSAL_DEPLOYMENT_STATUSES[number], number>>;
    readonly consistency: "consistent";
  };
  readonly readMode: "durable_only";
  readonly remoteWritesPerformed: false;
  readonly localWritesPerformed: false;
}

export interface HomeAutomationMigrationStatusFailure {
  readonly schemaVersion: "1";
  readonly outcome: "needs_attention";
  readonly assessmentId: string;
  readonly reason: HomeMigrationStatusFailureReason;
  readonly readMode: "durable_only";
  readonly remoteWritesPerformed: false;
  readonly localWritesPerformed: false;
}

export type HomeAutomationMigrationStatusResult =
  | HomeAutomationMigrationStatusReport
  | HomeAutomationMigrationStatusFailure;

interface WorkflowLink {
  readonly ruleRef: string;
  readonly proposalId: string;
  readonly workflow: ParsedWorkflow;
}

interface MigrationRead {
  readonly migrationId: string;
  readonly sourceBridgeId: string;
  readonly sourceEpochId: string;
  readonly sourceLastSeq: number;
  readonly assessment: HomeAutomationMigrationStatusReport["assessment"];
  readonly selectionAudit: HomeAutomationMigrationStatusReport["selectionAudit"];
  readonly workflowLinks: readonly WorkflowLink[];
}

interface ProposalRead {
  readonly proposals: HomeAutomationMigrationStatusReport["proposals"];
}

/** Reads only existing SQLite files in read-only mode; it never runs schema setup or PRAGMA. */
export function readHomeMigrationStatusFromPaths(
  paths: HomeAutomationMigrationStatusPaths,
  assessmentId: string,
): HomeAutomationMigrationStatusResult {
  if (!isOpaqueId(assessmentId)) throw new TypeError("invalid assessment id");
  if (!isPath(paths?.migrationPath) || !isPath(paths?.proposalPath)) {
    throw new TypeError("home migration status paths are invalid");
  }

  const migration = readMigrationStore(paths.migrationPath, assessmentId);
  if (migration.kind === "failure") return failure(assessmentId, migration.reason);
  if (migration.value.workflowLinks.length === 0) {
    return {
      schemaVersion: "1",
      outcome: "reported",
      assessmentId,
      assessment: migration.value.assessment,
      selectionAudit: migration.value.selectionAudit,
      proposals: emptyProposalAggregate(),
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    };
  }
  const proposals = readProposalStore(paths.proposalPath, migration.value);
  if (proposals.kind === "failure") return failure(assessmentId, proposals.reason);

  return {
    schemaVersion: "1",
    outcome: "reported",
    assessmentId,
    assessment: migration.value.assessment,
    selectionAudit: migration.value.selectionAudit,
    proposals: proposals.value.proposals,
    readMode: "durable_only",
    remoteWritesPerformed: false,
    localWritesPerformed: false,
  };
}

type ReadResult<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "failure"; readonly reason: HomeMigrationStatusFailureReason };

function readMigrationStore(path: string, assessmentId: string): ReadResult<MigrationRead> {
  if (!isRegularFile(path)) return { kind: "failure", reason: "migration_store_unavailable" };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare(`SELECT source_bridge_id, source_epoch_id, source_last_seq, status, rules_json
      FROM home_automation_migrations WHERE migration_id = ?`).get(assessmentId) as Row | undefined;
    if (row === undefined) return { kind: "failure", reason: "assessment_not_found" };
    const parsed = parseMigrationRow(row);
    if (parsed === undefined) return { kind: "failure", reason: "migration_store_corrupt" };

    const selectionRows = db.prepare(`SELECT status, COUNT(*) AS count
      FROM home_automation_migration_selections WHERE migration_id = ? GROUP BY status`).all(assessmentId) as Row[];
    const selectionAudit = parseSelectionCounts(selectionRows);
    if (selectionAudit === undefined) return { kind: "failure", reason: "migration_store_corrupt" };
    return {
      kind: "ok",
      value: {
        migrationId: assessmentId,
        sourceBridgeId: parsed.sourceBridgeId,
        sourceEpochId: parsed.sourceEpochId,
        sourceLastSeq: parsed.sourceLastSeq,
        assessment: parsed.assessment,
        workflowLinks: parsed.workflowLinks,
        selectionAudit,
      },
    };
  } catch (error) {
    return { kind: "failure", reason: isMissingPathError(error) ? "migration_store_unavailable" : "migration_store_corrupt" };
  } finally {
    try { db?.close(); } catch { /* preserve the fixed result */ }
  }
}

function readProposalStore(path: string, migration: MigrationRead): ReadResult<ProposalRead> {
  if (!isRegularFile(path)) return { kind: "failure", reason: "proposal_store_unavailable" };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    // Probe the schema even when this assessment has not linked a Proposal.
    db.prepare(`SELECT proposal_id, producer, idempotency_key, revision, status,
        created_at, updated_at, payload_json FROM proposals WHERE 1 = 0`).all();
    const ids = migration.workflowLinks.map((link) => link.proposalId);
    const uniqueIds = [...new Set(ids)];
    const rows = uniqueIds.length === 0
      ? []
      : db.prepare(`SELECT proposal_id, producer, idempotency_key, revision, status,
          created_at, updated_at, payload_json FROM proposals
          WHERE proposal_id IN (${uniqueIds.map(() => "?").join(",")})`).all(...uniqueIds) as Row[];
    const byId = new Map<string, ParsedProposal>();
    for (const row of rows) {
      const proposal = parseProposalRow(row);
      if (proposal === undefined || byId.has(proposal.id)) return { kind: "failure", reason: "proposal_store_corrupt" };
      byId.set(proposal.id, proposal);
    }

    const reviewStatusCounts = zeroCounts(HOME_MIGRATION_PROPOSAL_REVIEW_STATUSES);
    const lifecycleCounts = zeroCounts(HOME_MIGRATION_PROPOSAL_LIFECYCLES);
    const applicationStatusCounts = zeroCounts(HOME_MIGRATION_PROPOSAL_APPLICATION_STATUSES);
    const deploymentCounts = zeroCounts(HOME_MIGRATION_PROPOSAL_DEPLOYMENT_STATUSES);
    let missingProposalCount = 0;
    const seen = new Set<string>();
    for (const link of migration.workflowLinks) {
      if (seen.has(link.proposalId)) return { kind: "failure", reason: "cross_store_inconsistent" };
      seen.add(link.proposalId);
      const proposal = byId.get(link.proposalId);
      if (proposal === undefined) {
        missingProposalCount += 1;
        continue;
      }
      if (!proposalCoherent(migration, link, proposal)) return { kind: "failure", reason: "cross_store_inconsistent" };
      reviewStatusCounts[proposal.status] += 1;
      lifecycleCounts[proposal.lifecycle] += 1;
      applicationStatusCounts[proposal.applicationStatus] += 1;
      deploymentCounts[proposal.deploymentStatus] += 1;
    }
    if (missingProposalCount > 0) return { kind: "failure", reason: "cross_store_inconsistent" };
    return {
      kind: "ok",
      value: {
        proposals: {
          linkedWorkflowCount: migration.workflowLinks.length,
          missingProposalCount: 0,
          reviewStatusCounts,
          lifecycleCounts,
          applicationStatusCounts,
          deploymentCounts,
          consistency: "consistent",
        },
      },
    };
  } catch (error) {
    return { kind: "failure", reason: isMissingPathError(error) ? "proposal_store_unavailable" : "proposal_store_corrupt" };
  } finally {
    try { db?.close(); } catch { /* preserve the fixed result */ }
  }
}

interface ParsedMigration {
  readonly sourceBridgeId: string;
  readonly sourceEpochId: string;
  readonly sourceLastSeq: number;
  readonly assessment: MigrationRead["assessment"];
  readonly workflowLinks: readonly WorkflowLink[];
}

function parseMigrationRow(row: Row): ParsedMigration | undefined {
  if (!isAssessmentStatus(row.status)
    || !isBoundedText(row.source_bridge_id, 200)
    || !isBoundedText(row.source_epoch_id, 256)
    || !isPositiveSafeInteger(row.source_last_seq)
    || typeof row.rules_json !== "string"
    || Buffer.byteLength(row.rules_json, "utf8") > 64 * 1024) return undefined;
  let rules: unknown;
  try { rules = JSON.parse(row.rules_json); } catch { return undefined; }
  if (!Array.isArray(rules) || rules.length > 256) return undefined;

  const dispositionCounts = zeroCounts(["eligible", "metadata_only", "unsupported", "needs_attention"] as const);
  const workflowCounts = zeroCounts(HOME_MIGRATION_WORKFLOW_STATUSES);
  const failureCounts = zeroCounts(HOME_MIGRATION_WORKFLOW_FAILURE_REASONS);
  const workflowLinks: WorkflowLink[] = [];
  for (const rule of rules) {
    if (!isRecord(rule) || !isBoundedText(rule.ruleRef, 200) || !isDisposition(rule.disposition)) return undefined;
    dispositionCounts[rule.disposition] += 1;
    if (rule.disposition !== "eligible") {
      if (rule.workflow !== undefined) return undefined;
      continue;
    }
    const workflow = parseWorkflow(rule.workflow, rule.sourceFingerprint);
    if (workflow === undefined) return undefined;
    const status = workflow.status;
    workflowCounts[status] += 1;
    if (status === "needs_attention") {
      if (workflow.failureReason === undefined) return undefined;
      failureCounts[workflow.failureReason] += 1;
    }
    if (workflow.proposalId !== undefined) {
      workflowLinks.push({ ruleRef: rule.ruleRef, proposalId: workflow.proposalId, workflow });
    } else if (status !== "assessed") {
      return undefined;
    }
  }
  return {
    sourceBridgeId: row.source_bridge_id,
    sourceEpochId: row.source_epoch_id,
    sourceLastSeq: row.source_last_seq,
    assessment: {
      status: row.status,
      ruleCount: rules.length,
      dispositionCounts,
      workflowCounts,
      failureCounts,
    },
    workflowLinks,
  };
}

interface ParsedWorkflow {
  readonly status: typeof HOME_MIGRATION_WORKFLOW_STATUSES[number];
  readonly sourceFingerprint: string;
  readonly assessedAt: string;
  readonly proposalId?: string;
  readonly candidateProposalRevision?: number;
  readonly candidateContentHash?: string;
  readonly artifactId?: string;
  readonly artifactRevision?: number;
  readonly artifactContentHash?: string;
  readonly translatedAt?: string;
  readonly compileResultId?: string;
  readonly dryRunResultId?: string;
  readonly simulatedAt?: string;
  readonly readyAt?: string;
  readonly reviewProposalRevision?: number;
  readonly approvedProposalRevision?: number;
  readonly switchOperationId?: string;
  readonly switchActor?: string;
  readonly sourceWasEnabled?: true;
  readonly switchStartedAt?: string;
  readonly deploymentId?: string;
  readonly deploymentTarget?: string;
  readonly deploymentConfigFingerprint?: string;
  readonly verifiedAt?: string;
  readonly rollbackOperationId?: string;
  readonly rollbackActor?: string;
  readonly rollbackStartedAt?: string;
  readonly restoredAt?: string;
  readonly failedAt?: string;
  readonly failureReason?: typeof HOME_MIGRATION_WORKFLOW_FAILURE_REASONS[number];
}

const WORKFLOW_CORE_KEYS = ["status", "sourceFingerprint", "assessedAt"] as const;
const WORKFLOW_TRANSLATED_KEYS = [
  ...WORKFLOW_CORE_KEYS, "proposalId", "candidateProposalRevision", "candidateContentHash", "translatedAt",
] as const;
const WORKFLOW_SIMULATED_KEYS = [
  ...WORKFLOW_TRANSLATED_KEYS, "artifactId", "artifactRevision", "artifactContentHash", "compileResultId", "dryRunResultId", "simulatedAt",
] as const;
const WORKFLOW_READY_KEYS = [...WORKFLOW_SIMULATED_KEYS, "readyAt", "reviewProposalRevision"] as const;
const WORKFLOW_SWITCHING_KEYS = [
  ...WORKFLOW_READY_KEYS, "approvedProposalRevision", "switchOperationId", "switchActor", "sourceWasEnabled", "switchStartedAt",
] as const;
const WORKFLOW_VERIFIED_KEYS = [
  ...WORKFLOW_SWITCHING_KEYS, "deploymentId", "deploymentTarget", "deploymentConfigFingerprint", "verifiedAt",
] as const;
const WORKFLOW_ROLLING_BACK_KEYS = [
  ...WORKFLOW_VERIFIED_KEYS, "rollbackOperationId", "rollbackActor", "rollbackStartedAt",
] as const;
const WORKFLOW_RESTORED_KEYS = [...WORKFLOW_ROLLING_BACK_KEYS, "restoredAt"] as const;
const WORKFLOW_FAILED_SWITCH_RESTORED_KEYS = [
  ...WORKFLOW_SWITCHING_KEYS, "failedAt", "failureReason", "restoredAt",
] as const;

function parseWorkflow(value: unknown, parentSourceFingerprint: unknown): ParsedWorkflow | undefined {
  if (!isRecord(value)
    || !isDigest(parentSourceFingerprint)
    || !isDigest(value.sourceFingerprint)
    || value.sourceFingerprint !== parentSourceFingerprint
    || !isWorkflowStatus(value.status)
    || !isIsoTimestamp(value.assessedAt)) return undefined;

  if (value.status === "assessed") {
    return hasExactKeys(value, WORKFLOW_CORE_KEYS) ? value as unknown as ParsedWorkflow : undefined;
  }
  if (value.status === "translated") {
    return hasExactKeys(value, WORKFLOW_TRANSLATED_KEYS) && isTranslatedWorkflow(value)
      ? value as unknown as ParsedWorkflow : undefined;
  }
  if (value.status === "simulated") {
    return hasExactKeys(value, WORKFLOW_SIMULATED_KEYS) && isSimulatedWorkflow(value)
      ? value as unknown as ParsedWorkflow : undefined;
  }
  if (value.status === "ready") {
    return hasExactKeys(value, WORKFLOW_READY_KEYS) && isReadyWorkflow(value)
      ? value as unknown as ParsedWorkflow : undefined;
  }
  if (value.status === "switching") {
    return hasExactKeys(value, WORKFLOW_SWITCHING_KEYS) && isSwitchingWorkflow(value)
      ? value as unknown as ParsedWorkflow : undefined;
  }
  if (value.status === "verified") {
    return hasExactKeys(value, WORKFLOW_VERIFIED_KEYS) && isVerifiedWorkflow(value)
      ? value as unknown as ParsedWorkflow : undefined;
  }
  if (value.status === "rolling_back") {
    return hasExactKeys(value, WORKFLOW_ROLLING_BACK_KEYS) && isRollingBackWorkflow(value)
      ? value as unknown as ParsedWorkflow : undefined;
  }
  if (value.status === "restored") {
    if (hasExactKeys(value, WORKFLOW_RESTORED_KEYS) && isRestoredWorkflow(value)) {
      return value as unknown as ParsedWorkflow;
    }
    return hasExactKeys(value, WORKFLOW_FAILED_SWITCH_RESTORED_KEYS) && isFailedSwitchRestoredWorkflow(value)
      ? value as unknown as ParsedWorkflow : undefined;
  }

  if (!isWorkflowFailureReason(value.failureReason) || !isIsoTimestamp(value.failedAt)) return undefined;
  if (value.failureReason === "compile_failed" || value.failureReason === "compile_unavailable") {
    return hasExactKeys(value, [...WORKFLOW_TRANSLATED_KEYS, "failedAt", "failureReason"])
      && isTranslatedWorkflow(value) && isIsoTimestamp(value.failedAt)
      ? value as unknown as ParsedWorkflow : undefined;
  }
  if (value.failureReason === "simulation_failed" || value.failureReason === "simulation_unavailable") {
    return hasExactKeys(value, [...WORKFLOW_SIMULATED_KEYS, "failedAt", "failureReason"])
      && isSimulatedWorkflow(value) && isIsoTimestamp(value.failedAt)
      ? value as unknown as ParsedWorkflow : undefined;
  }
  if (value.failureReason === "source_stale") {
    return hasExactKeys(value, [...WORKFLOW_READY_KEYS, "failedAt", "failureReason"])
      && isReadyWorkflow(value) && isIsoTimestamp(value.failedAt)
      ? value as unknown as ParsedWorkflow : undefined;
  }
  if (value.failureReason === "switch_failed" || value.failureReason === "switch_unknown") {
    return hasExactKeys(value, [...WORKFLOW_SWITCHING_KEYS, "failedAt", "failureReason"])
      && isSwitchingWorkflow(value) && isIsoTimestamp(value.failedAt)
      ? value as unknown as ParsedWorkflow : undefined;
  }
  if (value.failureReason === "verification_failed") {
    return hasExactKeys(value, [...WORKFLOW_VERIFIED_KEYS, "failedAt", "failureReason"])
      && isVerifiedWorkflow(value) && isIsoTimestamp(value.failedAt)
      ? value as unknown as ParsedWorkflow : undefined;
  }
  return hasExactKeys(value, [...WORKFLOW_ROLLING_BACK_KEYS, "failedAt", "failureReason"])
    && isRollingBackWorkflow(value) && isIsoTimestamp(value.failedAt)
    ? value as unknown as ParsedWorkflow : undefined;
}

function isTranslatedWorkflow(value: Record<string, unknown>): boolean {
  return isBoundedText(value.proposalId, 200)
    && isPositiveSafeInteger(value.candidateProposalRevision)
    && isDigest(value.candidateContentHash)
    && isIsoTimestamp(value.translatedAt)
    && Date.parse(value.translatedAt) >= Date.parse(value.assessedAt as string);
}

function isSimulatedWorkflow(value: Record<string, unknown>): boolean {
  return isTranslatedWorkflow(value)
    && isBoundedText(value.artifactId, 200)
    && isPositiveSafeInteger(value.artifactRevision)
    && isDigest(value.artifactContentHash)
    && isDigest(value.compileResultId)
    && isDigest(value.dryRunResultId)
    && isIsoTimestamp(value.simulatedAt)
    && Date.parse(value.simulatedAt) >= Date.parse(value.translatedAt as string);
}

function isReadyWorkflow(value: Record<string, unknown>): boolean {
  return isSimulatedWorkflow(value)
    && isIsoTimestamp(value.readyAt)
    && isPositiveSafeInteger(value.reviewProposalRevision)
    && (value.candidateProposalRevision as number) < Number.MAX_SAFE_INTEGER
    && value.reviewProposalRevision === (value.candidateProposalRevision as number) + 1
    && Date.parse(value.readyAt) >= Date.parse(value.simulatedAt as string);
}

function isSwitchingWorkflow(value: Record<string, unknown>): boolean {
  return isReadyWorkflow(value)
    && isPositiveSafeInteger(value.approvedProposalRevision)
    && (value.reviewProposalRevision as number) < Number.MAX_SAFE_INTEGER
    && value.approvedProposalRevision === (value.reviewProposalRevision as number) + 1
    && is128BitHex(value.switchOperationId)
    && isBoundedText(value.switchActor, 200)
    && value.sourceWasEnabled === true
    && isIsoTimestamp(value.switchStartedAt)
    && Date.parse(value.switchStartedAt) >= Date.parse(value.readyAt as string);
}

function isVerifiedWorkflow(value: Record<string, unknown>): boolean {
  return isSwitchingWorkflow(value)
    && isBoundedText(value.deploymentId, 200)
    && isBoundedText(value.deploymentTarget, 200)
    && isDigest(value.deploymentConfigFingerprint)
    && isIsoTimestamp(value.verifiedAt)
    && Date.parse(value.verifiedAt) >= Date.parse(value.switchStartedAt as string);
}

function isRollingBackWorkflow(value: Record<string, unknown>): boolean {
  return isVerifiedWorkflow(value)
    && is128BitHex(value.rollbackOperationId)
    && isBoundedText(value.rollbackActor, 200)
    && isIsoTimestamp(value.rollbackStartedAt)
    && Date.parse(value.rollbackStartedAt) >= Date.parse(value.verifiedAt as string);
}

function isRestoredWorkflow(value: Record<string, unknown>): boolean {
  return isRollingBackWorkflow(value)
    && isIsoTimestamp(value.restoredAt)
    && Date.parse(value.restoredAt) >= Date.parse(value.rollbackStartedAt as string);
}

function isFailedSwitchRestoredWorkflow(value: Record<string, unknown>): boolean {
  return isSwitchingWorkflow(value)
    && (value.failureReason === "switch_failed" || value.failureReason === "switch_unknown")
    && isIsoTimestamp(value.failedAt)
    && isIsoTimestamp(value.restoredAt)
    && Date.parse(value.failedAt) >= Date.parse(value.switchStartedAt as string)
    && Date.parse(value.restoredAt) >= Date.parse(value.failedAt);
}

function parseSelectionCounts(rows: readonly Row[]): MigrationRead["selectionAudit"] | undefined {
  const statusCounts = zeroCounts(HOME_MIGRATION_SELECTION_STATUSES);
  let total = 0;
  for (const row of rows) {
    if (!isSelectionStatus(row.status) || !isSafeCount(row.count)) return undefined;
    statusCounts[row.status] += row.count;
    total += row.count;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return { total, statusCounts };
}

interface ParsedProposal {
  readonly id: string;
  readonly revision: number;
  readonly idempotencyKey: string;
  readonly dedupKey: string;
  readonly sourceRuleRef: string;
  readonly status: typeof HOME_MIGRATION_PROPOSAL_REVIEW_STATUSES[number];
  readonly lifecycle: typeof HOME_MIGRATION_PROPOSAL_LIFECYCLES[number];
  readonly applicationStatus: typeof HOME_MIGRATION_PROPOSAL_APPLICATION_STATUSES[number];
  readonly deploymentStatus: typeof HOME_MIGRATION_PROPOSAL_DEPLOYMENT_STATUSES[number];
  readonly candidateContentHash: string;
  readonly preparedArtifact?: PreparedArtifact;
  readonly deployment?: ProposalDeployment;
  readonly auditRevisions: ReadonlyMap<string, number>;
}

function parseProposalRow(row: Row): ParsedProposal | undefined {
  if (!isBoundedText(row.proposal_id, 256) || row.producer !== "home-automation-migration"
    || !isBoundedText(row.idempotency_key, 1_000)
    || !isPositiveSafeInteger(row.revision) || !isProposalReviewStatus(row.status)
    || !isIsoTimestamp(row.created_at) || !isIsoTimestamp(row.updated_at)
    || typeof row.payload_json !== "string"
    || Buffer.byteLength(row.payload_json, "utf8") > HOME_MIGRATION_STATUS_MAX_PROPOSAL_PAYLOAD_BYTES) return undefined;
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); } catch { return undefined; }
  if (!isRecord(payload)
    || payload.id !== row.proposal_id
    || payload.idempotencyKey !== row.idempotency_key
    || payload.revision !== row.revision
    || payload.createdAt !== row.created_at
    || payload.updatedAt !== row.updated_at
    || payload.kind !== "automation-draft"
    || payload.reviewLane !== "migration"
    || !isRecord(payload.provenance)
    || payload.provenance.producer !== "home-automation-migration"
    || !isBoundedText(payload.idempotencyKey, 1_000)
    || !isBoundedText(payload.dedupKey, 1_000)
    || !isIsoTimestamp(payload.createdAt)
    || !isIsoTimestamp(payload.updatedAt)
    || payload.status !== row.status
    || !isProposalLifecycle(payload.lifecycle)
    || !isProposalApplicationStatus(payload.applicationStatus)) return undefined;

  if (!isRecord(payload.artifactCandidate)
    || !hasExactKeys(payload.artifactCandidate, ["schemaVersion", "content"])
    || payload.artifactCandidate.schemaVersion !== "1"
    || !Object.hasOwn(payload.artifactCandidate, "content")) return undefined;
  let candidateContentHash: string;
  try {
    candidateContentHash = computeHomeAutomationMigrationCandidateContentHash(payload.artifactCandidate.content);
  } catch {
    return undefined;
  }

  const preparedArtifact = parsePreparedArtifact(payload.preparedArtifact);
  if (payload.preparedArtifact !== undefined && preparedArtifact === undefined) return undefined;

  const sourceRuleRef = parseSourceRuleRef(payload.conflictCheck);
  if (sourceRuleRef === undefined) return undefined;

  let deploymentStatus: ParsedProposal["deploymentStatus"] = "absent";
  let deployment: ProposalDeployment | undefined;
  if (payload.deployment !== undefined) {
    if (!isRecord(payload.deployment)) return undefined;
    deployment = parseProposalDeployment(payload.deployment);
    if (deployment === undefined) return undefined;
    deploymentStatus = deployment.status;
  }
  const auditRevisions = parseAuditRevisions(payload.audit);
  if (auditRevisions === undefined) return undefined;
  return {
    id: row.proposal_id,
    revision: row.revision as number,
    idempotencyKey: payload.idempotencyKey,
    dedupKey: payload.dedupKey,
    sourceRuleRef,
    status: row.status,
    lifecycle: payload.lifecycle,
    applicationStatus: payload.applicationStatus,
    deploymentStatus,
    candidateContentHash,
    ...(preparedArtifact === undefined ? {} : { preparedArtifact }),
    ...(deployment === undefined ? {} : { deployment }),
    auditRevisions,
  };
}

function parseSourceRuleRef(value: unknown): string | undefined {
  if (!isRecord(value) || value.status !== "checked" || !isSafeCount(value.existingAutomationCount)
    || !Array.isArray(value.matches)
    || value.matches.length !== 1) return undefined;
  const match = value.matches[0];
  return isRecord(match) && match.relation === "possible_overlap" && isBoundedText(match.identity, 200)
    ? match.identity : undefined;
}

interface PreparedArtifact {
  readonly artifactId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly compileResultId: string;
  readonly dryRunResultId: string;
}

interface ProposalDeployment {
  readonly status: Exclude<typeof HOME_MIGRATION_PROPOSAL_DEPLOYMENT_STATUSES[number], "absent">;
  readonly deploymentId?: string;
  readonly target?: string;
  readonly configFingerprint?: string;
}

function parsePreparedArtifact(value: unknown): PreparedArtifact | undefined {
  if (!isRecord(value)
    || !hasExactKeys(value, ["artifactId", "revision", "contentHash", "compileResultId", "dryRunResultId"])
    || !isBoundedText(value.artifactId, 200)
    || !isPositiveSafeInteger(value.revision)
    || !isDigest(value.contentHash)
    || !isDigest(value.compileResultId)
    || !isDigest(value.dryRunResultId)) return undefined;
  return {
    artifactId: value.artifactId,
    revision: value.revision,
    contentHash: value.contentHash,
    compileResultId: value.compileResultId,
    dryRunResultId: value.dryRunResultId,
  };
}

function parseProposalDeployment(value: unknown): ProposalDeployment | undefined {
  if (!isRecord(value)
    || !isProposalDeploymentStatus(value.status, true)
    || !isIsoTimestamp(value.requestedAt)) return undefined;
  if (value.status === "verified" && (!isBoundedText(value.deploymentId, 200)
    || !isBoundedText(value.target, 200)
    || !isDigest(value.configFingerprint)
    || !isIsoTimestamp(value.verifiedAt))) return undefined;
  if (value.status === "rolled_back" && value.deploymentId !== undefined
    && (!isBoundedText(value.deploymentId, 200) || value.target !== undefined && !isBoundedText(value.target, 200)
      || value.configFingerprint !== undefined && !isDigest(value.configFingerprint))) return undefined;
  if (value.deploymentId !== undefined && !isBoundedText(value.deploymentId, 200)) return undefined;
  if (value.target !== undefined && !isBoundedText(value.target, 200)) return undefined;
  if (value.configFingerprint !== undefined && !isDigest(value.configFingerprint)) return undefined;
  return {
    status: value.status === "absent" ? "pending" : value.status,
    ...(value.deploymentId === undefined ? {} : { deploymentId: value.deploymentId }),
    ...(value.target === undefined ? {} : { target: value.target }),
    ...(value.configFingerprint === undefined ? {} : { configFingerprint: value.configFingerprint }),
  };
}

function parseAuditRevisions(value: unknown): ReadonlyMap<string, number> | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return undefined;
  const result = new Map<string, number>();
  for (const event of value) {
    if (!isRecord(event) || typeof event.action !== "string" || !isPositiveSafeInteger(event.revision)) return undefined;
    result.set(event.action, event.revision);
  }
  return result;
}

function emptyProposalAggregate(): HomeAutomationMigrationStatusReport["proposals"] {
  return {
    linkedWorkflowCount: 0,
    missingProposalCount: 0,
    reviewStatusCounts: zeroCounts(HOME_MIGRATION_PROPOSAL_REVIEW_STATUSES),
    lifecycleCounts: zeroCounts(HOME_MIGRATION_PROPOSAL_LIFECYCLES),
    applicationStatusCounts: zeroCounts(HOME_MIGRATION_PROPOSAL_APPLICATION_STATUSES),
    deploymentCounts: zeroCounts(HOME_MIGRATION_PROPOSAL_DEPLOYMENT_STATUSES),
    consistency: "consistent",
  };
}

function proposalCoherent(
  migration: MigrationRead,
  link: WorkflowLink,
  proposal: ParsedProposal,
): boolean {
  const workflow = link.workflow;
  let expectedIdentity: ReturnType<typeof homeAutomationMigrationProposalIdentity>;
  try {
    expectedIdentity = homeAutomationMigrationProposalIdentity({
      migrationId: migration.migrationId,
      ruleRef: link.ruleRef,
      sourceBridgeId: migration.sourceBridgeId,
      sourceEpochId: migration.sourceEpochId,
      sourceLastSeq: migration.sourceLastSeq,
      sourceFingerprint: workflow.sourceFingerprint,
    });
  } catch {
    return false;
  }
  if (proposal.dedupKey !== expectedIdentity.dedupKey
    || proposal.idempotencyKey !== expectedIdentity.idempotencyKey
    || proposal.sourceRuleRef !== link.ruleRef
    || workflow.proposalId !== proposal.id
    || workflow.candidateProposalRevision === undefined
    || workflow.candidateContentHash === undefined
    || proposal.candidateContentHash !== workflow.candidateContentHash) {
    return false;
  }

  if (workflow.status === "ready") {
    return proposal.status === "pending_review"
      && proposal.lifecycle === "ready"
      && proposal.deployment === undefined
      && proposal.revision === workflow.reviewProposalRevision
      && workflow.reviewProposalRevision === workflow.candidateProposalRevision + 1
      && proposal.auditRevisions.get("prepared") === proposal.revision
      && preparedArtifactMatches(workflow, proposal.preparedArtifact);
  }
  if (workflow.status === "verified") {
    return proposal.status === "approved"
      && proposal.lifecycle === "active"
      && proposal.applicationStatus === "running"
      && proposal.deploymentStatus === "verified"
      && proposal.revision > (workflow.approvedProposalRevision ?? Number.MAX_SAFE_INTEGER)
      && proposal.auditRevisions.get("approved") === workflow.approvedProposalRevision
      && proposal.auditRevisions.get("deployment_verified") !== undefined
      && proposal.auditRevisions.get("deployment_verified")! <= proposal.revision
      && preparedArtifactMatches(workflow, proposal.preparedArtifact)
      && deploymentMatches(workflow, proposal.deployment, "verified");
  }
  if (workflow.status === "restored") {
    const failedSwitchRestore = workflow.deploymentId === undefined;
    return proposal.status === "approved"
      && proposal.lifecycle === "closed"
      && proposal.applicationStatus === "withdrawn"
      && proposal.deploymentStatus === "rolled_back"
      && proposal.revision > (workflow.approvedProposalRevision ?? Number.MAX_SAFE_INTEGER)
      && proposal.auditRevisions.get("approved") === workflow.approvedProposalRevision
      && proposal.auditRevisions.get("closed") === proposal.revision
      && (failedSwitchRestore
        ? proposal.deployment?.deploymentId === undefined
          && proposal.deployment?.target === undefined
          && proposal.deployment?.configFingerprint === undefined
          && proposal.auditRevisions.get("deployment_failed") !== undefined
          && proposal.auditRevisions.get("deployment_failed")! < proposal.revision
        : preparedArtifactMatches(workflow, proposal.preparedArtifact)
          && deploymentMatches(workflow, proposal.deployment, "rolled_back")
          && proposal.auditRevisions.get("deployment_verified") !== undefined
          && proposal.auditRevisions.get("deployment_verified")! < proposal.revision);
  }
  if (workflow.status === "translated" || workflow.status === "simulated") {
    return proposal.status === "pending_review"
      && (proposal.lifecycle === "preparing" || proposal.lifecycle === "needs_info")
      && proposal.revision === workflow.candidateProposalRevision;
  }
  if (workflow.status === "switching") {
    return proposal.status === "approved"
      && proposal.lifecycle === "enabling"
      && proposal.applicationStatus === "deploying"
      && proposal.deploymentStatus === "pending"
      && proposal.revision === workflow.approvedProposalRevision
      && proposal.auditRevisions.get("approved") === workflow.approvedProposalRevision
      && preparedArtifactMatches(workflow, proposal.preparedArtifact);
  }
  if (workflow.status === "rolling_back") {
    return proposal.status === "approved"
      && (proposal.lifecycle === "active" || proposal.lifecycle === "paused" || proposal.lifecycle === "recovery_required")
      && proposal.revision > (workflow.approvedProposalRevision ?? Number.MAX_SAFE_INTEGER)
      && proposal.auditRevisions.get("approved") === workflow.approvedProposalRevision
      && preparedArtifactMatches(workflow, proposal.preparedArtifact)
      && deploymentMatches(workflow, proposal.deployment, "verified");
  }
  return true;
}

function preparedArtifactMatches(
  workflow: ParsedWorkflow,
  artifact: PreparedArtifact | undefined,
): boolean {
  return artifact !== undefined
    && workflow.artifactId !== undefined
    && workflow.artifactRevision !== undefined
    && workflow.artifactContentHash !== undefined
    && workflow.compileResultId !== undefined
    && workflow.dryRunResultId !== undefined
    && artifact.artifactId === workflow.artifactId
    && artifact.revision === workflow.artifactRevision
    && artifact.contentHash === workflow.artifactContentHash
    && artifact.compileResultId === workflow.compileResultId
    && artifact.dryRunResultId === workflow.dryRunResultId;
}

function deploymentMatches(
  workflow: ParsedWorkflow,
  deployment: ProposalDeployment | undefined,
  status: Exclude<typeof HOME_MIGRATION_PROPOSAL_DEPLOYMENT_STATUSES[number], "absent" | "pending">,
): boolean {
  return deployment !== undefined
    && deployment.status === status
    && workflow.deploymentId !== undefined
    && workflow.deploymentTarget !== undefined
    && workflow.deploymentConfigFingerprint !== undefined
    && deployment.deploymentId === workflow.deploymentId
    && deployment.target === workflow.deploymentTarget
    && deployment.configFingerprint === workflow.deploymentConfigFingerprint;
}

function failure(
  assessmentId: string,
  reason: HomeMigrationStatusFailureReason,
): HomeAutomationMigrationStatusFailure {
  return {
    schemaVersion: "1",
    outcome: "needs_attention",
    assessmentId,
    reason,
    readMode: "durable_only",
    remoteWritesPerformed: false,
    localWritesPerformed: false,
  };
}

function zeroCounts<const T extends readonly string[]>(keys: T): { -readonly [K in T[number]]: number } {
  return Object.fromEntries(keys.map((key) => [key, 0])) as { -readonly [K in T[number]]: number };
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
}

function isPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001F\u007F]/u.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Number.isFinite(Date.parse(value))
    && /(?:Z|[+-]\d{2}:\d{2})$/u.test(value);
}

function is128BitHex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isAssessmentStatus(value: unknown): value is "discovered" | "assessed" | "needs_attention" | "closed" {
  return value === "discovered" || value === "assessed" || value === "needs_attention" || value === "closed";
}

function isDisposition(value: unknown): value is "eligible" | "metadata_only" | "unsupported" | "needs_attention" {
  return value === "eligible" || value === "metadata_only" || value === "unsupported" || value === "needs_attention";
}

function isWorkflowStatus(value: unknown): value is typeof HOME_MIGRATION_WORKFLOW_STATUSES[number] {
  return (HOME_MIGRATION_WORKFLOW_STATUSES as readonly unknown[]).includes(value);
}

function isWorkflowFailureReason(value: unknown): value is typeof HOME_MIGRATION_WORKFLOW_FAILURE_REASONS[number] {
  return (HOME_MIGRATION_WORKFLOW_FAILURE_REASONS as readonly unknown[]).includes(value);
}

function isSelectionStatus(value: unknown): value is typeof HOME_MIGRATION_SELECTION_STATUSES[number] {
  return (HOME_MIGRATION_SELECTION_STATUSES as readonly unknown[]).includes(value);
}

function isProposalReviewStatus(value: unknown): value is typeof HOME_MIGRATION_PROPOSAL_REVIEW_STATUSES[number] {
  return (HOME_MIGRATION_PROPOSAL_REVIEW_STATUSES as readonly unknown[]).includes(value);
}

function isProposalLifecycle(value: unknown): value is typeof HOME_MIGRATION_PROPOSAL_LIFECYCLES[number] {
  return (HOME_MIGRATION_PROPOSAL_LIFECYCLES as readonly unknown[]).includes(value);
}

function isProposalApplicationStatus(value: unknown): value is typeof HOME_MIGRATION_PROPOSAL_APPLICATION_STATUSES[number] {
  return (HOME_MIGRATION_PROPOSAL_APPLICATION_STATUSES as readonly unknown[]).includes(value);
}

function isProposalDeploymentStatus(value: unknown, allowAbsent: boolean): value is typeof HOME_MIGRATION_PROPOSAL_DEPLOYMENT_STATUSES[number] {
  return (allowAbsent
    ? HOME_MIGRATION_PROPOSAL_DEPLOYMENT_STATUSES
    : HOME_MIGRATION_PROPOSAL_DEPLOYMENT_STATUSES.filter((status) => status !== "absent") as readonly string[]).includes(value as string);
}

type Row = Record<string, unknown>;
