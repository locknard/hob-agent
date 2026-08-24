import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  parseHomeMigrationStatusArgs,
  readHomeMigrationStatusFromPaths,
} from "./home-migration-status.js";
import { SqliteHomeAutomationMigrationStore } from "../home/home-automation-migration-store.js";
import { SqliteProposalStore } from "../home/proposal-store.js";
import { HOME_MIGRATION_STATUS_MAX_PROPOSAL_PAYLOAD_BYTES } from "../home/home-automation-migration-status-reader.js";

const ASSESSMENT_ID = "a".repeat(32);

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
      candidateContentHash: `sha256:${"b".repeat(64)}`,
      translatedAt: "2026-08-24T08:00:00.500Z",
    } : {}),
    ...(status === "verified" ? {
      candidateProposalRevision: 1,
      candidateContentHash: `sha256:${"b".repeat(64)}`,
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
  readonly lifecycle: "active";
  readonly applicationStatus: "running";
  readonly deploymentStatus: "verified";
}): void {
  const store = new SqliteProposalStore({ path });
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare(`INSERT INTO proposals
    (proposal_id, producer, idempotency_key, status, revision, created_at, updated_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.id, "home-automation-migration", "idempotency-private", input.status, 3,
      "2026-08-24T08:00:00.000Z", "2026-08-24T08:00:02.000Z", JSON.stringify({
        id: input.id,
        revision: 3,
        reviewLane: "migration",
        provenance: { producer: "home-automation-migration" },
        status: input.status,
        lifecycle: input.lifecycle,
        applicationStatus: input.applicationStatus,
        deployment: { status: input.deploymentStatus },
        title: input.title,
      }));
  store.close();
}
