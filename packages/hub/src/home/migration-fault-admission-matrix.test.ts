import assert from "node:assert/strict";
import test from "node:test";

import {
  MIGRATION_FAULT_KINDS,
  resolveMigrationFaultAdmission,
} from "./migration-fault-admission-matrix.js";

const EXPECTED = {
  restart: {
    expectedDurableState: "preserve_in_progress",
    remoteWriteAllowance: "existing_decision_only",
    requiredRecoveryExit: "resume_existing_receipt",
    evidenceSource: "migration_and_proposal_audit",
  },
  bridge_disconnect: {
    expectedDurableState: "needs_attention",
    remoteWriteAllowance: "none",
    requiredRecoveryExit: "bridge_ready_then_fresh_readback",
    evidenceSource: "bridge_health_and_durable_manifest",
  },
  timeout: {
    expectedDurableState: "needs_attention",
    remoteWriteAllowance: "none",
    requiredRecoveryExit: "fresh_readback_before_retry",
    evidenceSource: "operation_receipt_and_durable_manifest",
  },
  state_drift: {
    expectedDurableState: "needs_attention",
    remoteWriteAllowance: "none",
    requiredRecoveryExit: "revalidate_source_cut",
    evidenceSource: "source_cut_and_durable_manifest",
  },
  duplicate_submit: {
    expectedDurableState: "preserve_existing_decision",
    remoteWriteAllowance: "none",
    requiredRecoveryExit: "replay_existing_receipt",
    evidenceSource: "selection_and_proposal_idempotency_audit",
  },
  rollback_failure: {
    expectedDurableState: "recovery_required",
    remoteWriteAllowance: "fresh_recovery_receipt_only",
    requiredRecoveryExit: "new_recovery_receipt_then_restored",
    evidenceSource: "rollback_and_recovery_receipts",
  },
} as const;

test("admits exactly the six documented migration fault injections", () => {
  assert.deepEqual([...MIGRATION_FAULT_KINDS], Object.keys(EXPECTED));
  for (const fault of MIGRATION_FAULT_KINDS) {
    assert.deepEqual(resolveMigrationFaultAdmission(fault), {
      outcome: "admitted",
      fault,
      ...EXPECTED[fault],
    });
  }
});

test("rejects unknown fault values with a fixed no-write manual-review outcome", () => {
  const expected = {
    outcome: "rejected",
    fault: "unknown",
    reason: "unknown_fault",
    expectedDurableState: "needs_attention",
    remoteWriteAllowance: "none",
    requiredRecoveryExit: "manual_review",
    evidenceSource: "durable_status_only",
  } as const;
  for (const unknown of ["restart-now", "bridge_reconnect", "provider_payload", "", null, 7, {}]) {
    const result = resolveMigrationFaultAdmission(unknown);
    assert.deepEqual(result, expected);
    if (typeof unknown === "string" && unknown !== "") {
      assert.equal(JSON.stringify(result).includes(unknown), false);
    }
  }
});

test("returns immutable admissions so callers cannot widen a fault policy", () => {
  const admission = resolveMigrationFaultAdmission("rollback_failure");
  assert.equal(Object.isFrozen(admission), true);
  assert.throws(() => {
    (admission as { remoteWriteAllowance: string }).remoteWriteAllowance = "arbitrary_write";
  }, TypeError);
  assert.equal(resolveMigrationFaultAdmission("rollback_failure").remoteWriteAllowance, "fresh_recovery_receipt_only");
});
