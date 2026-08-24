/**
 * Closed fault vocabulary for the Phase 0.5 acceptance and evidence model.
 * This module is a pure policy table; it does not inject faults or own a runtime.
 */
export const MIGRATION_FAULT_KINDS = Object.freeze([
  "restart",
  "bridge_disconnect",
  "timeout",
  "state_drift",
  "duplicate_submit",
  "rollback_failure",
] as const);

export type MigrationFaultKind = typeof MIGRATION_FAULT_KINDS[number];

export type MigrationFaultDurableState =
  | "preserve_in_progress"
  | "needs_attention"
  | "preserve_existing_decision"
  | "recovery_required";

export type MigrationFaultRemoteWriteAllowance =
  | "none"
  | "existing_decision_only"
  | "fresh_recovery_receipt_only";

export type MigrationFaultRecoveryExit =
  | "resume_existing_receipt"
  | "bridge_ready_then_fresh_readback"
  | "fresh_readback_before_retry"
  | "revalidate_source_cut"
  | "replay_existing_receipt"
  | "new_recovery_receipt_then_restored"
  | "manual_review";

export type MigrationFaultEvidenceSource =
  | "migration_and_proposal_audit"
  | "bridge_health_and_durable_manifest"
  | "operation_receipt_and_durable_manifest"
  | "source_cut_and_durable_manifest"
  | "selection_and_proposal_idempotency_audit"
  | "rollback_and_recovery_receipts"
  | "durable_status_only";

export interface MigrationFaultAdmissionPolicy {
  readonly expectedDurableState: MigrationFaultDurableState;
  readonly remoteWriteAllowance: MigrationFaultRemoteWriteAllowance;
  readonly requiredRecoveryExit: Exclude<MigrationFaultRecoveryExit, "manual_review">;
  readonly evidenceSource: Exclude<MigrationFaultEvidenceSource, "durable_status_only">;
}

export interface MigrationFaultAdmission {
  readonly outcome: "admitted";
  readonly fault: MigrationFaultKind;
  readonly expectedDurableState: MigrationFaultDurableState;
  readonly remoteWriteAllowance: MigrationFaultRemoteWriteAllowance;
  readonly requiredRecoveryExit: Exclude<MigrationFaultRecoveryExit, "manual_review">;
  readonly evidenceSource: Exclude<MigrationFaultEvidenceSource, "durable_status_only">;
}

export interface MigrationFaultRejection {
  readonly outcome: "rejected";
  readonly fault: "unknown";
  readonly reason: "unknown_fault";
  readonly expectedDurableState: "needs_attention";
  readonly remoteWriteAllowance: "none";
  readonly requiredRecoveryExit: "manual_review";
  readonly evidenceSource: "durable_status_only";
}

export type MigrationFaultAdmissionResult = MigrationFaultAdmission | MigrationFaultRejection;

const MATRIX: Readonly<Record<MigrationFaultKind, MigrationFaultAdmissionPolicy>> = Object.freeze({
  restart: Object.freeze({
    expectedDurableState: "preserve_in_progress",
    remoteWriteAllowance: "existing_decision_only",
    requiredRecoveryExit: "resume_existing_receipt",
    evidenceSource: "migration_and_proposal_audit",
  }),
  bridge_disconnect: Object.freeze({
    expectedDurableState: "needs_attention",
    remoteWriteAllowance: "none",
    requiredRecoveryExit: "bridge_ready_then_fresh_readback",
    evidenceSource: "bridge_health_and_durable_manifest",
  }),
  timeout: Object.freeze({
    expectedDurableState: "needs_attention",
    remoteWriteAllowance: "none",
    requiredRecoveryExit: "fresh_readback_before_retry",
    evidenceSource: "operation_receipt_and_durable_manifest",
  }),
  state_drift: Object.freeze({
    expectedDurableState: "needs_attention",
    remoteWriteAllowance: "none",
    requiredRecoveryExit: "revalidate_source_cut",
    evidenceSource: "source_cut_and_durable_manifest",
  }),
  duplicate_submit: Object.freeze({
    expectedDurableState: "preserve_existing_decision",
    remoteWriteAllowance: "none",
    requiredRecoveryExit: "replay_existing_receipt",
    evidenceSource: "selection_and_proposal_idempotency_audit",
  }),
  rollback_failure: Object.freeze({
    expectedDurableState: "recovery_required",
    remoteWriteAllowance: "fresh_recovery_receipt_only",
    requiredRecoveryExit: "new_recovery_receipt_then_restored",
    evidenceSource: "rollback_and_recovery_receipts",
  }),
});

/** Immutable machine-readable matrix used by acceptance tooling and docs. */
export const MIGRATION_FAULT_ADMISSION_MATRIX = MATRIX;

const UNKNOWN_FAULT_ADMISSION: MigrationFaultRejection = Object.freeze({
  outcome: "rejected",
  fault: "unknown",
  reason: "unknown_fault",
  expectedDurableState: "needs_attention",
  remoteWriteAllowance: "none",
  requiredRecoveryExit: "manual_review",
  evidenceSource: "durable_status_only",
});

/** Parses only the six documented fault names; every other value is rejected. */
export function parseMigrationFaultKind(value: unknown): MigrationFaultKind | undefined {
  if (typeof value !== "string") return undefined;
  return (MIGRATION_FAULT_KINDS as readonly string[]).includes(value)
    ? value as MigrationFaultKind
    : undefined;
}

/** Resolves a fault policy without echoing or granting authority to unknown input. */
export function resolveMigrationFaultAdmission(value: unknown): MigrationFaultAdmissionResult {
  const fault = parseMigrationFaultKind(value);
  if (fault === undefined) return UNKNOWN_FAULT_ADMISSION;
  return Object.freeze({ outcome: "admitted" as const, fault, ...MATRIX[fault] });
}
