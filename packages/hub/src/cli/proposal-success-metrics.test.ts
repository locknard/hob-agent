import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const AS_OF = "2026-03-01T00:00:00.000Z";

function seedProposalStore(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE proposals (
    proposal_id TEXT PRIMARY KEY,
    producer TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  ) STRICT`);
  const payload = {
    id: "private-proposal-id",
    schemaVersion: "1",
    kind: "automation-draft",
    status: "approved",
    revision: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lifecycle: "active",
    title: "private household title",
    audit: [
      { id: "private-created", action: "created", at: "2026-01-01T00:00:00.000Z", actor: "private-actor", revision: 1 },
      { id: "private-approved", action: "approved", at: "2026-01-01T00:00:00.000Z", actor: "private-actor", note: "private note", revision: 2 },
      { id: "private-verified", action: "deployment_verified", at: "2026-01-01T00:00:00.000Z", actor: "private-actor", revision: 3 },
    ],
    deployment: {
      status: "verified",
      requestedAt: "2026-01-01T00:00:00.000Z",
      verifiedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  db.prepare(`INSERT INTO proposals
    (proposal_id, producer, idempotency_key, status, revision, created_at, updated_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    payload.id,
    "private-producer",
    "private-idempotency",
    payload.status,
    payload.revision,
    payload.createdAt,
    payload.updatedAt,
    JSON.stringify(payload),
  );
  db.close();
}

test("reads one existing Proposal SQLite file without exposing proposal metadata", async () => {
  const cli = await import("./proposal-success-metrics.js").catch(() => undefined);
  assert.ok(cli, "the proposal success metrics CLI must exist");
  if (cli === undefined) return;
  const directory = join(tmpdir(), `hob-proposal-success-metrics-${process.pid}-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  const proposalPath = join(directory, "proposals.sqlite");
  seedProposalStore(proposalPath);
  const before = statSync(proposalPath);
  try {
    const result = cli.readProposalSuccessMetrics({ HOB_DATA_DIR: directory }, AS_OF);
    assert.equal(result.outcome, "metrics");
    if (result.outcome !== "metrics") return;
    assert.equal(result.reviewedProposalCount, 1);
    assert.equal(result.enableDecisionCount, 1);
    assert.equal(result.enableRate, 1);
    assert.equal(result.survival.survivalRate, 1);
    assert.equal(result.remoteWritesPerformed, false);
    assert.equal(result.localWritesPerformed, false);
    const serialized = JSON.stringify(result);
    for (const privateValue of ["private-proposal-id", "private household title", "private-actor", "private note", "private-producer"]) {
      assert.equal(serialized.includes(privateValue), false, `metrics leaked ${privateValue}`);
    }
    const after = statSync(proposalPath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports missing HOB_DATA_DIR as fixed insufficient evidence without echoing input", async () => {
  const cli = await import("./proposal-success-metrics.js");
  const result = cli.readProposalSuccessMetrics({ HOB_DATA_DIR: undefined }, AS_OF);
  assert.deepEqual(result, {
    schemaVersion: "1",
    outcome: "insufficient_evidence",
    asOf: AS_OF,
    scope: "automation_proposals",
    readMode: "durable_only",
    reason: "proposal_store_unavailable",
    missingDurableField: "proposals.payload_json",
    remoteWritesPerformed: false,
    localWritesPerformed: false,
  });
});

test("requires one explicit as-of timestamp and rejects extra CLI arguments", async () => {
  const cli = await import("./proposal-success-metrics.js");
  assert.deepEqual(cli.parseProposalSuccessMetricsArgs(["--as-of", AS_OF]), { asOf: AS_OF });
  assert.throws(() => cli.parseProposalSuccessMetricsArgs([]), /--as-of is required/);
  assert.throws(() => cli.parseProposalSuccessMetricsArgs(["--as-of", AS_OF, "extra"]), /unknown argument/);
  assert.throws(() => cli.parseProposalSuccessMetricsArgs(["--as-of", "not-a-timestamp"]), /invalid as-of/);
});
