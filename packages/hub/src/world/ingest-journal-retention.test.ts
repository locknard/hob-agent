import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BridgeEvent, Envelope } from "./bridge-ingest-types.js";
import { SqliteIngestJournal } from "./ingest-journal.js";

function append(
  journal: SqliteIngestJournal,
  bridgeId: string,
  epochId: string,
  seq: number,
  receivedAt: string,
  event: BridgeEvent = {
    kind: "state",
    state: {
      nativeId: `${bridgeId}-${epochId}-${seq}`,
      nativeInstanceId: "main",
      attrs: { state: "observed" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  },
): void {
  const envelope: Envelope = { epochId, seq, event };
  journal.appendAtomic({ bridgeId, receivedAt, envelope });
}

test("retention keeps recovery, evidence, open-gap, and proposal references while auditing a partial floor", () => {
  const journal = new SqliteIngestJournal(":memory:");
  const old = "2026-08-01T00:00:00.000Z";
  const now = "2026-08-20T00:00:00.000Z";

  append(journal, "bridge-a", "epoch-expired", 1, old, {
    kind: "state",
    state: {
      nativeId: "expired",
      nativeInstanceId: "main",
      attrs: { state: "off" },
      time: { sourceTsQuality: "none" },
      origin: "observed",
    },
  });
  journal.markConsistent("bridge-a", { epochId: "epoch-expired", lastSeq: 1 });
  append(journal, "bridge-a", "epoch-recovery", 1, old);
  append(journal, "bridge-a", "epoch-recovery", 2, old);
  journal.markConsistent("bridge-a", { epochId: "epoch-recovery", lastSeq: 2 });
  journal.recordHistoryGap({
    bridgeId: "bridge-a",
    epochId: "epoch-gap",
    fromSeq: 2,
    toSeq: 5,
    reason: "sequence_gap",
  });
  append(journal, "bridge-a", "epoch-gap", 1, old);
  append(journal, "bridge-a", "epoch-proposal", 1, old);
  journal.markConsistent("bridge-a", { epochId: "epoch-proposal", lastSeq: 1 });
  journal.markConsistent("bridge-a", { epochId: "epoch-recovery", lastSeq: 2 });
  append(journal, "bridge-a", "epoch-fresh", 1, "2026-08-19T00:00:00.000Z");
  append(journal, "bridge-b", "epoch-other", 1, old);
  journal.recordRejection({
    bridgeId: "bridge-a",
    epochId: "epoch-expired",
    seq: 2,
    reason: "invalid_payload",
    nativeId: "expired",
  });

  const usedBefore = journal.capacity().usedBytes;
  const result = journal.applyRetention({
    policyId: "retention-1",
    bridgeId: "bridge-a",
    requestedAt: now,
    requestedBy: "operator",
    reason: "bounded evidence maintenance",
    proposalEvidence: [{
      referenceId: "proposal-1",
      bridgeId: "bridge-a",
      epochId: "epoch-proposal",
      seq: 1,
    }],
  });

  assert.equal(result.candidateCount, 5);
  assert.equal(result.deletedEventCount, 1);
  assert.equal(result.skippedRecoveryCount, 2);
  assert.equal(result.skippedHistoryGapCount, 1);
  assert.equal(result.skippedProposalEvidenceCount, 1);
  assert.equal(result.skippedEvidenceWindowCount, 1);
  assert.equal(result.partialCoverage, true);
  assert.equal(result.coverageFloor, old);
  assert.equal(result.bytesDeleted > 0, true);
  assert.equal(journal.capacity().usedBytes < usedBefore, true);
  assert.deepEqual(journal.records("bridge-a").map((record) => [record.envelope.epochId, record.envelope.seq]), [
    ["epoch-recovery", 1],
    ["epoch-recovery", 2],
    ["epoch-gap", 1],
    ["epoch-proposal", 1],
    ["epoch-fresh", 1],
  ]);
  assert.equal(journal.records("bridge-b").length, 1);
  assert.equal(journal.rejections("bridge-a").length, 1);
  assert.equal(journal.historyGaps("bridge-a").length, 1);

  assert.deepEqual(journal.coverage("bridge-a"), {
    bridgeId: "bridge-a",
    coverageFloor: old,
    retainedRecordCount: 5,
    partial: true,
    latestConsistentWatermark: { epochId: "epoch-recovery", lastSeq: 2 },
    openHistoryGapCount: 1,
    lastRetentionPolicyId: "retention-1",
  });
  assert.equal(journal.retentionAudits("bridge-a").length, 1);
  assert.equal(journal.latestRetentionAudit("bridge-a")?.policyId, "retention-1");
  assert.throws(() => journal.applyRetention({
    policyId: "retention-1",
    bridgeId: "bridge-a",
    requestedAt: now,
    requestedBy: "operator",
    reason: "duplicate policy",
  }), /already applied/);
  journal.close();
});

test("retention preview uses the exact protection decision without deleting or auditing", () => {
  const journal = new SqliteIngestJournal(":memory:");
  append(journal, "bridge-a", "epoch-expired", 1, "2026-08-01T00:00:00.000Z");
  journal.markConsistent("bridge-a", { epochId: "epoch-expired", lastSeq: 1 });
  append(journal, "bridge-a", "epoch-proposal", 1, "2026-08-01T00:00:00.000Z");
  journal.markConsistent("bridge-a", { epochId: "epoch-proposal", lastSeq: 1 });
  append(journal, "bridge-a", "epoch-fresh", 1, "2026-08-19T00:00:00.000Z");
  journal.markConsistent("bridge-a", { epochId: "epoch-fresh", lastSeq: 1 });
  const usedBefore = journal.capacity().usedBytes;
  const database = (journal as unknown as { db: { exec(sql: string): void } }).db;
  const originalExec = database.exec.bind(database);
  const transactions: string[] = [];
  database.exec = (sql: string): void => {
    if (sql.startsWith("BEGIN")) transactions.push(sql);
    originalExec(sql);
  };

  try {
    const preview = (journal as unknown as {
      previewRetention(policy: Parameters<SqliteIngestJournal["applyRetention"]>[0]): ReturnType<SqliteIngestJournal["applyRetention"]>;
    }).previewRetention({
      policyId: "retention-preview",
      bridgeId: "bridge-a",
      requestedAt: "2026-08-20T00:00:00.000Z",
      requestedBy: "operator",
      reason: "preview only",
      proposalEvidence: [{
        referenceId: "proposal-1",
        bridgeId: "bridge-a",
        epochId: "epoch-proposal",
        seq: 1,
      }],
    });

    assert.equal(preview.candidateCount, 2);
    assert.equal(preview.deletedEventCount, 1);
    assert.equal(preview.skippedProposalEvidenceCount, 1);
    assert.equal(preview.skippedEvidenceWindowCount, 1);
    assert.equal(preview.bytesDeleted > 0, true);
    assert.equal(preview.partialCoverage, true);
    assert.deepEqual(transactions, ["BEGIN"]);
    assert.equal(journal.records("bridge-a").length, 3);
    assert.equal(journal.capacity().usedBytes, usedBefore);
    assert.deepEqual(journal.retentionAudits("bridge-a"), []);
    assert.equal(journal.coverage("bridge-a").partial, false);
    assert.equal(journal.coverage("bridge-a").lastRetentionPolicyId, undefined);
  } finally {
    database.exec = originalExec;
  }
  journal.close();
});

test("retention preview orders a hypothetical coverage floor by instant rather than timestamp text", () => {
  const journal = new SqliteIngestJournal(":memory:");
  append(journal, "bridge-a", "epoch-expired", 1, "2026-08-01T00:00:00.000Z");
  journal.markConsistent("bridge-a", { epochId: "epoch-expired", lastSeq: 1 });
  append(journal, "bridge-a", "epoch-offset-oldest", 1, "2026-08-13T01:00:00+02:00");
  journal.markConsistent("bridge-a", { epochId: "epoch-offset-oldest", lastSeq: 1 });
  append(journal, "bridge-a", "epoch-utc-newer", 1, "2026-08-13T00:30:00.000Z");
  journal.markConsistent("bridge-a", { epochId: "epoch-utc-newer", lastSeq: 1 });

  const preview = journal.previewRetention({
    policyId: "retention-offset-preview",
    bridgeId: "bridge-a",
    requestedAt: "2026-08-20T00:00:00.000Z",
    requestedBy: "operator",
    reason: "timestamp ordering",
    evidenceWindowMs: 8 * 24 * 60 * 60 * 1_000,
  });

  assert.equal(preview.deletedEventCount, 1);
  assert.equal(preview.coverageFloor, "2026-08-13T01:00:00+02:00");
  journal.close();
});

test("retention preserves an old epoch unless that exact epoch reached verified consistency", () => {
  const journal = new SqliteIngestJournal(":memory:");
  append(journal, "bridge-a", "epoch-incomplete", 1, "2026-08-01T00:00:00.000Z");
  append(journal, "bridge-a", "epoch-complete", 1, "2026-08-01T00:00:00.000Z");
  journal.markConsistent("bridge-a", { epochId: "epoch-complete", lastSeq: 1 });
  append(journal, "bridge-a", "epoch-current", 1, "2026-08-19T00:00:00.000Z");
  journal.markConsistent("bridge-a", { epochId: "epoch-current", lastSeq: 1 });

  const result = journal.applyRetention({
    policyId: "retention-incomplete-epoch",
    bridgeId: "bridge-a",
    requestedAt: "2026-08-20T00:00:00.000Z",
    requestedBy: "operator",
    reason: "preserve unfinished recovery evidence",
  });

  assert.equal(result.candidateCount, 2);
  assert.equal(result.deletedEventCount, 1);
  assert.equal(result.skippedRecoveryCount, 1);
  assert.deepEqual(journal.records("bridge-a").map((record) => record.envelope.epochId), [
    "epoch-incomplete",
    "epoch-current",
  ]);
  journal.close();
});

test("retention validates bounded policy input before mutating the journal", () => {
  const journal = new SqliteIngestJournal(":memory:");
  append(journal, "bridge-a", "epoch-a", 1, "2026-08-01T00:00:00.000Z");
  assert.throws(() => journal.applyRetention({
    policyId: "",
    bridgeId: "bridge-a",
    requestedAt: "not-a-time",
    requestedBy: "operator",
    reason: "invalid",
  }));
  assert.throws(() => journal.applyRetention({
    policyId: "retention-too-short",
    bridgeId: "bridge-a",
    requestedAt: "2026-08-20T00:00:00.000Z",
    requestedBy: "operator",
    reason: "invalid window",
    evidenceWindowMs: 60 * 60 * 1_000,
  }), /at least 168 hours/);
  assert.equal(journal.records("bridge-a").length, 1);
  assert.deepEqual(journal.retentionAudits("bridge-a"), []);
  journal.close();
});

test("retention rolls back event deletion and audit together on a SQLite failure", () => {
  const journal = new SqliteIngestJournal(":memory:");
  append(journal, "bridge-a", "epoch-old", 1, "2026-08-01T00:00:00.000Z");
  journal.markConsistent("bridge-a", { epochId: "epoch-old", lastSeq: 1 });
  append(journal, "bridge-a", "epoch-current", 1, "2026-08-19T00:00:00.000Z");
  journal.markConsistent("bridge-a", { epochId: "epoch-current", lastSeq: 1 });
  const usedBefore = journal.capacity().usedBytes;
  const database = (journal as unknown as { db: { exec(sql: string): void } }).db;
  database.exec("CREATE TRIGGER injected_retention_failure BEFORE DELETE ON ingest_events BEGIN SELECT RAISE(ABORT, 'injected retention failure'); END;");

  assert.throws(() => journal.applyRetention({
    policyId: "retention-rollback",
    bridgeId: "bridge-a",
    requestedAt: "2026-08-20T00:00:00.000Z",
    requestedBy: "operator",
    reason: "rollback test",
  }), /injected retention failure/);
  assert.equal(journal.records("bridge-a").length, 2);
  assert.deepEqual(journal.retentionAudits("bridge-a"), []);
  assert.equal(journal.capacity().usedBytes, usedBefore);
  journal.close();
});

test("retention decision reads are protected from an external gap committed before the lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-retention-toctou-"));
  const path = join(directory, "journal.sqlite");
  const journal = new SqliteIngestJournal(path);
  const other = new DatabaseSync(path);
  other.exec("PRAGMA busy_timeout=5000;");
  append(journal, "bridge-a", "epoch-old", 1, "2026-08-01T00:00:00.000Z");
  journal.markConsistent("bridge-a", { epochId: "epoch-old", lastSeq: 1 });

  const database = (journal as unknown as {
    db: { exec: (sql: string) => void };
  }).db;
  const originalExec = database.exec.bind(database);
  let injected = false;
  database.exec = (sql: string): void => {
    if (sql === "BEGIN IMMEDIATE" && !injected) {
      injected = true;
      other.exec("BEGIN IMMEDIATE");
      other.prepare(`INSERT INTO ingest_history_gaps
        (bridge_id, epoch_id, from_seq, to_seq, reason, closed, bytes)
        VALUES (?, ?, ?, ?, ?, 0, 0)`).run("bridge-a", "epoch-old", 2, 3, "sequence_gap");
      other.exec("COMMIT");
    }
    originalExec(sql);
  };

  try {
    journal.applyRetention({
      policyId: "retention-toctou",
      bridgeId: "bridge-a",
      requestedAt: "2026-08-20T00:00:00.000Z",
      requestedBy: "operator",
      reason: "TOCTOU test",
    });
    assert.deepEqual(journal.records("bridge-a").map((record) => record.envelope.seq), [1]);
    assert.equal(journal.historyGaps("bridge-a").length, 1);
  } finally {
    database.exec = originalExec;
    journal.close();
    other.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retention audit and partial coverage survive a journal restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-retention-"));
  const path = join(directory, "journal.sqlite");
  try {
    const first = new SqliteIngestJournal(path);
    append(first, "bridge-a", "epoch-old", 1, "2026-08-01T00:00:00.000Z");
    first.markConsistent("bridge-a", { epochId: "epoch-old", lastSeq: 1 });
    append(first, "bridge-a", "epoch-fresh", 1, "2026-08-19T00:00:00.000Z");
    first.markConsistent("bridge-a", { epochId: "epoch-fresh", lastSeq: 1 });
    first.applyRetention({
      policyId: "retention-restart",
      bridgeId: "bridge-a",
      requestedAt: "2026-08-20T00:00:00.000Z",
      requestedBy: "operator",
      reason: "restart test",
    });
    first.close();

    const reopened = new SqliteIngestJournal(path);
    assert.equal(reopened.coverage("bridge-a").partial, true);
    assert.equal(reopened.coverage("bridge-a").coverageFloor, "2026-08-19T00:00:00.000Z");
    assert.equal(reopened.retentionAudits("bridge-a")[0]?.policyId, "retention-restart");
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the default evidence floor is exactly 168 hours and is inclusive", () => {
  const journal = new SqliteIngestJournal(":memory:");
  append(journal, "bridge-a", "epoch-expired", 1, "2026-08-12T23:59:59.999Z");
  journal.markConsistent("bridge-a", { epochId: "epoch-expired", lastSeq: 1 });
  append(journal, "bridge-a", "epoch-boundary", 1, "2026-08-13T00:00:00.000Z");
  journal.markConsistent("bridge-a", { epochId: "epoch-boundary", lastSeq: 1 });

  const result = journal.applyRetention({
    policyId: "retention-window",
    bridgeId: "bridge-a",
    requestedAt: "2026-08-20T00:00:00.000Z",
    requestedBy: "operator",
    reason: "window boundary test",
  });

  assert.equal(result.candidateCount, 1);
  assert.equal(result.deletedEventCount, 1);
  assert.equal(result.skippedEvidenceWindowCount, 1);
  assert.deepEqual(journal.records("bridge-a").map((record) => record.envelope.epochId), ["epoch-boundary"]);
  journal.close();
});
