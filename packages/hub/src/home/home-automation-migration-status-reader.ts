import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";

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
  readonly proposalId: string;
  readonly status: typeof HOME_MIGRATION_WORKFLOW_STATUSES[number];
}

interface MigrationRead {
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
  const proposals = readProposalStore(paths.proposalPath, migration.value.workflowLinks);
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
    const row = db.prepare(`SELECT status, rules_json
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

function readProposalStore(path: string, links: readonly WorkflowLink[]): ReadResult<ProposalRead> {
  if (!isRegularFile(path)) return { kind: "failure", reason: "proposal_store_unavailable" };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    // Probe the schema even when this assessment has not linked a Proposal.
    db.prepare("SELECT proposal_id, producer, revision, status, payload_json FROM proposals WHERE 1 = 0").all();
    const ids = links.map((link) => link.proposalId);
    const uniqueIds = [...new Set(ids)];
    const rows = uniqueIds.length === 0
      ? []
      : db.prepare(`SELECT proposal_id, producer, revision, status, payload_json FROM proposals
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
    for (const link of links) {
      if (seen.has(link.proposalId)) return { kind: "failure", reason: "cross_store_inconsistent" };
      seen.add(link.proposalId);
      const proposal = byId.get(link.proposalId);
      if (proposal === undefined) {
        missingProposalCount += 1;
        continue;
      }
      if (!proposalCoherent(link.status, proposal)) return { kind: "failure", reason: "cross_store_inconsistent" };
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
          linkedWorkflowCount: links.length,
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
  readonly assessment: MigrationRead["assessment"];
  readonly workflowLinks: readonly WorkflowLink[];
}

function parseMigrationRow(row: Row): ParsedMigration | undefined {
  if (!isAssessmentStatus(row.status) || typeof row.rules_json !== "string"
    || Buffer.byteLength(row.rules_json, "utf8") > 64 * 1024) return undefined;
  let rules: unknown;
  try { rules = JSON.parse(row.rules_json); } catch { return undefined; }
  if (!Array.isArray(rules) || rules.length > 256) return undefined;

  const dispositionCounts = zeroCounts(["eligible", "metadata_only", "unsupported", "needs_attention"] as const);
  const workflowCounts = zeroCounts(HOME_MIGRATION_WORKFLOW_STATUSES);
  const failureCounts = zeroCounts(HOME_MIGRATION_WORKFLOW_FAILURE_REASONS);
  const workflowLinks: WorkflowLink[] = [];
  for (const rule of rules) {
    if (!isRecord(rule) || !isDisposition(rule.disposition)) return undefined;
    dispositionCounts[rule.disposition] += 1;
    if (rule.disposition !== "eligible") {
      if (rule.workflow !== undefined) return undefined;
      continue;
    }
    if (!isRecord(rule.workflow) || !isWorkflowStatus(rule.workflow.status)) return undefined;
    const status = rule.workflow.status;
    workflowCounts[status] += 1;
    if (status === "needs_attention") {
      if (!isWorkflowFailureReason(rule.workflow.failureReason)) return undefined;
      failureCounts[rule.workflow.failureReason] += 1;
    } else if (rule.workflow.failureReason !== undefined) {
      return undefined;
    }
    if (rule.workflow.proposalId !== undefined) {
      if (!isBoundedText(rule.workflow.proposalId, 200)) return undefined;
      workflowLinks.push({ proposalId: rule.workflow.proposalId, status });
    } else if (status !== "assessed") {
      return undefined;
    }
  }
  return {
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
  readonly status: typeof HOME_MIGRATION_PROPOSAL_REVIEW_STATUSES[number];
  readonly lifecycle: typeof HOME_MIGRATION_PROPOSAL_LIFECYCLES[number];
  readonly applicationStatus: typeof HOME_MIGRATION_PROPOSAL_APPLICATION_STATUSES[number];
  readonly deploymentStatus: typeof HOME_MIGRATION_PROPOSAL_DEPLOYMENT_STATUSES[number];
}

function parseProposalRow(row: Row): ParsedProposal | undefined {
  if (!isBoundedText(row.proposal_id, 256) || row.producer !== "home-automation-migration"
    || !isPositiveSafeInteger(row.revision) || !isProposalReviewStatus(row.status)
    || typeof row.payload_json !== "string"
    || Buffer.byteLength(row.payload_json, "utf8") > HOME_MIGRATION_STATUS_MAX_PROPOSAL_PAYLOAD_BYTES) return undefined;
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); } catch { return undefined; }
  if (!isRecord(payload)
    || payload.id !== row.proposal_id
    || payload.revision !== row.revision
    || payload.reviewLane !== "migration"
    || !isRecord(payload.provenance)
    || payload.provenance.producer !== "home-automation-migration"
    || payload.status !== row.status
    || !isProposalLifecycle(payload.lifecycle)
    || !isProposalApplicationStatus(payload.applicationStatus)) return undefined;
  let deploymentStatus: ParsedProposal["deploymentStatus"] = "absent";
  if (payload.deployment !== undefined) {
    if (!isRecord(payload.deployment) || !isProposalDeploymentStatus(payload.deployment.status, true)) return undefined;
    deploymentStatus = payload.deployment.status;
  }
  return {
    id: row.proposal_id,
    status: row.status,
    lifecycle: payload.lifecycle,
    applicationStatus: payload.applicationStatus,
    deploymentStatus,
  };
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
  workflowStatus: WorkflowLink["status"],
  proposal: ParsedProposal,
): boolean {
  if (workflowStatus === "ready") {
    return proposal.status === "pending_review" && proposal.lifecycle === "ready";
  }
  if (workflowStatus === "verified") {
    return proposal.status === "approved"
      && proposal.lifecycle === "active"
      && proposal.applicationStatus === "running"
      && proposal.deploymentStatus === "verified";
  }
  if (workflowStatus === "restored") {
    return proposal.status === "approved"
      && proposal.lifecycle === "closed"
      && proposal.applicationStatus === "withdrawn"
      && proposal.deploymentStatus === "rolled_back";
  }
  return true;
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

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
