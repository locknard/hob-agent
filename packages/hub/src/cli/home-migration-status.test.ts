import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  parseHomeMigrationStatusArgs,
  readHomeMigrationStatusFromPaths,
} from "./home-migration-status.js";
import {
  readHomeMigrationEvidenceFromPaths,
} from "../home/home-automation-migration-status-reader.js";
import { SqliteHomeAutomationMigrationStore } from "../home/home-automation-migration-store.js";
import { SqliteProposalStore } from "../home/proposal-store.js";
import { homeAutomationMigrationProposalIdentity } from "../home/home-automation-migration-preparation.js";
import { computeHomeAutomationMigrationCandidateContentHash } from "../home/home-automation-migration-simulator.js";
import { HOME_MIGRATION_STATUS_MAX_PROPOSAL_PAYLOAD_BYTES } from "../home/home-automation-migration-status-reader.js";

const ASSESSMENT_ID = "a".repeat(32);
const MIGRATION_SOURCE_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const MIGRATION_CANDIDATE_CONTENT = {
  trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "20:30" },
  conditions: [],
  actions: [{ kind: "notify_local", message: "Review the migration" }],
  rollback: { kind: "no_remote_change" },
  postconditions: [],
} as const;

test("requires one explicit lowercase assessment id", () => {
  assert.deepEqual(parseHomeMigrationStatusArgs(["--assessment-id", ASSESSMENT_ID]), {
    assessmentId: ASSESSMENT_ID,
  });
  assert.deepEqual(parseHomeMigrationStatusArgs(["--", "--assessment-id", ASSESSMENT_ID]), {
    assessmentId: ASSESSMENT_ID,
  });
  assert.throws(() => parseHomeMigrationStatusArgs([]), /--assessment-id is required/);
  assert.throws(() => parseHomeMigrationStatusArgs(["--assessment-id", "A".repeat(32)]), /invalid assessment id/);
  assert.throws(() => parseHomeMigrationStatusArgs(["--assessment-id", ASSESSMENT_ID, "extra"]), /unknown argument/);
});

test("provides an explicit evidence CLI parser without inferring the assessment", async () => {
  const evidenceCli = await import("./home-migration-evidence.js").catch(() => undefined);
  assert.ok(evidenceCli, "the evidence CLI must exist");
  if (evidenceCli === undefined) return;
  assert.deepEqual(evidenceCli.parseHomeMigrationEvidenceArgs(["--assessment-id", ASSESSMENT_ID]), {
    assessmentId: ASSESSMENT_ID,
  });
  assert.deepEqual(evidenceCli.parseHomeMigrationEvidenceArgs(["--", "--assessment-id", ASSESSMENT_ID]), {
    assessmentId: ASSESSMENT_ID,
  });
  assert.throws(() => evidenceCli.parseHomeMigrationEvidenceArgs([]), /--assessment-id is required/);
  assert.throws(() => evidenceCli.parseHomeMigrationEvidenceArgs(["--assessment-id", "A".repeat(32)]), /invalid assessment id/);
  assert.throws(() => evidenceCli.parseHomeMigrationEvidenceArgs(["--assessment-id", ASSESSMENT_ID, "extra"]), /unknown argument/);
});

test("fails closed without creating either missing durable database", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-missing-"));
  const migrationPath = join(directory, "missing-migrations.sqlite");
  const proposalPath = join(directory, "missing-proposals.sqlite");
  try {
    const result = readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID);

    assert.deepEqual(result, {
      schemaVersion: "1",
      outcome: "needs_attention",
      assessmentId: ASSESSMENT_ID,
      reason: "migration_store_unavailable",
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
    assert.equal(existsSync(migrationPath), false);
    assert.equal(existsSync(proposalPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a symlinked migration database before opening it", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-symlink-"));
  const realMigrationPath = join(directory, "real-migrations.sqlite");
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "missing-proposals.sqlite");
  try {
    seedMigration(realMigrationPath, { workflowStatus: "assessed", privateName: "private" });
    symlinkSync(realMigrationPath, migrationPath);
    assert.deepEqual(readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID), {
      schemaVersion: "1",
      outcome: "needs_attention",
      assessmentId: ASSESSMENT_ID,
      reason: "migration_store_unavailable",
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
    assert.equal(existsSync(proposalPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a non-regular migration path before opening it", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-directory-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "missing-proposals.sqlite");
  try {
    mkdirSync(migrationPath);
    assert.deepEqual(readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID), {
      schemaVersion: "1",
      outcome: "needs_attention",
      assessmentId: ASSESSMENT_ID,
      reason: "migration_store_unavailable",
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed when the migration database commits during the read", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-migration-commit-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "missing-proposals.sqlite");
  const writer = (() => {
    seedMigration(migrationPath, { workflowStatus: "assessed", privateName: "private" });
    const setup = new DatabaseSync(migrationPath);
    setup.exec("PRAGMA journal_mode = WAL");
    setup.close();
    return new DatabaseSync(migrationPath);
  })();
  const statementPrototype = sqliteStatementPrototype();
  const originalAll = statementPrototype.all;
  let committed = false;
  statementPrototype.all = function (this: SqliteStatementPrototype, ...parameters: unknown[]): unknown {
    const result = originalAll.apply(this, parameters);
    if (!committed) {
      committed = true;
      writer.prepare("UPDATE home_automation_migrations SET source_last_seq = source_last_seq + 1 WHERE migration_id = ?")
        .run(ASSESSMENT_ID);
    }
    return result;
  };
  try {
    assert.deepEqual(readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID), {
      schemaVersion: "1",
      outcome: "needs_attention",
      assessmentId: ASSESSMENT_ID,
      reason: "migration_store_unavailable",
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
    assert.equal(committed, true);
  } finally {
    statementPrototype.all = originalAll;
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed when the Proposal path is replaced during the read", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-proposal-replace-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  const replacementPath = join(directory, "replacement-proposals.sqlite");
  seedMigration(migrationPath, { workflowStatus: "assessed", privateName: "private" });
  replaceEligibleWorkflow(migrationPath, makeReadyWorkflow("proposal-replaced"));
  seedReadyProposal(replacementPath, "proposal-replaced");
  seedReadyProposal(proposalPath, "proposal-replaced");
  const statementPrototype = sqliteStatementPrototype();
  const originalAll = statementPrototype.all;
  let replaced = false;
  let allCalls = 0;
  statementPrototype.all = function (this: SqliteStatementPrototype, ...parameters: unknown[]): unknown {
    const result = originalAll.apply(this, parameters);
    allCalls += 1;
    if (!replaced && allCalls === 3) {
      replaced = true;
      renameSync(replacementPath, proposalPath);
    }
    return result;
  };
  try {
    assert.deepEqual(readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID), {
      schemaVersion: "1",
      outcome: "needs_attention",
      assessmentId: ASSESSMENT_ID,
      reason: "proposal_store_unavailable",
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
    assert.equal(replaced, true);
  } finally {
    statementPrototype.all = originalAll;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports assessment, workflow, selection, and linked Proposal lifecycle as safe aggregates", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-report-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  const privateName = "private household rule title";
  try {
    seedMigration(migrationPath, { workflowStatus: "assessed", privateName });
    seedSelections(migrationPath);
    replaceEligibleWorkflow(migrationPath, makeWorkflow("verified", "proposal-private"));
    seedProposal(proposalPath, {
      id: "proposal-private",
      title: privateName,
      status: "approved",
      lifecycle: "active",
      applicationStatus: "running",
      deploymentStatus: "verified",
      deploymentId: "native-id",
      deploymentTarget: "provider-payload",
    });

    const before = statSync(migrationPath).mtimeMs;
    const proposalBefore = statSync(proposalPath).mtimeMs;
    const result = readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID);
    const after = statSync(migrationPath).mtimeMs;
    const proposalAfter = statSync(proposalPath).mtimeMs;

    assert.deepEqual(result, {
      schemaVersion: "1",
      outcome: "reported",
      assessmentId: ASSESSMENT_ID,
      assessment: {
        status: "assessed",
        ruleCount: 2,
        dispositionCounts: { eligible: 1, metadata_only: 0, unsupported: 1, needs_attention: 0 },
        workflowCounts: {
          assessed: 0,
          translated: 0,
          simulated: 0,
          ready: 0,
          switching: 0,
          verified: 1,
          rolling_back: 0,
          restored: 0,
          needs_attention: 0,
        },
        failureCounts: {
          compile_failed: 0,
          compile_unavailable: 0,
          simulation_failed: 0,
          simulation_unavailable: 0,
          source_stale: 0,
          switch_failed: 0,
          switch_unknown: 0,
          verification_failed: 0,
          rollback_failed: 0,
          rollback_unknown: 0,
        },
      },
      selectionAudit: {
        total: 2,
        statusCounts: { issued: 0, processing: 1, prepared: 1, unavailable: 0, expired: 0, invalidated: 0 },
      },
      proposals: {
        linkedWorkflowCount: 1,
        missingProposalCount: 0,
        reviewStatusCounts: { pending_review: 0, approved: 1, rejected: 0, expired: 0 },
        lifecycleCounts: {
          preparing: 0,
          needs_info: 0,
          ready: 0,
          enabling: 0,
          active: 1,
          paused: 0,
          closed: 0,
          enable_failed: 0,
          recovery_required: 0,
        },
        applicationStatusCounts: { not_available: 0, deploying: 0, running: 1, failed: 0, withdrawn: 0 },
        deploymentCounts: { absent: 0, pending: 0, verified: 1, failed: 0, rolled_back: 0 },
        consistency: "consistent",
      },
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
    assert.equal(after, before);
    assert.equal(proposalAfter, proposalBefore);
    const serialized = JSON.stringify(result);
    for (const secret of [privateName, "rule-private", "principal-private", "sha256:", "native-id", "provider-payload"]) {
      assert.equal(serialized.includes(secret), false, `report leaked ${secret}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("emits a deterministic redacted evidence manifest for one verified decision", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-evidence-red-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  try {
    seedMigration(migrationPath, {
      workflowStatus: "verified",
      proposalId: "proposal-private",
      privateName: "private household rule title",
    });
    seedProposal(proposalPath, {
      id: "proposal-private",
      title: "private proposal title",
      status: "approved",
      lifecycle: "active",
      applicationStatus: "running",
      deploymentStatus: "verified",
      deploymentId: "native-id",
      deploymentTarget: "provider-payload",
    });

    const result = readHomeMigrationEvidenceFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID) as {
      readonly outcome: string;
      readonly readMode: string;
      readonly remoteWritesPerformed: boolean;
      readonly localWritesPerformed: boolean;
      readonly manifestDigest: string;
      readonly assessmentGate: { readonly name: string; readonly status: string; readonly at?: string };
      readonly workflows?: readonly {
        readonly gates: readonly { readonly name: string; readonly status: string; readonly at?: string }[];
        readonly enableDecisionCount: number;
        readonly recovery: { readonly attemptCount: number; readonly result: string };
        readonly receipts: readonly { readonly kind: string; readonly digest: string }[];
      }[];
    };
    assert.deepEqual(readHomeMigrationEvidenceFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID), result);
    assert.equal(result.outcome, "evidence");
    assert.equal(result.readMode, "durable_only");
    assert.equal(result.remoteWritesPerformed, false);
    assert.equal(result.localWritesPerformed, false);
    assert.match(result.manifestDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(result.assessmentGate, {
      name: "assessment",
      status: "completed",
      at: "2026-08-24T08:00:00.000Z",
    });
    const workflow = result.workflows?.[0];
    assert.ok(workflow);
    assert.deepEqual(workflow.gates.map((gate) => gate.name), [
      "assessment", "translation", "simulation", "ready", "approval", "switch", "verification", "rollback",
    ]);
    assert.deepEqual(workflow.gates.map((gate) => gate.status), [
      "completed", "completed", "completed", "completed", "completed", "completed", "completed", "not_started",
    ]);
    assert.deepEqual(workflow.gates.map((gate) => gate.at), [
      "2026-08-24T08:00:00.000Z",
      "2026-08-24T08:00:00.500Z",
      "2026-08-24T08:00:00.750Z",
      "2026-08-24T08:00:00.900Z",
      "2026-08-24T08:00:01.000Z",
      "2026-08-24T08:00:01.000Z",
      "2026-08-24T08:00:02.000Z",
      undefined,
    ]);
    assert.equal(workflow.enableDecisionCount, 1);
    assert.deepEqual(workflow.recovery, { attemptCount: 0, result: "not_required", receiptDigests: [] });
    assert.ok(workflow.receipts.length >= 6);
    assert.ok(workflow.receipts.every((receipt) => /^sha256:[a-f0-9]{64}$/u.test(receipt.digest)));
    const serialized = JSON.stringify(result);
    for (const secret of ["rule-private", "principal-private", "token", "sha256:" + "a".repeat(64), "native-id", "provider-payload", "private proposal title"]) {
      assert.equal(serialized.includes(secret), false, `evidence leaked ${secret}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps one approval while exposing a new recovery receipt in recovery_required", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-evidence-recovery-red-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  try {
    seedMigration(migrationPath, {
      workflowStatus: "verified",
      proposalId: "proposal-recovery",
      privateName: "private recovery rule",
    });
    const verified = makeWorkflow("verified", "proposal-recovery");
    replaceEligibleWorkflow(migrationPath, {
      ...verified,
      status: "needs_attention",
      failedAt: "2026-08-24T08:00:03.000Z",
      failureReason: "verification_failed",
    });
    seedProposal(proposalPath, {
      id: "proposal-recovery",
      title: "private recovery proposal",
      status: "approved",
      lifecycle: "recovery_required",
      applicationStatus: "failed",
      deploymentStatus: "failed",
      revision: 6,
      deploymentId: "native-id",
      deploymentTarget: "provider-payload",
      recoveryAttemptIds: ["recovery-first", "recovery-second"],
      recoveryStartedCount: 2,
    });

    const result = readHomeMigrationEvidenceFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID);
    assert.equal(result.outcome, "evidence");
    if (result.outcome !== "evidence") return;
    const workflow = result.workflows[0];
    assert.ok(workflow);
    assert.equal(workflow.enableDecisionCount, 1);
    assert.equal(workflow.recovery.attemptCount, 2);
    assert.equal(workflow.recovery.result, "recovery_required");
    assert.ok(workflow.recovery.latestReceiptDigest);
    assert.match(workflow.recovery.latestReceiptDigest!, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(workflow.recovery.receiptDigests.length >= 3);
    assert.equal(new Set(workflow.recovery.receiptDigests).size, workflow.recovery.receiptDigests.length);
    const serialized = JSON.stringify(result);
    for (const secret of ["rule-private", "recovery-private", "recovery-first", "recovery-second", "native-id", "provider-payload"]) {
      assert.equal(serialized.includes(secret), false, `recovery evidence leaked ${secret}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports a terminal failed-switch restoration without counting its retained receipt as active failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-failed-switch-restored-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  try {
    seedMigration(migrationPath, { workflowStatus: "assessed", privateName: "private" });
    replaceEligibleWorkflow(migrationPath, makeFailedSwitchRestoredWorkflow("proposal-restored"));
    seedProposal(proposalPath, {
      id: "proposal-restored",
      title: "private",
      status: "approved",
      lifecycle: "closed",
      applicationStatus: "withdrawn",
      deploymentStatus: "rolled_back",
      revision: 5,
    });

    const result = readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID);

    assert.equal(result.outcome, "reported");
    if (result.outcome === "reported") {
      assert.equal(result.assessment.workflowCounts.restored, 1);
      assert.equal(result.assessment.workflowCounts.needs_attention, 0);
      assert.equal(result.assessment.failureCounts.switch_failed, 0);
      assert.equal(result.proposals.lifecycleCounts.closed, 1);
      assert.equal(result.proposals.deploymentCounts.rolled_back, 1);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed when a verified workflow candidate hash disagrees with its linked Proposal", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-candidate-identity-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  try {
    seedMigration(migrationPath, { workflowStatus: "verified", proposalId: "proposal-candidate-identity", privateName: "private" });
    seedProposal(proposalPath, {
      id: "proposal-candidate-identity",
      title: "private",
      status: "approved",
      lifecycle: "active",
      applicationStatus: "running",
      deploymentStatus: "verified",
      deploymentId: "native-id",
      deploymentTarget: "provider-payload",
    });
    replaceEligibleWorkflow(migrationPath, {
      ...makeWorkflow("verified", "proposal-candidate-identity"),
      candidateContentHash: `sha256:${"9".repeat(64)}`,
    });

    assert.deepEqual(readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID), {
      schemaVersion: "1",
      outcome: "needs_attention",
      assessmentId: ASSESSMENT_ID,
      reason: "cross_store_inconsistent",
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed when a ready workflow revision no longer matches its linked Proposal", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-ready-revision-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  try {
    seedMigration(migrationPath, { workflowStatus: "assessed", privateName: "private" });
    replaceEligibleWorkflow(migrationPath, makeReadyWorkflow("proposal-ready-identity"));
    seedReadyProposal(proposalPath, "proposal-ready-identity");

    const before = readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID);
    assert.equal(before.outcome, "reported");

    replaceEligibleWorkflow(migrationPath, {
      ...makeReadyWorkflow("proposal-ready-identity"),
      candidateProposalRevision: 2,
      reviewProposalRevision: 3,
    });
    assert.deepEqual(readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID), {
      schemaVersion: "1",
      outcome: "needs_attention",
      assessmentId: ASSESSMENT_ID,
      reason: "cross_store_inconsistent",
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed when verified source, artifact, or deployment identity drifts", () => {
  const cases: readonly [string, (workflow: Record<string, unknown>) => Record<string, unknown>][] = [
    ["source identity", (workflow) => workflow],
    ["artifact identity", (workflow) => ({ ...workflow, artifactContentHash: `sha256:${"9".repeat(64)}` })],
    ["deployment identity", (workflow) => ({ ...workflow, deploymentTarget: "different-target" })],
  ];
  for (const [label, mutate] of cases) {
    const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-verified-identity-"));
    const migrationPath = join(directory, "migrations.sqlite");
    const proposalPath = join(directory, "proposals.sqlite");
    try {
      seedMigration(migrationPath, { workflowStatus: "assessed", privateName: "private" });
      const original = makeWorkflow("verified", "proposal-verified-identity");
      replaceEligibleWorkflow(migrationPath, mutate(original));
      seedProposal(proposalPath, {
        id: "proposal-verified-identity",
        title: "private",
        status: "approved",
        lifecycle: "active",
        applicationStatus: "running",
        deploymentStatus: "verified",
        deploymentId: "native-id",
        deploymentTarget: "provider-payload",
      });
      if (label === "source identity") {
        const db = new DatabaseSync(proposalPath);
        try {
          const row = db.prepare("SELECT payload_json FROM proposals WHERE proposal_id = ?")
            .get("proposal-verified-identity") as { payload_json?: unknown } | undefined;
          if (typeof row?.payload_json !== "string") throw new Error("missing proposal fixture");
          const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
          payload.dedupKey = "home-automation-migration:source-drift";
          db.prepare("UPDATE proposals SET payload_json = ? WHERE proposal_id = ?")
            .run(JSON.stringify(payload), "proposal-verified-identity");
        } finally {
          db.close();
        }
      }
      assert.deepEqual(readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID), {
        schemaVersion: "1",
        outcome: "needs_attention",
        assessmentId: ASSESSMENT_ID,
        reason: "cross_store_inconsistent",
        readMode: "durable_only",
        remoteWritesPerformed: false,
        localWritesPerformed: false,
      }, label);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("fails closed on malformed migration durability without creating a Proposal database", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-migration-corrupt-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  try {
    seedMigration(migrationPath, { workflowStatus: "assessed", privateName: "private" });
    const db = new DatabaseSync(migrationPath);
    db.prepare("UPDATE home_automation_migrations SET rules_json = ? WHERE migration_id = ?")
      .run("not-json", ASSESSMENT_ID);
    db.close();
    assert.deepEqual(readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID), {
      schemaVersion: "1",
      outcome: "needs_attention",
      assessmentId: ASSESSMENT_ID,
      reason: "migration_store_corrupt",
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
    assert.equal(existsSync(proposalPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports zero Proposal aggregates when no workflow is linked, without creating a proposal database", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-proposal-missing-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  try {
    seedMigration(migrationPath, { workflowStatus: "assessed", privateName: "private" });
    const result = readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID);
    assert.equal(result.outcome, "reported");
    if (result.outcome === "reported") {
      assert.deepEqual(result.proposals, {
        linkedWorkflowCount: 0,
        missingProposalCount: 0,
        reviewStatusCounts: { pending_review: 0, approved: 0, rejected: 0, expired: 0 },
        lifecycleCounts: {
          preparing: 0,
          needs_info: 0,
          ready: 0,
          enabling: 0,
          active: 0,
          paused: 0,
          closed: 0,
          enable_failed: 0,
          recovery_required: 0,
        },
        applicationStatusCounts: { not_available: 0, deploying: 0, running: 0, failed: 0, withdrawn: 0 },
        deploymentCounts: { absent: 0, pending: 0, verified: 0, failed: 0, rolled_back: 0 },
        consistency: "consistent",
      });
    }
    assert.equal(existsSync(proposalPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed on a missing linked Proposal and never exposes the missing identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-cross-store-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  try {
    seedMigration(migrationPath, { workflowStatus: "translated", proposalId: "secret-proposal", privateName: "private" });
    new SqliteProposalStore({ path: proposalPath }).close();
    const result = readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID);
    assert.deepEqual(result, {
      schemaVersion: "1",
      outcome: "needs_attention",
      assessmentId: ASSESSMENT_ID,
      reason: "cross_store_inconsistent",
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
    assert.equal(JSON.stringify(result).includes("secret-proposal"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a symlinked Proposal database before opening it", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-proposal-symlink-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const realProposalPath = join(directory, "real-proposals.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  try {
    seedMigration(migrationPath, { workflowStatus: "translated", proposalId: "proposal-private", privateName: "private" });
    new SqliteProposalStore({ path: realProposalPath }).close();
    symlinkSync(realProposalPath, proposalPath);
    assert.deepEqual(readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID), {
      schemaVersion: "1",
      outcome: "needs_attention",
      assessmentId: ASSESSMENT_ID,
      reason: "proposal_store_unavailable",
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("maps malformed Proposal payload to a fixed corruption result", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-proposal-corrupt-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  try {
    seedMigration(migrationPath, { workflowStatus: "translated", proposalId: "proposal-private", privateName: "private" });
    const proposals = new SqliteProposalStore({ path: proposalPath });
    const db = (proposals as unknown as { db: DatabaseSync }).db;
    db.prepare(`INSERT INTO proposals
      (proposal_id, producer, idempotency_key, status, revision, created_at, updated_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("proposal-private", "home-automation-migration", "idempotency", "pending_review", 1,
        "2026-08-24T08:00:00.000Z", "2026-08-24T08:00:00.000Z", "not-json");
    proposals.close();
    assert.deepEqual(readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID), {
      schemaVersion: "1",
      outcome: "needs_attention",
      assessmentId: ASSESSMENT_ID,
      reason: "proposal_store_corrupt",
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed when a linked Proposal is produced by another producer", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-proposal-producer-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  try {
    seedMigration(migrationPath, { workflowStatus: "translated", proposalId: "proposal-private", privateName: "private" });
    const proposals = new SqliteProposalStore({ path: proposalPath });
    const db = (proposals as unknown as { db: DatabaseSync }).db;
    db.prepare(`INSERT INTO proposals
      (proposal_id, producer, idempotency_key, status, revision, created_at, updated_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("proposal-private", "foreign-producer", "idempotency", "pending_review", 1,
        "2026-08-24T08:00:00.000Z", "2026-08-24T08:00:00.000Z", JSON.stringify({
          id: "proposal-private",
          revision: 1,
          reviewLane: "migration",
          provenance: { producer: "foreign-producer" },
          status: "pending_review",
          lifecycle: "ready",
          applicationStatus: "not_available",
        }));
    proposals.close();
    assert.deepEqual(readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID), {
      schemaVersion: "1",
      outcome: "needs_attention",
      assessmentId: ASSESSMENT_ID,
      reason: "proposal_store_corrupt",
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed when a Proposal row revision disagrees with its payload", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-proposal-revision-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  try {
    seedMigration(migrationPath, { workflowStatus: "translated", proposalId: "proposal-private", privateName: "private" });
    const proposals = new SqliteProposalStore({ path: proposalPath });
    const db = (proposals as unknown as { db: DatabaseSync }).db;
    db.prepare(`INSERT INTO proposals
      (proposal_id, producer, idempotency_key, status, revision, created_at, updated_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("proposal-private", "home-automation-migration", "idempotency", "pending_review", 1,
        "2026-08-24T08:00:00.000Z", "2026-08-24T08:00:00.000Z", JSON.stringify({
          id: "proposal-private",
          revision: 2,
          reviewLane: "migration",
          provenance: { producer: "home-automation-migration" },
          status: "pending_review",
          lifecycle: "ready",
          applicationStatus: "not_available",
        }));
    proposals.close();
    assert.deepEqual(readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID), {
      schemaVersion: "1",
      outcome: "needs_attention",
      assessmentId: ASSESSMENT_ID,
      reason: "proposal_store_corrupt",
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed when a Proposal row status disagrees with its payload", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-proposal-status-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  try {
    seedMigration(migrationPath, { workflowStatus: "translated", proposalId: "proposal-private", privateName: "private" });
    const proposals = new SqliteProposalStore({ path: proposalPath });
    const db = (proposals as unknown as { db: DatabaseSync }).db;
    db.prepare(`INSERT INTO proposals
      (proposal_id, producer, idempotency_key, status, revision, created_at, updated_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("proposal-private", "home-automation-migration", "idempotency", "pending_review", 1,
        "2026-08-24T08:00:00.000Z", "2026-08-24T08:00:00.000Z", JSON.stringify({
          id: "proposal-private",
          revision: 1,
          reviewLane: "migration",
          provenance: { producer: "home-automation-migration" },
          status: "approved",
          lifecycle: "ready",
          applicationStatus: "not_available",
        }));
    proposals.close();
    assert.deepEqual(readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID), {
      schemaVersion: "1",
      outcome: "needs_attention",
      assessmentId: ASSESSMENT_ID,
      reason: "proposal_store_corrupt",
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed before parsing an oversized Proposal payload", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-status-proposal-large-"));
  const migrationPath = join(directory, "migrations.sqlite");
  const proposalPath = join(directory, "proposals.sqlite");
  try {
    seedMigration(migrationPath, { workflowStatus: "translated", proposalId: "proposal-private", privateName: "private" });
    const proposals = new SqliteProposalStore({ path: proposalPath });
    const db = (proposals as unknown as { db: DatabaseSync }).db;
    db.prepare(`INSERT INTO proposals
      (proposal_id, producer, idempotency_key, status, revision, created_at, updated_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("proposal-private", "home-automation-migration", "idempotency", "pending_review", 1,
        "2026-08-24T08:00:00.000Z", "2026-08-24T08:00:00.000Z", "x".repeat(HOME_MIGRATION_STATUS_MAX_PROPOSAL_PAYLOAD_BYTES + 1));
    proposals.close();
    assert.deepEqual(readHomeMigrationStatusFromPaths({ migrationPath, proposalPath }, ASSESSMENT_ID), {
      schemaVersion: "1",
      outcome: "needs_attention",
      assessmentId: ASSESSMENT_ID,
      reason: "proposal_store_corrupt",
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface SqliteStatementPrototype {
  all: (...parameters: unknown[]) => unknown;
}

function sqliteStatementPrototype(): SqliteStatementPrototype {
  const probe = new DatabaseSync(":memory:");
  try {
    return Object.getPrototypeOf(probe.prepare("SELECT 1")) as SqliteStatementPrototype;
  } finally {
    probe.close();
  }
}

function seedMigration(
  path: string,
  input: { readonly workflowStatus: "assessed" | "translated" | "verified"; readonly proposalId?: string; readonly privateName: string },
): void {
  const store = new SqliteHomeAutomationMigrationStore({ path });
  const fingerprint = `sha256:${"a".repeat(64)}`;
  const workflow = makeWorkflow(input.workflowStatus, input.proposalId);
  const assessedWorkflow = {
    status: "assessed" as const,
    sourceFingerprint: fingerprint,
    assessedAt: "2026-08-24T08:00:00.000Z",
  };
  const rules = [
    {
      ruleRef: "rule-private",
      name: input.privateName,
      triggerClass: "state",
      conditionClass: "flat_and",
      actionClass: "reversible",
      sourceFingerprint: fingerprint,
      disposition: "eligible",
      workflow: assessedWorkflow,
    },
    {
      ruleRef: "rule-unsupported",
      name: "unsupported-private",
      triggerClass: "state",
      conditionClass: "flat_and",
      actionClass: "unsupported",
      disposition: "unsupported",
      reason: "unsupported_action",
    },
  ];
  store.discover({
    migrationId: ASSESSMENT_ID,
    idempotencyKey: "1".repeat(32),
    inputDigest: `sha256:${"2".repeat(64)}`,
    sourceBridgeId: "bridge-private",
    sourceEpochId: "epoch-private",
    sourceLastSeq: 7,
    analysisMode: "trusted_neutral",
    rules,
    createdAt: "2026-08-24T08:00:00.000Z",
  });
  store.assess({
    migrationId: ASSESSMENT_ID,
    status: "assessed",
    assessedAt: "2026-08-24T08:00:00.000Z",
    rules,
  });
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare("UPDATE home_automation_migrations SET rules_json = ? WHERE migration_id = ?")
    .run(JSON.stringify(rules.map((rule) => rule.disposition === "eligible" ? { ...rule, workflow } : rule)), ASSESSMENT_ID);
  store.close();
}

function makeWorkflow(
  status: "assessed" | "translated" | "verified",
  proposalId?: string,
): Record<string, unknown> {
  const fingerprint = `sha256:${"a".repeat(64)}`;
  return {
    status,
    sourceFingerprint: fingerprint,
    assessedAt: "2026-08-24T08:00:00.000Z",
    ...(status === "assessed" || proposalId === undefined ? {} : { proposalId }),
    ...(status === "translated" ? {
      candidateProposalRevision: 1,
      candidateContentHash: computeHomeAutomationMigrationCandidateContentHash(MIGRATION_CANDIDATE_CONTENT),
      translatedAt: "2026-08-24T08:00:00.500Z",
    } : {}),
    ...(status === "verified" ? {
      candidateProposalRevision: 1,
      candidateContentHash: computeHomeAutomationMigrationCandidateContentHash(MIGRATION_CANDIDATE_CONTENT),
      artifactId: "artifact-private",
      artifactRevision: 1,
      artifactContentHash: `sha256:${"c".repeat(64)}`,
      compileResultId: `sha256:${"d".repeat(64)}`,
      dryRunResultId: `sha256:${"e".repeat(64)}`,
      translatedAt: "2026-08-24T08:00:00.500Z",
      simulatedAt: "2026-08-24T08:00:00.750Z",
      readyAt: "2026-08-24T08:00:00.900Z",
      reviewProposalRevision: 2,
      approvedProposalRevision: 3,
      switchOperationId: "f".repeat(32),
      switchActor: "private-actor",
      sourceWasEnabled: true,
      switchStartedAt: "2026-08-24T08:00:01.000Z",
      deploymentId: "native-id",
      deploymentTarget: "provider-payload",
      deploymentConfigFingerprint: `sha256:${"f".repeat(64)}`,
      verifiedAt: "2026-08-24T08:00:02.000Z",
    } : {}),
  };
}

function makeReadyWorkflow(proposalId: string): Record<string, unknown> {
  const verified = makeWorkflow("verified", proposalId);
  return {
    status: "ready",
    sourceFingerprint: verified.sourceFingerprint,
    assessedAt: verified.assessedAt,
    proposalId: verified.proposalId,
    candidateProposalRevision: verified.candidateProposalRevision,
    candidateContentHash: verified.candidateContentHash,
    translatedAt: verified.translatedAt,
    artifactId: verified.artifactId,
    artifactRevision: verified.artifactRevision,
    artifactContentHash: verified.artifactContentHash,
    compileResultId: verified.compileResultId,
    dryRunResultId: verified.dryRunResultId,
    simulatedAt: verified.simulatedAt,
    readyAt: "2026-08-24T08:00:00.900Z",
    reviewProposalRevision: 2,
  };
}

function makeFailedSwitchRestoredWorkflow(proposalId: string): Record<string, unknown> {
  return {
    status: "restored",
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    assessedAt: "2026-08-24T08:00:00.000Z",
    proposalId,
    candidateProposalRevision: 1,
    candidateContentHash: computeHomeAutomationMigrationCandidateContentHash(MIGRATION_CANDIDATE_CONTENT),
    translatedAt: "2026-08-24T08:00:00.500Z",
    artifactId: "artifact-private",
    artifactRevision: 1,
    artifactContentHash: `sha256:${"c".repeat(64)}`,
    compileResultId: `sha256:${"d".repeat(64)}`,
    dryRunResultId: `sha256:${"e".repeat(64)}`,
    simulatedAt: "2026-08-24T08:00:00.750Z",
    readyAt: "2026-08-24T08:00:00.900Z",
    reviewProposalRevision: 2,
    approvedProposalRevision: 3,
    switchOperationId: "f".repeat(32),
    switchActor: "private-actor",
    sourceWasEnabled: true,
    switchStartedAt: "2026-08-24T08:00:01.000Z",
    failedAt: "2026-08-24T08:00:02.000Z",
    failureReason: "switch_failed",
    restoredAt: "2026-08-24T08:00:03.000Z",
  };
}

function replaceEligibleWorkflow(path: string, workflow: Record<string, unknown>): void {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare("SELECT rules_json FROM home_automation_migrations WHERE migration_id = ?").get(ASSESSMENT_ID) as { rules_json?: unknown } | undefined;
    if (typeof row?.rules_json !== "string") throw new Error("missing migration fixture");
    const rules = JSON.parse(row.rules_json) as Array<Record<string, unknown>>;
    db.prepare("UPDATE home_automation_migrations SET rules_json = ? WHERE migration_id = ?")
      .run(JSON.stringify(rules.map((rule) => rule.disposition === "eligible" ? { ...rule, workflow } : rule)), ASSESSMENT_ID);
  } finally {
    db.close();
  }
}

function seedSelections(path: string): void {
  const store = new SqliteHomeAutomationMigrationStore({ path });
  const common = {
    migrationId: ASSESSMENT_ID,
    ruleRef: "rule-private",
    principal: { principalId: "principal-private", role: "adult_member" as const, privateDeviceBinding: "verified" as const },
    sourceBridgeId: "bridge-private",
    sourceEpochId: "epoch-private",
    sourceLastSeq: 7,
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    generation: "generation-private",
    issuedAt: "2026-08-24T08:00:00.000Z",
    expiresAt: "2026-08-24T08:05:00.000Z",
  } as const;
  const first = store.issueSelection({ ...common, selectionId: "3".repeat(32), tokenDigest: `sha256:${"3".repeat(64)}` });
  store.claimSelection({
    selectionId: first.selection.selectionId,
    tokenDigest: first.selection.tokenDigest,
    principal: common.principal,
    generation: common.generation,
    now: common.issuedAt,
  });
  const secondPrincipal = { ...common.principal, principalId: "principal-private-2" };
  const second = store.issueSelection({ ...common, principal: secondPrincipal, selectionId: "4".repeat(32), tokenDigest: `sha256:${"4".repeat(64)}` });
  const claimed = store.claimSelection({
    selectionId: second.selection.selectionId,
    tokenDigest: second.selection.tokenDigest,
    principal: secondPrincipal,
    generation: common.generation,
    now: common.issuedAt,
  });
  assert.equal(claimed.outcome, "claimed");
  if (claimed.outcome === "claimed") {
    store.completeSelection({
      selectionId: claimed.selection.selectionId,
      expectedRevision: claimed.selection.revision,
      principal: secondPrincipal,
      generation: common.generation,
      completedAt: "2026-08-24T08:00:01.000Z",
      status: "prepared",
      proposalId: "proposal-private",
      proposalRevision: 2,
    });
  }
  store.close();
}

function seedProposal(path: string, input: {
  readonly id: string;
  readonly title: string;
  readonly status: "approved";
  readonly lifecycle: "active" | "closed" | "recovery_required";
  readonly applicationStatus: "running" | "failed" | "withdrawn";
  readonly deploymentStatus: "failed" | "verified" | "rolled_back";
  readonly revision?: number;
  readonly deploymentId?: string;
  readonly deploymentTarget?: string;
  readonly deploymentConfigFingerprint?: string;
  readonly recoveryStartedCount?: number;
  readonly recoveryAttemptIds?: readonly string[];
}): void {
  const store = new SqliteProposalStore({ path });
  const db = (store as unknown as { db: DatabaseSync }).db;
  const workflowIdentity = homeAutomationMigrationProposalIdentity({
    migrationId: ASSESSMENT_ID,
    ruleRef: "rule-private",
    sourceBridgeId: "bridge-private",
    sourceEpochId: "epoch-private",
    sourceLastSeq: 7,
    sourceFingerprint: MIGRATION_SOURCE_FINGERPRINT,
  });
  const revision = input.revision ?? 4;
  const deploymentConfigFingerprint = input.deploymentConfigFingerprint ?? `sha256:${"f".repeat(64)}`;
  const deployment = {
    status: input.deploymentStatus,
    requestedAt: "2026-08-24T08:00:01.000Z",
    ...(input.deploymentId === undefined ? {} : { deploymentId: input.deploymentId }),
    ...(input.deploymentTarget === undefined ? {} : { target: input.deploymentTarget }),
    ...(input.deploymentStatus === "verified" || input.deploymentConfigFingerprint !== undefined
      ? { configFingerprint: deploymentConfigFingerprint } : {}),
    ...(input.deploymentStatus === "verified" ? { verifiedAt: "2026-08-24T08:00:02.000Z" } : {}),
  };
  const recoveryStartedCount = input.recoveryStartedCount ?? 0;
  const recoveryAudits = Array.from({ length: recoveryStartedCount }, (_, index) => ({
    id: `audit-recovery-${index + 1}`,
    at: `2026-08-24T08:00:0${4 + index}.000Z`,
    action: "recovery_started",
    actor: "recovery-private",
    revision: 5 + index,
  }));
  const audit = [
    { id: "audit-created", at: "2026-08-24T08:00:00.000Z", action: "created", actor: "home-automation-migration", revision: 1 },
    { id: "audit-prepared", at: "2026-08-24T08:00:00.500Z", action: "prepared", actor: "system", revision: 2 },
    { id: "audit-approved", at: "2026-08-24T08:00:01.000Z", action: "approved", actor: "household-owner", revision: 3 },
    ...(input.deploymentStatus === "verified"
      ? [{ id: "audit-deployment", at: "2026-08-24T08:00:02.000Z", action: "deployment_verified", actor: "system", revision: 4 }]
      : [{ id: "audit-deployment", at: "2026-08-24T08:00:02.000Z", action: "deployment_failed", actor: "system", revision: 4 }]),
    ...recoveryAudits,
    ...(input.lifecycle === "closed"
      ? [{ id: "audit-closed", at: "2026-08-24T08:00:03.000Z", action: "closed", actor: "household-owner", revision }]
      : []),
  ];
  db.prepare(`INSERT INTO proposals
    (proposal_id, producer, idempotency_key, status, revision, created_at, updated_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.id, "home-automation-migration", workflowIdentity.idempotencyKey, input.status, revision,
      "2026-08-24T08:00:00.000Z", "2026-08-24T08:00:02.000Z", JSON.stringify({
        id: input.id,
        revision,
        kind: "automation-draft",
        idempotencyKey: workflowIdentity.idempotencyKey,
        dedupKey: workflowIdentity.dedupKey,
        createdAt: "2026-08-24T08:00:00.000Z",
        updatedAt: "2026-08-24T08:00:02.000Z",
        reviewLane: "migration",
        provenance: { producer: "home-automation-migration" },
        status: input.status,
        lifecycle: input.lifecycle,
        applicationStatus: input.applicationStatus,
        artifactCandidate: { schemaVersion: "1", content: MIGRATION_CANDIDATE_CONTENT },
        preparedArtifact: {
          artifactId: "artifact-private",
          revision: 1,
          contentHash: `sha256:${"c".repeat(64)}`,
          compileResultId: `sha256:${"d".repeat(64)}`,
          dryRunResultId: `sha256:${"e".repeat(64)}`,
        },
        deployment,
        ...(input.recoveryAttemptIds === undefined ? {} : {
          recoveryAttempts: input.recoveryAttemptIds.map((id, index) => ({
            id,
            actor: "recovery-private",
            revision: 5 + index,
            startedAt: `2026-08-24T08:00:0${4 + index}.000Z`,
          })),
        }),
        conflictCheck: { status: "checked", existingAutomationCount: 1, matches: [{ identity: "rule-private", relation: "possible_overlap" }] },
        audit,
        title: input.title,
      }));
  store.close();
}

function seedReadyProposal(path: string, proposalId: string): void {
  const store = new SqliteProposalStore({ path });
  const db = (store as unknown as { db: DatabaseSync }).db;
  const identity = homeAutomationMigrationProposalIdentity({
    migrationId: ASSESSMENT_ID,
    ruleRef: "rule-private",
    sourceBridgeId: "bridge-private",
    sourceEpochId: "epoch-private",
    sourceLastSeq: 7,
    sourceFingerprint: MIGRATION_SOURCE_FINGERPRINT,
  });
  const createdAt = "2026-08-24T08:00:00.000Z";
  const updatedAt = "2026-08-24T08:00:00.900Z";
  db.prepare(`INSERT INTO proposals
    (proposal_id, producer, idempotency_key, status, revision, created_at, updated_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    proposalId,
    "home-automation-migration",
    identity.idempotencyKey,
    "pending_review",
    2,
    createdAt,
    updatedAt,
    JSON.stringify({
      id: proposalId,
      revision: 2,
      kind: "automation-draft",
      idempotencyKey: identity.idempotencyKey,
      dedupKey: identity.dedupKey,
      createdAt,
      updatedAt,
      reviewLane: "migration",
      provenance: { producer: "home-automation-migration" },
      status: "pending_review",
      lifecycle: "ready",
      applicationStatus: "not_available",
      artifactCandidate: { schemaVersion: "1", content: MIGRATION_CANDIDATE_CONTENT },
      preparedArtifact: {
        artifactId: "artifact-private",
        revision: 1,
        contentHash: `sha256:${"c".repeat(64)}`,
        compileResultId: `sha256:${"d".repeat(64)}`,
        dryRunResultId: `sha256:${"e".repeat(64)}`,
      },
      conflictCheck: { status: "checked", existingAutomationCount: 1, matches: [{ identity: "rule-private", relation: "possible_overlap" }] },
      audit: [
        { id: "audit-created", at: createdAt, action: "created", actor: "home-automation-migration", revision: 1 },
        { id: "audit-prepared", at: updatedAt, action: "prepared", actor: "system", revision: 2 },
      ],
      title: "private",
    }),
  );
  store.close();
}
